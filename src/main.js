const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CREDENTIALS_PATH = path.join(
  process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
  '.credentials.json'
);

const FULL_SIZE = { width: 340, height: 420 };
const COMPACT_SIZE = { width: 250, height: 44 };

const settingsPath = path.join(app.getPath('userData'), 'overlay-settings.json');
const defaults = { x: null, y: null, compact: false, paused: false, intervalSec: 60, fullHeight: FULL_SIZE.height };
let settings = loadSettings();

let win = null;
let tray = null;
let timer = null;
let lastData = null;
let lastError = null;
let lastFetchAt = null;
let fetching = false;
let backoffUntil = 0;

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

function sendState() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('state', {
    data: lastData,
    error: lastError,
    lastFetchAt,
    fetching,
    paused: settings.paused,
    compact: settings.compact,
    intervalSec: settings.intervalSec,
  });
  updateTrayMenu();
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

function trayIcon() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="14" fill="#d97757"/><path d="M16 6v20M6 16h20M9 9l14 14M23 9L9 23" stroke="#fff" stroke-width="3" stroke-linecap="round"/></svg>`;
  return nativeImage.createFromDataURL('data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'));
}

function updateTrayMenu() {
  if (!tray) return;
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
      { label: 'Sair', click: () => app.quit() },
    ])
  );
  const s = lastData?.five_hour?.utilization;
  tray.setToolTip(`Claude Usage${s != null ? ` — sessão ${Math.round(s)}%` : ''}${settings.paused ? ' (pausado)' : ''}`);
}

ipcMain.on('refresh', () => fetchUsage({ force: true }));
ipcMain.on('set-paused', (_e, v) => setPaused(!!v));
ipcMain.on('set-compact', (_e, v) => setCompact(!!v));
ipcMain.on('set-interval', (_e, v) => setIntervalSec(Number(v) || 60));
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
    if (settings.paused) sendState();
    else fetchUsage({ force: true });
  });
  // Keep running in the tray even if the window is closed.
  app.on('window-all-closed', () => {});
}
