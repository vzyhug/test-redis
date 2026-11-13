const crypto = require('node:crypto');
const { withTestRedis } = require('./accounts');

async function listUserAlerts(userId) {
  return withTestRedis(async (client) => {
    const ids = await client.zRange(`security:user:alerts:${userId}`, 0, -1, { REV: true });
    const alerts = [];
    for (const alertId of ids) {
      const value = await client.hGetAll(`security:alert:${alertId}`);
      if (value.alertId) alerts.push(value);
    }
    return alerts;
  });
}

async function getAlertForUser(userId, alertType) {
  const alerts = await listUserAlerts(userId);
  return alerts.find((item) => item.alertType === alertType) || null;
}

async function getSessionFromPage(page, userId) {
  const response = await page.request.get('/api/sessions');
  if (!response.ok()) throw new Error(`Cannot read active E2E sessions: HTTP ${response.status()}`);
  const sessions = await response.json();
  return sessions.find((session) => session.userId === userId || session.current) || sessions[0] || null;
}

async function securitySnapshot(userId, alertId) {
  return withTestRedis(async (client) => {
    const alertKey = `security:alert:${alertId}`;
    const alert = await client.hGetAll(alertKey);
    const [userScore, globalScore, openUser, openGlobal, eventsType] = await Promise.all([
      client.zScore(`security:user:alerts:${userId}`, alertId),
      client.zScore('security:alerts:global', alertId),
      client.zScore(`security:user:alerts:${userId}:open`, alertId),
      client.zScore('security:alerts:global:open', alertId),
      client.type(`security:alert:events:${alertId}`),
    ]);
    return { alert, userScore, globalScore, openUser, openGlobal, eventsType };
  });
}

function uniqueMarker() { return crypto.randomUUID(); }

module.exports = { listUserAlerts, getAlertForUser, getSessionFromPage, securitySnapshot, uniqueMarker };
