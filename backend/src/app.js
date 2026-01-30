require('dotenv').config();

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const pool = require('./config/db');

const authRoutes = require('./routes/auth');
// 这里的 plans 路由实际文件仍然叫 products.js，为了兼容直接复用
const planRoutes = require('./routes/products');
const orderRoutes = require('./routes/orders');
const ticketRoutes = require('./routes/tickets');
const adminRoutes = require('./routes/admin');
const subscriptionRoutes = require('./routes/subscription');
const internalRoutes = require('./routes/internal');
const nodeAgentRoutes = require('./routes/node_agent');
const trafficRoutes = require('./routes/traffic');

const app = express();

// 中间件
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

// 健康检查
app.get('/api/health', async (req, res) => {
  try {
    // 简单测试一下数据库连接
    const [rows] = await pool.query('SELECT 1 AS ok');
    res.json({
      code: 200,
      message: 'OK',
      data: {
        db: rows[0].ok === 1 ? 'connected' : 'unknown'
      }
    });
  } catch (err) {
    console.error('Health check error:', err);
    res.status(500).json({
      code: 500,
      message: 'Health check failed',
      data: {
        db: 'error'
      }
    });
  }
});

// 路由
app.use('/api/auth', authRoutes);
app.use('/api/plans', planRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/tickets', ticketRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/admin', nodeAgentRoutes);
app.use('/api/subscription', subscriptionRoutes);
app.use('/api/sub', subscriptionRoutes); // 订阅链接访问路径
app.use('/api/internal', internalRoutes); // 仅供节点/对接程序调用（需 x-internal-token）
app.use('/api/traffic', trafficRoutes); // 用户流量统计（总览图表）

// 全局错误处理（MySQL 错误会带 code、sqlMessage，便于 docker logs 排查）
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err?.code, err?.sqlMessage || err?.message, err?.sql || '');
  res.status(500).json({
    code: 500,
    message: err.message || '服务器错误',
    data: null
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Backend server is running on http://localhost:${PORT}`);
});

