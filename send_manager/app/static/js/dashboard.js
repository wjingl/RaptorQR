/* ============================================================================
 * 工作台（仪表盘）：角色感知概览
 * - 总管理：待审批账号 + 全局统计 + 按目的地 + 成员传输记录（点击查看该成员全部记录）
 *           + 最近记录（含备份下载）+ 管理入口
 * - 普通用户：本人统计 + 按目的地 + 最近记录
 * ========================================================================== */
'use strict';

(async () => {
  if (!(await App.init('/dashboard'))) return;
  const isAdmin = App.isAdmin();

  document.getElementById('pageSub').textContent = isAdmin ? '总管理 · 全局传出概览' : '我的传出概览';
  document.getElementById('adminLinks').style.display = isAdmin ? '' : 'none';
  document.getElementById('pendingCard').style.display = isAdmin ? '' : 'none';
  document.getElementById('userCard').style.display = isAdmin ? '' : 'none';
  document.getElementById('thUser').style.display = isAdmin ? '' : 'none';
  document.getElementById('thBackup').style.display = isAdmin ? '' : 'none';

  function rowHtml(cells) {
    const tr = document.createElement('tr');
    tr.innerHTML = cells.map((c) => `<td>${c}</td>`).join('');
    return tr;
  }

  try {
    // 待审批账号（总管理）
    if (isAdmin) {
      const pend = await App.api('/api/users?status=pending&pageSize=20');
      const pc = document.getElementById('pendingCard');
      const pb = document.getElementById('pendingBody');
      if (!pend.rows.length) {
        pc.style.display = 'none';
      } else {
        pc.style.display = '';
        pb.innerHTML = '';
        for (const u of pend.rows) {
          const tr = rowHtml([
            App.escapeHtml(u.username),
            App.escapeHtml(u.display_name || ''),
            App.fmtTime(u.created_at),
            `<button class="btn sm green" data-id="${u.id}" data-act="approve">通过</button>
             <button class="btn sm red" data-id="${u.id}" data-act="reject">驳回</button>`,
          ]);
          pb.appendChild(tr);
        }
        pb.querySelectorAll('button[data-act]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const act = btn.dataset.act;
            if (act === 'reject' && !confirm(`确认驳回 ${btn.closest('tr').children[0].textContent}？`)) return;
            try {
              await App.api(`/api/users/${btn.dataset.id}/approve`, { method: 'POST', body: { decision: act } });
              location.reload();
            } catch (err) {
              App.showAlert(err.message);
            }
          });
        });
      }
    }

    // 统计卡
    const o = await App.api('/api/stats/overview');
    document.getElementById('sTotal').textContent = o.total;
    document.getElementById('sBytes').textContent = App.fmtSize(o.total_bytes);
    document.getElementById('sDone').textContent = o.completed;
    document.getElementById('sSending').textContent = o.sending;

    // 按目的地
    const dest = await App.api('/api/stats/destinations');
    const db = document.getElementById('destBody');
    db.innerHTML = '';
    if (!dest.rows.length) db.appendChild(rowHtml(['暂无数据', '-', '-', '-']));
    for (const r of dest.rows) db.appendChild(rowHtml([`<span class="badge blue">${App.escapeHtml(r.destination)}</span>`, r.n, App.fmtSize(r.bytes), r.completed]));

    // 成员传输记录（总管理，用户名可点击进入该成员全部记录）
    if (isAdmin) {
      const users = await App.api('/api/stats/users?limit=100');
      const ub = document.getElementById('userBody');
      ub.innerHTML = '';
      if (!users.rows.length) {
        ub.appendChild(rowHtml(['暂无数据', '-', '-', '-']));
      } else {
        for (const r of users.rows) {
          ub.appendChild(rowHtml([
            `<a href="/records?userId=${r.user_id}">${App.escapeHtml(r.username)}</a>`,
            r.n, App.fmtSize(r.bytes), r.completed,
          ]));
        }
      }
    }

    // 最近记录（总管理含备份下载）
    const rec = await App.api('/api/records?pageSize=8');
    const rb = document.getElementById('recBody');
    rb.innerHTML = '';
    if (!rec.rows.length) rb.appendChild(rowHtml([(isAdmin ? '<td></td>' : ''), '暂无记录', '-', '-', '-', '-']));
    for (const r of rec.rows) {
      const backup = r.backup_path
        ? `<a class="btn sm blue" href="/api/records/${r.id}/backup">下载</a>`
        : '<span style="color:#6e7681;font-size:12px;">—</span>';
      rb.appendChild(rowHtml([
        isAdmin ? App.escapeHtml(r.username) : '',
        App.fmtTime(r.started_at),
        `<span title="${App.escapeHtml(r.note)}" style="max-width:280px;overflow:hidden;text-overflow:ellipsis;display:inline-block;">${App.escapeHtml(r.filename)}</span>`,
        App.fmtSize(r.size),
        `<span class="badge blue">${App.escapeHtml(r.destination)}</span>`,
        App.statusBadge(r.status),
        isAdmin ? backup : '',
      ].filter((x) => x !== '')));
    }
  } catch (err) {
    App.showAlert(err.message);
  }
})();
