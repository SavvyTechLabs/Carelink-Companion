#!/usr/bin/env node
'use strict';

const http = require('http');
const { spawn } = require('child_process');
const { startServer } = require('./carelink-tool-server');

const HOST = '127.0.0.1';
const PORT = Number(process.env.CARELINK_TOOL_PORT || 8766);
const SERVER_URL = `http://${HOST}:${PORT}`;

function openBrowser(url) {
  if (process.platform === 'win32') {
    const child = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' });
    child.unref();
    return;
  }

  const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(command, [url], { detached: true, stdio: 'ignore' });
  child.unref();
}

function checkExistingServer() {
  return new Promise((resolve) => {
    const request = http.get(`${SERVER_URL}/status`, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on('error', () => resolve(false));
    request.setTimeout(1500, () => {
      request.destroy();
      resolve(false);
    });
  });
}

async function main() {
  const isRunning = await checkExistingServer();
  if (isRunning) {
    console.log(`CareLink Companion is already running at ${SERVER_URL}`);
    openBrowser(SERVER_URL);
    return;
  }

  await startServer({ openBrowserOnStart: true });
  console.log('CareLink Companion is ready. Keep this window open while Homey pairing is in progress.');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});