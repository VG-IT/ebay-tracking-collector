const emailEl = document.getElementById('email');
const tokenEl = document.getElementById('token');
const daysEl = document.getElementById('days');
const saveBtn = document.getElementById('save-btn');
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const refreshSessionBtn = document.getElementById('refresh-session-btn');
const openLoginBtn = document.getElementById('open-login-btn');
const refreshLogsBtn = document.getElementById('refresh-logs-btn');
const clearLogsBtn = document.getElementById('clear-logs-btn');
const loginBanner = document.getElementById('login-banner');
const loginBannerText = document.getElementById('login-banner-text');
const loginText = document.getElementById('login-text');
const statusText = document.getElementById('status-text');
const phaseText = document.getElementById('phase-text');
const progressText = document.getElementById('progress-text');
const logEl = document.getElementById('log');
const runLogTabsEl = document.getElementById('run-log-tabs');
const historyLogEl = document.getElementById('history-log');

let session = {
  checked: false,
  loggedIn: false,
};
let running = false;
let runLogs = [];
let selectedRunId = null;

function appendLog(line) {
  const stamp = new Date().toLocaleTimeString();
  logEl.textContent += `[${stamp}] ${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function setBusy(busy) {
  refreshSessionBtn.disabled = busy;
  openLoginBtn.disabled = busy;
}

function formatRunTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch (_) {
    return iso;
  }
}

function statusLabel(status) {
  const map = {
    running: 'Running',
    completed: 'Completed',
    stopped: 'Stopped',
    logged_out: 'Logged out',
    error: 'Failed',
    interrupted: 'Interrupted',
  };
  return map[status] || status || 'Unknown';
}

function renderSelectedRun() {
  const run = runLogs.find((item) => item.id === selectedRunId) || runLogs[0];
  if (!run) {
    historyLogEl.textContent = 'No run logs yet';
    runLogTabsEl.innerHTML = '';
    return;
  }
  selectedRunId = run.id;

  runLogTabsEl.innerHTML = '';
  runLogs.forEach((item, index) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `run-log-tab${item.id === selectedRunId ? ' active' : ''}`;
    btn.textContent = `#${index + 1} ${statusLabel(item.status)}`;
    btn.title = formatRunTime(item.startedAt);
    btn.addEventListener('click', () => {
      selectedRunId = item.id;
      renderSelectedRun();
    });
    runLogTabsEl.appendChild(btn);
  });

  const header = [
    `Started: ${formatRunTime(run.startedAt)}`,
    `Ended: ${formatRunTime(run.endedAt)}`,
    `Status: ${statusLabel(run.status)}`,
    `Email: ${run.email || '—'}`,
    `Lookback pages: ${run.days ?? '—'}`,
  ].join('\n');

  const body = (run.lines || [])
    .map((line) => {
      const time = line.at ? new Date(line.at).toLocaleTimeString() : '';
      return `[${time}] ${line.text}`;
    })
    .join('\n');

  historyLogEl.textContent = `${header}\n\n${body || '(no log lines)'}`;
}

async function loadRunLogs() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_RUN_LOGS' });
    runLogs = response?.ok ? response.runLogs || [] : [];
    if (selectedRunId && !runLogs.some((item) => item.id === selectedRunId)) {
      selectedRunId = null;
    }
    renderSelectedRun();
  } catch (err) {
    historyLogEl.textContent = `Failed to load logs: ${err.message}`;
  }
}

function applySession(nextSession = {}) {
  session = { ...session, ...nextSession, checked: true };

  loginBanner.classList.remove('hidden', 'warn', 'ok');

  if (!session.loggedIn) {
    loginBanner.classList.add('warn');
    loginBannerText.textContent = session.checked
      ? 'Not logged in or logged out. Sign in, then click Check Login before collecting.'
      : 'Please click Check Login to confirm your eBay session.';
    loginText.textContent = session.checked ? 'Not logged in' : 'Not checked';
    openLoginBtn.style.display = '';
    updateActionButtons();
    return;
  }

  loginBanner.classList.add('ok');
  loginBannerText.textContent =
    'Logged in (cached). You will be asked to Check Login again if logout is detected during collection.';
  loginText.textContent = 'Logged in';
  openLoginBtn.style.display = 'none';
  updateActionButtons();
}

function updateActionButtons() {
  const canStart =
    session.loggedIn &&
    !!emailEl.value.trim() &&
    !!tokenEl.value.trim() &&
    !running;
  startBtn.disabled = !canStart;
  stopBtn.disabled = !running;
  saveBtn.disabled = running;
}

function renderState(state = {}) {
  running = !!state.running;
  statusText.textContent = running ? 'Running' : 'Idle';
  phaseText.textContent = state.phase || '—';
  progressText.textContent = state.progress || '—';
  if (state.session?.checked) applySession(state.session);
  updateActionButtons();
  if (state.lastLog) appendLog(state.lastLog);
}

async function loadSettings() {
  const [syncData, localData] = await Promise.all([
    chrome.storage.sync.get({ email: '', days: 3 }),
    chrome.storage.local.get({ token: '' }),
  ]);
  emailEl.value = syncData.email || '';
  daysEl.value = syncData.days;
  tokenEl.value = localData.token || '';
}

async function saveSettings() {
  const email = emailEl.value.trim();
  const token = tokenEl.value.trim();
  const days = Number(daysEl.value) || 3;
  if (!email) {
    appendLog('Please enter buyer email');
    return false;
  }
  if (!token) {
    appendLog('Please enter Everymarket Token');
    return false;
  }
  await Promise.all([
    chrome.storage.sync.set({ email, days }),
    chrome.storage.local.set({ token }),
  ]);
  appendLog(`Settings saved: ${email}`);
  updateActionButtons();
  return true;
}

async function refreshSession() {
  setBusy(true);
  loginBanner.classList.remove('hidden', 'warn', 'ok');
  loginBanner.classList.add('warn');
  loginBannerText.textContent = 'Opening Purchase page to check login…';
  loginText.textContent = 'Checking…';

  try {
    const response = await chrome.runtime.sendMessage({ type: 'CHECK_SESSION' });
    if (!response?.ok) {
      appendLog(`Check login failed: ${response?.error || 'unknown'}`);
      applySession({ loggedIn: false });
      return;
    }
    applySession(response.session || {});
    appendLog(response.session?.loggedIn ? 'Logged in' : 'Not logged in — please sign in');
  } catch (err) {
    appendLog(`Check login error: ${err.message}`);
    applySession({ loggedIn: false });
  } finally {
    setBusy(false);
    updateActionButtons();
  }
}

saveBtn.addEventListener('click', async () => {
  await saveSettings();
});

startBtn.addEventListener('click', async () => {
  const saved = await saveSettings();
  if (!saved) return;
  if (!session.loggedIn) {
    appendLog('Please Check Login first');
    return;
  }

  const email = emailEl.value.trim();
  const days = Number(daysEl.value) || 3;
  logEl.textContent = '';
  appendLog('Starting collector…');
  running = true;
  updateActionButtons();
  const response = await chrome.runtime.sendMessage({
    type: 'START',
    payload: { email, days },
  });
  if (response?.error) appendLog(`Error: ${response.error}`);
  await loadRunLogs();
});

stopBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'STOP' });
  appendLog('Stop requested');
});

refreshSessionBtn.addEventListener('click', async () => {
  await refreshSession();
});

openLoginBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'OPEN_LOGIN' });
  appendLog('Opened sign-in page. After signing in, click Check Login.');
});

refreshLogsBtn.addEventListener('click', async () => {
  await loadRunLogs();
});

clearLogsBtn.addEventListener('click', async () => {
  const response = await chrome.runtime.sendMessage({ type: 'CLEAR_RUN_LOGS' });
  if (response?.ok === false) {
    appendLog(`Clear logs failed: ${response.error || 'unknown'}`);
    return;
  }
  logEl.textContent = '';
  selectedRunId = null;
  runLogs = [];
  renderSelectedRun();
  appendLog('Run logs cleared');
});

emailEl.addEventListener('input', updateActionButtons);
tokenEl.addEventListener('input', updateActionButtons);
daysEl.addEventListener('input', updateActionButtons);

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'STATE') {
    renderState(message.payload);
    if (!message.payload?.running) {
      loadRunLogs();
    }
  }
  if (message?.type === 'SESSION') {
    applySession(message.payload || {});
    updateActionButtons();
  }
  if (message?.type === 'LOG') {
    appendLog(message.payload);
  }
  if (message?.type === 'RUN_LOGS_UPDATED') {
    loadRunLogs();
  }
});

(async () => {
  await loadSettings();
  const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  if (state) renderState(state);
  if (state?.session?.checked) {
    applySession(state.session);
  } else {
    loginText.textContent = 'Not checked';
  }
  updateActionButtons();
  await loadRunLogs();
})();
