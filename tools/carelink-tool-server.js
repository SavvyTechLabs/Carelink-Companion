#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { URL } = require('url');
const { generateCareLinkToken } = require('./carelink-token-generator');

const HOST = '127.0.0.1';
const PORT = Number(process.env.CARELINK_TOOL_PORT || 8766);

function getDefaultDataDirectory() {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'CGMReader', 'CareLink Companion');
  }
  if (process.env.HOME) {
    return path.join(process.env.HOME, '.cgmreader-carelink');
  }
  return process.cwd();
}

const DATA_DIRECTORY = path.resolve(process.env.CARELINK_TOOL_DATA_DIR || getDefaultDataDirectory());
const OUTPUT_FILE = path.join(DATA_DIRECTORY, 'carelink-logindata.json');

const state = {
  running: false,
  region: 'EU',
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  logs: [],
  error: null,
  tokenFileExists: false,
  child: null,
  server: null
};

function openBrowser(url) {
  if (!url) return;

  let command;
  let args;

  if (process.platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', url];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }

  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (error) {
    pushLog(`Failed to open browser automatically: ${error.message}`);
  }
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function pushLog(line) {
  const message = `[${new Date().toISOString()}] ${line}`;
  state.logs.push(message);
  if (state.logs.length > 300) {
    state.logs = state.logs.slice(-300);
  }
}

async function refreshTokenFileStatus() {
  try {
    await fs.access(OUTPUT_FILE);
    state.tokenFileExists = true;
  } catch (error) {
    state.tokenFileExists = false;
  }
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data, null, 2);
  setCorsHeaders(res);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendHtml(res, html) {
  setCorsHeaders(res);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function currentStatus() {
  return {
    running: state.running,
    region: state.region,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    exitCode: state.exitCode,
    error: state.error,
    tokenFileExists: state.tokenFileExists,
    outputFile: OUTPUT_FILE,
    logs: state.logs
  };
}

async function startGenerator(region) {
  if (state.running) {
    throw new Error('Generator already running');
  }

  await refreshTokenFileStatus();

  state.running = true;
  state.region = region;
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.exitCode = null;
  state.error = null;
  state.logs = [];

  pushLog(`Starting CareLink generator for region ${region}`);

  Promise.resolve().then(async () => {
    await generateCareLinkToken({
      region,
      output: OUTPUT_FILE,
      headless: false,
      log: pushLog,
      errorLog: (line) => pushLog(`ERROR ${line}`)
    });
    state.running = false;
    state.finishedAt = new Date().toISOString();
    state.exitCode = 0;
    pushLog('Generator finished successfully');
    await refreshTokenFileStatus();
  }).catch(async (error) => {
    state.error = error.message || 'Generator failed';
    state.running = false;
    state.finishedAt = new Date().toISOString();
    state.exitCode = 1;
    pushLog(`ERROR ${error && error.stack ? error.stack : error}`);
    await refreshTokenFileStatus();
  });
}

function buildHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CareLink Companion</title>
  <style>
    :root {
      --bg: #f3efe6;
      --panel: #fffaf0;
      --line: #d9cdb8;
      --ink: #1f2a1f;
      --muted: #5f6b5f;
      --accent: #125b50;
      --accent-2: #b85c38;
    }
    body {
      margin: 0;
      font-family: Georgia, "Times New Roman", serif;
      background: radial-gradient(circle at top left, #fff8e8, var(--bg));
      color: var(--ink);
    }
    .wrap {
      max-width: 900px;
      margin: 0 auto;
      padding: 32px 20px 48px;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 18px;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.06);
      padding: 24px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 36px;
      line-height: 1.05;
    }
    p {
      color: var(--muted);
      font-size: 16px;
      line-height: 1.5;
    }
    .row {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      align-items: center;
      margin: 20px 0;
    }
    select, button, a.link {
      border-radius: 999px;
      border: 1px solid var(--line);
      padding: 12px 18px;
      font-size: 15px;
      background: white;
      color: var(--ink);
      text-decoration: none;
    }
    button.primary {
      background: var(--accent);
      color: white;
      border-color: var(--accent);
      cursor: pointer;
    }
    button.stop {
      background: var(--accent-2);
      color: white;
      border-color: var(--accent-2);
      cursor: pointer;
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .status {
      margin-top: 20px;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
    }
    .tile {
      background: rgba(255,255,255,0.8);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 14px;
    }
    .tile strong {
      display: block;
      font-size: 12px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 6px;
    }
    pre {
      margin: 20px 0 0;
      min-height: 260px;
      max-height: 420px;
      overflow: auto;
      padding: 16px;
      background: #1b1f1d;
      color: #d9f2e6;
      border-radius: 14px;
      font-size: 12px;
      line-height: 1.5;
      font-family: Consolas, "Courier New", monospace;
    }
    .hint {
      margin-top: 16px;
      padding: 14px;
      border-left: 4px solid var(--accent);
      background: rgba(18, 91, 80, 0.08);
      border-radius: 8px;
      color: var(--ink);
    }
    .notice {
      display: none;
      margin-top: 16px;
      padding: 14px;
      border-radius: 12px;
      font-size: 14px;
      line-height: 1.4;
    }
    .notice.visible {
      display: block;
    }
    .notice.error {
      background: #fff2ee;
      color: #9a2f12;
      border: 1px solid #f1c3b8;
    }
    .notice.info {
      background: #eef6ff;
      color: #0b5cab;
      border: 1px solid #bfd8ff;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>CareLink Companion</h1>
      <p>This local companion app runs CareLink login on the user's own computer and sends the result back to Homey pairing through localhost. When login is complete, Homey can import the token automatically.</p>
      <div class="row">
        <select id="region">
          <option value="EU">Europe</option>
          <option value="US">United States</option>
        </select>
        <button id="start" class="primary">Start Login</button>
        <button id="refresh">Refresh Status</button>
        <a class="link" href="/token" target="_blank" rel="noreferrer">Open Token File</a>
      </div>
      <div class="hint">A browser window will open for CareLink login. Complete the login and any CAPTCHA there. Keep this companion running while pairing the Medtronic device in Homey.</div>
      <div id="notice" class="notice"></div>
      <div class="status">
        <div class="tile"><strong>Running</strong><span id="running">No</span></div>
        <div class="tile"><strong>Region</strong><span id="current-region">EU</span></div>
        <div class="tile"><strong>Exit Code</strong><span id="exit-code">-</span></div>
        <div class="tile"><strong>Token File</strong><span id="token-file">Missing</span></div>
      </div>
      <pre id="logs">No output yet.</pre>
    </div>
  </div>
  <script>
    const startButton = document.getElementById('start');
    const refreshButton = document.getElementById('refresh');
    const regionSelect = document.getElementById('region');
    const runningEl = document.getElementById('running');
    const currentRegionEl = document.getElementById('current-region');
    const exitCodeEl = document.getElementById('exit-code');
    const tokenFileEl = document.getElementById('token-file');
    const logsEl = document.getElementById('logs');
    const noticeEl = document.getElementById('notice');

    function setNotice(message, type) {
      if (!message) {
        noticeEl.textContent = '';
        noticeEl.className = 'notice';
        return;
      }
      noticeEl.textContent = message;
      noticeEl.className = 'notice visible ' + (type || 'info');
    }

    async function refreshStatus() {
      const response = await fetch('/status');
      const data = await response.json();
      runningEl.textContent = data.running ? 'Yes' : 'No';
      currentRegionEl.textContent = data.region || '-';
      exitCodeEl.textContent = data.exitCode === null ? '-' : data.exitCode;
      tokenFileEl.textContent = data.tokenFileExists ? 'Ready' : 'Missing';
      logsEl.textContent = (data.logs && data.logs.length ? data.logs.join('\\n') : 'No output yet.');
      startButton.disabled = Boolean(data.running);
      return data;
    }

    async function startLogin() {
      startButton.disabled = true;
      const response = await fetch('/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ region: regionSelect.value })
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        setNotice(error.error || 'Failed to start generator', 'error');
      } else {
        setNotice('Login started. Complete the CareLink browser flow, then return here or to Homey.', 'info');
      }
      await refreshStatus();
    }

    startButton.addEventListener('click', startLogin);
    refreshButton.addEventListener('click', refreshStatus);
    setInterval(refreshStatus, 2000);
    refreshStatus();
  </script>
</body>
</html>`;
}

async function handleRequest(req, res) {
  const reqUrl = new URL(req.url, `http://${HOST}:${PORT}`);

  if (req.method === 'OPTIONS') {
    setCorsHeaders(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && reqUrl.pathname === '/') {
    sendHtml(res, buildHtml());
    return;
  }

  if (req.method === 'GET' && reqUrl.pathname === '/status') {
    await refreshTokenFileStatus();
    sendJson(res, 200, currentStatus());
    return;
  }

  if (req.method === 'GET' && reqUrl.pathname === '/favicon.ico') {
    setCorsHeaders(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && reqUrl.pathname === '/token') {
    try {
      const content = await fs.readFile(OUTPUT_FILE, 'utf8');
      setCorsHeaders(res);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(content);
    } catch (error) {
      sendJson(res, 404, { error: 'Token file not found yet' });
    }
    return;
  }

  if (req.method === 'POST' && reqUrl.pathname === '/start') {
    try {
      const body = await readRequestBody(req);
      const parsed = body ? JSON.parse(body) : {};
      const region = String(parsed.region || 'EU').toUpperCase();
      if (!['EU', 'US'].includes(region)) {
        throw new Error('Region must be EU or US');
      }
      await startGenerator(region);
      sendJson(res, 202, { ok: true });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Failed to start generator' });
    }
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}

async function startServer(options = {}) {
  await refreshTokenFileStatus();
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      sendJson(res, 500, { error: error.message || 'Internal server error' });
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, resolve);
  });

  state.server = server;
  const serverUrl = `http://${HOST}:${PORT}`;
  console.log(`CareLink tool server running at ${serverUrl}`);
  console.log(`CareLink token file location: ${OUTPUT_FILE}`);
  if (options.openBrowserOnStart) {
    openBrowser(serverUrl);
  }

  return server;
}

async function main() {
  await startServer({ openBrowserOnStart: process.argv.includes('--open-browser') });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}

module.exports = {
  startServer,
  OUTPUT_FILE,
  DATA_DIRECTORY,
  currentStatus
};