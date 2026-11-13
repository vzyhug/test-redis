const isAdminHistory = window.location.pathname === '/admin-history.html';
const rows = document.getElementById('historyRows');
const notice = document.getElementById('historyNotice');
const nextButton = document.getElementById('historyNext');
const eventLabels = {
  LOGIN_SUCCESS: 'Đăng nhập thành công',
  LOGIN_FAILED: 'Đăng nhập thất bại',
  LOGIN_LOCKED: 'Kích hoạt khóa đăng nhập',
  LOGOUT: 'Đăng xuất',
  SESSION_REVOKED: 'Thu hồi phiên',
  LOGOUT_ALL: 'Đăng xuất mọi thiết bị',
  SESSION_AUTO_REVOKED: 'Hệ thống tự thu hồi phiên cũ',
  ADMIN_SESSION_REVOKED: 'Admin thu hồi phiên',
  ADMIN_LOGOUT_ALL: 'Admin đăng xuất mọi phiên',
};
let cursor = null;
let loading = false;
let currentParams = {};

if (isAdminHistory) {
  document.getElementById('historyTitle').textContent = 'Lịch sử toàn hệ thống';
  document.querySelector('.admin-history-filter').hidden = false;
  document.getElementById('historyHeader').innerHTML = '<tr><th>Thời gian</th><th>Người thực hiện</th><th>Tài khoản liên quan</th><th>Hoạt động</th><th>Kết quả</th></tr>';
}

function showNotice(message, isError = false) {
  notice.textContent = message;
  notice.classList.toggle('notice-error', isError);
  notice.hidden = false;
  if (window.appToast) window.appToast(message, isError);
}

const pendingAuditWarning = sessionStorage.getItem('auditWarning');
if (pendingAuditWarning) {
  showNotice(pendingAuditWarning, true);
  sessionStorage.removeItem('auditWarning');
}

function localTime(value) {
  return value ? new Date(value).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : '—';
}

function cell(value, className = '') {
  const element = document.createElement('td');
  element.textContent = value || '—';
  if (className) element.className = className;
  return element;
}

function buildParams() {
  const params = new URLSearchParams({ limit: '20' });
  const type = document.getElementById('eventTypeFilter').value;
  const userId = document.getElementById('historyUserId').value.trim();
  const from = document.getElementById('historyFrom').value;
  const to = document.getElementById('historyTo').value;
  if (type) params.set('eventType', type);
  if (isAdminHistory && userId) params.set('userId', userId);
  const vietnamTimeToIso = (value) => {
    if (!value) return null;
    const [date, time] = value.split('T');
    const [year, month, day] = date.split('-').map(Number);
    const [hour, minute] = time.split(':').map(Number);
    return new Date(Date.UTC(year, month - 1, day, hour - 7, minute)).toISOString();
  };
  if (from) params.set('from', vietnamTimeToIso(from));
  if (to) params.set('to', vietnamTimeToIso(to));
  return params;
}

async function loadHistory({ append = false } = {}) {
  if (loading) return;
  loading = true;
  nextButton.disabled = true;
  if (!append) {
    const row = document.createElement('tr'); const cellElement = document.createElement('td');
    cellElement.colSpan = 5; cellElement.className = 'empty'; cellElement.textContent = 'Đang tải lịch sử…';
    row.append(cellElement); rows.replaceChildren(row);
  }
  try {
    const params = new URLSearchParams(currentParams);
    if (append && cursor) params.set('cursor', cursor);
    const endpoint = isAdminHistory ? '/api/admin/history' : '/api/history';
    const response = await fetch(`${endpoint}?${params}`);
    if (response.status === 401) { window.location.href = '/login.html'; return; }
    if (response.status === 403) { window.location.href = '/dashboard.html'; return; }
      const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Không tải được lịch sử');
    if (!append) rows.replaceChildren();
    if (!data.items.length && !append) {
      const emptyRow = document.createElement('tr');
      const emptyCell = cell('Không có sự kiện trong bộ lọc này', 'empty'); emptyCell.colSpan = 5;
      emptyRow.appendChild(emptyCell); rows.appendChild(emptyRow);
    }
    for (const item of data.items) {
      const row = document.createElement('tr');
      const activity = eventLabels[item.eventType] || item.eventType || 'Hoạt động';
      const details = item.revokedCount === null ? '' : ` · ${item.revokedCount} phiên`;
      const resultText = item.result === 'SUCCESS' ? 'Thành công'
        : item.result === 'FAILED' ? 'Thất bại'
          : item.result === 'LOCKED' ? 'Đã khóa' : (item.result || '—');
      if (isAdminHistory) {
        const actor = item.actorUserId
          ? `${item.actorUsername || item.actorUserId} (${item.actorRole || '—'})`
          : (item.actorRole || 'Ẩn danh');
        const target = item.targetUserId
          ? `${item.username || item.targetUserId} (${item.targetUserId})`
          : (item.username || '—');
        row.append(cell(localTime(item.occurredAt)), cell(actor), cell(target), cell(activity + details), cell(resultText));
      } else {
        const activityCell = cell(activity + details);
        activityCell.classList.add(item.result === 'FAILED' || item.result === 'LOCKED' ? 'audit-danger' : 'audit-event');
        row.append(cell(localTime(item.occurredAt)), activityCell, cell(item.device), cell(item.ip), cell(resultText));
      }
      rows.appendChild(row);
    }
    cursor = data.nextCursor;
    nextButton.disabled = !data.hasMore || !cursor;
    document.getElementById('historyPageInfo').textContent = data.hasMore ? 'Còn sự kiện cũ hơn' : 'Đã đến cuối lịch sử';
    if (!pendingAuditWarning) notice.hidden = true;
  } catch (error) {
    showNotice(error.message || 'Lỗi tải lịch sử', true);
  } finally { loading = false; }
}

document.getElementById('historyFilters').addEventListener('submit', (event) => {
  event.preventDefault(); cursor = null; currentParams = buildParams();
  loadHistory().catch((error) => showNotice(error.message, true));
});
nextButton.addEventListener('click', () => loadHistory({ append: true }));
document.getElementById('historyRefresh').addEventListener('click', () => {
  cursor = null; currentParams = buildParams(); loadHistory().catch((error) => showNotice(error.message, true));
});
currentParams = buildParams();
loadHistory().catch((error) => showNotice(error.message, true));
