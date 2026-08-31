/* ============================================================================
 * 账号页：自助改密 / 强制改密
 * ========================================================================== */
'use strict';

(async () => {
  if (!(await App.init('/account'))) return;
  const forced = new URLSearchParams(location.search).get('forced') === '1';
  const s = App.getSession();
  const forcedFlag = forced || s.mustChangePassword;

  document.getElementById('infoUsername').textContent = s.user.username;
  document.getElementById('infoRole').textContent = s.user.role === 'admin' ? '总管理' : '普通用户';

  if (forcedFlag) {
    document.getElementById('forcedWarn').style.display = '';
    document.getElementById('oldRow').style.display = 'none';
  }

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

  const form = document.getElementById('pwForm');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    App.hideAlert();
    const oldPassword = document.getElementById('oldPassword').value;
    const newPassword = document.getElementById('newPassword').value;
    const newPassword2 = document.getElementById('newPassword2').value;
    if (newPassword.length < 8) { App.showAlert('新密码至少 8 位'); return; }
    if (newPassword !== newPassword2) { App.showAlert('两次输入的新密码不一致'); return; }
    const path = forcedFlag ? '/api/auth/change-password-forced' : '/api/auth/change-password';
    try {
      const d = await App.api(path, { method: 'POST', body: { oldPassword, newPassword } });
      App.showAlert(d.message || '密码已修改', 'success');
      setTimeout(() => { location.href = '/login'; }, 1500);
    } catch (err) {
      App.showAlert(err.message);
    }
  });
})();
