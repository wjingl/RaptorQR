/* ============================================================================
 * 账号管理页（总管理）：待审批 / 批量注册 / 全部账号操作
 * ========================================================================== */
'use strict';

(async () => {
  if (!(await App.init('/users', { requireAdmin: true }))) return;
  let page = 1;
  const pageSize = 20;

  /* ---------- 待审批 ---------- */
  async function loadPending() {
    const d = await App.api('/api/users?status=pending&pageSize=100');
    const body = document.getElementById('pendingBody');
    const empty = document.getElementById('pendingEmpty');
    body.innerHTML = '';
    empty.style.display = d.rows.length ? 'none' : '';
    for (const u of d.rows) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${App.escapeHtml(u.username)}</td>
        <td>${App.escapeHtml(u.display_name)}</td>
        <td>${App.fmtTime(u.created_at)}</td>
        <td>
          <button class="btn sm" data-act="approve" data-id="${u.id}">通过</button>
          <button class="btn sm secondary" data-act="reject" data-id="${u.id}">驳回</button>
        </td>
      `;
      body.appendChild(tr);
    }
    body.querySelectorAll('button[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => onApprove(btn.dataset.id, btn.dataset.act));
    });
  }

  async function onApprove(id, act) {
    let reason = '';
    if (act === 'reject') {
      reason = prompt('请输入驳回原因（可留空）：', '') || '';
    }
    try {
      await App.api(`/api/users/${id}/approve`, { method: 'POST', body: { decision: act, reason } });
      await Promise.all([loadPending(), loadUsers()]);
    } catch (err) { App.showAlert(err.message); }
  }

  /* ---------- 批量注册 ---------- */
  document.getElementById('btnBatch').addEventListener('click', async () => {
    const lines = document.getElementById('batchText').value;
    if (!lines.trim()) { App.showAlert('请输入批量注册内容'); return; }
    const btn = document.getElementById('btnBatch');
    btn.disabled = true;
    try {
      const d = await App.api('/api/users/batch', { method: 'POST', body: { lines } });
      document.getElementById('batchResult').textContent = `✅ 成功 ${d.created} 个，失败 ${d.failed} 个${d.errors.length ? '（' + d.errors.slice(0, 3).join('；') + '）' : ''}`;
      document.getElementById('batchText').value = '';
      await Promise.all([loadPending(), loadUsers()]);
    } catch (err) { App.showAlert(err.message); } finally { btn.disabled = false; }
  });

  /* ---------- 全部账号 ---------- */
  async function loadUsers() {
    const q = new URLSearchParams();
    const kw = document.getElementById('fQ').value.trim();
    const st = document.getElementById('fStatus').value;
    if (kw) q.set('q', kw);
    if (st) q.set('status', st);
    q.set('page', page);
    q.set('pageSize', pageSize);
    try {
      const d = await App.api('/api/users?' + q.toString());
      const body = document.getElementById('userBody');
      const empty = document.getElementById('userEmpty');
      body.innerHTML = '';
      empty.style.display = d.rows.length ? 'none' : '';
      for (const u of d.rows) {
        const tr = document.createElement('tr');
        const isSelf = u.id === App.getSession().user.id;
        const roleBtn = u.role === 'admin'
          ? '<button class="btn sm secondary" data-act="demote" data-id="' + u.id + '">降为普通</button>'
          : '<button class="btn sm secondary" data-act="promote" data-id="' + u.id + '">设为总管理</button>';
        tr.innerHTML = `
          <td>${App.escapeHtml(u.username)}</td>
          <td>${App.escapeHtml(u.display_name)}</td>
          <td>${u.role === 'admin' ? '<span class="badge yellow">总管理</span>' : '<span class="badge">普通</span>'}</td>
          <td>${App.statusBadge(u.status)}</td>
          <td>${App.fmtTime(u.created_at)}</td>
          <td>${u.last_login_at ? App.fmtTime(u.last_login_at) : '-'}</td>
          <td style="white-space:normal;">
            ${!isSelf ? '<button class="btn sm secondary" data-act="reset" data-id="' + u.id + '">重置密码</button>' : ''}
            ${!isSelf ? roleBtn : ''}
            ${!isSelf && u.status === 'active' ? '<button class="btn sm danger" data-act="disable" data-id="' + u.id + '">停用</button>' : ''}
            ${!isSelf && u.status === 'disabled' ? '<button class="btn sm" data-act="enable" data-id="' + u.id + '">启用</button>' : ''}
            ${!isSelf && u.status !== 'archived' ? '<button class="btn sm secondary" data-act="archive" data-id="' + u.id + '">归档</button>' : ''}
          </td>
        `;
        body.appendChild(tr);
      }
      body.querySelectorAll('button[data-act]').forEach((btn) => {
        btn.addEventListener('click', () => onUserAction(btn.dataset.act, btn.dataset.id));
      });
      App.bindPager(d, (p) => { page = p; loadUsers(); });
    } catch (err) { App.showAlert(err.message); }
  }

  async function onUserAction(act, id) {
    try {
      if (act === 'reset') {
        if (!confirm('确定重置该用户密码？用户下次登录将强制修改密码。')) return;
        const d = await App.api(`/api/users/${id}/reset-password`, { method: 'POST', body: {} });
        alert('新临时密码：' + d.temporaryPassword + '\n（请线下告知该用户，勿在聊天工具明文传播）');
      } else if (act === 'promote' || act === 'demote') {
        if (!confirm(act === 'promote' ? '将该账号设为总管理？' : '将该账号降为普通用户？')) return;
        await App.api(`/api/users/${id}/role`, { method: 'POST', body: { role: act === 'promote' ? 'admin' : 'user' } });
      } else if (act === 'disable') {
        if (!confirm('确定停用该账号？停用后立即无法登录。')) return;
        await App.api(`/api/users/${id}/status`, { method: 'POST', body: { action: 'disable' } });
      } else if (act === 'enable') {
        await App.api(`/api/users/${id}/status`, { method: 'POST', body: { action: 'enable' } });
      } else if (act === 'archive') {
        if (!confirm('确定归档该账号？账号将无法登录，历史记录保留。')) return;
        await App.api(`/api/users/${id}/status`, { method: 'POST', body: { action: 'archive' } });
      }
      await Promise.all([loadPending(), loadUsers()]);
    } catch (err) { App.showAlert(err.message); }
  }

  document.getElementById('btnSearch').addEventListener('click', () => { page = 1; loadUsers(); });
  document.getElementById('fQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') { page = 1; loadUsers(); } });
  document.getElementById('fStatus').addEventListener('change', () => { page = 1; loadUsers(); });

  try {
    await Promise.all([loadPending(), loadUsers()]);
  } catch (err) { App.showAlert(err.message); }
})();
