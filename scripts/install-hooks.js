// Adds (or removes, with --uninstall) the overlay hooks in the user's Claude Code
// settings.json, keeping every other setting and hook untouched.
const fs = require('fs');
const os = require('os');
const path = require('path');

const SETTINGS_PATH = path.join(
  process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
  'settings.json'
);
const HOOK_SCRIPT = path.join(__dirname, 'overlay-hook.js');
const MARKER = 'overlay-hook.js';

// [event, matcher]
const EVENTS = [
  ['UserPromptSubmit'],
  ['Stop'],
  ['Notification'],
  ['SessionEnd'],
  ['PreToolUse', 'AskUserQuestion'],
  ['PostToolUse', 'AskUserQuestion'],
];

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`Não foi possível ler ${SETTINGS_PATH}: ${err.message}`);
  }
}

function writeSettings(settings) {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  if (fs.existsSync(SETTINGS_PATH)) fs.copyFileSync(SETTINGS_PATH, SETTINGS_PATH + '.overlay-backup');
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
}

const isOurs = (h) => typeof h?.command === 'string' && h.command.includes(MARKER);

function stripOurs(settings) {
  const hooks = settings.hooks || {};
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    hooks[event] = hooks[event]
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length);
    if (!hooks[event].length) delete hooks[event];
  }
  if (Object.keys(hooks).length) settings.hooks = hooks;
  else delete settings.hooks;
}

function isInstalled() {
  try {
    return Object.values(readSettings().hooks || {}).some(
      (groups) => Array.isArray(groups) && groups.some((g) => (g.hooks || []).some(isOurs))
    );
  } catch {
    return false;
  }
}

function install() {
  const settings = readSettings();
  stripOurs(settings);
  settings.hooks ||= {};
  const command = `node "${HOOK_SCRIPT.replace(/\\/g, '/')}"`;
  for (const [event, matcher] of EVENTS) {
    (settings.hooks[event] ||= []).push({
      ...(matcher ? { matcher } : {}),
      hooks: [{ type: 'command', command, timeout: 5 }],
    });
  }
  writeSettings(settings);
}

function uninstall() {
  const settings = readSettings();
  stripOurs(settings);
  writeSettings(settings);
}

if (require.main === module) {
  try {
    if (process.argv.includes('--uninstall')) {
      uninstall();
      console.log(`Hooks do overlay removidos de ${SETTINGS_PATH}`);
    } else {
      install();
      console.log(`Hooks do overlay instalados em ${SETTINGS_PATH}`);
      console.log('Reinicie as sessões do Claude Code já abertas para ativar os avisos.');
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { SETTINGS_PATH, isInstalled, install, uninstall };
