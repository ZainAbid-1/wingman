# Wingman

A live page that explains what Claude is changing in your code, and why, while it works. Pick how much detail you want, pause Claude, or tell it "not like this" — without waiting for it to finish.

- Works on any project and any language
- No API key, no account, no dependencies (Node 18+)
- Everything stays on your machine (`http://localhost:4545`)

## Install

Wingman is a Claude Code plugin. In Claude Code, run:

```
/plugin install wingman --marketplace ZainAbid-1/wingman
```

On Claude Code older than 2.1.275, add the marketplace first:

```
/plugin marketplace add ZainAbid-1/wingman
/plugin install wingman@wingman
```

Start a new Claude Code session. The page opens at `http://localhost:4545` on the first change, or any time with `/wingman:open`. Needs Node 18 or later on your PATH.

To turn it off: `/plugin disable wingman`. To remove it: `/plugin uninstall wingman`.

### Try it without Claude

From this folder:

```bash
node bin/cli.js demo
```

### Install without the plugin system

For other setups, or to wire it up by hand:

```bash
claude mcp add --scope user wingman -- node /path/to/wingman/bin/cli.js
node /path/to/wingman/bin/cli.js setup
```

`setup` adds the hooks to `~/.claude/settings.json` (a backup is saved next to it). Use `setup --project` for the current project only and `setup --remove` to take them out. Don't use this and the plugin at the same time, or every event is sent twice.

## How it works

```
Claude ── explain_change ("what" + "why") ──► ┐
                                              ├─► hub (localhost:4545) ──► live page
Claude Code hooks ── real diffs, prompts ───► ┘          ▲                    │
                                                         └── pause, feedback ◄┘
```

- **MCP server** (`wingman`): gives Claude five tools — `start_task`, `explain_change`, `mark_step_done`, `ask_user`, `get_feedback` — plus short instructions on when to use them.
- **Hooks** (`wingman hook <Event>`): send real diffs from Edit/Write, your prompts, and commands to the page. In a git repository, files changed by shell commands (scripts, `sed`, and so on) are diffed too. They cost no tokens.
- **Hub**: one small local server per machine. It starts by itself and stops after 3 idle hours. History is kept in `~/.wingman/state.json`.

### What each button does

| On the page | What reaches Claude |
|---|---|
| Pause Claude | The next tool call waits (up to 10 minutes) until you resume. |
| Not like this | Works like a new prompt about that change. It reaches Claude before its next edit or command (which waits until Claude has read it), and Claude's response shows up as its own run. If Claude has already finished, it goes along with your next message. |
| Simpler | Claude rewrites that card's explanation in plainer words. |
| Question cards | Claude waits for your choice. |
| Explain changes as | New explanations are written at that level. |

Claude can't be interrupted in the middle of writing a reply; feedback lands at its next step, usually within seconds. Press Esc in Claude Code to stop it immediately.

### Other MCP clients

Without hooks (Claude Desktop, Cursor and others), you still get explained cards, plans and questions. Diffs, prompt grouping and pause need Claude Code hooks, and feedback arrives only when Claude calls one of the Wingman tools.

## Settings

| Variable | Default | |
|---|---|---|
| `WINGMAN_PORT` | `4545` | Port for the page |
| `WINGMAN_NO_OPEN` | unset | Set to `1` to stop the page opening automatically |

## Cost

Explanations add roughly 150–250 tokens per explained change, plus about 1,000 tokens of tool definitions (usually cached). For a typical 20-edit task that's about 3–5% on top of the session. The page shows an estimate per run.

A "why" question asked after Claude has finished starts a short background Claude request that resumes the conversation, so it uses the same usage as one more message in that session (mostly cached if the session was recent).
