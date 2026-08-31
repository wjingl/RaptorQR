/* ============================================================================
 * 传出记录页：筛选 / 分页 / 普通用户仅本人，总管理可见全部（可切换成员）
 * - 传输中记录：单个"停止"操作 → 标记为已完成（语义：停止即完成，无单独完成按钮）
 * - 备份列：有备份且有权 → 下载；总管理可下载全部，普通用户仅自己记录可见
 * ========================================================================== */
'use strict';

(async () => {
  if (!(await App.init('/records'))) return;
  const tbody = document.getElementById('tbody');
  const empty = document.getElementById('empty');
  let isAdmin = false;
  let page = 1;
  let pageSize = 20;

  async function load() {
    const q = new URLSearchParams();
    const dest = document.getElementById('fDest').value;
    const status = document.getElementById('fStatus').value;
    const from = document.getElementById('fFrom').value;
    const to = document.getElementById('fTo').value;
    const kw = document.getElementById('fQ').value.trim();
    const userId = document.getElementById('fUser').value;
    if (dest) q.set('destination', dest);
    if (status) q.set('status', status);
    if (from) q.set('from', from + 'T00:00:00');
    if (to) q.set('to', to + 'T23:59:59');
    if (kw) q.set('q', kw);
    if (userId) q.set('userId', userId);
    q.set('page', page);
    q.set('pageSize', pageSize);
    try {
      const d = await App.api('/api/records?' + q.toString());
      isAdmin = d.isAdmin;
      document.getElementById('thUser').style.display = isAdmin ? '' : 'none';
      document.getElementById('userFilter').style.display = isAdmin ? '' : 'none';
      document.getElementById('pageSub').textContent = isAdmin ? '全部用户的文件传出记录' : '我的文件传出记录';
      render(d);
      App.bindPager(d, (p) => { page = p; load(); });
    } catch (err) {
      App.showAlert(err.message);
    }
  }

  function render(d) {
    tbody.innerHTML = '';
    empty.style.display = d.rows.length ? 'none' : '';
    for (const r of d.rows) {
      const tr = document.createElement('tr');
      // 传输中：单个"停止"（语义 = 标记完成）；无单独完成按钮
      let ops = '';
      if (r.status === 'sending') {
        ops = `<button class="btn sm secondary" data-id="${r.id}" data-act="stop">停止</button>`;
      } else {
        ops = '<span style="color:#6e7681;font-size:12px;">—</span>';
      }
      // 备份列：backup_path 非空表示服务器有 7 天备份
      const backup = r.backup_path
        ? `<a class="btn sm blue" href="/api/records/${r.id}/backup">下载</a>`
        : '<span style="color:#6e7681;font-size:12px;">—</span>';
      tr.innerHTML = `
        <td>#${r.id}</td>
        <td ${isAdmin ? '' : 'style="display:none;"'}>${App.escapeHtml(r.username)}</td>
        <td>${App.fmtTime(r.started_at)}</td>
        <td title="${App.escapeHtml(r.note)}" style="max-width:260px;overflow:hidden;text-overflow:ellipsis;">${App.escapeHtml(r.filename)}</td>
        <td>${App.fmtSize(r.size)}</td>
        <td><span class="badge blue">${App.escapeHtml(r.destination)}</span></td>
        <td>${App.statusBadge(r.status)}</td>
        <td>${r.completed_at ? App.fmtTime(r.completed_at) : '-'}</td>
        <td>${backup}</td>
        <td>${ops}</td>
      `;
      tbody.appendChild(tr);
    }
    tbody.querySelectorAll('button[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => changeStatus(btn.dataset.id));
    });
  }

  async function changeStatus(id) {
    if (!confirm('确认停止该传输并标记为已完成？')) return;
    try {
      await App.api(`/api/records/${id}/status`, { method: 'POST', body: { status: 'completed', note: '手动停止（记录页）' } });
      load();
    } catch (err) {
      App.showAlert(err.message);
    }
  }

  // 填充目的地筛选
  try {
    const info = await App.api('/api/system/info').catch(() => null);
    const sys = info || {};
    const dests = (sys.destinations || ['jzw', 'bgw', 'my', 'sjw']);
    const sel = document.getElementById('fDest');
    dests.forEach((d) => { const o = document.createElement('option'); o.value = d; o.textContent = d; sel.appendChild(o); });
  } catch (_) { /* 非管理员拿不到 system/info 也能工作 */ }

  // 总管理：填充用户筛选（来自 /api/users）
  try {
    const users = await App.api('/api/users');
    const uSel = document.getElementById('fUser');
    for (const u of users.rows) {
      const o = document.createElement('option');
      o.value = u.id;
      o.textContent = `${u.username}（${u.display_name || ''}）`;
      uSel.appendChild(o);
    }
  } catch (_) { /* 非管理员无 /api/users 权限，保持隐藏 */ }

  document.getElementById('btnSearch').addEventListener('click', () => { page = 1; load(); });
  document.getElementById('fQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') { page = 1; load(); } });
  document.getElementById('fUser').addEventListener('change', () => { page = 1; load(); });
  load();
})();
