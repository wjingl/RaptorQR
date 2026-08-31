/* ============================================================================
 * 审计日志页（总管理）
 * ========================================================================== */
'use strict';

(async () => {
  if (!(await App.init('/audit', { requireAdmin: true }))) return;
  let page = 1;
  const pageSize = 30;
  const tbody = document.getElementById('tbody');
  const empty = document.getElementById('empty');

  async function load() {
    const q = new URLSearchParams();
    const kw = document.getElementById('fQ').value.trim();
    if (kw) q.set('q', kw);
    q.set('page', page);
    q.set('pageSize', pageSize);
    try {
      const d = await App.api('/api/audit?' + q.toString());
      tbody.innerHTML = '';
      empty.style.display = d.rows.length ? 'none' : '';
      for (const a of d.rows) {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${App.fmtTime(a.ts)}</td>
          <td>${App.escapeHtml(a.username || '-')}</td>
          <td><span class="badge blue">${App.escapeHtml(a.action)}</span></td>
          <td style="white-space:normal;max-width:420px;">${App.escapeHtml(a.detail)}</td>
          <td>${App.escapeHtml(a.ip)}</td>
        `;
        tbody.appendChild(tr);
      }
      App.bindPager(d, (p) => { page = p; load(); });
    } catch (err) { App.showAlert(err.message); }
  }

  document.getElementById('btnSearch').addEventListener('click', () => { page = 1; load(); });
  document.getElementById('fQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') { page = 1; load(); } });
  load();
})();
