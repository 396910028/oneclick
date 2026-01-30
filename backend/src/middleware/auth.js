const jwt = require('jsonwebtoken');
const pool = require('../config/db');

// 验证登录的中间件：除校验 Token 外，每次请求都会到数据库确认用户仍然存在且未被停用
async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;

  if (!token) {
    return res.status(401).json({
      code: 401,
      message: '未登录或Token缺失',
      data: null
    });
  }

  let decoded;
  try {
    decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || 'change_this_to_a_long_random_string'
    );
  } catch (err) {
    return res.status(401).json({
      code: 401,
      message: 'Token无效或已过期',
      data: null
    });
  }

  try {
    const [rows] = await pool.query(
      'SELECT id, username, email, role, status FROM users WHERE id = ? LIMIT 1',
      [decoded.id]
    );

    if (rows.length === 0) {
      return res.status(401).json({
        code: 401,
        message: '用户不存在或已被删除',
        data: null
      });
    }

    const user = rows[0];
    if (user.status === 'banned') {
      return res.status(403).json({
        code: 403,
        message: '账户已被停用',
        data: null
      });
    }

    // 始终以数据库中的最新信息为准
    req.user = {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      status: user.status
    };

    next();
  } catch (err) {
    next(err);
  }
}

module.exports = authMiddleware;


