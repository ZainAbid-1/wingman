'use strict';

// The hub is one small local web server per machine. It keeps the explanation
// state, serves the live page, receives events from hooks and the MCP server,
// and holds pause / feedback / answers until Claude picks them up.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PORT, HOST, VERSION, openBrowser } = require('./shared');

const LEVELS = [
  { name: 'Big picture', guide: 'plain words for someone who does not read code; avoid jargon and code names; an everyday comparison is welcome' },
  { name: 'Walkthrough', guide: 'name the files and functions involved and define at most one technical term per change as {term|short definition}' },
  { name: 'Technical', guide: 'concise and technical, for a developer' },
  { name: 'Terse', guide: 'one short line; "why" only if it is not obvious' },
];
const WINGMAN_TOOL = /(^|__)(start_task|explain_change|mark_step_done|ask_user|get_feedback)$/;
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const MUTATING = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash', 'PowerShell']);
const STORE_DIR = path.join(os.homedir(), '.wingman');
const STORE = path.join(STORE_DIR, 'state.json');
const MAX_RUNS = 30;
const MAX_ROWS = 160;

let state = { level: 0, projects: {} };
let seq = 0;
const id = (p) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;
const now = () => Date.now();

/* ---------- persistence ---------- */
function load() {
  try {
    const s = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    if (s && s.projects) state = s;
    for (const p of Object.values(state.projects)) {
      p.paused = false;
      p.activity = '';
      p.pending = [];
      for (const r of p.runs) if (r.status === 'working') r.status = 'done';
    }
  } catch {
    /* first run */
  }
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(STORE_DIR, { recursive: true });
      fs.writeFileSync(STORE, JSON.stringify(state));
    } catch {
      /* not fatal */
    }
  }, 500);
}

/* ---------- live updates (server-sent events) ---------- */
const clients = new Set();
let bTimer = null;
function changed() {
  save();
  if (bTimer) return;
  bTimer = setTimeout(() => {
    bTimer = null;
    const msg = `data: ${JSON.stringify(publicState())}\n\n`;
    for (const res of clients) res.write(msg);
  }, 40);
}
function publicState() {
  return { level: state.level, levels: LEVELS.map((l) => l.name), projects: state.projects, version: VERSION };
}

/* ---------- model helpers ---------- */
function keyOf(cwd) {
  const r = path.resolve(cwd || '.');
  return process.platform === 'win32' ? r.toLowerCase() : r;
}
function project(cwd) {
  const key = keyOf(cwd);
  let p = state.projects[key];
  if (!p) {
    p = state.projects[key] = {
      key,
      name: path.basename(path.resolve(cwd || '.')) || 'project',
      cwd: path.resolve(cwd || '.'),
      paused: false,
      activity: '',
      runs: [],
      pending: [],
      lastToolAt: 0,
      lastLevelSent: -1,
      createdAt: now(),
    };
  }
  p.lastSeen = now();
  return p;
}
function working(p) {
  const r = p.runs[p.runs.length - 1];
  return r && r.status === 'working' ? r : null;
}
function newRun(p, prompt, source) {
  const cur = working(p);
  if (cur) finishRun(cur);
  const r = {
    id: id('r'),
    prompt: prompt || '',
    source,
    status: 'working',
    startedAt: now(),
    endedAt: 0,
    steps: [],
    stepState: [],
    items: [],
    files: {},
    tokens: 0,
  };
  p.runs.push(r);
  if (p.runs.length > MAX_RUNS) p.runs.splice(0, p.runs.length - MAX_RUNS);
  maybeOpen();
  return r;
}
function runFor(p) {
  return working(p) || newRun(p, '', 'auto');
}
function finishRun(r) {
  r.status = 'done';
  r.endedAt = now();
  for (const f of Object.values(r.files)) f.active = false;
  // Steps that got changes are treated as finished; untouched steps stay open.
  const touched = new Set(r.items.filter((i) => i.type === 'change' && i.step).map((i) => Number(i.step)));
  r.stepState = r.stepState.map((s, i) => (s === 'active' || touched.has(i + 1) ? 'done' : s));
}
function rel(p, file) {
  if (!file) return '';
  const abs = path.resolve(p.cwd, file);
  const r = path.relative(p.cwd, abs);
  return (r && !r.startsWith('..') ? r : abs).split(path.sep).join('/');
}
function fileState(run, f) {
  return run.files[f] || (run.files[f] = { read: false, active: false, adds: 0, dels: 0, isNew: false });
}
function findCard(p, cardId) {
  for (let i = p.runs.length - 1; i >= 0; i--) {
    const c = p.runs[i].items.find((x) => x.id === cardId);
    if (c) return { run: p.runs[i], card: c };
  }
  return {};
}
function setStep(run, step) {
  const n = Number(step);
  if (!run.steps.length || !Number.isInteger(n) || n < 1 || n > run.steps.length) return;
  for (let i = 0; i < n - 1; i++) if (run.stepState[i] !== 'done') run.stepState[i] = 'done';
  for (let i = 0; i < run.stepState.length; i++) if (run.stepState[i] === 'active' && i !== n - 1) run.stepState[i] = 'done';
  if (run.stepState[n - 1] !== 'done') run.stepState[n - 1] = 'active';
}

let opened = false;
function maybeOpen() {
  if (opened || clients.size > 0) return;
  opened = true;
  openBrowser();
}

/* ---------- feedback queue ---------- */
function queue(p, text, msg) {
  p.pending.push({ text, msg: msg || null });
}
function takePending(p) {
  if (!p.pending.length) return '';
  const out = p.pending.map((x) => `- ${x.text}`).join('\n');
  for (const x of p.pending) if (x.msg) x.msg.delivered = true;
  p.pending = [];
  changed();
  return out;
}

/* ---------- diffs ---------- */
function rowsFromPatch(patch) {
  const rows = [];
  patch.forEach((h, hi) => {
    if (hi > 0) rows.push({ t: '~' });
    let o = h.oldStart || 1;
    let n = h.newStart || 1;
    for (const line of h.lines || []) {
      const t = line[0];
      const s = line.slice(1);
      if (t === '-') rows.push({ t, n: o++, s });
      else if (t === '+') rows.push({ t, n: n++, s });
      else if (t === '\\') continue;
      else {
        rows.push({ t: ' ', n: n++, s });
        o++;
      }
    }
  });
  return rows;
}
function rowsFromStrings(oldS, newS) {
  const rows = [];
  if (oldS) for (const s of String(oldS).split('\n')) rows.push({ t: '-', s });
  if (newS) for (const s of String(newS).split('\n')) rows.push({ t: '+', s });
  return rows;
}
function diffFor(tool, input, resp) {
  let rows = [];
  if (resp && Array.isArray(resp.structuredPatch) && resp.structuredPatch.length) {
    rows = rowsFromPatch(resp.structuredPatch);
  } else if (tool === 'Write') {
    rows = String(input.content || '').split('\n').map((s, i) => ({ t: '+', n: i + 1, s }));
  } else if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
    input.edits.forEach((e, i) => {
      if (i) rows.push({ t: '~' });
      rows.push(...rowsFromStrings(e.old_string, e.new_string));
    });
  } else if (tool === 'NotebookEdit') {
    rows = rowsFromStrings('', input.new_source);
  } else {
    rows = rowsFromStrings(input.old_string, input.new_string);
  }
  const adds = rows.filter((r) => r.t === '+').length;
  const dels = rows.filter((r) => r.t === '-').length;
  const truncated = rows.length > MAX_ROWS ? rows.length - MAX_ROWS : 0;
  return { rows: rows.slice(0, MAX_ROWS), adds, dels, truncated };
}
function mergeDiff(a, b) {
  const rows = a.rows.concat([{ t: '~' }], b.rows).slice(0, MAX_ROWS);
  return { rows, adds: a.adds + b.adds, dels: a.dels + b.dels, truncated: a.truncated + b.truncated };
}

/* ---------- describing activity ---------- */
function base(f) {
  return f ? path.basename(String(f)) : '';
}
function describe(tool, input) {
  input = input || {};
  switch (tool) {
    case 'Edit':
    case 'MultiEdit':
      return `Editing ${base(input.file_path)}`;
    case 'Write':
      return `Writing ${base(input.file_path)}`;
    case 'NotebookEdit':
      return `Editing ${base(input.notebook_path)}`;
    case 'Read':
      return `Reading ${base(input.file_path)}`;
    case 'Bash':
    case 'PowerShell':
      return `Running ${input.description || String(input.command || '').slice(0, 48)}`;
    case 'Grep':
    case 'Glob':
      return 'Searching the code';
    case 'WebFetch':
    case 'WebSearch':
      return 'Looking something up';
    case 'Task':
    case 'Agent':
      return 'Running a helper agent';
    default:
      return `Using ${String(tool || 'a tool').replace(/^mcp__/, '').replace(/__/g, ' · ')}`;
  }
}

/* ---------- MCP tool calls ---------- */
// Tell each Claude session (one MCP process each) the level once, and again whenever it changes.
const levelSent = new Map();
function levelNote(session) {
  if (levelSent.get(session) === state.level) return '';
  levelSent.set(session, state.level);
  const l = LEVELS[state.level];
  return `Explanation level is now "${l.name}": ${l.guide}.`;
}
function reply(p, run, args, main) {
  const parts = [main];
  const lv = levelNote((args && args.__session) || p.key);
  if (lv) parts.push(lv);
  const fb = takePending(p);
  if (fb) parts.push(`Feedback from the user (handle before continuing):\n${fb}`);
  const text = parts.filter(Boolean).join('\n');
  if (run) run.tokens += Math.ceil((JSON.stringify(args || {}).length + text.length) / 4) + 40;
  return text;
}

async function mcpCall(body) {
  const p = project(body.cwd);
  const a = Object.assign({}, body.args);
  // Hidden from the token estimate; tells reply() which Claude session is asking.
  Object.defineProperty(a, '__session', { value: body.session || p.key, enumerable: false });
  switch (body.tool) {
    case 'start_task': {
      let run = working(p);
      if (!run) run = newRun(p, a.goal || '', 'mcp');
      if (!run.prompt) run.prompt = a.goal || '';
      run.goal = a.goal || run.goal;
      run.steps = Array.isArray(a.steps) ? a.steps.map(String).slice(0, 12) : [];
      run.stepState = run.steps.map(() => 'todo');
      if (run.steps.length) run.stepState[0] = 'active';
      changed();
      return reply(p, run, a, 'Plan shown to the user.');
    }
    case 'explain_change': {
      if (a.card_id) {
        const { run, card } = findCard(p, a.card_id);
        if (!card) return reply(p, null, a, `No card with id ${a.card_id}.`);
        if (a.reply) card.thread.push({ from: 'claude', text: String(a.reply), at: now() });
        if (a.what) card.what = String(a.what);
        if (a.why !== undefined) card.why = String(a.why || '');
        if (a.extra !== undefined) card.extra = String(a.extra || '');
        if (a.what || a.why) {
          card.level = state.level;
          card.wantSimpler = false;
        }
        changed();
        return reply(p, run, a, 'Updated.');
      }
      const run = runFor(p);
      const file = rel(p, a.file);
      const card = {
        id: id('c'),
        type: 'change',
        file,
        kind: ['cosmetic', 'logic', 'new', 'delete', 'test', 'config', 'docs'].includes(a.kind) ? a.kind : 'logic',
        what: String(a.what || ''),
        why: String(a.why || ''),
        extra: String(a.extra || ''),
        step: a.step || null,
        level: state.level,
        diff: null,
        thread: [],
        approved: false,
        at: now(),
      };
      run.items.push(card);
      if (file) {
        const fs1 = fileState(run, file);
        for (const f of Object.values(run.files)) f.active = false;
        fs1.active = true;
        if (card.kind === 'new') fs1.isNew = true;
      }
      setStep(run, a.step);
      changed();
      maybeOpen();
      return reply(p, run, a, `Shown as card ${card.id}.`);
    }
    case 'mark_step_done': {
      const run = working(p);
      const n = Number(a.step);
      if (run && Number.isInteger(n) && n >= 1 && n <= run.steps.length) {
        run.stepState[n - 1] = 'done';
        if (run.stepState[n] === 'todo') run.stepState[n] = 'active';
        changed();
      }
      return reply(p, run, a, 'Step marked done.');
    }
    case 'get_feedback': {
      const fb = takePending(p);
      return fb ? `Feedback from the user:\n${fb}` : 'No feedback right now.';
    }
    case 'ask_user': {
      const run = runFor(p);
      const opts = (Array.isArray(a.options) ? a.options : []).slice(0, 4).map((o) =>
        typeof o === 'string' ? { label: o, detail: '' } : { label: String(o.label || ''), detail: String(o.detail || '') }
      );
      const ask = { id: id('q'), type: 'ask', question: String(a.question || ''), options: opts, answer: null, at: now() };
      run.items.push(ask);
      p.activity = 'Waiting for your answer';
      changed();
      maybeOpen();
      const deadline = now() + 590 * 1000;
      while (ask.answer === null && now() < deadline) await sleep(250);
      p.activity = '';
      if (ask.answer === null) {
        ask.answer = '(no answer)';
        changed();
        return reply(p, run, a, 'The user did not answer within 10 minutes. Use your best judgment and say which option you chose.');
      }
      changed();
      return reply(p, run, a, `The user chose: ${ask.answer}`);
    }
    default:
      throw new Error(`Unknown tool ${body.tool}`);
  }
}

/* ---------- hooks ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function hookCall(body) {
  const event = body.event;
  const h = body.payload || {};
  const p = project(h.cwd);
  const tool = h.tool_name || '';
  const isOurs = WINGMAN_TOOL.test(tool);

  switch (event) {
    case 'SessionStart':
      changed();
      return context('SessionStart', REMINDER);

    case 'UserPromptSubmit': {
      const text = String(h.prompt || '').trim();
      if (!text) return {};
      const run = working(p);
      if (run && now() - p.lastToolAt < 20000) {
        run.items.push({ id: id('m'), type: 'message', text, at: now() });
      } else {
        newRun(p, text, 'prompt');
      }
      changed();
      return context('UserPromptSubmit', SHORT_REMINDER);
    }

    case 'PreToolUse': {
      if (isOurs) return {};
      p.lastToolAt = now();
      p.activity = describe(tool, h.tool_input);
      const run = working(p);
      if (run && EDIT_TOOLS.has(tool)) {
        const f = rel(p, (h.tool_input || {}).file_path || (h.tool_input || {}).notebook_path);
        if (f) {
          for (const x of Object.values(run.files)) x.active = false;
          fileState(run, f).active = true;
        }
      }
      changed();
      if (p.paused) {
        const deadline = now() + 585 * 1000;
        while (p.paused && now() < deadline) await sleep(300);
        if (p.paused) {
          return deny('The user paused you from Wingman. Stop here and ask them how they want to continue.');
        }
      }
      if (MUTATING.has(tool) && p.pending.length) {
        const fb = takePending(p);
        return deny(`Before this step, the user left feedback in Wingman. Take it into account, then continue (retry this step only if it still makes sense):\n${fb}`);
      }
      return {};
    }

    case 'PostToolUse': {
      if (isOurs) return {};
      p.lastToolAt = now();
      p.activity = '';
      const run = runFor(p);
      const input = h.tool_input || {};
      let nudge = '';
      if (EDIT_TOOLS.has(tool)) {
        const f = rel(p, input.file_path || input.notebook_path);
        const d = diffFor(tool, input, h.tool_response || {});
        const fst = fileState(run, f);
        fst.adds += d.adds;
        fst.dels += d.dels;
        fst.read = true;
        if (tool === 'Write' && h.tool_response && h.tool_response.type === 'create') fst.isNew = true;
        const last = run.items[run.items.length - 1];
        let card = null;
        for (let i = run.items.length - 1; i >= 0; i--) {
          const c = run.items[i];
          if (c.type === 'change' && c.file === f && !c.diff) {
            card = c;
            break;
          }
        }
        if (card) {
          card.diff = d;
        } else if (last && last.type === 'change' && last.file === f && last.diff) {
          last.diff = mergeDiff(last.diff, d);
        } else {
          if (!run.nudged) {
            run.nudged = true;
            nudge = `Wingman: you changed ${f} without explaining it. The user is watching the Wingman page; call explain_change for it now (file, what, why) and before each further edit.`;
          }
          run.items.push({
            id: id('c'),
            type: 'change',
            file: f,
            kind: fst.isNew ? 'new' : 'edit',
            what: '',
            why: '',
            extra: '',
            step: null,
            level: state.level,
            diff: d,
            thread: [],
            approved: false,
            at: now(),
          });
        }
      } else if (tool === 'Read' && input.file_path) {
        fileState(run, rel(p, input.file_path)).read = true;
      } else if (tool === 'Bash' || tool === 'PowerShell') {
        const resp = h.tool_response || {};
        run.items.push({
          id: id('x'),
          type: 'cmd',
          command: String(input.command || '').slice(0, 400),
          description: String(input.description || ''),
          failed: !!(resp.interrupted || (resp.stderr && !resp.stdout && /error|fail/i.test(resp.stderr))),
          at: now(),
        });
      }
      changed();
      const fb = takePending(p);
      const parts = [];
      if (fb) parts.push(`Feedback from the user in Wingman (handle before continuing):\n${fb}`);
      if (nudge) parts.push(nudge);
      return parts.length ? context('PostToolUse', parts.join('\n')) : {};
    }

    case 'Stop': {
      if (p.pending.length && !h.stop_hook_active) {
        const fb = takePending(p);
        return { decision: 'block', reason: `The user left feedback in Wingman. Address it:\n${fb}` };
      }
      const run = working(p);
      if (run) finishRun(run);
      p.activity = '';
      changed();
      return {};
    }

    default:
      return {};
  }
}
const REMINDER =
  'Wingman is on: the user watches a live page that explains your work as you do it. ' +
  'For multi-step work call the wingman start_task tool first. Before each file edit call wingman explain_change (file, what, why, step). ' +
  'If these tools are deferred, load them with tool search first. Tool results may carry the user\'s detail level and feedback; follow them.';
const SHORT_REMINDER = 'Wingman is on: call wingman explain_change before each file edit.';
function context(eventName, text) {
  return { hookSpecificOutput: { hookEventName: eventName, additionalContext: text } };
}
function deny(reason) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

/* ---------- page actions ---------- */
function uiCall(b) {
  if (b.action === 'level') {
    const l = Number(b.level);
    if (l >= 0 && l < LEVELS.length) state.level = l;
    changed();
    return {};
  }
  const p = state.projects[b.key];
  if (!p) return { error: 'Unknown project' };
  switch (b.action) {
    case 'pause':
      p.paused = true;
      break;
    case 'resume':
      p.paused = false;
      break;
    case 'answer': {
      for (const r of p.runs) {
        const q = r.items.find((x) => x.id === b.askId && x.type === 'ask');
        if (q && q.answer === null) q.answer = String(b.choice || '');
      }
      break;
    }
    case 'feedback': {
      const { card } = findCard(p, b.cardId);
      if (!card) return { error: 'Unknown card' };
      const where = `card ${card.id}${card.file ? ` (${card.file})` : ''}`;
      if (b.kind === 'ok') {
        card.approved = true;
        break;
      }
      if (b.kind === 'simpler') {
        card.wantSimpler = true;
        queue(p, `The user wants ${where} explained more simply. Call explain_change with card_id "${card.id}" and a plainer what/why.`);
        break;
      }
      const text = String(b.text || '').trim() || (b.kind === 'why' ? 'Why did you do it this way?' : 'Not like this.');
      const msg = { from: 'user', kind: b.kind, text, delivered: false, at: now() };
      card.thread.push(msg);
      if (b.kind === 'why') {
        queue(p, `About ${where}, the user asks: "${text}". Answer in one or two sentences with explain_change, card_id "${card.id}", reply.`, msg);
      } else {
        queue(p, `The user does not want ${where} as it is: "${text}". Change your approach accordingly, and reply briefly with explain_change, card_id "${card.id}", reply.`, msg);
      }
      break;
    }
    case 'clear':
      p.runs = p.runs.filter((r) => r.status === 'working');
      break;
    case 'forget':
      delete state.projects[b.key];
      break;
    default:
      return { error: 'Unknown action' };
  }
  changed();
  return {};
}

/* ---------- http ---------- */
let lastHit = now();
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}
function send(res, code, obj) {
  const data = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(data);
}

function main() {
  load();
  const page = path.join(__dirname, '..', 'public', 'index.html');
  const server = http.createServer(async (req, res) => {
    lastHit = now();
    const url = new URL(req.url, 'http://x');
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return fs.createReadStream(page).pipe(res);
      }
      if (req.method === 'GET' && url.pathname === '/api/ping') return send(res, 200, { ok: true, version: VERSION });
      if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, publicState());
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify(publicState())}\n\n`);
        clients.add(res);
        opened = true;
        const ka = setInterval(() => res.write(': ka\n\n'), 25000);
        req.on('close', () => {
          clearInterval(ka);
          clients.delete(res);
        });
        return;
      }
      // Only accept writes from this machine's page or tools, never from other sites.
      const origin = req.headers.origin;
      if (origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return send(res, 403, { error: 'Forbidden' });
      if (req.method === 'POST' && url.pathname === '/api/hook') return send(res, 200, await hookCall(await readBody(req)));
      if (req.method === 'POST' && url.pathname === '/api/mcp') {
        const b = await readBody(req);
        try {
          return send(res, 200, { text: await mcpCall(b) });
        } catch (e) {
          return send(res, 200, { error: e.message });
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/ui') return send(res, 200, uiCall(await readBody(req)));
      send(res, 404, { error: 'Not found' });
    } catch (e) {
      send(res, 500, { error: e.message });
    }
  });
  server.requestTimeout = 0;
  server.timeout = 0;
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') process.exit(0); // another hub already runs
    throw e;
  });
  server.listen(PORT, HOST, () => {
    if (process.stdout.isTTY) console.log(`Wingman is live at http://localhost:${PORT}`);
  });
  // Shut down after 3 idle hours with no page open.
  setInterval(() => {
    if (clients.size === 0 && now() - lastHit > 3 * 3600 * 1000) process.exit(0);
  }, 5 * 60 * 1000).unref();
}

module.exports = { main };
