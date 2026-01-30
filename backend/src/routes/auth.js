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

    // 4. 查找"签到套餐"的 plan_id（用于“没有任何套餐时”创建一个可退订的签到套餐）
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

    // 5. 处理签到权益：优先把奖励加到“时间价值最高”的现有套餐；没有任何套餐时创建一个签到套餐权益
    let planExtended = false;
    let planCreated = false;

    // 5.1 查找用户当前有效权益（按 service_expire_at 从晚到早排，选最晚到期的那一个）
    const [entRows] = await connection.query(
      `SELECT e.id, e.service_expire_at, e.traffic_total_bytes, e.traffic_used_bytes
       FROM user_entitlements e
       WHERE e.user_id = ? 
         AND e.status = 'active'
         AND e.service_expire_at > NOW()
       ORDER BY e.service_expire_at DESC
       LIMIT 1`,
      [userId]
    );

    const signinBonusMinutes = 10; // 签到奖励10分钟

    if (entRows.length > 0) {
      // 已有至少一个有效套餐：把签到奖励加到“时间价值最高”的那个权益上
      const target = entRows[0];
      await connection.query(
        `UPDATE user_entitlements 
         SET service_expire_at = DATE_ADD(service_expire_at, INTERVAL ? MINUTE),
             traffic_total_bytes = traffic_total_bytes + ?,
             updated_at = NOW()
         WHERE id = ?`,
        [signinBonusMinutes, bonusBytes, target.id]
      );
      planExtended = true;
    } else if (signinPlanId) {
      // 没有任何有效套餐：使用签到套餐 plan 创建一个新的权益（可在前端展示/管理员退订）
      const start = now;
      const expire = new Date(now.getTime() + signinBonusMinutes * 60 * 1000);
      const startStr = start.toISOString().slice(0, 19).replace('T', ' ');
      const expireStr = expire.toISOString().slice(0, 19).replace('T', ' ');

      await connection.query(
        `INSERT INTO user_entitlements 
         (user_id, group_id, plan_id, status,
          original_started_at, original_expire_at,
          service_started_at, service_expire_at,
          traffic_total_bytes, traffic_used_bytes,
          last_order_id, created_at, updated_at)
         SELECT ?, pg.id, p.id, 'active',
                ?, ?, ?, ?, ?, 0, NULL, NOW(), NOW()
         FROM plans p
         JOIN plan_groups pg ON p.group_id = pg.id
         WHERE p.id = ?
         LIMIT 1`,
        [userId, startStr, expireStr, startStr, expireStr, bonusBytes, signinPlanId]
      );
      planCreated = true;
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
        planExtended,
        planCreated
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

