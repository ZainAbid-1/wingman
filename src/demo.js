'use strict';

// Plays an example session through the same hook and MCP endpoints Claude Code
// uses, so feedback and questions on the page behave for real.

const os = require('os');
const path = require('path');
const { request, ensureHub, openBrowser, URL } = require('./shared');

const cwd = path.join(os.tmpdir(), 'musicapp');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const abs = (f) => path.join(cwd, f);
const replies = {};

async function level() {
  try {
    return (await request('GET', '/api/state')).level || 0;
  } catch {
    return 0;
  }
}
function log(...a) {
  console.log('  ', ...a);
}
async function hook(event, payload) {
  const out = await request('POST', '/api/hook', { event, payload: { cwd, session_id: 'demo', hook_event_name: event, ...payload } }, 600000);
  const ctx = out && (out.hookSpecificOutput || {}).additionalContext;
  const reason = out && ((out.hookSpecificOutput || {}).permissionDecisionReason || out.reason);
  const fb = ctx || reason;
  if (fb) {
    log('Claude received feedback:\n' + fb.split('\n').map((l) => '      ' + l).join('\n'));
    await answerFeedback(fb);
  }
  return out;
}
async function mcp(tool, args) {
  const r = await request('POST', '/api/mcp', { cwd, tool, args }, 620000);
  if (r.text && /Feedback from the user/.test(r.text)) {
    log('Claude received feedback:\n' + r.text.split('\n').map((l) => '      ' + l).join('\n'));
    await answerFeedback(r.text);
  }
  return r.text || '';
}
async function answerFeedback(text) {
  const ids = [...text.matchAll(/card_id "([^"]+)"/g)].map((m) => m[1]);
  for (const id of new Set(ids)) {
    await sleep(900);
    await mcp('explain_change', {
      card_id: id,
      reply: replies[id] || 'Understood, I will do it that way. (This is the demo, so the answer is canned. In a real session Claude answers you here.)',
    });
  }
}
async function edit(file, kind, step, L, patch, tool = 'Edit', reply = '') {
  const lv = await level();
  // Samples are written for the old four levels; level 1 is now Technical (old index 2).
  const t = (lv === 1 ? L[2] : L[0]) || L[1];
  const out = await mcp('explain_change', { file, kind, step, what: t[0], why: t[1] || '', extra: t[2] || '' });
  const m = out.match(/card (c\w+)/);
  if (m && reply) replies[m[1]] = reply;
  await sleep(700);
  const input = tool === 'Write' ? { file_path: abs(file), content: patch.map((l) => l.slice(1)).join('\n') } : { file_path: abs(file) };
  const pre = await hook('PreToolUse', { tool_name: tool, tool_input: input });
  if (pre.hookSpecificOutput && pre.hookSpecificOutput.permissionDecision === 'deny') {
    log('Edit held back by the user; retrying after taking the feedback into account.');
    await sleep(1500);
  }
  await sleep(500);
  const start = Number((patch[0].match(/@(\d+)/) || [])[1]) || 1;
  const lines = patch.filter((l) => !l.startsWith('@'));
  await hook('PostToolUse', {
    tool_name: tool,
    tool_input: input,
    tool_response: { type: tool === 'Write' ? 'create' : undefined, structuredPatch: [{ oldStart: start, newStart: start, lines }] },
  });
}

async function main() {
  if (!(await ensureHub())) {
    console.error('Could not start the Wingman hub.');
    process.exit(1);
  }
  console.log(`\nWingman demo — watch it at ${URL}`);
  console.log('Try the detail level (top right) and "Not like this" on a card. The demo reacts like Claude would.\n');
  openBrowser();
  await sleep(1500);

  await hook('UserPromptSubmit', { prompt: 'Fix the crash when the playlist is empty' });
  await sleep(800);
  await mcp('start_task', { goal: 'Fix the crash when the playlist is empty', steps: ['Find the crash', 'Guard the empty queue', 'Show what happens instead', 'Add a test'] });
  for (const f of ['src/player/player.ts', 'src/lib/queue.ts', 'src/ui/App.tsx']) {
    await hook('PreToolUse', { tool_name: 'Read', tool_input: { file_path: abs(f) } });
    await sleep(500);
    await hook('PostToolUse', { tool_name: 'Read', tool_input: { file_path: abs(f) } });
  }
  log('Read 3 files');
  await sleep(1200);

  await edit('src/lib/queue.ts', 'cosmetic', 2, [
    ['Tidying up names in the playlist code and adding a simple yes/no check: is the playlist empty?', 'Clearer names make the real fix easier to read, and the next change uses this check.'],
    ['Renames the vague `q` to `items` and adds an `isEmpty` {getter|A property that runs a small function whenever you read it}.', 'The fix in `player.ts` needs to ask whether the queue is empty.'],
    ['Rename `q` → `items`; add `isEmpty` getter.', 'Used by the guard in `play()`.'],
    ['Rename + `isEmpty` getter.'],
  ], ['@12', ' export class Queue {', '-  private q: Song[] = [];', '+  private items: Song[] = [];', ' ', '-  get length() { return this.q.length; }', '+  get length() { return this.items.length; }', '+  get isEmpty() { return this.items.length === 0; }'],
  'Edit', 'Putting `isEmpty` on the queue keeps the rule in one place. If "empty" ever means more, there is one line to update.');
  await sleep(2500);

  await edit('src/player/player.ts', 'logic', 2, [
    ["This is the actual fix. Before playing, the app now checks whether there's anything to play.", 'With an empty playlist, the app reached for a song that wasn\'t there and crashed.', 'Like checking there\'s milk before you pour the cereal.'],
    ['Adds a {guard clause|An early check that exits a function when something is not right} at the top of `play()`.', '`peek()` returns `undefined` on an empty queue, and the next line read `song.url` from it.'],
    ['Early return in `play()` when `queue.isEmpty`; emits `empty`.', "Fixes `TypeError: Cannot read properties of undefined (reading 'url')`."],
    ['Guard empty queue in `play()`, emit `empty`.'],
  ], ['@41', ' play() {', '-  const song = this.queue.peek();', '+  if (this.queue.isEmpty) {', '+    this.emit("empty");', '+    return;', '+  }', '+  const song = this.queue.peek();', '   this.audio.src = song.url;'],
  'Edit', 'Returning silently would hide the problem, so the player announces an `empty` event and the screen decides what to show.');
  await mcp('mark_step_done', { step: 2 });
  await sleep(2000);

  log('Asking the user a question on the page…');
  const ans = await mcp('ask_user', {
    question: 'When the playlist is empty, what should people see?',
    options: [{ label: 'Show a friendly message', detail: 'A note with a Browse music button.' }, { label: 'Hide the player bar', detail: 'Nothing shows until a song is added.' }],
  });
  log(ans.split('\n')[0]);
  const hide = /Hide/.test(ans);
  await sleep(1200);

  if (hide) {
    await edit('src/ui/App.tsx', 'logic', 3, [
      ["Hiding the player bar whenever there's nothing to play.", 'You chose to hide it.'],
      ['`App` returns `null`, which means "draw nothing", when the queue is empty.', 'Matches your choice.'],
      ['Conditional render: `null` when `queue.isEmpty`.', 'Per your choice.'],
      ['Hide `PlayerBar` when empty.'],
    ], ['@21', '-  return <PlayerBar />;', '+  if (queue.isEmpty) return null;', '+  return <PlayerBar />;']);
  } else {
    await edit('src/ui/EmptyState.tsx', 'new', 3, [
      ['A new piece of the screen: a message that says the playlist is empty, with a button to find music.', 'You chose to show a message.'],
      ['New {component|A reusable building block of the interface} `EmptyState` with a message and a Browse button.', 'Keeping it in its own file lets other screens reuse it.'],
      ['Add `EmptyState` with an `onBrowse` callback.', 'Per your choice.'],
      ['New `EmptyState.tsx`.'],
    ], ['@1', '+export function EmptyState({ onBrowse }) {', '+  return (', '+    <div className="empty">', '+      <p>Your playlist is empty</p>', '+      <button onClick={onBrowse}>Browse music</button>', '+    </div>', '+  );', '+}'], 'Write');
    await sleep(1800);
    await edit('src/ui/App.tsx', 'logic', 3, [
      ['Connecting the new message to the app, so it appears when the playlist is empty.', 'The player announces "empty"; the app listens and swaps the bar for the message.'],
      ["`App` listens for the player's `empty` event and keeps it in {state|Data the screen remembers; when it changes, the screen redraws}.", 'When `empty` is true it shows `EmptyState`.'],
      ['Subscribe to `empty`; conditionally render `EmptyState`.', 'Wires the step 2 event into the UI.'],
      ['Wire `empty` → `EmptyState`.'],
    ], ['@18', ' const queue = usePlayerQueue();', '+const [empty, setEmpty] = useState(queue.isEmpty);', '+useEffect(() => player.on("empty", () => setEmpty(true)), []);', '-return <PlayerBar />;', '+if (empty) return <EmptyState onBrowse={openLibrary} />;', '+return <PlayerBar />;']);
  }
  await mcp('mark_step_done', { step: 3 });
  await sleep(2000);

  await edit('tests/player.test.ts', 'test', 4, [
    ['Adding an automatic check that recreates the exact situation that used to crash.', 'If someone breaks this again, the check fails before it reaches you.'],
    ['Adds a {test|Code that runs your code in a known situation and checks the result} calling `play()` on an empty queue.', 'Checks nothing throws and `empty` fires once.'],
    ["Regression test: `play()` on empty queue doesn't throw, emits `empty`.", 'Locks in the fix.'],
    ['Regression test.'],
  ], ['@1', '+test("play() on an empty queue doesn\'t crash", () => {', '+  const player = new Player(new Queue());', '+  const onEmpty = vi.fn();', '+  player.on("empty", onEmpty);', '+  expect(() => player.play()).not.toThrow();', '+  expect(onEmpty).toHaveBeenCalledOnce();', '+});'], 'Write');
  await sleep(1500);

  const cmd = { command: 'npm test', description: 'Run the test suite' };
  await hook('PreToolUse', { tool_name: 'Bash', tool_input: cmd });
  await sleep(1800);
  await hook('PostToolUse', { tool_name: 'Bash', tool_input: cmd, tool_response: { stdout: '5 passed', stderr: '' } });
  await mcp('mark_step_done', { step: 4 });
  await sleep(1200);
  const stop = await hook('Stop', {});
  if (stop.decision === 'block') {
    await sleep(1500);
    await hook('Stop', { stop_hook_active: true });
  }
  console.log('\nDemo finished. The page stays up; run the demo again any time.\n');
  process.exit(0);
}

module.exports = { main };
