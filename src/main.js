const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen, shell, dialog } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SESSIONS_DIR, writeSession, removeSession } = require('../scripts/overlay-hook');
const claudeHooks = require('../scripts/install-hooks');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CREDENTIALS_PATH = path.join(
  process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
  '.credentials.json'
);

const FULL_SIZE = { width: 340, height: 420 };
const COMPACT_SIZE = { width: 250, height: 44 };

const settingsPath = path.join(app.getPath('userData'), 'overlay-settings.json');
const defaults = {
  x: null, y: null, compact: false, paused: false, intervalSec: 60, fullHeight: FULL_SIZE.height,
  agentAlerts: true, agentSound: false,
};
let settings = loadSettings();

// Claude Code sessions reported by scripts/overlay-hook.js.
const ATTENTION = new Set(['question', 'permission', 'done']);
const ACTIVITY_GRACE_MS = 2000;
const WORKING_STALE_MS = 20 * 60 * 1000;
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

let win = null;
let tray = null;
let timer = null;
let lastData = null;
let lastError = null;
let lastFetchAt = null;
let fetching = false;
let backoffUntil = 0;
let agents = null;
let lastAgentsKey = '';
const dismissed = new Map();
let hooksInstalled = claudeHooks.isInstalled();
let trayAlert = false;

function loadSettings() {
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(settingsPath, 'utf8')) };
  } catch {
    return { ...defaults };
  }
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch {}
}

// Re-read the file on every fetch: Claude Code rotates the token and rewrites it.
function readToken() {
  const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
  const oauth = JSON.parse(raw).claudeAiOauth;
  if (!oauth || !oauth.accessToken) throw new Error('Login do Claude Code não encontrado.');
  return { token: oauth.accessToken, expiresAt: oauth.expiresAt, plan: oauth.subscriptionType };
}

async function fetchUsage({ force = false } = {}) {
  if (fetching) return;
  if (!force && Date.now() < backoffUntil) return;
  fetching = true;
  sendState();
  try {
    const { token, expiresAt, plan } = readToken();
    if (expiresAt && expiresAt < Date.now()) {
      throw new Error('Token expirado — abra o Claude Code para renovar o login.');
    }
    const res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 429) {
      const retry = Number(res.headers.get('retry-after')) || 120;
      backoffUntil = Date.now() + retry * 1000;
      throw new Error(`Limite de requisições — tentando de novo em ${retry}s.`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error('Não autorizado — abra o Claude Code e faça login novamente.');
    }
    if (!res.ok) throw new Error(`Erro HTTP ${res.status}`);
    lastData = { ...(await res.json()), plan };
    lastError = null;
    lastFetchAt = Date.now();
  } catch (err) {
    lastError = err.code === 'ENOENT' ? 'Arquivo de credenciais do Claude Code não encontrado.' : err.message;
  } finally {
    fetching = false;
    sendState();
    scheduleNext();
  }
}

// Fetch on the regular interval, but also right after the nearest reset so the
// overlay flips to the fresh window without waiting a full interval.
function scheduleNext() {
  clearTimeout(timer);
  if (settings.paused) return;
  let delay = settings.intervalSec * 1000;
  const resets = (lastData?.limits || [])
    .map((l) => Date.parse(l.resets_at))
    .filter((t) => t > Date.now());
  if (resets.length) delay = Math.min(delay, Math.min(...resets) - Date.now() + 5000);
  if (backoffUntil > Date.now()) delay = Math.max(delay, backoffUntil - Date.now());
  timer = setTimeout(() => fetchUsage(), Math.max(delay, 5000));
}

function loadAgents() {
  let files = [];
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  } catch {}
  const next = new Map();
  for (const f of files) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
      if (Date.now() - s.ts > SESSION_MAX_AGE_MS) removeSession(s.sessionId);
      else next.set(s.sessionId, { ...s, activityAt: agents?.get(s.sessionId)?.activityAt });
    } catch {}
  }
  // Sessions already waiting when the overlay starts don't trigger an alert.
  const fresh = agents !== null && [...next.values()].some(
    (s) => ATTENTION.has(s.state) && agents.get(s.sessionId)?.ts !== s.ts
  );
  agents = next;
  if (fresh && settings.agentAlerts) {
    if (win && !win.isDestroyed()) win.webContents.send('agent-alert');
    if (settings.agentSound) shell.beep();
  }
  // Polling runs every few seconds; only re-render when the list changed.
  const key = JSON.stringify(visibleAgents());
  if (key !== lastAgentsKey) {
    lastAgentsKey = key;
    sendState();
  }
}

// Answering a question or a permission prompt writes to the transcript, which
// fires no hook of its own: treat that as Claude being back to work.
function checkAgentActivity() {
  if (!agents) return;
  for (const s of agents.values()) {
    if (!s.transcript) continue;
    try {
      s.activityAt = fs.statSync(s.transcript).mtimeMs;
    } catch {
      continue;
    }
    if (s.source === 'tool' && s.activityAt > s.ts + ACTIVITY_GRACE_MS) {
      writeSession({ ...s, activityAt: undefined, state: 'working', source: '', message: '', ts: Date.now() });
    }
  }
}

function watchAgents() {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  let debounce = null;
  try {
    fs.watch(SESSIONS_DIR, () => {
      clearTimeout(debounce);
      debounce = setTimeout(loadAgents, 100);
    });
  } catch {}
  // Polling backs up fs.watch and keeps "há X min" and stale sessions current.
  setInterval(() => {
    checkAgentActivity();
    loadAgents();
  }, 3000);
  loadAgents();
}

function visibleAgents() {
  if (!settings.agentAlerts || !agents) return [];
  const now = Date.now();
  const rank = { question: 0, permission: 0, done: 1, working: 2 };
  return [...agents.values()]
    .filter((s) =>
      s.state === 'working'
        ? now - Math.max(s.ts, s.activityAt || 0) < WORKING_STALE_MS
        : ATTENTION.has(s.state) && !(dismissed.get(s.sessionId) >= s.ts)
    )
    .map((s) => ({
      id: s.sessionId,
      state: s.state,
      ts: s.ts,
      project: s.cwd ? path.basename(s.cwd) : 'Claude Code',
      cwd: s.cwd || '',
      message: s.message || '',
    }))
    .sort((a, b) => rank[a.state] - rank[b.state] || b.ts - a.ts);
}

function sendState() {
  if (!win || win.isDestroyed()) return;
  const agentList = visibleAgents();
  win.webContents.send('state', {
    data: lastData,
    error: lastError,
    lastFetchAt,
    fetching,
    paused: settings.paused,
    compact: settings.compact,
    intervalSec: settings.intervalSec,
    agents: agentList,
  });
  updateTrayMenu(agentList.filter((a) => a.state !== 'working').length);
}

function applyCompact() {
  const size = settings.compact ? COMPACT_SIZE : { width: FULL_SIZE.width, height: settings.fullHeight };
  win.setMinimumSize(1, 1);
  win.setSize(size.width, size.height);
  keepOnScreen();
}

function keepOnScreen() {
  const b = win.getBounds();
  const area = screen.getDisplayMatching(b).workArea;
  const x = Math.min(Math.max(b.x, area.x), area.x + area.width - b.width);
  const y = Math.min(Math.max(b.y, area.y), area.y + area.height - b.height);
  if (x !== b.x || y !== b.y) win.setPosition(x, y);
}

function createWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  const size = settings.compact ? COMPACT_SIZE : { width: FULL_SIZE.width, height: settings.fullHeight };
  win = new BrowserWindow({
    ...size,
    x: settings.x ?? area.x + area.width - size.width - 20,
    y: settings.y ?? area.y + 20,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // 'screen-saver' keeps it above most fullscreen/borderless apps too.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true);
  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', keepOnScreen);

  win.on('moved', () => {
    const [x, y] = win.getPosition();
    settings.x = x;
    settings.y = y;
    saveSettings();
  });
  win.webContents.on('did-finish-load', sendState);
}

function toggleVisible() {
  if (win.isVisible()) win.hide();
  else {
    win.show();
    win.setAlwaysOnTop(true, 'screen-saver');
  }
  updateTrayMenu();
}

function setPaused(paused) {
  settings.paused = paused;
  saveSettings();
  if (paused) clearTimeout(timer);
  else fetchUsage({ force: true });
  sendState();
}

function setCompact(compact) {
  settings.compact = compact;
  saveSettings();
  applyCompact();
  sendState();
}

function setIntervalSec(sec) {
  settings.intervalSec = sec;
  saveSettings();
  scheduleNext();
  sendState();
}

function setAgentSetting(key, value) {
  settings[key] = value;
  saveSettings();
  sendState();
}

function dismissAgent(id) {
  const s = agents?.get(id);
  if (s) dismissed.set(id, s.ts);
  sendState();
}

function setHooksInstalled(install) {
  try {
    if (install) claudeHooks.install();
    else claudeHooks.uninstall();
    hooksInstalled = claudeHooks.isInstalled();
    if (install) {
      dialog.showMessageBox({
        type: 'info',
        title: 'Claude Usage',
        message: 'Hooks instalados no Claude Code.',
        detail: `Arquivo: ${claudeHooks.SETTINGS_PATH}\n\nSessões já abertas precisam ser reiniciadas para enviar avisos ao overlay.`,
      });
    }
  } catch (err) {
    dialog.showErrorBox('Claude Usage', err.message);
  }
  updateTrayMenu();
}

// The dot marks Claude Code sessions waiting for the user.
function trayIcon(alert = false) {
  const dot = alert ? `<circle cx="25" cy="7" r="6" fill="#6fb98a" stroke="#181715" stroke-width="2"/>` : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="14" fill="#d97757"/><path d="M16 6v20M6 16h20M9 9l14 14M23 9L9 23" stroke="#fff" stroke-width="3" stroke-linecap="round"/>${dot}</svg>`;
  return nativeImage.createFromDataURL('data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'));
}

function updateTrayMenu(waiting = visibleAgents().filter((a) => a.state !== 'working').length) {
  if (!tray) return;
  if (trayAlert !== waiting > 0) {
    trayAlert = waiting > 0;
    tray.setImage(trayIcon(trayAlert));
  }
  const intervals = [30, 60, 120, 300, 600];
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: win?.isVisible() ? 'Ocultar overlay' : 'Mostrar overlay', click: toggleVisible },
      { label: settings.compact ? 'Expandir' : 'Minimizar', click: () => setCompact(!settings.compact) },
      { type: 'separator' },
      { label: 'Atualizar agora', click: () => fetchUsage({ force: true }) },
      { label: 'Pausar atualização', type: 'checkbox', checked: settings.paused, click: (i) => setPaused(i.checked) },
      {
        label: 'Intervalo de atualização',
        submenu: intervals.map((s) => ({
          label: s < 60 ? `${s} segundos` : `${s / 60} minuto${s > 60 ? 's' : ''}`,
          type: 'radio',
          checked: settings.intervalSec === s,
          click: () => setIntervalSec(s),
        })),
      },
      {
        label: 'Iniciar com o Windows',
        type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        click: (i) => app.setLoginItemSettings({ openAtLogin: i.checked, args: [app.getAppPath()] }),
      },
      { type: 'separator' },
      {
        label: 'Avisos do Claude Code',
        type: 'checkbox',
        checked: settings.agentAlerts,
        click: (i) => setAgentSetting('agentAlerts', i.checked),
      },
      {
        label: 'Som nos avisos',
        type: 'checkbox',
        checked: settings.agentSound,
        enabled: settings.agentAlerts,
        click: (i) => setAgentSetting('agentSound', i.checked),
      },
      {
        label: 'Hooks instalados no Claude Code',
        type: 'checkbox',
        checked: hooksInstalled,
        click: (i) => setHooksInstalled(i.checked),
      },
      { type: 'separator' },
      { label: 'Sair', click: () => app.quit() },
    ])
  );
  const s = lastData?.five_hour?.utilization;
  tray.setToolTip(
    `Claude Usage${s != null ? ` — sessão ${Math.round(s)}%` : ''}${settings.paused ? ' (pausado)' : ''}` +
      (waiting ? `\n${waiting} sessão${waiting > 1 ? 'ões' : ''} aguardando você` : '')
  );
}

ipcMain.on('refresh', () => fetchUsage({ force: true }));
ipcMain.on('set-paused', (_e, v) => setPaused(!!v));
ipcMain.on('set-compact', (_e, v) => setCompact(!!v));
ipcMain.on('set-interval', (_e, v) => setIntervalSec(Number(v) || 60));
ipcMain.on('dismiss-agent', (_e, id) => dismissAgent(String(id)));
ipcMain.on('hide', () => toggleVisible());
ipcMain.on('quit', () => app.quit());
ipcMain.on('content-height', (_e, h) => {
  const height = Math.max(120, Math.min(Math.ceil(h), 900));
  if (settings.compact || height === settings.fullHeight) return;
  settings.fullHeight = height;
  saveSettings();
  win.setSize(FULL_SIZE.width, height);
  keepOnScreen();
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isVisible()) toggleVisible();
  });
  app.whenReady().then(() => {
    createWindow();
    tray = new Tray(trayIcon());
    tray.on('click', toggleVisible);
    updateTrayMenu();
    watchAgents();
    if (settings.paused) sendState();
    else fetchUsage({ force: true });
  });
  // Keep running in the tray even if the window is closed.
  app.on('window-all-closed', () => {});
}
