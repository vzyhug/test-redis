// ============================================================
// authMiddleware.js - Kiểm tra phiên đăng nhập bằng Redis
// ============================================================
const { getSession, refreshSession, SESSION_TTL } = require('./sessionService');

async function authMiddleware(req, res, next) {
  try {
    // 1. Lấy sessionId từ cookie
    const sessionId = req.cookies.sessionId;
    if (!sessionId) {
      return res.status(401).json({ success: false, message: 'Chưa đăng nhập' });
    }

    // 2-3. EXISTS + HGETALL session:<sessionId>
    const session = await getSession(sessionId);
    if (!session) {
      res.clearCookie('sessionId');
      return res
        .status(401)
        .json({ success: false, message: 'Phiên đăng nhập không tồn tại hoặc đã hết hạn' });
    }

    // 4. Sliding session: mỗi request hợp lệ gia hạn TTL về 1800s
    await refreshSession(sessionId);
    res.cookie('sessionId', sessionId, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: SESSION_TTL * 1000,
    });

    // 5. Gắn dữ liệu vào req.session rồi cho đi tiếp
    req.session = { ...session, sessionId };
    next();
  } catch (err) {
    console.error('[authMiddleware] Lỗi:', err.message);
    res.status(500).json({ success: false, message: 'Lỗi máy chủ khi kiểm tra phiên' });
  }
}

module.exports = authMiddleware;
