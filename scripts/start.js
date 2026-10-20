// VS Code's terminal sets ELECTRON_RUN_AS_NODE, which makes Electron boot as plain Node.
const { spawn } = require('child_process');
const path = require('path');
const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

spawn(electron, [path.join(__dirname, '..')], { env, stdio: 'inherit', windowsHide: false })
  .on('exit', (code) => process.exit(code ?? 0));
