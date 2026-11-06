'use strict';

// Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0).
// Each tool call is forwarded to the local hub, which updates the live page.

const { VERSION, request, ensureHub } = require('./shared');

const INSTRUCTIONS = `Wingman shows the user a live page that explains your work while you do it.
- For a task with several steps, call start_task first with the goal and short steps.
- Before each file edit, call explain_change with the file, what you are changing, why, and the plan step. Several small edits to one file can share one call. Call mark_step_done as you finish each step.
- When you need the user to choose between approaches, call ask_user instead of guessing.
- Tool results may include the user's chosen explanation level and their feedback. Follow both.`;

const TOOLS = [
  {
    name: 'start_task',
    description: 'Show the user the goal and plan for the current task. Call once at the start of a multi-step task.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'The task in a few words, as the user would say it.' },
        steps: { type: 'array', items: { type: 'string' }, description: '2 to 8 short steps, each a few words.' },
      },
      required: ['goal'],
    },
  },
  {
    name: 'explain_change',
    description:
      'Explain an edit to the user before you make it. Write "what" and "why" at the explanation level the tool results tell you. ' +
      'Wrap a technical term as {term|short definition} to give it a hover definition. ' +
      'To answer a user question about an earlier card or re-explain it, pass card_id with reply and/or new what/why.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path of the file you are about to change.' },
        what: { type: 'string', description: 'What the change does, in one sentence.' },
        why: { type: 'string', description: 'Why it is needed, in one or two sentences.' },
        kind: {
          type: 'string',
          enum: ['logic', 'cosmetic', 'new', 'delete', 'test', 'config', 'docs'],
          description: 'Type of change.',
        },
        step: { type: 'integer', description: 'Which plan step (1-based) this belongs to, if any.' },
        extra: { type: 'string', description: 'Optional: a comparison, a risk, or what comes next.' },
        card_id: { type: 'string', description: 'Update or reply on an existing card instead of making a new one.' },
        reply: { type: 'string', description: 'With card_id: your answer to the user on that card.' },
      },
    },
  },
  {
    name: 'mark_step_done',
    description: 'Mark a plan step as finished.',
    inputSchema: {
      type: 'object',
      properties: { step: { type: 'integer', description: '1-based step number.' } },
      required: ['step'],
    },
  },
  {
    name: 'ask_user',
    description:
      'Ask the user to choose on the live page and wait for the answer (up to 10 minutes). Use for real decisions, not confirmations.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        options: {
          type: 'array',
          minItems: 2,
          maxItems: 4,
          items: {
            type: 'object',
            properties: { label: { type: 'string' }, detail: { type: 'string' } },
            required: ['label'],
          },
        },
      },
      required: ['question', 'options'],
    },
  },
  {
    name: 'get_feedback',
    description: 'Check for feedback the user left on the live page. Other tools already include it, so call this only after a long stretch without them.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function callTool(name, args) {
  if (!TOOLS.some((t) => t.name === name)) throw new Error(`Unknown tool: ${name}`);
  await ensureHub();
  const r = await request('POST', '/api/mcp', { cwd: process.cwd(), tool: name, args: args || {} }, name === 'ask_user' ? 620000 : 10000);
  if (r.error) throw new Error(r.error);
  return r.text || 'OK';
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  try {
    let result;
    switch (method) {
      case 'initialize':
        ensureHub().catch(() => {});
        result = {
          protocolVersion: (params && params.protocolVersion) || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'wingman', version: VERSION },
          instructions: INSTRUCTIONS,
        };
        break;
      case 'ping':
        result = {};
        break;
      case 'tools/list':
        result = { tools: TOOLS };
        break;
      case 'tools/call':
        try {
          const text = await callTool(params.name, params.arguments);
          result = { content: [{ type: 'text', text }] };
        } catch (e) {
          result = {
            content: [{ type: 'text', text: `Wingman is unavailable (${e.message}). Continue your work normally.` }],
            isError: true,
          };
        }
        break;
      default:
        if (!isRequest) return; // notifications such as notifications/initialized
        return write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
    if (isRequest) write({ jsonrpc: '2.0', id, result });
  } catch (e) {
    if (isRequest) write({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
  }
}

function main() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        continue;
      }
      handle(msg);
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

module.exports = { main, TOOLS };
