//! Windows 平台实现（与 3.2.2 及之前的行为保持一致）。

use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::time::Duration;

use tauri::WebviewWindow;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Job Object 句柄。裸存 isize 以满足 Send/Sync；存活期 = 壳进程（不主动关闭）。
pub struct KillGuard(isize);

pub fn init_kill_guard() -> Result<KillGuard, String> {
    unsafe {
        let job = CreateJobObjectW(None, None).map_err(|e| format!("创建作业对象失败：{e}"))?;
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            std::ptr::from_ref(&info).cast(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
        .map_err(|e| format!("配置作业对象失败：{e}"))?;
        Ok(KillGuard(job.0 as isize))
    }
}

pub fn configure_command(cmd: &mut Command) {
    cmd.creation_flags(CREATE_NO_WINDOW);
}

/// 把子进程挂进 kill-on-close 作业树。失败必须由调用方立刻杀掉孩子。
pub fn attach_child(child: &mut Child, guard: &KillGuard) -> Result<(), String> {
    unsafe {
        AssignProcessToJobObject(
            HANDLE(guard.0 as *mut _),
            HANDLE(child.as_raw_handle() as *mut _),
        )
    }
    .map_err(|e| format!("挂载作业对象失败：{e}"))
}

/// 宽限期用尽后的硬终止（整棵作业树）。
pub fn terminate_child(child: &mut Child, guard: &KillGuard) {
    unsafe {
        let _ = TerminateJobObject(HANDLE(guard.0 as *mut _), 1);
    }
    let _ = child.wait();
}

pub fn start_window_drag(window: &WebviewWindow) -> Result<(), String> {
    // 最大化状态下拖动 = 还原并跟随（Windows 的标准手感）
    if window.is_maximized().unwrap_or(false) {
        let _ = window.unmaximize();
    }
    let window = window.clone();
    std::thread::spawn(move || {
        use windows::Win32::Foundation::POINT;
        use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
        use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

        let mut start = POINT::default();
        let mut cursor = POINT::default();
        unsafe {
            if GetCursorPos(&mut start).is_err() {
                return;
            }
        }
        loop {
            let held = unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) } < 0;
            if !held {
                break;
            }
            unsafe {
                if GetCursorPos(&mut cursor).is_err() {
                    break;
                }
            }
            let dx = cursor.x - start.x;
            let dy = cursor.y - start.y;
            if dx != 0 || dy != 0 {
                if let Ok(pos) = window.outer_position() {
                    let _ = window.set_position(tauri::PhysicalPosition::new(pos.x + dx, pos.y + dy));
                }
                start = cursor;
            }
            std::thread::sleep(Duration::from_millis(8));
        }
    });
    Ok(())
}

pub fn open_path(path: &Path) -> Result<(), String> {
    Command::new("explorer")
        .arg(path)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Windows 上托盘左键由 `on_tray_icon_event` 处理；菜单只响应右键。
pub fn tray_menu_on_left_click() -> bool {
    false
}

pub fn normalize_path(p: PathBuf) -> PathBuf {
    const VERBATIM: &str = "\\\\?\\";
    let s = p.as_os_str().to_string_lossy();
    match s.strip_prefix(VERBATIM) {
        Some(stripped) => PathBuf::from(stripped.to_string()),
        None => p,
    }
}

/// PATH 之外常见的 Node 安装位置。
pub fn node_candidates() -> Vec<PathBuf> {
    vec![
        std::env::var("ProgramFiles").ok().map(|p| PathBuf::from(p).join("nodejs/node.exe")),
        std::env::var("ProgramFiles(x86)").ok().map(|p| PathBuf::from(p).join("nodejs/node.exe")),
        std::env::var("LocalAppData").ok().map(|p| PathBuf::from(p).join("Programs/nodejs/node.exe")),
    ]
    .into_iter()
    .flatten()
    .collect()
}

pub fn ensure_private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)
}

pub fn open_log_file(path: &Path) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new().create(true).append(true).open(path)
}
