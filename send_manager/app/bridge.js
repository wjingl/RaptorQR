'use strict';
/* ============================================================================
 * 发送工作台桥接：在单文件发送页 </body> 前注入独立 <script>
 * - 源文件字节不变（服务时模板化注入）
 * - 提供目的地选择（jzw/bgw/my/sjw）、文件/文本选择、开始发送
 * - 自动联动：开始→创建记录（含传输内容备份）→点击应用 Start；应用 Stop → completed；出错 → failed
 * - 工具栏含角色感知导航（首页/我的记录/统计/账号管理/审计日志/退出），解决 /app 无法返回的问题
 * - 绕过桥接直接点应用内 Start → 提示未记录
 * ========================================================================== */

function createBridge(ctx) {
  const { config } = ctx;
  const destinations = JSON.stringify(config.destinations);

  // 注意：以下模板字符串中避免使用 `</script>` 字面量（防提前闭合），用转义拼接
  const script = `
(function () {
  'use strict';
  /* __RQR_SENDER_BRIDGE__ */
  var DESTINATIONS = ${destinations};
  var API = '/api';
  var csrfToken = null;
  var activeRecordId = null;   // 当前进行中的记录
  var selectedFile = null;     // {name,size,mime,sha256}
  var mode = 'file';           // 'file' | 'text'
  var busy = false;
  var sessionUser = null;      // /api/auth/session 返回的 user（用于角色导航）

  var COLORS = { panel: '#161b22', border: '#30363d', bg: '#0d1117', text: '#c9d1d9', sub: '#8b949e', green: '#238636', greenH: '#2ea043', red: '#da3633', accent: '#58a6ff' };

  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === 'style') e.style.cssText = attrs[k];
      else if (k === 'text') e.textContent = attrs[k];
      else e.setAttribute(k, attrs[k]);
    }
    (children || []).forEach(function (c) { e.appendChild(c); });
    return e;
  }

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  /* ---------- API ---------- */
  async function api(path, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
    if (opts.body !== undefined && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
    var res = await fetch(API + path, Object.assign({}, opts, { headers: Object.assign(headers, opts.headers), credentials: 'same-origin' }));
    if (res.status === 401) { location.href = '/login'; throw new Error('未登录'); }
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || ('请求失败 (' + res.status + ')'));
    return data;
  }

  async function refreshCsrf() {
    var d = await api('/auth/session');
    if (d.csrfToken) csrfToken = d.csrfToken;
    sessionUser = d.authenticated ? d.user : null;
    renderNav();
  }

  /** ArrayBuffer / Uint8Array → base64（分块拼接防调用栈溢出） */
  function toBase64(data) {
    var bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    var bin = '';
    var CHUNK = 0x8000;
    for (var i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  /* ---------- DOM 帮助 ---------- */
  function appButtons() { return $$('#root button'); }
  function findButton(text) { return appButtons().find(function (b) { return b.textContent.trim().indexOf(text) !== -1; }); }
  function fileInput() { return $('#root input[type="file"]'); }
  function textArea() { return $('#root textarea[placeholder*="transfer"]'); }
  function statusLine() {
    return $$('#root div').find(function (d) { return /^Live QR running/.test(d.textContent.trim()) || d.textContent.trim() === 'Stopped.' || /^Encoded/.test(d.textContent.trim()); });
  }
  function currentStatusText() {
    var s = statusLine();
    return s ? s.textContent.trim() : '';
  }

  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  async function sha256OfFile(file) {
    try {
      var buf = await file.arrayBuffer();
      var digest = await crypto.subtle.digest('SHA-256', buf);
      return Array.from(new Uint8Array(digest)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    } catch (_) { return ''; }
  }

  /* ---------- 工具栏 UI ---------- */
  var bar = el('div', {
    style: 'position:fixed;top:0;left:0;right:0;z-index:99999;background:' + COLORS.panel + ';border-bottom:1px solid ' + COLORS.border + ';padding:8px 12px;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:' + COLORS.text + ';display:flex;flex-wrap:wrap;gap:8px;align-items:center;box-shadow:0 2px 8px rgba(0,0,0,.4);'
  });

  var title = el('span', { text: '📤 发送管理', style: 'font-weight:600;font-size:14px;margin-right:4px;' });

  var sel = el('select', { style: 'background:' + COLORS.bg + ';color:' + COLORS.text + ';border:1px solid ' + COLORS.border + ';border-radius:6px;padding:5px 8px;font-size:13px;' });
  var opt0 = el('option', { text: '选择目的地…', value: '' });
  opt0.disabled = true; opt0.selected = true;
  sel.appendChild(opt0);
  DESTINATIONS.forEach(function (d) { sel.appendChild(el('option', { text: d, value: d })); });

  var modeSel = el('select', { style: 'background:' + COLORS.bg + ';color:' + COLORS.text + ';border:1px solid ' + COLORS.border + ';border-radius:6px;padding:5px 8px;font-size:13px;' });
  modeSel.appendChild(el('option', { text: '文件', value: 'file' }));
  modeSel.appendChild(el('option', { text: '文本', value: 'text' }));

  var fileBtn = el('button', { style: 'background:' + COLORS.bg + ';color:' + COLORS.text + ';border:1px solid ' + COLORS.border + ';border-radius:6px;padding:5px 10px;font-size:13px;cursor:pointer;' }, [el('span', { text: '选择文件' })]);
  var startBtn = el('button', { style: 'background:' + COLORS.green + ';color:#fff;border:none;border-radius:6px;padding:6px 14px;font-size:13px;cursor:pointer;font-weight:600;' }, [el('span', { text: '▶ 开始发送' })]);

  var info = el('span', { text: '', style: 'font-size:12px;color:' + COLORS.sub + ';max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' });
  var status = el('span', { text: '就绪', style: 'font-size:12px;color:' + COLORS.sub + ';' });

  /* 角色感知导航（/app 单页内的返回管理后台入口） */
  var navBox = el('div', { style: 'display:flex;gap:2px;align-items:center;margin-left:auto;flex-wrap:wrap;' });
  function navLink(href, text) {
    return el('a', { href: href, text: text, style: 'color:' + COLORS.accent + ';font-size:12px;text-decoration:none;padding:5px 8px;border-radius:4px;white-space:nowrap;' });
  }
  function renderNav() {
    navBox.innerHTML = '';
    if (!sessionUser) { navBox.appendChild(navLink('/login', '登录')); return; }
    var isAdmin = sessionUser.role === 'admin';
    navBox.appendChild(navLink('/dashboard', '首页'));
    navBox.appendChild(navLink('/records', '我的记录'));
    if (isAdmin) {
      navBox.appendChild(navLink('/stats', '统计'));
      navBox.appendChild(navLink('/users', '账号管理'));
      navBox.appendChild(navLink('/audit', '审计日志'));
    }
    var lo = el('a', { href: '#', text: '退出登录', style: 'color:' + COLORS.red + ';font-size:12px;text-decoration:none;padding:5px 8px;border-radius:4px;white-space:nowrap;' });
    lo.addEventListener('click', function (e) {
      e.preventDefault();
      api('/auth/logout', { method: 'POST' }).catch(function () {}).then(function () { location.href = '/login'; });
    });
    navBox.appendChild(lo);
  }

  [title, sel, modeSel, fileBtn, startBtn, info, status, navBox].forEach(function (n) { bar.appendChild(n); });
  document.body.appendChild(bar);

  // 给应用内容留出顶部空间
  var pad = el('div', { style: 'height:52px;' });
  document.body.insertBefore(pad, document.body.firstChild);

  /* ---------- 模式切换（联动应用内 File/Text 页签） ---------- */
  function switchMode(m) {
    mode = m;
    if (m === 'file') {
      var f = findButton('File');
      if (f) f.click();
    } else {
      var t = findButton('Text');
      if (t) t.click();
    }
    renderInfo();
  }
  modeSel.addEventListener('change', function () { switchMode(modeSel.value); });

  function renderInfo() {
    if (mode === 'file' && selectedFile) {
      info.textContent = selectedFile.name + ' · ' + fmtSize(selectedFile.size);
    } else if (mode === 'file') {
      info.textContent = '未选择文件';
    } else {
      var ta = textArea();
      var t = ta ? ta.value : '';
      info.textContent = '文本 · ' + t.length + ' 字符';
    }
  }

  /* ---------- 文件选择 ---------- */
  fileBtn.addEventListener('click', function () {
    var inp = fileInput();
    if (!inp) { setStatus('请先停留在发送页文件模式'); return; }
    inp.click();
  });

  // 监听应用文件 input 变化（桥接不干预应用自身逻辑）
  var observer = new MutationObserver(function () {
    var inp = fileInput();
    if (inp) {
      if (!inp.__bridgeBound) {
        inp.__bridgeBound = true;
        inp.addEventListener('change', function () {
          var f = inp.files && inp.files[0];
          if (f) {
            selectedFile = { name: f.name, size: f.size, mime: f.type || 'application/octet-stream', sha256: '' };
            sha256OfFile(f).then(function (h) { if (selectedFile && selectedFile.name === f.name) selectedFile.sha256 = h; });
            renderInfo();
          }
        });
      }
    }
  });
  observer.observe(document.getElementById('root') || document.body, { childList: true, subtree: true });

  function setStatus(txt, isErr) {
    status.textContent = txt;
    status.style.color = isErr ? COLORS.red : COLORS.sub;
  }

  /* ---------- 开始发送 ---------- */
  startBtn.addEventListener('click', async function () {
    if (busy) return;
    var dest = sel.value;
    if (!dest) { setStatus('请先选择目的地', true); return; }

    var payload = null;
    if (mode === 'file') {
      var inp = fileInput();
      var f = inp && inp.files && inp.files[0];
      if (!f) { setStatus('请先选择文件', true); return; }
      if (f.size > 8 * 1024 * 1024) { setStatus('文件超过 8MB 上限', true); return; }
      var fileBuf = await f.arrayBuffer();
      payload = { destination: dest, filename: f.name, size: f.size, mime: f.type || 'application/octet-stream', isText: false, sha256: selectedFile && selectedFile.sha256 || '', content: toBase64(fileBuf) };
    } else {
      var ta = textArea();
      var text = ta ? ta.value : '';
      if (!text) { setStatus('请输入要发送的文本', true); return; }
      var enc = new TextEncoder().encode(text);
      payload = { destination: dest, filename: '文本_' + text.slice(0, 20).replace(/[\\/:*?"<>|\\r\\n]/g, '') + '.txt', size: enc.length, mime: 'text/plain', isText: true, sha256: '', content: toBase64(enc) };
    }

    try {
      busy = true;
      await refreshCsrf();
      // 关闭上一笔未完结记录（视为已完成）
      if (activeRecordId) { try { await api('/records/' + activeRecordId + '/status', { method: 'POST', body: { status: 'completed', note: '上一笔自动完成（新发送开始）' } }); } catch (_) {} }
      var r = await api('/records', { method: 'POST', body: payload });
      activeRecordId = r.record.id;
      setStatus('记录已创建 #' + activeRecordId + '，正在启动发送…');
      // 点击应用内 Start Live QR
      var sb = findButton('Start Live QR');
      if (!sb) { setStatus('未找到发送按钮，请检查发送页状态', true); return; }
      if (sb.disabled) { setStatus('应用仍在编码，请稍候再点开始', true); return; }
      sb.click();
      setStatus('传输中（记录 #' + activeRecordId + ' → ' + dest + '）');
    } catch (err) {
      setStatus('失败：' + err.message, true);
    } finally {
      busy = false;
    }
  });

  /* ---------- 状态行自动联动 ---------- */
  // 应用内错误提示（#root 中以 ⚠ 开头的短文本），用于把失败记录标为 failed
  function appErrorText() {
    var root = document.getElementById('root');
    if (!root) return '';
    var els = root.querySelectorAll('div, span');
    for (var i = 0; i < els.length; i++) {
      var t = els[i].textContent.trim();
      if (t.length > 2 && t.length < 300 && t.indexOf('⚠') === 0) return t;
    }
    return '';
  }

  var lastStatus = '';
  var lastErr = '';
  setInterval(function () {
    var t = currentStatusText();
    var err = appErrorText();
    if (t === lastStatus && err === lastErr) return;
    lastStatus = t;
    lastErr = err;
    if (/^Live QR running/.test(t) && activeRecordId) {
      setStatus('传输中（记录 #' + activeRecordId + '）');
    } else if (t === 'Stopped.' && activeRecordId) {
      // 用户点应用内 Stop：视为本次传输完成
      api('/records/' + activeRecordId + '/status', { method: 'POST', body: { status: 'completed', note: '发送已停止' } }).then(function () {
        setStatus('已完成（记录 #' + activeRecordId + '）');
        activeRecordId = null;
      }).catch(function () {});
    } else if (err && activeRecordId) {
      api('/records/' + activeRecordId + '/status', { method: 'POST', body: { status: 'failed', note: '传输出错：' + err.slice(0, 100) } }).then(function () {
        setStatus('已记录失败（#' + activeRecordId + '）');
        activeRecordId = null;
      }).catch(function () {});
    }
  }, 1500);

  // 防绕过：直接点击应用内 Start 而未走桥接
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('button') : null;
    if (b && b.textContent.trim().indexOf('Start Live QR') !== -1 && !activeRecordId && !busy) {
      setTimeout(function () {
        if (!activeRecordId) setStatus('⚠ 本次未记录：请通过顶部"开始发送"进行管理发送', true);
      }, 300);
    }
  }, true);

  refreshCsrf().catch(function () {});
})();
`;

  // 防止脚本字符串内出现 `</script>` 提前闭合
  return script.replace(/<\//g, '<\\/');
}

module.exports = { createBridge };
