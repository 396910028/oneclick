#!/usr/bin/env bash
set -euo pipefail

# Ubuntu 一键开局（最小可用版）：
# - Docker 运行 Xray（VLESS + Reality）
# - 自动向面板注册节点（/api/internal/register-node）
# - 定时拉取 allowed-uuids 并重启 Xray 生效（真正“强行断网”）
#
# 依赖：
# - 面板后端已设置 INTERNAL_API_KEY（backend/.env.docker）
# - 面板后端已暴露 /api/internal/*（本项目已实现）
#
# 使用：
#   sudo bash ubuntu-xray-vless-reality-oneclick.sh \
#     --panel "http://你的面板IP或域名:3000" \
#     --token "INTERNAL_API_KEY的值" \
#     --name  "HK-01" \
#     --port  443
#
# 运行完成后会输出：
# - 节点 ID（node_id）
# - 可直接用于订阅导入的 vless:// reality 示例（UUID 会由面板订阅下发为“用户专属 UUID”）

PANEL_BASE_URL=""
INTERNAL_TOKEN=""
NODE_NAME="xray-node"
VLESS_PORT="443"
SNI="www.cloudflare.com"
DEST="${SNI}:443"
SYNC_INTERVAL="10"
INSTALL_DIR="/opt/panel-node"

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
    --panel) PANEL_BASE_URL="$2"; shift 2 ;;
    --token) INTERNAL_TOKEN="$2"; shift 2 ;;
    --name) NODE_NAME="$2"; shift 2 ;;
    --port) VLESS_PORT="$2"; shift 2 ;;
    --sni) SNI="$2"; DEST="${SNI}:443"; shift 2 ;;
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
echo "Xray VLESS+Reality 一键开局（交互模式）"
echo "提示：你也可以用参数模式运行（--panel/--token/--name/--port/--sni 等）"
echo "==============================================================="

if [[ -z "${PANEL_BASE_URL}" ]]; then
  PANEL_BASE_URL="$(prompt "请输入面板后端地址（示例：http://1.2.3.4:3000 或 http://domain:3000）")"
fi
if [[ -z "${INTERNAL_TOKEN}" ]]; then
  INTERNAL_TOKEN="$(prompt_secret "请输入 INTERNAL_API_KEY（对应面板 backend/.env.docker 的 INTERNAL_API_KEY）")"
fi
NODE_NAME="$(prompt "请输入节点名称" "${NODE_NAME}")"
SNI="$(prompt "请输入 Reality SNI（建议 cloudflare/google 站点域名）" "${SNI}")"
VLESS_PORT="$(prompt "请输入 VLESS Reality 端口" "${VLESS_PORT}")"
SYNC_INTERVAL="$(prompt "请输入同步间隔秒（越小断网越快，但重启更频繁）" "${SYNC_INTERVAL}")"
INSTALL_DIR="$(prompt "请输入安装目录（新机器建议默认即可）" "${INSTALL_DIR}")"
DEST="${SNI}:443"

if [[ -z "${PANEL_BASE_URL}" || -z "${INTERNAL_TOKEN}" ]]; then
  echo "面板地址或 INTERNAL_API_KEY 为空，退出。" >&2
  exit 2
fi

apt-get update -y
apt-get install -y ca-certificates curl jq

COMPOSE_CMD=""
ensure_docker_official_repo() {
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
  ensure_docker_official_repo
  if apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin; then
    systemctl enable --now docker || true
    return 0
  fi

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

mkdir -p "${INSTALL_DIR}"/{xray,connector}

PUBLIC_IP="$(curl -fsSL https://api.ipify.org || true)"
if [[ -z "${PUBLIC_IP}" ]]; then
  PUBLIC_IP="$(hostname -I | awk '{print $1}')"
fi

XRAY_IMAGE="ghcr.io/xtls/xray-core:latest"

echo "[1/6] 拉取 Xray 镜像..."
docker pull "${XRAY_IMAGE}" >/dev/null

echo "[2/6] 生成 Reality 密钥对..."
# 说明：部分 xray 版本的 x25519 输出不包含 PublicKey，因此统一用 sing-box 生成 keypair
SB_IMAGE="ghcr.io/sagernet/sing-box:latest"
docker pull "${SB_IMAGE}" >/dev/null 2>&1 || true
KEY_OUT_SB="$(docker run --rm --entrypoint sing-box "${SB_IMAGE}" generate reality-keypair 2>/dev/null || true)"
PRIVATE_KEY="$(echo "${KEY_OUT_SB}" | awk -F'[: ]+' '/^PrivateKey:/ {print $2} /^Private key:/ {print $3}' | head -n1)"
PUBLIC_KEY="$(echo "${KEY_OUT_SB}" | awk -F'[: ]+' '/^PublicKey:/ {print $2} /^Public key:/ {print $3}' | head -n1)"
if [[ -z "${PRIVATE_KEY}" || -z "${PUBLIC_KEY}" ]]; then
  echo "生成 Reality 密钥失败（无法解析 sing-box 输出）：" >&2
  echo "${KEY_OUT_SB:-<empty>}" >&2
  exit 1
fi

SHORT_ID="$(head -c 8 /dev/urandom | xxd -p)"
FLOW="xtls-rprx-vision"

echo "[3/6] 写入 Xray 配置（VLESS+Reality）..."
cat > "${INSTALL_DIR}/xray/config.json" <<EOF
{
  "log": {
    "loglevel": "warning"
  },
  "inbounds": [
    {
      "tag": "vless-reality-in",
      "listen": "0.0.0.0",
      "port": ${VLESS_PORT},
      "protocol": "vless",
      "settings": {
        "clients": [],
        "decryption": "none"
      },
      "streamSettings": {
        "network": "tcp",
        "security": "reality",
        "realitySettings": {
          "show": false,
          "dest": "${DEST}",
          "xver": 0,
          "serverNames": ["${SNI}"],
          "privateKey": "${PRIVATE_KEY}",
          "shortIds": ["${SHORT_ID}"]
        }
      }
    }
  ],
  "outbounds": [
    { "protocol": "freedom", "tag": "direct" }
  ]
}
EOF

echo "[4/6] 写入 docker-compose.yml..."
cat > "${INSTALL_DIR}/docker-compose.yml" <<EOF
services:
  xray:
    image: ${XRAY_IMAGE}
    container_name: panel_xray
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./xray/config.json:/etc/xray/config.json:ro
EOF

echo "[5/6] 向面板注册节点..."
NODE_CONFIG_JSON="$(jq -nc \
  --arg security "reality" \
  --arg sni "${SNI}" \
  --arg flow "${FLOW}" \
  --arg publicKey "${PUBLIC_KEY}" \
  --arg shortId "${SHORT_ID}" \
  '{security:$security,sni:$sni,flow:$flow,publicKey:$publicKey,shortId:$shortId,encryption:"none"}' \
)"

REGISTER_PAYLOAD="$(jq -nc \
  --arg name "${NODE_NAME}" \
  --arg address "${PUBLIC_IP}" \
  --argjson port "${VLESS_PORT}" \
  --arg protocol "vless" \
  --argjson cfg "${NODE_CONFIG_JSON}" \
  '{name:$name,address:$address,port:$port,protocol:$protocol,config:$cfg,status:1,sort_order:0}' \
)"

REGISTER_RESP="$(curl -fsSL \
  -H "Content-Type: application/json" \
  -H "x-internal-token: ${INTERNAL_TOKEN}" \
  -d "${REGISTER_PAYLOAD}" \
  "${PANEL_BASE_URL%/}/api/internal/register-node" \
)"
NODE_ID="$(echo "${REGISTER_RESP}" | jq -r '.data.id // empty')"
if [[ -z "${NODE_ID}" ]]; then
  echo "注册节点失败：${REGISTER_RESP}" >&2
  exit 1
fi

echo "${NODE_ID}" > "${INSTALL_DIR}/node_id"
echo "${PANEL_BASE_URL%/}" > "${INSTALL_DIR}/panel_url"
echo "${INTERNAL_TOKEN}" > "${INSTALL_DIR}/internal_token"
echo "${SYNC_INTERVAL}" > "${INSTALL_DIR}/sync_interval_seconds"

echo "[6/6] 启动 Xray..."
cd "${INSTALL_DIR}"
${COMPOSE_CMD} up -d

echo "[sync] 创建同步脚本（拉 UUID 列表 -> 生成 clients -> 重启 xray）..."
cat > "${INSTALL_DIR}/connector/sync.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="/opt/panel-node"
NODE_ID="$(cat "${INSTALL_DIR}/node_id")"
PANEL_URL="$(cat "${INSTALL_DIR}/panel_url")"
TOKEN="$(cat "${INSTALL_DIR}/internal_token")"

CONFIG_PATH="${INSTALL_DIR}/xray/config.json"
TMP_CONFIG="${INSTALL_DIR}/xray/config.json.tmp"
LAST_HASH="${INSTALL_DIR}/connector/last_hash"

while true; do
  RESP="$(curl -fsSL -H "x-internal-token: ${TOKEN}" "${PANEL_URL%/}/api/internal/nodes/${NODE_ID}/allowed-uuids")" || {
    echo "[WARN] fetch allowed-uuids failed"
    sleep 5
    continue
  }

  UUIDS_JSON="$(echo "${RESP}" | jq -c '.data.uuids // []')"
  HASH="$(echo "${UUIDS_JSON}" | sha256sum | awk '{print $1}')"
  OLD="$(cat "${LAST_HASH}" 2>/dev/null || true)"

  if [[ "${HASH}" != "${OLD}" ]]; then
    echo "${HASH}" > "${LAST_HASH}"

    CLIENTS="$(echo "${UUIDS_JSON}" | jq -c '[ .[] | {id: ., flow:"xtls-rprx-vision"} ]')"
    jq --argjson clients "${CLIENTS}" '
      .inbounds[0].settings.clients = $clients
    ' "${CONFIG_PATH}" > "${TMP_CONFIG}"
    mv "${TMP_CONFIG}" "${CONFIG_PATH}"

    echo "[INFO] clients changed -> restart xray (count=$(echo "${UUIDS_JSON}" | jq 'length'))"
    docker restart panel_xray >/dev/null || true
  fi

  INTERVAL="$(cat "${INSTALL_DIR}/sync_interval_seconds" 2>/dev/null || echo 10)"
  if ! [[ "${INTERVAL}" =~ ^[0-9]+$ ]]; then INTERVAL="10"; fi
  sleep "${INTERVAL}"
done
EOF
chmod +x "${INSTALL_DIR}/connector/sync.sh"

cat > /etc/systemd/system/panel-connector.service <<EOF
[Unit]
Description=Panel connector (sync allowed UUIDs to Xray)
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
systemctl enable --now panel-connector.service

echo
echo "==================== 完成 ===================="
echo "节点公网 IP: ${PUBLIC_IP}"
echo "节点端口:   ${VLESS_PORT}"
echo "Reality 公钥: ${PUBLIC_KEY}"
echo "Reality shortId: ${SHORT_ID}"
echo "面板 node_id: ${NODE_ID}"
echo
echo "提示：订阅下发会使用“用户专属 UUID”，所以这里不输出带 uuid 的最终 vless://（uuid 由面板生成）。"
echo "你现在可以在面板里看到新节点（节点管理），并在订阅里导入测试。"
echo "=============================================="

