#!/usr/bin/env node

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');

const VERSIONS_DIR = path.join(__dirname, 'versions');
const ENTRY_CANDIDATES = ['server.js', 'index.js', 'app.js'];

let currentChild = null;
let currentVersion = null;
let switching = false;
let allocatedPort = null;
let consolePassword = null;

function resolveAllocatedPort() {
  return process.env.SERVER_PORT || process.env.PORT || '3000';
}

function setupEnv() {
  allocatedPort = resolveAllocatedPort();
  consolePassword = process.env.CONSOLE_PASSWORD;
  if (!consolePassword) {
    consolePassword = crypto.randomBytes(9).toString('base64url');
  }
}

function ensureClaudeCode() {
  const check = spawnSync('claude', ['--version'], { stdio: 'pipe' });
  if (check.status !== 0) {
    spawnSync('npm', ['install', '-g', '@anthropic-ai/claude-code'], {
      stdio: 'inherit',
    });
  }
}

const TERMINAL_PAGE = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>Claude Console</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5/css/xterm.css" />
<style>
  html, body { margin: 0; height: 100%; background: #111; }
  #login { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; font-family: monospace; color: #eee; gap: 12px; }
  #login input { padding: 8px 10px; font-size: 14px; width: 260px; }
  #login button { padding: 8px 14px; font-size: 14px; cursor: pointer; }
  #term { display: none; height: 100%; padding: 4px; box-sizing: border-box; }
  #error { color: #f66; min-height: 1.2em; }
</style>
</head>
<body>
  <div id="login">
    <div>Claude Console</div>
    <input id="pw" type="password" placeholder="Password" autofocus />
    <button id="go">Connect</button>
    <div id="error"></div>
  </div>
  <div id="term"></div>

  <script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5/lib/xterm.js"></script>
  <script>
    const loginEl = document.getElementById('login');
    const termEl = document.getElementById('term');
    const errEl = document.getElementById('error');
    const pwEl = document.getElementById('pw');

    function connect(password) {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(proto + '://' + location.host + '/ws');
      let authed = false;

      ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', password }));

      ws.onmessage = (ev) => {
        if (!authed) {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'auth_ok') {
            authed = true;
            loginEl.style.display = 'none';
            termEl.style.display = 'block';
            const term = new Terminal({ convertEol: true, fontSize: 14 });
            term.open(termEl);
            term.onData((d) => ws.send(JSON.stringify({ type: 'input', data: d })));
            ws._term = term;
          } else if (msg.type === 'auth_fail') {
            errEl.textContent = 'Wrong password';
            ws.close();
          }
          return;
        }
        const msg = JSON.parse(ev.data);
        if (msg.type === 'output' && ws._term) ws._term.write(msg.data);
      };

      ws.onclose = () => {
        if (authed && ws._term) ws._term.write('\\r\\n[connection closed]\\r\\n');
      };
      ws.onerror = () => { errEl.textContent = 'Connection error'; };
    }

    document.getElementById('go').onclick = () => connect(pwEl.value);
    pwEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(pwEl.value); });
  </script>
</body>
</html>`;

function startConsoleServer(port) {
  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(TERMINAL_PAGE);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  const wss = new WebSocket.Server({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    let authed = false;
    let shell = null;

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return; }

      if (!authed) {
        if (msg.type === 'auth' && msg.password === consolePassword) {
          authed = true;
          ws.send(JSON.stringify({ type: 'auth_ok' }));

          shell = spawn('script', ['-qc', 'claude', '/dev/null'], {
            cwd: __dirname,
            env: process.env,
          });

          shell.stdout.on('data', (d) => {
            try { ws.send(JSON.stringify({ type: 'output', data: d.toString('utf8') })); } catch (_) {}
          });
          shell.stderr.on('data', (d) => {
            try { ws.send(JSON.stringify({ type: 'output', data: d.toString('utf8') })); } catch (_) {}
          });
          shell.on('exit', () => {
            try { ws.close(); } catch (_) {}
          });
        } else {
          ws.send(JSON.stringify({ type: 'auth_fail' }));
          ws.close();
        }
        return;
      }

      if (msg.type === 'input' && shell && shell.stdin.writable) {
        shell.stdin.write(msg.data);
      }
    });

    ws.on('close', () => {
      if (shell && !shell.killed) {
        try { shell.kill('SIGTERM'); } catch (_) {}
      }
    });
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`Server successfully started on 0.0.0.0:${port}`);
  });
}

function listVersionDirs() {
  if (!fs.existsSync(VERSIONS_DIR)) fs.mkdirSync(VERSIONS_DIR, { recursive: true });
  return fs
    .readdirSync(VERSIONS_DIR)
    .filter((d) => /^v\d+\.\d+\.\d+$/.test(d))
    .filter((d) => fs.statSync(path.join(VERSIONS_DIR, d)).isDirectory());
}

function isComplete(versionDir) {
  return fs.existsSync(path.join(VERSIONS_DIR, versionDir, 'update.txt'));
}

function semverParts(v) {
  return v.replace(/^v/, '').split('.').map(Number);
}

function compareVersions(a, b) {
  const pa = semverParts(a);
  const pb = semverParts(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function latestCompleteVersion() {
  const complete = listVersionDirs().filter(isComplete);
  if (complete.length === 0) return null;
  complete.sort(compareVersions);
  return complete[complete.length - 1];
}

function findEntryFile(versionDir) {
  const dir = path.join(VERSIONS_DIR, versionDir);
  const pkgPath = path.join(dir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.main && fs.existsSync(path.join(dir, pkg.main))) return pkg.main;
    } catch (_) {}
  }
  for (const candidate of ENTRY_CANDIDATES) {
    if (fs.existsSync(path.join(dir, candidate))) return candidate;
  }
  throw new Error(`No entry file found in versions/${versionDir}`);
}

function stopCurrent() {
  return new Promise((resolve) => {
    if (!currentChild) return resolve();
    const child = currentChild;
    currentChild = null;
    const killTimeout = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
    }, 5000);
    child.once('exit', () => {
      clearTimeout(killTimeout);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

async function startVersion(versionDir) {
  const entry = findEntryFile(versionDir);
  const cwd = path.join(VERSIONS_DIR, versionDir);

  const childEnv = { ...process.env, SITE_VERSION: versionDir };
  delete childEnv.PORT;
  delete childEnv.SERVER_PORT;

  const child = spawn('node', [entry], { cwd, stdio: 'inherit', env: childEnv });

  currentChild = child;
  currentVersion = versionDir;
}

async function switchToLatest() {
  if (switching) return;
  switching = true;
  try {
    const latest = latestCompleteVersion();
    if (!latest) {
      return;
    }
    if (latest === currentVersion) return;

    await stopCurrent();
    await startVersion(latest);
  } catch (err) {
  } finally {
    switching = false;
  }
}

function watchVersions() {
  fs.watch(VERSIONS_DIR, { recursive: true }, (eventType, filename) => {
    if (!filename) return;
    if (filename.endsWith('update.txt')) {
      setTimeout(switchToLatest, 250);
    }
  });
}

function ensureBaseline() {
  const dirs = listVersionDirs();
  if (dirs.length > 0) return;

  const baseDir = path.join(VERSIONS_DIR, 'v0.0.1');
  fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(
    path.join(baseDir, 'index.js'),
    `console.log('v0.0.1 baseline running (no network port assigned)');\n` +
      `setInterval(() => {}, 1 << 30);\n`
  );
  fs.writeFileSync(
    path.join(baseDir, 'update.txt'),
    'v0.0.1 — initial baseline version created by orchestrator.\n'
  );
}

async function main() {
  setupEnv();
  ensureClaudeCode();
  ensureBaseline();
  watchVersions();
  await switchToLatest();
  startConsoleServer(allocatedPort);
}

process.on('SIGINT', async () => { await stopCurrent(); process.exit(0); });
process.on('SIGTERM', async () => { await stopCurrent(); process.exit(0); });

main();
