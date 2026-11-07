---
description: Open the Wingman live page (in the Claude app's browser when available)
allowed-tools: Bash(node:*), mcp__Claude_Browser__preview_start, mcp__Claude_Browser__navigate
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/cli.js" open --no-browser`

Open the Wingman page now:
- If you have the Claude app's built-in browser tool (Claude_Browser `preview_start` with a `url`), open the address printed above (http://localhost:4545 by default) with it.
- Otherwise, run `node "${CLAUDE_PLUGIN_ROOT}/bin/cli.js" open` to open it in the user's regular browser.

Then tell the user in one short sentence where it opened, and nothing else.
