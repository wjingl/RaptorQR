/* ============================================================================
 * 自助注册：提交后待总管理审批
 * ========================================================================== */
'use strict';

(async () => {
  const form = document.getElementById('registerForm');

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
    if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) { App.showAlert('用户名仅允许字母/数字/下划线，3-32 位'); return; }
    if (!displayName) { App.showAlert('请填写姓名'); return; }
    if (password.length < 8) { App.showAlert('密码至少 8 位'); return; }
    if (password !== password2) { App.showAlert('两次输入的密码不一致'); return; }
    try {
      await App.api('/api/auth/register', { method: 'POST', body: { username, displayName, password } });
      App.showAlert('注册申请已提交，请等待总管理审批', 'success');
      setTimeout(() => { location.href = '/login'; }, 1500);
    } catch (err) {
      App.showAlert(err.message);
    }
  });
})();
