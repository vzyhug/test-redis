(() => {
  const path = window.location.pathname;
  const pageTitle = path === '/admin.html' ? 'Quản trị hệ thống'
    : path === '/admin-history.html' ? 'Lịch sử toàn hệ thống'
      : path === '/history.html' ? 'Lịch sử hoạt động'
        : path === '/security.html' ? 'Trung tâm bảo mật'
          : path === '/reports.html' ? 'Báo cáo & Xuất dữ liệu'
        : 'Tổng quan';
  const icon = '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z"/><path d="M8 8h8M8 12h8M8 16h4"/></svg>';
  const body = document.body;
  const oldHeader = document.querySelector('.topbar');
  const content = document.querySelector('main.container');
  if (!content) return;
  const shell = document.createElement('div'); shell.className = 'app-shell';
  const sidebar = document.createElement('aside'); sidebar.className = 'app-sidebar'; sidebar.setAttribute('aria-label', 'Điều hướng chính');
  const nav = document.createElement('nav'); nav.className = 'side-nav';
  const item = (href, label, glyph, active) => `<a class="nav-link${active ? ' active' : ''}" href="${href}"${active ? ' aria-current="page"' : ''}><span class="nav-icon">${glyph}</span><span>${label}</span></a>`;
  const glyphs = [
    '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
    '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/></svg>',
    '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="10" cy="7" r="4"/><path d="M20 8v6m3-3h-6"/></svg>',
    '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v16H4z"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>',
  ];
  nav.innerHTML = `<div class="nav-label">Không gian cá nhân</div>${item('/dashboard.html','Tổng quan',glyphs[0],path==='/dashboard.html')}${item('/dashboard.html#sessions','Phiên đăng nhập',glyphs[1],false)}${item('/history.html','Lịch sử hoạt động',glyphs[2],path==='/history.html')}${item('/security.html','Trung tâm bảo mật',glyphs[4],path==='/security.html')}${item('/reports.html','Báo cáo & Xuất dữ liệu',glyphs[4],path==='/reports.html')}<div class="nav-label admin-nav" hidden>Quản trị</div><div class="admin-nav" hidden>${item('/admin.html','Người dùng & phiên',glyphs[3],path==='/admin.html')}${item('/admin-history.html','Lịch sử hệ thống',glyphs[4],path==='/admin-history.html')}</div>`;
  sidebar.innerHTML = `<div class="brand"><span class="brand-mark">${icon}</span><span><span class="brand-title">Redis Session Manager</span><span class="brand-caption">Session Management Console</span></span></div>`;
  sidebar.append(nav);
  const footer = document.createElement('div'); footer.className = 'sidebar-spacer'; sidebar.append(footer);
  const user = document.createElement('div'); user.className = 'side-user';
  user.innerHTML = '<span class="avatar" id="sideAvatar">?</span><span class="side-user-info"><span class="side-username" id="sideUsername">Đang tải…</span><span class="role-chip" id="sideRole">—</span></span><button class="logout-icon" id="sideLogout" type="button" aria-label="Đăng xuất" title="Đăng xuất"><svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 17l5-5-5-5m5 5H3"/><path d="M12 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6"/></svg></button>';
  sidebar.append(user);
  const overlay = document.createElement('div'); overlay.className = 'mobile-overlay'; overlay.setAttribute('aria-hidden', 'true');
  const main = document.createElement('div'); main.className = 'app-main';
  const header = document.createElement('header'); header.className = 'app-header';
  header.innerHTML = `<button type="button" class="menu-toggle" id="menuToggle" aria-label="Mở menu" aria-expanded="false">☰</button><div><p class="header-eyebrow">Redis Session Manager</p><p class="header-title">${pageTitle}</p></div><div class="header-user"><span class="avatar" id="headerAvatar">?</span><span class="header-name" id="headerUsername">Đang tải…</span></div>`;
  main.append(header);
  const appContent = document.createElement('div'); appContent.className = 'app-content';
  if (oldHeader) oldHeader.remove();
  appContent.append(content); main.append(appContent);
  shell.append(sidebar, overlay, main);
  const firstScript = [...body.children].find((element) => element.tagName === 'SCRIPT');
  body.insertBefore(shell, firstScript || null);

  const toggle = document.getElementById('menuToggle');
  const closeDrawer = () => { body.classList.remove('drawer-open'); toggle?.setAttribute('aria-expanded', 'false'); };
  toggle?.addEventListener('click', () => { const opened = body.classList.toggle('drawer-open'); toggle.setAttribute('aria-expanded', String(opened)); });
  overlay.addEventListener('click', closeDrawer);
  sidebar.querySelectorAll('.nav-link').forEach((link) => link.addEventListener('click', closeDrawer));
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeDrawer(); });

  window.appToast = (message, isError = false) => {
    let region = document.querySelector('.toast-region');
    if (!region) { region = document.createElement('div'); region.className = 'toast-region'; region.setAttribute('aria-live', 'polite'); document.body.append(region); }
    const toast = document.createElement('div'); toast.className = `toast${isError ? ' error' : ''}`; toast.textContent = message; region.append(toast);
    setTimeout(() => toast.remove(), 4200);
  };
  window.appConfirm = (title, message, danger = true) => new Promise((resolve) => {
    const previousFocus = document.activeElement;
    const backdrop = document.createElement('div'); backdrop.className = 'modal-backdrop'; backdrop.setAttribute('role', 'presentation');
    const modal = document.createElement('section'); modal.className = 'confirm-modal'; modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-labelledby', 'confirmTitle');
    const heading = document.createElement('h2'); heading.id = 'confirmTitle'; heading.textContent = title;
    const detail = document.createElement('p'); detail.textContent = message;
    const actions = document.createElement('div'); actions.className = 'modal-actions';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn'; cancel.textContent = 'Hủy';
    const confirm = document.createElement('button'); confirm.type = 'button'; confirm.className = `btn${danger ? ' btn-danger' : ' btn-primary'}`; confirm.textContent = 'Xác nhận';
    actions.append(cancel, confirm); modal.append(heading, detail, actions); backdrop.append(modal); document.body.append(backdrop);
    const finish = (result) => { document.removeEventListener('keydown', keydown); backdrop.remove(); previousFocus?.focus?.(); resolve(result); };
    const keydown = (event) => {
      if (event.key === 'Escape') { finish(false); return; }
      if (event.key === 'Tab') {
        if (event.shiftKey && document.activeElement === cancel) { event.preventDefault(); confirm.focus(); }
        else if (!event.shiftKey && document.activeElement === confirm) { event.preventDefault(); cancel.focus(); }
      }
    };
    cancel.addEventListener('click', () => finish(false)); confirm.addEventListener('click', () => finish(true));
    backdrop.addEventListener('click', (event) => { if (event.target === backdrop) finish(false); });
    document.addEventListener('keydown', keydown); cancel.focus();
  });

  document.getElementById('sideLogout')?.addEventListener('click', async (event) => {
    const button = event.currentTarget; button.disabled = true;
    try {
      const response = await fetch('/api/logout', { method: 'POST' });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) { window.location.href = '/login.html'; return; }
      if (!response.ok) throw new Error(data.message || 'Không thể đăng xuất. Hãy thử lại.');
      if (data.auditRecorded === false) sessionStorage.setItem('auditWarning', 'Đã đăng xuất nhưng lịch sử chưa được ghi.');
      window.location.href = '/login.html';
    } catch (error) { button.disabled = false; window.appToast(error.message || 'Không kết nối được với máy chủ.', true); }
  });
  fetch('/api/me').then(async (response) => {
    if (response.status === 401) { window.location.href = '/login.html'; return null; }
    if (!response.ok) throw new Error('Không thể xác thực phiên');
    return response.json();
  }).then((me) => {
    if (!me) return;
    for (const id of ['sideUsername', 'headerUsername']) document.getElementById(id).textContent = me.username || 'Tài khoản';
    for (const id of ['sideAvatar', 'headerAvatar']) document.getElementById(id).textContent = String(me.username || '?').slice(0, 1).toLocaleUpperCase('vi-VN');
    document.getElementById('sideRole').textContent = me.role || 'USER';
    if (me.role === 'ADMIN') document.querySelectorAll('.admin-nav').forEach((element) => { element.hidden = false; });
  }).catch(() => window.appToast('Không kết nối được với dịch vụ xác thực.', true));
})();
