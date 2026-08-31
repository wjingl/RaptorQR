/* ============================================================================
 * 前端通用库：API 封装（CSRF 头）、会话加载、导航栏、工具函数
 * 全站无内联脚本（CSP script-src 'self'），所有逻辑外置。
 * ========================================================================== */
'use strict';

const App = (() => {
  let session = null; // {authenticated, user, mustChangePassword, csrfToken}

  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (session && session.csrfToken) headers['X-CSRF-Token'] = session.csrfToken;
    if (opts.body !== undefined && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
    const res = await fetch(path, Object.assign({}, opts, { headers: Object.assign(headers, opts.headers), credentials: 'same-origin' }));
    // 401 仅当是"会话过期/未登录"时才跳转登录页；
    // 登录接口自身的 401（账密错误）不能跳转，须把错误返回给页面显示
    if (res.status === 401 && !path.startsWith('/api/auth/session') && !path.startsWith('/api/auth/login')) {
      location.href = '/login';
      throw new Error('未登录');
    }
    let data = {};
    try { data = await res.json(); } catch (_) { /* 非 JSON 响应 */ }
    if (!res.ok) {
      const err = new Error(data.error || `请求失败 (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  async function loadSession() {
    session = await api('/api/auth/session');
    return session;
  }

  function getSession() { return session; }
  function isAdmin() { return session && session.user && session.user.role === 'admin'; }
  function isAuthed() { return session && session.authenticated; }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtSize(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(2) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }

  function fmtTime(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  const STATUS_LABEL = {
    pending: '待审批', rejected: '已驳回', active: '正常', disabled: '已停用', archived: '已归档',
    sending: '传输中', completed: '已完成', stopped: '已停止', failed: '失败',
  };
  function statusBadge(status) {
    const map = {
      pending: 'yellow', rejected: 'red', active: 'green', disabled: 'gray', archived: 'gray',
      sending: 'blue', completed: 'green', stopped: 'gray', failed: 'red',
    };
    return `<span class="badge ${map[status] || 'gray'}">${STATUS_LABEL[status] || status}</span>`;
  }

  function navLinks(active) {
    const items = [
      { href: '/dashboard', label: '首页' },
      { href: '/app', label: '发送' },
      { href: '/records', label: '我的记录' },
    ];
    // 总管理：账号管理 = 管理所有账号（自改密在顶栏"改密"入口）；普通用户：账号 = 改自己的密码
    if (isAdmin()) {
      items.push({ href: '/stats', label: '统计' }, { href: '/users', label: '账号管理' }, { href: '/audit', label: '审计日志' });
    } else {
      items.push({ href: '/account', label: '账号' });
    }
    return items.map((it) => `<a href="${it.href}" class="${it.href === active ? 'active' : ''}">${it.label}</a>`).join('');
  }

  function renderTopbar(active) {
    const u = session.user;
    const el = document.getElementById('topbar');
    if (!el) return;
    el.innerHTML = `
      <div class="brand">◈ RaptorQR <span>发送管理</span></div>
      <nav>${navLinks(active)}</nav>
      <div class="spacer"></div>
      <div class="user">${escapeHtml(u.display_name || u.username)}${u.role === 'admin' ? ' · 总管理' : ''}</div>
      ${u.role === 'admin' ? '<a class="pwd-link" href="/account">改密</a>' : ''}
      <button class="logout" onclick="App.logout()">退出</button>
    `;
  }

  async function logout() {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch (_) { /* 忽略 */ }
    location.href = '/login';
  }

  function showAlert(msg, type = 'error') {
    const el = document.getElementById('alert');
    if (!el) { alert(msg); return; }
    el.className = `alert ${type} show`;
    el.textContent = msg;
  }
  function hideAlert() {
    const el = document.getElementById('alert');
    if (el) el.className = 'alert';
  }

  function bindPager(data, cb) {
    const box = document.getElementById('pager');
    if (!box) return;
    const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
    box.innerHTML = `
      <button id="pgPrev" ${data.page <= 1 ? 'disabled' : ''}>上一页</button>
      <span>第 ${data.page} / ${totalPages} 页 · 共 ${data.total} 条</span>
      <button id="pgNext" ${data.page >= totalPages ? 'disabled' : ''}>下一页</button>
    `;
    const prev = document.getElementById('pgPrev');
    const next = document.getElementById('pgNext');
    if (prev) prev.onclick = () => cb(data.page - 1);
    if (next) next.onclick = () => cb(data.page + 1);
  }

  /** 页面初始化：加载会话 + 渲染顶栏；未登录跳转 /login */
  async function init(active, { requireAdmin = false } = {}) {
    await loadSession();
    if (!isAuthed()) { location.href = '/login'; return false; }
    if (requireAdmin && !isAdmin()) { location.href = '/app'; return false; }
    renderTopbar(active);
    return true;
  }

  return { api, loadSession, getSession, isAdmin, isAuthed, escapeHtml, fmtSize, fmtTime, statusBadge, renderTopbar, logout, showAlert, hideAlert, bindPager, init, STATUS_LABEL };
})();

window.App = App;
