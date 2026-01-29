#!/usr/bin/env bash
set -euo pipefail

# Ubuntu 一键开局（sing-box 多协议版，推荐给你选的 B 方案）
#
# 能力：
# - Docker 运行 sing-box（host network）
# - 一台机器同时提供：VLESS(Reality)、VMess(TLS)、Trojan(TLS)、Hysteria2(TLS)、SOCKS5(鉴权)
# - 自动向面板注册多个节点（每个协议/端口一条 nodes 记录）
# - systemd 同步服务：定时拉取 allowed UUID 列表 → 写回 sing-box 入站 users → 重启容器
#   => 真正做到“套餐到期/封禁/超流量立即断网”（客户端不刷新订阅也会断）
#
# 说明：
# - VMess/Trojan/Hy2 默认使用自签证书，客户端需开启“允许不安全证书(insecure)”或跳过证书验证。
# - 你后续可以改为真实域名+ACME（sing-box 自带 acme 字段，可升级）。
#
# 用法：
#   sudo bash ubuntu-singbox-multi-oneclick.sh \
#     --panel "http://你的面板IP或域名:3000" \
#     --token "INTERNAL_API_KEY的值" \
#     --name  "HK-SB-01" \
#     --sni   "www.cloudflare.com"
#
# 可选：自定义端口
#   --vless 443 --vmess 8443 --trojan 8444 --hy2 8445 --socks 1080

PANEL_BASE_URL=""
INTERNAL_TOKEN=""
NODE_NAME="singbox-node"
SNI="www.cloudflare.com"

PORT_BASE="1080"          # 连续端口起始（包含 SOCKS）
PORT_SOCKS="1080"
PORT_VLESS="1081"
PORT_VMESS="1082"
PORT_TROJAN="1083"
PORT_HY2="1084"
AGENT_PORT="1085"

SET_VLESS=0
SET_VMESS=0
SET_TROJAN=0
SET_HY2=0
SET_SOCKS=0
SET_AGENT=0
SET_BASE=0

SYNC_INTERVAL="10"
INSTALL_DIR="/opt/panel-node-sb"

MODE="agent" # agent=面板主动连节点（默认）；panel=节点主动连面板

prompt() {
  local label="$1"
  local def="${2:-}"
  local val=""
  if [[ -n "${def}" ]]; then
    read -r -p "${label} (默认: ${def}): " val
    val="${val:-${def}}"
  else
    read -r -p "${label}: " val
  fi
  echo "${val}"
}

prompt_secret() {
  local label="$1"
  local val=""
  read -r -s -p "${label} (输入不回显): " val
  echo
  echo "${val}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    --panel) PANEL_BASE_URL="$2"; shift 2 ;;
    --token) INTERNAL_TOKEN="$2"; shift 2 ;;
    --name) NODE_NAME="$2"; shift 2 ;;
    --sni) SNI="$2"; shift 2 ;;
    --base-port) PORT_BASE="$2"; SET_BASE=1; shift 2 ;;
    --vless) PORT_VLESS="$2"; SET_VLESS=1; shift 2 ;;
    --vmess) PORT_VMESS="$2"; SET_VMESS=1; shift 2 ;;
    --trojan) PORT_TROJAN="$2"; SET_TROJAN=1; shift 2 ;;
    --hy2) PORT_HY2="$2"; SET_HY2=1; shift 2 ;;
    --socks) PORT_SOCKS="$2"; SET_SOCKS=1; shift 2 ;;
    --agent-port) AGENT_PORT="$2"; SET_AGENT=1; shift 2 ;;
    --interval) SYNC_INTERVAL="$2"; shift 2 ;;
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ $EUID -ne 0 ]]; then
  echo "请用 root 执行（sudo）" >&2
  exit 1
fi

echo "==============================================================="
echo "sing-box 多协议一键开局（交互模式）"
echo "提示：你也可以用参数模式运行（--panel/--token/--name/--sni 等）"
echo "==============================================================="

MODE="$(prompt "请选择模式：agent=面板主动连节点（推荐/默认），panel=节点主动连面板" "${MODE}")"
if [[ "${MODE}" != "agent" && "${MODE}" != "panel" ]]; then
  echo "模式无效：${MODE}（只能是 agent 或 panel）" >&2
  exit 2
fi

if [[ "${MODE}" == "panel" ]]; then
  if [[ -z "${PANEL_BASE_URL}" ]]; then
    PANEL_BASE_URL="$(prompt "请输入面板后端地址（示例：http://1.2.3.4:3000 或 http://domain:3000）")"
  fi
  if [[ -z "${INTERNAL_TOKEN}" ]]; then
    INTERNAL_TOKEN="$(prompt_secret "请输入 INTERNAL_API_KEY（对应面板 backend/.env.docker 的 INTERNAL_API_KEY）")"
  fi
  if [[ -z "${PANEL_BASE_URL}" || -z "${INTERNAL_TOKEN}" ]]; then
    echo "面板地址或 INTERNAL_API_KEY 为空，退出。" >&2
    exit 2
  fi
else
  echo "[mode=agent] 选择了面板主动连节点：无需填写面板地址/INTERNAL_API_KEY。"
fi
if [[ -z "${NODE_NAME}" ]]; then
  NODE_NAME="singbox-node"
fi
NODE_NAME="$(prompt "请输入节点名称" "${NODE_NAME}")"
SNI="$(prompt "请输入 Reality SNI（建议 cloudflare/google 站点域名）" "${SNI}")"

PORT_BASE="$(prompt "请输入连续端口起始（共 6 个端口：SOCKS/VLESS/VMess/Trojan/Hy2/Agent）" "${PORT_BASE}")"
if ! [[ "${PORT_BASE}" =~ ^[0-9]+$ ]]; then
  echo "端口起始无效：${PORT_BASE}" >&2
  exit 2
fi

# 自动计算连续端口（除非用户显式传参覆盖）
if [[ "${SET_SOCKS}" -eq 0 ]]; then PORT_SOCKS="${PORT_BASE}"; fi
if [[ "${SET_VLESS}" -eq 0 ]]; then PORT_VLESS="$((PORT_BASE + 1))"; fi
if [[ "${SET_VMESS}" -eq 0 ]]; then PORT_VMESS="$((PORT_BASE + 2))"; fi
if [[ "${SET_TROJAN}" -eq 0 ]]; then PORT_TROJAN="$((PORT_BASE + 3))"; fi
if [[ "${SET_HY2}" -eq 0 ]]; then PORT_HY2="$((PORT_BASE + 4))"; fi
if [[ "${SET_AGENT}" -eq 0 ]]; then AGENT_PORT="$((PORT_BASE + 5))"; fi

PORT_START="${PORT_BASE}"
PORT_END="$((PORT_BASE + 5))"
echo "端口规划：${PORT_START}-${PORT_END}（共 6 个端口）"
echo "  SOCKS5=${PORT_SOCKS}"
echo "  VLESS =${PORT_VLESS}"
echo "  VMess =${PORT_VMESS}"
echo "  Trojan=${PORT_TROJAN}"
echo "  Hy2   =${PORT_HY2}"
echo "  Agent =${AGENT_PORT}"

SYNC_INTERVAL="$(prompt "请输入同步间隔秒（仅模式 panel 使用；mode=agent 可忽略）" "${SYNC_INTERVAL}")"
INSTALL_DIR="$(prompt "请输入安装目录（新机器建议默认即可）" "${INSTALL_DIR}")"

# 容器名：按起始端口区分，避免多次运行冲突
CONTAINER_NAME_DEFAULT="panel_singbox_${PORT_BASE}"
CONTAINER_NAME="${CONTAINER_NAME_DEFAULT}"

cleanup_systemd_service() {
  local svc="$1"
  if systemctl list-unit-files --type=service 2>/dev/null | awk '{print $1}' | grep -qx "${svc}"; then
    echo "[systemd] stop/disable 旧服务：${svc}"
    systemctl stop "${svc}" >/dev/null 2>&1 || true
    systemctl disable "${svc}" >/dev/null 2>&1 || true
  fi
  if [[ -f "/etc/systemd/system/${svc}" ]]; then
    rm -f "/etc/systemd/system/${svc}"
  fi
}

echo "[systemd] 清理旧服务（重跑覆盖配置）..."
cleanup_systemd_service "panel-node-agent.service"
cleanup_systemd_service "panel-singbox-connector.service"
cleanup_systemd_service "panel-connector.service"
systemctl daemon-reload >/dev/null 2>&1 || true

open_ports() {
  local start="$1"
  local end="$2"
  echo "[net] 尝试自动放行端口（TCP/UDP）：${start}-${end}"
  # UFW（最常见）
  if command -v ufw >/dev/null 2>&1; then
    local ufw_status
    ufw_status="$(ufw status 2>/dev/null | head -n1 || true)"
    if echo "${ufw_status}" | grep -qi "active"; then
      ufw allow "${start}:${end}/tcp" >/dev/null 2>&1 || true
      ufw allow "${start}:${end}/udp" >/dev/null 2>&1 || true
      echo "[net] ufw 已放行 ${start}-${end} TCP/UDP"
      return 0
    fi
  fi
  # firewalld
  if command -v firewall-cmd >/dev/null 2>&1; then
    if firewall-cmd --state >/dev/null 2>&1; then
      firewall-cmd --permanent --add-port="${start}-${end}/tcp" >/dev/null 2>&1 || true
      firewall-cmd --permanent --add-port="${start}-${end}/udp" >/dev/null 2>&1 || true
      firewall-cmd --reload >/dev/null 2>&1 || true
      echo "[net] firewalld 已放行 ${start}-${end} TCP/UDP"
      return 0
    fi
  fi
  echo "[net] 未检测到已启用的 ufw/firewalld，无法自动放行。"
  echo "[net] 请到云厂商安全组放行：TCP/UDP ${start}-${end}（至少 TCP ${PORT_START}-${PORT_END}，Hy2 需要 UDP ${PORT_HY2}）"
}

confirm() {
  local label="$1"
  local def="${2:-Y}"
  local v=""
  read -r -p "${label} (默认: ${def}): " v
  v="${v:-${def}}"
  [[ "${v}" =~ ^[Yy]$ ]]
}

apt-get update -y
apt-get install -y ca-certificates curl jq openssl python3

COMPOSE_CMD=""
ensure_docker_official_repo() {
  # 自动添加 Docker 官方 APT 源（适配 Ubuntu 20.04/22.04/24.04）
  if [[ -f /etc/apt/sources.list.d/docker.list ]]; then
    return 0
  fi

  echo "[docker] 正在添加 Docker 官方 APT 源..."
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg

  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg

  local arch
  arch="$(dpkg --print-architecture)"
  local codename
  codename="$(. /etc/os-release && echo "${VERSION_CODENAME}")"

  echo \
    "deb [arch=${arch} signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${codename} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
}

install_docker_and_compose() {
  # 先尝试官方源安装（带 compose plugin）
  ensure_docker_official_repo
  if apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin; then
    systemctl enable --now docker || true
    return 0
  fi

  # 兜底：Ubuntu 仓库 docker.io + docker-compose(v1)
  echo "[docker] 官方源安装失败，回退到 Ubuntu 仓库 docker.io + docker-compose(v1)..."
  apt-get update -y
  apt-get install -y docker.io docker-compose
  systemctl enable --now docker || true
}

if ! command -v docker >/dev/null 2>&1; then
  install_docker_and_compose
else
  systemctl enable --now docker >/dev/null 2>&1 || true
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD="docker-compose"
else
  # Docker 已装但 compose 没装：再补一次官方源安装
  install_docker_and_compose
  if docker compose version >/dev/null 2>&1; then
    COMPOSE_CMD="docker compose"
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_CMD="docker-compose"
  else
    echo "未检测到 docker compose 或 docker-compose，请检查 Docker 安装源后重试。" >&2
    exit 1
  fi
fi

mkdir -p "${INSTALL_DIR}"/{singbox,certs,connector}
echo "${CONTAINER_NAME}" > "${INSTALL_DIR}/container_name"

PUBLIC_IP="$(curl -fsSL https://api.ipify.org || true)"
if [[ -z "${PUBLIC_IP}" ]]; then
  PUBLIC_IP="$(hostname -I | awk '{print $1}')"
fi

SB_IMAGE="ghcr.io/sagernet/sing-box:latest"
XRAY_IMAGE="ghcr.io/xtls/xray-core:latest"

echo "[1/7] 拉取镜像..."
docker pull "${SB_IMAGE}" >/dev/null
docker pull "${XRAY_IMAGE}" >/dev/null

echo "[2/7] 生成 Reality keypair + shortId..."
# 注意：部分 xray 版本的 x25519 输出不包含 PublicKey（只含 PrivateKey/Password/Hash32）
# 因此这里改为优先使用 sing-box 生成 Reality keypair（包含 PrivateKey + PublicKey）
KEY_OUT_SB="$(docker run --rm --entrypoint sing-box "${SB_IMAGE}" generate reality-keypair 2>/dev/null || true)"
REALITY_PRIVATE_KEY="$(echo "${KEY_OUT_SB}" | awk -F'[: ]+' '/^PrivateKey:/ {print $2} /^Private key:/ {print $3}' | head -n1)"
REALITY_PUBLIC_KEY="$(echo "${KEY_OUT_SB}" | awk -F'[: ]+' '/^PublicKey:/ {print $2} /^Public key:/ {print $3}' | head -n1)"

if [[ -z "${REALITY_PRIVATE_KEY}" || -z "${REALITY_PUBLIC_KEY}" ]]; then
  echo "Reality key 生成失败（无法解析 sing-box 输出）：" >&2
  echo "${KEY_OUT_SB:-<empty>}" >&2
  exit 1
fi
REALITY_SHORT_ID="$(head -c 8 /dev/urandom | xxd -p)"

echo "[3/7] 生成自签 TLS 证书（给 VMess/Trojan/Hy2 用）..."
CERT_PATH_HOST="${INSTALL_DIR}/certs/server.crt"
KEY_PATH_HOST="${INSTALL_DIR}/certs/server.key"
CERT_PATH_CONT="/opt/certs/server.crt"
KEY_PATH_CONT="/opt/certs/server.key"
if [[ ! -f "${CERT_PATH_HOST}" || ! -f "${KEY_PATH_HOST}" ]]; then
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "${KEY_PATH_HOST}" \
    -out "${CERT_PATH_HOST}" \
    -days 3650 \
    -subj "/CN=${PUBLIC_IP}" >/dev/null 2>&1
fi

echo "[4/7] 写入 sing-box 配置..."
cat > "${INSTALL_DIR}/singbox/config.json" <<EOF
{
  "log": { "level": "warn" },
  "inbounds": [
    {
      "type": "vless",
      "tag": "in-vless-reality",
      "listen": "0.0.0.0",
      "listen_port": ${PORT_VLESS},
      "users": [],
      "tls": {
        "enabled": true,
        "reality": {
          "enabled": true,
          "handshake": { "server": "${SNI}", "server_port": 443 },
          "private_key": "${REALITY_PRIVATE_KEY}",
          "short_id": ["${REALITY_SHORT_ID}"]
        }
      }
    },
    {
      "type": "vmess",
      "tag": "in-vmess-tls",
      "listen": "0.0.0.0",
      "listen_port": ${PORT_VMESS},
      "users": [],
      "tls": {
        "enabled": true,
        "certificate_path": "${CERT_PATH_CONT}",
        "key_path": "${KEY_PATH_CONT}"
      }
    },
    {
      "type": "trojan",
      "tag": "in-trojan-tls",
      "listen": "0.0.0.0",
      "listen_port": ${PORT_TROJAN},
      "users": [],
      "tls": {
        "enabled": true,
        "certificate_path": "${CERT_PATH_CONT}",
        "key_path": "${KEY_PATH_CONT}"
      }
    },
    {
      "type": "hysteria2",
      "tag": "in-hy2",
      "listen": "0.0.0.0",
      "listen_port": ${PORT_HY2},
      "users": [],
      "tls": {
        "enabled": true,
        "certificate_path": "${CERT_PATH_CONT}",
        "key_path": "${KEY_PATH_CONT}"
      }
    },
    {
      "type": "socks",
      "tag": "in-socks5",
      "listen": "0.0.0.0",
      "listen_port": ${PORT_SOCKS},
      "users": []
    }
  ],
  "outbounds": [
    { "type": "direct", "tag": "direct" }
  ]
}
EOF

echo "[5/7] 写入 docker-compose.yml 并启动 sing-box..."
cat > "${INSTALL_DIR}/docker-compose.yml" <<EOF
services:
  singbox:
    image: ${SB_IMAGE}
    container_name: ${CONTAINER_NAME}
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./singbox/config.json:/etc/sing-box/config.json:rw
      - ./certs:/opt/certs:ro
EOF

cd "${INSTALL_DIR}"
if docker ps -a --format '{{.Names}}' | grep -qx "${CONTAINER_NAME}"; then
  echo "[WARN] 检测到已存在容器：${CONTAINER_NAME}"
  if confirm "是否删除并重建该容器？" "Y"; then
    docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  else
    echo "已选择不删除，将尝试直接启动/复用现有容器。"
  fi
fi
${COMPOSE_CMD} up -d

echo "[6/7] 节点注册..."

register_node() {
  local name="$1"
  local protocol="$2"
  local port="$3"
  local config_json="$4"
  local payload
  payload="$(jq -nc \
    --arg name "${name}" \
    --arg address "${PUBLIC_IP}" \
    --argjson port "${port}" \
    --arg protocol "${protocol}" \
    --argjson cfg "${config_json}" \
    '{name:$name,address:$address,port:$port,protocol:$protocol,config:$cfg,status:1,sort_order:0}' \
  )"
  curl -fsSL \
    -H "Content-Type: application/json" \
    -H "x-internal-token: ${INTERNAL_TOKEN}" \
    -d "${payload}" \
    "${PANEL_BASE_URL%/}/api/internal/register-node" \
    | jq -r '.data.id'
}

CFG_VLESS="$(jq -nc \
  --arg security "reality" \
  --arg sni "${SNI}" \
  --arg publicKey "${REALITY_PUBLIC_KEY}" \
  --arg shortId "${REALITY_SHORT_ID}" \
  --arg flow "xtls-rprx-vision" \
  '{security:$security,sni:$sni,publicKey:$publicKey,shortId:$shortId,flow:$flow,encryption:"none",managed:{provider:"sing-box",mode:"pull-uuids"}}' \
)"
CFG_TLS_INSECURE="$(jq -nc --arg sni "${PUBLIC_IP}" '{tls:"tls",sni:$sni,insecure:true,managed:{provider:"sing-box",mode:"pull-uuids"}}')"
CFG_HY2="$(jq -nc --arg sni "${PUBLIC_IP}" '{sni:$sni,alpn:["h3"],insecure:true,managed:{provider:"sing-box",mode:"pull-uuids"}}')"
CFG_SOCKS="$(jq -nc '{managed:{provider:"sing-box",mode:"pull-uuids"}}')"

NODE_ID_VLESS=""
NODE_ID_VMESS=""
NODE_ID_TROJAN=""
NODE_ID_HY2=""
NODE_ID_SOCKS=""

if [[ "${MODE}" == "panel" ]]; then
  echo "[mode=panel] 正在向面板注册节点（每个协议/端口一条记录）..."
  NODE_ID_VLESS="$(register_node "${NODE_NAME} VLESS Reality" "vless" "${PORT_VLESS}" "${CFG_VLESS}")"
  NODE_ID_VMESS="$(register_node "${NODE_NAME} VMess TLS" "vmess" "${PORT_VMESS}" "${CFG_TLS_INSECURE}")"
  NODE_ID_TROJAN="$(register_node "${NODE_NAME} Trojan TLS" "trojan" "${PORT_TROJAN}" "${CFG_TLS_INSECURE}")"
  NODE_ID_HY2="$(register_node "${NODE_NAME} Hysteria2" "hysteria2" "${PORT_HY2}" "${CFG_HY2}")"
  NODE_ID_SOCKS="$(register_node "${NODE_NAME} SOCKS5" "socks" "${PORT_SOCKS}" "${CFG_SOCKS}")"

  echo "${PANEL_BASE_URL%/}" > "${INSTALL_DIR}/panel_url"
  echo "${INTERNAL_TOKEN}" > "${INSTALL_DIR}/internal_token"
  echo "${NODE_ID_VLESS},${NODE_ID_VMESS},${NODE_ID_TROJAN},${NODE_ID_HY2},${NODE_ID_SOCKS}" > "${INSTALL_DIR}/node_ids"
  echo "${SYNC_INTERVAL}" > "${INSTALL_DIR}/sync_interval_seconds"
else
  echo "[mode=agent] 跳过向面板注册节点（由面板在节点管理中一键导入）。"
fi

echo "[7/7] 创建同步服务：拉 allowed-uuids -> 写回 sing-box users -> 重启容器..."
if [[ "${MODE}" != "panel" ]]; then
  echo "[mode=agent] 跳过 pull-uuids 同步服务（由面板 push-uuids 到 node-agent）。"
  # 仍继续安装 node-agent
else
cat > "${INSTALL_DIR}/connector/sync.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

DIR="/opt/panel-node-sb"
PANEL_URL="$(cat "${DIR}/panel_url")"
TOKEN="$(cat "${DIR}/internal_token")"
NODE_IDS_CSV="$(cat "${DIR}/node_ids")"
CFG="${DIR}/singbox/config.json"
TMP="${DIR}/singbox/config.json.tmp"
LAST="${DIR}/connector/last_hash"
CONTAINER_NAME="$(cat "${DIR}/container_name" 2>/dev/null || echo panel_singbox)"

fetch_uuids() {
  local node_id="$1"
  curl -fsSL -H "x-internal-token: ${TOKEN}" "${PANEL_URL%/}/api/internal/nodes/${node_id}/allowed-uuids" \
    | jq -c '.data.uuids // []'
}

SYNC_INTERVAL="$(cat "${DIR}/sync_interval_seconds" 2>/dev/null || echo 10)"
if ! [[ "${SYNC_INTERVAL}" =~ ^[0-9]+$ ]]; then SYNC_INTERVAL="10"; fi

while true; do
  # 任意一个节点的 uuid 列表变了，都刷新整份配置（同一批 uuid 用于多协议 users）
  # （面板侧是按 node_id 限制的；这里取 vless 节点的允许列表作为主列表）
  MAIN_NODE_ID="$(echo "${NODE_IDS_CSV}" | cut -d',' -f1)"
  UUIDS_JSON="$(fetch_uuids "${MAIN_NODE_ID}")" || {
    echo "[WARN] fetch allowed uuids failed"
    sleep 5
    continue
  }

  HASH="$(echo "${UUIDS_JSON}" | sha256sum | awk '{print $1}')"
  OLD="$(cat "${LAST}" 2>/dev/null || true)"
  if [[ "${HASH}" == "${OLD}" ]]; then
    sleep "${SYNC_INTERVAL}"
    continue
  fi
  echo "${HASH}" > "${LAST}"

  VLESS_USERS="$(echo "${UUIDS_JSON}" | jq -c '[ .[] | {name: ., uuid: ., flow: "xtls-rprx-vision"} ]')"
  VMESS_USERS="$(echo "${UUIDS_JSON}" | jq -c '[ .[] | {name: ., uuid: ., alterId: 0} ]')"
  TROJAN_USERS="$(echo "${UUIDS_JSON}" | jq -c '[ .[] | {name: ., password: .} ]')"
  HY2_USERS="$(echo "${UUIDS_JSON}" | jq -c '[ .[] | {name: ., password: .} ]')"
  SOCKS_USERS="$(echo "${UUIDS_JSON}" | jq -c '[ .[] | {username: ., password: .} ]')"

  jq \
    --argjson vless "${VLESS_USERS}" \
    --argjson vmess "${VMESS_USERS}" \
    --argjson trojan "${TROJAN_USERS}" \
    --argjson hy2 "${HY2_USERS}" \
    --argjson socks "${SOCKS_USERS}" \
    '
    .inbounds |= (map(
      if .tag == "in-vless-reality" then .users = $vless
      elif .tag == "in-vmess-tls" then .users = $vmess
      elif .tag == "in-trojan-tls" then .users = $trojan
      elif .tag == "in-hy2" then .users = $hy2
      elif .tag == "in-socks5" then .users = $socks
      else .
      end
    ))' \
    "${CFG}" > "${TMP}"
  mv "${TMP}" "${CFG}"

  echo "[INFO] users updated -> restart sing-box (count=$(echo "${UUIDS_JSON}" | jq 'length'))"
  docker restart "${CONTAINER_NAME}" >/dev/null || true

  sleep "${SYNC_INTERVAL}"
done
EOF
chmod +x "${INSTALL_DIR}/connector/sync.sh"

cat > /etc/systemd/system/panel-singbox-connector.service <<EOF
[Unit]
Description=Panel sing-box connector (sync allowed UUIDs)
After=docker.service
Requires=docker.service

[Service]
Type=simple
ExecStart=${INSTALL_DIR}/connector/sync.sh
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now panel-singbox-connector.service
fi

echo "[agent] 安装 node-agent（面板主动拉取/推送）..."
echo "[agent] node-agent 端口固定使用：${AGENT_PORT}（= 起始端口 + 5）"
AGENT_TOKEN_DEFAULT="$(openssl rand -hex 32)"
AGENT_TOKEN="$(prompt_secret "请输入 node-agent token（留空则自动生成）")"
if [[ -z "${AGENT_TOKEN}" ]]; then AGENT_TOKEN="${AGENT_TOKEN_DEFAULT}"; fi

AGENT_DIR="${INSTALL_DIR}/agent"
mkdir -p "${AGENT_DIR}"
echo -n "${AGENT_TOKEN}" > "${AGENT_DIR}/agent_token"
chmod 600 "${AGENT_DIR}/agent_token" || true
cat > "${AGENT_DIR}/node-agent.py" <<'PY'
#!/usr/bin/env python3
import json
import os
import subprocess
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse

AGENT_TOKEN = (os.environ.get("NODE_AGENT_TOKEN", "") or "").strip()
INSTALL_DIR = os.environ.get("NODE_INSTALL_DIR", "/opt/panel-node-sb")
CONTAINER_NAME = os.environ.get("NODE_CONTAINER", "panel_singbox")
LISTEN = os.environ.get("NODE_AGENT_LISTEN", "0.0.0.0")
PORT = int(os.environ.get("NODE_AGENT_PORT", "1085"))

def read_text(path: str) -> str:
    with open(path, "r", encoding="utf-8") as f:
        return f.read()

def load_json(path: str):
    return json.loads(read_text(path))

def write_json(path: str, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.write("\n")

def sh(cmd: list[str]) -> tuple[int, str]:
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    return p.returncode, p.stdout

def require_token(handler: BaseHTTPRequestHandler) -> bool:
    if not AGENT_TOKEN:
        handler.send_error(500, "NODE_AGENT_TOKEN not set")
        return False
    got = (handler.headers.get("x-agent-token", "") or "").strip()
    if got != AGENT_TOKEN:
        handler.send_error(403, "forbidden")
        return False
    return True

def get_node_info():
    cfg_path = os.path.join(INSTALL_DIR, "singbox", "config.json")
    cfg = load_json(cfg_path)

    public_ip = os.environ.get("NODE_PUBLIC_IP", "")
    if not public_ip:
        code, out = sh(["bash", "-lc", "curl -fsSL https://api.ipify.org || hostname -I | awk '{print $1}'"])
        public_ip = out.strip() if code == 0 else ""

    nodes = []
    protocol_map = {
        "vless": "vless",
        "vmess": "vmess",
        "trojan": "trojan",
        "hysteria2": "hysteria2",
        "socks": "socks",
        "shadowsocks": "shadowsocks",
    }
    for inbound in cfg.get("inbounds", []):
        t = inbound.get("type")
        tag = inbound.get("tag", t)
        port = inbound.get("listen_port")
        if not t or not port:
            continue
        proto = protocol_map.get(t)
        if not proto:
            continue

        config = {"managed": {"provider": "node-agent", "mode": "push-users"}}
        if t == "vless":
            tls = inbound.get("tls", {}) or {}
            reality = tls.get("reality", {}) or {}
            handshake = reality.get("handshake", {}) or {}
            short_ids = reality.get("short_id") or []
            config.update({
                "security": "reality",
                "sni": handshake.get("server", ""),
                "publicKey": os.environ.get("REALITY_PUBLIC_KEY", ""),
                "shortId": short_ids[0] if isinstance(short_ids, list) and short_ids else "",
                "flow": "xtls-rprx-vision",
                "encryption": "none"
            })

        if t in ("vmess", "trojan"):
            config.update({"tls": "tls", "sni": public_ip, "insecure": True})
        if t == "hysteria2":
            config.update({"sni": public_ip, "alpn": ["h3"], "insecure": True})

        nodes.append({
            "name": f"{os.environ.get('NODE_NAME', 'node')} {proto} {tag}",
            "address": public_ip,
            "port": port,
            "protocol": proto,
            "config": config,
            "status": 1,
            "sort_order": 0
        })
    return {"public_ip": public_ip, "nodes": nodes}

def apply_users(payload: dict):
    uuids = payload.get("uuids") or []
    if not isinstance(uuids, list):
        raise ValueError("uuids must be list")

    cfg_path = os.path.join(INSTALL_DIR, "singbox", "config.json")
    cfg = load_json(cfg_path)

    vless_users = [{"name": u, "uuid": u, "flow": "xtls-rprx-vision"} for u in uuids]
    vmess_users = [{"name": u, "uuid": u, "alterId": 0} for u in uuids]
    trojan_users = [{"name": u, "password": u} for u in uuids]
    hy2_users = [{"name": u, "password": u} for u in uuids]
    socks_users = [{"username": u, "password": u} for u in uuids]

    for inbound in cfg.get("inbounds", []):
        tag = inbound.get("tag")
        if tag == "in-vless-reality":
            inbound["users"] = vless_users
        elif tag == "in-vmess-tls":
            inbound["users"] = vmess_users
        elif tag == "in-trojan-tls":
            inbound["users"] = trojan_users
        elif tag == "in-hy2":
            inbound["users"] = hy2_users
        elif tag == "in-socks5":
            inbound["users"] = socks_users

    write_json(cfg_path, cfg)

    code, out = sh(["docker", "restart", CONTAINER_NAME])
    if code != 0:
        raise RuntimeError("docker restart failed: " + out)
    return {"applied": len(uuids), "restarted": CONTAINER_NAME}

class Handler(BaseHTTPRequestHandler):
    def _json(self, code: int, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        p = urlparse(self.path)
        if p.path == "/health":
            return self._json(200, {"ok": True})
        if p.path == "/v1/node-info":
            if not require_token(self):
                return
            return self._json(200, get_node_info())
        self.send_error(404, "not found")

    def do_POST(self):
        p = urlparse(self.path)
        if p.path == "/v1/apply-users":
            if not require_token(self):
                return
            n = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(n).decode("utf-8") if n else "{}"
            payload = json.loads(raw or "{}")
            try:
                return self._json(200, apply_users(payload))
            except Exception as e:
                return self._json(400, {"error": str(e)})
        self.send_error(404, "not found")

def main():
    httpd = HTTPServer((LISTEN, PORT), Handler)
    print(f"[node-agent] listening on http://{LISTEN}:{PORT}")
    httpd.serve_forever()

if __name__ == "__main__":
    main()
PY
chmod +x "${AGENT_DIR}/node-agent.py"

# 输出“一键导入码”（避免复制两次）
PUBLIC_IP_FOR_PANEL="${PUBLIC_IP}"
if [[ -z "${PUBLIC_IP_FOR_PANEL}" ]]; then
  PUBLIC_IP_FOR_PANEL="$(curl -fsSL https://api.ipify.org || hostname -I | awk '{print $1}' || true)"
  PUBLIC_IP_FOR_PANEL="$(echo "${PUBLIC_IP_FOR_PANEL}" | tr -d '\r\n' || true)"
fi

AGENT_URL_FOR_PANEL="http://${PUBLIC_IP_FOR_PANEL}:${AGENT_PORT}"
IMPORT_JSON="$(printf '{"agent_url":"%s","agent_token":"%s"}' "${AGENT_URL_FOR_PANEL}" "${AGENT_TOKEN}")"
IMPORT_CODE="SBAGENT1:$(echo -n "${IMPORT_JSON}" | base64 -w0)"
echo -n "${IMPORT_CODE}" > "${AGENT_DIR}/agent_import_code"
chmod 600 "${AGENT_DIR}/agent_import_code" || true

echo "==============================================================="
echo "[面板一键导入] 复制下面这一行到面板「节点管理 -> 一键绑定节点」的「一键导入码」即可："
echo "${IMPORT_CODE}"
echo "（已保存到：${AGENT_DIR}/agent_import_code）"
echo "==============================================================="

cat > /etc/systemd/system/panel-node-agent.service <<EOF
[Unit]
Description=Panel node-agent (panel pulls/pushes node configs)
After=docker.service
Requires=docker.service

[Service]
Type=simple
Environment=NODE_AGENT_TOKEN=${AGENT_TOKEN}
Environment=NODE_AGENT_PORT=${AGENT_PORT}
Environment=NODE_INSTALL_DIR=${INSTALL_DIR}
Environment=NODE_CONTAINER=${CONTAINER_NAME}
Environment=NODE_NAME=${NODE_NAME}
Environment=REALITY_PUBLIC_KEY=${REALITY_PUBLIC_KEY}
ExecStart=/usr/bin/python3 ${AGENT_DIR}/node-agent.py
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now panel-node-agent.service

open_ports "${PORT_START}" "${PORT_END}"

echo
echo "==================== node-agent 已启动 ===================="
echo "节点 agent URL:  http://${PUBLIC_IP}:${AGENT_PORT}"
echo "节点 agent token: ${AGENT_TOKEN}"
echo "在面板侧调用：POST /api/admin/node-agent/import 绑定该节点（面板主动连节点）"
echo "==========================================================="

echo
echo "[tools] 安装本机按键面板脚本：${INSTALL_DIR}/tools/sb-panel.sh ..."
TOOLS_DIR="${INSTALL_DIR}/tools"
mkdir -p "${TOOLS_DIR}"
cat > "${TOOLS_DIR}/sb-panel.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

CONFIG_DIR="${CONFIG_DIR:-/opt/panel-node-sb/tools}"
mkdir -p "${CONFIG_DIR}"
PANEL_CFG="${CONFIG_DIR}/panel.env"

banner() {
  echo "==========================================================="
  echo " sing-box 节点本机小面板（UUID 查询 / 一键应用）"
  echo "==========================================================="
}

prompt() {
  local label="$1"
  local def="${2:-}"
  local val=""
  if [[ -n "${def}" ]]; then
    read -r -p "${label} (默认: ${def}): " val
    val="${val:-${def}}"
  else
    read -r -p "${label}: " val
  fi
  echo "${val}"
}

load_defaults() {
  if [[ -f "${PANEL_CFG}" ]]; then
    # shellcheck disable=SC1090
    . "${PANEL_CFG}"
  fi

  # 从 systemd unit 中自动推断 agent 监听端口和 token
  if [[ -z "${AGENT_PORT:-}" || -z "${AGENT_TOKEN:-}" ]]; then
    if [[ -f /etc/systemd/system/panel-node-agent.service ]]; then
      local line
      line="$(grep -E '^Environment=NODE_AGENT_PORT=' /etc/systemd/system/panel-node-agent.service || true)"
      if [[ -n "${line}" ]]; then
        AGENT_PORT="${line#Environment=NODE_AGENT_PORT=}"
      fi
      line="$(grep -E '^Environment=NODE_AGENT_TOKEN=' /etc/systemd/system/panel-node-agent.service || true)"
      if [[ -n "${line}" ]]; then
        AGENT_TOKEN="${line#Environment=NODE_AGENT_TOKEN=}"
      fi
    fi
  fi
}

save_defaults() {
  cat > "${PANEL_CFG}" <<EOF
PANEL_BASE_URL=${PANEL_BASE_URL}
INTERNAL_API_KEY=${INTERNAL_API_KEY}
NODE_ID=${NODE_ID}
AGENT_URL=${AGENT_URL}
AGENT_PORT=${AGENT_PORT}
AGENT_TOKEN=${AGENT_TOKEN}
EOF
}

fetch_allowed_uuids() {
  curl -fsS \
    -H "x-internal-token: ${INTERNAL_API_KEY}" \
    "${PANEL_BASE_URL%/}/api/internal/nodes/${NODE_ID}/allowed-uuids"
}

apply_to_agent() {
  local json uuids
  echo "[info] 从面板拉取允许 UUID 列表..."
  json="$(fetch_allowed_uuids)"
  echo "[debug] panel response: ${json}"
  # 直接把 uuids 字段透传给 agent
  uuids="$(echo "${json}" | sed -n 's/.*"uuids":[[]\([^]]*\)[]].*/[\1]/p')"
  if [[ -z "${uuids}" ]]; then
    # 兜底：传递整个 json 给 agent，由 agent 自己处理
    uuids="[]"
  fi
  echo "[info] 推送到本机 node-agent (${AGENT_URL}) ..."
  curl -fsS -X POST \
    -H "Content-Type: application/json" \
    -H "x-agent-token: ${AGENT_TOKEN}" \
    -d "{\"uuids\": ${uuids}}" \
    "${AGENT_URL%/}/v1/apply-users"
  echo
  echo "[ok] 已下发 UUID，sing-box 已重载配置并重启容器。"
}

main() {
  banner
  load_defaults

  PANEL_BASE_URL="${PANEL_BASE_URL:-$(prompt "请输入面板地址（例如：http://你的域名:3000）" "")}"
  INTERNAL_API_KEY="${INTERNAL_API_KEY:-$(prompt "请输入 INTERNAL_API_KEY（与 backend/.env.docker 一致）" "")}"
  NODE_ID="${NODE_ID:-$(prompt "请输入要控制的节点 ID" "")}"

  local default_agent_url="http://127.0.0.1:${AGENT_PORT:-1085}"
  AGENT_URL="${AGENT_URL:-${default_agent_url}}"
  AGENT_URL="$(prompt "请输入本机 node-agent 地址" "${AGENT_URL}")"
  AGENT_PORT="${AGENT_PORT:-$(echo "${AGENT_URL##*:}" | sed 's/[^0-9]//g')}"
  AGENT_TOKEN="${AGENT_TOKEN:-$(prompt "请输入本机 node-agent token（脚本输出或 agent_token 文件里的值）" "")}"

  save_defaults

  while true; do
    echo
    echo "1) 查看当前允许的 UUID 列表（来自面板）"
    echo "2) 一键下发 UUID 到本机 node-agent（联动 sing-box）"
    echo "3) 退出"
    read -r -p "请选择操作 [1-3]: " choice
    case "${choice}" in
      1)
        echo "[info] 正在从面板获取 UUID 列表..."
        fetch_allowed_uuids || echo "[error] 获取失败"
        ;;
      2)
        apply_to_agent || echo "[error] 下发失败"
        ;;
      3)
        echo "退出。"
        exit 0
        ;;
      *)
        echo "无效选择。"
        ;;
    esac
  done
}

main "$@"
SH

chmod +x "${TOOLS_DIR}/sb-panel.sh"

echo
echo "[tools] 你可以在节点机本地运行：bash ${TOOLS_DIR}/sb-panel.sh"
echo "[tools] 用于：查看面板允许的 UUID，并一键下发到本机 node-agent（实时联动 sing-box）"

echo
echo "==================== 完成（sing-box 多协议）===================="
echo "公网 IP: ${PUBLIC_IP}"
echo "VLESS Reality: ${PORT_VLESS}  (sni=${SNI})"
echo "VMess TLS:     ${PORT_VMESS}  (自签证书，客户端需 insecure)"
echo "Trojan TLS:    ${PORT_TROJAN} (自签证书，客户端需 insecure)"
echo "Hysteria2 TLS: ${PORT_HY2}    (自签证书，客户端需 insecure)"
echo "SOCKS5:        ${PORT_SOCKS} (用户名/密码均为用户 UUID)"
echo
echo "面板节点 ID："
echo "  vless=${NODE_ID_VLESS}"
echo "  vmess=${NODE_ID_VMESS}"
echo "  trojan=${NODE_ID_TROJAN}"
echo "  hy2=${NODE_ID_HY2}"
echo "  socks=${NODE_ID_SOCKS}"
echo
echo "提示：订阅下发已改为“用户专属 UUID/密码”，到期/封禁/超流量会通过同步服务立即生效。"
echo "==============================================================="

