//! 平台相关能力收口。
//!
//! 桌面壳的主流程（控制通道、窗口、服务生命周期）是跨平台的；真正与操作系统
//! 绑定的只有这几件事：进程防残留、启动参数、窗口拖动、打开目录、Node 查找、
//! 路径归一化与文件权限。把它们放在这里，主文件只调用统一接口。
//!
//! 约束：**Windows 行为必须与拆分前逐字一致**（Job Object kill-on-close、
//! CREATE_NO_WINDOW、Win32 跟鼠标拖动）。Linux 用语义等价物：
//! `setpgid` + `PR_SET_PDEATHSIG` 防残留、`start_dragging()` 拖动、`xdg-open` 打开目录。

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::*;

#[cfg(unix)]
mod unix;
#[cfg(unix)]
pub use unix::*;

use std::path::{Path, PathBuf};

/// 内置运行时的可执行文件位置：`<resource_dir>/runtime/node[.exe]`。
///
/// 只负责拼路径与判断存在；版本检查由调用方做（`node_supported`）。
pub fn bundled_node_path(resource_dir: Option<&Path>) -> Option<PathBuf> {
    let dir = resource_dir?;
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    let path = dir.join("runtime").join(name);
    path.is_file().then_some(path)
}
