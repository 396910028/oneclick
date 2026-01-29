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
    # 从安装目录读取 sing-box 配置，推导需要注册到面板的节点信息（每个协议/端口一条）
    cfg_path = os.path.join(INSTALL_DIR, "singbox", "config.json")
    cfg = load_json(cfg_path)

    public_ip = os.environ.get("NODE_PUBLIC_IP", "")
    if not public_ip:
        # 尽量从 env / hostname 获取
        code, out = sh(["bash", "-lc", "curl -fsSL https://api.ipify.org || hostname -I | awk '{print $1}'"])
        public_ip = out.strip() if code == 0 else ""

    nodes = []
    for inbound in cfg.get("inbounds", []):
        t = inbound.get("type")
        tag = inbound.get("tag", t)
        port = inbound.get("listen_port")

        if not t or not port:
            continue

        protocol_map = {
            "vless": "vless",
            "vmess": "vmess",
            "trojan": "trojan",
            "hysteria2": "hysteria2",
            "socks": "socks",
            "shadowsocks": "shadowsocks",
        }
        proto = protocol_map.get(t)
        if not proto:
            continue

        config = {"managed": {"provider": "node-agent", "mode": "push-users"}}

        if t == "vless":
            tls = inbound.get("tls", {}) or {}
            reality = tls.get("reality", {}) or {}
            handshake = reality.get("handshake", {}) or {}
            config.update({
                "security": "reality",
                "sni": handshake.get("server", ""),
                "publicKey": os.environ.get("REALITY_PUBLIC_KEY", ""),
                "shortId": (reality.get("short_id") or [""])[0] if isinstance(reality.get("short_id"), list) else "",
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
            info = get_node_info()
            return self._json(200, info)
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
                resp = apply_users(payload)
                return self._json(200, resp)
            except Exception as e:
                return self._json(400, {"error": str(e)})
        self.send_error(404, "not found")


def main():
    httpd = HTTPServer((LISTEN, PORT), Handler)
    print(f"[node-agent] listening on http://{LISTEN}:{PORT}")
    httpd.serve_forever()


if __name__ == "__main__":
    main()

