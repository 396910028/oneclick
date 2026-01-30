const express = require('express');
const pool = require('../config/db');
const auth = require('../middleware/auth');

const router = express.Router();

// 获取当前用户的订单列表（基于 plans）
router.get('/', auth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { page = 1, size = 20 } = req.query;
    const limit = Number(size) || 20;
    const offset = (Number(page) - 1) * limit;

    const [rows] = await pool.query(
      `SELECT o.id,
              o.order_no,
              o.amount,
              o.status,
              o.pay_method,
              o.duration_days,
              o.created_at,
              o.paid_at,
              DATE_ADD(o.created_at, INTERVAL 30 MINUTE) AS pay_expire_at,
              p.name   AS plan_name
       FROM orders o
       JOIN plans p ON o.plan_id = p.id
       WHERE o.user_id = ?
       ORDER BY o.id DESC
       LIMIT ?, ?`,
      [userId, offset, limit]
    );

    const [countRows] = await pool.query(
      'SELECT COUNT(*) AS total FROM orders WHERE user_id = ?',
      [userId]
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

// 获取当前用户的当前生效套餐（同一套餐多次订阅会叠加到期时间）
router.get('/current', auth, async (req, res, next) => {
  try {
    const userId = req.user.id;

    const [rows] = await pool.query(
      `SELECT o.id,
              o.order_no,
              o.amount,
              o.status,
              o.duration_days,
              o.created_at,
              o.paid_at,
              p.id   AS plan_id,
              p.name AS plan_name,
              pg.level AS plan_level
       FROM orders o
       JOIN plans p ON o.plan_id = p.id
       JOIN plan_groups pg ON p.group_id = pg.id
       WHERE o.user_id = ?
         AND o.status = 'paid'
       ORDER BY COALESCE(o.paid_at, o.created_at), o.id`,
      [userId]
    );

    let current = null;
    let expireAt = null;

    if (rows.length > 0) {
      // 以最新一笔已支付订单的套餐为当前套餐
      const last = rows[rows.length - 1];
      const targetPlanId = last.plan_id;

      const samePlanOrders = rows.filter((o) => o.plan_id === targetPlanId);

      // 按订单 paid_at + duration_days 累加计算到期时间
      let accExpire = null;
      for (const o of samePlanOrders) {
        const baseStr = o.paid_at || o.created_at;
        if (!baseStr) continue;
        const base = new Date(baseStr);
        const start = accExpire && accExpire > base ? accExpire : base;
        const durationDays = Number(o.duration_days || 0);
        if (durationDays <= 0) continue;
        const expire = new Date(start.getTime() + durationDays * 24 * 60 * 60 * 1000);
        accExpire = expire;
      }

      current = last;
      expireAt = accExpire ? accExpire.toISOString() : null;
    }

    res.json({
      code: 200,
      message: 'success',
      data: {
        current: current
          ? {
              ...current,
              expire_at: expireAt
            }
          : null
      }
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/orders/:id/upgrade-preview 升级预览（计算旧套餐残值、新套餐价格、需补金额）
router.get('/:id/upgrade-preview', auth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { id } = req.params; // 旧订单ID
    const { new_plan_id } = req.query;

    if (!new_plan_id) {
      return res.status(400).json({
        code: 400,
        message: '参数不完整，必须提供 new_plan_id',
        data: null
      });
    }

    // 1. 查询旧订单（必须是已支付且属于当前用户）
    const [oldOrderRows] = await pool.query(
      `SELECT o.id, o.order_no, o.amount, o.duration_days, o.paid_at, o.created_at,
              p.id AS plan_id, p.name AS plan_name, pg.level AS plan_level
       FROM orders o
       JOIN plans p ON o.plan_id = p.id
       JOIN plan_groups pg ON p.group_id = pg.id
       WHERE o.id = ? AND o.user_id = ? AND o.status = 'paid' LIMIT 1`,
      [id, userId]
    );

    if (oldOrderRows.length === 0) {
      return res.status(404).json({
        code: 404,
        message: '旧订单不存在或未支付',
        data: null
      });
    }

    const oldOrder = oldOrderRows[0];

    // 2. 查询新套餐（带总套餐信息）
    const [newPlanRows] = await pool.query(
      `SELECT p.id, p.name, p.price, p.duration_days, p.status, p.is_public,
              pg.level AS level
       FROM plans p
       JOIN plan_groups pg ON p.group_id = pg.id
       WHERE p.id = ? LIMIT 1`,
      [new_plan_id]
    );

    if (newPlanRows.length === 0) {
      return res.status(404).json({
        code: 404,
        message: '新套餐不存在',
        data: null
      });
    }

    const newPlan = newPlanRows[0];

    if (newPlan.status !== 1 || newPlan.is_public !== 1) {
      return res.status(400).json({
        code: 400,
        message: '新套餐未上架或已停用',
        data: null
      });
    }

    // 3. 验证等级：新套餐等级必须 > 旧套餐等级
    const oldLevel = Number(oldOrder.plan_level || 0);
    const newLevel = Number(newPlan.level || 0);
    if (newLevel <= oldLevel) {
      return res.status(400).json({
        code: 400,
        message: '只能升级到更高级别的套餐',
        data: null
      });
    }

    // 4. 计算旧套餐剩余价值
    // 先计算旧套餐的到期时间（按同一套餐的所有已支付订单累加）
    const [allPaidOrders] = await pool.query(
      `SELECT o.duration_days, o.paid_at, o.created_at
       FROM orders o
       JOIN plans p ON o.plan_id = p.id
       WHERE o.user_id = ? AND o.status = 'paid' AND p.id = ?
       ORDER BY COALESCE(o.paid_at, o.created_at), o.id`,
      [userId, oldOrder.plan_id]
    );

    let oldExpireAt = null;
    if (allPaidOrders.length > 0) {
      let accExpire = null;
      for (const o of allPaidOrders) {
        const baseStr = o.paid_at || o.created_at;
        if (!baseStr) continue;
        const base = new Date(baseStr);
        const start = accExpire && accExpire > base ? accExpire : base;
        const durationDays = Number(o.duration_days || 0);
        if (durationDays <= 0) continue;
        const expire = new Date(start.getTime() + durationDays * 24 * 60 * 60 * 1000);
        accExpire = expire;
      }
      oldExpireAt = accExpire;
    }

    if (!oldExpireAt) {
      return res.status(400).json({
        code: 400,
        message: '无法计算旧套餐到期时间',
        data: null
      });
    }

    const now = new Date();
    const expireDate = new Date(oldExpireAt);
    const totalMs = expireDate.getTime() - now.getTime();

    if (totalMs <= 0) {
      return res.status(400).json({
        code: 400,
        message: '旧套餐已过期，无需升级',
        data: null
      });
    }

    // 计算旧套餐的总时长（从 paid_at 到 expire_at）
    const oldPaidAt = new Date(oldOrder.paid_at || oldOrder.created_at);
    const oldTotalMs = expireDate.getTime() - oldPaidAt.getTime();
    const remainingRatio = totalMs / oldTotalMs;

    // 旧套餐残值 = 原金额 * 剩余比例
    const oldAmount = Number(oldOrder.amount || 0);
    const oldRemainingValue = oldAmount * remainingRatio;

    // 5. 计算新套餐价格
    const newAmount = Number(newPlan.price || 0);

    if (!newAmount || newAmount <= 0) {
      return res.status(400).json({
        code: 400,
        message: '新套餐价格无效',
        data: null
      });
    }

    // 6. 计算需补金额
    const needPay = newAmount - oldRemainingValue;

    if (needPay < 0) {
      return res.status(400).json({
        code: 400,
        message: '旧套餐残值超过新套餐价格，请联系客服处理',
        data: null
      });
    }

    res.json({
      code: 200,
      message: 'success',
      data: {
        oldOrder: {
          id: oldOrder.id,
          order_no: oldOrder.order_no,
          plan_name: oldOrder.plan_name,
          amount: oldAmount,
          expire_at: oldExpireAt.toISOString()
        },
        newPlan: {
          id: newPlan.id,
          name: newPlan.name,
          amount: newAmount,
          duration_days: Number(newPlan.duration_days || 0)
        },
        oldRemainingValue: Number(oldRemainingValue.toFixed(2)),
        needPay: Number(needPay.toFixed(2))
      }
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/orders/:id/upgrade-confirm 确认升级并创建新订单
router.post('/:id/upgrade-confirm', auth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { id } = req.params; // 旧订单ID
    const { new_plan_id, pay_method = 'balance' } = req.body;

    if (!new_plan_id) {
      return res.status(400).json({
        code: 400,
        message: '参数不完整，必须提供 new_plan_id',
        data: null
      });
    }

    // 1. 再次验证旧订单和新套餐（防止并发）
    const [oldOrderRows] = await pool.query(
      `SELECT o.id, o.order_no, o.amount, o.duration_days, o.paid_at, o.created_at,
              p.id AS plan_id, p.name AS plan_name, pg.level AS plan_level
       FROM orders o
       JOIN plans p ON o.plan_id = p.id
       JOIN plan_groups pg ON p.group_id = pg.id
       WHERE o.id = ? AND o.user_id = ? AND o.status = 'paid' LIMIT 1`,
      [id, userId]
    );

    if (oldOrderRows.length === 0) {
      return res.status(404).json({
        code: 404,
        message: '旧订单不存在或未支付',
        data: null
      });
    }

    const oldOrder = oldOrderRows[0];

    const [newPlanRows] = await pool.query(
      `SELECT p.id, p.name, p.price, p.duration_days, p.status, p.is_public,
              pg.level AS level
       FROM plans p
       JOIN plan_groups pg ON p.group_id = pg.id
       WHERE p.id = ? LIMIT 1`,
      [new_plan_id]
    );

    if (newPlanRows.length === 0) {
      return res.status(404).json({
        code: 404,
        message: '新套餐不存在',
        data: null
      });
    }

    const newPlan = newPlanRows[0];

    if (newPlan.status !== 1 || newPlan.is_public !== 1) {
      return res.status(400).json({
        code: 400,
        message: '新套餐未上架或已停用',
        data: null
      });
    }

    const oldLevel = Number(oldOrder.plan_level || 0);
    const newLevel = Number(newPlan.level || 0);
    if (newLevel <= oldLevel) {
      return res.status(400).json({
        code: 400,
        message: '只能升级到更高级别的套餐',
        data: null
      });
    }

    // 2. 重新计算需补金额（与 preview 逻辑一致）
    const [allPaidOrders] = await pool.query(
      `SELECT o.duration_days, o.paid_at, o.created_at
       FROM orders o
       JOIN plans p ON o.plan_id = p.id
       WHERE o.user_id = ? AND o.status = 'paid' AND p.id = ?
       ORDER BY COALESCE(o.paid_at, o.created_at), o.id`,
      [userId, oldOrder.plan_id]
    );

    let oldExpireAt = null;
    if (allPaidOrders.length > 0) {
      let accExpire = null;
      for (const o of allPaidOrders) {
        const baseStr = o.paid_at || o.created_at;
        if (!baseStr) continue;
        const base = new Date(baseStr);
        const start = accExpire && accExpire > base ? accExpire : base;
        const durationDays = Number(o.duration_days || 0);
        if (durationDays <= 0) continue;
        const expire = new Date(start.getTime() + durationDays * 24 * 60 * 60 * 1000);
        accExpire = expire;
      }
      oldExpireAt = accExpire;
    }

    if (!oldExpireAt) {
      return res.status(400).json({
        code: 400,
        message: '无法计算旧套餐到期时间',
        data: null
      });
    }

    const now = new Date();
    const expireDate = new Date(oldExpireAt);
    const totalMs = expireDate.getTime() - now.getTime();

    if (totalMs <= 0) {
      return res.status(400).json({
        code: 400,
        message: '旧套餐已过期，无需升级',
        data: null
      });
    }

    const oldPaidAt = new Date(oldOrder.paid_at || oldOrder.created_at);
    const oldTotalMs = expireDate.getTime() - oldPaidAt.getTime();
    const remainingRatio = totalMs / oldTotalMs;

    const oldAmount = Number(oldOrder.amount || 0);
    const oldRemainingValue = oldAmount * remainingRatio;

    const newAmount = Number(newPlan.price || 0);

    if (!newAmount || newAmount <= 0) {
      return res.status(400).json({
        code: 400,
        message: '新套餐价格无效',
        data: null
      });
    }

    const newDurationDays = Number(newPlan.duration_days || 30);

    const needPay = newAmount - oldRemainingValue;

    if (needPay < 0) {
      return res.status(400).json({
        code: 400,
        message: '旧套餐残值超过新套餐价格，请联系客服处理',
        data: null
      });
    }

    // 3. 检查是否有未支付订单
    const [pendingOrders] = await pool.query(
      `SELECT id, order_no
       FROM orders
       WHERE user_id = ? AND status = 'pending'
       LIMIT 1`,
      [userId]
    );
    if (pendingOrders.length > 0) {
      return res.status(400).json({
        code: 400,
        message: '您有未支付的订单，请先支付或取消后再升级',
        data: null
      });
    }

    // 4. 创建新订单（金额为需补金额，如果为0则免费）
    const orderNo = `ORD${Date.now()}${Math.floor(Math.random() * 1000)
      .toString()
      .padStart(3, '0')}`;

    const finalAmount = Number(needPay.toFixed(2));

    const insertSql = `INSERT INTO orders
     (user_id, plan_id, order_no, amount, pay_method, status, duration_days, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, UTC_TIMESTAMP())`;
    const insertParams = [userId, new_plan_id, orderNo, finalAmount, pay_method, newDurationDays];

    const [result] = await pool.query(insertSql, insertParams);

    res.json({
      code: 200,
      message: '升级订单创建成功',
      data: {
        id: result.insertId,
        order_no: orderNo,
        amount: finalAmount,
        duration_days: newDurationDays,
        status: 'pending',
        old_order_id: id,
        old_remaining_value: Number(oldRemainingValue.toFixed(2))
      }
    });
  } catch (err) {
    next(err);
  }
});

// 当前登录用户取消自己的订单（仅 pending/expired）
router.post('/:id/cancel', auth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const [rows] = await pool.query(
      'SELECT id, user_id, status FROM orders WHERE id = ? LIMIT 1',
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

    if (order.user_id !== userId) {
      return res.status(403).json({
        code: 403,
        message: '无权取消该订单',
        data: null
      });
    }

    if (order.status === 'paid') {
      return res.status(400).json({
        code: 400,
        message: '已支付订单不能取消',
        data: null
      });
    }

    if (order.status === 'cancelled') {
      return res.status(400).json({
        code: 400,
        message: '订单已取消',
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
      message: '订单已取消',
      data: null
    });
  } catch (err) {
    next(err);
  }
});

// 创建订单（基于套餐 plans）
router.post('/', auth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;
    const { plan_id, pay_method = 'balance' } = req.body;

    if (!plan_id) {
      return res.status(400).json({
        code: 400,
        message: '参数不完整，必须提供 plan_id',
        data: null
      });
    }

    // 查询套餐，取价格、持续时间、等级、流量配额、总套餐分组/互斥信息
    const [plans] = await pool.query(
      `SELECT p.id, p.name, p.price, p.duration_days, p.traffic_limit, p.status, p.is_public,
              pg.id AS group_id, pg.group_key, pg.name AS group_name,
              pg.level AS level, pg.is_exclusive AS is_exclusive
       FROM plans p
       JOIN plan_groups pg ON p.group_id = pg.id
       WHERE p.id = ? LIMIT 1`,
      [plan_id]
    );

    if (plans.length === 0) {
      return res.status(404).json({
        code: 404,
        message: '套餐不存在',
        data: null
      });
    }

    const plan = plans[0];

    if (plan.status !== 1 || plan.is_public !== 1) {
      return res.status(400).json({
        code: 400,
        message: '套餐未上架或已停用',
        data: null
      });
    }

    // 普通用户若已有未支付订单，则不允许重复下单
    const isAdmin = userRole === 'admin';

    if (!isAdmin) {
      // 1）限制普通用户同时只能有一个未支付订单
      const [pendingOrders] = await pool.query(
        `SELECT id, order_no
         FROM orders
         WHERE user_id = ? AND status = 'pending'
         LIMIT 1`,
        [userId]
      );
      if (pendingOrders.length > 0) {
        return res.status(400).json({
          code: 400,
          message: '您有未支付的订单，请先在「我的订单」中支付或取消后再下单',
          data: null
        });
      }

      // 2）等级限制：已拥有较高级别总套餐时，禁止再购买更低级别总套餐
      const [rowsMaxLevel] = await pool.query(
        `SELECT MAX(pg.level) AS max_level
         FROM orders o
         JOIN plans p ON o.plan_id = p.id
         JOIN plan_groups pg ON p.group_id = pg.id
         WHERE o.user_id = ? AND o.status = 'paid'`,
        [userId]
      );
      const maxLevel = rowsMaxLevel[0]?.max_level;
      if (maxLevel !== null && maxLevel !== undefined) {
        const currentMaxLevel = Number(maxLevel);
        const targetLevel = Number(plan.level || 0);
        if (!Number.isNaN(currentMaxLevel) && !Number.isNaN(targetLevel)) {
          if (targetLevel < currentMaxLevel) {
            return res.status(400).json({
              code: 400,
              message: '您当前已拥有更高级别的总套餐，不能再购买更低级别的总套餐。',
              data: null
            });
          }
        }
      }
      // 3）总套餐互斥限制：互斥总套餐之间不能并存
      const groupId = plan.group_id || null;
      const exclusiveFlag = plan.is_exclusive ? 1 : 0;
      if (exclusiveFlag === 1 && groupId) {
        const [conflictRows] = await pool.query(
          `SELECT DISTINCT pg.name AS group_name, pg.group_key
           FROM orders o
           JOIN plans p ON o.plan_id = p.id
           JOIN plan_groups pg ON p.group_id = pg.id
           WHERE o.user_id = ?
             AND o.status = 'paid'
             AND pg.is_exclusive = 1
             AND pg.id <> ?`,
          [userId, groupId]
        );
        if (conflictRows.length > 0) {
          const conflict = conflictRows[0];
          return res.status(400).json({
            code: 400,
            message: `当前已拥有互斥总套餐【${conflict.group_name || conflict.group_key}】，不能再购买总套餐【${plan.group_name || plan.group_key}】，如需更换请先到期或使用升级功能。`,
            data: null
          });
        }
      }
    }

    const amount = Number(plan.price || 0);

    if (!amount || amount <= 0) {
      if (!isAdmin) {
        return res.status(400).json({
          code: 400,
          message: '该套餐价格无效',
          data: null
        });
      }
      // 管理员购买视为免费
      amount = 0;
    }

    const durationDays = Number(plan.duration_days || 30);

    // 生成简单订单号：时间戳 + 随机数
    const orderNo = `ORD${Date.now()}${Math.floor(Math.random() * 1000)
      .toString()
      .padStart(3, '0')}`;

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      let insertSql;
      let insertParams;

      if (isAdmin) {
        // 管理员购买：免费并直接视为已支付
        insertSql = `INSERT INTO orders
         (user_id, plan_id, order_no, amount, pay_method, status, duration_days, created_at, paid_at)
         VALUES (?, ?, ?, ?, ?, 'paid', ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`;
        insertParams = [userId, plan_id, orderNo, 0, pay_method, durationDays];
      } else {
        insertSql = `INSERT INTO orders
         (user_id, plan_id, order_no, amount, pay_method, status, duration_days, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, UTC_TIMESTAMP())`;
        insertParams = [userId, plan_id, orderNo, amount, pay_method, durationDays];
      }

      const [result] = await connection.query(insertSql, insertParams);

      // 如果是管理员购买（已支付），自动分配流量配额（一次性配额，无重置周期）
      if (isAdmin) {
        const trafficLimit = Number(plan.traffic_limit || 0);
        if (trafficLimit > 0) {
          await connection.query(
            'UPDATE users SET traffic_total = traffic_total + ? WHERE id = ?',
            [trafficLimit, userId]
          );
        }
      }

      await connection.commit();

      res.json({
        code: 200,
        message: isAdmin ? '管理员订购成功（已支付，金额为 0）' : '订单创建成功（待支付）',
        data: {
          id: result.insertId,
          order_no: orderNo,
          amount: isAdmin ? 0 : amount,
          duration_days: durationDays,
          status: isAdmin ? 'paid' : 'pending'
        }
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
  } catch (err) {
    next(err);
  }
});

module.exports = router;

