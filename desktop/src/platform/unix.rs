//! Linux / Unix 平台实现。
//!
//! 防残留用两层：
//! 1. 子进程 `setpgid(0, 0)` 自成一个进程组 → 超时可 `killpg` 整组；
//! 2. Linux 上 `PR_SET_PDEATHSIG(SIGTERM)` → 壳进程消亡（含崩溃/被强杀）时，
//!    内核给服务进程发 SIGTERM，走 Node 的优雅退出路径。这是 Job Object 的对应物。
//!
//! macOS 以后接入时只需补 candidates / open 命令；PDEATHSIG 部分用 `cfg(target_os)` 隔离。

use std::io;
use std::os::unix::fs::DirBuilderExt;
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::time::Duration;

use tauri::WebviewWindow;

/// Unix 没有需要长期持有的 OS 句柄；保留类型是为了与 Windows 共用主流程。
pub struct KillGuard;

pub fn init_kill_guard() -> Result<KillGuard, String> {
    Ok(KillGuard)
}

pub fn configure_command(cmd: &mut Command) {
    unsafe {
        cmd.pre_exec(|| {
            if libc::setpgid(0, 0) != 0 {
                return Err(io::Error::last_os_error());
            }
            #[cfg(target_os = "linux")]
            {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) != 0 {
                    return Err(io::Error::last_os_error());
                }
                // 父进程可能在本进程执行 prctl 之前就消失了；此时 PDEATHSIG 不会触发。
                if libc::getppid() == 1 {
                    libc::_exit(1);
                }
            }
            Ok(())
        });
    }
}

pub fn attach_child(_child: &mut Child, _guard: &KillGuard) -> Result<(), String> {
    Ok(())
}

/// 宽限期用尽后的硬终止：先给进程组 SIGTERM（让 Node 落盘），短暂等待后再 SIGKILL。
pub fn terminate_child(child: &mut Child, _guard: &KillGuard) {
    let pid = child.id() as i32;
    unsafe {
        let _ = libc::kill(-pid, libc::SIGTERM);
    }
    for _ in 0..10 {
        if child.try_wait().ok().flatten().is_some() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    unsafe {
        let _ = libc::kill(-pid, libc::SIGKILL);
    }
    let _ = child.wait();
}

pub fn start_window_drag(window: &WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|e| e.to_string())
}

pub fn open_path(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let opener = "open";
    #[cfg(not(target_os = "macos"))]
    let opener = "xdg-open";
    Command::new(opener)
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// AppIndicator 不产生左键点击事件；左键直接弹菜单，否则 Linux 上托盘无法打开控制台。
pub fn tray_menu_on_left_click() -> bool {
    true
}

pub fn normalize_path(p: PathBuf) -> PathBuf {
    p
}

pub fn node_candidates() -> Vec<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        vec![
            PathBuf::from("/usr/local/bin/node"),
            PathBuf::from("/opt/homebrew/bin/node"),
        ]
    }
    #[cfg(not(target_os = "macos"))]
    {
        vec![
            PathBuf::from("/usr/bin/node"),
            PathBuf::from("/usr/local/bin/node"),
            PathBuf::from("/usr/bin/nodejs"),
            PathBuf::from("/snap/bin/node"),
        ]
    }
}

/// 数据目录只允许当前用户访问（配置里有上游密钥）。
pub fn ensure_private_dir(dir: &Path) -> io::Result<()> {
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
    let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    Ok(())
}

/// 日志文件 0600：里面有数据目录路径、账号名等诊断信息。
pub fn open_log_file(path: &Path) -> io::Result<std::fs::File> {
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(path)
}
