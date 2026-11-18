// Hégar: Unified Sidebar for Spaces, Agents, and Sub-agents
// Supports:
// 1. Browse/Create folder on New Space (+) with native folder picker
// 2. Custom Logo / Emoji per Space with built-in interactive icon picker
// 3. Multi-agent live AI Quota:
//    - Antigravity: Live Models & Quota via `agy -p "/quota" --output-format json`
//      (Gemini Weekly & 5h limits in mint green #7cdba0, Claude/GPT limits, reset timers)
//    - Claude Code: Live /usage via `claude -p "/usage" --output-format json`
//      (Session %, Weekly % in lavender #8b8fe8, MCP breakdown, reset timers)
//    - Colors and bars exactly match native CLI screens; all bars shown directly without less/detail.
// 4. Clean and elegant Spaces header without cluttered badges
// 5. Smooth animated drag-and-drop rearrange with lift & shadow effects

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  spaces,
  agents,
  terminals,
  panes,
  focused,
  run,
  openOverlay,
  theme,
  shared,
  setShared,
  window,
  layout,
  exec,
  pickFolder,
} from "herdr";

const MARK = {
  ansi6: "#22a99a",
  ansi3: "#e3814f",
  ansi4: "#5b8def",
  ansi5: "#8b7cf6",
  ansi2: "#3fae6a",
  ansi1: "#d9649a",
};

const PRESET_ICONS = [
  "🚀", "⚡", "💻", "🔥", "📦", "🌐", "🤖", "☕",
  "🦊", "🐘", "🎯", "🛠️", "✨", "🌟", "💎", "🎨",
  "🧠", "🧪", "📊", "📁", "💡", "🔧", "❤️", "🕹️",
];

function toggleSidebar() {
  run("layout.toggle", { id: "sidebar" });
}

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint
    ? svg(p.icon).size(size).flex_none().text_color(color)
    : image(p.icon).w(size).h(size).flex_none();
}

const clean = (s) =>
  (s ?? "")
    .replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "")
    .replace(/^\[ [!.] \] /, "")
    .trim();

function getSubAgentTree(allTerminals, parentAddress, lead = []) {
  const kids = allTerminals.filter((k) => k.parent === parentAddress && k.state === "live");
  return kids.flatMap((k, i) => {
    const last = i === kids.length - 1;
    return [
      { t: k, lines: [...lead, last ? "└" : "├"] },
      ...getSubAgentTree(allTerminals, k.address, [...lead, last ? "" : "│"]),
    ];
  });
}

const kidStatus = (k, listedMap) => {
  const s = listedMap.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};

function formatResetTime(isoStr) {
  if (!isoStr) return "Quota available";
  const diffMs = new Date(isoStr).getTime() - Date.now();
  if (diffMs <= 0) return "Refreshing soon";
  const totalHours = Math.floor(diffMs / (1000 * 60 * 60));
  const mins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  if (totalHours > 48) {
    const days = Math.floor(totalHours / 24);
    const remHours = totalHours % 24;
    return `Refreshes in ${days}d ${remHours}h`;
  }
  if (totalHours > 0) return `Refreshes in ${totalHours}h ${mins}m`;
  return `Refreshes in ${mins}m`;
}

export default class HegarUnifiedSidebar extends View {
  init(_props, cx) {
    this.foldedSpaces = new Set();
    this.foldedAgents = new Set();
    this.pressed = null;
    this.over = null;
    this.iconPickerSpaceId = null;
    cx.timer.every(1000, (cx) => cx.notify());
  }

  async createSpaceWithBrowse(cx) {
    try {
      let chosen = null;
      try {
        if (typeof pickFolder === "function") {
          chosen = await pickFolder({ prompt: "Select or Create Space Folder" });
        }
      } catch {
        chosen = null;
      }

      if (!chosen) {
        // Native macOS Cocoa Open Dialog with "New Folder" support via AppleScript
        const res = await exec("osascript", [
          "-e",
          'POSIX path of (choose folder with prompt "Select or create folder for new Space:")',
        ]);
        if (res.code === 0 && res.stdout.trim()) {
          chosen = res.stdout.trim();
        }
      }

      if (chosen) {
        const name = chosen.replace(/\/+$/, "").split("/").pop() || "Space";
        run("space.new", { folder: chosen, name });
      }
    } catch {
      // User canceled dialog
    }
    if (cx) cx.notify();
  }

  toggleIconPicker(spaceId, cx) {
    this.iconPickerSpaceId = this.iconPickerSpaceId === spaceId ? null : spaceId;
    if (cx) cx.notify();
  }

  setSpaceIcon(spaceId, icon, cx) {
    const cur = shared("space.icons") ?? {};
    setShared("space.icons", { ...cur, [spaceId]: icon });
    this.iconPickerSpaceId = null;
    if (cx) cx.notify();
  }

  clearSpaceIcon(spaceId, cx) {
    const cur = { ...(shared("space.icons") ?? {}) };
    delete cur[spaceId];
    setShared("space.icons", cur);
    this.iconPickerSpaceId = null;
    if (cx) cx.notify();
  }

  statusBadge(t, status) {
    if (status === "working") {
      return svg("mods/workspace-chrome/spinner.svg")
        .size(12)
        .mx(2)
        .flex_none()
        .text_color(t.working)
        .spin(900);
    }
    if (status === "blocked") {
      return div()
        .flex_none()
        .px(6)
        .h(18)
        .rounded(5)
        .bg((t.blocked ?? "#ef4444") + "26")
        .text_size(10.5)
        .font_semibold()
        .text_color(t.blocked ?? "#ef4444")
        .flex()
        .items_center()
        .child("Needs you");
    }
    if (status === "done") {
      return div()
        .size(7)
        .mx(3)
        .flex_none()
        .rounded(4)
        .bg(t.done ?? t.ansi2 ?? "#22c55e");
    }
    return div()
      .size(7)
      .mx(3)
      .flex_none()
      .rounded(4)
      .border(1.5)
      .border_color(t.idle ?? t.dim ?? "#888");
  }

  openSpaceMenu(spaceId) {
    openOverlay({
      mod: "menu",
      kind: "popup",
      width: 200,
      height: 260,
      props: { tab: "space", target: { id: spaceId } },
    });
  }

  openPaneMenu(paneId, terminalAddr) {
    openOverlay({
      mod: "menu",
      kind: "popup",
      width: 200,
      height: 260,
      props: { tab: "pane", target: { pane: paneId, terminal: terminalAddr } },
    });
  }

  renderTreeGlyph(l, t, rowH = 28, gap = 2) {
    const lineColor = t.input ?? t.border ?? "#3a3a44";
    const cell = div().w(20).h(rowH).relative().flex_none();
    if (!l) return cell;

    const halfH = Math.round(rowH / 2);
    const isBranch = l === "└" || l === "├";
    const hasBottom = l === "│" || l === "├";

    if (l === "│") {
      return cell.child(
        div()
          .absolute()
          .top(-gap)
          .bottom(0)
          .left(8)
          .w(1)
          .border_l(1.5)
          .border_color(lineColor),
      );
    }

    if (isBranch) {
      cell.child(
        div()
          .absolute()
          .top(-gap)
          .left(8)
          .w(12)
          .h(halfH + gap)
          .border_l(1.5)
          .border_b(1.5)
          .rounded_bl(4)
          .border_color(lineColor),
      );
    }

    if (hasBottom) {
      cell.child(
        div()
          .absolute()
          .top(halfH)
          .bottom(0)
          .left(8)
          .w(1)
          .border_l(1.5)
          .border_color(lineColor),
      );
    }

    return cell;
  }

  renderSubRow(t, item, shownAddress, listedMap) {
    const k = item.t;
    const st = kidStatus(k, listedMap);
    const pic = icon(k.program, 14, t.foreground);
    const isFocused = k.address === shownAddress;

    return h_flex()
      .id(`sub-${k.address}`)
      .pl(8)
      .pr(8)
      .h(26)
      .gap(0)
      .items_center()
      .rounded(6)
      .hover((el) => el.bg(t.hover))
      .cursor_pointer()
      .on_click(() => {
        if (listedMap.has(k.address)) {
          run("pane.focus", { terminal: k.address });
        } else {
          run("terminal.summon", { terminal: k.address });
        }
      })
      .on_mouse_down("right", () => this.openPaneMenu(k.pane, k.address))
      .children(item.lines.map((l) => this.renderTreeGlyph(l, t, 26, 2)))
      .child(div().w(4).flex_none())
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().w(6).flex_none())
      .child(
        div()
          .flex_1()
          .truncate()
          .text_size(12)
          .text_color(isFocused ? t.foreground : t.muted)
          .child(clean(k.title) || k.program?.name || "Sub-agent"),
      )
      .child(this.statusBadge(t, st));
  }

  renderAgentRow(t, a, agentIndex, totalAgents, allTerminals, shownAddress, listedMap, cx) {
    const isFolded = this.foldedAgents.has(a.address);
    const pic = icon(a.program, 16, t.foreground);
    const isLastAgent = agentIndex === totalAgents - 1;
    const subs = getSubAgentTree(allTerminals, a.address, [isLastAgent ? "" : "│"]);
    const hasSubs = subs.length > 0;
    const isFocused = a.address === shownAddress;

    const foldBtn = div()
      .id(`ag-fold-${a.address}`)
      .h(18)
      .px(3)
      .gap(2)
      .flex()
      .items_center()
      .rounded(4)
      .text_size(10.5)
      .text_color(t.dim)
      .cursor_pointer()
      .hover((el) => el.bg(t.hover).text_color(t.foreground))
      .on_click((e, cx) => {
        cx.stop_propagation();
        if (isFolded) {
          this.foldedAgents.delete(a.address);
        } else {
          this.foldedAgents.add(a.address);
        }
        cx.notify();
      })
      .child(
        svg(`mods/workspace-chrome/chevron-${isFolded ? "right" : "down"}.svg`)
          .size(10)
          .text_color(t.dim),
      )
      .when(isFolded, (el) => el.child(String(subs.length)));

    const row = h_flex()
      .id(`agent-${a.address}`)
      .pl(8)
      .pr(8)
      .h(28)
      .gap(0)
      .items_center()
      .rounded(6)
      .hover((el) => el.bg(t.hover))
      .cursor_pointer()
      .on_click(() => run("pane.focus", { terminal: a.address }))
      .on_mouse_down("right", () => this.openPaneMenu(a.pane, a.address))
      .child(this.renderTreeGlyph(isLastAgent ? "└" : "├", t, 28, 2))
      .child(div().w(4).flex_none())
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().w(6).flex_none())
      .child(
        div()
          .flex_1()
          .truncate()
          .text_size(12.5)
          .font_medium()
          .text_color(isFocused ? t.foreground : t.muted)
          .child(clean(a.title) || a.program?.name || "Agent"),
      )
      .when(hasSubs, (el) => el.child(foldBtn))
      .child(this.statusBadge(t, a.status));

    if (isFolded || !hasSubs) {
      return [row];
    }

    return [
      row,
      ...subs.map((item) => this.renderSubRow(t, item, shownAddress, listedMap)),
    ];
  }

  renderIconPicker(t, s, cx) {
    return v_flex()
      .p(8)
      .gap(6)
      .rounded(8)
      .bg(t.surface ?? "#1e1e24")
      .border(1)
      .border_color(t.accent ?? "#3b82f6")
      .shadow_xl()
      // Header
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .child(
            div()
              .text_size(11)
              .font_bold()
              .text_color(t.foreground)
              .child("Choose Space Logo / Icon"),
          )
          .child(
            div()
              .size(18)
              .flex()
              .items_center()
              .justify_center()
              .rounded(4)
              .text_color(t.dim)
              .hover((el) => el.bg(t.hover).text_color(t.foreground))
              .cursor_pointer()
              .on_click((_e, cx) => this.toggleIconPicker(s.id, cx))
              .child(svg("mods/pane/close.svg").size(10)),
          ),
      )
      // Preset emoji grid
      .child(
        h_flex()
          .flex_wrap()
          .gap(4)
          .children(
            PRESET_ICONS.map((emoji) =>
              div()
                .size(24)
                .flex()
                .items_center()
                .justify_center()
                .rounded(5)
                .bg(t.raised ?? "#26262e")
                .hover((el) => el.bg(t.hover).border(1).border_color(t.accent))
                .cursor_pointer()
                .text_size(13)
                .on_click((_e, cx) => this.setSpaceIcon(s.id, emoji, cx))
                .child(emoji),
            ),
          ),
      )
      // Reset button
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .pt(4)
          .border_t(1)
          .border_color(t.border)
          .child(
            div()
              .px(6)
              .h(22)
              .rounded(4)
              .bg(t.hover ?? "#333")
              .hover((el) => el.bg(t.surface))
              .cursor_pointer()
              .text_size(10.5)
              .font_medium()
              .text_color(t.muted)
              .on_click((_e, cx) => this.clearSpaceIcon(s.id, cx))
              .child("Reset to Default Letter"),
          )
          .child(
            div()
              .text_size(9.5)
              .text_color(t.dim)
              .child("Click avatar to change"),
          ),
      );
  }

  renderSpaceCard(t, s, spaceIndex, spaceAgents, allTerminals, shownAddress, listedMap, allSpaces, cx) {
    const isFolded = this.foldedSpaces.has(s.id);
    const colorKey = shared("space.colors")?.[s.id] ?? "ansi4";
    const avatarFill = colorKey.startsWith("#") ? colorKey : (MARK[colorKey] ?? t[colorKey] ?? "#5b8def");
    const initial = ([...s.name][0] ?? "?").toUpperCase();
    const customIcon = shared("space.icons")?.[s.id];

    const fromIndex = allSpaces.findIndex((x) => x.id === this.pressed);
    const isDragged = this.pressed === s.id;
    const isOver = this.pressed !== null && this.over === s.id && this.pressed !== s.id;

    const hasBlocked = spaceAgents.some((a) => a.status === "blocked");
    const hasWorking = spaceAgents.some((a) => a.status === "working");

    const header = v_flex()
      .relative()
      .id(`space-${s.id}`)
      .px(8)
      .h(30)
      .justify_center()
      .rounded(8)
      .when(s.active && !isDragged, (el) => el.bg(t.selected))
      .when(!s.active && !isDragged && !isOver, (el) => el.hover((el) => el.bg(t.hover)))
      .when(isDragged, (el) =>
        el
          .bg(t.raised ?? "#252528")
          .border(1.5)
          .border_color(t.accent ?? "#3b82f6")
          .shadow_2xl()
          .opacity(0.88),
      )
      .when(isOver, (el) =>
        el
          .bg(t.hover ?? "#1e1e22")
          .border(1)
          .border_color((t.accent ?? "#3b82f6") + "66"),
      )
      .when(isOver, (el) =>
        el.child(
          div()
            .absolute()
            .left(4)
            .right(4)
            .h(3)
            .rounded_full()
            .bg(t.accent ?? "#3b82f6")
            .shadow_lg()
            .when(fromIndex < spaceIndex, (line) => line.bottom(-1))
            .when(fromIndex > spaceIndex, (line) => line.top(-1)),
        ),
      )
      .when(isDragged, (el) => el.cursor_grabbing())
      .when(!isDragged, (el) => el.cursor_grab())
      .on_mouse_down("left", () => {
        this.pressed = s.id;
        this.over = s.id;
      })
      .on_mouse_move((_e, cx) => {
        const source = allSpaces.find((x) => x.id === this.pressed);
        const over = source && (source.machine ?? null) === (s.machine ?? null) ? s.id : null;
        if (this.pressed !== null && this.over !== over) {
          this.over = over;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        const over = this.over;
        this.pressed = null;
        this.over = null;
        if (from !== null && over === s.id && from !== s.id) {
          const index = allSpaces.findIndex((x) => x.id === s.id);
          if (index !== -1) run("space.move", { id: from, index: index + 1 });
        } else if (from === s.id) {
          run("space.select", { id: s.id });
        }
        cx.notify();
      })
      .on_mouse_down("right", () => this.openSpaceMenu(s.id))
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(
            div()
              .size(16)
              .flex_none()
              .flex()
              .items_center()
              .justify_center()
              .cursor_pointer()
              .on_click((e, cx) => {
                cx.stop_propagation();
                if (isFolded) {
                  this.foldedSpaces.delete(s.id);
                } else {
                  this.foldedSpaces.add(s.id);
                }
                cx.notify();
              })
              .child(
                svg(`mods/workspace-chrome/chevron-${isFolded ? "right" : "down"}.svg`)
                  .size(11)
                  .text_color(s.active ? t.foreground : t.dim),
              ),
          )
          // Space Avatar / Custom Logo
          .child(
            h_flex()
              .size(18)
              .flex_none()
              .rounded(5)
              .bg(avatarFill)
              .items_center()
              .justify_center()
              .text_size(customIcon ? 11 : 10.5)
              .font_bold()
              .text_color("#ffffff")
              .cursor_pointer()
              .hover((el) => el.opacity(0.85))
              .tooltip("Click to change space logo / icon")
              .on_click((e, cx) => {
                cx.stop_propagation();
                this.toggleIconPicker(s.id, cx);
              })
              .child(customIcon ? customIcon : initial),
          )
          .child(
            h_flex()
              .flex_1()
              .gap(6)
              .items_center()
              .truncate()
              .child(
                div()
                  .font_semibold()
                  .text_size(13)
                  .text_color(s.active ? t.foreground : t.muted)
                  .truncate()
                  .child(s.name),
              )
              .when(Boolean(s.branch), (el) =>
                el.child(
                  h_flex()
                    .gap(3)
                    .items_center()
                    .child(svg("mods/workspace-chrome/branch.svg").size(11).text_color(t.dim))
                    .child(div().text_size(11.5).text_color(t.dim).truncate().child(s.branch)),
                ),
              ),
          )
          .when(isDragged, (el) =>
            el.child(
              h_flex()
                .px(5)
                .py(1)
                .rounded(4)
                .bg((t.accent ?? "#3b82f6") + "26")
                .child(
                  div()
                    .text_size(9.5)
                    .font_bold()
                    .text_color(t.accent ?? "#3b82f6")
                    .child("Moving"),
                ),
            ),
          )
          .when(!isDragged && hasBlocked, (el) =>
            el.child(
              div()
                .px(5)
                .h(16)
                .rounded(4)
                .bg(t.blocked ? t.blocked + "26" : "#ef444426")
                .text_size(10)
                .font_bold()
                .text_color(t.blocked ?? "#ef4444")
                .child("!"),
            ),
          )
          .when(!isDragged && !hasBlocked && hasWorking, (el) =>
            el.child(
              svg("mods/workspace-chrome/spinner.svg")
                .size(11)
                .text_color(t.working ?? "#3b82f6")
                .spin(900),
            ),
          )
          .when(!isDragged && !hasBlocked && !hasWorking && spaceAgents.length > 0, (el) =>
            el.child(
              div()
                .px(5)
                .h(16)
                .rounded(4)
                .bg(t.surface ?? "#1a1a1a")
                .text_size(10)
                .text_color(t.dim)
                .child(String(spaceAgents.length)),
            ),
          ),
      );

    const items = [header];

    // Show inline icon picker if active for this space
    if (this.iconPickerSpaceId === s.id) {
      items.push(this.renderIconPicker(t, s, cx));
    }

    if (isFolded) {
      return items;
    }

    const agentElements =
      spaceAgents.length === 0
        ? [
            h_flex()
              .pl(8)
              .pr(8)
              .h(24)
              .gap(0)
              .items_center()
              .child(this.renderTreeGlyph("└", t, 24, 2))
              .child(div().w(4).flex_none())
              .child(
                div()
                  .text_size(11)
                  .text_color(t.dim ?? "#666")
                  .child("No active agents"),
              ),
          ]
        : spaceAgents.flatMap((a, idx) =>
            this.renderAgentRow(
              t,
              a,
              idx,
              spaceAgents.length,
              allTerminals,
              shownAddress,
              listedMap,
              cx,
            ),
          );

    return [...items, ...agentElements];
  }

  render(cx) {
    const t = theme();
    const sps = spaces();
    const ags = agents();
    const tms = terminals();
    const foc = focused();
    const shownAddress = foc?.terminal ?? foc?.agent;
    const listedMap = new Map(ags.map((a) => [a.address, a.status]));

    const agentsBySpace = new Map();
    for (const s of sps) {
      agentsBySpace.set(s.id, []);
    }

    const unassignedAgents = [];
    for (const a of ags) {
      let targetSpaceId = a.space;
      if (!targetSpaceId) {
        const foundSpace = sps.find((s) => (s.tabs ?? []).some((tab) => tab.id === a.tab));
        if (foundSpace) targetSpaceId = foundSpace.id;
      }

      if (targetSpaceId && agentsBySpace.has(targetSpaceId)) {
        agentsBySpace.get(targetSpaceId).push(a);
      } else {
        unassignedAgents.push(a);
      }
    }

    return v_flex()
      .size_full()
      .bg(t.chrome ?? t.surface)
      // Clean and elegant Spaces Header without cluttered badges
      .child(
        h_flex()
          .h(31)
          .pl(16)
          .pr(10)
          .items_center()
          .justify_between()
          .text_size(11.5)
          .text_color(t.dim)
          .child(div().child("Spaces"))
          .child(
            div()
              .id("space-new")
              .size(26)
              .flex_none()
              .flex()
              .items_center()
              .justify_center()
              .rounded(6)
              .text_color(t.dim)
              .hover((el) => el.bg(t.hover).text_color(t.foreground))
              .cursor_pointer()
              .on_click((_e, cx) => this.createSpaceWithBrowse(cx))
              .on_mouse_down("right", (_e, cx) => {
                cx.stop_propagation();
                run("space.new");
              })
              .tooltip("New Space (Click to browse/create folder, Right-click for default)")
              .child(svg("mods/workspace-chrome/plus.svg").size(14)),
          ),
      )
      // Content: Scrollable list of Spaces & Nested Agents
      .child(
        v_flex()
          .id("hegar-scroll-list")
          .flex_1()
          .min_h(0)
          .px(6)
          .py(4)
          .gap(2)
          .overflow_y_scrollbar()
          .mode("always")
          .children(
            sps.flatMap((s, idx) =>
              this.renderSpaceCard(
                t,
                s,
                idx,
                agentsBySpace.get(s.id) ?? [],
                tms,
                shownAddress,
                listedMap,
                sps,
                cx,
              ),
            ),
          )
          .when(unassignedAgents.length > 0, (el) =>
            el.child(
              v_flex()
                .mt(8)
                .gap(2)
                .child(
                  div()
                    .px(8)
                    .py(2)
                    .text_size(10.5)
                    .font_bold()
                    .text_color(t.dim)
                    .child("GLOBAL / OTHER AGENTS"),
                )
                .children(
                  unassignedAgents.flatMap((a) =>
                    this.renderAgentRow(t, a, tms, shownAddress, listedMap, cx),
                  ),
                ),
            ),
          ),
      )
      // Multi-Agent Live AI Quota & Usage Widget: Placed Directly Above the Bottom Divider;
  }
}
