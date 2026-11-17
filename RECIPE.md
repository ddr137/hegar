# Hégar

A clean, GPU-accelerated workspace layout for AI-driven development in Herdr, featuring a unified left sidebar that brings together spaces, agents, and sub-agents into a single tree hierarchy with custom emoji branding, native folder browsing on space creation, real-time agent-aware AI quota bars (with exact TUI colors for Antigravity and Claude Code), an interactive Human-in-the-Loop Inbox card panel next to Files and Changes for one-click approvals and question replies, and animated drag-and-drop space reordering.

![Hégar](preview.png)

## What you see

The window is divided into a dedicated left workspace sidebar and a flexible center work area with an optional right panel stack:

1. **Left Sidebar (`sidebar`, width 280px, resizable 180–520px, chrome background):**
   - **Top Brand Block (`brand`, height 46px):** Window drag handle, macOS traffic lights padding (76px), Herdr icon and title, command palette search button, and sidebar collapse toggle.
   - **Unified Workspace (`hegar-main`, flex 1):**
     - **Spaces Header:** Displays clean `Spaces` label with space count badge `(N)` on the left, and a `+` button on the right to browse/create a folder for new spaces.
     - **Space Cards:** Card header with folder fold/unfold chevron, custom emoji avatar or colored initial letter, active space indicator (`raised` background and border), space title, git branch indicator, and status badge (`!` red indicator for blocked, spinning blue icon for working, agent count badge).
     - **Nested Agents:** Indented rows (22px) displaying program icon (Antigravity, Claude Code, OpenCode), live title, and status badge (`Needs you`, `Working`, `Done`, `Idle`).
     - **Sub-agents:** Indented rows (28px) connected via ASCII tree markers (`├─`, `└─`, `│`), live title, and status badge.
     - **Inline Icon Picker:** Clickable from the space avatar, revealing a 24-preset emoji grid (`🚀`, `⚡`, `💻`, `🔥`, `📦`, `🌐`, `🤖`, `☕`, `🦊`, `🐘`, `🎯`, `🛠️`, `✨`, `🌟`, `💎`, `🎨`, `🧠`, `🧪`, `📊`, `📁`, `💡`, `🔧`, `❤️`, `🕹️`) and a "Reset to Default Letter" action.
     - **Live AI Quota Widget:** Located directly above the footer divider, displaying agent selector chips (`[Auto] [Antigravity] [Claude]`), a refresh spinner, and exact live quota bars matching native CLI screens:
       - *Antigravity Mode:* Displays Account email in cyan (`#5fa8eb`), Gemini Models (Gemini 3.8 Flash) with Weekly Limit Remaining (`77.7%`, mint green `#7cdba0`, dark track `#222d3b`) and Five Hour Limit Remaining (`91.1%`, mint green `#7cdba0`), countdown timers (`Refreshes in 119h 5m`, `Refreshes in 3h 30m`), and Claude/GPT Models with 100% available bars.
       - *Claude Code Mode:* Displays Current session (`0% used`, lavender `#8b8fe8`, dark track `#25263a`), Current week all models (`86% used`, lavender `#8b8fe8`, reset time `Nov 19 at 1pm`), and top MCP servers breakdown (`figcraft 49%`, `claude-in-chrome 7%`).
   - **Footer Block (`sidebar-footer`, height 69px):** Settings button (with app update indicator dot) and Add Machine button.

2. **Work Area (`work`, flex 1):**
   - **Tab Bar (`tabs`, height 42px, chrome background):**
     - Sidebar restore button (visible only when sidebar is hidden).
     - Horizontally scrollable agent tabs with active highlight, program icons, status indicators, double-click rename, close button.
     - `+` New Tab button.
     - Right-side Panel Buttons: `[Inbox (N)]` `[Files]` `[Changes]` with active toggle highlight and pending notification counter badge.
   - **Work Body (`work-body`, row, padding 8px, gap 8px):**
     - **Main Terminal (`main`, flex 1):** Active pane terminal block with 10px rounded corners, canvas background, border, focus ring, and pane header (split right, split down, zoom, close).
     - **Right Panel (`panel`, width 368px, resizable 280–900px, hidden by default):**
       - Stack (`panel-body`) housing `inbox`, `files`, and `changes`.
       - All three panels share the identical outer card frame: `rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)` and height 42px header.
       - **Inbox Panel (`inbox`):**
         - Header with Inbox icon, count badge of blocked agents, refresh button.
         - Filter bar: `[Needs you]` `[Working]` `[Done]` `[Idle]` `[All]`.
         - Agent cards with live terminal output / question explanation box (`hc read`), quick 1-click `✓ Approve (Yes)`, `✕ Reject (No)`, interactive inline reply text input with `Send ↵` button, and `Open Terminal →` focus button.
   - **Status Bar (`status`, height 28px):** Displays workspace connection status and notifications.

## How it behaves

- **Agent Status Lifecycle:**
  - `blocked` (Needs you): Displayed with red theme color (`#ef4444`), bold "Needs you" badge in sidebar and tab bar, red notification pill counter on the `Inbox` button in the tab bar and header. In Inbox, presents the exact output question snippet and provides 1-click `✓ Approve (Yes)` (sends `y\n`), `✕ Reject (No)` (sends `n\n`), and direct text input with `Send ↵`.
  - `working`: Displayed with blue theme color (`#3b82f6`), rotating 900ms spinner icon, "Working" badge. In Inbox, shows active processing indicator and `Stop` button (`hc interrupt`).
  - `done`: Displayed with green theme color (`#22c55e`), "Done" badge. In Inbox, shows completion confirmation.
  - `idle`: Displayed with muted gray border dot. In Inbox, provides prompt dispatch box.

- **Interactions & Clicks:**
  - Clicking a space selects it (`space.select`), switching the visible tabs and active terminal.
  - Clicking the chevron folds/unfolds space agents or agent sub-trees.
  - Clicking a space avatar opens the 24-preset emoji icon picker; clicking an emoji sets `shared("space.icons")[spaceId]`.
  - Right-clicking a space opens the space context menu (Rename, Worktree, Close).
  - Left-clicking `+` in the Spaces header opens native macOS Cocoa Open Folder dialog (with built-in "New Folder" creation); right-clicking `+` creates a default quick space.
  - Dragging a space initiates animated reordering with `shadow_2xl`, elevated card styling, and blue insertion indicator line. Dropping triggers `space.move`.
  - Clicking an agent or sub-agent focuses its pane (`pane.focus`) or summons it (`terminal.summon`).
  - Clicking `[Inbox]`, `[Files]`, or `[Changes]` in the tab bar toggles the right panel stack; clicking an active button closes the panel.
  - Clicking `sidebar-toggle` (or pressing `Cmd+B`) hides the sidebar cleanly; when hidden, an unhide button appears in the tab bar.
  - In AI Quota widget, clicking `[Auto]`, `[Antigravity]`, or `[Claude]` switches the live meter; clicking the refresh spinner re-runs the CLI background checks.

## Built from

- **Layout Structure (`layouts/hegar.json`):**
  - Root: row divider, background `canvas`, traffic lights `[12, 16]`.
  - Left: `sidebar` column (blocks: `brand`, `hegar-main`, `sidebar-footer`).
  - Center/Right: `work` column (blocks: `tabs`, `work-body` row containing `main` pane and `panel` stack, `status`).

- **Shipped Mods Used:**
  - `workspace-chrome`, `workspace-status`, `files`, `changes`, `pane`, `menu`, `picker`, `new-menu`.

- **Custom Mods Included:**
  - `mods/hegar/`: Unified Spaces, Agents, and Sub-agents sidebar with live dual-agent AI quota and emoji icon picker.
  - `mods/inbox/`: Human-in-the-loop approval, question handling, explanation snippet viewer, and interactive terminal dispatch.
  - `mods/tabs/`: Tab bar customized with unhide restore button and tri-panel toggles (`inbox`, `files`, `changes`).
  - `mods/ai-usage/`: Standalone floating dashboard modal for comprehensive AI quota breakdown.

- **Herdr APIs & Commands:**
  - State & Info: `spaces()`, `agents()`, `terminals()`, `panes()`, `focused()`, `theme()`, `shared()`, `setShared()`, `layout()`, `window()`, `settings()`.
  - Control Commands: `space.new`, `space.select`, `space.move`, `space.close`, `space.rename`, `pane.focus`, `terminal.summon`, `tab.select`, `tab.new`, `tab.close`, `tab.rename`, `tab.move`, `layout.toggle`, `layout.show`, `layout.hide`, `layout.select`, `layout.switch`.
  - System Execution: `exec()`, `hc()`, `pickFolder()`, `openOverlay()`, `closeOverlay()`.

- **External CLI Integrations:**
  - `agy -p "/quota" --output-format json`: Fetches Antigravity Gemini and Claude/GPT quota buckets, percentages, and ISO reset timestamps.
  - `claude -p "/usage" --output-format json`: Fetches Claude Code session and weekly usage percentages, reset times, and MCP breakdown.
  - `hc read <address>`: Reads live terminal screen and prompt history for human-in-the-loop explanations.
  - `hc keys <address> <keys...>`: Sends interactive approvals (`y enter`) and rejections (`n enter`).
  - `hc send <address> <text>`: Delivers text answers directly into the agent's running session.
  - `hc interrupt <address>`: Gracefully stops running tasks.
