(() => {
  const notice = document.getElementById('reportsNotice');
  const loading = document.getElementById('reportsLoading');
  const grid = document.getElementById('reportsGrid');
  const adminFilters = [...document.querySelectorAll('.admin-report-filter')];
  let isAdmin = false;

  function showNotice(message, isError = false) {
    notice.textContent = message;
    notice.classList.toggle('notice-error', isError);
    notice.hidden = false;
    window.appToast?.(message, isError);
  }

  function vnToday() {
    return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  function defaultFrom(to) {
    const value = new Date(`${to}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() - 6);
    return value.toISOString().slice(0, 10);
  }

  function setDefaultDates() {
    const to = vnToday();
    for (const form of document.querySelectorAll('.report-form')) {
      const fromInput = form.querySelector('[name="from"]');
      const toInput = form.querySelector('[name="to"]');
      fromInput.value = defaultFrom(to);
      toInput.value = to;
      toInput.max = to;
    }
  }

  function validateForm(form) {
    const from = form.querySelector('[name="from"]').value;
    const to = form.querySelector('[name="to"]').value;
    if (!from || !to) throw new Error('Hãy chọn ngày bắt đầu và ngày kết thúc.');
    if (from > to) throw new Error('Ngày bắt đầu phải nhỏ hơn hoặc bằng ngày kết thúc.');
    const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1;
    if (days > 30) throw new Error('Mỗi lần xuất tối đa 30 ngày.');
    if (to > vnToday()) throw new Error('Không thể xuất báo cáo cho ngày trong tương lai.');
    return { from, to };
  }

  function filenameFrom(response, fallback) {
    const value = response.headers.get('Content-Disposition') || '';
    const match = /filename="([a-z0-9-]+\.csv)"/i.exec(value);
    return match?.[1] || fallback;
  }

  async function exportForm(form) {
    const button = form.querySelector('[type="submit"]');
    const label = button.textContent;
    button.disabled = true;
    button.textContent = 'Đang chuẩn bị CSV…';
    notice.hidden = true;
    try {
      const params = new URLSearchParams(validateForm(form));
      for (const name of ['eventType', 'severity', 'status', 'alertType', 'userId']) {
        const control = form.querySelector(`[name="${name}"]`);
        const value = control?.value?.trim();
        if (value) params.set(name, value);
      }
      const kind = form.dataset.kind;
      const prefix = isAdmin ? '/api/admin/reports' : '/api/reports';
      const response = await fetch(`${prefix}/${kind}/export?${params.toString()}`, {
        method: 'GET', credentials: 'same-origin', headers: { Accept: 'text/csv' },
      });
      if (response.status === 401) {
        window.location.href = '/login.html';
        return;
      }
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.message || `Không thể xuất báo cáo (HTTP ${response.status}).`);
      }
      if (!(response.headers.get('Content-Type') || '').toLowerCase().startsWith('text/csv')) {
        throw new Error('Máy chủ trả về định dạng không hợp lệ; chưa tải file.');
      }
      const blob = await response.blob();
      if (!blob.size) throw new Error('File CSV rỗng không hợp lệ; chưa tải file.');
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filenameFrom(response, `${kind}-report.csv`);
      anchor.hidden = true;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      const isEmpty = response.headers.get('X-Report-Empty') === 'true';
      showNotice(isEmpty ? 'Không có dữ liệu phù hợp; đã tải CSV chỉ gồm tiêu đề.' : 'Đã tải báo cáo CSV thành công.');
    } catch (error) {
      showNotice(error.message || 'Không thể kết nối để xuất báo cáo.', true);
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  }

  for (const form of document.querySelectorAll('.report-form')) {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      exportForm(form);
    });
  }

  setDefaultDates();
  fetch('/api/me', { credentials: 'same-origin' }).then(async (response) => {
    if (response.status === 401) { window.location.href = '/login.html'; return null; }
    if (!response.ok) throw new Error('Không thể xác minh phiên đăng nhập.');
    return response.json();
  }).then((me) => {
    if (!me) return;
    isAdmin = me.role === 'ADMIN';
    for (const element of adminFilters) element.hidden = !isAdmin;
    loading.hidden = true;
    grid.hidden = false;
  }).catch((error) => {
    loading.textContent = error.message || 'Không thể tải trang báo cáo.';
    loading.classList.add('notice-error');
  });
})();
