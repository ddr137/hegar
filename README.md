# Hégar · Herdr Layout

A clean, GPU-accelerated workspace layout for AI-driven development in [Herdr](https://herdr.dev).

![Hégar](preview.png)

## Highlights

- **Unified Left Sidebar**: Merges Spaces, Agents, and Sub-agents into a single collapsible tree hierarchy.
- **New space menu on `+`**: Browse for a folder with the system's folder picker, or start a terminal in the home folder at once. Right-clicking `+` does the second directly.
- **Live AI Quota Widget**: Real-time quota tracking for **Google Antigravity** and **Claude Code** with exact native CLI colors and reset countdowns.
- **Human-in-the-Loop Inbox**: A right-hand panel card matching `Files` and `Changes`. Agents are grouped by project (the same coloured avatar as the sidebar, foldable, with a count per state); each agent shows its last reply (from its session log); an agent that waits on you shows the real question with its choices as buttons (or Approve / Reject for a y/n question), plus a box for a custom answer. Light on the machine: a program runs only when an agent changes state.
- **Files with image preview**: `filesplus` is Herdr's Files panel plus pictures (png, jpg, gif, webp, bmp, ico, svg) drawn in the panel.
- **AI commit messages**: `changesplus` is Herdr's Changes panel plus a ✦ button that writes the commit message with Google Gemini. Press the key icon in its header, paste a Gemini API key (and optionally a model name), then press ✦. The diff is sent to Google; the key is kept in the mod's local storage on this machine.
- **Toolkit (skills & MCP)**: `toolkit` is a fourth tab in the right panel. One shelf in Herdr's folder holds your skills (`~/.config/herdr-app/toolkit/skills/<name>/SKILL.md`) and MCP servers (`~/.config/herdr-app/toolkit/mcp.json`). Tick what a project should carry, then press **Apply**: nothing changes before that. A skill becomes a symlink in `.opencode/skills` (`.claude/skills` and `.agents/skills` follow); an MCP server is written to `.mcp.json`, `.opencode/opencode.json` and `.agents/plugins/workspace-mcp`, so Claude Code, OpenCode and Antigravity all see it. **Find** searches [skills.sh](https://skills.sh) and the [official MCP registry](https://registry.modelcontextprotocol.io); **Add** puts a result on the shelf (turning it on is the separate Apply step). The trash icon on a shelf row **deletes** it for good, only after a confirmation that names what will happen: the skill folder or server entry is erased from the shelf and turned off in every project Toolkit has turned it on in (a project's own skills and servers are never touched). Turning off and deleting are different buttons: a tick turns an item off for one project, the trash removes it from the shelf.
- **Drag-and-Drop**: Space reordering drawn like the default list: a dimmed row and a line where it lands.

## Installation

To add this layout to your local Herdr setup:

1. Copy `layouts/hegar.json` into `~/.config/herdr-app/layouts/`
2. Copy the mods from `mods/` into `~/.config/herdr-app/mods/`:
   - `mods/sidebar`
   - `mods/spacemenu`
   - `mods/tabbar`
   - `mods/paneheader`
   - `mods/statusbar`
   - `mods/inbox`
   - `mods/aiusage`
   - `mods/filesplus`
   - `mods/changesplus`
   - `mods/toolkit`
3. Switch to Hégar in Herdr Settings or run:
   ```bash
   herdr-app switch hegar
   ```

## Recipe

See [RECIPE.md](RECIPE.md) for the complete design brief and technical specification.
