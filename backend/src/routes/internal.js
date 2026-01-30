const express = require('express');
const crypto = require('crypto');
const pool = require('../config/db');

const router = express.Router();

function requireInternalToken(req, res, next) {
  const token = req.headers['x-internal-token'];
  const expected = process.env.INTERNAL_API_KEY || '';
  if (!expected || token !== expected) {
    return res.status(403).json({
      code: 403,
      message: 'forbidden',
      data: null
    });
  }
  next();
}

// 刷新用户权益状态（请求时兜底：自动更新 expired/exhausted 状态）
async function refreshUserEntitlementStatus(userId) {
  // 更新已过期的权益
  await pool.query(
    `UPDATE user_entitlements 
     SET status = 'expired'
     WHERE user_id = ? 
       AND status = 'active'
       AND service_expire_at <= NOW()`
  );
  
  // 更新已耗尽的权益
  await pool.query(
    `UPDATE user_entitlements 
     SET status = 'exhausted'
     WHERE user_id = ?
       AND status = 'active'
       AND traffic_total_bytes > 0
       AND traffic_used_bytes >= traffic_total_bytes`
  );
}

// 获取用户「有效」的 plan_id 列表（从 user_entitlements 读取，考虑套餐互斥：互斥组内只认 level 最高的一条）
async function getActivePlanIdsForUser(userId) {
  // 先刷新状态（请求时兜底）
  await refreshUserEntitlementStatus(userId);
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

async function getOrCreateUserUuid(userId) {
  const [rows] = await pool.query(
    'SELECT uuid FROM user_clients WHERE user_id = ? AND enabled = 1 ORDER BY id ASC LIMIT 1',
    [userId]
  );
  if (rows.length > 0) return rows[0].uuid;
  const uuid = crypto.randomUUID();
  await pool.query(
    'INSERT INTO user_clients (user_id, uuid, remark, enabled) VALUES (?, ?, ?, 1)',
    [userId, uuid, 'default']
  );
  return uuid;
}

// GET /api/internal/auth?uuid=...&node_id=...
// 供“对接程序”在新连接/定时检查时使用：返回 allow/deny
router.get('/auth', requireInternalToken, async (req, res, next) => {
  try {
    const uuid = (req.query.uuid || '').trim();
    const nodeId = req.query.node_id ? Number(req.query.node_id) : null;

    if (!uuid) {
      return res.status(400).json({ code: 400, message: 'uuid required', data: null });
    }

    const [rows] = await pool.query(
      `SELECT uc.user_id, uc.enabled,
              u.status, u.traffic_total, u.traffic_used
       FROM user_clients uc
       JOIN users u ON u.id = uc.user_id
       WHERE uc.uuid = ?
       LIMIT 1`,
      [uuid]
    );

    if (rows.length === 0) {
      return res.json({ code: 200, message: 'success', data: { allow: false, reason: 'uuid_not_found' } });
    }

    const info = rows[0];
    if (!info.enabled) {
      return res.json({ code: 200, message: 'success', data: { allow: false, reason: 'uuid_disabled' } });
    }
    if (info.status !== 'active') {
      return res.json({ code: 200, message: 'success', data: { allow: false, reason: 'user_banned' } });
    }
    
    // 流量检查：从 entitlements 检查是否有可用权益
    const [entitlementCheck] = await pool.query(
      `SELECT COUNT(*) AS count
       FROM user_entitlements
       WHERE user_id = ?
         AND status = 'active'
         AND service_expire_at > NOW()
         AND (traffic_total_bytes < 0 OR traffic_used_bytes < traffic_total_bytes)
       LIMIT 1`,
      [info.user_id]
    );
    
    if (entitlementCheck.length === 0 || Number(entitlementCheck[0].count) === 0) {
      return res.json({ code: 200, message: 'success', data: { allow: false, reason: 'traffic_exceeded' } });
    }

    const activePlanIds = await getActivePlanIdsForUser(info.user_id);
    if (activePlanIds.length === 0) {
      return res.json({ code: 200, message: 'success', data: { allow: false, reason: 'no_active_plan' } });
    }

    // 可选：校验该 uuid 是否有权使用指定节点
    if (nodeId) {
      const allowedNodeIds = await getAllowedNodeIdsForUser(info.user_id, activePlanIds);
      if (!allowedNodeIds.includes(nodeId)) {
        return res.json({ code: 200, message: 'success', data: { allow: false, reason: 'node_not_allowed' } });
      }
    }

    return res.json({
      code: 200,
      message: 'success',
      data: {
        allow: true,
        user_id: info.user_id,
        active_plan_ids: activePlanIds
      }
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/internal/nodes/:nodeId/allowed-uuids
// 供“对接程序”周期性同步 Xray inbound users：只下发允许的 UUID 列表
router.get('/nodes/:nodeId/allowed-uuids', requireInternalToken, async (req, res, next) => {
  try {
    const nodeId = Number(req.params.nodeId);
    if (!nodeId) {
      return res.status(400).json({ code: 400, message: 'nodeId invalid', data: null });
    }

    // 先找能用该节点的所有用户（具备 paid 订单；再在 JS 里按周期叠加计算是否仍有效）
    const [userRows] = await pool.query(
      `SELECT DISTINCT o.user_id
       FROM orders o
       JOIN plan_nodes pn ON pn.plan_id = o.plan_id
       JOIN users u ON u.id = o.user_id
       WHERE o.status = 'paid'
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

      // 流量检查：从 entitlements 检查是否有可用权益
      const [entitlementCheck] = await pool.query(
        `SELECT COUNT(*) AS count
         FROM user_entitlements
         WHERE user_id = ?
           AND status = 'active'
           AND service_expire_at > NOW()
           AND (traffic_total_bytes < 0 OR traffic_used_bytes < traffic_total_bytes)
         LIMIT 1`,
        [userId]
      );
      
      if (entitlementCheck.length === 0 || Number(entitlementCheck[0].count) === 0) continue;

      const uuid = await getOrCreateUserUuid(userId);
      allowed.push(uuid);
    }

    res.json({
      code: 200,
      message: 'success',
      data: {
        node_id: nodeId,
        uuids: allowed
      }
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/internal/report-traffic
// body: { uuid, node_id, upload, download }
// 说明：
// - 节点侧建议每 60 秒上报一次“增量流量”（该分钟内的 upload/download 字节数）
// - 面板会：
//   1) 累加到 users.traffic_used
//   2) 写入 node_traffic（按天聚合）
//   3) 写入 user_traffic_minute（按分钟聚合，供总览图表/近24小时查询使用）
router.post('/report-traffic', requireInternalToken, async (req, res, next) => {
  try {
    const uuid = (req.body.uuid || '').trim();
    const nodeId = req.body.node_id ? Number(req.body.node_id) : null;
    const upload = Number(req.body.upload || 0);
    const download = Number(req.body.download || 0);
    const total = Math.max(0, upload) + Math.max(0, download);

    if (!uuid || !nodeId) {
      return res.status(400).json({ code: 400, message: 'uuid and node_id required', data: null });
    }
    if (!Number.isFinite(total) || total <= 0) {
      return res.status(400).json({ code: 400, message: 'upload/download invalid', data: null });
    }

    const [rows] = await pool.query(
      'SELECT user_id FROM user_clients WHERE uuid = ? AND enabled = 1 LIMIT 1',
      [uuid]
    );
    if (rows.length === 0) {
      return res.status(404).json({ code: 404, message: 'uuid not found', data: null });
    }

    const userId = rows[0].user_id;

    // 1) 累加用户已用流量（用于统计）
    await pool.query(
      'UPDATE users SET traffic_used = traffic_used + ? WHERE id = ?',
      [total, userId]
    );

    // 1.1) 按策略分摊流量到 entitlements（仅扣“当前节点允许的权益”，优先消耗最早 service_expire_at）
    const [entitlementRows] = await pool.query(
      `SELECT e.id, e.plan_id, e.traffic_total_bytes, e.traffic_used_bytes, e.service_expire_at
       FROM user_entitlements e
       JOIN plan_nodes pn ON pn.plan_id = e.plan_id AND pn.node_id = ?
       WHERE e.user_id = ? AND e.status = 'active'
         AND e.service_expire_at > NOW()
         AND (e.traffic_total_bytes < 0 OR e.traffic_used_bytes < e.traffic_total_bytes)
       ORDER BY e.service_expire_at ASC, e.id ASC`,
      [nodeId, userId]
    );

    if (entitlementRows.length === 0) {
      // 没有任何可用于该节点的权益：直接拒绝（避免把流量扣到其他套餐上）
      return res.status(403).json({ code: 403, message: 'no_entitlement_for_node', data: null });
    }

    let remainingTraffic = total;
    for (const e of entitlementRows) {
      if (remainingTraffic <= 0) break;
      
      // 计算该权益的可用流量
      const availableTraffic = e.traffic_total_bytes < 0 
        ? Number.MAX_SAFE_INTEGER 
        : Math.max(0, Number(e.traffic_total_bytes || 0) - Number(e.traffic_used_bytes || 0));
      
      if (availableTraffic <= 0) continue;
      
      // 消耗该权益的流量
      const consumeAmount = Math.min(remainingTraffic, availableTraffic);
      await pool.query(
        'UPDATE user_entitlements SET traffic_used_bytes = traffic_used_bytes + ? WHERE id = ?',
        [consumeAmount, e.id]
      );
      
      remainingTraffic -= consumeAmount;
      
      // 检查是否已耗尽，如果是则更新状态为 exhausted
      if (e.traffic_total_bytes >= 0) {
        const [updated] = await pool.query(
          `SELECT traffic_used_bytes, traffic_total_bytes 
           FROM user_entitlements 
           WHERE id = ?`,
          [e.id]
        );
        if (updated.length > 0 && updated[0].traffic_used_bytes >= updated[0].traffic_total_bytes) {
          await pool.query(
            'UPDATE user_entitlements SET status = ? WHERE id = ?',
            ['exhausted', e.id]
          );
        }
      }
    }

    // 2) 累加节点每日流量
    await pool.query(
      `INSERT INTO node_traffic (node_id, date, upload, download, connections)
       VALUES (?, CURDATE(), ?, ?, 1)
       ON DUPLICATE KEY UPDATE
         upload = upload + VALUES(upload),
         download = download + VALUES(download),
         connections = connections + 1`,
      [nodeId, Math.max(0, upload), Math.max(0, download)]
    );

    // 3) 记录用户分钟级流量（按当前时间所在分钟聚合）
    //    使用 MySQL 计算当前分钟起始时间：FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP()/60)*60)
    await pool.query(
      `INSERT INTO user_traffic_minute (user_id, ts_minute, upload, download)
       VALUES (?, FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP()/60)*60), ?, ?)
       ON DUPLICATE KEY UPDATE
         upload = upload + VALUES(upload),
         download = download + VALUES(download)`,
      [userId, Math.max(0, upload), Math.max(0, download)]
    );

    res.json({ code: 200, message: 'success', data: null });
  } catch (err) {
    next(err);
  }
});

// GET /api/internal/user-traffic?uuid=...
// 用于节点机按键面板查询某个 UUID 对应用户的流量使用情况
router.get('/user-traffic', requireInternalToken, async (req, res, next) => {
  try {
    const uuid = (req.query.uuid || '').trim();
    if (!uuid) {
      return res.status(400).json({ code: 400, message: 'uuid required', data: null });
    }

    const [rows] = await pool.query(
      `SELECT u.id AS user_id,
              u.traffic_total,
              u.traffic_used,
              u.status
       FROM user_clients uc
       JOIN users u ON u.id = uc.user_id
       WHERE uc.uuid = ?
         AND uc.enabled = 1
       LIMIT 1`,
      [uuid]
    );

    if (rows.length === 0) {
      return res.status(404).json({ code: 404, message: 'uuid not found', data: null });
    }

    const info = rows[0];

    // 近 24 小时的分钟级汇总（可选）
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [aggRows] = await pool.query(
      `SELECT
         COALESCE(SUM(upload), 0)   AS upload_24h,
         COALESCE(SUM(download), 0) AS download_24h
       FROM user_traffic_minute
       WHERE user_id = ?
         AND ts_minute >= ?`,
      [info.user_id, since]
    );

    const agg = aggRows[0] || { upload_24h: 0, download_24h: 0 };

    res.json({
      code: 200,
      message: 'success',
      data: {
        user_id: info.user_id,
        status: info.status,
        traffic_total: Number(info.traffic_total || 0),
        traffic_used: Number(info.traffic_used || 0),
        upload_24h: Number(agg.upload_24h || 0),
        download_24h: Number(agg.download_24h || 0)
      }
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/internal/register-node
// 供“一键开局脚本”注册节点到面板（无需登录后台，只需 internal token）
// body: { name, address, port, protocol, config, status?, sort_order?, plan_ids? }
router.post('/register-node', requireInternalToken, async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const {
      name,
      address,
      port,
      protocol,
      config,
      status = 1,
      sort_order = 0,
      plan_ids
    } = req.body || {};

    if (!name || !address || !port || !protocol || config === undefined) {
      connection.release();
      return res.status(400).json({
        code: 400,
        message: 'name、address、port、protocol、config 为必填',
        data: null
      });
    }

    const portNum = Number(port);
    if (!Number.isFinite(portNum) || portNum <= 0 || portNum > 65535) {
      connection.release();
      return res.status(400).json({
        code: 400,
        message: 'port 无效',
        data: null
      });
    }

    const configStr = typeof config === 'string' ? config : JSON.stringify(config);

    await connection.beginTransaction();

    // 简单幂等：address + port + protocol 相同则视为同一节点，进行更新
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

    // 可选：绑定套餐
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

    await connection.commit();
    connection.release();

    res.json({
      code: 200,
      message: 'success',
      data: {
        id: nodeId,
        created
      }
    });
  } catch (err) {
    await connection.rollback();
    connection.release();
    next(err);
  }
});

module.exports = router;

