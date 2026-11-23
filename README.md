# Hégar · Herdr Layout

A clean workspace layout for AI-driven development in [Herdr](https://herdr.dev). It puts spaces, agents and sub-agents in one sidebar tree, adds an inbox for agents that wait on you, shows live AI quotas in the status bar, and adds a Toolkit panel to manage skills, subagents, MCP servers, plugins and hooks for Claude Code, OpenCode and Antigravity.

![Hégar](preview.png)

## Contents

| Mod | Where | What it does |
| --- | --- | --- |
| `sidebar` | Left column | Spaces, agents and sub-agents in one foldable tree; drag to reorder spaces |
| `spacemenu` | Popup from the sidebar's `+` | **Browse folder…** or **New terminal in home** |
| `tabbar` | Top bar | Tabs, sidebar restore button, and the panel buttons: Inbox · Files · Changes · Toolkit |
| `paneheader` | Above each pane | Status, plus split right / split down / zoom / close on hover |
| `statusbar` | Bottom bar | Claude Code and Antigravity quota bars with reset countdowns |
| `aiusage` | Popup from the status bar | Full quota breakdown per model group |
| `inbox` | Right panel | Human-in-the-loop inbox: answer agent questions in one click |
| `filesplus` | Right panel | Herdr's Files panel plus image preview, Markdown, editing, new / rename / delete |
| `changesplus` | Right panel | Herdr's Changes panel plus AI commit messages (Google Gemini) |
| `toolkit` | Right panel | Skills · Agents · MCP · Plugins · Hooks for all three agents |

The layout itself is `layouts/hegar.json`. It also uses Herdr's shipped `workspace-chrome` (brand block, footer, icons), `menu` and `new-menu`.

## Features

### Sidebar and spaces

- One tree: spaces → agents → sub-agents, with program icons (Claude Code, OpenCode, Antigravity), live titles and status badges (`Needs you`, `Working`, `Done`, `Idle`).
- The `+` button opens a small menu: pick a folder with the system folder picker, or start a terminal in `~` at once. Right-click `+` for the second directly.
- Drag a space to reorder it: the row dims and a line shows where it lands.
- `agent.next` / `agent.prev` follow the order drawn in the sidebar.

### Inbox

- Agents grouped by project (same coloured avatar as the sidebar), foldable, with a count per state; the most urgent project comes first.
- Each agent shows its last reply, read from its session log (Claude Code, Antigravity).
- An agent waiting on you shows the real question read from its screen, with its numbered choices as buttons (or Approve / Reject for a y/n question), a box for a custom answer, Stop and Open Terminal.
- Light on the machine: it only reads again when an agent changes state.

### AI quota

- The status bar shows Claude Code and Antigravity limits (session / 5-hour and weekly) with live countdowns, in the theme's own colours.
- Click it for the `aiusage` popup with every model group, sized so it never scrolls.
- `claude` and `agy` are read every 3 minutes while the window is shown, shortly after an agent finishes a turn (at most once a minute), and on Refresh. The reads use no model tokens.

### Files+ (`filesplus`)

- **Images** (png, jpg, gif, webp, bmp, ico, svg) drawn in the panel with Figma-style zoom.
- **Markdown** opens rendered, with a Preview | Edit switch.
- **Edit and save text files** (Save button or `Cmd+S`). Unsaved changes are marked and kept when you switch folders; leaving asks first. If the file changed on disk, Save refuses to overwrite and lets you reload or overwrite.
- **New file, new folder, rename** from the header or any row. Nothing is ever overwritten.
- **Delete** moves to the Trash after a confirmation (with the item count for a folder). Where there is no Trash, a second question offers "Delete permanently".
- View-only (with the reason shown) for read-only, binary, non-UTF-8, very large files, and remote or Windows folders.

### Changes+ (`changesplus`)

- A ✦ button writes the commit message with Google Gemini.
- Press the key icon in the header, paste a Gemini API key (optionally a model name), then press ✦.
- Only when you press ✦, the diff (up to 30,000 characters) is sent to Google. The key stays in the mod's local storage on this machine.

### Toolkit (`toolkit`)

A fourth tab in the right panel with five lists: **Skills · Agents · MCP · Plugins · Hooks**.

- **One shelf, three agents.** Your skills, subagents and MCP servers live in `~/.config/herdr-app/toolkit/`. Pick the agents with the chips (Claude, OpenCode, Antigravity), tick what a project should carry, then press **Apply**. Nothing changes before Apply.
- **Each agent gets what it reads, in its own place:**

  | | Claude Code | OpenCode | Antigravity |
  | --- | --- | --- | --- |
  | Skills | `.claude/skills/<name>` (link) | `.opencode/skills/<name>` (link) | `.agents/skills/<name>` (copy, kept in sync) |
  | Agents | `.claude/agents/<name>.md` | `.opencode/agents/<name>.md` | `.agents/agents/<name>.md` |
  | MCP | `.mcp.json` | `.opencode/opencode.json` | `.agents/plugins/workspace-mcp/` |

  "Claude only" really means Claude only: a skill hidden from OpenCode gets a `deny` in its `permission.skill`.
- **Agents (subagents):** New, edit, or Import from a project's own agent file. A `tools` limit is translated for each agent and never widened; anything that cannot be carried is listed on the row.
- **Plugins:** read from `claude plugin list`, `agy plugin list` and OpenCode's config; enable, disable or uninstall after a confirmation that names the exact command.
- **Hooks:** Claude's project and local hooks can be added and removed; everything else is shown read-only.
- **Find:** search [skills.sh](https://skills.sh), the [official MCP registry](https://registry.modelcontextprotocol.io), the [aitmpl.com](https://www.aitmpl.com) catalog (agents and hooks, pinned to one commit, with its security scan; `DO_NOT_INSTALL` entries cannot be added), Claude marketplaces and npm (`opencode-plugin`). Agents open a Review screen showing exactly what will be written.
- **Updates:** items added from Find remember their source. **Check** (or once a day) shows an **Update** button where something newer exists; items you edited locally are skipped by **Update all**.
- **Safe writes:** every project file Toolkit changes is first backed up to `~/.config/herdr-app/toolkit/backups/` (newest 60 kept) and written atomically. A project's own files with the same name are never overwritten.
- **Herdr's own manuals** (`herdr-core`, `herdr-window`) are seeded on the shelf from the installed Herdr, but not turned on anywhere until you choose.
- After Apply, Toolkit offers to add the links it made to the project's `.gitignore`.

> A shelf item runs code on your machine once it is turned on and an agent starts. Read it before turning it on.

## Requirements

- [Herdr](https://herdr.dev) (macOS or Linux)
- Optional, depending on what you use:
  - `claude` (Claude Code) and/or `agy` (Antigravity) for quotas, plugins and session logs
  - `opencode` for OpenCode plugins
  - `git` for Changes+, Toolkit's skill install and update checks
  - A Google Gemini API key for AI commit messages

## Installation

```bash
git clone https://github.com/ddr137/hegar.git && cd hegar

mkdir -p ~/.config/herdr-app/layouts ~/.config/herdr-app/mods
cp layouts/hegar.json ~/.config/herdr-app/layouts/
cp -R mods/* ~/.config/herdr-app/mods/

herdr-app switch hegar
```

Or pick **Hégar** in Herdr Settings. To check the install:

```bash
for m in sidebar spacemenu tabbar paneheader statusbar inbox aiusage filesplus changesplus toolkit; do
  herdr-app check "$m"
done
herdr-app status
```

## Network and privacy

| Mod | What leaves the machine | When |
| --- | --- | --- |
| `statusbar` | `claude` / `agy` CLIs contact their own services | Every 3 min while shown, after a turn, on Refresh |
| `changesplus` | The diff, to Google Gemini | Only when ✦ is pressed |
| `toolkit` | Searches to skills.sh, MCP registry, aitmpl.com, npm; `git clone` from GitHub | Only on Find, Add, Check, or the daily update check |

No other mod uses the network. Full details of every program the mods run and every file they read are in [RECIPE.md](RECIPE.md#built-from).

## Development notes

- Do not edit Herdr's shipped mods (`tabs`, `pane`, `spaces`, …): Herdr restores them and renames an edited one to `<name>-edited`. The mods here use their own single-word names.
- `init()` runs during `herdr-app check`; mods that start timers or programs return early on `checking()`.
- Never poll Herdr's live data: react in `render()`. Animate with `.spin()`, not timers. Take colours from `theme()`.
- Herdr's JavaScript has no `TextEncoder`, `TextDecoder` or `structuredClone`.

See [RECIPE.md](RECIPE.md) for the complete design brief and technical specification.
