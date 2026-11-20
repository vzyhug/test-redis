const usersTable = document.getElementById('usersTable');
const sessionsPanel = document.getElementById('sessionsPanel');
const sessionsTable = document.getElementById('adminSessions');
const notice = document.getElementById('adminNotice');
const accountEditor = document.getElementById('accountEditor');
const accountPassword = document.getElementById('accountPassword');
const pendingAuditWarning = sessionStorage.getItem('auditWarning');
if (pendingAuditWarning) {
  notice.textContent = pendingAuditWarning;
  notice.classList.add('notice-error');
  notice.hidden = false;
  sessionStorage.removeItem('auditWarning');
}
const pageSize = 25;
let pageOffset = 0;
let pagePending = false;
let selectedAccount = null;

const formatTime = (value) => { const date = value ? new Date(value) : null; return date && Number.isFinite(date.getTime()) ? date.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : 'Không xác định'; };
const formatTtl = (seconds) => Number.isInteger(Number(seconds)) && Number(seconds) >= 0 ? `${Math.floor(Number(seconds) / 60)} phút ${Number(seconds) % 60} giây` : 'Không xác định';
function showNotice(message, isError = false) {
  notice.textContent = message;
  notice.classList.toggle('notice-error', isError);
  notice.hidden = false;
  window.appToast?.(message, isError);
}
function openAccountEditor(user = null) {
  accountEditor.dataset.userId = user?.userId || '';
  document.getElementById('accountEditorTitle').textContent = user ? `Sửa tài khoản ${user.username}` : 'Tạo tài khoản';
  document.getElementById('saveAccount').textContent = user ? 'Lưu thay đổi' : 'Tạo tài khoản';
  document.getElementById('passwordHint').textContent = user ? '(để trống nếu không đổi)' : '(bắt buộc)';
  document.getElementById('accountUsername').value = user?.username || '';
  document.getElementById('accountEmail').value = user?.email || '';
  document.getElementById('accountRole').value = user?.role || 'USER';
  accountPassword.value = '';
  accountPassword.required = !user;
  accountEditor.hidden = false;
  document.getElementById('accountUsername').focus();
}
function makeCell(value, className = '') {
  const cell = document.createElement('td');
  cell.textContent = value ?? '—';
  if (className) cell.className = className;
  return cell;
}
function showLoginIfUnauthorized(response) {
  if (response.status === 401) { window.location.href = '/login.html'; return true; }
  if (response.status === 403) { window.location.href = '/dashboard.html'; return true; }
  return false;
}

async function loadOverview() {
  const response = await fetch('/api/admin/overview');
  if (showLoginIfUnauthorized(response)) return;
  if (!response.ok) throw new Error('Không tải được tổng quan hệ thống');
  const overview = await response.json();
  document.getElementById('totalUsers').textContent = overview.totalUsers;
  document.getElementById('activeAccounts').textContent = overview.activeAccounts;
  document.getElementById('activeSessions').textContent = overview.totalActiveSessions;
  document.getElementById('roleSessions').textContent = `${overview.activeSessionsByRole.USER} / ${overview.activeSessionsByRole.ADMIN}`;
}

async function loadUsers() {
  if (pagePending) return;
  pagePending = true;
  const previous = document.getElementById('previousPage');
  const next = document.getElementById('nextPage');
  previous.disabled = true; next.disabled = true;
  const loadingRow = document.createElement('tr'); const loadingCell = makeCell('Đang tải danh sách tài khoản…', 'empty'); loadingCell.colSpan = 6; loadingRow.append(loadingCell); usersTable.replaceChildren(loadingRow);
  const search = document.getElementById('userSearch').value.trim();
  try {
    const query = new URLSearchParams({ offset: String(pageOffset), limit: String(pageSize), q: search });
    const response = await fetch(`/api/admin/users?${query}`);
    if (showLoginIfUnauthorized(response)) return;
    if (!response.ok) throw new Error('Không tải được danh sách tài khoản');
    const data = await response.json();
    usersTable.replaceChildren();
    if (!data.users.length) {
      const row = document.createElement('tr'); const cell = makeCell('Không tìm thấy tài khoản', 'empty');
      cell.colSpan = 6; row.appendChild(cell); usersTable.appendChild(row);
    }
    for (const user of data.users) {
      const row = document.createElement('tr');
      row.append(makeCell(user.userId, 'mono'), makeCell(user.username), makeCell(user.email), makeCell(user.role), makeCell(user.activeSessionCount));
      const actions = document.createElement('td'); actions.className = 'admin-row-actions';
      const view = document.createElement('button'); view.className = 'btn btn-ghost btn-small'; view.textContent = 'Xem phiên';
      view.addEventListener('click', () => loadUserSessions(user));
      const logoutAll = document.createElement('button'); logoutAll.className = 'btn btn-danger btn-small'; logoutAll.textContent = 'Đăng xuất tất cả';
      logoutAll.addEventListener('click', () => logoutAllUser(user, logoutAll));
      const edit = document.createElement('button'); edit.className = 'btn btn-ghost btn-small'; edit.textContent = 'Sửa';
      edit.addEventListener('click', () => openAccountEditor(user));
      const remove = document.createElement('button'); remove.className = 'btn btn-danger btn-small'; remove.textContent = 'Xóa';
      remove.addEventListener('click', () => deleteAccount(user, remove));
      actions.append(view, logoutAll, edit, remove); row.appendChild(actions); usersTable.appendChild(row);
    }
    const from = data.total ? pageOffset + 1 : 0;
    const to = Math.min(pageOffset + data.users.length, data.total);
    document.getElementById('pageSummary').textContent = `${from}–${to} / ${data.total}`;
    previous.disabled = pageOffset === 0;
    next.disabled = data.nextOffset === null;
  } catch (error) {
    const row = document.createElement('tr'); const cell = makeCell(error.message || 'Không tải được danh sách tài khoản. Hãy thử làm mới.', 'empty'); cell.colSpan = 6; row.append(cell); usersTable.replaceChildren(row); throw error;
  } finally { pagePending = false; }
}

async function loadUserSessions(user) {
  selectedAccount = user;
  sessionsPanel.hidden = false;
  document.getElementById('selectedUser').textContent = `${user.username} (${user.userId}, ${user.role})`;
  const loadingRow = document.createElement('tr'); const loadingCell = makeCell('Đang tải phiên…', 'empty'); loadingCell.colSpan = 6; loadingRow.append(loadingCell); sessionsTable.replaceChildren(loadingRow);
  try {
    const response = await fetch(`/api/admin/users/${encodeURIComponent(user.userId)}/sessions`);
    if (showLoginIfUnauthorized(response)) return;
    if (response.status === 404) throw new Error('Tài khoản không còn tồn tại');
    if (!response.ok) throw new Error('Không tải được phiên của tài khoản');
    const data = await response.json();
    sessionsTable.replaceChildren();
    if (!data.sessions.length) {
      const row = document.createElement('tr'); const cell = makeCell('Tài khoản không có phiên hoạt động', 'empty');
      cell.colSpan = 6; row.appendChild(cell); sessionsTable.appendChild(row); return;
    }
    for (const session of data.sessions) {
      const row = document.createElement('tr');
      const status = makeCell('');
      const badge = document.createElement('span'); badge.className = session.current ? 'badge' : 'status-pill';
      const ttlValue = Number(session.ttl);
      badge.textContent = session.current ? 'Phiên hiện tại' : ttlValue === 0 ? 'Sắp hết hạn' : ttlValue > 0 ? 'Đang hoạt động' : 'Không xác định';
      if (ttlValue === 0) badge.style.color = 'var(--color-warning)';
      status.append(badge);
      row.append(makeCell(session.device || 'Không rõ thiết bị'), makeCell(session.ip || 'Không xác định'), makeCell(formatTime(session.loginTime)), makeCell(formatTtl(session.ttl)), status);
      const action = document.createElement('td');
      const revoke = document.createElement('button'); revoke.className = 'btn btn-danger btn-small'; revoke.textContent = 'Thu hồi';
      revoke.addEventListener('click', () => revokeUserSession(user, session, revoke));
      action.appendChild(revoke); row.appendChild(action); sessionsTable.appendChild(row);
    }
  } catch (error) {
    const row = document.createElement('tr'); const cell = makeCell(error.message || 'Không tải được phiên. Hãy thử lại.', 'empty'); cell.colSpan = 6; row.append(cell); sessionsTable.replaceChildren(row);
    showNotice(error.message, true);
  }
}

async function revokeUserSession(user, session, button) {
  const effect = session.current ? ' Đây là phiên hiện tại của bạn; thao tác sẽ đăng xuất tài khoản Admin này.' : '';
  const approved = await (window.appConfirm?.('Thu hồi phiên đăng nhập?', `Tài khoản ${user.username}\nThiết bị: ${session.device || 'Không rõ thiết bị'}.${effect}`) ?? Promise.resolve(window.confirm(`Thu hồi phiên của ${user.username}?${effect}`)));
  if (!approved) return;
  button.disabled = true; button.textContent = 'Đang thu hồi…';
  try {
    const response = await fetch(`/api/admin/users/${encodeURIComponent(user.userId)}/sessions/${encodeURIComponent(session.managementId)}`, { method: 'DELETE' });
    if (showLoginIfUnauthorized(response)) return;
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Không thể thu hồi phiên');
    if (data.currentSessionRevoked) {
      if (data.auditRecorded === false) sessionStorage.setItem('auditWarning', 'Đã thu hồi phiên Admin nhưng lịch sử chưa được ghi.');
      window.location.href = '/login.html'; return;
    }
    showNotice(data.auditRecorded === false
      ? `Đã thu hồi phiên của ${user.username}, nhưng lịch sử chưa được ghi.`
      : `Đã thu hồi phiên của ${user.username}.`, data.auditRecorded === false);
    await loadUserSessions(user);
    await loadUsers();
    await loadOverview();
  } catch (error) { showNotice(error.message, true); button.disabled = false; button.textContent = 'Thu hồi'; }
}

async function logoutAllUser(user, button) {
  const approved = await (window.appConfirm?.('Đăng xuất tất cả thiết bị?', `Tài khoản ${user.username} (${user.userId}) sẽ bị đăng xuất trên toàn bộ thiết bị.`) ?? Promise.resolve(window.confirm(`Đăng xuất tất cả thiết bị của ${user.username}?`)));
  if (!approved) return;
  button.disabled = true; button.textContent = 'Đang xử lý…';
  try {
    const response = await fetch(`/api/admin/users/${encodeURIComponent(user.userId)}/logout-all`, { method: 'POST' });
    if (showLoginIfUnauthorized(response)) return;
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Không thể đăng xuất tài khoản');
    if (data.currentSessionRevoked) {
      if (data.auditRecorded === false) sessionStorage.setItem('auditWarning', 'Đã đăng xuất Admin nhưng lịch sử chưa được ghi.');
      window.location.href = '/login.html'; return;
    }
    showNotice(data.auditRecorded === false
      ? `Đã đăng xuất ${data.revokedCount} phiên của ${user.username}, nhưng lịch sử chưa được ghi.`
      : `Đã đăng xuất ${data.revokedCount} phiên của ${user.username}.`, data.auditRecorded === false);
    if (selectedAccount?.userId === user.userId) await loadUserSessions(user);
    await loadUsers();
    await loadOverview();
  } catch (error) { showNotice(error.message, true); button.disabled = false; button.textContent = 'Đăng xuất tất cả'; }
}

async function deleteAccount(user, button) {
  const approved = await (window.appConfirm?.('Xóa tài khoản?', `Tài khoản ${user.username} (${user.userId}) sẽ bị xóa khỏi Redis và toàn bộ phiên sẽ bị thu hồi.`)
    ?? Promise.resolve(window.confirm(`Xóa tài khoản ${user.username} và thu hồi các phiên của tài khoản?`)));
  if (!approved) return;
  button.disabled = true;
  try {
    const response = await fetch(`/api/admin/users/${encodeURIComponent(user.userId)}`, { method: 'DELETE' });
    if (showLoginIfUnauthorized(response)) return;
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Không thể xóa tài khoản');
    if (selectedAccount?.userId === user.userId) { selectedAccount = null; sessionsPanel.hidden = true; }
    accountEditor.hidden = true;
    showNotice(`Đã xóa tài khoản ${user.username} và thu hồi ${data.revokedCount} phiên.`);
    await Promise.all([loadUsers(), loadOverview()]);
  } catch (error) { showNotice(error.message, true); button.disabled = false; }
}

document.getElementById('createAccount').addEventListener('click', () => openAccountEditor());
document.getElementById('cancelAccountEdit').addEventListener('click', () => { accountEditor.hidden = true; });
accountEditor.addEventListener('submit', async (event) => {
  event.preventDefault();
  const saveButton = document.getElementById('saveAccount');
  saveButton.disabled = true;
  const userId = accountEditor.dataset.userId;
  const body = {
    username: document.getElementById('accountUsername').value,
    email: document.getElementById('accountEmail').value,
    role: document.getElementById('accountRole').value,
    password: accountPassword.value,
  };
  try {
    const response = await fetch(userId ? `/api/admin/users/${encodeURIComponent(userId)}` : '/api/admin/users', {
      method: userId ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (showLoginIfUnauthorized(response)) return;
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Không thể lưu tài khoản');
    accountEditor.hidden = true;
    if (data.currentSessionRevoked) {
      sessionStorage.setItem('auditWarning', 'Thông tin tài khoản đã đổi; hãy đăng nhập lại.');
      window.location.href = '/login.html';
      return;
    }
    showNotice(userId ? `Đã cập nhật tài khoản ${data.user.username}.` : `Đã tạo tài khoản ${data.user.username}.`);
    await Promise.all([loadUsers(), loadOverview()]);
  } catch (error) { showNotice(error.message, true); }
  finally { saveButton.disabled = false; }
});

document.getElementById('searchForm').addEventListener('submit', (event) => {
  event.preventDefault(); pageOffset = 0; loadUsers().catch((error) => showNotice(error.message, true));
});
document.getElementById('previousPage').addEventListener('click', () => {
  pageOffset = Math.max(0, pageOffset - pageSize); loadUsers().catch((error) => showNotice(error.message, true));
});
document.getElementById('nextPage').addEventListener('click', () => {
  pageOffset += pageSize; loadUsers().catch((error) => showNotice(error.message, true));
});
document.getElementById('closeSessions').addEventListener('click', () => { sessionsPanel.hidden = true; });
document.getElementById('adminRefresh')?.addEventListener('click', async (event) => {
  const button = event.currentTarget; button.disabled = true; button.textContent = 'Đang tải…';
  try { await Promise.all([loadOverview(), loadUsers()]); if (selectedAccount) await loadUserSessions(selectedAccount); }
  catch (error) { showNotice(error.message || 'Không thể làm mới dữ liệu.', true); }
  finally { button.disabled = false; button.textContent = 'Làm mới'; }
});
(async () => {
  try { await Promise.all([loadOverview(), loadUsers()]); }
  catch (error) { console.error(error); showNotice(error.message || 'Không tải được dữ liệu Admin', true); }
})();
