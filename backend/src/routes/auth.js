const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

// 生成 JWT
function signToken(user) {
  const payload = {
    id: user.id,
    username: user.username,
    role: user.role
  };
  return jwt.sign(
    payload,
    process.env.JWT_SECRET || 'change_this_to_a_long_random_string',
    {
      expiresIn: process.env.JWT_EXPIRES_IN || '2h'
    }
  );
}

// 用户注册（简单版）
router.post('/register', async (req, res, next) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({
        code: 400,
        message: '用户名、邮箱和密码不能为空',
        data: null
      });
    }

    // 检查是否已存在
    const [existing] = await pool.query(
      'SELECT id FROM users WHERE username = ? OR email = ? LIMIT 1',
      [username, email]
    );
    if (existing.length > 0) {
      return res.status(400).json({
        code: 400,
        message: '用户名或邮箱已被注册',
        data: null
      });
    }

    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(password, salt);

    const [result] = await pool.query(
      'INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)',
      [username, email, hash]
    );

    res.json({
      code: 200,
      message: '注册成功',
      data: { id: result.insertId, username, email }
    });
  } catch (err) {
    // 方便排查 500：查看 docker logs ip_proxy_backend
    console.error('[/api/auth/register]', err?.code || err?.errno, err?.sqlMessage || err?.message, err?.sql || '');
    next(err);
  }
});

// 用户登录
router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        code: 400,
        message: '用户名和密码不能为空',
        data: null
      });
    }

    const [rows] = await pool.query(
      'SELECT id, username, email, password_hash, role, status FROM users WHERE username = ? OR email = ? LIMIT 1',
      [username, username]
    );

    if (rows.length === 0) {
      return res.status(400).json({
        code: 400,
        message: '用户不存在或密码错误',
        data: null
      });
    }

    const user = rows[0];

    if (user.status === 'banned') {
      return res.status(403).json({
        code: 403,
        message: '账户已被封禁',
        data: null
      });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({
        code: 400,
        message: '用户不存在或密码错误',
        data: null
      });
    }

    // 更新最后登录时间
    await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [
      user.id
    ]);

    const token = signToken(user);

    res.json({
      code: 200,
      message: '登录成功',
      data: {
        token,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          role: user.role
        }
      }
    });
  } catch (err) {
    next(err);
  }
});

// 工具函数：获取某个 Date 在 UTC+8 下的“日期字符串”YYYY-MM-DD（用于签到自然日判断，与前端一致）
function getUtc8DateString(date) {
  const d = date instanceof Date ? date : new Date(date);
  const utc8 = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  return utc8.toISOString().slice(0, 10);
}

// GET /api/auth/me 获取当前登录用户详细信息（含流量、到期时间、签到信息等）
router.get('/me', authMiddleware, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const [rows] = await pool.query(
      `SELECT id, username, email, role, status, balance,
              traffic_total, traffic_used, expired_at,
              created_at, last_login_at,
              last_signin_at, signin_streak
       FROM users
       WHERE id = ? LIMIT 1`,
      [userId]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        code: 404,
        message: '用户不存在',
        data: null
      });
    }

    res.json({
      code: 200,
      message: 'success',
      data: rows[0]
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/signin 每日签到（UTC+8 按日重置，随机赠送 0-100MB 流量）
router.post('/signin', authMiddleware, async (req, res, next) => {
  const userId = req.user.id;
  const now = new Date();
  // 严格按 UTC+8 自然日，字符串 YYYY-MM-DD，与 user_signins.date 比较
  const todayUtc8 = getUtc8DateString(now);

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // 1. 检查今天是否已经签到（按 UTC+8 的 date 字段）
    const [todayRows] = await connection.query(
      'SELECT id, bonus_traffic FROM user_signins WHERE user_id = ? AND date = ? LIMIT 1',
      [userId, todayUtc8]
    );

    if (todayRows.length > 0) {
      // 已签到，返回今天的奖励值（幂等）
      const [userRows] = await connection.query(
        'SELECT traffic_total, traffic_used, last_signin_at, signin_streak FROM users WHERE id = ? LIMIT 1',
        [userId]
      );

      const user = userRows[0] || {};

      await connection.commit();
      return res.json({
        code: 200,
        message: '今天已签到',
        data: {
          todaySigned: true,
          alreadySigned: true,
          bonusTraffic: todayRows[0].bonus_traffic,
          signinStreak: user.signin_streak || 0,
          trafficTotal: user.traffic_total || 0
        }
      });
    }

    // 2. 读取当前用户签到状态，计算连续签到天数
    const [userRows] = await connection.query(
      'SELECT traffic_total, traffic_used, last_signin_at, signin_streak FROM users WHERE id = ? LIMIT 1',
      [userId]
    );

    if (userRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({
        code: 404,
        message: '用户不存在',
        data: null
      });
    }

    const user = userRows[0];

    let newStreak = 1;
    if (user.last_signin_at) {
      const lastSigninDateStr = getUtc8DateString(user.last_signin_at);
      const yesterdayUtc8 = getUtc8DateString(
        new Date(now.getTime() - 24 * 60 * 60 * 1000)
      );
      if (lastSigninDateStr === yesterdayUtc8) {
        newStreak = (user.signin_streak || 0) + 1;
      }
    }

    // 3. 随机奖励 0-100MB（字节）
    const maxBonusBytes = 100 * 1024 * 1024;
    const bonusBytes = Math.floor(Math.random() * (maxBonusBytes + 1));

    const newTrafficTotal =
      Number(user.traffic_total || 0) + Number(bonusBytes || 0);

    // 4. 查找"签到套餐"的 plan_id
    const [signinPlanRows] = await connection.query(
      `SELECT p.id AS plan_id
       FROM plans p
       JOIN plan_groups pg ON p.group_id = pg.id
       WHERE pg.group_key = 'signin' AND p.status = 1
       LIMIT 1`
    );

    let signinPlanId = null;
    if (signinPlanRows.length > 0) {
      signinPlanId = signinPlanRows[0].plan_id;
    }

    // 5. 处理套餐：检查用户是否有有效套餐
    let hasActivePlan = false;
    let currentExpireAt = null;

    if (signinPlanId) {
      // 查询用户当前所有已支付订单，计算是否有有效套餐
      const [orderRows] = await connection.query(
        `SELECT o.id, o.plan_id, o.duration_days, o.paid_at, o.created_at,
                p.id AS plan_id, pg.group_key
         FROM orders o
         JOIN plans p ON o.plan_id = p.id
         JOIN plan_groups pg ON p.group_id = pg.id
         WHERE o.user_id = ? AND o.status = 'paid'
         ORDER BY COALESCE(o.paid_at, o.created_at) ASC, o.id ASC`,
        [userId]
      );

      if (orderRows.length > 0) {
        // 按套餐分组，计算每个套餐的到期时间
        const byPlan = new Map();
        for (const o of orderRows) {
          if (!byPlan.has(o.plan_id)) byPlan.set(o.plan_id, []);
          byPlan.get(o.plan_id).push(o);
        }

        // 找出所有有效套餐的到期时间
        const activeExpires = [];
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
            activeExpires.push(accExpire);
            hasActivePlan = true;
          }
        }

        // 取最晚的到期时间作为当前到期时间
        if (activeExpires.length > 0) {
          currentExpireAt = new Date(Math.max(...activeExpires.map((e) => e.getTime())));
        }
      }

      // 6. 创建签到订单（延长套餐10分钟或创建新套餐）
      const signinDurationDays = 1; // 1天
      const signinBonusMinutes = 10; // 签到奖励10分钟
      const signinBonusMs = signinBonusMinutes * 60 * 1000; // 10分钟的毫秒数
      const oneDayMs = 24 * 60 * 60 * 1000; // 1天的毫秒数

      let signinPaidAt;
      if (hasActivePlan && currentExpireAt) {
        // 已有套餐：延长10分钟
        // paid_at 设置为：当前到期时间 - (1天 - 10分钟)
        // 这样 paid_at + 1天 = 当前到期时间 + 10分钟
        signinPaidAt = new Date(currentExpireAt.getTime() - (oneDayMs - signinBonusMs));
      } else {
        // 没有套餐：创建新套餐，有效期10分钟
        // paid_at 设置为：当前时间 - (1天 - 10分钟)
        // 这样 paid_at + 1天 = 当前时间 + 10分钟
        signinPaidAt = new Date(now.getTime() - (oneDayMs - signinBonusMs));
      }

      // 生成订单号
      const orderNo = `SIGNIN${Date.now()}${Math.floor(Math.random() * 1000)}`;

      // 创建签到订单（自动已支付，金额为0，pay_method 复用 balance，避免 ENUM 截断）
      await connection.query(
        `INSERT INTO orders (user_id, order_no, plan_id, amount, status, pay_method, duration_days, paid_at, created_at)
         VALUES (?, ?, ?, 0.00, 'paid', 'balance', ?, ?, NOW())`,
        [userId, orderNo, signinPlanId, signinDurationDays, signinPaidAt]
      );

      // 如果签到套餐有流量配额，也累加到用户流量（但这里我们让流量单独处理，套餐只负责时间）
    }

    // 7. 写入签到记录 & 更新用户表（放在同一事务中）
    await connection.query(
      'INSERT INTO user_signins (user_id, date, bonus_traffic) VALUES (?, ?, ?)',
      [userId, todayUtc8, bonusBytes]
    );

    await connection.query(
      'UPDATE users SET traffic_total = ?, last_signin_at = NOW(), signin_streak = ? WHERE id = ?',
      [newTrafficTotal, newStreak, userId]
    );

    await connection.commit();

    res.json({
      code: 200,
      message: '签到成功',
      data: {
        todaySigned: true,
        alreadySigned: false,
        bonusTraffic: bonusBytes,
        signinStreak: newStreak,
        trafficTotal: newTrafficTotal,
        planExtended: hasActivePlan,
        planCreated: !hasActivePlan && signinPlanId !== null
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
});

module.exports = router;

