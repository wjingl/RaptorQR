/* ============================================================================
 * 登录页逻辑：验证码按需加载、登录、错误提示
 * ========================================================================== */
'use strict';

(async () => {
  const form = document.getElementById('loginForm');
  const captchaRow = document.getElementById('captchaRow');
  const captchaImg = document.getElementById('captchaImg');
  const answer = document.getElementById('captchaAnswer');
  const pwInput = document.getElementById('password');
  const togglePw = document.getElementById('togglePw');
  let captchaId = '';
  let needCaptcha = false;

  // 显示/隐藏密码
  if (togglePw) {
    togglePw.addEventListener('click', () => {
      const show = pwInput.type === 'password';
      pwInput.type = show ? 'text' : 'password';
      togglePw.textContent = show ? '🙈' : '👁';
      togglePw.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
      pwInput.focus();
    });
  }

  async function loadCaptcha() {
    try {
      const d = await App.api('/api/captcha');
      captchaId = d.id;
      captchaImg.innerHTML = d.svg;
      captchaImg.onclick = loadCaptcha;
      answer.value = '';
    } catch (_) { /* 验证码加载失败，仅限流时要求 */ }
  }

  async function setNeedCaptcha(flag) {
    needCaptcha = flag;
    captchaRow.style.display = flag ? '' : 'none';
    if (flag) await loadCaptcha();
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    App.hideAlert();
    const body = {
      username: document.getElementById('username').value.trim(),
      password: document.getElementById('password').value,
      captchaId,
      captchaAnswer: answer.value.trim(),
    };
    if (!body.username || !body.password) { App.showAlert('请输入用户名和密码'); return; }
    try {
      const d = await App.api('/api/auth/login', { method: 'POST', body });
      const target = d.mustChangePassword ? '/account?forced=1' : (d.user && d.user.role === 'admin' ? '/dashboard' : '/app');
      location.href = target;
    } catch (err) {
      App.showAlert(err.message);
      if (err.data && (err.data.needCaptcha || err.status === 423)) {
        await setNeedCaptcha(true);
      }
    }
  });

  // 已登录直接进工作台
  try {
    const s = await App.loadSession();
    if (s.authenticated) { location.href = s.user && s.user.role === 'admin' ? '/dashboard' : '/app'; return; }
  } catch (_) { /* 未初始化 */ }
})();
