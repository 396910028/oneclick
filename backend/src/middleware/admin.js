/**
 * 管理员权限中间件：须在 auth 之后使用，校验 req.user.role === 'admin'
 * 否则返回 403
 */
function adminOnly(req, res, next) {
  if (req.user && req.user.role === 'admin') {
    return next();
  }
  return res.status(403).json({
    code: 403,
    message: '需要管理员权限',
    data: null
  });
}

module.exports = adminOnly;
