# 一键节点（Xray VLESS Reality + gRPC）

## 安装

```bash
curl -o install-xray-node.sh https://raw.githubusercontent.com/396910028/oneclick/master/oneclick/install-xray-node.sh
sudo bash install-xray-node.sh
```

## 上不了网时（节点排查）

在**节点机**上执行诊断脚本，把输出贴给排查：

```bash
sudo /opt/panel-node-xray/tools/diag-node.sh
```

重点看输出里：
- **443** 是否由 xray 监听
- **applied.json** 里是否有你的 UUID
- **VLESS clients 数量** 是否 > 0（为 0 说明用户未写入 Xray）
- **本机公网 IP**：客户端「服务器地址」必须填此 IP（或解析到此 IP 的域名）
- **云安全组**：入站 TCP 443 是否放行

客户端必须与面板该节点一致：**UUID、Reality 的 publicKey / shortId / sni**，且 **flow = xtls-rprx-vision**。