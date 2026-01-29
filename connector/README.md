# 对接程序（connector）— 让 Xray 按 UUID 精确断网

本目录提供一个 **Go 对接程序**，用于做到“机场级别控制”：

- 即使用户客户端不刷新订阅、仍然保留旧配置
- 只要用户 **套餐到期 / 被封禁 / 超流量**
- 节点侧也会通过 **UUID** 立即拒绝连接（强行断网）

它的工作方式是：

1. 周期性调用面板内部接口：`GET /api/internal/nodes/:nodeId/allowed-uuids`
2. 得到该节点当前允许的 UUID 列表
3. 写入 `OUTPUT_DIR/node-<id>/allowed-uuids.{txt,json}`
4. （可选）执行 `APPLY_CMD` 钩子脚本，把 UUID 列表应用到 Xray（推荐用 Xray API 动态 add/remove users；退而求其次可重载/重启）

> 注意：面板侧接口已经在后端新增并做了 token 保护（`x-internal-token`）。

---

## 1. 前置：面板内部接口

面板后端需要设置（`backend/.env.docker`）：

- `INTERNAL_API_KEY=...`

对接程序每次请求都会带：

- Header：`x-internal-token: <INTERNAL_API_KEY>`

---

## 2. 编译/运行

进入目录：

```bash
cd connector
```

编译：

```bash
go build -o connector .
```

运行（示例）：

```bash
PANEL_BASE_URL="http://127.0.0.1:3000" \
INTERNAL_API_KEY="你的内部密钥" \
NODE_IDS="1,2,3" \
OUTPUT_DIR="./out" \
INTERVAL_SECONDS="10" \
./connector
```

只跑一次并退出：

```bash
./connector -once
```

---

## 3. 环境变量说明

- `PANEL_BASE_URL`：面板后端地址（示例：`http://127.0.0.1:3000` 或 `http://backend:3000`）
- `INTERNAL_API_KEY`：必须，与后端 `.env.docker` 一致
- `NODE_IDS`：要同步的节点 ID 列表（逗号分隔），例如 `1,2,3`
- `OUTPUT_DIR`：输出目录（默认 `./out`）
- `INTERVAL_SECONDS`：同步间隔秒（默认 10）
- `HTTP_TIMEOUT_SECONDS`：请求超时秒（默认 10）
- `APPLY_CMD`：可选，发生变更后执行的命令模板（见下节）

---

## 4. APPLY_CMD：把 UUID 列表“真正应用”到 Xray

对接程序会在每个节点 UUID 列表变更后执行一次 `APPLY_CMD`。

它支持 3 个占位符：

- `{node_id}`：节点 ID
- `{uuids_file}`：生成的 `allowed-uuids.txt` 文件路径
- `{uuids_json}`：生成的 `allowed-uuids.json` 文件路径

### 4.1 推荐方案：Xray API 动态 add/remove users（真正“强行断网”）

你需要在 Xray 配置开启 **API**（监听本机 gRPC），并让对接程序能访问该端口。

示例思路（伪流程）：

1. 对接程序拿到 `{uuids_file}`
2. 读取 UUID 列表，与“当前 Xray inbound users”做差集：
   - 不在列表内的 UUID → remove
   - 新增的 UUID → add
3. 通过 Xray gRPC API 直接更新（无需重启）

> 由于不同内核版本/部署方式差异较大，本仓库默认不内置 Xray gRPC proto（否则会引入大量生成代码）。  
> 最稳的落地方式是：你提供一个 `apply.sh/apply.ps1`，内部用你服务器上的 `xray`/`xray-api` 工具或你自己的 gRPC 客户端去执行 add/remove。

### 4.2 兜底方案：重写配置 + 重启（能用但“断网不够实时”）

如果你不方便用 gRPC API，可以：

- 把 `{uuids_file}` 转成 Xray inbound 的 `clients` 数组 JSON
- 写入某个 `clients.json`
- 然后 `systemctl restart xray` 或容器重启

缺点：

- 重启有短暂闪断
- 同步频率越高重启越频繁

---

## 5. 最小可用的 apply 脚本示例（你来填具体实现）

### Linux（`apply.sh`）

```bash
#!/usr/bin/env bash
set -euo pipefail

NODE_ID="$1"
UUIDS_FILE="$2"

echo "[apply] node=$NODE_ID uuids_file=$UUIDS_FILE"

# TODO：把 UUID 列表应用到 Xray
# - 推荐：调用你自己的 gRPC 客户端进行 add/remove
# - 兜底：生成 clients.json 并重启 xray
```

对应的 `APPLY_CMD`：

```bash
APPLY_CMD="bash ./apply.sh {node_id} {uuids_file}"
```

### Windows（`apply.ps1`）

```powershell
param(
  [int]$NodeId,
  [string]$UuidsFile
)

Write-Host "[apply] node=$NodeId uuids_file=$UuidsFile"

# TODO：把 UUID 列表应用到 Xray
```

对应的 `APPLY_CMD`：

```powershell
$env:APPLY_CMD = "powershell -NoProfile -File .\\apply.ps1 -NodeId {node_id} -UuidsFile {uuids_file}"
```

---

## 6. 流量统计（xray-grpc 模式）

当 `APPLY_MODE=xray-grpc` 时，connector 会**按周期**（默认 60 秒）做两件事：

1. **从 Xray 读流量**  
   通过 Xray gRPC **StatsService** 查询每个已应用用户的流量：  
   - `user>>>{email}>>>traffic>>>uplink`  
   - `user>>>{email}>>>traffic>>>downlink`  
   （`email` 即 UUID，与 AddUser 时一致）

2. **上报增量到面板**  
   计算与上次的差值（增量），调用 `POST /api/internal/report-traffic`，面板会累加 `users.traffic_used` 并写入 `user_traffic_minute` 等。

**前提：**

- Xray 配置中需有 **StatsService**、**stats: {}**，以及 **policy.levels.0.statsUserUplink / statsUserDownlink: true**，否则 Xray 不会记录用户流量。
- 环境变量：`ENABLE_TRAFFIC_REPORT=true`（默认）、`TRAFFIC_REPORT_INTERVAL_SECONDS=60`。

