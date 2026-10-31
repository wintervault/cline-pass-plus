//! Cline Pass 上游控制台 —— 桌面壳
//!
//! 职责只有一个：把 Node 服务进程管起来，并保证「退出就是真退出」。
//!
//! 防残留的三道闸（自我审计清单，缺一不可）：
//! 1. **Job Object（kill-on-close）**：服务进程从 spawn 起就挂进本壳的作业对象。
//!    作业句柄随壳进程消亡而关闭 → OS 层面无条件终止整棵子进程树。
//!    无论壳是正常退出、崩溃、被任务管理器强杀，子进程都不会残留。
//! 2. **优雅关停优先**：正常退出先请求服务端的 /api/shutdown（仅放行回环 + 无 Origin，
//!    浏览器跨源被中间件拦截），等服务落盘退出（≤8s），超时才用平台兜底强杀
//!    （Windows: TerminateJobObject；Linux: SIGTERM→SIGKILL 进程组）。
//! 3. **退出路径唯一**：托盘「退出」→ stop → app.exit(0)。关窗只是隐藏进托盘，不退出。
//!    启动方式与平常的桌面软件一致：双击图标就打开控制台（服务先就绪再开窗）。
//!
//! **控制通道走 HTTP，不走 Tauri IPC**（2.9.2 的根因修复，别再改回去）：
//! 控制台页面是 `WebviewUrl::External("http://127.0.0.1:3125/")`。对外部 URL，
//! Tauri 默认不注入 `window.__TAURI_INTERNALS__`，且新版对「非本地来源」强制执行 ACL、
//! 未声明 remote capability 的自定义命令会被直接拒绝（tauri-apps/tauri#4837、#15190）。
//! 页面里的 `cpsHost` 因此永远拿不到结果，UI 只能把每次失败当成「已停止」，
//! 于是出现「明明在跑却显示已停止」+「按钮点了没反应」。现在壳自己监听回环控制端口，
//! 注入的桥只做 HTTP 调用：无 IPC、无 ACL、无来源限制，浏览器直开也能用、curl 也能诊断。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::ManagerExt as AutostartExt;

mod platform;

/// 控制台端口（2.1 起独立于网关）：网关默认从 3126 起。
const PORT: u16 = 3125;
/// 开机自启时使用的命令行参数：由 autostart 插件写入注册项，启动时据此只驻留托盘。
const AUTOSTART_ARG: &str = "--autostart";
/// 控制端口：壳自己的回环 HTTP 服务，页面据此启停服务。固定端口便于诊断（curl 可直连）；
/// 被占用时退回系统分配端口（罕见路径，端口会通过注入脚本告诉页面）。
const CONTROL_PORT: u16 = 3122;
/// 允许调用控制通道的来源：**只有控制台自己**。
///
/// 为什么必须放行：控制台在 3125、控制通道在 3122，对浏览器而言是跨源请求，
/// 一定带 Origin/Referer；一律拒绝的话页面自己也被挡在门外——这正是「按钮点了没反应」
/// 的最后一层原因。放行之后仍然安全：别的网页 Origin/Referer 不是这个值，照旧 403。
const CONSOLE_ORIGIN: &str = "http://127.0.0.1:3125";
/// 「关于」里的仓库链接。桌面 WebView 不处理 target=_blank，只能由壳交给系统浏览器；
/// 只暴露这一个固定地址，不开放任意 URL 打开（否则控制通道就成了启动器）。
const REPO_URL: &str = "https://github.com/wintervault/cline-pass-plus";
const HEALTHZ_TIMEOUT: Duration = Duration::from_secs(25);
const GRACEFUL_STOP: Duration = Duration::from_secs(8);
const LOG_ROTATE_BYTES: u64 = 8 * 1024 * 1024;
/// 壳内保留的最近日志行数（/host/log 读内存副本，不去抢服务进程持有的文件句柄）
const LOG_RING: usize = 500;
/// 注入脚本里预置的控制端口占位符（端口运行期确定，只能后填）
const CONTROL_PORT_PLACEHOLDER: &str = "__CPS_CONTROL_PORT__";

/// 服务状态。`Error` 不是多余的——它把「启动失败」和「没启动」分开，
/// 页面才不至于把拉不起来的原因吞掉、只显示一句「已停止」。
#[derive(Clone, PartialEq, Eq)]
enum SvcState {
    Stopped,
    Starting,
    Running,
    Stopping,
    Error(String),
}

impl SvcState {
    fn name(&self) -> &'static str {
        match self {
            SvcState::Stopped => "stopped",
            SvcState::Starting => "starting",
            SvcState::Running => "running",
            SvcState::Stopping => "stopping",
            SvcState::Error(_) => "error",
        }
    }
}

/// 服务进程的持有状态。child 与防残留句柄的存活期 = 壳进程存活期。
struct ServerState {
    child: Mutex<Option<Child>>,
    /// 平台防残留句柄：Windows 是 Job Object；Unix 无句柄（PDEATHSIG + 进程组）。
    guard: platform::KillGuard,
    /// 壳自身的句柄：控制通道要用它去操作主窗口（窗口控制 / 拖动）
    app: AppHandle,
    data_dir: PathBuf,
    entry: PathBuf,
    log_dir: PathBuf,
    /// 退出中：为 true 时窗口的 CloseRequested 不再被拦截（否则 app.exit 会被
    /// 自己的「关窗进托盘」逻辑拖住——托盘退出卡顿的根因）
    exiting: AtomicBool,
    /// 控制端口（0 = 控制服务没起来，页面会明确报「控制通道不可用」）
    control_port: AtomicU16,
    state: Mutex<SvcState>,
    /// 用户/启动流程「希望服务在跑」——看门狗只在这个前提下自动重启，
    /// 这样用户主动停止、托盘退出都不会被它又拉起来。
    desired: AtomicBool,
    /// 最近几次自动重启的时刻（用于限流，防止崩溃循环把机器拖垮）。
    restarts: Mutex<Vec<Instant>>,
    /// 壳日志的内存环形缓冲，供 /host/log 回读（便于远程诊断）
    logs: Mutex<VecDeque<String>>,
}

impl ServerState {
    fn set_state(&self, next: SvcState) {
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        *guard = next;
    }

    /// 壳日志：落盘 + 进内存环。
    fn log(&self, line: &str) {
        write_log_file(&self.log_dir, line);
        let mut guard = self.logs.lock().unwrap_or_else(|e| e.into_inner());
        if guard.len() >= LOG_RING {
            guard.pop_front();
        }
        guard.push_back(line.to_string());
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::Builder::new().args([AUTOSTART_ARG]).build())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // 开机自启触发的第二次启动：系统登录时可能已经有一个实例在跑，
            // 此时不该把窗口抢到前台（用户刚登录，并不想看到这个窗口）。
            if args.iter().any(|a| a == AUTOSTART_ARG) {
                return;
            }
            // 二次启动 = 用户又双击了一次图标/快捷方式 → 把已经开着的窗口叫到前面来。
            // （冷启动自己就会开窗，见下面的启动线程；这里只管「已经在跑」的那种。）
            let state = app.state::<Arc<ServerState>>();
            state.log("[壳] 收到第二次启动：把控制台窗口叫到前面");
            show_main(app);
        }))
        .setup(|app| {
            let autostart_launch = std::env::args().any(|a| a == AUTOSTART_ARG);
            let (data_dir, portable) = resolve_data_dir(app.handle());
            let log_dir = data_dir.join("logs");
            platform::ensure_private_dir(&log_dir)?;

            let handle = app.handle().clone();
            let entry = resolve_entry(&handle);
            let guard = platform::init_kill_guard()?;
            app.manage(Arc::new(ServerState {
                child: Mutex::new(None),
                guard,
                app: app.handle().clone(),
                data_dir,
                entry,
                log_dir: log_dir.clone(),
                exiting: AtomicBool::new(false),
                control_port: AtomicU16::new(0),
                state: Mutex::new(SvcState::Stopped),
                desired: AtomicBool::new(false),
                restarts: Mutex::new(Vec::new()),
                logs: Mutex::new(VecDeque::new()),
            }));

            log_line(
                &log_dir,
                &format!(
                    "[壳] 数据目录：{}（{}）",
                    log_dir.parent().unwrap_or(&log_dir).display(),
                    if portable { "便携模式：数据随 exe 目录" } else { "安装模式：用户数据目录" }
                ),
            );

            build_tray(&handle)?;

            // 控制端口先起来：页面靠它得知状态、执行启停。它不通 = 页面上的按钮是死的。
            {
                let state = handle.state::<Arc<ServerState>>();
                let control = Arc::clone(state.inner());
                std::thread::spawn(move || control_server(control));
            }

            // 服务看门狗：意外退出自动拉起（见 supervise 的注释）
            {
                let state = handle.state::<Arc<ServerState>>();
                let watched = Arc::clone(state.inner());
                std::thread::spawn(move || supervise(watched));
            }

            // 启动即打开控制台：跟平常的桌面软件一样，双击图标就该看到界面。
            // 例外：开机自启（--autostart）只把服务拉起来并驻留托盘，不弹窗——
            // 用户登录系统时并不期待一个窗口跳出来。
            std::thread::spawn(move || {
                let state = handle.state::<Arc<ServerState>>();
                if let Err(err) = spawn_server(&state) {
                    state.log(&format!("[壳] 启动失败：{err}"));
                    state.set_state(SvcState::Error(err));
                    return;
                }
                let started = Instant::now();
                if !wait_healthz(PORT, HEALTHZ_TIMEOUT) {
                    state.log("[壳] 服务未能就绪：未开窗，可从托盘「打开控制台」重试");
                    return;
                }
                state.log(&format!("[壳] 服务就绪（{}ms）", started.elapsed().as_millis()));
                if autostart_launch {
                    state.log("[壳] 本次由开机自启触发：驻留托盘，不打开窗口");
                    return;
                }
                state.log("[壳] 打开控制台");
                // 窗口操作交给主线程执行（std::thread 里不能直接建窗）
                let app = handle.clone();
                let _ = handle.run_on_main_thread(move || show_main(&app));
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // 关窗 = 隐藏进托盘（需求：退出点击自动进托盘）。
            // 例外：壳正在退出时必须放行关闭——否则 app.exit 被这里拖住，退出明显卡顿。
            if let WindowEvent::CloseRequested { api, .. } = event {
                let exiting = window
                    .app_handle()
                    .try_state::<Arc<ServerState>>()
                    .is_some_and(|s| s.exiting.load(Ordering::SeqCst));
                if exiting {
                    return;
                }
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![open_logs])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ---------- 控制通道（回环 HTTP；页面注入的桥唯一依赖） ----------

/// 页面侧的控制桥。
///
/// 只依赖 `fetch` —— 不碰 `window.__TAURI_INTERNALS__`（外部 URL 下不存在/被 ACL 拒绝，
/// 见文件头注释）。安全边界由控制端承担：只绑回环 + 拒绝一切带 Origin 的请求
/// （浏览器发起的跨源请求必带 Origin，因此任意网页都无法越权启停服务）。
const BRIDGE_SCRIPT: &str = r#"(() => {
  // 屏蔽 WebView2 默认右键菜单的打印/扩展项（「优质打印」预览的来源），
  // 保留输入框的右键粘贴；拦截 Ctrl+P 打印预览。控制台不需要打印。
  document.addEventListener('contextmenu', (e) => {
    const t = e.target;
    const editable = !!(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable));
    if (!editable) e.preventDefault();
  }, true);
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'p' || e.key === 'P')) e.preventDefault();
  }, true);

  const PORT = __CPS_CONTROL_PORT__;
  if (!PORT) return;
  const base = 'http://127.0.0.1:' + PORT;
  const call = async (path, method) => {
    const res = await fetch(base + path, { method: method || 'GET', cache: 'no-store' });
    if (!res.ok) throw new Error('控制通道返回 ' + res.status);
    return await res.json();
  };
  window.cpsHost = {
    hosted: true,
    port: PORT,
    status: () => call('/host/status'),
    start: () => call('/host/start', 'POST'),
    stop: () => call('/host/stop', 'POST'),
    restart: () => call('/host/restart', 'POST'),
    log: () => call('/host/log'),
    openLogs: async () => { await call('/host/open-logs', 'POST'); },
    openRepo: async () => { await call('/host/open-repo', 'POST'); },
    autostart: () => call('/host/autostart'),
    setAutostart: (enabled) => call('/host/autostart?enable=' + (enabled ? '1' : '0'), 'POST'),
    info: () => call('/host/info'),

    // 自绘标题栏：窗口控制与拖动。
    // 拖动没有走 data-tauri-drag-region（外部 URL 下 Tauri 不注入其脚本），
    // 而是把「按下时的鼠标屏幕坐标」交给壳，壳在原生侧跟着鼠标移动窗口——
    // 与系统标题栏同一条体验，也不依赖任何注入脚本。
    minimize: () => call('/host/window?action=minimize', 'POST'),
    toggleMaximize: () => call('/host/window?action=toggle-maximize', 'POST'),
    close: () => call('/host/window?action=close', 'POST'),
    isMaximized: async () => (await call('/host/window?action=query', 'POST')).maximized,
    dragMove: () => call('/host/drag', 'POST'),
  };
})();
"#;

/// 控制服务：单线程 accept 循环 + 每连接一个处理线程。
fn control_server(state: Arc<ServerState>) {
    let (listener, port) = match bind_control(CONTROL_PORT) {
        Ok(v) => v,
        Err(err) => {
            state.log(&format!("[壳] 控制端口绑定失败：{err}"));
            return;
        }
    };
    state.control_port.store(port, Ordering::SeqCst);
    state.log(&format!("[壳] 控制通道就绪：http://127.0.0.1:{port}"));

    for stream in listener.incoming() {
        if state.exiting.load(Ordering::SeqCst) {
            break;
        }
        if let Ok(stream) = stream {
            let state = Arc::clone(&state);
            std::thread::spawn(move || handle_control(stream, &state));
        }
    }
}

/// 固定端口优先；被占用时退回系统分配（同机跑两个便携副本也不会互相抢）。
fn bind_control(preferred: u16) -> Result<(TcpListener, u16), String> {
    if let Ok(l) = TcpListener::bind(("127.0.0.1", preferred)) {
        return Ok((l, preferred));
    }
    let l = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    let port = l.local_addr().map_err(|e| e.to_string())?.port();
    Ok((l, port))
}

fn handle_control(stream: TcpStream, state: &Arc<ServerState>) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut reader = match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    };
    let mut buf = [0u8; 4096];
    let mut raw = Vec::new();
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                raw.extend_from_slice(&buf[..n]);
                if raw.windows(4).any(|w| w == b"\r\n\r\n") || raw.len() > 8192 {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let text = String::from_utf8_lossy(&raw);
    let request_line = text.split("\r\n").next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("");

    // ---- 来源闸门 ----
    // 无 Origin：非浏览器客户端（curl、托盘自身、脚本）→ 放行。
    // 有 Origin/Referer：必须是控制台页面自己（它在 3125，控制通道在 3122，属跨源），
    // 否则 403——任意网页都无法越权启停服务。
    let mut origin: Option<String> = None;
    let mut referer: Option<String> = None;
    for line in text.split("\r\n").skip(1) {
        let lower = line.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("origin:") {
            let _ = rest;
            origin = line.splitn(2, ':').nth(1).map(|v| v.trim().to_string());
        } else if lower.starts_with("referer:") {
            referer = line.splitn(2, ':').nth(1).map(|v| v.trim().to_string());
        }
    }
    // 有 Origin 就用 Origin；只有 Referer 时从它截出 origin（scheme://host:port）。
    let claimed_origin: Option<String> = origin.clone().or_else(|| referer.map(|r| origin_of(&r)));
    if let Some(claimed) = &claimed_origin {
        if claimed != CONSOLE_ORIGIN {
            let _ = write_control(stream, 403, "{\"error\":\"cross-origin request refused\"}");
            return;
        }
    }

    // 预检（浏览器对带自定义头的跨源请求会先问一句）：放行控制台自己的来源。
    if method == "OPTIONS" {
        let _ = write_preflight(stream);
        return;
    }

    let (code, body) = dispatch_control(method, path, state);
    let _ = write_control(stream, code, &body);
}

fn dispatch_control(method: &str, path: &str, state: &Arc<ServerState>) -> (u16, String) {
    let (route, query) = match path.split_once('?') {
        Some((p, q)) => (p, Some(q.to_string())),
        None => (path, None),
    };
    // 开机自启是「读/写同一条路由」：GET 查状态，POST 设置。
    if route == "/host/autostart" {
        let manager = state.app.autolaunch();
        match method {
            "GET" => match manager.is_enabled() {
                Ok(enabled) => return (200, format!("{{\"enabled\":{enabled}}}")),
                Err(err) => return (500, format!("{{\"error\":{}}}", json_string(&err.to_string()))),
            },
            "POST" => {
                let enable = query_param(query.as_deref().unwrap_or(""), "enable").as_deref() == Some("1");
                let result = if enable { manager.enable() } else { manager.disable() };
                if let Err(err) = result {
                    return (500, format!("{{\"error\":{}}}", json_string(&err.to_string())));
                }
                return match manager.is_enabled() {
                    Ok(enabled) => (200, format!("{{\"enabled\":{enabled}}}")),
                    Err(err) => (500, format!("{{\"error\":{}}}", json_string(&err.to_string()))),
                };
            }
            _ => return (405, "{\"error\":\"method not allowed\"}".into()),
        }
    }

    let expected = match route {
        "/host/status" | "/host/log" | "/host/info" => "GET",
        "/host/start" | "/host/stop" | "/host/restart" | "/host/open-logs" | "/host/open-repo"
        | "/host/window" | "/host/drag" => "POST",
        _ => return (404, "{\"error\":\"no such control route\"}".into()),
    };
    if method != expected {
        return (405, "{\"error\":\"method not allowed\"}".into());
    }
    match route {
        "/host/status" => (200, control_status(state)),
        "/host/info" => (
            200,
            format!(
                "{{\"version\":{},\"dataDir\":{},\"logDir\":{}}}",
                json_string(env!("CARGO_PKG_VERSION")),
                json_string(&state.data_dir.display().to_string()),
                json_string(&state.log_dir.display().to_string()),
            ),
        ),
        "/host/start" => {
            if let Err(err) = spawn_server(state) {
                state.set_state(SvcState::Error(err.clone()));
                state.log(&format!("[壳] 启动失败：{err}"));
            }
            (200, control_status(state))
        }
        "/host/stop" => {
            state.set_state(SvcState::Stopping);
            let worker = Arc::clone(state);
            std::thread::spawn(move || {
                let result = stop_server(&worker, GRACEFUL_STOP);
                worker.set_state(match result {
                    Ok(()) => SvcState::Stopped,
                    Err(err) => SvcState::Error(err),
                });
            });
            (200, control_status(state))
        }
        "/host/restart" => {
            state.set_state(SvcState::Stopping);
            let worker = Arc::clone(state);
            std::thread::spawn(move || {
                if let Err(err) = stop_server(&worker, GRACEFUL_STOP) {
                    worker.set_state(SvcState::Error(err));
                    return;
                }
                worker.set_state(SvcState::Stopped);
                if let Err(err) = spawn_server(&worker) {
                    worker.log(&format!("[壳] 重启失败：{err}"));
                    worker.set_state(SvcState::Error(err));
                }
            });
            (200, control_status(state))
        }
        "/host/open-logs" => {
            let _ = platform::open_path(&state.log_dir);
            (200, "{\"ok\":true}".into())
        }
        "/host/open-repo" => {
            if let Err(err) = platform::open_url(REPO_URL) {
                return (500, format!("{{\"error\":{}}}", json_string(&err)));
            }
            (200, "{\"ok\":true}".into())
        }
        "/host/log" => (200, recent_logs(state)),
        "/host/window" => window_control(state, query.as_deref().unwrap_or("")),
        "/host/drag" => window_drag(state),
        _ => (404, "{\"error\":\"no such control route\"}".into()),
    }
}

/// 解析 `a=1&b=2` 形式的查询串。
fn query_param(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        (k == key).then(|| v.to_string())
    })
}

/// 自绘标题栏的窗口控制。全部派发到主线程执行（Tauri 要求窗口操作在主线程）。
fn window_control(state: &Arc<ServerState>, query: &str) -> (u16, String) {
    let action = query_param(query, "action").unwrap_or_default();
    let app = state.app.clone();
    let Some(window) = app.get_webview_window("main") else {
        return (409, "{\"error\":\"窗口尚未创建\"}".into());
    };
    match action.as_str() {
        "minimize" => {
            let _ = window.minimize();
        }
        "toggle-maximize" => {
            let maximized = window.is_maximized().unwrap_or(false);
            let _ = if maximized { window.unmaximize() } else { window.maximize() };
        }
        "close" => {
            // 与系统标题栏的关闭一致：进托盘，不退出
            let _ = window.close();
        }
        "query" => {}
        _ => return (400, "{\"error\":\"unknown window action\"}".into()),
    }
    let maximized = window.is_maximized().unwrap_or(false);
    (200, format!("{{\"ok\":true,\"maximized\":{maximized}}}"))
}

/// 窗口拖动：前端在标题栏按下鼠标时打一声招呼，壳在原生侧盯着鼠标左键移动窗口。
///
/// 为什么不用 `data-tauri-drag-region`：控制台是外部 URL，Tauri 不向外部来源注入
/// 它的脚本（与 IPC 同一原因），该属性不会生效。自己跟鼠标既可靠，行为也与系统
/// 标题栏一致。拖动期间不再有后续 HTTP——壳自己判断左键何时松开。
fn window_drag(state: &Arc<ServerState>) -> (u16, String) {
    let app = state.app.clone();
    let Some(window) = app.get_webview_window("main") else {
        return (409, "{\"error\":\"窗口尚未创建\"}".into());
    };
    match platform::start_window_drag(&window) {
        Ok(()) => (200, "{\"ok\":true}".into()),
        Err(err) => (500, format!("{{\"error\":{}}}", json_string(&err))),
    }
}

fn control_status(state: &Arc<ServerState>) -> String {
    let current = sync_state(state);
    let port = state.control_port.load(Ordering::SeqCst);
    let mut body = format!("{{\"state\":\"{}\",\"port\":{port}", current.name());
    if let SvcState::Error(msg) = &current {
        body.push_str(&format!(",\"error\":{}", json_string(msg)));
    }
    body.push('}');
    body
}

/// 状态以「进程真实存活 + healthz 通过」为准，而不是只看内部标志位——
/// 服务被外部杀掉、或刚开始监听但还没 healthy，页面都能立刻反映。
///
/// 关键：`Starting` 也要参与判定。否则通过控制通道拉起服务后状态会卡在「启动中」，
/// 页面就一直转圈（健康检查才是唯一可信的运行判据）。
fn sync_state(state: &Arc<ServerState>) -> SvcState {
    let mut guard = state.state.lock().unwrap_or_else(|e| e.into_inner());
    if matches!(*guard, SvcState::Stopping) {
        return guard.clone(); // 停止/重启进行中，展示态由执行线程收尾
    }
    let alive = {
        let mut child = state.child.lock().unwrap_or_else(|e| e.into_inner());
        match child.as_mut() {
            Some(c) => c.try_wait().map(|s| s.is_none()).unwrap_or(false),
            None => false,
        }
    };
    if !alive {
        // 没有进程：除了「启动失败」这种要留住的错误，一律视为已停止
        if !matches!(*guard, SvcState::Stopped | SvcState::Error(_)) {
            *guard = SvcState::Stopped;
        }
        return guard.clone();
    }
    if healthz_ok(PORT) {
        *guard = SvcState::Running;
    } else if !matches!(*guard, SvcState::Starting) {
        // 进程在但健康检查不过：别谎报运行中
        *guard = SvcState::Starting;
    }
    guard.clone()
}

fn recent_logs(state: &Arc<ServerState>) -> String {
    let lines: Vec<String> = {
        let guard = state.logs.lock().unwrap_or_else(|e| e.into_inner());
        guard.iter().cloned().collect()
    };
    let joined = lines.iter().map(|l| json_string(l)).collect::<Vec<_>>().join(",");
    format!("{{\"lines\":[{joined}]}}")
}

/// 从 URL 截出 origin（scheme://host:port）——只用于比对，不引 URL 解析库。
fn origin_of(url: &str) -> String {
    let after_scheme = match url.find("//") {
        Some(i) => i + 2,
        None => return url.to_string(),
    };
    match url[after_scheme..].find('/') {
        Some(i) => url[..after_scheme + i].to_string(),
        None => url.to_string(),
    }
}

/// 预检响应：只放行控制台自己的来源与它实际会用的方法/头。
fn write_preflight(mut stream: TcpStream) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: {CONSOLE_ORIGIN}\r\n\
         Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
         Access-Control-Allow-Headers: Content-Type\r\n\
         Access-Control-Max-Age: 600\r\nVary: Origin\r\nContent-Length: 0\r\n\
         Connection: close\r\n\r\n"
    );
    stream.write_all(head.as_bytes())?;
    stream.flush()
}

fn write_control(mut stream: TcpStream, code: u16, body: &str) -> std::io::Result<()> {
    let reason = match code {
        200 => "OK",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "Error",
    };
    let head = format!(
        "HTTP/1.1 {code} {reason}\r\nContent-Type: application/json; charset=utf-8\r\n\
         Access-Control-Allow-Origin: {CONSOLE_ORIGIN}\r\nVary: Origin\r\n\
         Content-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body.as_bytes())?;
    stream.flush()
}

/// 最小 JSON 字符串转义（错误信息里可能有引号/反斜杠/换行）。
fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

// ---------- 窗口 ----------

/// 打开控制台。先确保服务在跑（spawn 幂等 + 就绪等待）——
/// 窗口永远指向活着的控制台，用户永远不该看到 webview 错误页。
fn show_main(app: &AppHandle) {
    {
        let state = app.state::<Arc<ServerState>>();
        if let Err(err) = spawn_server(&state) {
            state.log(&format!("[壳] 打开控制台前启动服务失败：{err}"));
            state.set_state(SvcState::Error(err));
            return;
        }
        if !wait_healthz(PORT, HEALTHZ_TIMEOUT) {
            state.log("[壳] 打开控制台前服务未就绪，稍后再试");
            return;
        }
        state.set_state(SvcState::Running);
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return;
    }
    let url: tauri::Url = format!("http://127.0.0.1:{PORT}/").parse().expect("valid url");
    let ws = default_window_size(app);
    let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title(APP_TITLE)
        // 尺寸按**逻辑**像素给（Tauri 的 inner_size 单位就是逻辑像素，见
        // webview_window.rs 的属性文档）。**不要再追加一次 `set_size` 去钉物理像素**：
        // 实测那样反而会把客户区顶高 43px（tao 在 Windows 上按「带装饰的窗口」估算
        // 外框，把标题栏算进去了，而本窗口 decorations(false)），只留一条路径时
        // 客户区就等于请求值（1506×900）。
        .inner_size(ws.logical_w, ws.logical_h)
        .min_inner_size(960.0, 640.0)
        // 无系统标题栏：标题栏由页面自绘（右上角最小化/最大化/关闭），
        // 暗色下不再有一条与页面无关的灰条，内容区也多出 30px。
        .decorations(false)
        .visible(false)
        .initialization_script(&bridge_script(app))
        .build()
        .expect("failed to create main window");
    let _ = window.center();
    {
        // 记「按什么尺寸创建」而不是读回：读回要等窗口真正显示之后才稳定
        // （窗口还隐藏时读到的是过渡中的值，实测差 43px）。
        let state = app.state::<Arc<ServerState>>();
        state.log(&format!(
            "[壳] 窗口按 {}x{} 逻辑像素创建（缩放 {}，显示器 {}x{} 物理）",
            ws.logical_w, ws.logical_h, ws.scale, ws.screen_w, ws.screen_h
        ));
    }
    // 服务已就绪才走到这里；先隐藏构建、再 show，避免空白闪烁
    let _ = window.show();
    let _ = window.set_focus();
}

/// 窗口标题：用产品名，别只写 Cline Pass（那是订阅服务的名字，不是这个工具）。
const APP_TITLE: &str = "Cline Pass+";

/// 窗口尺寸的决策结果。
struct WindowSize {
    /// 界面逻辑尺寸（给窗口构建器；也是页面拿到的视口大小）
    logical_w: f64,
    logical_h: f64,
    scale: f64,
    /// 显示器物理尺寸（诊断用：解释这个窗口尺寸是怎么算出来的）
    screen_w: u32,
    screen_h: u32,
}

/// 默认窗口尺寸：先按显示器的工作区定**逻辑**尺寸，再交给窗口构建器换算。
///
/// 不写死一个拍脑袋的数字：写死在高分屏上会小得可怜、在小屏上又会超出屏幕。
/// 界面需要的是逻辑像素（布局宽度就是它），而屏幕给的约束是物理像素——
/// 所以先用缩放比把屏幕换算成同一套单位，再取「设计需要」与「屏幕装得下」中小的那个。
fn default_window_size(app: &AppHandle) -> WindowSize {
    let monitor = app.primary_monitor().ok().flatten();
    let scale = monitor.as_ref().map(|m| m.scale_factor()).unwrap_or(1.0);
    let (sw, sh) = monitor
        .as_ref()
        .map(|m| (m.size().width, m.size().height))
        .unwrap_or((1920, 1080));
    let (avail_w, avail_h) = (sw as f64 / scale, sh as f64 / scale);
    WindowSize {
        logical_w: TARGET_LOGICAL_W.min(avail_w * 0.92).max(960.0),
        logical_h: TARGET_LOGICAL_H.min(avail_h * 0.90).max(640.0),
        scale,
        screen_w: sw,
        screen_h: sh,
    }
}

/// 目标逻辑宽度：**刚好放得下界面的内容列**。
/// 目标逻辑宽度：1170（用户在实际使用中定下来的尺寸，不是算出来的）。
///
/// 这个数字有约束，改之前先看清楚：内容列 = 1170 - 展开侧栏 200 - 留白 56 -
/// 滚动条槽位 10 = **904**，它必须放得下最宽的那张表——请求历史的最小宽度 890。
/// 所以动窗口宽度、侧栏宽度、或请求历史的列宽，这三者要一起看（见 CLAUDE.md
/// 的「装得下」不变量）。屏幕装不下这个宽度时按工作区的 92% 退让。
const TARGET_LOGICAL_W: f64 = 1170.0;
/// 目标逻辑高度：860。要求是**最高的那一页（测试台）不出纵向滚动条**——
/// 它在 860 下实测余量 191px（页面自身 579 高 + 页头 + 内边距）。
const TARGET_LOGICAL_H: f64 = 860.0;

/// 注入脚本 = 模板 + 运行期确定的控制端口。
fn bridge_script(app: &AppHandle) -> String {
    let port = app
        .try_state::<Arc<ServerState>>()
        .map(|s| s.control_port.load(Ordering::SeqCst))
        .unwrap_or(0);
    BRIDGE_SCRIPT.replace(CONTROL_PORT_PLACEHOLDER, &port.to_string())
}

// ---------- 托盘 ----------

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItemBuilder::with_id("open", "打开控制台").build(app)?;
    let start = MenuItemBuilder::with_id("start", "启动服务").build(app)?;
    let stop = MenuItemBuilder::with_id("stop", "停止服务").build(app)?;
    let restart = MenuItemBuilder::with_id("restart", "重启服务").build(app)?;
    let logs = MenuItemBuilder::with_id("logs", "打开日志目录").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "退出（结束服务进程）").build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&open)
        .separator()
        .item(&start)
        .item(&stop)
        .item(&restart)
        .separator()
        .item(&logs)
        .separator()
        .item(&quit)
        .build()?;

    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().expect("bundle icon").clone())
        .tooltip(APP_TITLE)
        .menu(&menu)
        // AppIndicator（Linux）不产生左键点击事件，左键直接弹菜单；Windows 保持左键唤窗。
        .show_menu_on_left_click(platform::tray_menu_on_left_click())
        .on_menu_event(|app, event| {
            let app = app.clone();
            // 菜单事件在主线程回调：启停等耗时操作派发到后台线程，避免卡死托盘
            match event.id().as_ref() {
                "open" => show_main(&app),
                "start" => {
                    std::thread::spawn(move || menu_start(&app));
                }
                "stop" => {
                    std::thread::spawn(move || menu_stop(&app));
                }
                "restart" => {
                    std::thread::spawn(move || menu_restart(&app));
                }
                "logs" => {
                    let dir = app.state::<Arc<ServerState>>().log_dir.clone();
                    let _ = platform::open_path(&dir);
                }
                "quit" => quit_app(&app),
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            // 左键单击托盘图标 = 打开/聚焦控制台
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn menu_start(app: &AppHandle) {
    let state = app.state::<Arc<ServerState>>();
    if let Err(err) = spawn_server(&state) {
        state.log(&format!("[壳] 托盘启动失败：{err}"));
        state.set_state(SvcState::Error(err));
        return;
    }
    if wait_healthz(PORT, HEALTHZ_TIMEOUT) {
        state.set_state(SvcState::Running);
        show_main(app);
    }
}

fn menu_stop(app: &AppHandle) {
    let state = app.state::<Arc<ServerState>>();
    state.set_state(SvcState::Stopping);
    let result = stop_server(&state, GRACEFUL_STOP);
    state.set_state(match result {
        Ok(()) => SvcState::Stopped,
        Err(err) => SvcState::Error(err),
    });
}

fn menu_restart(app: &AppHandle) {
    let state = app.state::<Arc<ServerState>>();
    state.set_state(SvcState::Stopping);
    let _ = stop_server(&state, GRACEFUL_STOP);
    state.set_state(SvcState::Stopped);
    if let Err(err) = spawn_server(&state) {
        state.log(&format!("[壳] 托盘重启失败：{err}"));
        state.set_state(SvcState::Error(err));
        return;
    }
    if wait_healthz(PORT, HEALTHZ_TIMEOUT) {
        state.set_state(SvcState::Running);
        show_main(app);
    }
}

/// 托盘「退出」：先收窗（视觉即时反馈）→ 优雅停服务 → 退出进程（Job Object 兜底）
fn quit_app(app: &AppHandle) {
    let state = app.state::<Arc<ServerState>>();
    state.exiting.store(true, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    let started = Instant::now();
    let _ = stop_server(&state, GRACEFUL_STOP);
    state.log(&format!("[壳] 托盘退出：停服耗时 {}ms，壳进程结束", started.elapsed().as_millis()));
    app.exit(0);
}

// ---------- tauri commands（只剩「打开日志目录」这类一次性动作；启停一律走控制通道） ----------

#[tauri::command]
fn open_logs(state: tauri::State<'_, Arc<ServerState>>) -> Result<(), String> {
    platform::open_path(&state.log_dir)
}

// ---------- 服务进程生命周期 ----------

fn spawn_server(state: &ServerState) -> Result<(), String> {
    let mut guard = state.child.lock().map_err(|e| e.to_string())?;
    if let Some(child) = guard.as_mut() {
        if child.try_wait().map_err(|e| e.to_string())?.is_none() {
            // 已在运行（幂等）：仍然要把「希望它在跑」记下来，看门狗据此判断
            state.desired.store(true, Ordering::SeqCst);
            return Ok(());
        }
    }

    let node = find_node(&state.app).ok_or_else(|| {
        "未找到 Node.js（需要 ≥ 20）。安装包应内置运行时；开发环境请安装 Node.js 后重试。".to_string()
    })?;

    rotate_log(&state.log_dir);
    let log_out = platform::open_log_file(&log_path(&state.log_dir)).map_err(|e| e.to_string())?;
    let log_err = log_out.try_clone().map_err(|e| e.to_string())?;

    state.log(&format!(
        "[壳] 启动服务：{} {}（DATA_DIR={}）",
        node.display(),
        state.entry.display(),
        state.data_dir.display()
    ));

    let mut command = std::process::Command::new(&node);
    command
        .arg(&state.entry)
        .env("DATA_DIR", &state.data_dir)
        .env("PORT", PORT.to_string())
        .env("BIND_HOST", "127.0.0.1")
        .env("NODE_ENV", "production")
        .env("LOG_LEVEL", "info")
        .stdout(log_out)
        .stderr(log_err);
    platform::configure_command(&mut command);
    let mut child = command.spawn().map_err(|e| format!("拉起服务失败：{e}"))?;

    // 防残留：Windows 挂进 kill-on-close 作业树；Unix 已在 pre_exec 里 setpgid +
    // PR_SET_PDEATHSIG。挂载失败必须立刻杀掉这个孩子——否则它会游离在防残留
    // 机制之外继续监听端口，既成了残留进程，又会让下一次「启动」因端口占用而失败。
    if let Err(err) = platform::attach_child(&mut child, &state.guard) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(err);
    }

    state.log(&format!("[壳] 服务已启动 pid={}", child.id()));
    *guard = Some(child);
    state.desired.store(true, Ordering::SeqCst);
    state.set_state(SvcState::Starting);
    Ok(())
}

fn stop_server(state: &ServerState, grace: Duration) -> Result<(), String> {
    // 先撤销「希望它在跑」：看门狗看到它就不会在我们收尸的间隙把服务又拉起来
    state.desired.store(false, Ordering::SeqCst);
    let mut guard = state.child.lock().map_err(|e| e.to_string())?;
    let Some(child) = guard.as_mut() else {
        return Ok(()); // 已停止（幂等）
    };

    // ① 优雅：请服务自己走 SIGTERM 同款路径（落盘 → 退出）
    let _ = shutdown_request(PORT);

    // ② 等待退出；超时则 ③ 终止整棵作业树
    let deadline = Instant::now() + grace;
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(code) => {
                state.log(&format!("[壳] 服务已退出（code={code:?}）"));
                break;
            }
            None if Instant::now() >= deadline => {
                state.log("[壳] 优雅关停超时，强制终止服务进程树");
                platform::terminate_child(child, &state.guard);
                break;
            }
            None => std::thread::sleep(Duration::from_millis(100)),
        }
    }
    *guard = None;
    Ok(())
}

/// 自动重启的限流：5 分钟内最多 3 次。
const RESTART_WINDOW: Duration = Duration::from_secs(300);
const RESTART_LIMIT: usize = 3;

/// 服务看门狗：服务**意外**退出时自动拉起。
///
/// 背景（2026-10-31 线上两次）：上游 SSE 中途断开让 Node 抛未捕获异常，进程直接
/// 退出——窗口还开着、服务没了，用户只能手动重启。根因已在服务端修掉（改用
/// pipeline 转发流错误），但任何**未来**的未捕获错误仍会以同样方式表现，
/// 而「壳只做一件事：把服务进程管起来」本身就包含「挂了要拉起来」。
///
/// 只在 `desired`（用户/启动流程希望它在跑）时生效：主动停止、托盘退出、
/// 重启过程中的空档都不会被它干扰。连续 3 次退出就停手并把原因写进状态，
/// 避免崩溃循环刷日志、拖慢机器。
fn supervise(state: Arc<ServerState>) {
    loop {
        std::thread::sleep(Duration::from_millis(1000));
        if state.exiting.load(Ordering::SeqCst) {
            return;
        }
        if !state.desired.load(Ordering::SeqCst) {
            continue;
        }
        {
            let guard = state.state.lock().unwrap_or_else(|e| e.into_inner());
            if matches!(*guard, SvcState::Stopping) {
                continue; // 停止/重启进行中，由执行线程收尾
            }
        }
        // 进程还活着 → 无事可做；已经退出 → 收尸并准备重启
        let status = {
            let mut child = state.child.lock().unwrap_or_else(|e| e.into_inner());
            match child.as_mut() {
                None => continue, // 还没有进程（启动流程自己会拉起）
                Some(c) => match c.try_wait() {
                    Ok(Some(status)) => status,
                    _ => continue,
                },
            }
        };
        {
            let mut child = state.child.lock().unwrap_or_else(|e| e.into_inner());
            *child = None;
        }

        let attempt = {
            let mut times = state.restarts.lock().unwrap_or_else(|e| e.into_inner());
            times.retain(|t| t.elapsed() < RESTART_WINDOW);
            if times.len() >= RESTART_LIMIT {
                None
            } else {
                times.push(Instant::now());
                Some(times.len())
            }
        };
        let Some(attempt) = attempt else {
            let msg = format!("服务连续退出 {RESTART_LIMIT} 次（最近一次 {status}），已停止自动重启");
            state.log(&format!("[壳] {msg}"));
            state.set_state(SvcState::Error(msg));
            state.desired.store(false, Ordering::SeqCst);
            continue;
        };

        state.log(&format!("[壳] 服务意外退出（{status}），自动重启（第 {attempt} 次）"));
        let backoff = match attempt {
            1 => 1_000,
            2 => 5_000,
            _ => 15_000,
        };
        std::thread::sleep(Duration::from_millis(backoff));
        if state.exiting.load(Ordering::SeqCst) || !state.desired.load(Ordering::SeqCst) {
            continue; // 等退避的这段时间里用户把它停了
        }
        if let Err(err) = spawn_server(&state) {
            state.log(&format!("[壳] 自动重启失败：{err}"));
            state.set_state(SvcState::Error(err));
            state.desired.store(false, Ordering::SeqCst);
        }
    }
}

// ---------- 网络探针 ----------

fn healthz_ok(port: u16) -> bool {
    http_once(port, "GET /healthz").is_some_and(|body| body.contains(" 200 "))
}

fn shutdown_request(port: u16) -> bool {
    // POST /api/shutdown：服务端只放行「来自回环且无 Origin」的请求（浏览器跨源被中间件拦截）
    http_once(port, "POST /api/shutdown").is_some_and(|body| body.contains(" 200 "))
}

fn http_once(port: u16, request_line: &str) -> Option<String> {
    let addr = ("127.0.0.1", port).to_socket_addrs().ok()?.next()?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(800)).ok()?;
    stream.set_read_timeout(Some(Duration::from_millis(1500))).ok()?;
    let req = format!(
        "{request_line} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(req.as_bytes()).ok()?;
    let mut body = String::new();
    stream.read_to_string(&mut body).ok()?;
    Some(body)
}

fn wait_healthz(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if healthz_ok(port) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

// ---------- 工具 ----------

/// 数据目录解析（VS Code Portable Mode 同款检测）：
/// exe 旁存在 `data` 目录 → **便携模式**，数据（配置/密钥/日志）就地保存；
/// 否则 → **安装模式**，用平台用户数据目录（Windows `%APPDATA%`、Linux
/// `~/.local/share/<identifier>`）——安装目录会被升级/卸载流程清空，
/// 数据混进去会被删（这是默认不能放安装目录的决定性原因，两种形态各得其所）。
fn resolve_data_dir(app: &AppHandle) -> (PathBuf, bool) {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let portable = dir.join("data");
            if portable.is_dir() {
                let _ = platform::ensure_private_dir(&portable);
                return (portable, true);
            }
        }
    }
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::current_dir().unwrap_or_default());
    let _ = platform::ensure_private_dir(&dir);
    (dir, false)
}

/// Node 主版本必须 >= 20（服务端用到 AbortSignal.any、递归 readdir 等）。
/// 只看「能否 spawn」不够：PATH 上的旧 Node 能执行，但服务会以各种难懂的方式失败。
fn node_supported(node: &std::ffi::OsStr) -> bool {
    let mut command = std::process::Command::new(node);
    command.arg("--version");
    platform::configure_command(&mut command);
    command
        .output()
        .ok()
        .filter(|out| out.status.success())
        .and_then(|out| {
            let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
            text.strip_prefix('v')
                .and_then(|v| v.split('.').next())
                .and_then(|major| major.parse::<u32>().ok())
        })
        .is_some_and(|major| major >= 20)
}

/// Node 查找顺序：**内置运行时优先**（安装包自带，版本可控），其次 PATH，
/// 最后是平台常见安装位置。Linux 桌面环境从 .desktop 启动时 PATH 很精简，
/// 只靠 PATH 会找不到 node。
fn find_node(app: &AppHandle) -> Option<PathBuf> {
    let mut bundled: Vec<PathBuf> = Vec::new();
    if let Ok(res) = app.path().resource_dir() {
        if let Some(p) = platform::bundled_node_path(Some(&res)) {
            bundled.push(p);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            if let Some(p) = platform::bundled_node_path(Some(dir)) {
                bundled.push(p);
            }
        }
    }
    for path in bundled {
        if node_supported(path.as_os_str()) {
            return Some(path);
        }
    }
    if node_supported(std::ffi::OsStr::new("node")) {
        return Some(PathBuf::from("node"));
    }
    platform::node_candidates()
        .into_iter()
        .find(|p| p.exists() && node_supported(p.as_os_str()))
}

/// 服务入口：多候选兜底（安装器 / 便携 exe / 开发环境的资源布局各不相同）
fn resolve_entry(app: &AppHandle) -> PathBuf {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(env_entry) = std::env::var("CPASS_SERVER_ENTRY") {
        candidates.push(PathBuf::from(env_entry));
    }
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(res.join("runtime/server/dist/index.js"));
    }
    if let Ok(exe) = std::env::current_exe() {
        let dir = exe.parent().unwrap_or(&exe).to_path_buf();
        candidates.push(dir.join("runtime/server/dist/index.js"));
        candidates.push(dir.join("resources/runtime/server/dist/index.js"));
        candidates.push(dir.join("../../server/dist/index.js"));
    }
    candidates.push(PathBuf::from("server/dist/index.js"));
    platform::normalize_path(
        candidates
            .into_iter()
            .find(|p| p.exists())
            .unwrap_or_else(|| PathBuf::from("server/dist/index.js")),
    )
}

fn log_path(log_dir: &Path) -> PathBuf {
    log_dir.join("server.log")
}

/// 只落盘的日志写入（setup 早期还没有状态对象时的兜底路径）。
fn write_log_file(log_dir: &Path, line: &str) {
    if let Ok(mut f) = platform::open_log_file(&log_path(log_dir)) {
        let _ = f.write_all(format!("{line}\n").as_bytes());
    }
}

fn log_line(log_dir: &Path, line: &str) {
    write_log_file(log_dir, line);
}

fn rotate_log(log_dir: &Path) {
    let path = log_path(log_dir);
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > LOG_ROTATE_BYTES {
            // Windows 的 rename 不覆盖已存在的目标：先删旧的 .old，否则第二次
            // 轮转起会静默失败，日志会无限增长。
            let old = log_dir.join("server.old.log");
            let _ = std::fs::remove_file(&old);
            let _ = std::fs::rename(&path, old);
        }
    }
}
