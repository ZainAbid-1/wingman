'use strict';

// Claude Code runs this for each hook event. It forwards the event to the hub
// and prints whatever the hub wants Claude Code to do (deny, add context...).
// It must never break Claude's work: on any error it exits 0 silently.

const { request, ensureHub, readStdin } = require('./shared');

async function main(eventArg) {
  // A background answer that Wingman itself started: stay silent.
  if (process.env.WINGMAN_OFF) return process.exit(0);
  try {
    const raw = await readStdin();
    const payload = raw ? JSON.parse(raw) : {};
    const event = eventArg || payload.hook_event_name;
    if (!event) return process.exit(0);
    if (!(await ensureHub())) return process.exit(0);
    const timeout = event === 'PreToolUse' ? 595000 : 8000;
    const out = await request('POST', '/api/hook', { event, payload, claude: process.env.CLAUDE_CODE_EXECPATH || '' }, timeout);
    if (out && Object.keys(out).length && !out.error) process.stdout.write(JSON.stringify(out));
  } catch {
    /* stay out of the way */
  }
  process.exit(0);
}

module.exports = { main };
