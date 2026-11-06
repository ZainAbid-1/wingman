#!/usr/bin/env node
'use strict';

const cmd = process.argv[2];

switch (cmd) {
  case undefined:
  case 'mcp':
    require('../src/mcp').main();
    break;
  case 'hub':
    require('../src/hub').main();
    break;
  case 'hook':
    require('../src/hook').main(process.argv[3]);
    break;
  case 'setup':
    require('../src/setup').main(process.argv.slice(3));
    break;
  case 'demo':
    require('../src/demo').main();
    break;
  case 'open':
    require('../src/shared').ensureHub().then(() => require('../src/shared').openBrowser());
    break;
  case 'help':
  case '--help':
  case '-h':
    console.log(`wingman

  wingman            Run the MCP server (this is what Claude Code starts)
  wingman setup      Add the Wingman hooks to ~/.claude/settings.json
  wingman setup --project   Add them to ./.claude/settings.json instead
  wingman open       Open the live page (http://localhost:${require('../src/shared').PORT})
  wingman demo       Play an example session on the page
  wingman hub        Run the page server in the foreground
`);
    break;
  default:
    console.error(`Unknown command: ${cmd}. Try "wingman help".`);
    process.exit(1);
}
