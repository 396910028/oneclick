#!/usr/bin/env bash
# 节点机诊断：上不了网时在节点上运行，输出关键状态供排查
# 用法：sudo bash diag-node.sh  或  sudo /opt/panel-node-xray/tools/diag-node.sh

set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/panel-node-xray}"
ENV_FILE="${ENV_FILE:-${INSTALL_DIR}/daemon.env}"

echo "=============================================="
echo " 节点诊断（上不了网时请把本输出贴给排查）"
echo "=============================================="

# 1) 端口监听
echo
echo "[1] 端口监听"
echo "---"
if command -v ss >/dev/null 2>&1; then
  ss -tlnp 2>/dev/null | grep -E ':443|:10085' || echo "未发现 443 或 10085 监听"
else
  netstat -tlnp 2>/dev/null | grep -E ':443|:10085' || echo "未发现 443 或 10085 监听"
fi

# 2) 服务状态
echo
echo "[2] 服务状态"
echo "---"
for u in panel-xray panel-xray-daemon; do
  if systemctl is-active --quiet "$u" 2>/dev/null; then
    echo "$u: running"
  else
    echo "$u: not running"
  fi
done

# 3) applied.json（是否有用户）
echo
echo "[3] 已应用 UUID（applied.json）"
echo "---"
for f in "${INSTALL_DIR}"/out/node-*/applied.json; do
  if [[ -f "$f" ]]; then
    echo "文件: $f"
    cat "$f" | head -20
  fi
done
if ! compgen -G "${INSTALL_DIR}/out/node-*/applied.json" >/dev/null 2>&1; then
  echo "未找到 applied.json（connector 尚未成功同步用户到 Xray）"
fi

# 4) Xray 配置摘要（端口、inbound tag、outbound）
echo
echo "[4] Xray 配置摘要（/etc/xray/config.json）"
echo "---"
if [[ -f /etc/xray/config.json ]]; then
  echo "VLESS 端口: $(jq -r '.inbounds[]? | select(.tag=="in-vless-reality") | .port' /etc/xray/config.json 2>/dev/null || echo 'N/A')"
  echo "VLESS 配置文件 clients 数量: $(jq -r '.inbounds[]? | select(.tag=="in-vless-reality") | .settings.clients | length' /etc/xray/config.json 2>/dev/null || echo '0') （gRPC 热更新下恒为 0，用户存在内存，以 applied.json 为准）"
  echo "outbounds: $(jq -r '.outbounds[]?.tag' /etc/xray/config.json 2>/dev/null | tr '\n' ' ')"
  echo "routing 规则数: $(jq -r '.routing.rules | length' /etc/xray/config.json 2>/dev/null || echo '0')"
else
  echo "未找到 /etc/xray/config.json"
fi

# 5) 防火墙
echo
echo "[5] 防火墙（ufw/iptables）"
echo "---"
if command -v ufw >/dev/null 2>&1; then
  ufw status 2>/dev/null | head -20 || true
else
  echo "ufw 未安装"
fi
iptables -L INPUT -n 2>/dev/null | head -15 || true

# 6) 本机出口 IP（客户端应填的服务器地址）
echo
echo "[6] 本机公网 IP（客户端「服务器地址」应填此 IP 或解析到此 IP 的域名）"
echo "---"
curl -s --connect-timeout 3 ifconfig.me 2>/dev/null || curl -s --connect-timeout 3 ip.sb 2>/dev/null || echo "无法获取"

# 7) 面板连通性（可选）
echo
echo "[7] 面板连通性（INTERNAL_API_KEY 从 daemon.env 读）"
echo "---"
if [[ -f "${ENV_FILE}" ]]; then
  # shellcheck disable=SC1090
  . "${ENV_FILE}" 2>/dev/null || true
  url="${PANEL_BASE_URL%/}/api/internal/nodes"
  if [[ -n "${PANEL_BASE_URL:-}" ]]; then
    code=$(curl -s -o /dev/null -w "%{http_code}" -H "x-internal-token: ${INTERNAL_API_KEY:-}" "$url" 2>/dev/null || echo "000")
    echo "GET ${url} -> HTTP $code"
  else
    echo "PANEL_BASE_URL 未设置"
  fi
else
  echo "未找到 ${ENV_FILE}"
fi

echo
echo "=============================================="
echo " 请检查："
echo "  - [1] 443 是否由 xray 监听；10085 是否由 xray 监听"
echo "  - [3] applied.json 是否有你的 UUID"
echo "  - [4] gRPC 模式下 config 里 clients 恒为 0，以 [3] applied.json 为准"
echo "  - [5] 云服务器安全组是否放行 入站 TCP 443"
echo "  - [6] 客户端「服务器地址」是否填的 [6] 中的 IP（或解析到该 IP 的域名）"
echo "  - 客户端 UUID / Reality publicKey / shortId / sni 是否与面板该节点一致"
echo "=============================================="
