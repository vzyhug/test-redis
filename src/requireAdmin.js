const { client } = require('./redisClient');

async function requireAdmin(req, res, next) {
  try {
    const userId = req.session && req.session.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập' });

    // Read the current account role on each admin request; session role may be stale.
    const key = `user:${userId}`;
    if (await client.type(key) !== 'hash') {
      res.clearCookie('sessionId');
      return res.status(401).json({ success: false, message: 'Tài khoản không còn hợp lệ' });
    }
    const role = await client.hGet(key, 'role');
    if (role !== 'ADMIN') {
      return res.status(403).json({ success: false, message: 'Không có quyền quản trị' });
    }
    req.admin = { userId };
    return next();
  } catch (error) {
    console.error('[requireAdmin] Failed to verify administrator role:', error.message);
    return res.status(500).json({ success: false, message: 'Lỗi máy chủ' });
  }
}

module.exports = requireAdmin;
