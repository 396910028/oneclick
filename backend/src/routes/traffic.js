const express = require('express');
const pool = require('../config/db');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

// GET /api/traffic/history?rangeMinutes=1440
// 返回当前登录用户最近 rangeMinutes 分钟的分钟级流量统计，用于总览图表
router.get('/history', authMiddleware, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const rawRange = Number(req.query.rangeMinutes || 1440); // 默认 24 小时
    const rangeMinutes = Number.isFinite(rawRange) && rawRange > 0 ? rawRange : 1440;
    // 最长限制：7 天，避免一次性拉太多数据
    const maxMinutes = 7 * 24 * 60;
    const finalRange = Math.min(rangeMinutes, maxMinutes);

    const since = new Date(Date.now() - finalRange * 60 * 1000);

    const [rows] = await pool.query(
      `SELECT ts_minute, upload, download
       FROM user_traffic_minute
       WHERE user_id = ?
         AND ts_minute >= ?
       ORDER BY ts_minute ASC`,
      [userId, since]
    );

    res.json({
      code: 200,
      message: 'success',
      data: {
        rangeMinutes: finalRange,
        points: rows.map((r) => ({
          ts: r.ts_minute,
          upload: Number(r.upload || 0),
          download: Number(r.download || 0)
        }))
      }
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

