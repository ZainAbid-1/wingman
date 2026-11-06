'use strict';

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.WINGMAN_PORT) || 4545;
const HOST = '127.0.0.1';
const VERSION = require('../package.json').version;
const URL = `http://localhost:${PORT}`;

function request(method, urlPath, body, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        method,
        path: urlPath,
        headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve(text ? JSON.parse(text) : {});
          } catch (e) {
            reject(new Error(`Bad response from the Wingman hub: ${text.slice(0, 200)}`));
          }
        });
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function hubVersion() {
  try {
    const r = await request('GET', '/api/ping', undefined, 800);
    return r && r.ok === true ? r.version || '0.0.0' : null;
  } catch {
    return null;
  }
}
async function ping() {
  return (await hubVersion()) !== null;
}
function older(a, b) {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  return false;
}

// Start the hub as a detached background process if it isn't running yet.
// A hub from an older Wingman is asked to exit so this version takes over.
async function ensureHub() {
  const running = await hubVersion();
  if (running && !older(running, VERSION)) return true;
  if (running) {
    await request('POST', '/api/shutdown', {}, 1000).catch(() => {});
    for (let i = 0; i < 20 && (await ping()); i++) await new Promise((r) => setTimeout(r, 100));
  }
  const cli = path.join(__dirname, '..', 'bin', 'cli.js');
  const child = spawn(process.execPath, [cli, 'hub'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
  });
  child.unref();
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await ping()) return true;
  }
  return false;
}

function openBrowser(url = URL) {
  if (process.env.WINGMAN_NO_OPEN) return;
  let cmd, args;
  if (process.platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '""', url];
  } else if (process.platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    /* no browser available; the user can run "wingman open" */
  }
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(''));
  });
}

module.exports = { PORT, HOST, VERSION, URL, request, ping, ensureHub, openBrowser, readStdin };
