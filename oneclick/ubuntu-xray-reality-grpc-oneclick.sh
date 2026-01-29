#!/usr/bin/env bash
set -euo pipefail

# Ubuntu 一键开局（Xray 二进制 + systemd，支持 gRPC 热更新 users）
# - 安装/重装 Xray（VLESS + Reality）
# - 开启 Xray gRPC API（127.0.0.1:10085，HandlerService）
# - 向面板注册节点（/api/internal/register-node）
# - 安装并启动 node-daemon（复用仓库 connector，APPLY_MODE=xray-grpc）
#
# 目标：实现“机场级”实时增删用户（无需重启 Xray）

PANEL_BASE_URL=""
INTERNAL_TOKEN=""
NODE_NAME="xray-node"
VLESS_PORT="443"
SNI="www.cloudflare.com"
DEST="" # default "${SNI}:443"
INSTALL_DIR="/opt/panel-node-xray"
REPO_URL="https://github.com/396910028/oneclick.git"
XRAY_API_PORT="10085"
SYNC_INTERVAL="10"
VLESS_FLOW="xtls-rprx-vision"

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

sanitize_url() {
  # 去掉不可见字符/Windows 换行/奇怪编码（例如粘贴导致的 http�://）
  # 仅保留可打印 ASCII（含空格会被后续 trim 掉）
  local s="$1"
  s="$(printf "%s" "${s}" | tr -d '\r\n' | tr -cd '\11\12\15\40-\176')"
  # trim
  s="$(printf "%s" "${s}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  echo "${s}"
}

sanitize_token() {
  # 去掉换行、\r、不可见字符，避免 header 被截断/变形
  local s="$1"
  s="$(printf "%s" "${s}" | tr -d '\r\n' | tr -cd '\11\12\15\40-\176')"
  s="$(printf "%s" "${s}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  echo "${s}"
}

require_http_url() {
  local s="$1"
  if [[ "${s}" != http://* && "${s}" != https://* ]]; then
    echo "[error] 面板地址格式不正确：${s}" >&2
    echo "请填写形如：http://你的域名:3000 或 https://你的域名 的地址" >&2
    exit 2
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --panel) PANEL_BASE_URL="$2"; shift 2 ;;
    --token) INTERNAL_TOKEN="$2"; shift 2 ;;
    --name) NODE_NAME="$2"; shift 2 ;;
    --port) VLESS_PORT="$2"; shift 2 ;;
    --sni) SNI="$2"; shift 2 ;;
    --dest) DEST="$2"; shift 2 ;;
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --repo) REPO_URL="$2"; shift 2 ;;
    --api-port) XRAY_API_PORT="$2"; shift 2 ;;
    --interval) SYNC_INTERVAL="$2"; shift 2 ;;
    --flow) VLESS_FLOW="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ $EUID -ne 0 ]]; then
  echo "请用 root 执行（sudo）" >&2
  exit 1
fi

echo "==============================================================="
echo "Xray VLESS+Reality（gRPC 热更新 users）一键开局"
echo "==============================================================="

if [[ -z "${PANEL_BASE_URL}" ]]; then
  PANEL_BASE_URL="$(prompt "请输入面板后端地址（示例：http://你的域名:3000）")"
fi
if [[ -z "${INTERNAL_TOKEN}" ]]; then
  INTERNAL_TOKEN="$(prompt_secret "请输入 INTERNAL_API_KEY（对应面板 backend/.env.docker）")"
fi

# 清洗/校验输入（避免粘贴异常字符导致 curl URL 非法）
PANEL_BASE_URL="$(sanitize_url "${PANEL_BASE_URL}")"
require_http_url "${PANEL_BASE_URL}"
INTERNAL_TOKEN="$(sanitize_token "${INTERNAL_TOKEN}")"
if [[ -z "${INTERNAL_TOKEN}" ]]; then
  echo "[error] INTERNAL_API_KEY 为空或包含非法字符（清洗后为空），请重新输入。" >&2
  exit 2
fi

NODE_NAME="$(prompt "请输入节点名称" "${NODE_NAME}")"
SNI="$(prompt "请输入 Reality SNI（建议 cloudflare/google 站点域名）" "${SNI}")"
VLESS_PORT="$(prompt "请输入 VLESS Reality 端口" "${VLESS_PORT}")"
XRAY_API_PORT="$(prompt "请输入 Xray gRPC API 端口（仅本机使用）" "${XRAY_API_PORT}")"
SYNC_INTERVAL="$(prompt "请输入同步间隔秒（越小越实时）" "${SYNC_INTERVAL}")"
INSTALL_DIR="$(prompt "请输入安装目录（新机器建议默认即可）" "${INSTALL_DIR}")"
VLESS_FLOW="$(prompt "请输入 VLESS flow（Vision 通常用 xtls-rprx-vision）" "${VLESS_FLOW}")"

if [[ -z "${DEST}" ]]; then
  DEST="${SNI}:443"
fi

mkdir -p "${INSTALL_DIR}"

wait_for_dpkg() {
  local i=0
  while fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; do
    i=$((i+1))
    if [[ $i -gt 60 ]]; then
      echo "[apt] dpkg 锁等待超时，可能正在 unattended-upgrades。你可以稍后重试，或手动 stop unattended-upgrades 后再跑。" >&2
      exit 1
    fi
    echo "[apt] dpkg 锁被占用，等待中...(${i}s)"
    sleep 1
  done
}

wait_for_dpkg
apt-get update -y
apt-get install -y ca-certificates curl jq git unzip

install_go() {
  # 这里直接安装最新可用的 Go toolchain（避免 go 命令运行时再自动下载/切换）
  # 当前依赖链（xray-core）要求 go >= 1.25.6
  local want_ver="1.25.6"
  local arch url tmp
  if command -v go >/dev/null 2>&1; then
    local cur
    cur="$(go version 2>/dev/null | awk '{print $3}' | sed 's/^go//')"
    if [[ "${cur}" == "${want_ver}" ]]; then
      echo "[go] 已安装 go${cur}，满足要求。"
      return 0
    fi
    echo "[go] 当前 go${cur:-<unknown>} != go${want_ver}，升级到 go${want_ver}..."
  else
    echo "[go] 未检测到 Go，安装 go${want_ver}..."
  fi

  arch="$(uname -m)"
  case "${arch}" in
    x86_64|amd64) arch="linux-amd64" ;;
    aarch64|arm64) arch="linux-arm64" ;;
    *) echo "[go] 不支持的架构：${arch}" >&2; return 1 ;;
  esac

  url="https://go.dev/dl/go${want_ver}.${arch}.tar.gz"
  tmp="$(mktemp -d)"
  echo "[go] 下载：${url}"
  curl -fsSL -o "${tmp}/go.tgz" "${url}"
  rm -rf /usr/local/go
  tar -C /usr/local -xzf "${tmp}/go.tgz"
  ln -sf /usr/local/go/bin/go /usr/local/bin/go
  ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt
  export PATH="/usr/local/go/bin:${PATH}"
  echo "[go] 安装完成：$(go version)"
}

install_go

# 强制仅使用本机安装的 Go，不让 go 命令运行时自动切换/下载 toolchain
export GOTOOLCHAIN=local

cleanup_service() {
  local svc="$1"
  if systemctl list-unit-files --type=service 2>/dev/null | awk '{print $1}' | grep -qx "${svc}"; then
    echo "[systemd] stop/disable：${svc}"
    systemctl stop "${svc}" >/dev/null 2>&1 || true
    systemctl disable "${svc}" >/dev/null 2>&1 || true
    systemctl reset-failed "${svc}" >/dev/null 2>&1 || true
  fi
  if [[ -f "/etc/systemd/system/${svc}" ]]; then
    rm -f "/etc/systemd/system/${svc}"
  fi
}

echo "[systemd] 清理旧服务（重跑覆盖配置）..."
cleanup_service "panel-xray.service"
cleanup_service "panel-xray-daemon.service"
cleanup_service "xray.service"
systemctl daemon-reload >/dev/null 2>&1 || true

echo "[xray] 安装/更新 Xray..."
INSTALL_SCRIPT="/tmp/xray-install-release.sh"
curl -fsSL -o "${INSTALL_SCRIPT}" "https://github.com/XTLS/Xray-install/raw/main/install-release.sh"
bash "${INSTALL_SCRIPT}" install >/dev/null 2>&1 || true

XRAY_BIN="$(command -v xray || true)"
if [[ -z "${XRAY_BIN}" ]]; then
  # 有些安装脚本放到 /usr/local/bin
  if [[ -x /usr/local/bin/xray ]]; then
    XRAY_BIN="/usr/local/bin/xray"
  elif [[ -x /usr/bin/xray ]]; then
    XRAY_BIN="/usr/bin/xray"
  fi
fi
if [[ -z "${XRAY_BIN}" ]]; then
  echo "[xray] 未找到 xray 可执行文件，安装失败。" >&2
  exit 1
fi

PUBLIC_IP="$(curl -fsSL https://api.ipify.org || true)"
if [[ -z "${PUBLIC_IP}" ]]; then
  PUBLIC_IP="$(hostname -I | awk '{print $1}')"
fi

echo "[xray] 生成 Reality keypair + shortId..."
KEY_OUT="$("${XRAY_BIN}" x25519 2>/dev/null || true)"
PRIVATE_KEY="$(echo "${KEY_OUT}" | awk -F'[: ]+' '/PrivateKey:/ {print $2} /Private key:/ {print $3}' | head -n1)"
PUBLIC_KEY="$(echo "${KEY_OUT}" | awk -F'[: ]+' '/PublicKey:/ {print $2} /Public key:/ {print $3}' | head -n1)"
if [[ -z "${PRIVATE_KEY}" || -z "${PUBLIC_KEY}" ]]; then
  echo "[xray] x25519 未输出完整 keypair（部分版本只输出 PrivateKey），改用 sing-box 生成 Reality keypair..."

  download_singbox() {
    local arch asset_url tmpdir
    arch="$(uname -m)"
    case "${arch}" in
      x86_64|amd64) arch="linux-amd64" ;;
      aarch64|arm64) arch="linux-arm64" ;;
      *) echo "[sing-box] 不支持的架构：${arch}" >&2; return 1 ;;
    esac

    # 优先不用 GitHub API（容易限流），通过 latest 重定向拿版本号
    echo "[sing-box] 获取最新版版本号（via releases/latest 重定向）..."
    local latest_url tag ver
    latest_url="$(curl -fsSL -o /dev/null -w '%{url_effective}' https://github.com/SagerNet/sing-box/releases/latest)"
    tag="$(echo "${latest_url}" | awk -F'/tag/' '{print $2}' | tail -n1)"
    ver="${tag#v}"
    if [[ -z "${tag}" || -z "${ver}" || "${ver}" == "${tag}" ]]; then
      echo "[sing-box] 无法解析最新版本号：${latest_url}" >&2
      return 1
    fi

    asset_url="https://github.com/SagerNet/sing-box/releases/download/${tag}/sing-box-${ver}-${arch}.tar.gz"
    echo "[sing-box] 使用资源：${asset_url}"

    tmpdir="$(mktemp -d)"
    echo "[sing-box] 下载：${asset_url}"
    curl -fsSL -o "${tmpdir}/sb.tgz" "${asset_url}"
    tar -xzf "${tmpdir}/sb.tgz" -C "${tmpdir}"
    # tar 内通常有 sing-box 可执行文件
    if [[ -x "${tmpdir}/sing-box" ]]; then
      echo "${tmpdir}/sing-box"
      return 0
    fi
    local sb_bin
    sb_bin="$(find "${tmpdir}" -maxdepth 2 -type f -name sing-box | head -n1 || true)"
    if [[ -n "${sb_bin}" && -x "${sb_bin}" ]]; then
      echo "${sb_bin}"
      return 0
    fi
    echo "[sing-box] 解压后未找到 sing-box 可执行文件" >&2
    return 1
  }

  SB_BIN="$(download_singbox)"
  if [[ -z "${SB_BIN}" ]]; then
    echo "[sing-box] 下载失败，无法生成 Reality keypair。" >&2
    echo "[xray] x25519 输出如下（供排错）：" >&2
    echo "${KEY_OUT:-<empty>}" >&2
    exit 1
  fi

  KEY_OUT_SB="$("${SB_BIN}" generate reality-keypair 2>&1 || true)"
  PRIVATE_KEY="$(echo "${KEY_OUT_SB}" | awk -F'[: ]+' '/^PrivateKey:/ {print $2} /^Private key:/ {print $3}' | head -n1)"
  PUBLIC_KEY="$(echo "${KEY_OUT_SB}" | awk -F'[: ]+' '/^PublicKey:/ {print $2} /^Public key:/ {print $3}' | head -n1)"
  if [[ -z "${PRIVATE_KEY}" || -z "${PUBLIC_KEY}" ]]; then
    echo "[sing-box] tar 版本生成失败，尝试安装 deb 版本再生成..." >&2

    # 通过 releases/latest 重定向拿版本
    latest_url="$(curl -fsSL -o /dev/null -w '%{url_effective}' https://github.com/SagerNet/sing-box/releases/latest)"
    tag="$(echo "${latest_url}" | awk -F'/tag/' '{print $2}' | tail -n1)"
    ver="${tag#v}"
    if [[ -z "${tag}" || -z "${ver}" || "${ver}" == "${tag}" ]]; then
      echo "[sing-box] 无法解析最新版本号（deb 兜底失败），输出如下：" >&2
      echo "${KEY_OUT_SB:-<empty>}" >&2
      exit 1
    fi

    arch2="$(uname -m)"
    case "${arch2}" in
      x86_64|amd64) deb_arch="amd64" ;;
      aarch64|arm64) deb_arch="arm64" ;;
      *) deb_arch="" ;;
    esac
    if [[ -z "${deb_arch}" ]]; then
      echo "[sing-box] deb 兜底不支持架构：${arch2}" >&2
      echo "${KEY_OUT_SB:-<empty>}" >&2
      exit 1
    fi

    deb_url="https://github.com/SagerNet/sing-box/releases/download/${tag}/sing-box_${ver}_linux_${deb_arch}.deb"
    tmpdeb="$(mktemp -d)"
    echo "[sing-box] 下载 deb：${deb_url}" >&2
    if curl -fsSL -o "${tmpdeb}/sb.deb" "${deb_url}"; then
      dpkg -i "${tmpdeb}/sb.deb" >/dev/null 2>&1 || apt-get -f install -y >/dev/null 2>&1 || true
    fi

    if command -v sing-box >/dev/null 2>&1; then
      KEY_OUT_SB2="$(sing-box generate reality-keypair 2>&1 || true)"
      PRIVATE_KEY="$(echo "${KEY_OUT_SB2}" | awk -F'[: ]+' '/^PrivateKey:/ {print $2} /^Private key:/ {print $3}' | head -n1)"
      PUBLIC_KEY="$(echo "${KEY_OUT_SB2}" | awk -F'[: ]+' '/^PublicKey:/ {print $2} /^Public key:/ {print $3}' | head -n1)"
      if [[ -n "${PRIVATE_KEY}" && -n "${PUBLIC_KEY}" ]]; then
        KEY_OUT_SB="${KEY_OUT_SB2}"
      fi
    fi

    if [[ -z "${PRIVATE_KEY}" || -z "${PUBLIC_KEY}" ]]; then
      echo "[sing-box] Reality key 生成失败，输出如下（tar 版）：" >&2
      echo "${KEY_OUT_SB:-<empty>}" >&2
      if [[ -n "${KEY_OUT_SB2:-}" ]]; then
        echo "[sing-box] Reality key 生成失败，输出如下（deb 版）：" >&2
        echo "${KEY_OUT_SB2:-<empty>}" >&2
      fi
      exit 1
    fi
  fi
fi
SHORT_ID="$(head -c 8 /dev/urandom | xxd -p)"

echo "[xray] 写入配置：/etc/xray/config.json"
mkdir -p /etc/xray
cat > /etc/xray/config.json <<EOF
{
  "log": { "loglevel": "warning" },
  "api": {
    "tag": "api",
    "services": ["HandlerService", "StatsService"]
  },
  "stats": {},
  "policy": {
    "levels": {
      "0": {
        "statsUserUplink": true,
        "statsUserDownlink": true
      }
    }
  },
  "inbounds": [
    {
      "tag": "api-in",
      "listen": "127.0.0.1",
      "port": ${XRAY_API_PORT},
      "protocol": "dokodemo-door",
      "settings": {
        "address": "127.0.0.1"
      }
    },
    {
      "tag": "in-vless-reality",
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
  "routing": {
    "rules": [
      {
        "type": "field",
        "inboundTag": ["api-in"],
        "outboundTag": "api"
      }
    ]
  },
  "outbounds": [
    { "protocol": "freedom", "tag": "direct" }
  ]
}
EOF

echo "[systemd] 写入 panel-xray.service..."
cat > /etc/systemd/system/panel-xray.service <<EOF
[Unit]
Description=Panel Xray (VLESS Reality + gRPC API)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# 【重要】Xray 重启时清除 applied.json，确保 connector 重新添加所有用户
# 因为 Xray 重启后内存中的用户列表会被清空，但 applied.json 还保留旧状态
ExecStartPre=/bin/bash -c 'rm -f ${INSTALL_DIR}/out/node-*/applied.json 2>/dev/null || true'
ExecStart=${XRAY_BIN} run -config /etc/xray/config.json
Restart=always
RestartSec=3
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now panel-xray.service

echo "[panel] 向面板注册节点..."
NODE_CONFIG_JSON="$(jq -nc \
  --arg security "reality" \
  --arg sni "${SNI}" \
  --arg flow "${VLESS_FLOW}" \
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

echo "[panel] 调用 /api/internal/register-node ..."
REGISTER_URL="${PANEL_BASE_URL%/}/api/internal/register-node"
tmp_hdr="$(mktemp)"
tmp_body="$(mktemp)"
REGISTER_CODE="$(
  curl -sS \
    -D "${tmp_hdr}" \
    -o "${tmp_body}" \
    -H "Content-Type: application/json" \
    -H "x-internal-token: ${INTERNAL_TOKEN}" \
    -d "${REGISTER_PAYLOAD}" \
    -w "%{http_code}" \
    "${REGISTER_URL}" \
    || echo "000"
)"
REGISTER_HEADERS="$(cat "${tmp_hdr}" 2>/dev/null || true)"
REGISTER_BODY="$(cat "${tmp_body}" 2>/dev/null || true)"
rm -f "${tmp_hdr}" "${tmp_body}" >/dev/null 2>&1 || true

if [[ "${REGISTER_CODE}" != "200" ]]; then
  echo "[panel] 注册节点失败：HTTP ${REGISTER_CODE:-<unknown>} url=${REGISTER_URL}" >&2
  echo "[panel] 响应 body：" >&2
  echo "${REGISTER_BODY:-<empty>}" >&2
  if [[ -z "${REGISTER_BODY}" || "${REGISTER_BODY}" == "<empty>" ]]; then
    echo "[panel] 响应 headers（body 为空时用于排错）：" >&2
    echo "${REGISTER_HEADERS:-<empty>}" >&2
    echo "[panel] 提示：这通常是 INTERNAL_API_KEY 不匹配、或中间反代/WAF 拦截了 POST /api/internal/*。" >&2
  fi
  exit 1
fi

NODE_ID="$(echo "${REGISTER_BODY}" | jq -r '.data.id // empty' 2>/dev/null || true)"
if [[ -z "${NODE_ID}" ]]; then
  echo "[panel] 注册节点返回异常（无法解析 node_id），响应：" >&2
  echo "[panel] headers:" >&2
  echo "${REGISTER_HEADERS:-<empty>}" >&2
  echo "[panel] body:" >&2
  echo "${REGISTER_BODY:-<empty>}" >&2
  exit 1
fi
echo "[panel] 节点注册成功：node_id=${NODE_ID}"

echo "[panel] 写入节点注册信息（用于按键面板一键重新注册）..."
cat > "${INSTALL_DIR}/node.json" <<EOF
{
  "name": "${NODE_NAME}",
  "address": "${PUBLIC_IP}",
  "port": ${VLESS_PORT},
  "protocol": "vless",
  "config": ${NODE_CONFIG_JSON},
  "status": 1,
  "sort_order": 0,
  "node_id": ${NODE_ID}
}
EOF

echo "[daemon] 准备 node-daemon（connector xray-grpc 模式）..."

# 【重要】清除旧的 applied.json，防止重装后 connector 不重新添加用户
# 这是因为 Xray 重装后用户列表被清空，但旧的 applied.json 还存在
echo "[cleanup] 清除旧的 applied state..."
rm -f "${INSTALL_DIR}/out/node-*/applied.json" 2>/dev/null || true

SRC_DIR="${INSTALL_DIR}/src"
mkdir -p "${SRC_DIR}"
if [[ -d "${SRC_DIR}/.git" ]]; then
  # 强制更新：先重置本地修改，再拉取最新代码
  echo "[git] 强制更新仓库（丢弃本地修改）..."
  git -C "${SRC_DIR}" fetch origin >/dev/null 2>&1 || true
  git -C "${SRC_DIR}" reset --hard origin/master >/dev/null 2>&1 || \
  git -C "${SRC_DIR}" reset --hard origin/main >/dev/null 2>&1 || \
  git -C "${SRC_DIR}" reset --hard HEAD >/dev/null 2>&1 || true
  git -C "${SRC_DIR}" pull --rebase >/dev/null 2>&1 || true
else
  rm -rf "${SRC_DIR}"
  git clone "${REPO_URL}" "${SRC_DIR}"
fi

CONNECTOR_DIR="${SRC_DIR}/connector"
if [[ ! -d "${CONNECTOR_DIR}" ]]; then
  echo "[daemon] 未找到 connector 目录：${CONNECTOR_DIR}" >&2
  exit 1
fi

mkdir -p "${INSTALL_DIR}/bin" "${INSTALL_DIR}/out"
(
  cd "${CONNECTOR_DIR}"
  echo "[daemon] go mod tidy（生成 go.sum / 拉取依赖）..."
  go mod tidy
  go build -o "${INSTALL_DIR}/bin/connector" .
)

cat > "${INSTALL_DIR}/daemon.env" <<EOF
PANEL_BASE_URL=${PANEL_BASE_URL}
INTERNAL_API_KEY=${INTERNAL_TOKEN}
NODE_IDS=${NODE_ID}
OUTPUT_DIR=${INSTALL_DIR}/out
INTERVAL_SECONDS=${SYNC_INTERVAL}
APPLY_MODE=xray-grpc
XRAY_API_ADDR=127.0.0.1:${XRAY_API_PORT}
XRAY_TAG_MAP=${NODE_ID}:in-vless-reality
XRAY_VLESS_FLOW=${VLESS_FLOW}
XRAY_RPC_TIMEOUT_SECONDS=5
# 流量统计（通过 Xray Stats API 每分钟上报一次）
ENABLE_TRAFFIC_REPORT=true
TRAFFIC_REPORT_INTERVAL_SECONDS=60
EOF

cat > /etc/systemd/system/panel-xray-daemon.service <<EOF
[Unit]
Description=Panel node-daemon (sync allowed UUIDs to Xray via gRPC)
After=network-online.target panel-xray.service
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${INSTALL_DIR}/daemon.env
ExecStart=${INSTALL_DIR}/bin/connector
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now panel-xray-daemon.service

echo "[tools] 安装本机按键面板脚本：${INSTALL_DIR}/tools/xray-panel.sh ..."
mkdir -p "${INSTALL_DIR}/tools"
# 强制从仓库复制最新的 xray-panel.sh（如果存在），否则使用内嵌版本
if [[ -f "${SRC_DIR}/oneclick/tools/xray-panel.sh" ]]; then
  cp -f "${SRC_DIR}/oneclick/tools/xray-panel.sh" "${INSTALL_DIR}/tools/xray-panel.sh"
  echo "[tools] 已从仓库强制覆盖最新版 xray-panel.sh"
else
  # 内嵌版本（作为后备）
  echo "[tools] 仓库中未找到 xray-panel.sh，使用内嵌版本"
  cat > "${INSTALL_DIR}/tools/xray-panel.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

# 节点机本地按键面板（配合 Xray gRPC 热更新方案）
# - 查看面板允许的 UUID（internal API）
# - 查看本机已应用 UUID（connector 输出的 applied.json）
# - 手动触发一次同步（connector -once）
#
# 默认读取 /opt/panel-node-xray/daemon.env

INSTALL_DIR="${INSTALL_DIR:-/opt/panel-node-xray}"
ENV_FILE="${ENV_FILE:-${INSTALL_DIR}/daemon.env}"

if [[ -f "${ENV_FILE}" ]]; then
  # shellcheck disable=SC1090
  . "${ENV_FILE}"
fi

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

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "缺少依赖：$1" >&2; exit 1; }
}

need_cmd curl
need_cmd jq

PANEL_BASE_URL="${PANEL_BASE_URL:-}"
INTERNAL_API_KEY="${INTERNAL_API_KEY:-}"
NODE_IDS="${NODE_IDS:-}"
OUTPUT_DIR="${OUTPUT_DIR:-${INSTALL_DIR}/out}"

if [[ -z "${PANEL_BASE_URL}" ]]; then
  PANEL_BASE_URL="$(prompt "请输入面板地址（http://...:3000）" "")"
fi
if [[ -z "${INTERNAL_API_KEY}" ]]; then
  INTERNAL_API_KEY="$(prompt "请输入 INTERNAL_API_KEY" "")"
  # 保存到 daemon.env（如果文件存在）
  if [[ -f "${ENV_FILE}" ]]; then
    if ! grep -q "^INTERNAL_API_KEY=" "${ENV_FILE}" 2>/dev/null; then
      echo "INTERNAL_API_KEY=${INTERNAL_API_KEY}" >> "${ENV_FILE}"
    else
      sed -i "s|^INTERNAL_API_KEY=.*|INTERNAL_API_KEY=${INTERNAL_API_KEY}|" "${ENV_FILE}" || true
    fi
  fi
fi
if [[ -z "${NODE_IDS}" ]]; then
  NODE_IDS="$(prompt "请输入 node_id（逗号分隔也可）" "")"
fi

IFS=',' read -r -a NODE_ID_ARR <<< "${NODE_IDS}"
NODE_ID="${NODE_ID_ARR[0]}"
if [[ "${#NODE_ID_ARR[@]}" -gt 1 ]]; then
  echo "检测到多个 node_id：${NODE_IDS}"
  NODE_ID="$(prompt "请输入要操作的 node_id" "${NODE_ID}")"
fi

fetch_allowed() {
  curl -fsS -H "x-internal-token: ${INTERNAL_API_KEY}" \
    "${PANEL_BASE_URL%/}/api/internal/nodes/${NODE_ID}/allowed-uuids"
}

show_allowed() {
  local json
  json="$(fetch_allowed)"
  echo "${json}" | jq .
  echo
  echo "[allowed] uuids="
  echo "${json}" | jq -r '.data.uuids[]?'
}

node_info_file="${INSTALL_DIR}/node.json"

check_node_exists() {
  # 检查节点是否在主面板存在（通过 node_id）
  local check_id="${1:-${NODE_ID}}"
  local resp
  resp="$(curl -fsS -H "x-internal-token: ${INTERNAL_API_KEY}" \
    "${PANEL_BASE_URL%/}/api/internal/nodes/${check_id}/allowed-uuids" 2>/dev/null || echo "")"
  if [[ -n "${resp}" ]]; then
    local code
    code="$(echo "${resp}" | jq -r '.code // empty')"
    if [[ "${code}" == "200" ]]; then
      return 0  # 节点存在
    fi
  fi
  return 1  # 节点不存在
}

sync_node_with_panel() {
  # 节点与主面板同步：检查节点是否存在，如果不存在或被删除，重新注册
  echo "[sync-panel] 检查节点 node_id=${NODE_ID} 是否在主面板存在..."
  
  if check_node_exists "${NODE_ID}"; then
    echo "[ok] 节点在主面板存在，无需同步"
    return 0
  fi

  echo "[warn] 节点在主面板不存在或被删除，开始重新注册..."

  if [[ ! -f "${node_info_file}" ]]; then
    echo "[error] 未找到节点信息文件：${node_info_file}"
    echo "请先用一键脚本部署 Xray（ubuntu-xray-reality-grpc-oneclick.sh），它会生成该文件。"
    return 1
  fi

  echo "[info] 使用 ${node_info_file} 重新注册节点到面板..."
  local payload resp new_id
  payload="$(cat "${node_info_file}")"
  resp="$(curl -fsS \
    -H "Content-Type: application/json" \
    -H "x-internal-token: ${INTERNAL_API_KEY}" \
    -d "${payload}" \
    "${PANEL_BASE_URL%/}/api/internal/register-node")" || {
      echo "[error] 重新注册失败"
      return 1
    }

  new_id="$(echo "${resp}" | jq -r '.data.id // empty')"
  if [[ -z "${new_id}" ]]; then
    echo "[error] 重新注册返回异常："
    echo "${resp}"
    return 1
  fi

  echo "[ok] 重新注册成功：node_id=${new_id}"

  # 更新 node.json 里的 node_id
  tmp="$(mktemp)"
  echo "${payload}" | jq --argjson id "${new_id}" '.node_id=$id' > "${tmp}"
  mv "${tmp}" "${node_info_file}"

  # 更新 daemon.env，使 node-daemon 指向新的 node_id
  if [[ -f "${ENV_FILE}" ]]; then
    # 保存 INTERNAL_API_KEY（如果还没有）
    if ! grep -q "^INTERNAL_API_KEY=" "${ENV_FILE}" 2>/dev/null; then
      echo "INTERNAL_API_KEY=${INTERNAL_API_KEY}" >> "${ENV_FILE}"
    else
      sed -i "s|^INTERNAL_API_KEY=.*|INTERNAL_API_KEY=${INTERNAL_API_KEY}|" "${ENV_FILE}" || true
    fi
    
    # 更新 NODE_IDS
    if ! grep -q "^NODE_IDS=" "${ENV_FILE}" 2>/dev/null; then
      echo "NODE_IDS=${new_id}" >> "${ENV_FILE}"
    else
      sed -i "s/^NODE_IDS=.*/NODE_IDS=${new_id}/" "${ENV_FILE}" || true
    fi
    
    # 更新 XRAY_TAG_MAP
    if ! grep -q "^XRAY_TAG_MAP=" "${ENV_FILE}" 2>/dev/null; then
      echo "XRAY_TAG_MAP=${new_id}:in-vless-reality" >> "${ENV_FILE}"
    else
      sed -i "s|^XRAY_TAG_MAP=.*|XRAY_TAG_MAP=${new_id}:in-vless-reality|" "${ENV_FILE}" || true
    fi
  fi

  # 更新当前脚本的 NODE_ID
  NODE_ID="${new_id}"

  echo "[systemd] 重启 node-daemon..."
  systemctl daemon-reload >/dev/null 2>&1 || true
  systemctl restart panel-xray-daemon.service >/dev/null 2>&1 || true
  echo "[ok] 已重启 panel-xray-daemon.service"
  echo "[ok] 节点与主面板同步完成！"
}

rereregister_node() {
  # 强制重新注册节点（不管是否存在）
  if [[ ! -f "${node_info_file}" ]]; then
    echo "[error] 未找到节点信息文件：${node_info_file}"
    echo "请先用一键脚本部署 Xray（ubuntu-xray-reality-grpc-oneclick.sh），它会生成该文件。"
    return 1
  fi

  echo "[info] 使用 ${node_info_file} 强制重新注册节点到面板..."
  local payload resp new_id
  payload="$(cat "${node_info_file}")"
  resp="$(curl -fsS \
    -H "Content-Type: application/json" \
    -H "x-internal-token: ${INTERNAL_API_KEY}" \
    -d "${payload}" \
    "${PANEL_BASE_URL%/}/api/internal/register-node")" || {
      echo "[error] 重新注册失败"
      return 1
    }

  new_id="$(echo "${resp}" | jq -r '.data.id // empty')"
  if [[ -z "${new_id}" ]]; then
    echo "[error] 重新注册返回异常："
    echo "${resp}"
    return 1
  fi

  echo "[ok] 重新注册成功：node_id=${new_id}"

  # 更新 node.json 里的 node_id
  tmp="$(mktemp)"
  echo "${payload}" | jq --argjson id "${new_id}" '.node_id=$id' > "${tmp}"
  mv "${tmp}" "${node_info_file}"

  # 更新 daemon.env，使 node-daemon 指向新的 node_id
  if [[ -f "${ENV_FILE}" ]]; then
    # 保存 INTERNAL_API_KEY（如果还没有）
    if ! grep -q "^INTERNAL_API_KEY=" "${ENV_FILE}" 2>/dev/null; then
      echo "INTERNAL_API_KEY=${INTERNAL_API_KEY}" >> "${ENV_FILE}"
    else
      sed -i "s|^INTERNAL_API_KEY=.*|INTERNAL_API_KEY=${INTERNAL_API_KEY}|" "${ENV_FILE}" || true
    fi
    
    # 更新 NODE_IDS
    if ! grep -q "^NODE_IDS=" "${ENV_FILE}" 2>/dev/null; then
      echo "NODE_IDS=${new_id}" >> "${ENV_FILE}"
    else
      sed -i "s/^NODE_IDS=.*/NODE_IDS=${new_id}/" "${ENV_FILE}" || true
    fi
    
    # 更新 XRAY_TAG_MAP
    if ! grep -q "^XRAY_TAG_MAP=" "${ENV_FILE}" 2>/dev/null; then
      echo "XRAY_TAG_MAP=${new_id}:in-vless-reality" >> "${ENV_FILE}"
    else
      sed -i "s|^XRAY_TAG_MAP=.*|XRAY_TAG_MAP=${new_id}:in-vless-reality|" "${ENV_FILE}" || true
    fi
  fi

  # 更新当前脚本的 NODE_ID
  NODE_ID="${new_id}"

  echo "[systemd] 重启 node-daemon..."
  systemctl daemon-reload >/dev/null 2>&1 || true
  systemctl restart panel-xray-daemon.service >/dev/null 2>&1 || true
  echo "[ok] 已重启 panel-xray-daemon.service"
}

show_applied() {
  local path="${OUTPUT_DIR}/node-${NODE_ID}/applied.json"
  if [[ ! -f "${path}" ]]; then
    echo "[applied] 文件不存在：${path}"
    echo "说明：可能还没同步成功，或 node-daemon 未启用 xray-grpc apply。"
    return 0
  fi
  cat "${path}" | jq .
  echo
  echo "[applied] uuids="
  cat "${path}" | jq -r '.uuids[]?'
}

sync_once() {
  echo "[sync] 执行一次同步（connector -once）..."
  "${INSTALL_DIR}/bin/connector" -once
  echo "[sync] 完成。你可以再查看 applied 列表确认。"
}

while true; do
  echo
  echo "==========================================================="
  echo " Xray 节点按键面板（查询允许UUID / 查询已应用UUID / 手动同步 / 查询流量）"
  echo " node_id=${NODE_ID}"
  echo "==========================================================="
  echo "1) 查看面板允许的 UUID（internal API）"
  echo "2) 查看本机已应用到 Xray 的 UUID（applied.json）"
  echo "3) UUID 同步：立即同步一次（connector -once，同步面板允许的UUID到Xray）"
  echo "4) 节点与主面板同步：检查节点是否存在，不存在则重新注册"
  echo "5) 强制重新注册节点到主面板（register-node，不管是否存在）"
  echo "6) 查询某个 UUID 的流量与状态"
  echo "7) 切换 node_id"
  echo "8) 退出"
  read -r -p "请选择操作 [1-8]: " c
  case "${c}" in
    1) show_allowed || echo "[error] 拉取失败" ;;
    2) show_applied || echo "[error] 读取失败" ;;
    3) sync_once || echo "[error] UUID 同步失败" ;;
    4) sync_node_with_panel || echo "[error] 节点与主面板同步失败" ;;
    5) rereregister_node || true ;;
    6)
      uuid="$(prompt "请输入要查询的 UUID（客户端中的 UUID）" "")"
      if [[ -z "${uuid}" ]]; then
        echo "[error] UUID 不能为空"
      else
        echo "[info] 调用 /api/internal/auth 查询是否允许上网..."
        auth_json="$(curl -fsS -H "x-internal-token: ${INTERNAL_API_KEY}" \
          "${PANEL_BASE_URL%/}/api/internal/auth?uuid=${uuid}&node_id=${NODE_ID}" || echo "")"
        if [[ -n "${auth_json}" ]]; then
          echo "[auth] 返回："
          echo "${auth_json}" | jq .
        else
          echo "[auth] 请求失败"
        fi
        echo
        echo "[info] 调用 /api/internal/user-traffic 查询流量使用情况..."
        traffic_json="$(curl -fsS -H "x-internal-token: ${INTERNAL_API_KEY}" \
          "${PANEL_BASE_URL%/}/api/internal/user-traffic?uuid=${uuid}" || echo "")"
        if [[ -n "${traffic_json}" ]]; then
          echo "[traffic] 返回："
          echo "${traffic_json}" | jq .
        else
          echo "[traffic] 请求失败"
        fi
      fi
      ;;
    7) NODE_ID="$(prompt "请输入 node_id" "${NODE_ID}")" ;;
    8) exit 0 ;;
    *) echo "无效选择" ;;
  esac
done
SH
fi
chmod +x "${INSTALL_DIR}/tools/xray-panel.sh"

echo "[tools] 安装快捷命令：xp / xray-panel ..."
ln -sf "${INSTALL_DIR}/tools/xray-panel.sh" /usr/local/bin/xp
ln -sf "${INSTALL_DIR}/tools/xray-panel.sh" /usr/local/bin/xray-panel
ln -sf "${INSTALL_DIR}/tools/xray-panel.sh" /usr/local/bin/xr

echo
echo "==================== 完成（Xray gRPC 热更新）===================="
echo "公网 IP: ${PUBLIC_IP}"
echo "VLESS Reality: ${VLESS_PORT}  (sni=${SNI})"
echo "Reality PublicKey: ${PUBLIC_KEY}"
echo "Reality ShortId:   ${SHORT_ID}"
echo "面板 node_id: ${NODE_ID}"
echo
echo "验证："
echo "  - systemctl status panel-xray.service"
echo "  - systemctl status panel-xray-daemon.service"
echo "  - ss -lntp | grep ${XRAY_API_PORT}  # 应只监听 127.0.0.1"
echo "==============================================================="
echo
echo "工具：节点机本地按键面板"
echo "  bash ${INSTALL_DIR}/tools/xray-panel.sh"

