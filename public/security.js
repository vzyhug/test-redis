const rows = document.getElementById('securityRows');
const notice = document.getElementById('securityNotice');
const nextButton = document.getElementById('securityNext');
const detailPanel = document.getElementById('securityDetail');
const severityNames = { LOW: 'Thấp', MEDIUM: 'Trung bình', HIGH: 'Cao' };
const typeNames = {
  NEW_LOGIN_ENVIRONMENT: 'Môi trường đăng nhập mới',
  LOGIN_LOCKOUT: 'Khóa do đăng nhập sai nhiều lần',
};
const reasonNames = { NEW_DEVICE: 'Thiết bị / trình duyệt mới', NEW_IP: 'Địa chỉ IP mới', FAILURE_THRESHOLD: 'Đạt ngưỡng đăng nhập sai' };
const statusNames = { OPEN: 'Đang mở', PROCESSING: 'Đang xử lý', RESOLVED_SAFE: 'Đã xác nhận an toàn', RESOLVED_REVOKED: 'Đã thu hồi phiên' };
const eventNames = {
  ALERT_CREATED: 'Cảnh báo được tạo', ALERT_READ: 'Đã xem', ALERT_RESOLVED_SAFE: 'Xác nhận an toàn',
  SESSION_REVOKE_STARTED: 'Bắt đầu thu hồi phiên', SESSION_REVOKE_FAILED: 'Thu hồi phiên không thành công',
  SESSION_REVOKED_FOR_ALERT: 'Phiên liên quan đã bị thu hồi', ACTION_RETRY: 'Thử xử lý lại',
};
let isAdmin = false;
let currentUser = null;
let currentCursor = null;
let currentParams = new URLSearchParams({ limit: '20' });
let loading = false;
let selectedAlertId = null;
let resolvingAlert = false;

function showNotice(message, isError = false) {
  notice.textContent = message;
  notice.classList.toggle('notice-error', isError);
  notice.hidden = false;
  window.appToast?.(message, isError);
}

function showLogin(response) {
  if (response.status === 401) { window.location.href = '/login.html'; return true; }
  if (response.status === 403) { window.location.href = '/dashboard.html'; return true; }
  return false;
}

function vietnamTimeToIso(value) {
  if (!value) return null;
  const [date, time] = value.split('T');
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour - 7, minute)).toISOString();
}

function readFilters() {
  const params = new URLSearchParams({ limit: '20' });
  const severity = document.getElementById('securitySeverity').value;
  const status = document.getElementById('securityStatus').value;
  const alertType = document.getElementById('securityType').value;
  const from = vietnamTimeToIso(document.getElementById('securityFrom').value);
  const to = vietnamTimeToIso(document.getElementById('securityTo').value);
  const search = document.getElementById('securitySearch').value.trim();
  if (severity) params.set('severity', severity);
  if (status) params.set('status', status);
  if (alertType) params.set('alertType', alertType);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (isAdmin && search) params.set('q', search);
  return params;
}

function formatTime(value) {
  if (!value) return 'Không xác định';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : 'Không xác định';
}

function makeCell(value, className = '') {
  const cell = document.createElement('td');
  cell.textContent = value ?? '—';
  if (className) cell.className = className;
  return cell;
}

function setEmpty(message, isError = false) {
  const row = document.createElement('tr');
  const cell = makeCell(message, 'empty');
  cell.colSpan = isAdmin ? 7 : 6;
  if (isError) cell.classList.add('audit-danger');
  row.append(cell); rows.replaceChildren(row);
}

function addBadge(value, className) {
  const badge = document.createElement('span'); badge.className = className; badge.textContent = value; return badge;
}

function renderAlertRow(alert) {
  const row = document.createElement('tr');
  if (isAdmin) row.append(makeCell(`${alert.username || 'Tài khoản'} (${alert.userId})`, 'mono'));
  row.append(makeCell(formatTime(alert.createdAt)));
  const typeCell = makeCell('');
  const type = document.createElement('strong'); type.className = 'security-type'; type.textContent = typeNames[alert.alertType] || alert.alertType;
  const readState = document.createElement('span'); readState.className = 'security-read'; readState.textContent = alert.readAt ? ' · Đã xem' : ' · Chưa xem';
  typeCell.append(type, readState); row.append(typeCell);
  const severityCell = makeCell('');
  severityCell.append(addBadge(severityNames[alert.severity] || alert.severity, `severity-pill severity-${String(alert.severity).toLowerCase()}`));
  row.append(severityCell);
  row.append(makeCell([alert.device, alert.ip].filter(Boolean).join(' · ') || 'Không có thông tin'));
  row.append(makeCell(statusNames[alert.status] || alert.status, alert.status === 'PROCESSING' ? 'security-processing' : ''));
  const actions = document.createElement('td');
  const detail = document.createElement('button'); detail.type = 'button'; detail.className = 'btn btn-ghost btn-small'; detail.textContent = 'Chi tiết';
  detail.addEventListener('click', () => loadDetail(alert.alertId)); actions.append(detail);
  row.append(actions); return row;
}

async function loadOverview() {
  const endpoint = isAdmin ? '/api/admin/security/overview' : '/api/security/overview';
  const response = await fetch(endpoint);
  if (showLogin(response)) return;
  if (!response.ok) throw new Error('Không tải được tổng quan cảnh báo');
  const data = await response.json();
  document.getElementById('securityTotal').textContent = data.total;
  document.getElementById('securityOpen').textContent = data.open;
  document.getElementById('securityHigh').textContent = data.high;
  document.getElementById('securityResolved').textContent = data.resolved;
}

async function loadAlerts({ append = false } = {}) {
  if (loading) return;
  loading = true; nextButton.disabled = true;
  if (!append) setEmpty('Đang tải cảnh báo…');
  try {
    const params = new URLSearchParams(currentParams);
    if (append && currentCursor) params.set('cursor', currentCursor);
    const endpoint = isAdmin ? '/api/admin/security/alerts' : '/api/security/alerts';
    const response = await fetch(`${endpoint}?${params}`);
    if (showLogin(response)) return;
    if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.message || 'Không tải được cảnh báo'); }
    const data = await response.json();
    if (!append) rows.replaceChildren();
    if (!data.items.length && !append) setEmpty('Chưa phát hiện cảnh báo bảo mật nào.');
    for (const alert of data.items) rows.append(renderAlertRow(alert));
    currentCursor = data.nextCursor;
    nextButton.disabled = !data.hasMore || !currentCursor;
    document.getElementById('securityPageInfo').textContent = data.hasMore ? 'Còn cảnh báo cũ hơn' : (data.items.length ? 'Đã đến cuối danh sách' : 'Không có kết quả');
  } catch (error) { setEmpty(error.message || 'Không tải được cảnh báo. Hãy thử lại.', true); showNotice(error.message, true); }
  finally { loading = false; }
}

function renderEvents(events) {
  const tbody = document.getElementById('securityEvents'); tbody.replaceChildren();
  if (!events.length) {
    const row = document.createElement('tr'); const cell = makeCell('Chưa có thao tác xử lý nào.', 'empty'); cell.colSpan = 3; row.append(cell); tbody.append(row); return;
  }
  for (const event of events) {
    const row = document.createElement('tr');
    row.append(makeCell(formatTime(event.occurredAt)), makeCell(eventNames[event.eventType] || event.eventType), makeCell(event.actorUserId === 'SYSTEM' ? 'Hệ thống' : event.actorUserId || 'Hệ thống'));
    tbody.append(row);
  }
}

async function loadDetail(alertId) {
  const endpoint = isAdmin ? `/api/admin/security/alerts/${encodeURIComponent(alertId)}` : `/api/security/alerts/${encodeURIComponent(alertId)}`;
  try {
    const response = await fetch(endpoint);
    if (showLogin(response)) return;
    if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.message || 'Không tải được chi tiết cảnh báo'); }
    const { alert, events } = await response.json(); selectedAlertId = alert.alertId;
    document.getElementById('detailTitle').textContent = alert.title || typeNames[alert.alertType] || 'Chi tiết cảnh báo';
    document.getElementById('detailMeta').textContent = `${formatTime(alert.createdAt)} · ${severityNames[alert.severity] || alert.severity} · ${statusNames[alert.status] || alert.status}${isAdmin ? ` · ${alert.username || alert.userId} (${alert.userId})` : ''}`;
    document.getElementById('detailDescription').textContent = alert.description || 'Không có mô tả bổ sung.';
    document.getElementById('detailReasons').textContent = alert.reasons.map((reason) => reasonNames[reason] || reason).join(', ') || 'Không có dữ liệu';
    document.getElementById('detailDevice').textContent = alert.device || 'Không có dữ liệu';
    document.getElementById('detailIp').textContent = alert.ip || 'Không có dữ liệu';
    document.getElementById('detailSession').textContent = !alert.hasRelatedSession ? 'Không liên kết với phiên' : alert.relatedSessionActive ? alert.relatedSessionCurrent ? 'Phiên hiện tại' : 'Đang hoạt động' : 'Đã hết hạn hoặc không còn hoạt động';
    const lockoutDetail = document.getElementById('detailLockout');
    lockoutDetail.hidden = alert.alertType !== 'LOGIN_LOCKOUT';
    document.getElementById('detailLockoutValue').textContent = alert.alertType === 'LOGIN_LOCKOUT'
      ? `${alert.failureCount ?? 'Không rõ'} lần sai · khóa ${alert.lockSeconds ?? 'Không rõ'} giây` : '—';
    document.getElementById('detailResolver').textContent = alert.resolvedBy || 'Chưa xử lý';
    document.getElementById('markReadBtn').hidden = Boolean(alert.readAt) || alert.status !== 'OPEN';
    document.getElementById('resolveSafeBtn').hidden = alert.status !== 'OPEN';
    const revoke = document.getElementById('revokeAlertSessionBtn');
    revoke.hidden = !alert.relatedSessionActive || alert.status !== 'OPEN';
    revoke.textContent = alert.relatedSessionCurrent ? 'Đăng xuất phiên hiện tại' : 'Thu hồi phiên liên quan';
    renderEvents(events || []); detailPanel.hidden = false; detailPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) { showNotice(error.message, true); }
}

async function sendAction(url, method, body) {
  const response = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (showLogin(response)) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 403) throw new Error('Bạn không có quyền xử lý cảnh báo này.');
    if (response.status === 409) throw new Error(data.message || 'Cảnh báo hoặc phiên đã thay đổi; hãy làm mới dữ liệu.');
    throw new Error(data.message || 'Không thể cập nhật cảnh báo.');
  }
  return data;
}

function alertActionPath(action) {
  return isAdmin ? `/api/admin/security/alerts/${encodeURIComponent(selectedAlertId)}/${action}`
    : `/api/security/alerts/${encodeURIComponent(selectedAlertId)}/${action}`;
}

async function refreshAfterAction(message, data) {
  if (data?.historyRecorded === false) showNotice(`${message} Lịch sử xử lý chưa được ghi đầy đủ.`, true);
  else showNotice(message);
  await Promise.all([loadOverview(), loadAlerts()]);
  if (selectedAlertId) await loadDetail(selectedAlertId);
}

document.getElementById('securityFilters').addEventListener('submit', (event) => {
  event.preventDefault(); currentCursor = null; currentParams = readFilters(); loadAlerts().catch((error) => showNotice(error.message, true));
});
nextButton.addEventListener('click', () => loadAlerts({ append: true }));
document.getElementById('securityRefresh').addEventListener('click', async (event) => {
  const button = event.currentTarget; button.disabled = true; button.textContent = 'Đang tải…';
  try { currentCursor = null; currentParams = readFilters(); await Promise.all([loadOverview(), loadAlerts()]); }
  catch (error) { showNotice(error.message, true); }
  finally { button.disabled = false; button.textContent = 'Làm mới'; }
});
document.getElementById('detailClose').addEventListener('click', () => { detailPanel.hidden = true; });
document.getElementById('markReadBtn').addEventListener('click', async (event) => {
  if (!selectedAlertId) return;
  const button = event.currentTarget; button.disabled = true;
  try { const data = await sendAction(alertActionPath('read'), 'PATCH'); if (data) await refreshAfterAction('Đã đánh dấu cảnh báo đã xem.', data); }
  catch (error) { showNotice(error.message, true); }
  finally { button.disabled = false; }
});
document.getElementById('resolveSafeBtn').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const alertId = selectedAlertId;
  if (!alertId || resolvingAlert) return;
  resolvingAlert = true;
  button.disabled = true;
  try {
    const approved = await window.appConfirm('Xác nhận hoạt động an toàn?', 'Cảnh báo sẽ được lưu lại với trạng thái đã xác nhận an toàn.');
    if (!approved) return;
    const endpoint = isAdmin ? `/api/admin/security/alerts/${encodeURIComponent(alertId)}/resolve`
      : `/api/security/alerts/${encodeURIComponent(alertId)}/resolve`;
    const data = await sendAction(endpoint, 'PATCH', { action: 'safe' });
    if (data) await refreshAfterAction('Cảnh báo đã được xác nhận an toàn.', data);
  }
  catch (error) { showNotice(error.message, true); }
  finally { resolvingAlert = false; button.disabled = false; }
});
document.getElementById('revokeAlertSessionBtn').addEventListener('click', async (event) => {
  if (!selectedAlertId) return;
  const button = event.currentTarget;
  const currentSession = button.textContent.includes('hiện tại');
  const approved = await window.appConfirm(currentSession ? 'Đăng xuất phiên hiện tại?' : 'Thu hồi phiên liên quan?', currentSession
    ? 'Phiên hiện tại sẽ bị kết thúc và bạn sẽ được chuyển về trang đăng nhập.'
    : 'Thiết bị liên quan sẽ bị đăng xuất; cảnh báo sẽ được ghi nhận đã xử lý bằng cách thu hồi phiên.');
  if (!approved) return;
  button.disabled = true; button.textContent = 'Đang xử lý…';
  try {
    const data = await sendAction(alertActionPath('revoke-session'), 'POST');
    if (data?.currentSessionRevoked) { window.location.href = '/login.html'; return; }
    if (data) await refreshAfterAction(data.alertUpdated ? 'Phiên đã được thu hồi và cảnh báo đã xử lý.' : 'Phiên đã bị thu hồi; trạng thái cảnh báo cần được đối soát.', data);
  } catch (error) { showNotice(error.message, true); }
  finally { button.disabled = false; button.textContent = currentSession ? 'Đăng xuất phiên hiện tại' : 'Thu hồi phiên liên quan'; }
});

(async () => {
  try {
    const response = await fetch('/api/me');
    if (response.status === 401) { window.location.href = '/login.html'; return; }
    if (!response.ok) throw new Error('Không xác minh được phiên đăng nhập');
    currentUser = await response.json(); isAdmin = currentUser.role === 'ADMIN';
    if (isAdmin) {
      document.getElementById('securitySubtitle').textContent = 'Theo dõi và xử lý cảnh báo bảo mật trên toàn hệ thống.';
      document.getElementById('securityListTitle').textContent = 'Cảnh báo toàn hệ thống';
      document.getElementById('securitySearchLabel').hidden = false;
      document.getElementById('securityTableHead').innerHTML = '<tr><th>Tài khoản</th><th>Thời gian</th><th>Cảnh báo</th><th>Mức độ</th><th>Thiết bị / IP</th><th>Trạng thái</th><th>Thao tác</th></tr>';
    }
    const pending = sessionStorage.getItem('auditWarning');
    if (pending) { showNotice(pending, true); sessionStorage.removeItem('auditWarning'); }
    currentParams = readFilters();
    await Promise.all([loadOverview(), loadAlerts()]);
  } catch (error) { showNotice(error.message || 'Không tải được Security Center.', true); setEmpty(error.message || 'Lỗi tải dữ liệu.', true); }
})();
