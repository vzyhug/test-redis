const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const publicDir = path.join(__dirname, '..', 'public');
const read = (name) => fs.readFileSync(path.join(publicDir, name), 'utf8');

test('login uses the existing authentication API without publishing demo credentials', () => {
  const html = read('login.html');
  const script = read('script.js');
  assert.match(html, /id="username"/);
  assert.match(html, /id="password"/);
  assert.match(html, /id="passwordToggle"/);
  assert.match(script, /fetch\('\/api\/login'/);
  assert.match(script, /response\.status === 429/);
  assert.doesNotMatch(html, /nguyenvana|tranthib|123456/);
});

test('authenticated pages include shared shell and real page data sections', () => {
  for (const page of ['dashboard.html', 'admin.html', 'history.html']) {
    const html = read(page);
    assert.match(html, /href="\/style\.css"/);
    assert.match(html, /src="\/app\.js"/);
  }
  assert.match(read('dashboard.html'), /id="activeSessionKpi"/);
  assert.match(read('dashboard.html'), /id="currentTtlKpi"/);
  assert.match(read('dashboard.html'), /id="recentActivity"/);
  assert.match(read('admin.html'), /id="totalUsers"/);
  assert.match(read('history.html'), /id="historyNext"/);
});

test('frontend calls the implemented APIs and keeps history cursor pagination', () => {
  const dashboard = read('script.js');
  const admin = read('admin.js');
  const history = read('history.js');
  for (const endpoint of ['/api/me', '/api/sessions', '/api/login-count', '/api/history', '/api/logout-all']) assert.ok(dashboard.includes(endpoint), endpoint);
  assert.ok(admin.includes('/api/admin/overview'));
  assert.ok(admin.includes('/api/admin/users?'));
  assert.match(admin, /\/api\/admin\/users\/\$\{encodeURIComponent\(user\.userId\)\}\/sessions/);
  assert.match(admin, /\/api\/admin\/users\/\$\{encodeURIComponent\(user\.userId\)\}\/sessions\/\$\{encodeURIComponent\(session\.managementId\)\}/);
  assert.match(history, /\/api\/admin\/history/);
  assert.match(history, /params\.set\('cursor', cursor\)/);
  assert.match(history, /params\.set\('eventType'/);
});

test('untrusted API values are written as text and Admin pages remain server protected', () => {
  for (const script of ['script.js', 'admin.js', 'history.js']) {
    const source = read(script);
    assert.doesNotMatch(source, /\.innerHTML\s*=\s*`[^`]*\$\{/);
  }
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /app\.get\('\/admin\.html',\s*authMiddleware,\s*requireAdmin/);
  assert.match(server, /app\.get\('\/admin-history\.html',\s*authMiddleware,\s*requireAdmin/);
  assert.match(read('app.js'), /me\.role === 'ADMIN'/);
});

test('design system includes mobile drawer, narrow layouts, and reduced-motion support', () => {
  const css = read('style.css');
  assert.match(css, /--bg-primary:\s*#0d0b1a/i);
  assert.match(css, /--color-primary:\s*#8b5cf6/i);
  assert.match(css, /@media\s*\(max-width:\s*760px\)/);
  assert.match(css, /drawer-open/);
  assert.match(css, /prefers-reduced-motion/);
});
