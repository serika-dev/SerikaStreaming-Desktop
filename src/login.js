// ─── DOM refs ──────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const tabs = document.querySelectorAll('.tab');
const tabContents = document.querySelectorAll('.tab-content');
const errorEl = $('error');

// QR elements
const qrLoading = $('qr-loading');
const qrContent = $('qr-content');
const qrImage = $('qr-image');
const qrCodeDisplay = $('qr-code-display');
const qrTimer = $('qr-timer');
const qrRefresh = $('qr-refresh');
const qrLinked = $('qr-linked');

// Password elements
const loginForm = $('login-form');
const emailInput = $('email');
const passwordInput = $('password');
const rememberMe = $('remember-me');
const loginBtn = $('login-btn');
const togglePw = $('toggle-password');

// 2FA elements
const mfaOverlay = $('mfa-overlay');
const mfaForm = $('mfa-form');
const mfaCodeInput = $('mfa-code');
const mfaBtn = $('mfa-btn');
const mfaBack = $('mfa-back');

// ─── State ─────────────────────────────────────────────────────────────────

let currentTab = 'qr';
let qrCode = null;
let qrPollInterval = null;
let qrCountdownInterval = null;
let qrTimeLeft = 0;

// ─── Helpers ───────────────────────────────────────────────────────────────

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.classList.remove('hidden');
}

function clearError() {
  errorEl.classList.add('hidden');
}

function setLoading(btn, loading) {
  const text = btn.querySelector('.btn-text');
  const spinner = btn.querySelector('.btn-spinner');
  if (loading) {
    text.classList.add('hidden');
    spinner.classList.remove('hidden');
    btn.disabled = true;
  } else {
    text.classList.remove('hidden');
    spinner.classList.add('hidden');
    btn.disabled = false;
  }
}

function switchTab(tab) {
  currentTab = tab;
  tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  tabContents.forEach(c => {
    const isActive = c.id === `${tab}-tab`;
    c.classList.toggle('active', isActive);
  });
  clearError();
}

function completeLogin() {
  window.serika.completeLogin();
}

// ─── Tab switching ─────────────────────────────────────────────────────────

tabs.forEach(tab => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

// ─── Password login ────────────────────────────────────────────────────────

togglePw.addEventListener('click', () => {
  const isPw = passwordInput.type === 'password';
  passwordInput.type = isPw ? 'text' : 'password';
});

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError();
  setLoading(loginBtn, true);

  try {
    const result = await window.serika.login(
      emailInput.value,
      passwordInput.value,
      rememberMe.checked
    );

    if (!result || result.success === false) {
      showError(result?.message || 'Invalid email or password');
      return;
    }

    if (result.requiresTwoFactor) {
      mfaOverlay.classList.remove('hidden');
      mfaCodeInput.focus();
      return;
    }

    completeLogin();
  } catch {
    showError('Something went wrong. Please try again.');
  } finally {
    setLoading(loginBtn, false);
  }
});

// ─── 2FA ───────────────────────────────────────────────────────────────────

mfaForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError();
  setLoading(mfaBtn, true);

  try {
    const result = await window.serika.verify2FA(mfaCodeInput.value);

    if (!result || result.success === false || result.code) {
      showError(result?.message || 'Invalid authentication code');
      return;
    }

    completeLogin();
  } catch {
    showError('Unable to verify code. Please try again.');
  } finally {
    setLoading(mfaBtn, false);
  }
});

mfaBack.addEventListener('click', () => {
  mfaOverlay.classList.add('hidden');
  mfaCodeInput.value = '';
  clearError();
});

// ─── QR login ──────────────────────────────────────────────────────────────

async function generateQR() {
  qrLoading.classList.remove('hidden');
  qrContent.classList.add('hidden');
  qrLinked.classList.add('hidden');
  qrRefresh.classList.add('hidden');
  clearError();

  stopQRPolling();

  try {
    const result = await window.serika.generateQR();

    if (result.error) {
      showError(result.error);
      qrLoading.classList.add('hidden');
      qrRefresh.classList.remove('hidden');
      return;
    }

    qrCode = result.code;
    qrTimeLeft = result.expiresIn;

    if (result.qrDataUrl) {
      qrImage.src = result.qrDataUrl;
    }

    // Render code characters
    qrCodeDisplay.innerHTML = '';
    for (const char of result.code) {
      const span = document.createElement('span');
      span.className = 'char';
      span.textContent = char;
      qrCodeDisplay.appendChild(span);
    }

    qrLoading.classList.add('hidden');
    qrContent.classList.remove('hidden');

    startQRPolling();
    startQRCountdown();
  } catch {
    showError('Failed to generate QR code. Try again.');
    qrLoading.classList.add('hidden');
    qrRefresh.classList.remove('hidden');
  }
}

function startQRPolling() {
  stopQRPolling();
  qrPollInterval = setInterval(async () => {
    if (!qrCode) return;
    try {
      const result = await window.serika.pollQR(qrCode);

      if (result.status === 'linked') {
        stopQRPolling();
        stopQRCountdown();
        qrContent.classList.add('hidden');
        qrLinked.classList.remove('hidden');
        setTimeout(completeLogin, 800);
      } else if (result.status === 'expired') {
        stopQRPolling();
        stopQRCountdown();
        qrContent.classList.add('hidden');
        qrRefresh.classList.remove('hidden');
        qrTimer.textContent = 'Code expired';
      }
    } catch {
      // ignore poll errors
    }
  }, 3000);
}

function startQRCountdown() {
  stopQRCountdown();
  qrCountdownInterval = setInterval(() => {
    qrTimeLeft--;
    if (qrTimeLeft <= 0) {
      stopQRCountdown();
      // Auto-refresh
      generateQR();
      return;
    }
    const mins = Math.floor(qrTimeLeft / 60);
    const secs = (qrTimeLeft % 60).toString().padStart(2, '0');
    qrTimer.textContent = `Waiting for link… ${mins}:${secs}`;
  }, 1000);
}

function stopQRPolling() {
  if (qrPollInterval) {
    clearInterval(qrPollInterval);
    qrPollInterval = null;
  }
}

function stopQRCountdown() {
  if (qrCountdownInterval) {
    clearInterval(qrCountdownInterval);
    qrCountdownInterval = null;
  }
}

qrRefresh.addEventListener('click', generateQR);

// ─── Init ──────────────────────────────────────────────────────────────────

// Start with QR tab
generateQR();
