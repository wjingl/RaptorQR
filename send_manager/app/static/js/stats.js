/* ============================================================================
 * 统计页（总管理）：全局 + 每人 + 目的地 + 每日趋势
 * ========================================================================== */
'use strict';

(async () => {
  if (!(await App.init('/stats', { requireAdmin: true }))) return;

  function rowHtml(cells) {
    const tr = document.createElement('tr');
    tr.innerHTML = cells.map((c) => `<td>${c}</td>`).join('');
    return tr;
  }

  async function load() {
    try {
      const o = await App.api('/api/stats/overview');
      document.getElementById('sTotal').textContent = o.total;
      document.getElementById('sBytes').textContent = App.fmtSize(o.total_bytes);
      document.getElementById('sDone').textContent = o.completed;
      document.getElementById('sSending').textContent = o.sending;

      const dest = await App.api('/api/stats/destinations');
      const db = document.getElementById('destBody');
      db.innerHTML = '';
      if (!dest.rows.length) db.appendChild(rowHtml(['暂无数据', '-', '-', '-']));
      for (const r of dest.rows) db.appendChild(rowHtml([`<span class="badge blue">${App.escapeHtml(r.destination)}</span>`, r.n, App.fmtSize(r.bytes), r.completed]));

      const users = await App.api('/api/stats/users');
      const ub = document.getElementById('userBody');
      ub.innerHTML = '';
      if (!users.rows.length) ub.appendChild(rowHtml(['暂无数据', '-', '-', '-']));
      for (const r of users.rows) ub.appendChild(rowHtml([App.escapeHtml(r.username), r.n, App.fmtSize(r.bytes), r.completed]));

      const daily = await App.api('/api/stats/daily?days=30');
      const dlb = document.getElementById('dailyBody');
      dlb.innerHTML = '';
      for (const r of daily.rows) dlb.appendChild(rowHtml([r.day, r.n, App.fmtSize(r.bytes)]));
    } catch (err) {
      App.showAlert(err.message);
    }
  }

  load();
})();
