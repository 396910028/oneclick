const express = require('express');
const pool = require('../config/db');
const auth = require('../middleware/auth');
const adminOnly = require('../middleware/admin');

const router = express.Router();

// 所有 /api/admin/node-agent/* 接口都需要登录 + 管理员权限
router.use(auth, adminOnly);

async function getActivePlanIdsForUser(userId) {
  // 从 user_entitlements 读取有效的权益（active 且未过期且有剩余流量）
  const [rows] = await pool.query(
    `SELECT e.plan_id, e.group_id, pg.level, pg.is_exclusive
     FROM user_entitlements e
     JOIN plan_groups pg ON e.group_id = pg.id
     WHERE e.user_id = ? 
       AND e.status = 'active'
       AND e.service_expire_at > NOW()
       AND (e.traffic_total_bytes < 0 OR e.traffic_used_bytes < e.traffic_total_bytes)
     ORDER BY pg.level DESC, e.service_expire_at DESC`,
    [userId]
  );

  if (rows.length === 0) return [];

  // 互斥组内只保留 level 最高的一条权益对应的 plan_id
  const byGroup = new Map();
  for (const r of rows) {
    const gid = r.group_id;
    if (!byGroup.has(gid)) byGroup.set(gid, []);
    byGroup.get(gid).push(r);
  }

  const activePlanIds = [];
  for (const [, groupEntitlements] of byGroup.entries()) {
    const isExclusive = Number(groupEntitlements[0]?.is_exclusive) === 1;
    if (isExclusive) {
      // 互斥组：只取 level 最高的
      const best = groupEntitlements.reduce((a, b) => (Number(b.level) > Number(a.level) ? b : a));
      activePlanIds.push(best.plan_id);
    } else {
      // 非互斥组：全部加入
      groupEntitlements.forEach((e) => activePlanIds.push(e.plan_id));
    }
  }

  return [...new Set(activePlanIds)];
}

async function getAllowedNodeIdsForUser(userId, activePlanIds) {
  if (!activePlanIds || activePlanIds.length === 0) return [];
  const [rows] = await pool.query(
    `SELECT DISTINCT pn.node_id
     FROM plan_nodes pn
     WHERE pn.plan_id IN (${activePlanIds.map(() => '?').join(',')})`,
    activePlanIds
  );
  return rows.map((r) => r.node_id);
}

async function getAllowedUUIDsForNode(nodeId) {
  // 先找可能用户（具备有效权益且绑定该节点）
  const [userRows] = await pool.query(
    `SELECT DISTINCT e.user_id
     FROM user_entitlements e
     JOIN plan_nodes pn ON pn.plan_id = e.plan_id
     JOIN users u ON u.id = e.user_id
     WHERE e.status = 'active'
       AND e.service_expire_at > NOW()
       AND (e.traffic_total_bytes < 0 OR e.traffic_used_bytes < e.traffic_total_bytes)
       AND pn.node_id = ?
       AND u.status = 'active'`,
    [nodeId]
  );

  const allowed = [];
  for (const ur of userRows) {
    const userId = ur.user_id;
    const activePlanIds = await getActivePlanIdsForUser(userId);
    if (activePlanIds.length === 0) continue;
    const allowedNodeIds = await getAllowedNodeIdsForUser(userId, activePlanIds);
    if (!allowedNodeIds.includes(nodeId)) continue;

    const [uuidRows] = await pool.query(
      'SELECT uuid FROM user_clients WHERE user_id = ? AND enabled = 1 ORDER BY id ASC LIMIT 1',
      [userId]
    );
    if (uuidRows.length === 0) continue;
    allowed.push(uuidRows[0].uuid);
  }

  return allowed;
}

async function upsertNode(connection, { name, address, port, protocol, config, status = 1, sort_order = 0, plan_ids }) {
  const portNum = Number(port);
  const configStr = typeof config === 'string' ? config : JSON.stringify(config);

  const [existing] = await connection.query(
    'SELECT id FROM nodes WHERE address = ? AND port = ? AND protocol = ? LIMIT 1',
    [address, portNum, protocol]
  );

  let nodeId;
  let created = false;
  if (existing.length > 0) {
    nodeId = existing[0].id;
    await connection.query(
      `UPDATE nodes
       SET name = ?, config = ?, status = ?, sort_order = ?, updated_at = NOW()
       WHERE id = ?`,
      [name, configStr, status, sort_order, nodeId]
    );
  } else {
    const [result] = await connection.query(
      `INSERT INTO nodes
         (name, address, port, protocol, config, status, sort_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
      [name, address, portNum, protocol, configStr, status, sort_order]
    );
    nodeId = result.insertId;
    created = true;
  }

  if (Array.isArray(plan_ids)) {
    await connection.query('DELETE FROM plan_nodes WHERE node_id = ?', [nodeId]);
    if (plan_ids.length > 0) {
      const placeholders = plan_ids.map(() => '(?, ?, ?)').join(',');
      const flatValues = plan_ids.flatMap((pid) => [pid, nodeId, 0]);
      await connection.query(
        `INSERT INTO plan_nodes (plan_id, node_id, priority) VALUES ${placeholders}`,
        flatValues
      );
    }
  }

  return { nodeId, created };
}

// 1) 面板主动拉取节点 agent 信息并创建节点（真正“一键绑定”）
// POST /api/admin/node-agent/import
// body: { agent_url, agent_token, plan_ids? }
router.post('/node-agent/import', async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const { agent_url, agent_token, plan_ids } = req.body || {};
    if (!agent_url || !agent_token) {
      connection.release();
      return res.status(400).json({ code: 400, message: 'agent_url / agent_token 必填', data: null });
    }

    const url = String(agent_url).replace(/\/+$/, '') + '/v1/node-info';
    let text = '';
    let info;
    try {
      const r = await fetch(url, {
        headers: { 'x-agent-token': agent_token }
      });
      text = await r.text();
      if (!r.ok) {
        const status = r.status || 0;
        // node-agent 使用 BaseHTTPRequestHandler.send_error 时会返回 HTML（403/404），这里做可读化提示
        if (status === 403) {
          connection.release();
          return res.status(400).json({
            code: 400,
            message: '拉取 agent 失败：403 forbidden（agent_token 不正确或不匹配，请使用节点脚本输出的最新导入码/agent_token）',
            data: null
          });
        }
        const short = String(text || '').replace(/\s+/g, ' ').slice(0, 160);
        connection.release();
        return res.status(400).json({
          code: 400,
          message: `拉取 agent 失败：HTTP ${status}（${short || 'empty body'}）`,
          data: null
        });
      }
      try {
        info = JSON.parse(text);
      } catch (e) {
        connection.release();
        return res.status(400).json({ code: 400, message: 'agent 返回不是 JSON: ' + text.slice(0, 200), data: null });
      }
    } catch (e) {
      connection.release();
      return res.status(400).json({
        code: 400,
        message: '无法连接 agent（请检查节点公网 IP/端口、安全组/防火墙、node-agent 服务是否启动）：' + (e?.message || String(e)),
        data: null
      });
    }
    const nodes = Array.isArray(info.nodes) ? info.nodes : [];
    if (nodes.length === 0) {
      connection.release();
      return res.status(400).json({ code: 400, message: 'agent 未返回 nodes 列表', data: null });
    }

    await connection.beginTransaction();

    const results = [];
    for (const n of nodes) {
      const payload = {
        ...n,
        plan_ids: Array.isArray(plan_ids) ? plan_ids : undefined
      };
      const { nodeId, created } = await upsertNode(connection, payload);
      results.push({ id: nodeId, created, protocol: payload.protocol, port: payload.port, address: payload.address });
    }

    await connection.commit();
    connection.release();

    res.json({ code: 200, message: 'success', data: { imported: results } });
  } catch (err) {
    await connection.rollback();
    connection.release();
    next(err);
  }
});

// 2) 面板主动推送“允许 UUID 列表”到节点 agent（真正“强行断网”）
// POST /api/admin/node-agent/push-uuids
// body: { agent_url, agent_token, node_id }
router.post('/node-agent/push-uuids', async (req, res, next) => {
  try {
    const { agent_url, agent_token, node_id } = req.body || {};
    const nodeId = Number(node_id);
    if (!agent_url || !agent_token || !nodeId) {
      return res.status(400).json({ code: 400, message: 'agent_url / agent_token / node_id 必填', data: null });
    }

    const uuids = await getAllowedUUIDsForNode(nodeId);
    const url = String(agent_url).replace(/\/+$/, '') + '/v1/apply-users';
    let text = '';
    let resp;
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-agent-token': agent_token
        },
        body: JSON.stringify({ uuids })
      });
      text = await r.text();
      if (!r.ok) {
        return res.status(400).json({ code: 400, message: '推送失败: ' + text, data: null });
      }
      try {
        resp = JSON.parse(text);
      } catch (e) {
        return res.status(400).json({ code: 400, message: 'agent 返回不是 JSON: ' + text.slice(0, 200), data: null });
      }
    } catch (e) {
      return res.status(400).json({
        code: 400,
        message: '无法连接 agent（请检查节点公网 IP/端口、安全组/防火墙、node-agent 服务是否启动）：' + (e?.message || String(e)),
        data: null
      });
    }
    res.json({ code: 200, message: 'success', data: { pushed: uuids.length, agent: resp } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

