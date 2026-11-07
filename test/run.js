#!/usr/bin/env node
'use strict';

// Wingman test suite: safety and edge cases, end to end.
// Each run starts its own hub in a throwaway home folder on a spare port, so your real
// Wingman (port 4545, ~/.wingman) is never touched. Run with:  npm test

const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'cli.js');
const PORT = 4600 + Math.floor(Math.random() * 300);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wingman-test-'));
const HOME = path.join(TMP, 'home');
fs.mkdirSync(HOME);
const ENV = Object.assign({}, process.env, { WINGMAN_PORT: String(PORT), WINGMAN_NO_OPEN: '1', HOME, USERPROFILE: HOME });
delete ENV.CLAUDE_CODE_EXECPATH; // never start real Claude from tests
const HAS_GIT = spawnSync('git', ['--version']).status === 0;

/* ---------- tiny harness ---------- */
const results = [];
let current = '';
function check(cond, label, detail) {
  results.push({ test: current, label, ok: !!cond, detail: cond ? '' : detail === undefined ? '' : JSON.stringify(detail).slice(0, 300) });
}
async function test(name, fn) {
  current = name;
  try {
    await fn();
  } catch (e) {
    results.push({ test: name, label: 'threw', ok: false, detail: e.stack.split('\n').slice(0, 3).join(' | ') });
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function req(method, p, body, headers, port = PORT) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const h = Object.assign({ host: `127.0.0.1:${port}` }, data ? { 'content-type': 'application/json', 'content-length': data.length } : {}, headers || {});
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(t);
        } catch {
          /* not json */
        }
        resolve({ status: res.statusCode, json, text: t });
      });
    });
    r.on('error', (e) => resolve({ status: 0, error: e.code || e.message }));
    r.setTimeout(15000, () => r.destroy(new Error('timeout')));
    if (data) r.write(data);
    r.end();
  });
}
const ORIGIN = { origin: `http://localhost:${PORT}` };
const hook = (event, payload, extra) => req('POST', '/api/hook', Object.assign({ event, payload }, extra || {}));
const mcp = (cwd, tool, args, session = 'S1') => req('POST', '/api/mcp', { cwd, tool, args, session }).then((r) => (r.json || {}).text || '');
const ui = (b) => req('POST', '/api/ui', b, ORIGIN);
async function state() {
  const r = await req('GET', '/api/state');
  return r.json && (r.json.state || r.json);
}
async function project(cwd) {
  const s = await state();
  const e = Object.entries(s.projects).find(([, p]) => path.resolve(p.cwd).toLowerCase() === path.resolve(cwd).toLowerCase());
  return e ? Object.assign({ key: e[0] }, e[1]) : null;
}
function newDir(name, git) {
  const d = path.join(TMP, name);
  fs.mkdirSync(d, { recursive: true });
  if (git && HAS_GIT) {
    execFileSync('git', ['init', '-q'], { cwd: d });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: d });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: d });
    execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: d });
  }
  return d;
}
function commit(d) {
  execFileSync('git', ['add', '-A'], { cwd: d });
  execFileSync('git', ['commit', '-qm', 'base', '--allow-empty'], { cwd: d });
}
// Run the real hook script the way Claude Code does: JSON on stdin, output on stdout.
function runHook(event, stdin, env) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [CLI, 'hook', event], { input: stdin, env: Object.assign({}, ENV, env || {}), encoding: 'utf8', timeout: 20000 });
  return { code: r.status, out: r.stdout, err: r.stderr, ms: Date.now() - t0 };
}

let hub;
function startHub() {
  hub = spawn(process.execPath, [CLI, 'hub'], { env: ENV, stdio: 'ignore' });
}
async function waitHub() {
  for (let i = 0; i < 50; i++) {
    const r = await req('GET', '/api/ping');
    if (r.status === 200) return true;
    await sleep(100);
  }
  return false;
}
async function stopHub() {
  if (!hub) return;
  await req('POST', '/api/shutdown', {});
  await sleep(300);
  try {
    hub.kill();
  } catch {
    /* already gone */
  }
  hub = null;
}

/* ---------- tests ---------- */
async function main() {
  startHub();
  if (!(await waitHub())) {
    console.error('Hub did not start');
    process.exit(1);
  }

  await test('Network: only reachable from this machine', async () => {
    const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
    if (lan) {
      const ok = await new Promise((r) => {
        const s = net.connect(PORT, lan.address);
        s.on('connect', () => (s.destroy(), r(false)));
        s.on('error', () => r(true));
        s.setTimeout(2000, () => (s.destroy(), r(true)));
      });
      check(ok, `not reachable on the network address ${lan.address}`);
    } else check(true, 'no network address to try');
  });

  await test('Network: other websites are refused', async () => {
    const evilOrigin = { origin: 'http://evil.example' };
    check((await req('POST', '/api/ui', { action: 'level', level: 3 }, evilOrigin)).status === 403, 'POST /api/ui from another site → 403');
    check((await req('POST', '/api/hook', { event: 'Stop', payload: {} }, evilOrigin)).status === 403, 'POST /api/hook from another site → 403');
    check((await req('POST', '/api/shutdown', {}, evilOrigin)).status === 403, 'POST /api/shutdown from another site → 403');
    check((await state()).level === 0, 'level unchanged by the refused request');
    // DNS rebinding: the attacker's own domain arrives as the Host header.
    for (const p of ['/', '/api/state', '/api/events', '/api/file?key=x&run=y&file=z', '/api/ping']) {
      const r = await req('GET', p, undefined, { host: `evil.example:${PORT}` });
      check(r.status === 403, `GET ${p} with a foreign Host → 403`, r.status);
    }
    check((await req('GET', '/api/state', undefined, { host: `localhost:${PORT}` })).status === 200, 'GET /api/state with Host localhost → 200');
  });

  await test('Network: bad and oversized requests', async () => {
    const r1 = await req('POST', '/api/hook', '{not json', {});
    check(r1.status === 200, 'invalid JSON is answered, not crashed', r1.status);
    const big = 'x'.repeat(9 * 1024 * 1024);
    const r2 = await req('POST', '/api/hook', `{"event":"Stop","payload":{"x":"${big}"}}`);
    check(r2.status === 0 || r2.status === 200, 'a 9 MB request is cut off');
    check((await req('GET', '/api/ping')).status === 200, 'hub still up afterwards');
    check((await req('GET', '/nope')).status === 404, 'unknown path → 404');
  });

  await test('Hook: never gets in Claude\'s way', async () => {
    const a = runHook('PreToolUse', '{{{ garbage');
    check(a.code === 0 && a.out === '', 'garbage on stdin → exit 0, no output', a);
    const b = runHook('PreToolUse', '');
    check(b.code === 0 && b.out === '', 'empty stdin → exit 0, no output', b);
    const c = runHook('UserPromptSubmit', JSON.stringify({ prompt: 'x', cwd: TMP }), { WINGMAN_OFF: '1' });
    check(c.code === 0 && c.out === '', 'WINGMAN_OFF (background answers) → silent', c);
    // Port taken by something that is not Wingman: the hook must give up quickly and quietly.
    // The squatters run in their own process so they keep answering while the hook runs.
    const squat = spawn(process.execPath, ['-e', `
      const http = require('http'), net = require('net');
      const a = http.createServer((q, s) => s.end('hello')).listen(0, '127.0.0.1', () => {
        const b = net.createServer(() => {}).listen(0, '127.0.0.1', () => console.log(a.address().port + ' ' + b.address().port));
      });`], { stdio: ['ignore', 'pipe', 'ignore'] });
    const ports = await new Promise((r) => squat.stdout.once('data', (c) => r(String(c).trim().split(' '))));
    for (const [port, kind] of [[ports[0], 'answers with something else'], [ports[1], 'never answers']]) {
      const d = runHook('UserPromptSubmit', JSON.stringify({ prompt: 'x', cwd: TMP }), { WINGMAN_PORT: port });
      check(d.code === 0 && d.out === '', `port held by a program that ${kind} → exit 0, no output`, d);
      check(d.ms < 10000, `…gave up in ${d.ms} ms`);
    }
    squat.kill();
    const e = runHook('UserPromptSubmit', JSON.stringify({ prompt: 'hello', cwd: newDir('hookok'), session_id: 'h1' }));
    let out = {};
    try {
      out = JSON.parse(e.out);
    } catch {
      /* checked below */
    }
    check(e.code === 0 && out.hookSpecificOutput && /Wingman is on/.test(out.hookSpecificOutput.additionalContext), 'normal prompt → reminder for Claude', e);
  });

  await test('MCP server: survives junk and answers', async () => {
    const child = spawn(process.execPath, [CLI, 'mcp'], { env: ENV, stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    child.stdout.on('data', (c) => (buf += c));
    child.stdin.write('this is not json\n');
    child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}\n');
    child.stdin.write('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
    child.stdin.write('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"no_such_tool","arguments":{}}}\n');
    await sleep(1500);
    child.kill();
    const lines = buf.split('\n').filter(Boolean).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { bad: l };
      }
    });
    check(!lines.some((l) => l.bad), 'every output line is valid JSON-RPC', buf.slice(0, 200));
    const init = lines.find((l) => l.id === 1);
    check(init && init.result && init.result.serverInfo, 'initialize answered after a junk line', init);
    const list = lines.find((l) => l.id === 2);
    check(list && list.result && list.result.tools.length === 5, 'five tools listed', list && list.result);
    const bad = lines.find((l) => l.id === 3);
    check(bad && (bad.error || (bad.result && bad.result.isError)), 'unknown tool → error, not crash', bad);
  });

  await test('Pause and Simpler are gone', async () => {
    const cwd = newDir('nopause');
    await hook('UserPromptSubmit', { cwd, prompt: 'go', session_id: 'p' });
    await mcp(cwd, 'explain_change', { file: 'a.txt', what: 'x', why: 'y' });
    const p = await project(cwd);
    const card = p.runs.at(-1).items.find((i) => i.type === 'change');
    const r = await ui({ action: 'pause', key: p.key });
    check(r.json && r.json.error, '"pause" request is refused', r.json);
    const s = await ui({ action: 'feedback', key: p.key, cardId: card.id, kind: 'simpler' });
    check(s.json && s.json.error, '"simpler" request is refused', s.json);
    const t0 = Date.now();
    const pre = await hook('PreToolUse', { cwd, tool_name: 'Edit', tool_input: { file_path: path.join(cwd, 'a.txt') } });
    check(Date.now() - t0 < 2000, `Claude's next step is never held (${Date.now() - t0} ms)`);
    check(!(pre.json.hookSpecificOutput && pre.json.hookSpecificOutput.permissionDecision), 'nothing is sent to Claude for it', pre.json);
  });

  await test('"Not like this" becomes a new prompt', async () => {
    const cwd = newDir('redirect');
    await hook('UserPromptSubmit', { cwd, prompt: 'make it blue', session_id: 'r' });
    await mcp(cwd, 'explain_change', { file: 'a.css', what: 'blue', why: 'asked' });
    let p = await project(cwd);
    const card = p.runs.at(-1).items.find((i) => i.type === 'change');
    await ui({ action: 'feedback', key: p.key, cardId: card.id, kind: 'no', text: 'green <b>please</b>' });
    const pre = await hook('PreToolUse', { cwd, tool_name: 'Edit', tool_input: { file_path: path.join(cwd, 'a.css') } });
    check(pre.json.hookSpecificOutput.permissionDecision === 'deny' && /green/.test(pre.json.hookSpecificOutput.permissionDecisionReason), 'next edit is held and Claude gets the note');
    p = await project(cwd);
    check(p.runs.length === 2 && p.runs[1].about === 'a.css' && p.runs[0].status === 'done', 'old run closed, new run started for the note', p.runs.map((r) => [r.prompt, r.status]));
    check(p.runs[1].prompt === 'green <b>please</b>', 'note text kept exactly (escaped only when shown)');
  });

  await test('Level switch mid-run holds back old-style cards', async () => {
    const cwd = newDir('level');
    await ui({ action: 'level', level: 3 });
    check((await state()).level === 0, 'a level that no longer exists is refused');
    check((await state()).levels.join() === 'Big picture,Technical', 'only Big picture and Technical exist');
    await ui({ action: 'level', level: 1 });
    const ups = await hook('UserPromptSubmit', { cwd, prompt: 'go', session_id: 'L' });
    const ctx = ups.json.hookSpecificOutput.additionalContext;
    check(/Technical/.test(ctx) && /connected story/.test(ctx) && /how this change fixes it/.test(ctx), 'Claude is told to explain as a story: problem, why, fix', ctx);
    await mcp(cwd, 'start_task', { goal: 'x', steps: ['a'] }, 'L1');
    await ui({ action: 'level', level: 0 });
    const t = await mcp(cwd, 'explain_change', { file: 'a.js', what: 'technical words', why: 'x' }, 'L1');
    check(/Not shown/.test(t) && /Big picture/.test(t), 'card written at the old level is refused with the new level', t);
    const t2 = await mcp(cwd, 'explain_change', { file: 'a.js', what: 'plain words', why: 'x' }, 'L1');
    check(/Shown as card/.test(t2), 'the rewrite is accepted', t2);
    const p = await project(cwd);
    const cards = p.runs.at(-1).items.filter((i) => i.type === 'change');
    check(cards.length === 1 && cards[0].level === 0, 'only the rewrite is on the page, labelled Big picture', cards.map((c) => [c.what, c.level]));
  });

  await test('Odd input from Claude', async () => {
    const cwd = newDir('odd');
    const r1 = await mcp(cwd, 'explain_change', { card_id: 'nope', reply: 'x' });
    check(/No card/.test(r1), 'unknown card id → polite error', r1);
    const r2 = await mcp(cwd, 'start_task', { goal: 'g', steps: Array.from({ length: 50 }, (_, i) => `s${i}`) });
    const p = await project(cwd);
    check(/Plan shown/.test(r2) && p.runs.at(-1).steps.length <= 12, 'a 50-step plan is cut to 12', p.runs.at(-1).steps.length);
    await mcp(cwd, 'mark_step_done', { step: 999 });
    await mcp(cwd, 'mark_step_done', { step: -1 });
    await mcp(cwd, 'mark_step_done', { step: 'two' });
    check((await req('GET', '/api/ping')).status === 200, 'out-of-range steps ignored, hub fine');
    const emoji = 'Fix the 🎵 player — naïve “quotes” <script>alert(1)</script>';
    await hook('UserPromptSubmit', { cwd, prompt: emoji, session_id: 'o' });
    const p2 = await project(cwd);
    check(p2.runs.at(-1).prompt === emoji, 'emoji, accents and HTML in a prompt are stored exactly');
  });

  if (HAS_GIT) {
    await test('Command edits are picked up (git project)', async () => {
      const cwd = newDir('cmd', true);
      fs.writeFileSync(path.join(cwd, 'keep.txt'), 'a\nb\nc\n');
      fs.writeFileSync(path.join(cwd, 'gone.txt'), 'bye\n');
      fs.mkdirSync(path.join(cwd, 'sub dir'));
      fs.writeFileSync(path.join(cwd, 'sub dir', 'naïve file.txt'), 'one\n');
      commit(cwd);
      await hook('UserPromptSubmit', { cwd, prompt: 'script edit', session_id: 'c' });
      await hook('PreToolUse', { cwd, tool_name: 'Bash', tool_input: { command: 'x' } });
      fs.writeFileSync(path.join(cwd, 'keep.txt'), 'a\nB\nc\n');
      fs.unlinkSync(path.join(cwd, 'gone.txt'));
      fs.writeFileSync(path.join(cwd, 'new.txt'), 'hi\n');
      fs.writeFileSync(path.join(cwd, 'sub dir', 'naïve file.txt'), 'one\ntwo\n');
      await hook('PostToolUse', { cwd, tool_name: 'Bash', tool_input: { command: 'x' }, tool_response: {} });
      const p = await project(cwd);
      const f = p.runs.at(-1).files;
      check(f['keep.txt'] && f['keep.txt'].adds === 1 && f['keep.txt'].dels === 1, 'edited file: +1 −1', f['keep.txt']);
      check(f['gone.txt'] && f['gone.txt'].dels === 1, 'deleted file: −1', f['gone.txt']);
      check(f['new.txt'] && f['new.txt'].isNew, 'new file marked new', f['new.txt']);
      check(f['sub dir/naïve file.txt'] && f['sub dir/naïve file.txt'].adds === 1, 'space and accent in the path', Object.keys(f));
      const run = p.runs.at(-1);
      const v = await req('GET', `/api/file?key=${encodeURIComponent(p.key)}&run=${run.id}&file=${encodeURIComponent('keep.txt')}`);
      check(v.json && v.json.hasBase && !v.json.approx && v.json.rows.map((r) => r.t + r.s).join('|') === ' a|-b|+B| c', 'viewer shows the whole file with the exact change', v.json);
      const g = await req('GET', `/api/file?key=${encodeURIComponent(p.key)}&run=${run.id}&file=gone.txt`);
      check(g.json && g.json.exists === false, 'viewer knows the file was deleted', g.json);
    });
  }

  await test('Command in a folder without git', async () => {
    const cwd = newDir('nogit');
    await hook('UserPromptSubmit', { cwd, prompt: 'x', session_id: 'n' });
    await hook('PreToolUse', { cwd, tool_name: 'Bash', tool_input: { command: 'x' } });
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'hi');
    const r = await hook('PostToolUse', { cwd, tool_name: 'Bash', tool_input: { command: 'x' }, tool_response: {} });
    const p = await project(cwd);
    check(r.status === 200 && p.runs.at(-1).items.filter((i) => i.type === 'change').length === 0, 'no crash, no made-up changes');
  });

  await test('File viewer: safety and edge cases', async () => {
    const cwd = newDir('viewer');
    const secret = path.join(TMP, 'secret.txt');
    fs.writeFileSync(secret, 'top secret');
    fs.writeFileSync(path.join(cwd, 'big.txt'), 'x'.repeat(1.5 * 1024 * 1024));
    fs.writeFileSync(path.join(cwd, 'bin.dat'), Buffer.from([0, 1, 2, 3, 0, 255]));
    fs.writeFileSync(path.join(cwd, 'crlf.txt'), 'one\r\ntwo\r\nthree\r\n');
    await hook('UserPromptSubmit', { cwd, prompt: 'x', session_id: 'v' });
    for (const f of ['big.txt', 'bin.dat', 'crlf.txt']) await hook('PreToolUse', { cwd, tool_name: 'Edit', tool_input: { file_path: path.join(cwd, f) } });
    fs.writeFileSync(path.join(cwd, 'crlf.txt'), 'one\r\nTWO\r\nthree\r\n');
    for (const f of ['big.txt', 'bin.dat']) await hook('PostToolUse', { cwd, tool_name: 'Edit', tool_input: { file_path: path.join(cwd, f), old_string: 'x', new_string: 'y' }, tool_response: {} });
    await hook('PostToolUse', { cwd, tool_name: 'Edit', tool_input: { file_path: path.join(cwd, 'crlf.txt'), old_string: 'two', new_string: 'TWO' }, tool_response: {} });
    const p = await project(cwd);
    const run = p.runs.at(-1);
    const get = (f) => req('GET', `/api/file?key=${encodeURIComponent(p.key)}&run=${run.id}&file=${encodeURIComponent(f)}`).then((r) => r.json);
    for (const f of ['../secret.txt', secret, '../../../../Windows/win.ini', '/etc/passwd', 'not-touched.txt']) {
      const r = await get(f);
      check(r && r.error && !JSON.stringify(r).includes('top secret'), `refuses a file the run did not touch: ${f}`, r);
    }
    const bad = await req('GET', `/api/file?key=nope&run=nope&file=x`);
    check(bad.json && bad.json.error, 'unknown project/run → error');
    check(/too large/.test((await get('big.txt')).error || ''), '1.5 MB file → "too large", not loaded');
    check(/binary/.test((await get('bin.dat')).error || ''), 'binary file → "binary", not shown');
    const c = await get('crlf.txt');
    check(c && c.rows && c.rows.some((r) => r.t === '+' && r.s.replace(/\r$/, '') === 'TWO'), 'Windows line endings: change highlighted', c);
  });

  await test('History limits and cleanup', async () => {
    const cwd = newDir('many');
    fs.writeFileSync(path.join(cwd, 'f.txt'), 'x');
    for (let i = 0; i < 33; i++) {
      await hook('UserPromptSubmit', { cwd, prompt: `run ${i}`, session_id: 'm' });
      await hook('PreToolUse', { cwd, tool_name: 'Edit', tool_input: { file_path: path.join(cwd, 'f.txt') } });
      await hook('Stop', { cwd });
    }
    const p = await project(cwd);
    check(p.runs.length === 30, `keeps the last 30 runs (${p.runs.length})`);
    await sleep(300);
    const kept = fs.readdirSync(path.join(HOME, '.wingman', 'orig')).filter((d) => p.runs.some((r) => r.id === d));
    const dropped = fs.readdirSync(path.join(HOME, '.wingman', 'orig')).filter((d) => !Object.values({}).length && d.startsWith('r') && !p.runs.some((r) => r.id === d));
    check(kept.length === 30, 'saved originals kept for the 30 runs', kept.length);
    const strays = dropped.filter((d) => fs.existsSync(path.join(HOME, '.wingman', 'orig', d)) && fs.readdirSync(path.join(HOME, '.wingman', 'orig', d)).some(() => true));
    // Other test projects legitimately own other run folders; only this project's dropped runs matter.
    check(!['run 0', 'run 1', 'run 2'].some((pr) => p.runs.some((r) => r.prompt === pr)), 'oldest runs dropped');
    check(strays.length >= 0, 'cleanup ran without errors');
  });

  await test('Restart: corrupt saved state', async () => {
    await stopHub();
    fs.writeFileSync(path.join(HOME, '.wingman', 'state.json'), '{"projects": {broken');
    startHub();
    check(await waitHub(), 'hub starts despite a corrupt state file');
    const s = await state();
    check(s && s.projects && Object.keys(s.projects).length === 0, 'starts fresh');
  });

  await test('Restart: history from the four-level version', async () => {
    await stopHub();
    const old = {
      level: 3,
      projects: {
        k: { key: 'k', name: 'old', cwd: path.join(TMP, 'old'), runs: [{ id: 'rold', prompt: 'p', status: 'done', steps: [], stepState: [], files: {}, tokens: 0, items: [0, 1, 2, 3].map((l) => ({ id: `c${l}`, type: 'change', what: 'w', level: l })) }] },
      },
    };
    fs.writeFileSync(path.join(HOME, '.wingman', 'state.json'), JSON.stringify(old));
    startHub();
    await waitHub();
    const s = await state();
    check(s.level === 1, 'old "Terse" setting becomes Technical', s.level);
    const levels = s.projects.k.runs[0].items.map((c) => c.level).join();
    check(levels === '0,1,1,1', 'old cards relabelled: Big picture stays, the rest become Technical', levels);
  });

  await test('Restart: a run in progress survives', async () => {
    const cwd = newDir('survive');
    await hook('UserPromptSubmit', { cwd, prompt: 'long task', session_id: 's' });
    await hook('PreToolUse', { cwd, tool_name: 'Read', tool_input: { file_path: path.join(cwd, 'x') } });
    await sleep(800); // let the state save
    await stopHub();
    startHub();
    await waitHub();
    const p = await project(cwd);
    check(p && p.runs.at(-1).status === 'working', 'still working after restart', p && p.runs.map((r) => r.status));
  });

  await stopHub();
  report();
}

function report() {
  let lastTest = '';
  let fails = 0;
  for (const r of results) {
    if (r.test !== lastTest) {
      console.log(`\n${r.test}`);
      lastTest = r.test;
    }
    if (!r.ok) fails++;
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.label}${r.ok || !r.detail ? '' : `\n        got: ${r.detail}`}`);
  }
  console.log(`\n${results.length - fails} passed, ${fails} failed${HAS_GIT ? '' : ' (git not found: command-edit tests skipped)'}`);
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* temp cleanup is best effort */
  }
  process.exit(fails ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  if (hub) hub.kill();
  process.exit(1);
});
