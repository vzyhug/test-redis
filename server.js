// ============================================================
// server.js - Express server + các API
// ============================================================
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const path = require('path');

const { client, connectRedis } = require('./src/redisClient');
const authMiddleware = require('./src/authMiddleware');
const requireAdmin = require('./src/requireAdmin');
const adminService = require('./src/adminService');
const auditService = require('./src/auditService');
const sessionService = require('./src/sessionService');
const securityService = require('./src/securityService');
const reportController = require('./src/reportController');
const firestoreSync = require('./src/firestoreSync');

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(express.json());
app.use(cookieParser());

function adminMutationOriginFirst(req, res, next) {
  // Keep unauthenticated requests at 401 without touching Redis; for cookie requests
  // check Origin before authMiddleware can refresh any session TTL.
  if (!req.cookies.sessionId) return authMiddleware(req, res, next);
  return sameOriginMutation(req, res, next);
}

function sameOriginMutation(req, res, next) {
  const origin = req.get('Origin');
  const expected = `${req.protocol}://${req.get('host')}`;
  if (!origin || origin !== expected) {
    return res.status(403).json({ success: false, message: 'Yêu cầu không hợp lệ' });
  }
  return next();
}

// Truy cập "/" -> chuyển tới trang đăng nhập (đặt trước express.static)
app.get('/', (req, res) => res.redirect('/login.html'));

app.get('/admin.html', authMiddleware, requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/history.html', authMiddleware, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'history.html'));
});
app.get('/admin-history.html', authMiddleware, requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'history.html'));
});
app.get('/security.html', authMiddleware, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'security.html'));
});
app.get('/reports.html', authMiddleware, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'reports.html'));
});

// Phục vụ file tĩnh trong thư mục public
app.use(express.static(path.join(__dirname, 'public')));

function parseAdminPage(req) {
  const rawLimit = Number.parseInt(req.query.limit, 10);
  const rawOffset = Number.parseInt(req.query.offset, 10);
  return {
    limit: Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 25,
    offset: Number.isFinite(rawOffset) ? Math.min(1000000, Math.max(0, rawOffset)) : 0,
    search: typeof req.query.q === 'string' ? req.query.q.slice(0, 64) : '',
  };
}

function syncAdminAccountProfile(profile) {
  void firestoreSync.saveUserProfile(profile).catch((error) => {
    console.error('[Firestore] Could not sync Admin account profile:', error.message);
  });
}
app.get('/api/admin/overview', authMiddleware, requireAdmin, async (req, res) => {
  try {
    return res.json(await adminService.getOverview());
  } catch (error) {
    console.error('[GET /api/admin/overview]', error.message);
    return res.status(500).json({ success: false, message: 'Lỗi máy chủ' });
  }
});

app.get('/api/admin/users', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const page = await adminService.listUsers(parseAdminPage(req));
    return res.json(page);
  } catch (error) {
    console.error('[GET /api/admin/users]', error.message);
    return res.status(500).json({ success: false, message: 'Lỗi máy chủ' });
  }
});

app.post('/api/admin/users', adminMutationOriginFirst, authMiddleware, requireAdmin, sameOriginMutation, async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const passwordHash = await bcrypt.hash(String(body.password || ''), 10);
    const user = await adminService.createUser(body, passwordHash);
    return res.status(201).json({ success: true, user });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, message: error.message });
    console.error('[POST /api/admin/users]', error.message);
    return res.status(500).json({ success: false, message: 'Lỗi máy chủ' });
  }
});

app.patch('/api/admin/users/:userId', adminMutationOriginFirst, authMiddleware, requireAdmin, sameOriginMutation, async (req, res) => {
  try {
    const userId = req.params.userId;
    const current = await adminService.getUser(userId);
    if (!current) return res.status(404).json({ success: false, message: 'Không tìm thấy tài khoản' });
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const requestedRole = typeof body.role === 'string' ? body.role.toUpperCase() : '';
    if (userId === req.session.userId && requestedRole && requestedRole !== 'ADMIN') {
      return res.status(409).json({ success: false, message: 'Không thể tự hạ quyền tài khoản Admin đang đăng nhập' });
    }
    if (current.role === 'ADMIN' && requestedRole === 'USER' && await adminService.countAdmins() <= 1) {
      return res.status(409).json({ success: false, message: 'Hệ thống phải còn ít nhất một tài khoản Admin' });
    }
    const passwordHash = body.password ? await bcrypt.hash(String(body.password), 10) : null;
    const usernameChanged = typeof body.username === 'string' && current.username !== body.username.trim();
    let revokedCount = 0;
    let currentSessionRevoked = false;
    if (passwordHash || usernameChanged || (requestedRole && current.role !== requestedRole)) {
      const outcome = await sessionService.revokeAllSessions(userId, {
        eventType: 'ADMIN_LOGOUT_ALL', actorUserId: req.session.userId,
        actorRole: 'ADMIN', actorUsername: req.session.username,
        ip: getClientIp(req), device: String(req.headers['user-agent'] || '').slice(0, 256),
      });
      revokedCount = outcome.revokedCount;
      currentSessionRevoked = userId === req.session.userId;
      if (currentSessionRevoked) res.clearCookie('sessionId');
    }
    const user = await adminService.updateUser(userId, body, passwordHash);
    syncAdminAccountProfile({ userId: user.userId, username: user.username, email: user.email, role: user.role, status: 'active' });
    return res.json({ success: true, user, revokedCount, currentSessionRevoked });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, message: error.message });
    console.error('[PATCH /api/admin/users/:userId]', error.message);
    return res.status(500).json({ success: false, message: 'Lỗi máy chủ' });
  }
});

app.delete('/api/admin/users/:userId', adminMutationOriginFirst, authMiddleware, requireAdmin, sameOriginMutation, async (req, res) => {
  try {
    const userId = req.params.userId;
    const user = await adminService.getUser(userId);
    if (!user) return res.status(404).json({ success: false, message: 'Không tìm thấy tài khoản' });
    if (userId === req.session.userId) {
      return res.status(409).json({ success: false, message: 'Không thể xóa tài khoản Admin đang đăng nhập' });
    }
    if (user.role === 'ADMIN' && await adminService.countAdmins() <= 1) {
      return res.status(409).json({ success: false, message: 'Hệ thống phải còn ít nhất một tài khoản Admin' });
    }
    const outcome = await sessionService.revokeAllSessions(userId, {
      eventType: 'ADMIN_LOGOUT_ALL', actorUserId: req.session.userId,
      actorRole: 'ADMIN', actorUsername: req.session.username,
      ip: getClientIp(req), device: String(req.headers['user-agent'] || '').slice(0, 256),
    });
    const deleted = await adminService.deleteUser(userId);
    syncAdminAccountProfile({ userId, username: '', email: '', role: 'USER', status: 'deleted', displayName: '' });
    return res.json({ success: true, userId, revokedCount: outcome.revokedCount, deletedSessionCount: deleted.deletedSessionCount });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, message: error.message });
    console.error('[DELETE /api/admin/users/:userId]', error.message);
    return res.status(500).json({ success: false, message: 'Lỗi máy chủ' });
  }
});

app.get('/api/admin/users/:userId/sessions', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const result = await adminService.getUserSessions(req.params.userId, req.session.sessionId);
    if (!result) return res.status(404).json({ success: false, message: 'Không tìm thấy tài khoản' });
    return res.json(result);
  } catch (error) {
    console.error('[GET /api/admin/users/:userId/sessions]', error.message);
    return res.status(500).json({ success: false, message: 'Lỗi máy chủ' });
  }
});

app.delete('/api/admin/users/:userId/sessions/:managementId', adminMutationOriginFirst, authMiddleware, requireAdmin, sameOriginMutation, async (req, res) => {
  try {
    const targetUser = await adminService.getUser(req.params.userId);
    if (!targetUser || !/^[0-9a-f-]{36}$/i.test(req.params.managementId)) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy phiên' });
    }
    // Empty current ID opts into admin-authorized revocation of any target session,
    // including the administrator's own current session.
    const result = await sessionService.revokeSession(req.params.userId, req.params.managementId, '', {
      eventType: 'ADMIN_SESSION_REVOKED', actorUserId: req.session.userId,
      actorRole: 'ADMIN', actorUsername: req.session.username,
      ip: getClientIp(req), device: String(req.headers['user-agent'] || '').slice(0, 256),
    });
    if (result.status !== 'REVOKED') return res.status(404).json({ success: false, message: 'Không tìm thấy phiên' });
    const currentRevoked = req.session.userId === req.params.userId
      && req.session.managementId === req.params.managementId;
    if (currentRevoked) res.clearCookie('sessionId');
    return res.json({ success: true, currentSessionRevoked: currentRevoked, auditRecorded: result.auditRecorded });
  } catch (error) {
    console.error('[DELETE /api/admin/users/:userId/sessions/:managementId]', error.message);
    return res.status(500).json({ success: false, message: 'Lỗi máy chủ' });
  }
});

app.post('/api/admin/users/:userId/logout-all', adminMutationOriginFirst, authMiddleware, requireAdmin, sameOriginMutation, async (req, res) => {
  try {
    if (!await adminService.getUser(req.params.userId)) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy tài khoản' });
    }
    const outcome = await sessionService.revokeAllSessions(req.params.userId, {
      eventType: 'ADMIN_LOGOUT_ALL', actorUserId: req.session.userId,
      actorRole: 'ADMIN', actorUsername: req.session.username,
      ip: getClientIp(req), device: String(req.headers['user-agent'] || '').slice(0, 256),
    });
    const currentRevoked = req.session.userId === req.params.userId;
    if (currentRevoked) res.clearCookie('sessionId');
    return res.json({ success: true, revokedCount: outcome.revokedCount, currentSessionRevoked: currentRevoked, auditRecorded: outcome.auditRecorded });
  } catch (error) {
    console.error('[POST /api/admin/users/:userId/logout-all]', error.message);
    return res.status(500).json({ success: false, message: 'Lỗi máy chủ' });
  }
});

function sendSecurityError(res, route, error) {
  const message = String(error?.message || '');
  if (/^(limit|severity|status|alertType|userId|q|from|to|cursor) /.test(message)) {
    return res.status(400).json({ success: false, message });
  }
  console.error(`[${route}]`, message);
  return res.status(500).json({ success: false, message: 'Lỗi máy chủ' });
}

app.get('/api/security/overview', authMiddleware, async (req, res) => {
  try { return res.json(await securityService.getOverview(securityService.userIndex(req.session.userId))); }
  catch (error) { return sendSecurityError(res, 'GET /api/security/overview', error); }
});

app.get('/api/security/alerts', authMiddleware, async (req, res) => {
  try {
    if (req.query.userId !== undefined) return res.status(400).json({ success: false, message: 'Không thể chỉ định userId cho cảnh báo cá nhân' });
    return res.json(await securityService.listAlerts(securityService.userIndex(req.session.userId), req.query));
  } catch (error) { return sendSecurityError(res, 'GET /api/security/alerts', error); }
});

app.get('/api/security/alerts/:alertId', authMiddleware, async (req, res) => {
  try {
    const alert = await securityService.getAlert(req.params.alertId, req.session.userId, req.session.managementId);
    if (!alert) return res.status(404).json({ success: false, message: 'Không tìm thấy cảnh báo' });
    return res.json({ alert, events: await securityService.readAlertEvents(alert.alertId) });
  } catch (error) { return sendSecurityError(res, 'GET /api/security/alerts/:alertId', error); }
});

app.patch('/api/security/alerts/:alertId/read', authMiddleware, sameOriginMutation, async (req, res) => {
  try {
    const alert = await securityService.getAlert(req.params.alertId, req.session.userId);
    if (!alert) return res.status(404).json({ success: false, message: 'Không tìm thấy cảnh cảnh báo' });
    const result = await securityService.mutateAlert({ userId: req.session.userId, alertId: alert.alertId, action: 'READ', actorUserId: req.session.userId });
    if (result.status === 'NOT_FOUND') return res.status(404).json({ success: false, message: 'Không tìm thấy cảnh báo' });
    return res.json({ success: true, changed: result.status === 'UPDATED', readAt: result.value, historyRecorded: result.historyRecorded });
  } catch (error) { return sendSecurityError(res, 'PATCH /api/security/alerts/:alertId/read', error); }
});

app.patch('/api/security/alerts/:alertId/resolve', authMiddleware, sameOriginMutation, async (req, res) => {
  try {
    if (req.body?.action !== 'safe') return res.status(400).json({ success: false, message: 'action phải là safe' });
    const alert = await securityService.getAlert(req.params.alertId, req.session.userId);
    if (!alert) return res.status(404).json({ success: false, message: 'Không tìm thấy cảnh báo' });
    const result = await securityService.mutateAlert({ userId: req.session.userId, alertId: alert.alertId, action: 'RESOLVE_SAFE', actorUserId: req.session.userId });
    if (result.status === 'NOT_FOUND') return res.status(404).json({ success: false, message: 'Không tìm thấy cảnh báo' });
    if (result.status !== 'UPDATED') return res.status(409).json({ success: false, message: 'Cảnh báo đã được xử lý hoặc đang được xử lý', status: result.value });
    return res.json({ success: true, status: result.value, historyRecorded: result.historyRecorded });
  } catch (error) { return sendSecurityError(res, 'PATCH /api/security/alerts/:alertId/resolve', error); }
});

async function revokeAlertSession(req, res, isAdmin) {
  let targetUserId;
  let alertId;
  let claimed = false;
  try {
    alertId = req.params.alertId;
    const record = await securityService.getAlertSession(alertId, isAdmin ? null : req.session.userId);
    if (!record) return res.status(404).json({ success: false, message: 'Không tìm thấy cảnh báo' });
    targetUserId = record.userId;
    if (!record.managementId) return res.status(409).json({ success: false, message: 'Cảnh báo không liên kết với phiên có thể thu hồi' });
    const claim = await securityService.mutateAlert({ userId: targetUserId, alertId, action: 'CLAIM_REVOKE', actorUserId: req.session.userId });
    if (claim.status !== 'CLAIMED') {
      if (claim.status === 'NOT_FOUND') return res.status(404).json({ success: false, message: 'Không tìm thấy cảnh báo' });
      return res.status(409).json({ success: false, message: 'Cảnh báo đã được xử lý hoặc đang được xử lý', status: claim.value });
    }
    claimed = true;
    const active = await sessionService.listUserSessions(targetUserId);
    const targetSession = active.find((session) => session.managementId === record.managementId);
    if (!targetSession) {
      await securityService.mutateAlert({ userId: targetUserId, alertId, action: 'UNCLAIM_REVOKE', actorUserId: req.session.userId });
      claimed = false;
      return res.status(409).json({ success: false, sessionActive: false, message: 'Phiên liên quan đã hết hạn hoặc không còn hoạt động.' });
    }
    const actorOwnSession = targetUserId === req.session.userId && record.managementId === req.session.managementId;
    if (!isAdmin && actorOwnSession) {
      const logout = await sessionService.deleteSession(req.session.sessionId, targetUserId, {
        eventId: crypto.randomUUID(), eventType: 'LOGOUT', actorUserId: req.session.userId,
        actorRole: req.session.role, actorUsername: req.session.username,
        username: req.session.username, ip: getClientIp(req),
        device: securityService.normalizeDevice(req.headers['user-agent']).label,
      });
      if (!logout?.deleted) {
        await securityService.mutateAlert({ userId: targetUserId, alertId, action: 'UNCLAIM_REVOKE', actorUserId: req.session.userId });
        claimed = false;
        return res.status(409).json({ success: false, sessionActive: false, message: 'Phiên hiện tại không còn hoạt động.' });
      }
      let alertUpdate = { status: 'ERROR', historyRecorded: false };
      try {
        alertUpdate = await securityService.mutateAlert({ userId: targetUserId, alertId, action: 'FINISH_REVOKE', actorUserId: req.session.userId });
        claimed = false;
      } catch (error) { console.error('[security] Current session logged out but alert finalization failed:', error.message); }
      res.clearCookie('sessionId');
      return res.json({ success: true, sessionRevoked: true, currentSessionRevoked: true,
        alertStatus: alertUpdate.value || null, alertUpdated: alertUpdate.status === 'UPDATED',
        historyRecorded: Boolean(logout.auditRecorded && alertUpdate.historyRecorded) });
    }
    const result = await sessionService.revokeSession(
      targetUserId, record.managementId, isAdmin ? '' : req.session.sessionId,
      {
        eventType: isAdmin ? 'ADMIN_SESSION_REVOKED' : 'SESSION_REVOKED',
        actorUserId: req.session.userId, actorRole: req.session.role,
        actorUsername: req.session.username, ip: getClientIp(req),
        device: securityService.normalizeDevice(req.headers['user-agent']).label,
      }
    );
    if (result.status !== 'REVOKED') {
      await securityService.mutateAlert({ userId: targetUserId, alertId, action: 'UNCLAIM_REVOKE', actorUserId: req.session.userId });
      claimed = false;
      return res.status(409).json({ success: false, sessionActive: false, message: 'Phiên không còn hoạt động; chưa được thu hồi bởi yêu cầu này.' });
    }
    let alertUpdate = { status: 'ERROR', historyRecorded: false };
    try {
      alertUpdate = await securityService.mutateAlert({ userId: targetUserId, alertId, action: 'FINISH_REVOKE', actorUserId: req.session.userId });
      claimed = false;
    } catch (error) { console.error('[security] Session revoked but alert finalization failed:', error.message); }
    const currentSessionRevoked = targetUserId === req.session.userId && record.managementId === req.session.managementId;
    if (currentSessionRevoked) res.clearCookie('sessionId');
    return res.json({
      success: true, sessionRevoked: true, alertStatus: alertUpdate.value || null,
      alertUpdated: alertUpdate.status === 'UPDATED',
      historyRecorded: result.auditRecorded && alertUpdate.historyRecorded,
      currentSessionRevoked,
    });
  } catch (error) {
    if (claimed && targetUserId && alertId) {
      try { await securityService.mutateAlert({ userId: targetUserId, alertId, action: 'UNCLAIM_REVOKE', actorUserId: req.session.userId }); }
      catch (recoveryError) { console.error('[security] Could not release alert action claim:', recoveryError.message); }
    }
    return sendSecurityError(res, `${isAdmin ? 'POST /api/admin' : 'POST /api'}/security/alerts/:alertId/revoke-session`, error);
  }
}

app.post('/api/security/alerts/:alertId/revoke-session', authMiddleware, sameOriginMutation, (req, res) => revokeAlertSession(req, res, false));

app.get('/api/admin/security/overview', authMiddleware, requireAdmin, async (req, res) => {
  try { return res.json(await securityService.getOverview(securityService.globalIndex())); }
  catch (error) { return sendSecurityError(res, 'GET /api/admin/security/overview', error); }
});
app.get('/api/admin/security/alerts', authMiddleware, requireAdmin, async (req, res) => {
  try { return res.json(await securityService.listAlerts(securityService.globalIndex(), req.query, { admin: true })); }
  catch (error) { return sendSecurityError(res, 'GET /api/admin/security/alerts', error); }
});
app.get('/api/admin/security/alerts/:alertId', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const alert = await securityService.getAlert(req.params.alertId, null, req.session.managementId);
    if (!alert) return res.status(404).json({ success: false, message: 'Không tìm thấy cảnh báo' });
    return res.json({ alert, events: await securityService.readAlertEvents(alert.alertId) });
  } catch (error) { return sendSecurityError(res, 'GET /api/admin/security/alerts/:alertId', error); }
});
app.patch('/api/admin/security/alerts/:alertId/read', adminMutationOriginFirst, authMiddleware, requireAdmin, sameOriginMutation, async (req, res) => {
  try {
    const alert = await securityService.getAlert(req.params.alertId);
    if (!alert) return res.status(404).json({ success: false, message: 'Không tìm thấy cảnh báo' });
    const result = await securityService.mutateAlert({ userId: alert.userId, alertId: alert.alertId, action: 'READ', actorUserId: req.session.userId });
    if (result.status === 'NOT_FOUND') return res.status(404).json({ success: false, message: 'Không tìm thấy cảnh báo' });
    return res.json({ success: true, changed: result.status === 'UPDATED', readAt: result.value, historyRecorded: result.historyRecorded });
  } catch (error) { return sendSecurityError(res, 'PATCH /api/admin/security/alerts/:alertId/read', error); }
});
app.patch('/api/admin/security/alerts/:alertId/resolve', adminMutationOriginFirst, authMiddleware, requireAdmin, sameOriginMutation, async (req, res) => {
  try {
    if (req.body?.action !== 'safe') return res.status(400).json({ success: false, message: 'action phải là safe' });
    const alert = await securityService.getAlert(req.params.alertId);
    if (!alert) return res.status(404).json({ success: false, message: 'Không tìm thấy cảnh báo' });
    const result = await securityService.mutateAlert({ userId: alert.userId, alertId: alert.alertId, action: 'RESOLVE_SAFE', actorUserId: req.session.userId });
    if (result.status === 'NOT_FOUND') return res.status(404).json({ success: false, message: 'Không tìm thấy cảnh báo' });
    if (result.status !== 'UPDATED') return res.status(409).json({ success: false, message: 'Cảnh báo đã được xử lý hoặc đang được xử lý', status: result.value });
    return res.json({ success: true, status: result.value, historyRecorded: result.historyRecorded });
  } catch (error) { return sendSecurityError(res, 'PATCH /api/admin/security/alerts/:alertId/resolve', error); }
});
app.post('/api/admin/security/alerts/:alertId/revoke-session', adminMutationOriginFirst, authMiddleware, requireAdmin, sameOriginMutation, (req, res) => revokeAlertSession(req, res, true));
app.get('/api/admin/security/alerts/:alertId/events', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const events = await securityService.listAlertEvents(req.params.alertId);
    if (!events) return res.status(404).json({ success: false, message: 'Không tìm thấy cảnh báo' });
    return res.json({ events });
  } catch (error) { return sendSecurityError(res, 'GET /api/admin/security/alerts/:alertId/events', error); }
});
app.get('/api/security/alerts/:alertId/events', authMiddleware, async (req, res) => {
  try {
    const events = await securityService.listAlertEvents(req.params.alertId, req.session.userId);
    if (!events) return res.status(404).json({ success: false, message: 'Không tìm thấy cảnh báo' });
    return res.json({ events });
  } catch (error) { return sendSecurityError(res, 'GET /api/security/alerts/:alertId/events', error); }
});

// Chuẩn hóa IP (::ffff:127.0.0.1 -> 127.0.0.1, ::1 -> 127.0.0.1)
function getClientIp(req) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (ip === '::1') return '127.0.0.1';
  return ip.replace('::ffff:', '');
}

function respondLoginLocked(res, retryAfterSeconds, auditRecorded) {
  const retryAfter = Math.max(1, Number(retryAfterSeconds) || sessionService.LOGIN_LOCK_SECONDS);
  res.set('Retry-After', String(retryAfter));
  return res.status(429).json({
    success: false,
    message: 'Đăng nhập tạm thời bị giới hạn. Vui lòng thử lại sau.',
    retryAfterSeconds: retryAfter,
    ...(auditRecorded === undefined ? {} : { auditRecorded }),
  });
}

async function respondLoginFailure(res, username, context) {
  const state = await sessionService.recordLoginFailure(username, context);
  if (state.newlyLocked && context.userId && context.username
    && ['USER', 'ADMIN'].includes(context.role)) {
    await securityService.createLockoutAlert({
      userId: context.userId, username: context.username || username, role: context.role,
      ip: context.ip, userAgent: context.device, failureCount: state.failureCount,
      lockSeconds: sessionService.LOGIN_LOCK_SECONDS,
    });
  }
  if (state.locked) return respondLoginLocked(res, state.retryAfterSeconds, state.auditRecorded);
  return res.status(401).json({
    success: false,
    message: 'Sai tài khoản hoặc mật khẩu',
    auditRecorded: state.auditRecorded,
  });
}

// ------------------------------------------------------------
// POST /api/login
// ------------------------------------------------------------
app.post('/api/login', async (req, res) => {
  try {
    const body = req.body || {};
    const usernameInput = body.username;
    const password = body.password;
    if (typeof usernameInput !== 'string' || typeof password !== 'string'
      || !usernameInput.trim() || !password) {
      return res
        .status(400)
        .json({ success: false, message: 'Vui lòng nhập tài khoản và mật khẩu' });
    }

    const username = sessionService.normalizeUsername(usernameInput);
    if (username.length > 64 || /[\u0000-\u001f\u007f]/.test(username)) {
      return res
        .status(400)
        .json({ success: false, message: 'Vui lòng nhập tài khoản và mật khẩu' });
    }

    // Fast rejection; createSession rechecks lock atomically after bcrypt.
    const lock = await sessionService.getLoginLockStatus(username);
    if (lock.locked) return respondLoginLocked(res, lock.retryAfterSeconds);
    const device = String(req.headers['user-agent'] || 'unknown').slice(0, 256);
    const ip = getClientIp(req);

    // GET username:<username> -> userId
    const userId = await client.get(`username:${username}`);
    if (!userId) {
      return respondLoginFailure(res, username, { username, device, ip });
    }

    // HGETALL user:<userId>
    const user = await client.hGetAll(`user:${userId}`);
    if (!user || !user.passwordHash) {
      return respondLoginFailure(res, username, { userId, username, role: user?.role, device, ip });
    }

    // So sánh mật khẩu với bcrypt hash
    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      return respondLoginFailure(res, username, { userId, username: user.username, role: user.role, device, ip });
    }

    // Lua kiểm tra lock lần cuối rồi tạo session theo BR-01/BR-02.
    const created = await sessionService.createSession(
      { userId, username: user.username, role: user.role },
      device,
      ip,
      username,
      { returnAuditStatus: true }
    );
    const { sessionId } = created;

    // Firestore contains a durable profile copy; Redis remains authoritative for auth/session.
    void firestoreSync.saveUserProfile({
      userId, username: user.username, role: user.role, email: user.email,
      displayName: user.displayName,
    }).catch((error) => console.error('[Firestore] Could not save user profile:', error.message));

    // Security monitoring is best-effort and cannot undo a committed login.
    await securityService.observeSuccessfulLogin({
      userId, username: user.username, userAgent: device, ip,
      managementId: created.managementId,
    });

    // Gửi sessionId về trình duyệt qua cookie
    res.cookie('sessionId', sessionId, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: sessionService.SESSION_TTL * 1000,
    });

    res.json({
      success: true,
      message: 'Đăng nhập thành công',
      auditRecorded: created.auditRecorded,
      user: { userId, username: user.username, role: user.role },
    });
  } catch (err) {
    if (err.code === 'LOGIN_LOCKED') {
      return respondLoginLocked(res, err.retryAfterSeconds);
    }
    console.error('[POST /api/login] Lỗi:', err.message);
    res.status(500).json({ success: false, message: 'Lỗi máy chủ' });
  }
});

app.get('/api/history', authMiddleware, async (req, res) => {
  try {
    if (req.query.userId !== undefined) {
      return res.status(400).json({ success: false, message: 'Không thể chỉ định userId cho lịch sử cá nhân' });
    }
    const validation = auditService.validateHistoryQuery(req.query);
    if (validation.error) return res.status(400).json({ success: false, message: validation.error });
    return res.json(await auditService.readHistory(
      auditService.userStreamKey(req.session.userId), validation.value
    ));
  } catch (error) {
    console.error('[GET /api/history]', error.message);
    return res.status(500).json({ success: false, message: 'Lỗi máy chủ' });
  }
});

app.get('/api/admin/history', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const validation = auditService.validateHistoryQuery(req.query, { allowUserId: true });
    if (validation.error) return res.status(400).json({ success: false, message: validation.error });
    return res.json(await auditService.readHistory(auditService.globalStreamKey(), validation.value));
  } catch (error) {
    console.error('[GET /api/admin/history]', error.message);
    return res.status(500).json({ success: false, message: 'Lỗi máy chủ' });
  }
});

for (const kind of ['history', 'security', 'summary']) {
  app.get(`/api/reports/${kind}/export`, authMiddleware, reportController.exportReport(kind, false));
  app.get(`/api/admin/reports/${kind}/export`, authMiddleware, requireAdmin, reportController.exportReport(kind, true));
}

// ------------------------------------------------------------
// GET /api/me - thông tin phiên hiện tại
// ------------------------------------------------------------
app.get('/api/me', authMiddleware, (req, res) => {
  const { userId, username, role, device, ip, loginTime, managementId } = req.session;
  res.json({ userId, username, role, device, ip, loginTime, managementId });
});

// ------------------------------------------------------------
// GET /api/sessions - các phiên còn hiệu lực của user
// ------------------------------------------------------------
app.get('/api/sessions', authMiddleware, async (req, res) => {
  try {
    const sessions = await sessionService.listUserSessions(req.session.userId);
    // Đánh dấu phiên hiện tại để dashboard hiển thị
    const list = sessions.map(({ sessionId, ...s }) => ({ ...s, current: sessionId === req.session.sessionId }));
    res.json(list);
  } catch (err) {
    console.error('[GET /api/sessions] Lỗi:', err.message);
    res.status(500).json({ success: false, message: 'Lỗi máy chủ' });
  }
});

// ------------------------------------------------------------
// GET /api/login-count - số lần đăng nhập
// ------------------------------------------------------------
app.get('/api/login-count', authMiddleware, async (req, res) => {
  try {
    const count = await sessionService.getLoginCount(req.session.userId);
    res.json({ userId: req.session.userId, count });
  } catch (err) {
    console.error('[GET /api/login-count] Lỗi:', err.message);
    res.status(500).json({ success: false, message: 'Lỗi máy chủ' });
  }
});

// ------------------------------------------------------------
// POST /api/logout
// ------------------------------------------------------------
app.delete('/api/sessions/:managementId', authMiddleware, sameOriginMutation, async (req, res) => {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.managementId)) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy phiên' });
    }
    const result = await sessionService.revokeSession(
      req.session.userId,
      req.params.managementId,
      req.session.sessionId,
      {
        eventType: 'SESSION_REVOKED', actorUserId: req.session.userId,
        actorRole: req.session.role, actorUsername: req.session.username,
        ip: getClientIp(req), device: String(req.headers['user-agent'] || '').slice(0, 256),
      }
    );
    if (result.status === 'CURRENT') {
      return res.status(400).json({ success: false, message: 'Dùng đăng xuất để kết thúc phiên hiện tại' });
    }
    if (result.status === 'NOT_FOUND') return res.status(404).json({ success: false, message: 'Không tìm thấy phiên' });
    return res.json({ success: true, message: 'Đã thu hồi phiên', auditRecorded: result.auditRecorded });
  } catch (err) {
    console.error('[DELETE /api/sessions/:managementId]', err.message);
    return res.status(500).json({ success: false, message: 'Lỗi máy chủ' });
  }
});

app.post('/api/logout-all', authMiddleware, sameOriginMutation, async (req, res) => {
  try {
    const outcome = await sessionService.revokeAllSessions(req.session.userId, {
      eventType: 'LOGOUT_ALL', actorUserId: req.session.userId,
      actorRole: req.session.role, actorUsername: req.session.username,
      ip: getClientIp(req), device: String(req.headers['user-agent'] || '').slice(0, 256),
    });
    res.clearCookie('sessionId');
    return res.json({ success: true, revokedCount: outcome.revokedCount, auditRecorded: outcome.auditRecorded });
  } catch (err) {
    console.error('[POST /api/logout-all]', err.message);
    return res.status(500).json({ success: false, message: 'Lỗi máy chủ' });
  }
});

app.post('/api/logout', sameOriginMutation, async (req, res) => {
  try {
    const sessionId = req.cookies.sessionId;

    if (sessionId) {
      // Lấy session để biết userId (nếu còn)
      const session = await sessionService.getSession(sessionId);
      // DEL session:<id> + SREM user:sessions:<userId> <id>
      if (session) {
        const deletion = await sessionService.deleteSession(sessionId, session.userId, {
          eventId: crypto.randomUUID(), eventType: 'LOGOUT', actorUserId: session.userId,
          actorRole: session.role, actorUsername: session.username, username: session.username,
          ip: session.ip, device: session.device,
        });
        res.clearCookie('sessionId');
        return res.json({ success: true, message: 'Đăng xuất thành công', auditRecorded: deletion.deleted ? deletion.auditRecorded : null });
      }
    }

    res.clearCookie('sessionId');
    res.json({ success: true, message: 'Đăng xuất thành công' });
  } catch (err) {
    console.error('[POST /api/logout] Lỗi:', err.message);
    res.status(500).json({ success: false, message: 'Lỗi máy chủ' });
  }
});

// ------------------------------------------------------------
// Khởi động: kết nối Redis xong mới mở cổng 3000
// ------------------------------------------------------------
async function start() {
  try {
    firestoreSync.initialize();
    await connectRedis();
    await auditService.startCleanup();
    await securityService.startCleanup();
    firestoreSync.startWorker();
    const server = app.listen(PORT, () => {
      console.log(`Server đang chạy tại http://localhost:${PORT}`);
    });
    const shutdown = async () => {
      auditService.stopCleanup();
      securityService.stopCleanup();
      await firestoreSync.stopWorker();
      server.close(async () => {
        if (client.isOpen) await client.quit();
        process.exit(0);
      });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    return server;
  } catch (err) {
    console.error('Không thể khởi động server vì Redis chưa sẵn sàng.');
    process.exit(1);
  }
}

if (require.main === module) {
  start();
}

module.exports = { app, start };
