// Sidebar: the spaces, with their agents and sub-agents under them, as one list.
//  - The + button opens a small menu (mod `spacemenu`): browse for a folder, or a terminal in home at once.
//  - A space drags to a new place, drawn like the default list (the row dims, a line shows where it lands).
//  - agent.next / agent.prev follow the list as drawn (setAgentOrder).

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
  window,
  layout,
  setAgentOrder,
  home,
} from "herdr";

const MARK = {
  ansi6: "#22a99a",
  ansi3: "#e3814f",
  ansi4: "#5b8def",
  ansi5: "#8b7cf6",
  ansi2: "#3fae6a",
  ansi1: "#d9649a",
};

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

export default class HegarUnifiedSidebar extends View {
  init(_props, cx) {
    this.foldedSpaces = new Set();
    this.foldedAgents = new Set();
    this.pressed = null;
    this.over = null;
    // A press whose release never reached a row (let go outside the window) must not leave one dimmed. Checked every
    // 2 s, and the window is redrawn only when one was let go: nothing else here changes with time.
    cx.timer.every(2000, (cx) => {
      if (this.pressed !== null && Date.now() - (this.pressedAt ?? 0) > 8000) {
        this.pressed = null;
        this.over = null;
        cx.notify();
      }
    });
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
          run("terminal.peek", { terminal: k.address });
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

  renderSpaceCard(t, s, spaceIndex, spaceAgents, allTerminals, shownAddress, listedMap, allSpaces, cx) {
    const isFolded = this.foldedSpaces.has(s.id);
    const colorKey = shared("space.colors")?.[s.id] ?? "ansi4";
    const avatarFill = colorKey.startsWith("#") ? colorKey : (MARK[colorKey] ?? t[colorKey] ?? "#5b8def");
    const initial = ([...s.name][0] ?? "?").toUpperCase();

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
      .when(s.active, (el) => el.bg(t.selected))
      .when(!s.active, (el) => el.hover((el) => el.bg(t.hover)))
      .when(isDragged && this.over !== s.id, (el) => el.opacity(0.5))
      .when(isOver, (el) =>
        el.child(
          div()
            .absolute()
            .left(0)
            .right(0)
            .h(2)
            .bg(t.accent)
            .when(fromIndex < spaceIndex, (line) => line.bottom(0))
            .when(fromIndex > spaceIndex, (line) => line.top(0)),
        ),
      )
      .when(isDragged, (el) => el.cursor_grabbing())
      .when(!isDragged, (el) => el.cursor_grab())
      .on_mouse_down("left", () => {
        this.pressed = s.id;
        this.pressedAt = Date.now();
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
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
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
          // Space avatar: its colour and first letter
          .child(
            h_flex()
              .size(18)
              .flex_none()
              .rounded(5)
              .bg(avatarFill)
              .items_center()
              .justify_center()
              .text_size(10.5)
              .font_bold()
              .text_color("#ffffff")
              .child(initial),
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
          .when(hasBlocked, (el) =>
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
          .when(!hasBlocked && hasWorking, (el) =>
            el.child(
              svg("mods/workspace-chrome/spinner.svg")
                .size(11)
                .text_color(t.working ?? "#3b82f6")
                .spin(900),
            ),
          )
          .when(!hasBlocked && !hasWorking && spaceAgents.length > 0, (el) =>
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

    // agent.next / agent.prev follow this list, in the order it is drawn
    setAgentOrder([...sps.flatMap((s) => agentsBySpace.get(s.id).map((a) => a.address)), ...unassignedAgents.map((a) => a.address)]);

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
              .on_click(() => openOverlay({ mod: "spacemenu", kind: "popup", width: 260, height: 108 }))
              .on_mouse_down("right", (_e, cx) => {
                cx.stop_propagation();
                run("space.new", { folder: home(), machine: "" });
              })
              .tooltip("New space (right-click: a terminal in home at once)")
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
  }
}
