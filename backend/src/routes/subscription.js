const express = require('express');
const crypto = require('crypto');
const pool = require('../config/db');
const auth = require('../middleware/auth');

const router = express.Router();

// 从subscriptions表获取或创建UUID（与订阅token绑定）
async function getOrCreateSubscriptionUuid(userId) {
  const [rows] = await pool.query(
    'SELECT uuid FROM subscriptions WHERE user_id = ? LIMIT 1',
    [userId]
  );
  if (rows.length > 0 && rows[0].uuid) {
    return rows[0].uuid;
  }
  // 如果没有UUID，生成新的并更新到subscriptions表
  const uuid = crypto.randomUUID();
  await pool.query(
    'UPDATE subscriptions SET uuid = ? WHERE user_id = ?',
    [uuid, userId]
  );
  return uuid;
}

// 兼容旧代码：从user_clients表获取UUID（如果subscriptions表中没有）
async function getOrCreateUserUuid(userId) {
  // 优先从subscriptions表获取
  const [subRows] = await pool.query(
    'SELECT uuid FROM subscriptions WHERE user_id = ? LIMIT 1',
    [userId]
  );
  if (subRows.length > 0 && subRows[0].uuid) {
    return subRows[0].uuid;
  }
  
  // 如果subscriptions表中没有，从user_clients表获取
  const [rows] = await pool.query(
    'SELECT uuid FROM user_clients WHERE user_id = ? AND enabled = 1 ORDER BY id ASC LIMIT 1',
    [userId]
  );
  if (rows.length > 0) return rows[0].uuid;
  
  // 如果都没有，生成新的UUID
  const uuid = crypto.randomUUID();
  // 先尝试更新到subscriptions表
  const [subCheck] = await pool.query(
    'SELECT id FROM subscriptions WHERE user_id = ? LIMIT 1',
    [userId]
  );
  if (subCheck.length > 0) {
    await pool.query(
      'UPDATE subscriptions SET uuid = ? WHERE user_id = ?',
      [uuid, userId]
    );
  } else {
    // 如果subscriptions表也没有记录，插入到user_clients表（兼容旧逻辑）
    await pool.query(
      'INSERT INTO user_clients (user_id, uuid, remark, enabled) VALUES (?, ?, ?, 1)',
      [userId, uuid, 'default']
    );
  }
  return uuid;
}

// 生成随机 token
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// 从 system_settings 读取面板网址（用于订阅 URL）
async function getPanelPublicUrl(req) {
  try {
    const [rows] = await pool.query(
      "SELECT value FROM system_settings WHERE `key` = 'panel_public_url' LIMIT 1"
    );
    if (rows.length > 0 && rows[0].value) return String(rows[0].value).trim();
  } catch (e) {
    // 表可能不存在
  }
  if (process.env.PANEL_PUBLIC_URL) return String(process.env.PANEL_PUBLIC_URL).trim();
  if (req && req.protocol && req.get) {
    const host = req.get('host');
    if (host) return `${req.protocol}://${host}`;
  }
  return '';
}

// GET /api/subscription/token 获取或生成用户的订阅 token
router.get('/token', auth, async (req, res, next) => {
  try {
    const userId = req.user.id;

    // 先查是否已有订阅 token
    let [rows] = await pool.query(
      'SELECT token, uuid FROM subscriptions WHERE user_id = ? LIMIT 1',
      [userId]
    );

    let token;
    let uuid;
    if (rows.length === 0) {
      // 没有则生成新的token和UUID
      token = generateToken();
      uuid = crypto.randomUUID();
      await pool.query(
        'INSERT INTO subscriptions (user_id, token, uuid, created_at) VALUES (?, ?, ?, NOW())',
        [userId, token, uuid]
      );
    } else {
      token = rows[0].token;
      uuid = rows[0].uuid;
      // 如果UUID不存在，生成并更新
      if (!uuid) {
        uuid = crypto.randomUUID();
        await pool.query(
          'UPDATE subscriptions SET uuid = ? WHERE user_id = ?',
          [uuid, userId]
        );
      }
    }

    // 获取面板网址用于生成订阅链接
    const panelUrl = await getPanelPublicUrl(req);
    const shareUrl = panelUrl ? `${panelUrl.replace(/\/$/, '')}/api/sub/${token}` : '';

    res.json({
      code: 200,
      message: 'success',
      data: { token, uuid, share_url: shareUrl }
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/subscription/reset-token 重置订阅 token
router.post('/reset-token', auth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const newToken = generateToken();
    // 重置token时同时生成新的UUID
    const newUuid = crypto.randomUUID();

    await pool.query(
      'UPDATE subscriptions SET token = ?, uuid = ?, updated_at = NOW() WHERE user_id = ?',
      [newToken, newUuid, userId]
    );

    // 获取面板网址用于生成订阅链接
    const panelUrl = await getPanelPublicUrl(req);
    const shareUrl = panelUrl ? `${panelUrl.replace(/\/$/, '')}/api/sub/${newToken}` : '';

    res.json({
      code: 200,
      message: '订阅链接已重置',
      data: { token: newToken, uuid: newUuid, share_url: shareUrl }
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/sub/:token 获取订阅内容（支持多种格式）
router.get('/:token', async (req, res, next) => {
  try {
    const { token } = req.params;
    const format = req.query.format || 'clash'; // 默认 Clash

    // 根据 token 查找用户
    const [subRows] = await pool.query(
      `SELECT s.user_id, u.status, u.traffic_used
       FROM subscriptions s
       JOIN users u ON s.user_id = u.id
       WHERE s.token = ? LIMIT 1`,
      [token]
    );

    if (subRows.length === 0) {
      return res.status(404).json({
        code: 404,
        message: '订阅链接不存在或已失效',
        data: null
      });
    }

    const user = subRows[0];

    // 检查用户状态
    if (user.status !== 'active') {
      return res.status(403).send('# 账户已被停用');
    }

    // 订单式到期：按用户 paid 订单 + duration_days 叠加计算每个 plan 的实际到期时间
    const [paidOrders] = await pool.query(
      `SELECT o.id, o.plan_id, o.duration_days, o.created_at, o.paid_at,
              p.traffic_limit
       FROM orders o
       JOIN plans p ON o.plan_id = p.id
       WHERE o.user_id = ?
         AND o.status = 'paid'
       ORDER BY COALESCE(o.paid_at, o.created_at) ASC, o.id ASC`,
      [user.user_id]
    );

    if (paidOrders.length === 0) {
      return res.status(403).send('# 您还没有可用的套餐');
    }

    const now = new Date();
    const byPlan = new Map();
    for (const o of paidOrders) {
      if (!byPlan.has(o.plan_id)) byPlan.set(o.plan_id, []);
      byPlan.get(o.plan_id).push(o);
    }

    const activePlanIds = [];
    let totalTrafficLimit = 0; // 所有有效订单的总流量配额（一次性，无重置周期）

    for (const [planId, orders] of byPlan.entries()) {
      let accExpire = null;
      for (const o of orders) {
        const baseStr = o.paid_at || o.created_at;
        if (!baseStr) continue;
        const base = new Date(baseStr);
        const start = accExpire && accExpire > base ? accExpire : base;
        const durationDays = Number(o.duration_days || 0);
        if (durationDays <= 0) continue;
        const expire = new Date(start.getTime() + durationDays * 24 * 60 * 60 * 1000);
        accExpire = expire;
      }
      if (accExpire && accExpire > now) {
        activePlanIds.push(planId);
        // 累加该套餐的流量配额（只累加一次，即使有多个订单）
        const planTrafficLimit = Number(orders[0].traffic_limit || 0);
        if (planTrafficLimit > 0) {
          totalTrafficLimit += planTrafficLimit;
        }
      }
    }

    if (activePlanIds.length === 0) {
      return res.status(403).send('# 订阅已过期');
    }

    // 检查流量是否超限（一次性配额，无重置周期）
    // 总配额 0 = 不可使用；总配额 > 0 且已用 >= 总配额 = 流量已用完
    if (totalTrafficLimit >= 0 && user.traffic_used >= totalTrafficLimit) {
      return res.status(403).send('# 流量已用完');
    }

    const [nodeIdRows] = await pool.query(
      `SELECT DISTINCT pn.node_id
       FROM plan_nodes pn
       WHERE pn.plan_id IN (${activePlanIds.map(() => '?').join(',')})`,
      activePlanIds
    );

    if (nodeIdRows.length === 0) {
      return res.status(403).send('# 当前套餐没有可用节点');
    }

    const nodeIds = nodeIdRows.map((r) => r.node_id);

    // 查询节点详情
    const [nodeRows] = await pool.query(
      `SELECT id, name, address, port, protocol, config, status
       FROM nodes
       WHERE id IN (${nodeIds.map(() => '?').join(',')})
         AND status = 1
       ORDER BY sort_order ASC, id ASC`,
      nodeIds
    );

    if (nodeRows.length === 0) {
      return res.status(403).send('# 当前套餐没有可用节点');
    }

    // 根据格式生成订阅内容
    let content;
    const contentType = {
      clash: 'application/x-yaml',
      v2ray: 'text/plain; charset=utf-8',
      'sing-box': 'application/json',
      surge: 'text/plain; charset=utf-8',
      quantumult: 'text/plain; charset=utf-8'
    }[format] || 'text/plain; charset=utf-8';

    const userUuid = await getOrCreateUserUuid(user.user_id);

    switch (format) {
      case 'clash':
        content = generateClashConfig(nodeRows, userUuid);
        break;
      case 'v2ray':
        content = generateV2RayConfig(nodeRows, userUuid);
        break;
      case 'sing-box':
        content = generateSingBoxConfig(nodeRows, userUuid);
        break;
      case 'surge':
        content = generateSurgeConfig(nodeRows, userUuid);
        break;
      case 'quantumult':
        content = generateQuantumultConfig(nodeRows, userUuid);
        break;
      default:
        content = generateClashConfig(nodeRows, userUuid);
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="subscription.${format === 'clash' ? 'yaml' : format === 'sing-box' ? 'json' : 'txt'}"`);
    res.send(content);
  } catch (err) {
    next(err);
  }
});

// 生成 Clash 配置
function generateClashConfig(nodes, userUuid) {
  const proxies = [];
  const proxyNames = [];

  nodes.forEach((node, index) => {
    try {
      const config = JSON.parse(node.config || '{}');
      const name = `${node.name || `节点${index + 1}`}`;
      proxyNames.push(name);

      switch (node.protocol) {
        case 'vless':
          proxies.push({
            name,
            type: 'vless',
            server: node.address,
            port: node.port,
            uuid: userUuid || config.uuid || config.id || '',
            tls: config.security === 'reality' || config.security === 'tls',
            'reality-opts': config.security === 'reality' ? {
              'public-key': config.publicKey || '',
              'short-id': config.shortId || ''
            } : undefined,
            flow: config.flow || '',
            'client-fingerprint': 'chrome',
            ...(config.sni ? { servername: config.sni } : {})
          });
          break;
        case 'vmess':
          proxies.push({
            name,
            type: 'vmess',
            server: node.address,
            port: node.port,
            uuid: userUuid || config.id || config.v || '',
            alterId: config.aid || config.alterId || 0,
            cipher: 'auto',
            tls: config.tls === 'tls',
            network: config.net || config.type || 'tcp',
            ...(config.net === 'ws' ? {
              'ws-opts': {
                path: config.path || '/',
                headers: config.host ? { Host: config.host } : {}
              }
            } : {})
          });
          break;
        case 'shadowsocks':
          proxies.push({
            name,
            type: 'ss',
            server: node.address,
            port: node.port,
            cipher: config.method || 'aes-256-gcm',
            password: config.password || ''
          });
          break;
        case 'trojan':
          proxies.push({
            name,
            type: 'trojan',
            server: node.address,
            port: node.port,
            password: userUuid || config.password || '',
            sni: config.sni || node.address,
            'skip-cert-verify': !!config.insecure
          });
          break;
        case 'hysteria2':
          proxies.push({
            name,
            type: 'hysteria2',
            server: node.address,
            port: node.port,
            password: userUuid || config.password || config.token || '',
            ...(config.sni ? { sni: config.sni } : {}),
            ...(config.insecure ? { 'skip-cert-verify': true } : {})
          });
          break;
        case 'socks':
          proxies.push({
            name,
            type: 'socks5',
            server: node.address,
            port: node.port,
            username: userUuid || config.username || '',
            password: userUuid || config.password || ''
          });
          break;
      }
    } catch (e) {
      console.error(`解析节点 ${node.id} 配置失败:`, e);
    }
  });

  // 生成正确的 YAML 格式
  const yamlLines = [
    'port: 7890',
    'socks-port: 7891',
    'allow-lan: false',
    'mode: rule',
    'log-level: info',
    'external-controller: 127.0.0.1:9090',
    '',
    'proxies:'
  ];

  proxies.forEach(p => {
    yamlLines.push('  - name: ' + (p.name || ''));
    yamlLines.push('    type: ' + p.type);
    yamlLines.push('    server: ' + p.server);
    yamlLines.push('    port: ' + p.port);
    if (p.uuid) yamlLines.push('    uuid: ' + p.uuid);
    if (p.password) yamlLines.push('    password: ' + p.password);
    if (p.username) yamlLines.push('    username: ' + p.username);
    if (p.cipher) yamlLines.push('    cipher: ' + p.cipher);
    if (p.alterId !== undefined) yamlLines.push('    alterId: ' + p.alterId);
    if (p.flow) yamlLines.push('    flow: ' + p.flow);
    if (p.tls !== undefined) yamlLines.push('    tls: ' + p.tls);
    if (p.servername) yamlLines.push('    servername: ' + p.servername);
    if (p.network) yamlLines.push('    network: ' + p.network);
    if (p['skip-cert-verify'] !== undefined) yamlLines.push('    skip-cert-verify: ' + p['skip-cert-verify']);
    if (p['ws-opts']) {
      yamlLines.push('    ws-opts:');
      if (p['ws-opts'].path) yamlLines.push('      path: ' + p['ws-opts'].path);
      if (p['ws-opts'].headers) {
        yamlLines.push('      headers:');
        Object.keys(p['ws-opts'].headers).forEach(k => {
          yamlLines.push(`        ${k}: ${p['ws-opts'].headers[k]}`);
        });
      }
    }
    if (p['reality-opts']) {
      yamlLines.push('    reality-opts:');
      if (p['reality-opts']['public-key']) yamlLines.push('      public-key: ' + p['reality-opts']['public-key']);
      if (p['reality-opts']['short-id']) yamlLines.push('      short-id: ' + p['reality-opts']['short-id']);
    }
    yamlLines.push('');
  });

  yamlLines.push('proxy-groups:');
  yamlLines.push('  - name: 🚀 节点选择');
  yamlLines.push('    type: select');
  yamlLines.push('    proxies:');
  yamlLines.push('      - ♻️ 自动选择');
  yamlLines.push('      - DIRECT');
  proxyNames.forEach(n => yamlLines.push('      - ' + n));
  yamlLines.push('  - name: ♻️ 自动选择');
  yamlLines.push('    type: url-test');
  yamlLines.push('    proxies:');
  proxyNames.forEach(n => yamlLines.push('      - ' + n));
  yamlLines.push("    url: 'http://www.gstatic.com/generate_204'");
  yamlLines.push('    interval: 300');
  yamlLines.push('');
  yamlLines.push('rules:');
  yamlLines.push('  - DOMAIN-SUFFIX,local,DIRECT');
  yamlLines.push('  - IP-CIDR,127.0.0.0/8,DIRECT');
  yamlLines.push('  - IP-CIDR,172.16.0.0/12,DIRECT');
  yamlLines.push('  - IP-CIDR,192.168.0.0/16,DIRECT');
  yamlLines.push('  - IP-CIDR,10.0.0.0/8,DIRECT');
  yamlLines.push('  - GEOIP,CN,DIRECT');
  yamlLines.push('  - MATCH,🚀 节点选择');

  return yamlLines.join('\n');
}

// 生成 V2Ray 配置（纯文本多行链接，V2RayN/V2RayNG 可直接识别）
function generateV2RayConfig(nodes, userUuid) {
  const links = [];

  nodes.forEach((node) => {
    try {
      const config = JSON.parse(node.config || '{}');
      let link = '';

      switch (node.protocol) {
        case 'vmess':
          const vmessObj = {
            v: '2',
            ps: node.name || '',
            add: node.address,
            port: String(node.port),
            id: userUuid || config.id || config.v || '',
            aid: String(config.aid || config.alterId || 0),
            scy: 'auto',
            net: config.net || config.type || 'tcp',
            type: 'none',
            host: config.host || '',
            path: config.path || '/',
            tls: config.tls || 'none'
          };
          const vmessStr = Buffer.from(JSON.stringify(vmessObj)).toString('base64');
          link = `vmess://${vmessStr}`;
          break;
        case 'vless':
          const vlessParams = new URLSearchParams();
          // 默认参数：flow/security/encryption
          if (config.flow) vlessParams.set('flow', config.flow);
          if (config.security) {
            vlessParams.set('security', config.security);
          }
          vlessParams.set('encryption', config.encryption || 'none');

          // Reality 相关：SNI / 公钥 / shortId
          if (config.sni) vlessParams.set('sni', config.sni);
          if (config.publicKey) vlessParams.set('pbk', config.publicKey);
          if (config.shortId) vlessParams.set('sid', config.shortId);

          // 指纹：默认 chrome，避免客户端出现 empty "fingerprint"
          vlessParams.set('fp', config.fingerprint || 'chrome');

          const vlessId = userUuid || config.uuid || config.id || '';
          const vlessLink = `vless://${vlessId}@${node.address}:${node.port}?${vlessParams.toString()}#${encodeURIComponent(node.name || '')}`;
          link = vlessLink;
          break;
        case 'shadowsocks':
          const ssStr = `${config.method || 'aes-256-gcm'}:${config.password || ''}@${node.address}:${node.port}`;
          const ssBase64 = Buffer.from(ssStr).toString('base64');
          link = `ss://${ssBase64}#${encodeURIComponent(node.name || '')}`;
          break;
        case 'trojan':
          const trojanParams = new URLSearchParams();
          if (config.sni) trojanParams.set('sni', config.sni);
          if (config.alpn && config.alpn.length > 0) trojanParams.set('alpn', config.alpn.join(','));
          const trojanPass = userUuid || config.password || '';
          const trojanLink = `trojan://${encodeURIComponent(trojanPass)}@${node.address}:${node.port}?${trojanParams.toString()}#${encodeURIComponent(node.name || '')}`;
          link = trojanLink;
          break;
        case 'hysteria2':
          const hy2Params = new URLSearchParams();
          if (config.sni) hy2Params.set('sni', config.sni);
          if (config.alpn && config.alpn.length > 0) hy2Params.set('alpn', config.alpn.join(','));
          const hy2Pass = userUuid || config.password || config.token || '';
          const hy2Link = `hysteria2://${encodeURIComponent(hy2Pass)}@${node.address}:${node.port}?${hy2Params.toString()}#${encodeURIComponent(node.name || '')}`;
          link = hy2Link;
          break;
        case 'socks':
          const socksUser = userUuid || config.username || '';
          const socksPass = userUuid || config.password || '';
          if (socksUser || socksPass) {
            link = `socks://${encodeURIComponent(socksUser)}:${encodeURIComponent(socksPass)}@${node.address}:${node.port}#${encodeURIComponent(node.name || '')}`;
          } else {
            link = `socks://${node.address}:${node.port}#${encodeURIComponent(node.name || '')}`;
          }
          break;
      }

      if (link) links.push(link);
    } catch (e) {
      console.error(`生成节点 ${node.id} 链接失败:`, e);
    }
  });

  // V2Ray 订阅格式：纯文本，每行一个链接（不再整体 Base64）
  return links.join('\n');
}

// 生成 sing-box 配置
function generateSingBoxConfig(nodes, userUuid) {
  const outbounds = [];

  nodes.forEach((node, index) => {
    try {
      const config = JSON.parse(node.config || '{}');
      const tag = node.name || `node-${index + 1}`;

      switch (node.protocol) {
        case 'vless':
          outbounds.push({
            type: 'vless',
            tag,
            server: node.address,
            server_port: node.port,
            uuid: userUuid || config.uuid || config.id || '',
            flow: config.flow || '',
            tls: {
              enabled: config.security === 'reality' || config.security === 'tls',
              ...(config.security === 'reality' ? {
                reality: {
                  enabled: true,
                  'public-key': config.publicKey || '',
                  'short-id': config.shortId || ''
                },
                server_name: config.sni || ''
              } : {})
            }
          });
          break;
        case 'vmess':
          outbounds.push({
            type: 'vmess',
            tag,
            server: node.address,
            server_port: node.port,
            uuid: userUuid || config.id || config.v || '',
            security: 'auto',
            alter_id: config.aid || config.alterId || 0,
            ...(config.tls === 'tls' ? {
              tls: {
                enabled: true,
                server_name: config.sni || '',
                insecure: !!config.insecure
              }
            } : {})
          });
          break;
        case 'shadowsocks':
          outbounds.push({
            type: 'shadowsocks',
            tag,
            server: node.address,
            server_port: node.port,
            method: config.method || 'aes-256-gcm',
            password: config.password || ''
          });
          break;
        case 'trojan':
          outbounds.push({
            type: 'trojan',
            tag,
            server: node.address,
            server_port: node.port,
            password: userUuid || config.password || '',
            tls: {
              enabled: true,
              server_name: config.sni || node.address,
              insecure: !!config.insecure
            }
          });
          break;
        case 'hysteria2':
          outbounds.push({
            type: 'hysteria2',
            tag,
            server: node.address,
            server_port: node.port,
            password: userUuid || config.password || config.token || '',
            tls: {
              enabled: true,
              server_name: config.sni || '',
              insecure: !!config.insecure
            }
          });
          break;
        case 'socks':
          outbounds.push({
            type: 'socks',
            tag,
            server: node.address,
            server_port: node.port,
            username: userUuid || config.username || '',
            password: userUuid || config.password || ''
          });
          break;
      }
    } catch (e) {
      console.error(`生成节点 ${node.id} 配置失败:`, e);
    }
  });

  return JSON.stringify({
    version: 1,
    outbounds: [
      {
        type: 'selector',
        tag: 'select',
        outbounds: outbounds.map(o => o.tag)
      },
      ...outbounds
    ]
  }, null, 2);
}

// 生成 Surge 配置
function generateSurgeConfig(nodes, userUuid) {
  const lines = ['#!MANAGED-CONFIG'];

  nodes.forEach((node, index) => {
    try {
      const config = JSON.parse(node.config || '{}');
      const name = node.name || `节点${index + 1}`;

      switch (node.protocol) {
        case 'vless':
          lines.push(`VLESS = ${node.address}, ${node.port}, ${userUuid || config.uuid || config.id || ''}, encryption=none${config.flow ? `, flow=${config.flow}` : ''}${config.sni ? `, sni=${config.sni}` : ''}, ${name}`);
          break;
        case 'vmess':
          lines.push(`VMess = ${node.address}, ${node.port}, username=${userUuid || config.id || config.v || ''}, ${name}`);
          break;
        case 'shadowsocks':
          lines.push(`SS = ${node.address}, ${node.port}, encrypt-method=${config.method || 'aes-256-gcm'}, password=${config.password || ''}, ${name}`);
          break;
        case 'trojan':
          lines.push(`Trojan = ${node.address}, ${node.port}, password=${config.password || ''}${config.sni ? `, sni=${config.sni}` : ''}, ${name}`);
          break;
      }
    } catch (e) {
      console.error(`生成节点 ${node.id} 配置失败:`, e);
    }
  });

  return lines.join('\n');
}

// 生成 Quantumult 配置
function generateQuantumultConfig(nodes, userUuid) {
  const lines = [];

  nodes.forEach((node, index) => {
    try {
      const config = JSON.parse(node.config || '{}');
      const name = node.name || `节点${index + 1}`;

      switch (node.protocol) {
        case 'vless':
          const vlessParams = [];
          const vlessId = userUuid || config.uuid || config.id || '';
          if (vlessId) vlessParams.push(`uuid=${vlessId}`);
          if (config.flow) vlessParams.push(`flow=${config.flow}`);
          if (config.sni) vlessParams.push(`sni=${config.sni}`);
          lines.push(`vless://${vlessId}@${node.address}:${node.port}?${vlessParams.join('&')}#${encodeURIComponent(name)}`);
          break;
        case 'vmess':
          const vmessObj = {
            v: '2',
            ps: name,
            add: node.address,
            port: String(node.port),
            id: userUuid || config.id || config.v || '',
            aid: String(config.aid || config.alterId || 0),
            net: config.net || 'tcp',
            type: 'none'
          };
          const vmessStr = Buffer.from(JSON.stringify(vmessObj)).toString('base64');
          lines.push(`vmess://${vmessStr}`);
          break;
        case 'shadowsocks':
          const ssStr = `${config.method || 'aes-256-gcm'}:${config.password || ''}@${node.address}:${node.port}`;
          const ssBase64 = Buffer.from(ssStr).toString('base64');
          lines.push(`ss://${ssBase64}#${encodeURIComponent(name)}`);
          break;
        case 'trojan':
          lines.push(`trojan://${config.password || ''}@${node.address}:${node.port}?sni=${config.sni || node.address}#${encodeURIComponent(name)}`);
          break;
      }
    } catch (e) {
      console.error(`生成节点 ${node.id} 配置失败:`, e);
    }
  });

  return lines.join('\n');
}

module.exports = router;
