const express = require('express');
const pool = require('../config/db');

const router = express.Router();

// 获取套餐列表（plans，类似 XBoard 的订阅计划）
router.get('/', async (req, res, next) => {
  try {
    const { page = 1, size = 20, keyword = '' } = req.query;

    const limit = Number(size) || 20;
    const offset = (Number(page) - 1) * limit;

    const params = [];
    const planConditions = ['p.status = 1', 'p.is_public = 1', 'pg.status = 1', 'pg.is_public = 1'];
    if (keyword) {
      planConditions.push('p.name LIKE ?');
      params.push(`%${keyword}%`);
    }
    const where = planConditions.join(' AND ');

    const [rows] = await pool.query(
      `SELECT p.id,
              p.name,
              p.description,
              p.price,
              p.duration_days,
              p.traffic_limit,
              p.speed_limit,
              p.connections,
              p.is_public,
              p.status,
              pg.id AS group_id,
              pg.group_key,
              pg.name AS group_name,
              pg.level AS level,
              pg.is_exclusive AS is_exclusive
       FROM plans p
       JOIN plan_groups pg ON p.group_id = pg.id
       WHERE ${where}
       ORDER BY pg.id ASC, p.id ASC
       LIMIT ?, ?`,
      [...params, offset, limit]
    );

    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total FROM plans p JOIN plan_groups pg ON p.group_id = pg.id WHERE ${where}`,
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

// 获取单个套餐详情
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.query(
      `SELECT p.id,
              p.name,
              p.description,
              p.price,
              p.duration_days,
              p.traffic_limit,
              p.speed_limit,
              p.connections,
              p.is_public,
              p.status,
              pg.id AS group_id,
              pg.group_key,
              pg.name AS group_name,
              pg.level AS level,
              pg.is_exclusive AS is_exclusive
       FROM plans p
       JOIN plan_groups pg ON p.group_id = pg.id
       WHERE p.id = ? AND pg.status = 1 AND pg.is_public = 1 LIMIT 1`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        code: 404,
        message: '套餐不存在',
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

module.exports = router;

