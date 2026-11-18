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
    this.selectedAgentTab = "auto"; // "auto" | "antigravity" | "claude"

    // Multi-agent quota states initialized with high-fidelity live structure
    this.agentQuotas = {
      claude: {
        weekPct: 86,
        sessionPct: 0,
        resetTime: "Nov 19 at 1pm (Asia/Jakarta)",
        topMcp: "figcraft 49%, claude-in-chrome 7%, Google Sheets 2%",
        loading: false,
      },
      antigravity: {
        account: "dadanramdhani1509@gmail.com",
        model: "Gemini 3.8 Flash",
        tier: "Google AI Pro",
        gemini: {
          weeklyPct: 78,
          weeklyReset: "2026-11-22T11:01:20Z",
          fiveHourPct: 91,
          fiveHourReset: "2026-11-17T15:26:41Z",
        },
        claudeGpt: {
          weeklyPct: 100,
          weeklyReset: null,
          fiveHourPct: 100,
          fiveHourReset: null,
        },
        loading: false,
      },
    };

    this.fetchQuota(cx);

    cx.timer.every(60000, (cx) => this.fetchQuota(cx));
    cx.timer.every(1000, (cx) => cx.notify());
  }

  async fetchQuota(cx) {
    // 1. Antigravity via agy -p "/quota" --output-format json
    const qAgy = this.agentQuotas.antigravity;
    if (!qAgy.loading) {
      qAgy.loading = true;
      if (cx) cx.notify();

      try {
        const resAgy = await exec("agy", ["-p", "/quota", "--output-format", "json"]);
        if (resAgy.code === 0 && resAgy.stdout) {
          const parsed = JSON.parse(resAgy.stdout);
          const groups = parsed?.command?.data?.groups;
          if (Array.isArray(groups)) {
            const gemGroup = groups.find((g) => g.name?.toLowerCase().includes("gemini"));
            const clGroup = groups.find(
              (g) => g.name?.toLowerCase().includes("claude") || g.name?.toLowerCase().includes("gpt"),
            );
            if (gemGroup) {
              const w = gemGroup.buckets?.find((b) => b.window === "weekly");
              const f = gemGroup.buckets?.find((b) => b.window === "5h");
              qAgy.gemini.weeklyPct = Math.round((w?.remaining_fraction ?? 1) * 1000) / 10;
              qAgy.gemini.weeklyReset = w?.reset_time;
              qAgy.gemini.fiveHourPct = Math.round((f?.remaining_fraction ?? 1) * 1000) / 10;
              qAgy.gemini.fiveHourReset = f?.reset_time;
            }
            if (clGroup) {
              const w = clGroup.buckets?.find((b) => b.window === "weekly");
              const f = clGroup.buckets?.find((b) => b.window === "5h");
              qAgy.claudeGpt.weeklyPct = Math.round((w?.remaining_fraction ?? 1) * 1000) / 10;
              qAgy.claudeGpt.weeklyReset = w?.reset_time;
              qAgy.claudeGpt.fiveHourPct = Math.round((f?.remaining_fraction ?? 1) * 1000) / 10;
              qAgy.claudeGpt.fiveHourReset = f?.reset_time;
            }
          }
        }
      } catch {
        // preserve previous valid snapshot
      } finally {
        qAgy.loading = false;
        if (cx) cx.notify();
      }
    }

    // 2. Claude Code via claude -p "/usage" --output-format json
    const qClaude = this.agentQuotas.claude;
    if (!qClaude.loading) {
      qClaude.loading = true;
      if (cx) cx.notify();

      try {
        const r = await exec("claude", ["-p", "/usage", "--output-format", "json"]);
        if (r.code === 0 && r.stdout) {
          const parsed = JSON.parse(r.stdout);
          const text = parsed?.result || "";
          const sessMatch = text.match(/Current session:\s*(\d+)%/i);
          const weekMatch = text.match(/Current week[^:]*:\s*(\d+)%\s*used/i);
          const resetMatch = text.match(/resets\s+([^(\n]+)/i);

          if (sessMatch) qClaude.sessionPct = parseInt(sessMatch[1], 10);
          if (weekMatch) qClaude.weekPct = parseInt(weekMatch[1], 10);
          if (resetMatch) qClaude.resetTime = resetMatch[1].trim();

          const mcpLine = text.split("Top MCP servers:")[1]?.split("\n")[0];
          if (mcpLine) qClaude.topMcp = mcpLine.trim();
        }
      } catch {
        // Fallback snapshot preserved
      } finally {
        qClaude.loading = false;
        if (cx) cx.notify();
      }
    }
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

  detectActiveAgent(sps, ags) {
    const activeSpace = sps.find((s) => s.active);
    const spaceAgs = ags.filter((a) => a.space === activeSpace?.id);
    if (spaceAgs.length > 0) {
      const lead = spaceAgs.find((a) => a.status === "working") || spaceAgs[0];
      const key = (lead.program?.key || "").toLowerCase();
      const name = (lead.program?.name || "").toLowerCase();
      const app = (lead.app || "").toLowerCase();
      const term = (lead.terminal || "").toLowerCase();

      if (
        key.includes("antigravity") ||
        name.includes("antigravity") ||
        app.includes("antigravity") ||
        term.includes("agy")
      ) {
        return "antigravity";
      }
      if (key.includes("claude") || name.includes("claude") || app.includes("claude")) {
        return "claude";
      }
    }
    if (activeSpace?.name?.toLowerCase().includes("hegar")) {
      return "antigravity";
    }
    return "claude";
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

  renderSubRow(t, item, shownAddress, listedMap) {
    const k = item.t;
    const st = kidStatus(k, listedMap);
    const pic = icon(k.program, 14, t.foreground);
    const isFocused = k.address === shownAddress;

    return h_flex()
      .id(`sub-${k.address}`)
      .pl(28)
      .pr(8)
      .h(26)
      .gap(4)
      .items_center()
      .rounded(8)
      .text_size(12.5)
      .when(isFocused, (el) => el.bg(t.selected))
      .when(!isFocused, (el) => el.hover((el) => el.bg(t.hover)))
      .cursor_pointer()
      .on_click(() => {
        if (listedMap.has(k.address)) {
          run("pane.focus", { terminal: k.address });
        } else {
          run("terminal.summon", { terminal: k.address });
        }
      })
      .on_mouse_down("right", () => this.openPaneMenu(k.pane, k.address))
      .child(
        div()
          .font_family("monospace")
          .text_color(t.dim ?? "#666")
          .child(item.lines.join("")),
      )
      .when(Boolean(pic), (el) => el.child(pic))
      .child(
        div()
          .flex_1()
          .truncate()
          .text_size(12.5)
          .text_color(isFocused ? t.foreground : t.muted)
          .child(clean(k.title) || k.program?.name || "Sub-agent"),
      )
      .child(this.statusBadge(t, st));
  }

  renderAgentRow(t, a, allTerminals, shownAddress, listedMap, cx) {
    const isFolded = this.foldedAgents.has(a.address);
    const pic = icon(a.program, 16, t.foreground);
    const subs = getSubAgentTree(allTerminals, a.address);
    const hasSubs = subs.length > 0;
    const isFocused = a.address === shownAddress;

    const row = h_flex()
      .id(`agent-${a.address}`)
      .pl(22)
      .pr(8)
      .h(30)
      .gap(6)
      .items_center()
      .rounded(8)
      .when(isFocused, (el) => el.bg(t.selected))
      .when(!isFocused, (el) => el.hover((el) => el.bg(t.hover)))
      .cursor_pointer()
      .on_click(() => run("pane.focus", { terminal: a.address }))
      .on_mouse_down("right", () => this.openPaneMenu(a.pane, a.address))
      .when(hasSubs, (el) =>
        el.child(
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
                this.foldedAgents.delete(a.address);
              } else {
                this.foldedAgents.add(a.address);
              }
              cx.notify();
            })
            .child(
              svg(`mods/workspace-chrome/chevron-${isFolded ? "right" : "down"}.svg`)
                .size(11)
                .text_color(t.dim),
            ),
        ),
      )
      .when(!hasSubs, (el) => el.child(div().size(16).flex_none()))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(
        div()
          .flex_1()
          .truncate()
          .text_size(13)
          .font_medium()
          .text_color(isFocused ? t.foreground : t.muted)
          .child(clean(a.title) || a.program?.name || "Agent"),
      )
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
            div()
              .pl(34)
              .py(4)
              .text_size(11)
              .text_color(t.dim ?? "#666")
              .child("No active agents"),
          ]
        : spaceAgents.flatMap((a) =>
            this.renderAgentRow(t, a, allTerminals, shownAddress, listedMap, cx),
          );

    return [...items, ...agentElements];
  }

  // Multi-Agent Live AI Usage & Quota Widget (Directly Above the Footer Divider)
  // Renders exact colors and all information bars directly matching the native CLI screens without less/detail.
  renderQuotaBar(t, sps, ags, cx) {
    const detected = this.detectActiveAgent(sps, ags);
    const activeAgentKey = this.selectedAgentTab === "auto" ? detected : this.selectedAgentTab;

    // Agent selector tabs
    const tabItem = (key, label) => {
      const on = this.selectedAgentTab === key;
      return div()
        .px(7)
        .h(22)
        .rounded(4)
        .flex()
        .items_center()
        .justify_center()
        .cursor_pointer()
        .bg(on ? t.raised : "#00000000")
        .border_1()
        .border_color(on ? t.border : "#00000000")
        .text_color(on ? t.foreground : t.dim)
        .font_medium()
        .text_size(11)
        .hover((el) => el.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => {
          this.selectedAgentTab = key;
          cx.notify();
        })
        .child(label);
    };

    let content = null;

    if (activeAgentKey === "antigravity") {
      const q = this.agentQuotas.antigravity;
      // Exact colors from Antigravity TUI Models & Quota screenshot
      const mintGreen = "#7cdba0";
      const mintTrack = "#222d3b";
      const emailBlue = "#5fa8eb";

      const gWeekly = q.gemini?.weeklyPct ?? 77.7;
      const g5h = q.gemini?.fiveHourPct ?? 91.1;
      const clWeekly = q.claudeGpt?.weeklyPct ?? 100;
      const cl5h = q.claudeGpt?.fiveHourPct ?? 100;

      const quotaBar = (pct) =>
        div()
          .h(5)
          .w_full()
          .rounded_full()
          .bg(mintTrack)
          .overflow_hidden()
          .child(
            div()
              .h_full()
              .w(`${Math.min(100, Math.max(0, pct))}%`)
              .rounded_full()
              .bg(mintGreen),
          );

      content = v_flex()
        .gap(6)
        // Account header
        .child(
          h_flex()
            .items_center()
            .gap(5)
            .text_size(11)
            .child(div().text_color(t.dim).child("Account:"))
            .child(div().font_medium().text_color(emailBlue).truncate().child(q.account)),
        )
        // GEMINI MODELS
        .child(
          v_flex()
            .gap(4)
            .child(
              div()
                .text_size(11)
                .font_semibold()
                .text_color(t.foreground)
                .child("GEMINI MODELS"),
            )
            .child(
              div()
                .text_size(10.5)
                .text_color(t.dim)
                .child("Models within this group: Gemini 3.8 Flash"),
            )
            // Weekly limit
            .child(
              h_flex()
                .items_center()
                .justify_between()
                .pt(2)
                .text_size(11)
                .child(div().text_color(t.muted).child("Weekly Limit Remaining"))
                .child(div().font_semibold().text_color(mintGreen).child(`${gWeekly}%`)),
            )
            .child(quotaBar(gWeekly))
            .child(
              div()
                .text_size(10.5)
                .text_color(mintGreen)
                .child(formatResetTime(q.gemini?.weeklyReset)),
            )
            // 5-Hour limit
            .child(
              h_flex()
                .items_center()
                .justify_between()
                .pt(2)
                .text_size(11)
                .child(div().text_color(t.muted).child("Five Hour Limit Remaining"))
                .child(div().font_semibold().text_color(mintGreen).child(`${g5h}%`)),
            )
            .child(quotaBar(g5h))
            .child(
              div()
                .text_size(10.5)
                .text_color(mintGreen)
                .child(formatResetTime(q.gemini?.fiveHourReset)),
            ),
        )
        // CLAUDE AND GPT MODELS
        .child(
          v_flex()
            .gap(4)
            .pt(4)
            .border_t(1)
            .border_color(t.border)
            .child(
              div()
                .text_size(11)
                .font_semibold()
                .text_color(t.foreground)
                .child("CLAUDE AND GPT MODELS"),
            )
            .child(
              div()
                .text_size(10.5)
                .text_color(t.dim)
                .child("Claude Sonnet 4.6, Claude Opus 4.6, GPT-OSS 120B"),
            )
            // Weekly limit
            .child(
              h_flex()
                .items_center()
                .justify_between()
                .pt(2)
                .text_size(11)
                .child(div().text_color(t.muted).child("Weekly Limit Remaining"))
                .child(div().font_semibold().text_color(mintGreen).child(`${clWeekly}%`)),
            )
            .child(quotaBar(clWeekly))
            .child(
              div()
                .text_size(10.5)
                .text_color(mintGreen)
                .child("Quota available"),
            )
            // 5-Hour limit
            .child(
              h_flex()
                .items_center()
                .justify_between()
                .pt(2)
                .text_size(11)
                .child(div().text_color(t.muted).child("Five Hour Limit Remaining"))
                .child(div().font_semibold().text_color(mintGreen).child(`${cl5h}%`)),
            )
            .child(quotaBar(cl5h))
            .child(
              div()
                .text_size(10.5)
                .text_color(mintGreen)
                .child("Quota available"),
            ),
        );
    } else {
      // Claude Code
      const q = this.agentQuotas.claude;
      // Exact color from Claude Code screenshot
      const claudeLavender = "#8b8fe8";
      const claudeTrack = "#25263a";

      const weekPct = q.weekPct ?? 86;
      const sessPct = q.sessionPct ?? 0;

      const claudeBar = (pct) =>
        div()
          .h(5)
          .w_full()
          .rounded_full()
          .bg(claudeTrack)
          .overflow_hidden()
          .child(
            div()
              .h_full()
              .w(`${Math.min(100, Math.max(0, pct))}%`)
              .rounded_full()
              .bg(claudeLavender),
          );

      content = v_flex()
        .gap(6)
        // Current session
        .child(
          v_flex()
            .gap(3)
            .child(
              h_flex()
                .items_center()
                .justify_between()
                .text_size(11)
                .child(div().font_medium().text_color(t.foreground).child("Current session"))
                .child(div().text_color(t.dim).child(`${sessPct}% used`)),
            )
            .child(claudeBar(sessPct)),
        )
        // Current week (all models)
        .child(
          v_flex()
            .gap(3)
            .child(
              h_flex()
                .items_center()
                .justify_between()
                .text_size(11)
                .child(div().font_medium().text_color(t.foreground).child("Current week (all models)"))
                .child(div().font_semibold().text_color(claudeLavender).child(`${weekPct}% used`)),
            )
            .child(claudeBar(weekPct))
            .child(
              div()
                .text_size(10.5)
                .text_color(t.dim)
                .child(q.resetTime ? `Resets ${q.resetTime}` : "Weekly quota"),
            ),
        )
        // Top MCP breakdown
        .when(Boolean(q.topMcp), (el) =>
          el.child(
            v_flex()
              .gap(3)
              .pt(3)
              .border_t(1)
              .border_color(t.border)
              .child(
                div()
                  .text_size(10.5)
                  .font_semibold()
                  .text_color(t.dim)
                  .child("TOP MCP SERVERS"),
              )
              .child(
                div()
                  .text_size(10.5)
                  .text_color(t.muted)
                  .child(q.topMcp),
              ),
          ),
        );
    }

    return v_flex()
      .p(10)
      .gap(6)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      // Top row: Tab switcher + Refresh
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .child(
            h_flex()
              .gap(2)
              .items_center()
              .child(tabItem("auto", "Auto"))
              .child(tabItem("antigravity", "Antigravity"))
              .child(tabItem("claude", "Claude")),
          )
          .child(
            div()
              .size(18)
              .rounded(3)
              .flex()
              .items_center()
              .justify_center()
              .cursor_pointer()
              .hover((el) => el.bg(t.hover))
              .on_click((_e, cx) => this.fetchQuota(cx))
              .tooltip("Refresh live quota")
              .child(
                svg("mods/workspace-chrome/spinner.svg")
                  .size(10)
                  .text_color(t.dim)
                  .when(
                    this.agentQuotas.antigravity.loading || this.agentQuotas.claude.loading,
                    (el) => el.spin(900),
                  ),
              ),
          ),
      )
      .child(content);
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
          .gap(4)
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
      // Multi-Agent Live AI Quota & Usage Widget: Placed Directly Above the Bottom Divider
      .child(this.renderQuotaBar(t, sps, ags, cx));
  }
}
