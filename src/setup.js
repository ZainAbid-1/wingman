'use strict';

// Adds the Wingman hooks to Claude Code settings, keeping everything else intact.

const fs = require('fs');
const os = require('os');
const path = require('path');

const EVENTS = {
  SessionStart: { timeout: 10 },
  UserPromptSubmit: { timeout: 10 },
  PreToolUse: { timeout: 600, matcher: '*' },
  PostToolUse: { timeout: 10, matcher: '*' },
  Stop: { timeout: 10 },
};
// Matches only hook commands that run Wingman's own cli.js.
const MARK = /wingman[\\/].*cli\.js"? hook /i;

function main(args) {
  const projectLevel = args.includes('--project');
  const remove = args.includes('--remove');
  const file = projectLevel
    ? path.join(process.cwd(), '.claude', 'settings.json')
    : path.join(os.homedir(), '.claude', 'settings.json');
  const cli = path.resolve(__dirname, '..', 'bin', 'cli.js');
  const command = `node "${cli}" hook`;

  let settings = {};
  if (fs.existsSync(file)) {
    try {
      settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      console.error(`Couldn't read ${file}: ${e.message}. Fix the JSON and try again.`);
      process.exit(1);
    }
  }
  settings.hooks = settings.hooks || {};

  for (const [event, opt] of Object.entries(EVENTS)) {
    const list = (settings.hooks[event] || []).map((g) => ({
      ...g,
      hooks: (g.hooks || []).filter((h) => !MARK.test(String(h.command || ''))),
    })).filter((g) => g.hooks.length);
    if (!remove) {
      const group = { hooks: [{ type: 'command', command: `${command} ${event}`, timeout: opt.timeout }] };
      if (opt.matcher) group.matcher = opt.matcher;
      list.push(group);
    }
    if (list.length) settings.hooks[event] = list;
    else delete settings.hooks[event];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');

  if (remove) {
    console.log(`Removed Wingman hooks from ${file}`);
    return;
  }
  console.log(`Added Wingman hooks to ${file}${fs.existsSync(file + '.bak') ? ` (backup: ${file}.bak)` : ''}`);
  console.log('\nIf you haven\'t added the MCP server yet, run:\n');
  console.log(`  claude mcp add --scope user wingman -- node "${cli}"\n`);
  console.log('Then start a new Claude Code session. The page opens at http://localhost:4545 on the first change.');
}

module.exports = { main };
