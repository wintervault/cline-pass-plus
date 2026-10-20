#!/bin/sh
# Tauri 把 bundle.resources 打进 /usr/lib/<productName>/，资源文件默认不带可执行位；
# 内置 Node 运行时必须以 0755 安装，否则壳无法拉起服务。
set -e
NODE=/usr/lib/cline-pass-plus/runtime/node
if [ -f "$NODE" ]; then
  chmod 0755 "$NODE"
fi
exit 0
