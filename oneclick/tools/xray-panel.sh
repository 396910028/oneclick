#!/usr/bin/env bash
set -euo pipefail

# 节点机本地按键面板（配合 Xray gRPC 热更新方案）
# - 查看面板允许的 UUID（internal API）
# - 查看本机已应用 UUID（connector 输出的 applied.json）
# - 手动触发一次同步（connector -once）
# - 自动更新功能
#
# 默认读取 /opt/panel-node-xray/daemon.env

# 版本号（每次发布更新此版本号）
XP_VERSION="1.0.0"

INSTALL_DIR="${INSTALL_DIR:-/opt/panel-node-xray}"
ENV_FILE="${ENV_FILE:-${INSTALL_DIR}/daemon.env}"
REPO_URL="${REPO_URL:-https://github.com/396910028/oneclick.git}"
SRC_DIR="${SRC_DIR:-/opt/panel-node-xray-src}"
VERSION_URL="${VERSION_URL:-https://raw.githubusercontent.com/396910028/oneclick/master/VERSION}"

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

# 整合显示：对比面板允许的 UUID 和 Xray 已应用的 UUID
show_uuid_comparison() {
  echo "[UUID 状态对比]"
  echo "==========================================================="
  
  # 获取面板允许的 UUID
  local allowed_json allowed_uuids
  allowed_json="$(fetch_allowed 2>/dev/null || echo '{"code":500,"data":{"uuids":[]}}')"
  allowed_uuids="$(echo "${allowed_json}" | jq -r '.data.uuids[]?' 2>/dev/null || echo "")"
  
  # 获取 Xray 已应用的 UUID
  local applied_path="${OUTPUT_DIR}/node-${NODE_ID}/applied.json"
  local applied_uuids=""
  if [[ -f "${applied_path}" ]]; then
    applied_uuids="$(cat "${applied_path}" | jq -r '.uuids[]?' 2>/dev/null || echo "")"
  fi
  
  # 合并所有 UUID（去重）
  local all_uuids
  all_uuids="$(echo -e "${allowed_uuids}\n${applied_uuids}" | sort -u | grep -v '^$')"
  
  if [[ -z "${all_uuids}" ]]; then
    echo "[warn] 未找到任何 UUID"
    return 0
  fi
  
  printf "%-40s %-12s %-12s\n" "UUID" "面板允许" "Xray已应用"
  echo "-----------------------------------------------------------"
  
  while IFS= read -r uuid; do
    [[ -z "${uuid}" ]] && continue
    
    local panel_allowed="FALSE"
    local xray_applied="FALSE"
    
    # 检查面板允许
    if echo "${allowed_uuids}" | grep -qFx "${uuid}" 2>/dev/null; then
      panel_allowed="TRUE"
    fi
    
    # 检查 Xray 已应用
    if echo "${applied_uuids}" | grep -qFx "${uuid}" 2>/dev/null; then
      xray_applied="TRUE"
    fi
    
    printf "%-40s %-12s %-12s\n" "${uuid}" "${panel_allowed}" "${xray_applied}"
  done <<< "${all_uuids}"
  
  echo "==========================================================="
  echo
  echo "说明："
  echo "  - 面板允许=TRUE, Xray已应用=FALSE：需要执行 UUID 同步（选项 2）"
  echo "  - 面板允许=FALSE, Xray已应用=TRUE：用户已被移除，Xray 中应删除"
  echo "  - 两者都为 TRUE：正常状态"
}

node_info_file="${INSTALL_DIR}/node.json"

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

sync_once() {
  echo "[sync] 执行一次同步（connector -once）..."
  # 加载环境变量（从 daemon.env 或当前 shell）
  if [[ -f "${ENV_FILE}" ]]; then
    set -a
    source "${ENV_FILE}" 2>/dev/null || true
    set +a
  fi
  # 确保必要的环境变量存在
  export PANEL_BASE_URL="${PANEL_BASE_URL:-}"
  export INTERNAL_API_KEY="${INTERNAL_API_KEY:-}"
  export NODE_IDS="${NODE_IDS:-${NODE_ID}}"
  export OUTPUT_DIR="${OUTPUT_DIR:-${INSTALL_DIR}/out}"
  export APPLY_MODE="${APPLY_MODE:-xray-grpc}"
  export XRAY_API_ADDR="${XRAY_API_ADDR:-127.0.0.1:10085}"
  export XRAY_TAG_MAP="${XRAY_TAG_MAP:-${NODE_ID}:in-vless-reality}"
  export XRAY_VLESS_FLOW="${XRAY_VLESS_FLOW:-xtls-rprx-vision}"
  
  if [[ -z "${INTERNAL_API_KEY}" ]]; then
    echo "[error] INTERNAL_API_KEY 未设置。请先设置环境变量或检查 ${ENV_FILE}"
    return 1
  fi
  
  "${INSTALL_DIR}/bin/connector" -once
  echo "[sync] 完成。你可以再查看 applied 列表确认。"
}

# 格式化流量显示（字节转 GB/MB）
format_traffic() {
  local bytes="${1:-0}"
  if [[ "${bytes}" -eq 0 ]]; then
    echo "0 B"
  elif [[ "${bytes}" -lt 1048576 ]]; then
    echo "$(awk "BEGIN {printf \"%.2f\", ${bytes}/1024}") KB"
  elif [[ "${bytes}" -lt 1073741824 ]]; then
    echo "$(awk "BEGIN {printf \"%.2f\", ${bytes}/1048576}") MB"
  else
    echo "$(awk "BEGIN {printf \"%.2f\", ${bytes}/1073741824}") GB"
  fi
}

# 检查更新
check_update() {
  echo "[update] 检查更新..."
  local latest_version
  latest_version="$(curl -fsS "${VERSION_URL}" 2>/dev/null || echo "")"
  
  if [[ -z "${latest_version}" ]]; then
    echo "[warn] 无法获取最新版本号（网络问题或 URL 错误）"
    return 1
  fi
  
  latest_version="$(echo "${latest_version}" | tr -d '[:space:]')"
  
  if [[ "${latest_version}" == "${XP_VERSION}" ]]; then
    echo "[ok] 当前已是最新版本：${XP_VERSION}"
    return 0
  fi
  
  echo "[info] 发现新版本：${latest_version}（当前：${XP_VERSION}）"
  return 2
}

# 执行更新
do_update() {
  echo "[update] 开始更新..."
  
  if [[ $EUID -ne 0 ]]; then
    echo "[error] 更新需要 root 权限，请使用 sudo 运行"
    return 1
  fi
  
  # 备份关键配置
  local backup_dir="/tmp/xp-update-backup-$(date +%s)"
  mkdir -p "${backup_dir}"
  
  echo "[update] 备份关键配置到 ${backup_dir}..."
  if [[ -f "${ENV_FILE}" ]]; then
    cp "${ENV_FILE}" "${backup_dir}/daemon.env.bak"
    echo "[update] 已备份 daemon.env"
  fi
  
  # 提取关键配置（INTERNAL_API_KEY 和 PANEL_BASE_URL）
  local saved_internal_key="${INTERNAL_API_KEY:-}"
  local saved_panel_url="${PANEL_BASE_URL:-}"
  
  if [[ -z "${saved_internal_key}" ]] && [[ -f "${ENV_FILE}" ]]; then
    saved_internal_key="$(grep "^INTERNAL_API_KEY=" "${ENV_FILE}" | cut -d'=' -f2- | tr -d '"' || echo "")"
  fi
  
  if [[ -z "${saved_panel_url}" ]] && [[ -f "${ENV_FILE}" ]]; then
    saved_panel_url="$(grep "^PANEL_BASE_URL=" "${ENV_FILE}" | cut -d'=' -f2- | tr -d '"' || echo "")"
  fi
  
  if [[ -z "${saved_internal_key}" ]] || [[ -z "${saved_panel_url}" ]]; then
    echo "[error] 无法获取 INTERNAL_API_KEY 或 PANEL_BASE_URL，更新终止"
    echo "[info] 请手动记录这两个值后重试"
    return 1
  fi
  
  echo "[update] 已保存配置："
  echo "  PANEL_BASE_URL=${saved_panel_url}"
  echo "  INTERNAL_API_KEY=${saved_internal_key:0:20}..."
  
  # 停止服务
  echo "[update] 停止服务..."
  systemctl stop panel-xray-daemon.service >/dev/null 2>&1 || true
  systemctl stop panel-xray.service >/dev/null 2>&1 || true
  
  # 删除旧文件（保留备份目录）
  echo "[update] 清理旧文件..."
  rm -rf "${INSTALL_DIR}" >/dev/null 2>&1 || true
  rm -rf "${SRC_DIR}" >/dev/null 2>&1 || true
  
  # 重新安装
  echo "[update] 重新安装（从 GitHub 拉取最新代码）..."
  echo
  
  # 使用 install-xray-node.sh 重新安装
  local install_script_url="https://raw.githubusercontent.com/396910028/oneclick/master/oneclick/install-xray-node.sh"
  
  if curl -fsSL "${install_script_url}" | bash; then
    echo
    echo "[update] 安装完成，恢复配置..."
    
    # 恢复配置（如果 daemon.env 已重新生成）
    if [[ -f "${ENV_FILE}" ]]; then
      # 更新 INTERNAL_API_KEY
      if grep -q "^INTERNAL_API_KEY=" "${ENV_FILE}" 2>/dev/null; then
        sed -i "s|^INTERNAL_API_KEY=.*|INTERNAL_API_KEY=${saved_internal_key}|" "${ENV_FILE}"
      else
        echo "INTERNAL_API_KEY=${saved_internal_key}" >> "${ENV_FILE}"
      fi
      
      # 更新 PANEL_BASE_URL
      if grep -q "^PANEL_BASE_URL=" "${ENV_FILE}" 2>/dev/null; then
        sed -i "s|^PANEL_BASE_URL=.*|PANEL_BASE_URL=${saved_panel_url}|" "${ENV_FILE}"
      else
        echo "PANEL_BASE_URL=${saved_panel_url}" >> "${ENV_FILE}"
      fi
      
      echo "[update] 配置已恢复"
    fi
    
    # 重启服务
    echo "[update] 重启服务..."
    systemctl daemon-reload >/dev/null 2>&1 || true
    systemctl restart panel-xray.service >/dev/null 2>&1 || true
    systemctl restart panel-xray-daemon.service >/dev/null 2>&1 || true
    
    echo
    echo "[ok] 更新完成！"
    echo "[info] 备份文件保存在：${backup_dir}"
    
    # 更新当前脚本的版本号（从新安装的文件读取）
    if [[ -f "${INSTALL_DIR}/tools/xray-panel.sh" ]]; then
      local new_version
      new_version="$(grep '^XP_VERSION=' "${INSTALL_DIR}/tools/xray-panel.sh" | cut -d'"' -f2 || echo 'unknown')"
      echo "[info] 新版本号：${new_version}"
      
      # 如果当前脚本在 INSTALL_DIR 中，直接替换
      if [[ "$(readlink -f "$0" 2>/dev/null || echo "$0")" == "$(readlink -f "${INSTALL_DIR}/tools/xray-panel.sh" 2>/dev/null || echo "${INSTALL_DIR}/tools/xray-panel.sh")" ]]; then
        echo "[info] 当前脚本已更新"
      else
        echo "[info] 请重新运行 xp 使用新版本（或使用 ${INSTALL_DIR}/tools/xray-panel.sh）"
      fi
    fi
    
    return 0
  else
    echo
    echo "[error] 安装失败！"
    echo "[info] 备份文件保存在：${backup_dir}"
    echo "[info] 你可以手动恢复："
    echo "  cp ${backup_dir}/daemon.env.bak ${ENV_FILE}"
    return 1
  fi
}

while true; do
  echo
  echo "==========================================================="
  echo " Xray 节点按键面板（UUID 状态对比 / 同步 / 流量查询）"
  echo " node_id=${NODE_ID} | 版本: ${XP_VERSION}"
  echo "==========================================================="
  echo "1) UUID 状态对比（面板允许 vs Xray已应用）"
  echo "2) UUID 同步：立即同步一次（connector -once，同步面板允许的UUID到Xray）"
  echo "3) 强制重新注册节点到主面板（register-node，不管是否存在）"
  echo "4) 查询某个 UUID 的流量与状态"
  echo "5) 切换 node_id"
  echo "6) 检查并更新（自动卸载重装，保留配置）"
  echo "7) 退出"
  read -r -p "请选择操作 [1-7]: " c
  case "${c}" in
    1) show_uuid_comparison || echo "[error] 查询失败" ;;
    2) sync_once || echo "[error] UUID 同步失败" ;;
    3) rereregister_node || true ;;
    4)
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
          code="$(echo "${traffic_json}" | jq -r '.code // 0')"
          if [[ "${code}" == "200" ]]; then
            user_id="$(echo "${traffic_json}" | jq -r '.data.user_id // 0')"
            status="$(echo "${traffic_json}" | jq -r '.data.status // "unknown"')"
            traffic_total="$(echo "${traffic_json}" | jq -r '.data.traffic_total // 0')"
            traffic_used="$(echo "${traffic_json}" | jq -r '.data.traffic_used // 0')"
            upload_24h="$(echo "${traffic_json}" | jq -r '.data.upload_24h // 0')"
            download_24h="$(echo "${traffic_json}" | jq -r '.data.download_24h // 0')"
            
            echo "[traffic] 用户流量统计："
            echo "  用户ID: ${user_id}"
            echo "  状态: ${status}"
            echo "  总流量配额: $(format_traffic "${traffic_total}")"
            echo "  已用流量: $(format_traffic "${traffic_used}")"
            if [[ "${traffic_total}" -gt 0 ]]; then
              remaining=$((traffic_total - traffic_used))
              percent="$(awk "BEGIN {printf \"%.2f\", ${traffic_used}*100/${traffic_total}}")"
              echo "  剩余流量: $(format_traffic "${remaining}") (已用 ${percent}%)"
            fi
            echo "  近24小时上传: $(format_traffic "${upload_24h}")"
            echo "  近24小时下载: $(format_traffic "${download_24h}")"
            total_24h=$((upload_24h + download_24h))
            echo "  近24小时总计: $(format_traffic "${total_24h}")"
            echo
            echo "[traffic] 原始 JSON："
            echo "${traffic_json}" | jq .
          else
            echo "[traffic] 返回："
            echo "${traffic_json}" | jq .
          fi
        else
          echo "[traffic] 请求失败"
        fi
      fi
      ;;
    5) NODE_ID="$(prompt "请输入 node_id" "${NODE_ID}")" ;;
    6)
      if check_update; then
        echo
        read -r -p "是否立即更新？(y/N): " confirm
        if [[ "${confirm}" =~ ^[Yy]$ ]]; then
          do_update
          echo
          echo "[info] 更新完成，程序将退出。请重新运行 xp 使用新版本。"
          exit 0
        else
          echo "[info] 已取消更新"
        fi
      else
        local update_result=$?
        if [[ "${update_result}" == "2" ]]; then
          echo
          read -r -p "发现新版本，是否立即更新？(y/N): " confirm
          if [[ "${confirm}" =~ ^[Yy]$ ]]; then
            do_update
            echo
            echo "[info] 更新完成，程序将退出。请重新运行 xp 使用新版本。"
            exit 0
          else
            echo "[info] 已取消更新"
          fi
        fi
      fi
      ;;
    7) exit 0 ;;
    *) echo "无效选择" ;;
  esac
done

