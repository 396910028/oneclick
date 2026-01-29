#!/usr/bin/env bash
set -euo pipefail

# 节点机一键安装 Xray（VLESS Reality + gRPC 热更新） + 对接当前面板
# 用法（节点机）：
#   curl -fsSL https://raw.githubusercontent.com/396910028/oneclick/master/oneclick/install-xray-node.sh | sudo bash

REPO_URL="${REPO_URL:-https://github.com/396910028/oneclick.git}"
SRC_DIR="${SRC_DIR:-/opt/panel-node-xray-src}"

if [[ $EUID -ne 0 ]]; then
  echo "请用 root 执行（sudo）" >&2
  exit 1
fi

echo ">>> [1/3] 更新系统 & 安装依赖 (git/curl/ca-certificates)..."
apt-get update -y
apt-get install -y git curl ca-certificates

echo ">>> [2/3] 克隆/更新仓库（强制更新，丢弃本地修改）..."
mkdir -p "${SRC_DIR}"
if [[ -d "${SRC_DIR}/.git" ]]; then
  # 强制更新：先重置本地修改，再拉取最新代码
  echo ">>> [git] 强制更新仓库（丢弃本地修改）..."
  cd "${SRC_DIR}"
  # 先获取远程更新
  git fetch origin >/dev/null 2>&1 || true
  # 获取当前分支名（如果失败则使用 master）
  CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'master')"
  echo ">>> [git] 当前分支: ${CURRENT_BRANCH}"
  # 强制重置到远程分支（按优先级尝试）
  if git reset --hard "origin/${CURRENT_BRANCH}" >/dev/null 2>&1; then
    echo ">>> [git] 已重置到 origin/${CURRENT_BRANCH}"
  elif git reset --hard origin/master >/dev/null 2>&1; then
    echo ">>> [git] 已重置到 origin/master"
  elif git reset --hard origin/main >/dev/null 2>&1; then
    echo ">>> [git] 已重置到 origin/main"
  else
    echo ">>> [git] 警告：reset 失败，尝试清理后重新克隆..."
    cd - >/dev/null 2>&1
    rm -rf "${SRC_DIR}"
    git clone "${REPO_URL}" "${SRC_DIR}"
    cd "${SRC_DIR}"
  fi
  # 清理未跟踪的文件和目录（更彻底）
  git clean -fd >/dev/null 2>&1 || true
  # 再次拉取确保最新
  git pull --rebase >/dev/null 2>&1 || git pull >/dev/null 2>&1 || true
  cd - >/dev/null 2>&1
  echo ">>> [git] 仓库更新完成"
else
  echo ">>> [git] 首次克隆仓库..."
  rm -rf "${SRC_DIR}"
  git clone "${REPO_URL}" "${SRC_DIR}"
fi

echo ">>> [3/3] 运行 Xray 一键脚本（VLESS+Reality+gRPC 热更新）..."
cd "${SRC_DIR}/oneclick"
chmod +x ubuntu-xray-reality-grpc-oneclick.sh
./ubuntu-xray-reality-grpc-oneclick.sh

echo
echo ">>> 完成。常用检查命令："
echo "  - systemctl status panel-xray.service --no-pager"
echo "  - systemctl status panel-xray-daemon.service --no-pager"
echo "  - ss -lntp | grep 10085   # 确认 gRPC API 仅监听 127.0.0.1:${XRAY_API_PORT:-10085}"
echo "  - xp / xray-panel / xr    # 节点机本地按键面板"

