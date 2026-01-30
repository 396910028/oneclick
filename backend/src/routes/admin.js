const express = require('express');
const pool = require('../config/db');
const auth = require('../middleware/auth');
const adminOnly = require('../middleware/admin');

const router = express.Router();

// 所有 /api/admin/* 接口都需要登录 + 管理员权限
router.use(auth, adminOnly);

// 从 system_settings 或 env 读取网站地址（用于分享/订阅 URL）
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

/* ========================
 * 1. 用户管理 /api/admin/users
 * ====================== */

// GET /api/admin/users 列表
router.get('/users', async (req, res, next) => {
  try {
    const {
      page = 1,
      size = 20,
      keyword = ''
    } = req.query;

    const limit = Number(size) || 20;
    const offset = (Number(page) - 1) * limit;

    const conditions = ['1=1'];
    const params = [];

    if (keyword) {
      conditions.push('(username LIKE ? OR email LIKE ?)');
      params.push(`%${keyword}%`, `%${keyword}%`);
    }

    const where = conditions.join(' AND ');

    const [rows] = await pool.query(
      `SELECT id,
              email,
              username,
              role,
              status,
              balance
       FROM users
       WHERE ${where}
       ORDER BY id DESC
       LIMIT ?, ?`,
      [...params, offset, limit]
    );

    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total FROM users WHERE ${where}`,
      params
    );

    // 为每个用户查询当前有效套餐（多个）及到期时间，拼成 current_plan_display
    const userIds = rows.map((r) => r.id);
    if (userIds.length > 0) {
      const placeholders = userIds.map(() => '?').join(',');
      const [orderRows] = await pool.query(
        `SELECT o.user_id,
                p.name AS plan_name,
                pg.name AS group_name,
                o.paid_at,
                o.duration_days,
                DATE_ADD(o.paid_at, INTERVAL o.duration_days DAY) AS expired_at
         FROM orders o
         JOIN plans p ON p.id = o.plan_id
         JOIN plan_groups pg ON pg.id = p.group_id
         WHERE o.user_id IN (${placeholders}) AND o.status = 'paid'
           AND o.paid_at IS NOT NULL AND o.duration_days > 0
           AND DATE_ADD(o.paid_at, INTERVAL o.duration_days DAY) > NOW()
         ORDER BY o.user_id, o.paid_at DESC`,
        userIds
      );
      const byUser = new Map();
      for (const o of orderRows) {
        if (!byUser.has(o.user_id)) byUser.set(o.user_id, []);
        const label = o.group_name ? `${o.group_name} - ${o.plan_name}` : o.plan_name;
        const expStr = o.expired_at ? new Date(o.expired_at).toISOString().slice(0, 10) : '';
        byUser.get(o.user_id).push(expStr ? `${label} (至${expStr})` : label);
      }
      for (const u of rows) {
        const plans = byUser.get(u.id) || [];
        u.current_plan_display = plans.length ? plans.join('、') : '-';
      }
    } else {
      for (const u of rows) u.current_plan_display = '-';
    }

    res.json({
      code: 200,
      message: 'success',
      data: {
        list: rows,
        total: countRows[0].total,
        page: Number(page),
        size: limit
      }
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/users/:id 用户详情（注册时间、当前套餐、套餐激活时间、余额、分享URL、UUID）
router.get('/users/:id', async (req, res, next) => {
  try {
    const userId = Number(req.params.id);
    if (!userId) {
      return res.status(400).json({ code: 400, message: 'id invalid', data: null });
    }

    const [userRows] = await pool.query(
      `SELECT id, username, email, role, status, balance, traffic_total, traffic_used, expired_at, created_at
       FROM users WHERE id = ? LIMIT 1`,
      [userId]
    );
    if (userRows.length === 0) {
      return res.status(404).json({ code: 404, message: '用户不存在', data: null });
    }

    const user = userRows[0];

    // 从subscriptions表获取UUID（与订阅token绑定）
    let share_url = null;
    let userUuid = null;
    const [subRows] = await pool.query(
      'SELECT token, uuid FROM subscriptions WHERE user_id = ? LIMIT 1',
      [userId]
    );
    if (subRows.length > 0 && subRows[0].token) {
      userUuid = subRows[0].uuid || null;
      const baseUrl = await getPanelPublicUrl(req);
      if (baseUrl) {
        share_url = `${baseUrl.replace(/\/$/, '')}/api/sub/${subRows[0].token}`;
      }
    }
    
    // 如果没有UUID，也从user_clients表获取（兼容旧数据）
    const [uuidRows] = await pool.query(
      'SELECT uuid, remark, enabled, created_at FROM user_clients WHERE user_id = ? ORDER BY id ASC',
      [userId]
    );
    
    // 优先使用subscriptions表中的UUID
    const uuids = [];
    if (userUuid) {
      uuids.push({ uuid: userUuid, remark: '订阅UUID', enabled: true });
    }
    // 补充user_clients中的UUID（如果存在且不同）
    for (const r of uuidRows) {
      if (r.uuid !== userUuid) {
        uuids.push({ uuid: r.uuid, remark: r.remark || '客户端UUID', enabled: !!r.enabled });
      }
    }

    const [orderRows] = await pool.query(
      `SELECT o.id, o.plan_id, o.paid_at, o.duration_days, o.status, p.name AS plan_name, pg.name AS group_name
       FROM orders o
       JOIN plans p ON p.id = o.plan_id
       JOIN plan_groups pg ON pg.id = p.group_id
       WHERE o.user_id = ? AND o.status = 'paid'
       ORDER BY o.paid_at DESC, o.id DESC
       LIMIT 50`,
      [userId]
    );

    const now = new Date();
    // 检查用户的expired_at，如果已过期则不应显示当前套餐
    const userExpiredAt = user.expired_at ? new Date(user.expired_at) : null;
    const isUserExpired = userExpiredAt && userExpiredAt <= now;
    
    const currentPlans = [];
    // 如果用户已过期，不显示任何当前套餐
    if (!isUserExpired) {
      for (const o of orderRows) {
        const paidAt = o.paid_at ? new Date(o.paid_at) : null;
        const durationDays = Number(o.duration_days || 0);
        if (!paidAt || durationDays <= 0) continue;
        const expire = new Date(paidAt.getTime() + durationDays * 24 * 60 * 60 * 1000);
        if (expire > now) {
          currentPlans.push({
            plan_name: o.plan_name,
            group_name: o.group_name,
            display: o.group_name ? `${o.group_name} - ${o.plan_name}` : o.plan_name,
            expired_at: expire.toISOString ? expire.toISOString().slice(0, 19) : expire
          });
        }
      }
    }

    res.json({
      code: 200,
      message: 'success',
      data: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        status: user.status,
        balance: user.balance,
        traffic_total: user.traffic_total,
        traffic_used: user.traffic_used,
        expired_at: user.expired_at,
        created_at: user.created_at,
        current_plans: currentPlans,
        uuids: uuids,
        share_url
      }
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/users/:id 更新用户信息（角色/状态/余额/到期时间/流量限制）
router.patch('/users/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status, role, balance, expired_at, traffic_total, traffic_used } = req.body;

    const fields = [];
    const params = [];

    // 不允许管理员把自己设为停用，避免把自己踢出系统
    const targetId = Number(id);
    const currentAdminId = req.user.id;
    if (status === 'banned' && targetId === currentAdminId) {
      return res.status(400).json({
        code: 400,
        message: '不能停用当前登录的管理员账号',
        data: null
      });
    }

    if (status) {
      fields.push('status = ?');
      params.push(status);
    }
    if (role) {
      fields.push('role = ?');
      params.push(role);
    }
    if (balance !== undefined) {
      fields.push('balance = ?');
      params.push(balance);
    }
    if (expired_at !== undefined) {
      fields.push('expired_at = ?');
      params.push(expired_at || null);
    }
    if (traffic_total !== undefined) {
      fields.push('traffic_total = ?');
      params.push(traffic_total);
    }
    if (traffic_used !== undefined) {
      fields.push('traffic_used = ?');
      params.push(traffic_used);
    }

    if (fields.length === 0) {
      return res.status(400).json({
        code: 400,
        message: '没有可更新的字段',
        data: null
      });
    }

    params.push(id);

    const [result] = await pool.query(
      `UPDATE users SET ${fields.join(', ')} WHERE id = ?`,
      params
    );

    res.json({
      code: 200,
      message: '用户信息已更新',
      data: { affectedRows: result.affectedRows }
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/users/:id/remaining 获取用户剩余天数和流量（用于退订）
router.get('/users/:id/remaining', async (req, res, next) => {
  try {
    const userId = Number(req.params.id);
    if (!userId) {
      return res.status(400).json({ code: 400, message: '用户 id 无效', data: null });
    }

    // 获取用户当前所有已支付订单（购买和退订）
    const [orderRows] = await pool.query(
      `SELECT o.id, o.plan_id, o.order_type, o.paid_at, o.duration_days, o.traffic_amount, o.status,
              p.name AS plan_name, pg.name AS group_name, pg.id AS group_id
       FROM orders o
       JOIN plans p ON o.plan_id = p.id
       JOIN plan_groups pg ON p.group_id = pg.id
       WHERE o.user_id = ? AND o.status = 'paid' AND o.paid_at IS NOT NULL
       ORDER BY o.paid_at ASC, o.id ASC`,
      [userId]
    );

    if (orderRows.length === 0) {
      return res.json({
        code: 200,
        message: 'success',
        data: {
          remaining_days: 0,
          remaining_traffic_bytes: 0,
          remaining_traffic_gb: '0.00',
          current_plan: null,
          can_unsubscribe: false
        }
      });
    }

    // 计算剩余天数和流量
    const [userRows] = await pool.query(
      'SELECT traffic_total, traffic_used, expired_at FROM users WHERE id = ? LIMIT 1',
      [userId]
    );
    const user = userRows[0];
    const userTrafficTotal = Number(user.traffic_total || 0);
    const userTrafficUsed = Number(user.traffic_used || 0);
    const remainingTraffic = Math.max(0, userTrafficTotal - userTrafficUsed);

    // 计算剩余天数（从最早订单开始累加）
    let totalDays = 0;
    let earliestPaidAt = null;
    for (const o of orderRows) {
      const paidAt = new Date(o.paid_at);
      if (!earliestPaidAt || paidAt < earliestPaidAt) {
        earliestPaidAt = paidAt;
      }
      totalDays += Number(o.duration_days || 0);
    }
    const now = new Date();
    const expireAt = earliestPaidAt ? new Date(earliestPaidAt.getTime() + totalDays * 24 * 60 * 60 * 1000) : null;
    const remainingDays = expireAt && expireAt > now ? Math.max(0, Math.floor((expireAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))) : 0;

    res.json({
      code: 200,
      message: 'success',
      data: {
        remaining_days: remainingDays,
        remaining_traffic_bytes: remainingTraffic,
        remaining_traffic_gb: (remainingTraffic / (1024 ** 3)).toFixed(2),
        current_plan: orderRows.length > 0 ? {
          group_id: orderRows[0].group_id,
          group_name: orderRows[0].group_name,
          plan_name: orderRows[0].plan_name
        } : null,
        can_unsubscribe: remainingDays > 0 || remainingTraffic > 0
      }
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/users/:id/unsubscribe 退订：扣减该用户时长与流量（写入一条负值订单并更新用户）
router.post('/users/:id/unsubscribe', async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const userId = Number(req.params.id);
    const { plan_id, duration_days_deduct = 0, traffic_gb_deduct = 0, remark = '', full_refund = false } = req.body;

    if (!userId) {
      connection.release();
      return res.status(400).json({ code: 400, message: '用户 id 无效', data: null });
    }

    const daysDeduct = Math.max(0, Number(duration_days_deduct) || 0);
    const gbDeduct = Math.max(0, Number(traffic_gb_deduct) || 0);
    const trafficBytesDeduct = Math.round(gbDeduct * 1073741824);

    if (!full_refund && daysDeduct <= 0 && trafficBytesDeduct <= 0) {
      connection.release();
      return res.status(400).json({
        code: 400,
        message: '请填写扣减天数或扣减流量（GB）至少一项，或选择全额退订',
        data: null
      });
    }

    // 获取用户当前套餐剩余
    const [orderRows] = await connection.query(
      `SELECT o.id, o.plan_id, o.order_type, o.paid_at, o.duration_days, o.traffic_amount, o.status,
              p.name AS plan_name, pg.name AS group_name, pg.id AS group_id
       FROM orders o
       JOIN plans p ON o.plan_id = p.id
       JOIN plan_groups pg ON p.group_id = pg.id
       WHERE o.user_id = ? AND o.status = 'paid' AND o.paid_at IS NOT NULL
       ORDER BY o.paid_at ASC, o.id ASC`,
      [userId]
    );

    if (orderRows.length === 0) {
      connection.release();
      return res.status(400).json({
        code: 400,
        message: '该用户当前没有生效的套餐',
        data: null
      });
    }

    // 计算剩余天数和流量
    const [userRows] = await connection.query(
      'SELECT traffic_total, traffic_used, expired_at FROM users WHERE id = ? LIMIT 1',
      [userId]
    );
    const user = userRows[0];
    const userTrafficTotal = Number(user.traffic_total || 0);
    const userTrafficUsed = Number(user.traffic_used || 0);
    const remainingTraffic = Math.max(0, userTrafficTotal - userTrafficUsed);

    // 计算剩余天数（从最早订单开始累加）
    let totalDays = 0;
    let earliestPaidAt = null;
    for (const o of orderRows) {
      const paidAt = new Date(o.paid_at);
      if (!earliestPaidAt || paidAt < earliestPaidAt) {
        earliestPaidAt = paidAt;
      }
      totalDays += Number(o.duration_days || 0);
    }
    const now = new Date();
    const expireAt = earliestPaidAt ? new Date(earliestPaidAt.getTime() + totalDays * 24 * 60 * 60 * 1000) : null;
    const remainingDays = expireAt && expireAt > now ? Math.max(0, Math.floor((expireAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))) : 0;

    let finalDaysDeduct = daysDeduct;
    let finalTrafficDeduct = trafficBytesDeduct;

    if (full_refund) {
      finalDaysDeduct = remainingDays;
      finalTrafficDeduct = remainingTraffic;
    } else {
      // 检查是否超限
      if (finalDaysDeduct > remainingDays) {
        connection.release();
        return res.status(400).json({
          code: 400,
          message: `扣减天数（${finalDaysDeduct}）超过剩余天数（${remainingDays}），无法退订`,
          data: null
        });
      }
      if (finalTrafficDeduct > remainingTraffic) {
        connection.release();
        return res.status(400).json({
          code: 400,
          message: `扣减流量（${(finalTrafficDeduct / (1024 ** 3)).toFixed(2)} GB）超过剩余流量（${(remainingTraffic / (1024 ** 3)).toFixed(2)} GB），无法退订`,
          data: null
        });
      }
    }

    await connection.beginTransaction();

    const planId = plan_id ? Number(plan_id) : orderRows[0].plan_id;
    const orderNo = `UNSUB${Date.now()}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`;
    await connection.query(
      `INSERT INTO orders
       (user_id, plan_id, order_no, amount, pay_method, status, order_type, duration_days, traffic_amount, remark, created_at, paid_at)
       VALUES (?, ?, ?, 0, 'balance', 'paid', 'unsubscribe', ?, ?, ?, NOW(), NOW())`,
      [userId, planId, orderNo, -finalDaysDeduct, -finalTrafficDeduct, (remark || '').slice(0, 255)]
    );

    // 扣减流量（不退订时不改变到期时间）
    if (finalTrafficDeduct > 0) {
      await connection.query(
        'UPDATE users SET traffic_total = GREATEST(0, traffic_total - ?) WHERE id = ?',
        [finalTrafficDeduct, userId]
      );
    }

    // 检查是否全额退订或超限，如果是则剔出套餐（设置 expired_at 为当前时间）
    const shouldRemovePlan = full_refund || finalDaysDeduct >= remainingDays || finalTrafficDeduct >= remainingTraffic;
    if (shouldRemovePlan) {
      await connection.query(
        'UPDATE users SET expired_at = NOW() WHERE id = ?',
        [userId]
      );
    }

    await connection.commit();
    connection.release();

    res.json({
      code: 200,
      message: shouldRemovePlan ? '全额退订已生效，套餐已失效' : '退订已生效，已扣减流量',
      data: {
        order_no: orderNo,
        removed_from_plan: shouldRemovePlan
      }
    });
  } catch (err) {
    try {
      await connection.rollback();
    } catch (e) {
      // ignore
    }
    connection.release();
    next(err);
  }
});

// DELETE /api/admin/users/:id 删除用户（不能删除自己；会级联删除其订单、工单等）
router.delete('/users/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = Number(id);
    const adminId = req.user.id;

    if (userId === adminId) {
      return res.status(400).json({
        code: 400,
        message: '不能删除当前登录的管理员账号',
        data: null
      });
    }

    const [result] = await pool.query('DELETE FROM users WHERE id = ?', [userId]);

    if (result.affectedRows === 0) {
      return res.status(404).json({
        code: 404,
        message: '用户不存在',
        data: null
      });
    }

    res.json({
      code: 200,
      message: '用户已删除',
      data: { affectedRows: result.affectedRows }
    });
  } catch (err) {
    next(err);
  }
});

/* ========================
 * 2.1 总套餐管理 /api/admin/plan-groups
 * ====================== */

// GET /api/admin/plan-groups 列出全部总套餐
router.get('/plan-groups', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT id,
              group_key,
              name,
              level,
              is_exclusive,
              status,
              is_public,
              sort_order,
              connections,
              speed_limit,
              created_at,
              updated_at
       FROM plan_groups
       ORDER BY id ASC`
    );

    res.json({
      code: 200,
      message: 'success',
      data: rows
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/plan-groups 新增总套餐
router.post('/plan-groups', async (req, res, next) => {
  try {
    const {
      group_key,
      name,
      level = 0,
      is_exclusive = 0,
      status = 1,
      is_public = 1,
      connections = 1,
      speed_limit = 0
    } = req.body;

    if (!group_key || !name) {
      return res.status(400).json({
        code: 400,
        message: 'group_key 和 name 必填',
        data: null
      });
    }

    const levelNum = Number(level);
    if (Number.isNaN(levelNum)) {
      return res.status(400).json({
        code: 400,
        message: 'level 必须为数字',
        data: null
      });
    }

    const connNum = Number(connections);
    const speedNum = Number(speed_limit);
    const [result] = await pool.query(
      `INSERT INTO plan_groups
       (group_key, name, level, is_exclusive, status, is_public, sort_order, connections, speed_limit, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, NOW())`,
      [
        group_key,
        name,
        levelNum,
        is_exclusive ? 1 : 0,
        status,
        is_public ? 1 : 0,
        Number.isNaN(connNum) ? 1 : Math.max(1, connNum),
        Number.isNaN(speedNum) ? 0 : Math.max(0, speedNum)
      ]
    );

    res.json({
      code: 200,
      message: '总套餐创建成功',
      data: { id: result.insertId }
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({
        code: 400,
        message: 'group_key 已存在',
        data: null
      });
    }
    next(err);
  }
});

// PUT /api/admin/plan-groups/:id 更新总套餐
router.put('/plan-groups/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const allowedFields = ['group_key', 'name', 'level', 'is_exclusive', 'status', 'is_public', 'connections', 'speed_limit'];

    const fields = [];
    const params = [];

    for (const key of allowedFields) {
      if (req.body[key] !== undefined) {
        fields.push(`${key} = ?`);
        params.push(req.body[key]);
      }
    }

    if (fields.length === 0) {
      return res.status(400).json({
        code: 400,
        message: '没有可更新的字段',
        data: null
      });
    }

    params.push(id);

    const [result] = await pool.query(
      `UPDATE plan_groups SET ${fields.join(', ')} WHERE id = ?`,
      params
    );

    res.json({
      code: 200,
      message: '总套餐已更新',
      data: { affectedRows: result.affectedRows }
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/plan-groups/:id 删除总套餐（需先删除所有子套餐）
router.delete('/plan-groups/:id', async (req, res, next) => {
  try {
    const { id } = req.params;

    // 检查是否有子套餐
    const [childPlans] = await pool.query(
      'SELECT COUNT(*) AS count FROM plans WHERE group_id = ?',
      [id]
    );

    if (childPlans[0].count > 0) {
      return res.status(400).json({
        code: 400,
        message: '该总套餐下还有子套餐，请先删除所有子套餐',
        data: null
      });
    }

    const [result] = await pool.query('DELETE FROM plan_groups WHERE id = ?', [id]);

    res.json({
      code: 200,
      message: '总套餐已删除',
      data: { affectedRows: result.affectedRows }
    });
  } catch (err) {
    next(err);
  }
});

/* ========================
 * 2.2 子套餐管理 /api/admin/plans
 * ====================== */

// GET /api/admin/plans 列出全部子套餐（只返回子套餐，不返回总套餐）
router.get('/plans', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT p.id,
              p.group_id,
              p.name,
              p.description,
              p.price,
              p.duration_days,
              p.traffic_limit,
              p.speed_limit,
              p.connections,
              p.is_public,
              p.status,
              p.created_at,
              p.updated_at,
              pg.group_key,
              pg.name AS group_name,
              pg.level AS group_level,
              pg.is_exclusive AS group_is_exclusive
       FROM plans p
       JOIN plan_groups pg ON p.group_id = pg.id
       ORDER BY pg.id ASC, p.id ASC`
    );

    res.json({
      code: 200,
      message: 'success',
      data: rows
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/plans 新增子套餐（仅价格、时长、流量；共享设备与限速从总套餐继承）
router.post('/plans', async (req, res, next) => {
  try {
    const {
      group_id,
      name,
      description = null,
      price,
      duration_days = 30,
      traffic_limit = 0,
      is_public = 1,
      status = 1
    } = req.body;

    if (!name || price === undefined || !group_id) {
      return res.status(400).json({
        code: 400,
        message: 'name、group_id 和 price 必填',
        data: null
      });
    }

    // 验证总套餐是否存在，并读取共享设备、限速（子套餐继承总套餐）
    const [groupRows] = await pool.query(
      'SELECT id, level, is_exclusive, status, COALESCE(connections, 1) AS connections, COALESCE(speed_limit, 0) AS speed_limit FROM plan_groups WHERE id = ? LIMIT 1',
      [group_id]
    );

    if (groupRows.length === 0) {
      return res.status(404).json({
        code: 404,
        message: '总套餐不存在',
        data: null
      });
    }

    const group = groupRows[0];
    if (group.status !== 1) {
      return res.status(400).json({
        code: 400,
        message: '总套餐已停用，无法创建子套餐',
        data: null
      });
    }

    const priceNum = Number(price);
    const durationNum = Number(duration_days);
    if (Number.isNaN(priceNum) || Number.isNaN(durationNum)) {
      return res.status(400).json({
        code: 400,
        message: 'price 和 duration_days 必须为数字',
        data: null
      });
    }

    if (durationNum <= 0) {
      return res.status(400).json({
        code: 400,
        message: 'duration_days 必须大于 0',
        data: null
      });
    }

    // 子套餐的共享设备、限速从总套餐继承，不再单独传
    const connFromGroup = Number(group.connections) || 1;
    const speedFromGroup = Number(group.speed_limit) || 0;

    const [result] = await pool.query(
      `INSERT INTO plans
       (group_id, name, description, price, duration_days,
        traffic_limit, speed_limit, connections,
        is_public, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        group_id,
        name,
        description,
        priceNum,
        durationNum,
        traffic_limit ?? 0,
        speedFromGroup,
        connFromGroup,
        is_public,
        status
      ]
    );

    res.json({
      code: 200,
      message: '子套餐创建成功',
      data: { id: result.insertId }
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/admin/plans/:id 更新子套餐（仅价格、时长、流量可编辑；共享设备与限速随总套餐）
router.put('/plans/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const allowedFields = [
      'group_id',
      'name',
      'description',
      'price',
      'duration_days',
      'traffic_limit',
      'is_public',
      'status'
    ];

    const fields = [];
    const params = [];

    for (const key of allowedFields) {
      if (req.body[key] !== undefined) {
        fields.push(`${key} = ?`);
        params.push(req.body[key]);
      }
    }

    if (fields.length === 0) {
      return res.status(400).json({
        code: 400,
        message: '没有可更新的字段',
        data: null
      });
    }

    const groupIdToSync = req.body.group_id !== undefined ? req.body.group_id : null;
    // 如果更新了 group_id，验证新总套餐并同步共享设备、限速
    if (groupIdToSync !== null) {
      const [groupRows] = await pool.query(
        'SELECT id, status, COALESCE(connections, 1) AS connections, COALESCE(speed_limit, 0) AS speed_limit FROM plan_groups WHERE id = ? LIMIT 1',
        [groupIdToSync]
      );
      if (groupRows.length === 0) {
        return res.status(404).json({
          code: 404,
          message: '总套餐不存在',
          data: null
        });
      }
      if (groupRows[0].status !== 1) {
        return res.status(400).json({
          code: 400,
          message: '总套餐已停用，无法将子套餐关联到该总套餐',
          data: null
        });
      }
      fields.push('connections = ?', 'speed_limit = ?');
      params.push(Number(groupRows[0].connections) || 1, Number(groupRows[0].speed_limit) || 0);
    }

    params.push(id);

    const [result] = await pool.query(
      `UPDATE plans SET ${fields.join(', ')} WHERE id = ?`,
      params
    );

    res.json({
      code: 200,
      message: '子套餐已更新',
      data: { affectedRows: result.affectedRows }
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/plans/:id 逻辑下架套餐
router.delete('/plans/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const [result] = await pool.query(
      `UPDATE plans
       SET status = 0, is_public = 0
       WHERE id = ?`,
      [id]
    );

    res.json({
      code: 200,
      message: '套餐已下架',
      data: { affectedRows: result.affectedRows }
    });
  } catch (err) {
    next(err);
  }
});

/* ========================
 * 3. 订单管理 /api/admin/orders
 * ====================== */

// GET /api/admin/orders 查询所有订单
router.get('/orders', async (req, res, next) => {
  try {
    const {
      page = 1,
      size = 20,
      status = '',
      user_id = '',
      plan_id = ''
    } = req.query;

    const limit = Number(size) || 20;
    const offset = (Number(page) - 1) * limit;

    const conditions = ['1=1'];
    const params = [];

    if (status) {
      conditions.push('o.status = ?');
      params.push(status);
    }
    if (user_id) {
      conditions.push('o.user_id = ?');
      params.push(user_id);
    }
    if (plan_id) {
      conditions.push('o.plan_id = ?');
      params.push(plan_id);
    }

    const where = conditions.join(' AND ');

    const [rows] = await pool.query(
      `SELECT o.id,
              o.order_no,
              o.amount,
              o.status,
              o.pay_method,
              o.order_type,
              o.duration_days,
              o.traffic_amount,
              o.remark,
              o.created_at,
              o.paid_at,
              DATE_ADD(o.created_at, INTERVAL 30 MINUTE) AS pay_expire_at,
              u.email       AS user_email,
              u.username    AS username,
              p.name        AS plan_name
       FROM orders o
       JOIN users u ON o.user_id = u.id
       JOIN plans p ON o.plan_id = p.id
       WHERE ${where}
       ORDER BY o.id DESC
       LIMIT ?, ?`,
      [...params, offset, limit]
    );

    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total
       FROM orders o
       WHERE ${where}`,
      params
    );

    res.json({
      code: 200,
      message: 'success',
      data: {
        list: rows,
        total: countRows[0].total,
        page: Number(page),
        size: limit
      }
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/orders/:id/force-pay 强制标记为已支付
router.post('/orders/:id/force-pay', async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const { id } = req.params;

    const [rows] = await connection.query(
      `SELECT o.id, o.user_id, o.status, o.plan_id
       FROM orders o
       WHERE o.id = ? LIMIT 1`,
      [id]
    );

    if (rows.length === 0) {
      await connection.rollback();
      return res.status(404).json({
        code: 404,
        message: '订单不存在',
        data: null
      });
    }

    const order = rows[0];
    if (order.status === 'paid') {
      await connection.rollback();
      return res.status(400).json({
        code: 400,
        message: '订单已是已支付状态',
        data: null
      });
    }

    // 查询套餐的流量与时长
    const [planRows] = await connection.query(
      'SELECT traffic_limit, duration_days FROM plans WHERE id = ? LIMIT 1',
      [order.plan_id]
    );
    const trafficLimit = planRows.length > 0 ? Number(planRows[0].traffic_limit || 0) : 0;
    const durationDays = planRows.length > 0 ? Number(planRows[0].duration_days || 0) : 0;

    // 更新订单状态并写入流量（便于列表展示）
    await connection.query(
      `UPDATE orders
       SET status = 'paid',
           paid_at = NOW(),
           traffic_amount = ?
       WHERE id = ?`,
      [trafficLimit, id]
    );

    if (trafficLimit > 0) {
      await connection.query(
        'UPDATE users SET traffic_total = traffic_total + ? WHERE id = ?',
        [trafficLimit, order.user_id]
      );
    }
    if (durationDays > 0) {
      await connection.query(
        `UPDATE users SET
          expired_at = CASE
            WHEN expired_at IS NULL OR expired_at < NOW() THEN DATE_ADD(NOW(), INTERVAL ? DAY)
            ELSE DATE_ADD(expired_at, INTERVAL ? DAY)
          END
         WHERE id = ?`,
        [durationDays, durationDays, order.user_id]
      );
    }

    await connection.commit();

    res.json({
      code: 200,
      message: '已强制标记为已支付',
      data: null
    });
  } catch (err) {
    try {
      await connection.rollback();
    } catch (e) {
      // ignore
    }
    next(err);
  } finally {
    connection.release();
  }
});

// POST /api/admin/orders/:id/force-cancel 强制取消订单
router.post('/orders/:id/force-cancel', async (req, res, next) => {
  try {
    const { id } = req.params;

    const [rows] = await pool.query(
      'SELECT id, status FROM orders WHERE id = ? LIMIT 1',
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        code: 404,
        message: '订单不存在',
        data: null
      });
    }

    const order = rows[0];
    if (order.status === 'cancelled') {
      return res.status(400).json({
        code: 400,
        message: '订单已是已取消状态',
        data: null
      });
    }

    await pool.query(
      `UPDATE orders
       SET status = 'cancelled'
       WHERE id = ?`,
      [id]
    );

    res.json({
      code: 200,
      message: '订单已强制取消',
      data: null
    });
  } catch (err) {
    next(err);
  }
});

/* ========================
 * 4. 工单管理 /api/admin/tickets
 * ====================== */

// GET /api/admin/tickets 查询所有工单
router.get('/tickets', async (req, res, next) => {
  try {
    const {
      page = 1,
      size = 20,
      status = '',
      category = ''
    } = req.query;

    const limit = Number(size) || 20;
    const offset = (Number(page) - 1) * limit;

    const conditions = ['1=1'];
    const params = [];

    if (status) {
      conditions.push('status = ?');
      params.push(status);
    }
    if (category) {
      conditions.push('category = ?');
      params.push(category);
    }

    const where = conditions.join(' AND ');

    const [rows] = await pool.query(
      `SELECT id,
              user_id,
              ticket_no,
              title,
              category,
              status,
              priority,
              created_at,
              updated_at,
              CASE
                WHEN status IN ('open', 'in_progress') THEN DATE_ADD(updated_at, INTERVAL 1 DAY)
                ELSE NULL
              END AS due_at
       FROM tickets
       WHERE ${where}
       ORDER BY
         CASE status
           WHEN 'open' THEN 0
           WHEN 'in_progress' THEN 1
           WHEN 'resolved' THEN 2
           ELSE 3
         END,
         created_at ASC
       LIMIT ?, ?`,
      [...params, offset, limit]
    );

    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total
       FROM tickets
       WHERE ${where}`,
      params
    );

    res.json({
      code: 200,
      message: 'success',
      data: {
        list: rows,
        total: countRows[0].total,
        page: Number(page),
        size: limit
      }
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/tickets/:id 更新工单状态/优先级
router.patch('/tickets/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status, priority } = req.body;

    const fields = [];
    const params = [];

    if (status) {
      fields.push('status = ?');
      params.push(status);
    }
    if (priority) {
      fields.push('priority = ?');
      params.push(priority);
    }

    if (fields.length === 0) {
      return res.status(400).json({
        code: 400,
        message: '没有可更新的字段',
        data: null
      });
    }

    params.push(id);

    const [result] = await pool.query(
      `UPDATE tickets SET ${fields.join(', ')} WHERE id = ?`,
      params
    );

    res.json({
      code: 200,
      message: '工单已更新',
      data: { affectedRows: result.affectedRows }
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/tickets/:id 删除工单（及关联回复，由外键级联或先删回复）
router.delete('/tickets/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM ticket_replies WHERE ticket_id = ?', [id]);
    const [result] = await pool.query('DELETE FROM tickets WHERE id = ?', [id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({
        code: 404,
        message: '工单不存在',
        data: null
      });
    }
    res.json({
      code: 200,
      message: '工单已删除',
      data: { affectedRows: result.affectedRows }
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/tickets/:id/reply 管理员回复工单（并指定处理结果）
router.post('/tickets/:id/reply', async (req, res, next) => {
  try {
    const adminId = req.user.id;
    const { id } = req.params;
    const { content, status } = req.body;

    if (!content) {
      return res.status(400).json({
        code: 400,
        message: '回复内容不能为空',
        data: null
      });
    }

    if (!status || !['resolved', 'open'].includes(status)) {
      return res.status(400).json({
        code: 400,
        message: '必须在「已解决」或「待用户补充」中选择一个处理结果',
        data: null
      });
    }

    const [tickets] = await pool.query(
      'SELECT id FROM tickets WHERE id = ? LIMIT 1',
      [id]
    );

    if (tickets.length === 0) {
      return res.status(404).json({
        code: 404,
        message: '工单不存在',
        data: null
      });
    }

    await pool.query(
      `INSERT INTO ticket_replies
       (ticket_id, user_id, is_admin, content, created_at)
       VALUES (?, ?, 1, ?, NOW())`,
      [id, adminId, content]
    );

    // 记录最后处理管理员，根据选择的处理结果更新状态：
    // status = 'resolved' -> 已解决；status = 'open' -> 待用户补充
    await pool.query(
      `UPDATE tickets
       SET admin_id = ?, status = ?, updated_at = NOW(),
           resolved_at = CASE WHEN ? = 'resolved' THEN NOW() ELSE resolved_at END
       WHERE id = ?`,
      [adminId, status, status, id]
    );

    res.json({
      code: 200,
      message: '管理员回复成功',
      data: null
    });
  } catch (err) {
    next(err);
  }
});

/* ========================
 * 6. 面板设置 /api/admin/settings
 * ====================== */

// GET /api/admin/settings/internal-api-key 获取当前 INTERNAL_API_KEY（仅管理员）
router.get('/settings/internal-api-key', (req, res) => {
  res.json({
    code: 200,
    message: 'success',
    data: {
      value: process.env.INTERNAL_API_KEY || ''
    }
  });
});

// POST /api/admin/settings/internal-api-key 更新当前进程使用的 INTERNAL_API_KEY
// 注意：仅更新运行时 process.env，不会自动修改 .env.docker 文件，重启容器后会回退为 .env.docker 中的值
router.post('/settings/internal-api-key', (req, res) => {
  const { value } = req.body || {};
  if (!value || typeof value !== 'string' || value.length < 16) {
    return res.status(400).json({
      code: 400,
      message: 'INTERNAL_API_KEY 至少 16 位字符串',
      data: null
    });
  }
  process.env.INTERNAL_API_KEY = value;
  res.json({
    code: 200,
    message: 'INTERNAL_API_KEY 已更新（当前进程生效，重启后需再次设置或更新 .env.docker）',
    data: { value }
  });
});

// GET /api/admin/settings/panel 获取面板设置（面板网址）
router.get('/settings/panel', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      "SELECT value FROM system_settings WHERE `key` = 'panel_public_url' LIMIT 1"
    );
    const panelUrl = rows.length > 0 && rows[0].value ? String(rows[0].value).trim() : '';
    res.json({
      code: 200,
      message: 'success',
      data: { panel_public_url: panelUrl }
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/admin/settings/panel 更新面板设置（面板网址）
router.put('/settings/panel', async (req, res, next) => {
  try {
    const { panel_public_url } = req.body || {};
    const url = panel_public_url ? String(panel_public_url).trim() : '';
    
    // 验证URL格式（简单验证）
    if (url && !/^https?:\/\/.+/.test(url)) {
      return res.status(400).json({
        code: 400,
        message: '面板网址格式不正确，应为 http:// 或 https:// 开头',
        data: null
      });
    }

    await pool.query(
      `INSERT INTO system_settings (\`key\`, \`value\`, updated_at)
       VALUES ('panel_public_url', ?, NOW())
       ON DUPLICATE KEY UPDATE \`value\` = ?, updated_at = NOW()`,
      [url, url]
    );

    res.json({
      code: 200,
      message: '面板设置已更新',
      data: { panel_public_url: url }
    });
  } catch (err) {
    next(err);
  }
});

/* ========================
 * 5. 节点管理 /api/admin/nodes
 * ====================== */

// GET /api/admin/nodes 列出所有节点及其绑定的总套餐ID（group_ids）
router.get('/nodes', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT
         n.id,
         n.name,
         n.address,
         n.port,
         n.protocol,
         n.config,
         n.status,
         n.sort_order,
         n.created_at,
         n.updated_at,
         GROUP_CONCAT(DISTINCT p.group_id ORDER BY p.group_id) AS group_ids
       FROM nodes n
       LEFT JOIN plan_nodes pn ON pn.node_id = n.id
       LEFT JOIN plans p ON p.id = pn.plan_id
       GROUP BY n.id
       ORDER BY n.sort_order ASC, n.id DESC`
    );

    const data = rows.map((r) => ({
      ...r,
      group_ids: r.group_ids ? r.group_ids.split(',').map((id) => Number(id)).filter(Boolean) : []
    }));

    res.json({
      code: 200,
      message: 'success',
      data
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/nodes 新增节点（绑定总套餐 group_ids，自动展开为该总套餐下所有子套餐）
router.post('/nodes', async (req, res, next) => {
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
      group_ids
    } = req.body;

    if (!name || !address || !port || !protocol || !config) {
      connection.release();
      return res.status(400).json({
        code: 400,
        message: 'name、address、port、protocol、config 为必填',
        data: null
      });
    }

    await connection.beginTransaction();

    const [result] = await connection.query(
      `INSERT INTO nodes
         (name, address, port, protocol, config, status, sort_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
      [name, address, port, protocol, config, status, sort_order]
    );

    const nodeId = result.insertId;

    if (Array.isArray(group_ids) && group_ids.length > 0) {
      const [planRows] = await connection.query(
        `SELECT id FROM plans WHERE group_id IN (${group_ids.map(() => '?').join(',')}) AND status = 1`,
        group_ids
      );
      if (planRows.length > 0) {
        const placeholders = planRows.map(() => '(?, ?, ?)').join(',');
        const flatValues = planRows.flatMap((p) => [p.id, nodeId, 0]);
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
      message: '节点创建成功',
      data: { id: nodeId }
    });
  } catch (err) {
    await connection.rollback();
    connection.release();
    next(err);
  }
});

// PUT /api/admin/nodes/:id 更新节点（绑定总套餐 group_ids，自动展开为该总套餐下所有子套餐）
router.put('/nodes/:id', async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const { id } = req.params;
    const {
      name,
      address,
      port,
      protocol,
      config,
      status,
      sort_order,
      group_ids
    } = req.body;

    const fields = [];
    const params = [];

    if (name !== undefined) {
      fields.push('name = ?');
      params.push(name);
    }
    if (address !== undefined) {
      fields.push('address = ?');
      params.push(address);
    }
    if (port !== undefined) {
      fields.push('port = ?');
      params.push(port);
    }
    if (protocol !== undefined) {
      fields.push('protocol = ?');
      params.push(protocol);
    }
    if (config !== undefined) {
      fields.push('config = ?');
      params.push(config);
    }
    if (status !== undefined) {
      fields.push('status = ?');
      params.push(status);
    }
    if (sort_order !== undefined) {
      fields.push('sort_order = ?');
      params.push(sort_order);
    }

    await connection.beginTransaction();

    if (fields.length > 0) {
      params.push(id);
      await connection.query(
        `UPDATE nodes SET ${fields.join(', ')} WHERE id = ?`,
        params
      );
    }

    if (Array.isArray(group_ids)) {
      await connection.query('DELETE FROM plan_nodes WHERE node_id = ?', [id]);
      if (group_ids.length > 0) {
        const [planRows] = await connection.query(
          `SELECT id FROM plans WHERE group_id IN (${group_ids.map(() => '?').join(',')}) AND status = 1`,
          group_ids
        );
        if (planRows.length > 0) {
          const placeholders = planRows.map(() => '(?, ?, ?)').join(',');
          const flatValues = planRows.flatMap((p) => [p.id, id, 0]);
          await connection.query(
            `INSERT INTO plan_nodes (plan_id, node_id, priority) VALUES ${placeholders}`,
            flatValues
          );
        }
      }
    }

    await connection.commit();
    connection.release();

    res.json({
      code: 200,
      message: '节点已更新',
      data: { id: Number(id) }
    });
  } catch (err) {
    await connection.rollback();
    connection.release();
    next(err);
  }
});

// DELETE /api/admin/nodes/:id 删除节点（同时删除套餐绑定关系）
router.delete('/nodes/:id', async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const { id } = req.params;

    await connection.beginTransaction();

    await connection.query('DELETE FROM plan_nodes WHERE node_id = ?', [id]);
    const [result] = await connection.query('DELETE FROM nodes WHERE id = ?', [id]);

    await connection.commit();
    connection.release();

    if (result.affectedRows === 0) {
      return res.status(404).json({
        code: 404,
        message: '节点不存在',
        data: null
      });
    }

    res.json({
      code: 200,
      message: '节点已删除',
      data: { affectedRows: result.affectedRows }
    });
  } catch (err) {
    await connection.rollback();
    connection.release();
    next(err);
  }
});

module.exports = router;

