## 一键节点脚本使用说明（Xray VLESS Reality + gRPC 热更新）

本目录主要用于**节点机一键部署脚本**，当前推荐使用方案为：  
在节点机上通过一行命令安装 Xray（VLESS Reality）+ gRPC 热更新 + node-daemon + 本地按键面板。

### 1. 前置条件

- 节点机系统：推荐 Ubuntu 20.04 / 22.04（amd64 架构）。
- 需具备：
  - 可以访问公网（至少能访问 GitHub Raw 或你自建的脚本仓库地址）。
  - 能访问到面板地址，例如 `http://jinkecheng.icbc.press:3000`（或你自己的面板域名/IP+端口）。
- 节点机需有 root 权限（或可以使用 `sudo`）。

### 2. 一行命令安装入口（推荐）

在**节点机**上执行下面的一行命令：

```bash
curl -fsSL https://raw.githubusercontent.com/396910028/oneclick/master/oneclick/install-xray-node.sh | sudo bash
```

说明：

- 脚本会自动完成：
  - `apt-get update`，安装 `git`、`curl`、`ca-certificates` 等基础依赖；
  - 克隆/更新仓库到 `/opt/panel-node-xray-src`；
  - 进入 `oneclick/` 目录并执行 `ubuntu-xray-reality-grpc-oneclick.sh`；
  - 根据交互提示填写面板地址、内部密钥、节点名称、端口、SNI 等；
  - 安装/更新 Xray 二进制、生成 Reality keypair、写入 `/etc/xray/config.json`；
  - 注册节点到面板 `/api/internal/register-node`，记录得到的 `node_id`；
  - 编译并配置 `connector`（`APPLY_MODE=xray-grpc`），写入 `panel-xray-daemon.service`；
  - 创建本地按键面板脚本 `tools/xray-panel.sh`，并在系统中添加快捷命令 `xp` / `xray-panel` / `xr`。

### 3. 安装完成后的常用命令

在节点机上，可以使用以下命令进行检查与日常运维：

- **查看 Xray 服务状态**

```bash
systemctl status panel-xray.service --no-pager
```

- **查看节点守护进程（connector）状态**

```bash
systemctl status panel-xray-daemon.service --no-pager
```

- **查看监听端口（含 gRPC API）**

```bash
ss -lntp | grep 10085
```

- **打开本地按键面板**

```bash
xp
# 或
xray-panel
# 或
xr
```

按键面板主要功能：

- **1) 查看面板允许的 UUID**（`allowed-uuids`，来自 `/api/internal/nodes/:nodeId/allowed-uuids`）；
- **2) 查看本机已应用到 Xray 的 UUID**（读取 `out/node-*/applied.json`）；
- **3) UUID 同步**：手动触发一次同步（`connector -once`），实现不重启 Xray 的即时用户增删（同步面板允许的 UUID 到 Xray）；
- **4) 节点与主面板同步**（新功能）：
  - 检查节点是否在主面板存在（通过 `node_id` 查询）；
  - 如果节点不存在或被删除，自动重新注册节点到主面板（使用 `node.json` 中的信息）；
  - 自动更新 `daemon.env` 中的 `NODE_IDS`、`XRAY_TAG_MAP` 和 `INTERNAL_API_KEY`（确保配置持久化）；
  - 重启 `panel-xray-daemon.service` 使新配置生效；
  - **使用场景**：主面板删除了节点后，执行此选项可立即恢复节点注册。
- **5) 强制重新注册节点到主面板**：不管节点是否存在，都重新注册（当你重装面板或调整节点信息时可一键重新对接）；
- **6) 查询某个 UUID 的流量与状态**：
  - 输入客户端中的 UUID 后，脚本会依次调用：
    - `/api/internal/auth?uuid=...&node_id=...`：查看该 UUID 当前是否允许上网（含封禁/超流量/无有效套餐等原因）；
    - `/api/internal/user-traffic?uuid=...`：查看对应用户的流量使用情况（总配额/已用流量 + 近 24 小时上传/下载字节数）。
- **7) 切换 node_id**：切换当前操作的节点 ID（如果节点机管理多个节点）。
- **8) 退出**：退出按键面板。

**注意事项**：
- 选项 3（UUID 同步）是**面板允许的 UUID 和 Xray 之间的同步**，用于实时更新 Xray 的用户列表。
- 选项 4（节点与主面板同步）是**节点与主面板的同步**，用于确保节点在主面板中已注册，如果被删除会自动恢复。
- `INTERNAL_API_KEY` 会在首次输入或执行同步操作时自动保存到 `/opt/panel-node-xray/daemon.env`，确保配置持久化。

### 4. 高级用法：直接运行底层脚本

如果你已经手动拉取了代码仓库到本地（例如 `/root/vpnpanel` 或 `/opt/panel-node-xray-src`），也可以直接在 `oneclick/` 目录下运行底层脚本：

```bash
cd /opt/panel-node-xray-src/oneclick
chmod +x ubuntu-xray-reality-grpc-oneclick.sh
sudo ./ubuntu-xray-reality-grpc-oneclick.sh
```

此方式与通过 `install-xray-node.sh` 入口效果一致，只是少了一步自动更新仓库的封装。

### 5. 与面板的关系说明

- 面板侧需要在 `backend/.env.docker`（或运行环境变量）中配置好 `INTERNAL_API_KEY`。  
- 一键脚本会提示你输入该密钥，并自动以 `x-internal-token` 头形式调用面板 `/api/internal/*` 接口。
- 节点机一旦成功对接：
  - 面板会在 `nodes` 表中新增一条记录，并返回 `node_id`；
  - `connector` 会定期拉取该 `node_id` 允许的 UUID 列表，并通过 Xray gRPC API 实时增删用户，不需要重启 Xray 服务；
  - 你的订阅链接中生成的节点配置，只要 UUID 在允许列表内即可正常使用，一旦套餐过期/流量耗尽/被封禁，UUID 会从允许列表中被移除，实现“机场级别强制断网”。
