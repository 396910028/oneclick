# 一键节点脚本（Xray VLESS Reality + gRPC 热更新）

## 新机安装（两行）

```bash
curl -fsSL https://raw.githubusercontent.com/396910028/oneclick/refs/heads/master/oneclick/install-xray-node.sh -o install-xray-node.sh
sudo bash install-xray-node.sh
```

按提示输入：面板地址、INTERNAL_API_KEY、节点名、VLESS 端口、SNI 等。

---

## 重装流程（已有节点要更新/修 applied.json 问题）

### 方式一：在节点上通过按键面板重装（推荐，保留配置）

**前提**：本仓库最新代码（含 connector 修复）已推到 GitHub，或你接受当前 GitHub 上的版本。

1. SSH 登录到**节点机**（装 Xray 的那台）。
2. 执行：
   ```bash
   sudo /opt/panel-node-xray/tools/xray-panel.sh
   ```
3. 菜单选 **7) 检查并更新（自动卸载重装，保留配置）**。
4. 脚本会：
   - 备份 `daemon.env`（面板地址、INTERNAL_API_KEY）
   - 停止 panel-xray、panel-xray-daemon
   - 删除 `/opt/panel-node-xray` 和 `/opt/panel-node-xray/src`
   - 从 GitHub 下载 `install-xray-node.sh` 并执行
   - 重新克隆仓库、编译 connector、安装 Xray、写 systemd、恢复 daemon.env
5. 按提示输入**节点名、VLESS 端口、SNI、gRPC 端口、同步间隔、安装目录**等（面板地址和 INTERNAL_API_KEY 已从备份恢复，一般不会再问）。
6. 重装完成后执行一次 **2) UUID 同步**，确认「Xray已应用」为 TRUE。

---

### 方式二：从 GitHub 全新重装（新机或彻底重装）

在**节点机**上执行：

```bash
curl -fsSL https://raw.githubusercontent.com/396910028/oneclick/refs/heads/master/oneclick/install-xray-node.sh -o install-xray-node.sh
sudo bash install-xray-node.sh
```

然后按提示输入所有配置（面板地址、INTERNAL_API_KEY、节点名、端口等）。

---

### 方式三：只更新 connector 二进制（修复未推 GitHub 时）

适用于：只改了 connector 代码，想尽快生效，不想整机重装。

1. **在能编译 Go 的机器上**（本机或 CI）：
   ```bash
   cd /path/to/index/connector
   go build -o connector .
   ```
2. 把生成的 `connector` 传到**节点机**，覆盖：
   ```bash
   sudo cp connector /opt/panel-node-xray/bin/connector
   sudo systemctl restart panel-xray-daemon
   ```
3. 在 xray-panel 菜单选 **2) UUID 同步**，确认状态。

---

## 重装后建议

- 在 xray-panel 选 **1) UUID 状态对比**，确认「面板允许」与「Xray已应用」一致。
- 若「Xray已应用」为 FALSE，再选 **2) UUID 同步** 一次。
