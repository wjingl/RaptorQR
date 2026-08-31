/* ============================================================================
 * 首次初始化：创建总管理账号
 * ========================================================================== */
'use strict';

(async () => {
  // 已初始化则被服务端重定向；此页仅在无管理员时可访问
  const form = document.getElementById('setupForm');

  // 显示/隐藏密码
  document.querySelectorAll('.pw-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = btn.previousElementSibling;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? '🙈' : '👁';
      input.focus();
    });
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    App.hideAlert();
    const username = document.getElementById('username').value.trim();
    const displayName = document.getElementById('displayName').value.trim();
    const password = document.getElementById('password').value;
    const password2 = document.getElementById('password2').value;
    if (!username || !displayName || !password) { App.showAlert('请填写完整信息'); return; }
    if (password.length < 8) { App.showAlert('密码至少 8 位'); return; }
    if (password !== password2) { App.showAlert('两次输入的密码不一致'); return; }
    try {
      await App.api('/api/setup', { method: 'POST', body: { username, displayName, password } });
      App.showAlert('总管理账号创建成功，请登录', 'success');
      setTimeout(() => { location.href = '/login'; }, 1200);
    } catch (err) {
      App.showAlert(err.message);
    }
  });
})();
