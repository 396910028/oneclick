const express = require('express');
const pool = require('../config/db');
const auth = require('../middleware/auth');

const router = express.Router();

// 更新用户权益（退订时调用）
async function updateUserEntitlementOnUnsubscribe(connection, userId, groupId, planId, orderId, daysDeduct, trafficBytesDeduct, fullRefund, remark) {
  // 查找该用户该 group+plan 的 active 权益
  const [entitlements] = await connection.query(
    `SELECT id, service_expire_at, traffic_total_bytes, traffic_used_bytes, original_expire_at
     FROM user_entitlements 
     WHERE user_id = ? AND group_id = ? AND plan_id = ? AND status = 'active' 
     ORDER BY service_expire_at DESC 
     LIMIT 1`,
    [userId, groupId, planId]
  );
  
  if (entitlements.length === 0) {
    return false; // 没有找到对应的权益
  }
  
  const entitlement = entitlements[0];
  const now = new Date();
  
  if (fullRefund) {
    // 全额退订：标记为 cancelled，设置 service_expire_at 为当前时间
    await connection.query(
      `UPDATE user_entitlements 
       SET status = 'cancelled',
           service_expire_at = NOW(),
           traffic_total_bytes = GREATEST(traffic_used_bytes, traffic_total_bytes - ?),
           cancel_reason = ?,
           cancelled_at = NOW(),
           last_order_id = ?,
           updated_at = NOW()
       WHERE id = ?`,
      [
        trafficBytesDeduct,
        remark || '全额退订',
        orderId,
        entitlement.id
      ]
    );
    
    // 如果扣减后流量已用完，标记为 exhausted
    await connection.query(
      `UPDATE user_entitlements 
       SET status = 'exhausted'
       WHERE id = ? AND traffic_total_bytes > 0 AND traffic_used_bytes >= traffic_total_bytes`,
      [entitlement.id]
    );
  } else {
    // 部分退订：扣减天数（只改 service_expire_at）和流量
    const currentExpireAt = new Date(entitlement.service_expire_at);
    const newExpireAt = new Date(currentExpireAt.getTime() - daysDeduct * 24 * 60 * 60 * 1000);
    const newTrafficTotal = Math.max(
      Number(entitlement.traffic_used_bytes || 0),
      Number(entitlement.traffic_total_bytes || 0) - trafficBytesDeduct
    );
    
    let newStatus = 'active';
    if (newExpireAt <= now) {
      newStatus = 'cancelled';
    } else if (newTrafficTotal > 0 && Number(entitlement.traffic_used_bytes || 0) >= newTrafficTotal) {
      newStatus = 'exhausted';
    }
    
    await connection.query(
      `UPDATE user_entitlements 
       SET service_expire_at = ?,
           traffic_total_bytes = ?,
           status = ?,
           last_order_id = ?,
           updated_at = NOW()
       WHERE id = ?`,
      [
        newExpireAt.toISOString().slice(0, 19).replace('T', ' '),
        newTrafficTotal,
        newStatus,
        orderId,
        entitlement.id
      ]
    );
  }
  
  return true;
}

// 创建或更新用户权益（支付成功时调用）
// 注意：此函数现在会同时维护 user_entitlements.total_amount，便于后续“按剩余价值升级”
async function upsertUserEntitlement(connection, userId, groupId, planId, orderId, paidAt, durationDays, trafficAmount, orderAmount = 0) {
  const now = new Date(paidAt);
  const expireAt = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);
  
  // 检查是否已存在同 group+plan 的 active 权益
  const [existing] = await connection.query(
    `SELECT id, traffic_total_bytes, service_expire_at, total_amount 
     FROM user_entitlements 
     WHERE user_id = ? AND group_id = ? AND plan_id = ? AND status = 'active' 
     LIMIT 1`,
    [userId, groupId, planId]
  );
  
  const addAmount = Number(orderAmount || 0);

  if (existing.length > 0) {
    // 更新现有权益：延长到期时间，累加流量
    const existingEntitlement = existing[0];
    const newExpireAt = new Date(Math.max(
      new Date(existingEntitlement.service_expire_at).getTime(),
      expireAt.getTime()
    ));
    
    await connection.query(
      `UPDATE user_entitlements 
       SET original_expire_at = ?,
           service_expire_at = ?,
           traffic_total_bytes = traffic_total_bytes + ?,
           total_amount = total_amount + ?,
           last_order_id = ?,
           updated_at = NOW()
       WHERE id = ?`,
      [
        newExpireAt.toISOString().slice(0, 19).replace('T', ' '),
        newExpireAt.toISOString().slice(0, 19).replace('T', ' '),
        trafficAmount,
        addAmount,
        orderId,
        existingEntitlement.id
      ]
    );
  } else {
    // 创建新权益
    await connection.query(
      `INSERT INTO user_entitlements 
       (user_id, group_id, plan_id, status, original_started_at, original_expire_at, 
        service_started_at, service_expire_at, traffic_total_bytes, traffic_used_bytes, total_amount,
        last_order_id, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, 0, ?, ?, NOW(), NOW())`,
      [
        userId,
        groupId,
        planId,
        paidAt.toISOString().slice(0, 19).replace('T', ' '),
        expireAt.toISOString().slice(0, 19).replace('T', ' '),
        paidAt.toISOString().slice(0, 19).replace('T', ' '),
        expireAt.toISOString().slice(0, 19).replace('T', ' '),
        trafficAmount,
        addAmount,
        orderId
      ]
    );
  }
}

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
              o.order_type,
              o.duration_days,
              o.traffic_amount,
              o.remark,
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

// 刷新用户权益状态（请求时兜底：自动更新 expired/exhausted 状态）
async function refreshUserEntitlementStatus(userId) {
  // 更新已过期的权益
  await pool.query(
    `UPDATE user_entitlements 
     SET status = 'expired'
     WHERE user_id = ? 
       AND status = 'active'
       AND service_expire_at <= NOW()`,
    [userId]
  );
  
  // 更新已耗尽的权益
  await pool.query(
    `UPDATE user_entitlements 
     SET status = 'exhausted'
     WHERE user_id = ?
       AND status = 'active'
       AND traffic_total_bytes > 0
       AND traffic_used_bytes >= traffic_total_bytes`,
    [userId]
  );
}

// 获取当前用户的当前生效套餐（从 user_entitlements 读取）
router.get('/current', auth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    
    // 先刷新状态（请求时兜底）
    await refreshUserEntitlementStatus(userId);

    // 返回所有有效权益（用于前端展示“多个套餐分别到期/分别剩余”）
    const [entitlementRows] = await pool.query(
      `SELECT e.id,
              e.group_id,
              e.plan_id,
              e.service_expire_at,
              e.traffic_total_bytes,
              e.traffic_used_bytes,
              pg.name AS group_name,
              pg.level AS plan_level,
              p.name AS plan_name
       FROM user_entitlements e
       JOIN plans p ON e.plan_id = p.id
       JOIN plan_groups pg ON e.group_id = pg.id
       WHERE e.user_id = ?
         AND e.status = 'active'
         AND e.service_expire_at > NOW()
         AND (e.traffic_total_bytes < 0 OR e.traffic_used_bytes < e.traffic_total_bytes)
       ORDER BY e.service_expire_at DESC, (e.traffic_total_bytes - e.traffic_used_bytes) DESC`,
      [userId]
    );

    const entitlements = entitlementRows.map((e) => {
      const total = Number(e.traffic_total_bytes || 0);
      const used = Number(e.traffic_used_bytes || 0);
      const remaining = total < 0 ? -1 : Math.max(0, total - used);
      return {
        entitlement_id: e.id,
        group_id: e.group_id,
        group_name: e.group_name,
        plan_id: e.plan_id,
        plan_name: e.plan_name,
        plan_level: e.plan_level,
        expire_at: e.service_expire_at,
        traffic_total_bytes: total,
        traffic_used_bytes: used,
        traffic_remaining_bytes: remaining
      };
    });

    // 兼容旧前端：仍给一个 current（取第一条）
    const current = entitlements.length
      ? {
          id: entitlements[0].entitlement_id,
          plan_id: entitlements[0].plan_id,
          plan_name: entitlements[0].plan_name,
          plan_level: entitlements[0].plan_level,
          expire_at: entitlements[0].expire_at
        }
      : null;

    res.json({
      code: 200,
      message: 'success',
      data: { current, entitlements }
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/orders/current/remaining 获取“可退订权益”的剩余（支持 entitlement_id 指定某个权益）
router.get('/current/remaining', auth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const entitlementId = req.query.entitlement_id ? Number(req.query.entitlement_id) : null;
    
    // 先刷新状态（请求时兜底）
    await refreshUserEntitlementStatus(userId);

    const [entitlementRows] = await pool.query(
      `SELECT e.id, e.group_id, e.plan_id, e.service_expire_at, e.traffic_total_bytes, e.traffic_used_bytes,
              pg.name AS group_name, p.name AS plan_name
       FROM user_entitlements e
       JOIN plan_groups pg ON e.group_id = pg.id
       JOIN plans p ON e.plan_id = p.id
       WHERE e.user_id = ?
         AND e.status = 'active'
         AND e.service_expire_at > NOW()
         AND (e.traffic_total_bytes < 0 OR e.traffic_used_bytes < e.traffic_total_bytes)
       ORDER BY e.service_expire_at DESC`,
      [userId]
    );

    if (entitlementRows.length === 0) {
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

    // 计算每个权益的剩余（用于前端选择“退订哪个”）
    const now = new Date();
    const items = entitlementRows.map((e) => {
      const expireAt = new Date(e.service_expire_at);
      const remainingDays = expireAt > now ? Math.max(0, Math.floor((expireAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))) : 0;
      const totalBytes = Number(e.traffic_total_bytes || 0);
      const usedBytes = Number(e.traffic_used_bytes || 0);
      const remainingTrafficBytes = totalBytes < 0 ? -1 : Math.max(0, totalBytes - usedBytes);
      return {
        entitlement_id: e.id,
        group_id: e.group_id,
        group_name: e.group_name,
        plan_id: e.plan_id,
        plan_name: e.plan_name,
        expire_at: e.service_expire_at,
        remaining_days: remainingDays,
        remaining_traffic_bytes: remainingTrafficBytes,
        remaining_traffic_gb: remainingTrafficBytes < 0 ? '-1' : (remainingTrafficBytes / (1024 ** 3)).toFixed(2)
      };
    });

    const target = entitlementId ? items.find((x) => x.entitlement_id === entitlementId) : items[0];

    res.json({
      code: 200,
      message: 'success',
      data: {
        // 兼容旧前端：仍返回单个 remaining/current_plan（默认第一条，或按 entitlement_id 指定）
        remaining_days: target?.remaining_days || 0,
        remaining_traffic_bytes: target?.remaining_traffic_bytes || 0,
        remaining_traffic_gb: target?.remaining_traffic_gb || '0.00',
        current_plan: target
          ? { group_id: target.group_id, group_name: target.group_name, plan_name: target.plan_name, expire_at: target.expire_at }
          : null,
        can_unsubscribe: !!target && ((target.remaining_days || 0) > 0 || (target.remaining_traffic_bytes || 0) > 0),
        entitlements: items
      }
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/orders/unsubscribe 个人中心退订（扣减时长与流量）
router.post('/unsubscribe', auth, async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const userId = req.user.id;
    const { entitlement_id, duration_days_deduct = 0, traffic_gb_deduct = 0, remark = '', full_refund = false } = req.body;

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

    // 从 user_entitlements 获取用户当前有效权益（必须按 entitlement_id 精确退订某一个）
    if (!entitlement_id) {
      connection.release();
      return res.status(400).json({ code: 400, message: '请先选择要退订的套餐（entitlement_id）', data: null });
    }

    const [entitlementRows] = await connection.query(
      `SELECT e.id, e.group_id, e.plan_id, e.service_expire_at, e.traffic_total_bytes, e.traffic_used_bytes,
              pg.name AS group_name, p.name AS plan_name
       FROM user_entitlements e
       JOIN plan_groups pg ON e.group_id = pg.id
       JOIN plans p ON e.plan_id = p.id
       WHERE e.user_id = ? AND e.status = 'active' 
         AND e.service_expire_at > NOW()
         AND (e.traffic_total_bytes < 0 OR e.traffic_used_bytes < e.traffic_total_bytes)
         AND e.id = ?
       LIMIT 1`,
      [userId, Number(entitlement_id)]
    );

    if (entitlementRows.length === 0) {
      connection.release();
      return res.status(400).json({
        code: 400,
        message: '您当前没有生效的套餐',
        data: null
      });
    }

    // 计算该权益剩余天数和流量
    const now = new Date();
    const targetEntitlement = entitlementRows[0];
    const expireAt = new Date(targetEntitlement.service_expire_at);
    const remainingDays = expireAt > now ? Math.max(0, Math.floor((expireAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))) : 0;
    const totalBytes = Number(targetEntitlement.traffic_total_bytes || 0);
    const usedBytes = Number(targetEntitlement.traffic_used_bytes || 0);
    const remainingTraffic = totalBytes < 0 ? Number.MAX_SAFE_INTEGER : Math.max(0, totalBytes - usedBytes);

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

    // 使用目标权益的 plan_id 和 group_id
    const planId = targetEntitlement.plan_id;
    const groupId = targetEntitlement.group_id;
    const orderNo = `UNSUB${Date.now()}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`;
    
    // 创建退订订单（审计用）
    const [orderResult] = await connection.query(
      `INSERT INTO orders
       (user_id, plan_id, order_no, amount, pay_method, status, order_type, duration_days, traffic_amount, remark, created_at, paid_at)
       VALUES (?, ?, ?, 0, 'balance', 'paid', 'unsubscribe', ?, ?, ?, NOW(), NOW())`,
      [userId, planId, orderNo, -finalDaysDeduct, -finalTrafficDeduct, (remark || '').slice(0, 255)]
    );
    const orderId = orderResult.insertId;

    // 更新用户权益
    const updated = await updateUserEntitlementOnUnsubscribe(
      connection,
      userId,
      groupId,
      planId,
      orderId,
      finalDaysDeduct,
      finalTrafficDeduct,
      full_refund,
      remark || '用户退订'
    );
    
    if (!updated) {
      await connection.rollback();
      connection.release();
      return res.status(400).json({
        code: 400,
        message: '无法找到对应的权益记录',
        data: null
      });
    }

    // 同时更新 users 表（兼容旧逻辑）
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

// 基于当前有效权益的升级预览（按剩余流量比例 × 累计金额计算残值）
// GET /api/orders/upgrade-by-entitlement/preview?entitlement_id=xxx&new_plan_id=yyy
router.get('/upgrade-by-entitlement/preview', auth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const entitlementId = Number(req.query.entitlement_id || 0);
    const newPlanId = Number(req.query.new_plan_id || 0);

    if (!entitlementId || !newPlanId) {
      return res.status(400).json({
        code: 400,
        message: '参数不完整，必须提供 entitlement_id 和 new_plan_id',
        data: null
      });
    }

    // 1. 查找当前有效权益
    const [entRows] = await pool.query(
      `SELECT e.id,
              e.user_id,
              e.group_id,
              e.plan_id,
              e.original_started_at,
              e.original_expire_at,
              e.service_started_at,
              e.service_expire_at,
              e.total_amount,
              pg.level AS group_level,
              pg.name  AS group_name,
              p.name   AS plan_name
       FROM user_entitlements e
       JOIN plan_groups pg ON e.group_id = pg.id
       JOIN plans p ON e.plan_id = p.id
       WHERE e.id = ? AND e.user_id = ? AND e.status = 'active'
         AND e.service_expire_at > NOW()
       LIMIT 1`,
      [entitlementId, userId]
    );

    if (entRows.length === 0) {
      return res.status(404).json({
        code: 404,
        message: '指定的权益不存在或已失效',
        data: null
      });
    }

    const ent = entRows[0];

    // 2. 查询新套餐
    const [newPlanRows] = await pool.query(
      `SELECT p.id, p.name, p.price, p.duration_days, p.status, p.is_public,
              pg.level AS level
       FROM plans p
       JOIN plan_groups pg ON p.group_id = pg.id
       WHERE p.id = ? LIMIT 1`,
      [newPlanId]
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

    // 3. 等级校验：新总套餐等级必须 > 旧总套餐等级
    const oldLevel = Number(ent.group_level || 0);
    const newLevel = Number(newPlan.level || 0);
    if (!Number.isNaN(oldLevel) && !Number.isNaN(newLevel) && newLevel <= oldLevel) {
      return res.status(400).json({
        code: 400,
        message: '只能升级到更高级别的套餐',
        data: null
      });
    }

    // 4. 计算“该总套餐（group_id）”的剩余流量比例 + 累计金额
    //   ratio = (group_remaining_traffic / group_total_traffic)
    //   残值 = group_total_amount * ratio
    const [aggRows] = await pool.query(
      `SELECT
          SUM(CASE WHEN e.traffic_total_bytes > 0 THEN e.traffic_total_bytes ELSE 0 END) AS total_traffic_bytes,
          SUM(CASE WHEN e.traffic_total_bytes > 0 THEN LEAST(e.traffic_used_bytes, e.traffic_total_bytes) ELSE 0 END) AS used_traffic_bytes,
          SUM(CASE WHEN e.total_amount > 0 THEN e.total_amount ELSE 0 END) AS total_amount
       FROM user_entitlements e
       WHERE e.user_id = ?
         AND e.group_id = ?
         AND e.status = 'active'
         AND e.service_expire_at > NOW()`,
      [userId, ent.group_id]
    );

    const agg = aggRows && aggRows.length ? aggRows[0] : {};
    const groupTotalTraffic = Number(agg.total_traffic_bytes || 0);
    const groupUsedTraffic = Number(agg.used_traffic_bytes || 0);
    const groupAmount = Number(agg.total_amount || 0);

    // 若总流量为 0（例如无流量套餐），无法按流量计算残值：直接视为无法升级（避免按时间兜底产生误解）
    if (!groupTotalTraffic || groupTotalTraffic <= 0) {
      return res.status(400).json({
        code: 400,
        message: '旧套餐总流量为 0（无流量套餐），无法按流量计算残值',
        data: null
      });
    }

    const groupRemainingTraffic = Math.max(0, groupTotalTraffic - groupUsedTraffic);
    const remainingRatio = groupRemainingTraffic / groupTotalTraffic;

    // 旧套餐累计金额：优先用该总套餐累计金额；如果为 0，再退化为最近一笔已支付订单金额（避免历史数据未回填）
    let baseAmount = groupAmount;
    if (!baseAmount || baseAmount <= 0) {
      const [lastPaid] = await pool.query(
        `SELECT amount
         FROM orders
         WHERE user_id = ? AND status = 'paid'
         ORDER BY COALESCE(paid_at, created_at) DESC, id DESC
         LIMIT 1`,
        [userId]
      );
      baseAmount = lastPaid.length ? Number(lastPaid[0].amount || 0) : 0;
    }

    if (!baseAmount || baseAmount <= 0) {
      return res.status(400).json({
        code: 400,
        message: '找不到可用于计算残值的订单金额，请联系客服处理',
        data: null
      });
    }

    const oldRemainingValue = baseAmount * remainingRatio;

    // 5. 新套餐价格
    const newAmount = Number(newPlan.price || 0);
    if (!newAmount || newAmount <= 0) {
      return res.status(400).json({
        code: 400,
        message: '新套餐价格无效',
        data: null
      });
    }

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
        entitlement: {
          id: ent.id,
          plan_id: ent.plan_id,
          plan_name: ent.plan_name,
          group_name: ent.group_name,
          original_started_at: ent.original_started_at,
          original_expire_at: ent.original_expire_at,
          service_expire_at: ent.service_expire_at,
          total_amount: Number(baseAmount.toFixed(2))
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

// 基于当前有效权益的升级确认：创建一笔补差价订单（pending）
// POST /api/orders/upgrade-by-entitlement/confirm { entitlement_id, new_plan_id, pay_method }
router.post('/upgrade-by-entitlement/confirm', auth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { entitlement_id, new_plan_id, pay_method = 'balance' } = req.body || {};

    const entitlementId = Number(entitlement_id || 0);
    const newPlanId = Number(new_plan_id || 0);

    if (!entitlementId || !newPlanId) {
      return res.status(400).json({
        code: 400,
        message: '参数不完整，必须提供 entitlement_id 和 new_plan_id',
        data: null
      });
    }

    // 1. 再次查当前权益，防止并发
    const [entRows] = await pool.query(
      `SELECT e.id,
              e.user_id,
              e.group_id,
              e.plan_id,
              e.original_started_at,
              e.original_expire_at,
              e.service_started_at,
              e.service_expire_at,
              e.total_amount,
              pg.level AS group_level,
              pg.name  AS group_name,
              p.name   AS plan_name
       FROM user_entitlements e
       JOIN plan_groups pg ON e.group_id = pg.id
       JOIN plans p ON e.plan_id = p.id
       WHERE e.id = ? AND e.user_id = ? AND e.status = 'active'
         AND e.service_expire_at > NOW()
       LIMIT 1`,
      [entitlementId, userId]
    );

    if (entRows.length === 0) {
      return res.status(404).json({
        code: 404,
        message: '指定的权益不存在或已失效',
        data: null
      });
    }

    const ent = entRows[0];

    // 2. 新套餐
    const [newPlanRows] = await pool.query(
      `SELECT p.id, p.name, p.price, p.duration_days, p.status, p.is_public,
              pg.level AS level
       FROM plans p
       JOIN plan_groups pg ON p.group_id = pg.id
       WHERE p.id = ? LIMIT 1`,
      [newPlanId]
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

    // 3. 等级约束：只能从低等级总套餐升级到高等级总套餐
    const oldLevel = Number(ent.group_level || 0);
    const newLevel = Number(newPlan.level || 0);
    if (!Number.isNaN(oldLevel) && !Number.isNaN(newLevel) && newLevel <= oldLevel) {
      return res.status(400).json({
        code: 400,
        message: '只能升级到更高级别的套餐',
        data: null
      });
    }

    // 4. 计算“该总套餐（group_id）”的剩余流量比例 + 累计金额
    const [aggRows] = await pool.query(
      `SELECT
          SUM(CASE WHEN e.traffic_total_bytes > 0 THEN e.traffic_total_bytes ELSE 0 END) AS total_traffic_bytes,
          SUM(CASE WHEN e.traffic_total_bytes > 0 THEN LEAST(e.traffic_used_bytes, e.traffic_total_bytes) ELSE 0 END) AS used_traffic_bytes,
          SUM(CASE WHEN e.total_amount > 0 THEN e.total_amount ELSE 0 END) AS total_amount
       FROM user_entitlements e
       WHERE e.user_id = ?
         AND e.group_id = ?
         AND e.status = 'active'
         AND e.service_expire_at > NOW()`,
      [userId, ent.group_id]
    );

    const agg = aggRows && aggRows.length ? aggRows[0] : {};
    const groupTotalTraffic = Number(agg.total_traffic_bytes || 0);
    const groupUsedTraffic = Number(agg.used_traffic_bytes || 0);
    const groupAmount = Number(agg.total_amount || 0);

    if (!groupTotalTraffic || groupTotalTraffic <= 0) {
      return res.status(400).json({
        code: 400,
        message: '旧套餐总流量为 0（无流量套餐），无法按流量计算残值',
        data: null
      });
    }

    const groupRemainingTraffic = Math.max(0, groupTotalTraffic - groupUsedTraffic);
    const remainingRatio = groupRemainingTraffic / groupTotalTraffic;

    let baseAmount = groupAmount;
    if (!baseAmount || baseAmount <= 0) {
      const [lastPaid] = await pool.query(
        `SELECT amount
         FROM orders
         WHERE user_id = ? AND status = 'paid'
         ORDER BY COALESCE(paid_at, created_at) DESC, id DESC
         LIMIT 1`,
        [userId]
      );
      baseAmount = lastPaid.length ? Number(lastPaid[0].amount || 0) : 0;
    }

    if (!baseAmount || baseAmount <= 0) {
      return res.status(400).json({
        code: 400,
        message: '找不到可用于计算残值的订单金额，请联系客服处理',
        data: null
      });
    }

    const oldRemainingValue = baseAmount * remainingRatio;
    const newAmount = Number(newPlan.price || 0);
    if (!newAmount || newAmount <= 0) {
      return res.status(400).json({
        code: 400,
        message: '新套餐价格无效',
        data: null
      });
    }

    const needPay = newAmount - oldRemainingValue;
    if (needPay < 0) {
      return res.status(400).json({
        code: 400,
        message: '旧套餐残值超过新套餐价格，请联系客服处理',
        data: null
      });
    }

    // 5. 检查是否有未支付订单
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

    // 6. 创建升级订单（金额为需补金额，如果为 0 则免费）
    const orderNo = `ORD${Date.now()}${Math.floor(Math.random() * 1000)
      .toString()
      .padStart(3, '0')}`;

    const finalAmount = Number(needPay.toFixed(2));
    const newDurationDays = Number(newPlan.duration_days || 30);

    const insertSql = `INSERT INTO orders
     (user_id, plan_id, order_no, amount, pay_method, status, order_type, duration_days, traffic_amount, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', 'upgrade', ?, 0, UTC_TIMESTAMP())`;
    const insertParams = [userId, newPlanId, orderNo, finalAmount, payMethod, newDurationDays];

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
        entitlement_id: entitlementId,
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

    let amount = Number(plan.price || 0);

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
    const trafficAmount = Number(plan.traffic_limit || 0);

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
         (user_id, plan_id, order_no, amount, pay_method, status, order_type, duration_days, traffic_amount, created_at, paid_at)
         VALUES (?, ?, ?, ?, ?, 'paid', 'purchase', ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`;
        insertParams = [userId, plan_id, orderNo, 0, pay_method, durationDays, trafficAmount];
      } else {
        insertSql = `INSERT INTO orders
         (user_id, plan_id, order_no, amount, pay_method, status, order_type, duration_days, traffic_amount, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', 'purchase', ?, ?, UTC_TIMESTAMP())`;
        insertParams = [userId, plan_id, orderNo, amount, pay_method, durationDays, trafficAmount];
      }

      const [result] = await connection.query(insertSql, insertParams);

      // 如果是管理员购买（已支付），累加流量并延长到期时间，同时创建/更新权益
      if (isAdmin) {
        if (trafficAmount > 0) {
          await connection.query(
            'UPDATE users SET traffic_total = traffic_total + ? WHERE id = ?',
            [trafficAmount, userId]
          );
        }
        await connection.query(
          `UPDATE users SET
            expired_at = CASE
              WHEN expired_at IS NULL OR expired_at < NOW() THEN DATE_ADD(NOW(), INTERVAL ? DAY)
              ELSE DATE_ADD(expired_at, INTERVAL ? DAY)
            END
           WHERE id = ?`,
          [durationDays, durationDays, userId]
        );
        
        // 创建或更新用户权益
        const paidAt = new Date();
        await upsertUserEntitlement(
          connection,
          userId,
          plan.group_id,
          plan_id,
          result.insertId,
          paidAt,
          durationDays,
          trafficAmount,
          0
        );
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

