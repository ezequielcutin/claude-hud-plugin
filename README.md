# neon-hud

A live HUD for [Claude Code](https://code.claude.com), drawn above the prompt. It shows what Claude is doing right now: how long the turn has run, which skill it loaded, which subagents are working, what changed in git, and how many tokens [rtk](https://github.com/rtk-ai/rtk) saved you. One click saves a handoff doc of the session.

It's a [mod](https://code.claude.com/docs/en/plugins/mods/overview): it runs inside Claude Code and draws in the terminal and in the Code tab of the Claude desktop app.

```
◴ 1m 04s  23 calls   ◆ brainstorming   ⑂ 2 running  1 done          ⟲ checkpoint   ⎇ main ±3 ↑1   ↯ 12.4k ▂▃▅█ 88%
AGENTS  │ ◴ general-purpose  research hud api                  41s    9 calls          Read
        │    └ ◴ Explore  find types                            12s    3 calls          Grep
SESSION │ up 1h 12m  ·  14 turns  ·  87 tool calls
```

## What it shows

| Segment | Shows | Hover (desktop) |
|---|---|---|
| **Turn** `◴ 15s  3 calls` | Live timer and tool-call count while Claude works; the last turn's numbers once it ends | Tool calls by tool (`Bash ×5 · Read ×3`) |
| **Skill** `◆ brainstorming` | The skill Claude loaded last | Its full name and the skills before it |
| **Agents** `⑂ 2 running  1 done` | Subagents running now, and recently finished | A tree of every agent: type, task, time, calls, current tool |
| **Checkpoint** `⟲ checkpoint` | A button that forks the session into a standalone handoff doc | Where it saved, or why it failed |
| **Git** `⎇ main ±3 ↑1` | Branch, changed files, commits ahead/behind | The changed files |
| **rtk** `↯ 12.4k ▂▃▅█ 88%` | Tokens rtk saved in *this* session, per-turn trend | Top commands by tokens saved, all-time total |

On the desktop app a console row under the chips shows session uptime, turns and tool calls; hover a chip to swap in its detail.

The rtk segment needs [rtk](https://github.com/rtk-ai/rtk) and `sqlite3`. Without them it hides itself and everything else works.

## Install

Requires Claude Code v2.1.287 or later.

```
/plugin marketplace add ezequielcutin/claude-hud-plugin
/plugin install neon-hud@claude-hud-plugin
```

Or from your shell:

```bash
claude plugin marketplace add ezequielcutin/claude-hud-plugin
claude plugin install neon-hud@claude-hud-plugin
```

Run `/reload-plugins` in any session that was already open.

## Commands

- `/hud`: list the segments and which are on
- `/hud turn | skill | agents | git | rtk`: show or hide a segment for this session
- `/hud checkpoint`: save a handoff doc (same as the button)

In the terminal, clicks reach the HUD only in fullscreen mode. Elsewhere, press `ctrl+x` then `tab` to focus it and `c` to checkpoint.

## Checkpoints

A checkpoint forks the current conversation and asks the model for a handoff doc another agent can pick up cold, with Goal, Current state, Decisions, Key files, Next steps and Gotchas sections. It's saved to `~/.claude/checkpoints/<time>-<project>-<session>.md` with a small header (session id, working directory, branch, model). It uses your plan's usage like any other model request.

## Settings

Set these in `/plugin` (or `/plugin configure neon-hud@claude-hud-plugin`):

| Setting | Default | What it does |
|---|---|---|
| `hidden_segments` | *(none)* | Comma-separated segments to hide at start, e.g. `rtk, git` |
| `timezone` | `local` | Checkpoint timestamps: `local`, `utc` or `us-eastern` |
| `checkpoint_dir` | `.claude/checkpoints` | Where checkpoints go, relative to your home directory |
| `rtk_path` | *(auto)* | Path to `rtk` if it isn't in `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `~/.cargo/bin` or `~/.local/bin` |
| `rtk_db` | *(auto)* | Path to rtk's `history.db` if it isn't in rtk's default location |

## What it can access

A mod runs with your permissions, so here is everything this one does (`claude plugin validate plugins/neon-hud` lists the same):

- **Runs** `git status`, `rtk gain`, `sqlite3` read queries on rtk's history database, and `/bin/date`
- **Reads** the `HOME` and `XDG_DATA_HOME` environment variables and checks whether those tools exist
- **Writes** one file per checkpoint, in your checkpoint folder, and nothing else
- **Calls the model** only when you press checkpoint
- **Never** blocks, rewrites or approves a tool call, and makes no network requests of its own

## Develop

```bash
git clone https://github.com/ezequielcutin/claude-hud-plugin
claude --plugin-dir ./claude-hud-plugin/plugins/neon-hud
```

Saving a file reloads the mod in that session. Run the tests and checks with:

```bash
claude plugin test plugins/neon-hud
claude plugin validate .
```

## License

MIT
