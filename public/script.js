const loginForm = document.getElementById('loginForm');

if (loginForm) {
  const errorBox = document.getElementById('errorBox');
  const loginBtn = document.getElementById('loginBtn');
  const passwordInput = document.getElementById('password');
  const passwordToggle = document.getElementById('passwordToggle');
  const auditWarning = sessionStorage.getItem('auditWarning');
  if (auditWarning) { errorBox.textContent = auditWarning; errorBox.hidden = false; sessionStorage.removeItem('auditWarning'); }
  passwordToggle.addEventListener('click', () => {
    const visible = passwordInput.type === 'password';
    passwordInput.type = visible ? 'text' : 'password';
    passwordToggle.textContent = visible ? 'Ẩn' : 'Hiện';
    passwordToggle.setAttribute('aria-label', visible ? 'Ẩn mật khẩu' : 'Hiện mật khẩu');
    passwordToggle.setAttribute('aria-pressed', String(visible));
  });
  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const username = document.getElementById('username').value.trim();
    const password = passwordInput.value;
    if (!username || !password) { errorBox.textContent = 'Vui lòng nhập tên đăng nhập và mật khẩu.'; errorBox.hidden = false; return; }
    errorBox.hidden = true; loginBtn.disabled = true; loginBtn.textContent = 'Đang xác thực…';
    try {
      const response = await fetch('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.success) {
        if (data.auditRecorded === false) sessionStorage.setItem('auditWarning', 'Đăng nhập thành công nhưng lịch sử chưa được ghi.');
        window.location.href = '/dashboard.html'; return;
      }
      const retry = Number(data.retryAfterSeconds);
      errorBox.textContent = response.status === 429
        ? `Tài khoản tạm thời bị khóa. Vui lòng thử lại sau ${retry > 0 ? `${retry} giây` : 'một khoảng thời gian'}.`
        : (data.message || 'Không thể đăng nhập. Vui lòng thử lại.');
      if (data.auditRecorded === false) errorBox.textContent += ' Lịch sử hoạt động hiện không ghi được.';
      errorBox.hidden = false;
    } catch { errorBox.textContent = 'Không kết nối được tới máy chủ. Kiểm tra ứng dụng rồi thử lại.'; errorBox.hidden = false; }
    finally { loginBtn.disabled = false; loginBtn.textContent = 'Đăng nhập'; }
  });
}

const sessionListEl = document.getElementById('sessionList');
if (sessionListEl) {
  const text = (id, value) => { const element = document.getElementById(id); if (element) element.textContent = value ?? '—'; };
  const formatTime = (value) => { const date = value ? new Date(value) : null; return date && Number.isFinite(date.getTime()) ? date.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : 'Không xác định'; };
  const formatTtl = (value) => Number.isInteger(Number(value)) && Number(value) >= 0
    ? `${Math.floor(Number(value) / 60)} phút ${Number(value) % 60} giây` : 'Không xác định';
  const notice = document.getElementById('sessionNotice');
  let requestPending = false;
  const showNotice = (message, isError = false) => { notice.textContent = message; notice.classList.toggle('notice-error', isError); notice.hidden = false; window.appToast?.(message, isError); };
  const warnAudit = (message, data) => { if (data?.auditRecorded === false) showNotice(`${message} Thao tác đã hoàn tất nhưng lịch sử chưa ghi được.`, true); else showNotice(message); };
  const pendingAuditWarning = sessionStorage.getItem('auditWarning');
  if (pendingAuditWarning) { showNotice(pendingAuditWarning, true); sessionStorage.removeItem('auditWarning'); }
  const eventNames = { LOGIN_SUCCESS:'Đăng nhập thành công', LOGIN_FAILED:'Đăng nhập thất bại', LOGIN_LOCKED:'Tài khoản bị khóa', LOGOUT:'Đăng xuất', SESSION_REVOKED:'Thu hồi phiên', LOGOUT_ALL:'Đăng xuất mọi thiết bị', SESSION_AUTO_REVOKED:'Tự thu hồi phiên cũ', ADMIN_SESSION_REVOKED:'Admin thu hồi phiên', ADMIN_LOGOUT_ALL:'Admin đăng xuất mọi phiên' };
  const setEmpty = (tbody, columns, message, isError = false) => {
    const row = document.createElement('tr'); const cell = document.createElement('td');
    cell.colSpan = columns; cell.className = 'empty'; cell.textContent = message; if (isError) cell.classList.add('audit-danger');
    row.append(cell); tbody.replaceChildren(row);
  };

  async function loadProfile() {
    const response = await fetch('/api/me');
    if (response.status === 401) { window.location.href = '/login.html'; return false; }
    if (!response.ok) throw new Error('Không tải được thông tin tài khoản');
    const me = await response.json();
    text('helloName', me.username); text('helloNameDetail', me.username); text('userId', me.userId); text('role', me.role);
    text('ip', me.ip || 'Không xác định'); text('device', me.device || 'Không xác định'); text('loginTime', formatTime(me.loginTime));
    return true;
  }
  async function loadLoginCount() {
    const response = await fetch('/api/login-count');
    if (response.status === 401) { window.location.href = '/login.html'; return; }
    if (!response.ok) throw new Error('Không tải được số lần đăng nhập');
    const data = await response.json(); text('loginCountKpi', data.count);
  }
  async function loadSessions() {
    if (requestPending) return;
    requestPending = true;
    const refresh = document.getElementById('refreshBtn'); if (refresh) { refresh.disabled = true; refresh.textContent = 'Đang làm mới…'; }
    try {
      const response = await fetch('/api/sessions');
      if (response.status === 401) { window.location.href = '/login.html'; return; }
      if (!response.ok) throw new Error('Không tải được danh sách phiên');
      const sessions = await response.json();
      text('activeSessionKpi', sessions.length); text('sessionLimitKpi', `${sessions.length} / 3`);
      const current = sessions.find((session) => session.current);
      text('currentTtlKpi', current ? formatTtl(current.ttl) : 'Không có');
      sessionListEl.replaceChildren();
      if (!sessions.length) { setEmpty(sessionListEl, 6, 'Không có phiên hoạt động.'); return; }
      for (const session of sessions) {
        const row = document.createElement('tr');
        const device = document.createElement('td'); device.textContent = session.device || 'Không rõ thiết bị';
        const status = document.createElement('td');
        const badge = document.createElement('span'); badge.className = 'status-pill';
        const ttlValue = Number(session.ttl);
        badge.textContent = session.current ? 'Phiên hiện tại' : ttlValue === 0 ? 'Sắp hết hạn' : ttlValue > 0 ? 'Đang hoạt động' : 'Không xác định';
        if (ttlValue === 0) badge.style.color = 'var(--color-warning)';
        status.append(badge);
        const ip = document.createElement('td'); ip.textContent = session.ip || 'Không xác định';
        const time = document.createElement('td'); time.textContent = formatTime(session.loginTime);
        const ttl = document.createElement('td'); ttl.textContent = formatTtl(session.ttl);
        const action = document.createElement('td');
        if (session.current) action.textContent = '—';
        else {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-small btn-danger'; button.textContent = 'Thu hồi';
          button.addEventListener('click', () => revokeOne(session, button)); action.append(button);
        }
        row.append(device, ip, time, ttl, status, action); sessionListEl.append(row);
      }
    } catch (error) { setEmpty(sessionListEl, 6, error.message || 'Lỗi tải phiên. Thử làm mới.', true); showNotice(error.message, true); }
    finally { requestPending = false; if (refresh) { refresh.disabled = false; refresh.textContent = 'Làm mới'; } }
  }
  async function loadRecentActivity() {
    const tbody = document.getElementById('recentActivity');
    try {
      const response = await fetch('/api/history?limit=5');
      if (response.status === 401) { window.location.href = '/login.html'; return; }
      if (!response.ok) throw new Error('Không tải được lịch sử hoạt động');
      const data = await response.json(); tbody.replaceChildren();
      if (!data.items.length) { setEmpty(tbody, 3, 'Chưa có hoạt động nào được ghi nhận.'); return; }
      for (const item of data.items) {
        const row = document.createElement('tr'); const event = document.createElement('td');
        event.textContent = eventNames[item.eventType] || item.eventType || 'Hoạt động';
        const when = document.createElement('td'); when.textContent = formatTime(item.occurredAt);
        const result = document.createElement('td'); result.textContent = item.result === 'SUCCESS' ? 'Thành công' : item.result === 'FAILED' ? 'Thất bại' : item.result === 'LOCKED' ? 'Đã khóa' : item.result || '—';
        result.className = item.result === 'SUCCESS' ? 'audit-success' : ['FAILED','LOCKED'].includes(item.result) ? 'audit-danger' : '';
        row.append(event, when, result); tbody.append(row);
      }
    } catch (error) { setEmpty(tbody, 3, error.message || 'Không tải được lịch sử.', true); }
  }
  async function revokeOne(session, button) {
    if (!session.managementId || requestPending) return;
    const approved = await (window.appConfirm?.('Thu hồi phiên đăng nhập?', `Thiết bị “${session.device || 'Không rõ thiết bị'}” sẽ bị đăng xuất.`) ?? Promise.resolve(window.confirm('Thu hồi phiên đăng nhập này?')));
    if (!approved) return;
    requestPending = true; button.disabled = true; button.textContent = 'Đang thu hồi…';
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.managementId)}`, { method: 'DELETE' });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) { window.location.href = '/login.html'; return; }
      if (!response.ok) throw new Error(data.message || 'Không thể thu hồi phiên');
      warnAudit('Đã thu hồi phiên.', data); requestPending = false; await Promise.all([loadSessions(), loadRecentActivity()]);
    } catch (error) { showNotice(error.message, true); }
    finally { requestPending = false; }
  }
  document.getElementById('refreshBtn')?.addEventListener('click', () => Promise.all([loadSessions(), loadRecentActivity(), loadLoginCount()]).catch((error) => showNotice(error.message, true)));
  document.getElementById('logoutAllBtn')?.addEventListener('click', async (event) => {
    if (requestPending) return;
    const button = event.currentTarget;
    requestPending = true; button.disabled = true; button.textContent = 'Đang xử lý…';
    try {
      const confirmed = await (window.appConfirm?.('Đăng xuất tất cả thiết bị?', 'Mọi phiên đăng nhập, bao gồm phiên hiện tại, sẽ kết thúc.') ?? Promise.resolve(window.confirm('Đăng xuất tất cả thiết bị, bao gồm phiên hiện tại?')));
      if (!confirmed) return;
      const response = await fetch('/api/logout-all', { method: 'POST' }); const data = await response.json().catch(() => ({}));
      if (response.status === 401) { window.location.href = '/login.html'; return; }
      if (!response.ok) throw new Error(data.message || 'Không thể đăng xuất tất cả thiết bị');
      if (data.auditRecorded === false) sessionStorage.setItem('auditWarning', 'Đã đăng xuất tất cả thiết bị nhưng lịch sử chưa ghi được.');
      window.location.href = '/login.html';
    } catch (error) { showNotice(error.message, true); button.disabled = false; button.textContent = 'Đăng xuất tất cả thiết bị'; }
    finally { requestPending = false; button.disabled = false; button.textContent = 'Đăng xuất tất cả thiết bị'; }
  });
  (async () => {
    try { if (await loadProfile()) await Promise.all([loadLoginCount(), loadSessions(), loadRecentActivity()]); }
    catch (error) { showNotice(error.message || 'Không tải được dữ liệu tài khoản.', true); }
  })();
}
