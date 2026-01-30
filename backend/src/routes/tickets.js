const express = require('express');
const pool = require('../config/db');
const auth = require('../middleware/auth');

const router = express.Router();

// 获取当前用户的工单列表
router.get('/', auth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { page = 1, size = 20, status = '' } = req.query;
    const limit = Number(size) || 20;
    const offset = (Number(page) - 1) * limit;

    const conditions = ['user_id = ?'];
    const params = [userId];

    if (status) {
      conditions.push('status = ?');
      params.push(status);
    }

    const where = conditions.join(' AND ');

    const [rows] = await pool.query(
      `SELECT id, ticket_no, title, category, status, priority, created_at, updated_at
       FROM tickets
       WHERE ${where}
       ORDER BY id DESC
       LIMIT ?, ?`,
      [...params, offset, limit]
    );

    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total FROM tickets WHERE ${where}`,
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

// 创建工单
router.post('/', auth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { title, content, category = 'other', priority = 'medium' } = req.body;

    if (!title || !content) {
      return res.status(400).json({
        code: 400,
        message: '标题和内容不能为空',
        data: null
      });
    }

    const ticketNo = `TK${Date.now()}${Math.floor(Math.random() * 1000)
      .toString()
      .padStart(3, '0')}`;

    const [result] = await pool.query(
      `INSERT INTO tickets
       (user_id, ticket_no, title, content, category, status, priority, created_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?, NOW())`,
      [userId, ticketNo, title, content, category, priority]
    );

    res.json({
      code: 200,
      message: '工单创建成功',
      data: {
        id: result.insertId,
        ticket_no: ticketNo
      }
    });
  } catch (err) {
    next(err);
  }
});

// 获取工单详情（含回复）
router.get('/:id', auth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;
    const { id } = req.params;

    let tickets;
    if (userRole === 'admin') {
      // 管理员可查看任意工单
      [tickets] = await pool.query(
        `SELECT id, ticket_no, title, content, category, status, priority, created_at, updated_at
         FROM tickets
         WHERE id = ?
         LIMIT 1`,
        [id]
      );
    } else {
      [tickets] = await pool.query(
        `SELECT id, ticket_no, title, content, category, status, priority, created_at, updated_at
         FROM tickets
         WHERE id = ? AND user_id = ?
         LIMIT 1`,
        [id, userId]
      );
    }

    if (tickets.length === 0) {
      return res.status(404).json({
        code: 404,
        message: '工单不存在',
        data: null
      });
    }

    const ticket = tickets[0];

    const [replies] = await pool.query(
      `SELECT id, user_id, is_admin, content, attachments, created_at
       FROM ticket_replies
       WHERE ticket_id = ?
       ORDER BY id ASC`,
      [id]
    );

    res.json({
      code: 200,
      message: 'success',
      data: {
        ticket,
        replies
      }
    });
  } catch (err) {
    next(err);
  }
});

// 回复工单
router.post('/:id/reply', auth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const { content } = req.body;

    if (!content) {
      return res.status(400).json({
        code: 400,
        message: '回复内容不能为空',
        data: null
      });
    }

    // 检查工单是否属于当前用户
    const [tickets] = await pool.query(
      'SELECT id FROM tickets WHERE id = ? AND user_id = ? LIMIT 1',
      [id, userId]
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
       VALUES (?, ?, 0, ?, NOW())`,
      [id, userId, content]
    );

    // 用户追加回复后，重新标记为“待处理”
    await pool.query(
      `UPDATE tickets
       SET status = 'open', updated_at = NOW()
       WHERE id = ?`,
      [id]
    );

    res.json({
      code: 200,
      message: '回复成功',
      data: null
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

