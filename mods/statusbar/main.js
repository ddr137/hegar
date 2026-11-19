import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, theme, run, window, keys, exec, openOverlay, shared, setShared, checking } from "herdr";

// Time left until `at` (ms since the epoch): "26m", "4h 32m", "6d 18h". Worked out when drawn, so it stays live.
function timeLeft(at) {
  if (!at) return "";
  const diffMs = at - Date.now();
  if (diffMs <= 0) return "";
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

// A limit's colour, from the theme's own green, yellow and red (the same ones the default spaces list uses for ahead and
// behind): green while there is room, yellow getting close, red nearly out. (`done` and `working` are status colours and
// are not green and yellow in every theme.) `isUsage`: the number is what was used (high is bad); else what is left (low is bad).
function getUsageColor(t, pct, isUsage = true) {
  const bad = isUsage ? pct >= 85 : pct <= 15;
  const warn = isUsage ? pct >= 60 : pct <= 40;
  return bad ? t.ansi1 : warn ? t.ansi3 : t.ansi2;
}

// Claude Code's "Nov 18 at 6:09pm" (local time) as ms since the epoch, or null.
function parseClaudeResetAt(str) {
  const m = /([A-Za-z]{3})[a-z]*\s+(\d{1,2})\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(str ?? "");
  if (!m) return null;
  const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(m[1].toLowerCase());
  if (month < 0) return null;
  let hour = parseInt(m[3], 10) % 12;
  if (m[5].toLowerCase() === "pm") hour += 12;
  const now = new Date();
  let d = new Date(now.getFullYear(), month, parseInt(m[2], 10), hour, parseInt(m[4] ?? "0", 10));
  if (d.getTime() < now.getTime() - 86400000) d = new Date(now.getFullYear() + 1, month, parseInt(m[2], 10), hour, parseInt(m[4] ?? "0", 10));
  return d.getTime();
}

// How often the limits are read when nothing happens: each read starts both CLIs (about 4 s, 1.4 s of CPU),
// so it is rare, only while the window is shown, and otherwise driven by events (an agent finishing, Refresh).
const IDLE_MS = 180000;
const MIN_GAP_MS = 60000; // however often agents finish turns: at most one read a minute (each is ~1.4 s of CPU, ~4 s in all)

export default class WorkspaceStatus extends View {
  init(_props, cx) {
    // The one place the limits are read: the popup (aiusage) draws what is published here.
    this.usage = shared("ai.usage") ?? null;
    this.lastAt = this.usage?.at ?? 0;
    this.lastAsk = shared("ai.usage.ask") ?? 0;
    this.busy = false;
    this.forced = false;
    this.dueAt = 0;
    this.lastMinute = -1;
    this.prevWorking = new Set(agents().filter((a) => a.status === "working").map((a) => a.address));
    if (checking()) return; // `herdr-app check` runs init for real: start no timer and no program
    cx.timer.every(5000, (cx) => this.tick(cx));
    this.tick(cx);
  }

  // Herdr redraws this mod whenever agents or shared state change, so what those did is noticed here, in render,
  // and nothing is polled: the popup's Refresh asks (shared `ai.usage.ask`), and an agent that stopped working
  // means the limits just moved. This only sets flags; the timer below acts on them.
  observe() {
    const now = Date.now();
    const ask = shared("ai.usage.ask") ?? 0;
    if (ask > this.lastAsk) {
      this.lastAsk = ask;
      this.forced = true;
    }
    const working = new Set(agents().filter((a) => a.status === "working").map((a) => a.address));
    for (const id of this.prevWorking) if (!working.has(id)) this.dueAt = Math.max(this.dueAt, now + 10000);
    this.prevWorking = working;
  }

  // Every 5 s, and about time only (it reads no live data): is a read due, and the countdowns by the minute.
  tick(cx) {
    const now = Date.now();
    const shown = window()?.active !== false;
    const stale = now - this.lastAt >= IDLE_MS;
    const due = this.dueAt > 0 && now >= this.dueAt;
    if (!this.busy && (this.forced || (now - this.lastAt >= MIN_GAP_MS && (due || (shown && stale))))) {
      this.forced = false;
      this.dueAt = 0;
      this.fetchUsage(cx);
      return;
    }
    const minute = Math.floor(now / 60000);
    if (minute !== this.lastMinute) {
      this.lastMinute = minute;
      if (cx) cx.notify();
    }
  }

  // The reading runs as a task of its own (cx.spawn): a callback's cx must not be used after the callback returns.
  fetchUsage(cx) {
    this.busy = true;
    setShared("ai.usage.busy", true);
    cx.spawn(async (cx) => {
      const next = { ...(this.usage ?? {}) };
      // one after the other (each is a 400 MB process), at low priority so the window stays smooth
      try {
        const r = await exec("nice", ["-n", "10", "agy", "-p", "/quota", "--output-format", "json"], { cwd: "/tmp" });
        if (r.code === 0 && r.stdout) {
          const groups = JSON.parse(r.stdout)?.command?.data?.groups;
          if (Array.isArray(groups)) {
            next.agy = {
              groups: groups.map((g) => ({
                name: g.name,
                description: g.description ?? "",
                buckets: (g.buckets ?? []).map((b) => ({
                  window: b.window,
                  name: b.name,
                  remaining: b.remaining_fraction,
                  resetAt: b.reset_time ? new Date(b.reset_time).getTime() : null,
                })),
              })),
            };
          }
        }
      } catch {
        // keep the last good numbers
      }

      try {
        // No session is saved (every read used to leave one behind: hundreds of them in the home folder's /resume list),
      // and the person's own hooks and settings are not loaded (`project` only, in an empty folder): a read is cheaper.
      const r = await exec(
        "nice",
        ["-n", "10", "claude", "-p", "/usage", "--output-format", "json", "--no-session-persistence", "--setting-sources", "project"],
        { cwd: "/tmp" },
      );
        if (r.code === 0 && r.stdout) {
          const text = JSON.parse(r.stdout)?.result || "";
          const sess = /Current session:\s*(\d+)%\s*used(?:[^\n]*?resets\s+([^(\n]+))?/i.exec(text);
          const week = /Current week[^:\n]*:\s*(\d+)%\s*used(?:[^\n]*?resets\s+([^(\n]+))?/i.exec(text);
          const mcp = text.split("Top MCP servers:")[1]?.split("\n")[0]?.trim();
          next.claude = {
            ...(next.claude ?? {}),
            sessionPct: sess ? parseInt(sess[1], 10) : next.claude?.sessionPct ?? null,
            sessionResetAt: sess ? parseClaudeResetAt(sess[2]) : next.claude?.sessionResetAt ?? null,
            weekPct: week ? parseInt(week[1], 10) : next.claude?.weekPct ?? null,
            weekResetAt: week ? parseClaudeResetAt(week[2]) : next.claude?.weekResetAt ?? null,
            weekResetText: week?.[2]?.trim() ?? next.claude?.weekResetText ?? "",
            topMcp: mcp ?? next.claude?.topMcp ?? "",
          };
        }
      } catch {
        // keep the last good numbers
      }

      next.at = Date.now();
      this.usage = next;
      this.lastAt = next.at;
      this.busy = false;
      setShared("ai.usage", next);
      setShared("ai.usage.busy", false);
      cx.notify();
    });
  }

  // The palette key as actually bound, not a hardcoded one
  hint(t) {
    const mac = window()?.platform === "macos";
    const mod = {
      cmd: mac ? "⌘" : "Ctrl+",
      ctrl: mac ? "⌃" : "Ctrl+",
      shift: mac ? "⇧" : "Shift+",
      alt: mac ? "⌥" : "Alt+",
      option: mac ? "⌥" : "Alt+",
    };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts =
      b && b.keys.endsWith("--")
        ? [...b.keys.slice(0, -2).split("-"), "-"]
        : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  render() {
    this.observe();
    const t = theme();
    const space = spaces().find((s) => s.active);
    const list = agents();
    const needs = list.filter((a) => a.status === "blocked").length;
    const label = (icon, text) =>
      h_flex()
        .gap(6)
        .items_center()
        .child(svg(`mods/workspace-chrome/${icon}.svg`).size(13))
        .child(text);

    // Mini Progress Bar matching official style with needle marker
    const miniBar = (pct, color) =>
      div()
        .w(28)
        .h(3.5)
        .rounded_full()
        .bg(t.hover ?? t.raised)
        .relative()
        .overflow_hidden()
        .child(
          div()
            .h_full()
            .w(`${Math.min(100, Math.max(0, pct))}%`)
            .rounded_full()
            .bg(color),
        )
        .when(pct > 0 && pct < 100, (el) =>
          el.child(
            div()
              .absolute()
              .top(0)
              .bottom(0)
              .left(`${Math.min(94, Math.max(6, pct))}%`)
              .w(1.5)
              .bg(t.foreground),
          ),
        );

    // Metric item helper (5h / wk)
    const metricItem = (labelStr, pctIn, resetStr, isUsage = false) => {
      const none = pctIn == null;
      const pct = none ? 0 : pctIn;
      const color = none ? t.dim : getUsageColor(t, pct, isUsage);
      const textVal = none ? "–" : resetStr ? `${pct}% · ${resetStr}` : `${pct}%`;

      return h_flex()
        .gap(4)
        .items_center()
        .child(div().text_size(10.5).text_color(t.dim).child(labelStr))
        .child(miniBar(pct, color))
        .child(div().text_size(11).font_medium().text_color(color).child(textVal));
    };

    const cl = this.usage?.claude;
    const gem = this.usage?.agy?.groups?.find((g) => /gemini/i.test(g.name));
    const bucket = (w) => gem?.buckets?.find((b) => b.window === w);
    const pctOf = (b) => (b?.remaining == null ? null : Math.round(b.remaining * 100));

    // Claude Telemetry Block
    const claudeBlock = h_flex()
      .gap(6)
      .items_center()
      .child(image("icons/claude.svg").w(13).h(13).flex_none())
      .child(metricItem("5h", cl?.sessionPct ?? null, timeLeft(cl?.sessionResetAt), true))
      .child(metricItem("wk", cl?.weekPct ?? null, timeLeft(cl?.weekResetAt), true));

    // Vertical Divider
    const divider = div().w(1).h(11).bg(t.border).mx(3);

    // Antigravity Telemetry Block
    const agyBlock = h_flex()
      .gap(6)
      .items_center()
      .child(image("icons/antigravity.svg").w(13).h(13).flex_none())
      .child(metricItem("5h", pctOf(bucket("5h")), timeLeft(bucket("5h")?.resetAt), false))
      .child(metricItem("wk", pctOf(bucket("weekly")), timeLeft(bucket("weekly")?.resetAt), false));

    // Inline Telemetry Group
    const telemetryBar = h_flex()
      .id("ai-telemetry-bar")
      .gap(8)
      .items_center()
      .cursor_pointer()
      .hover((s) => s.opacity(0.85))
      .tooltip("AI Quota: Claude & Antigravity Live Limits. Click for details.")
      .on_click((_e, cx) => {
        // tall enough for everything, so it never needs to scroll (one more group: 130 px more)
        const groups = this.usage?.agy?.groups?.length ?? 2;
        openOverlay({ mod: "aiusage", kind: "popup", width: 370, height: 350 + 130 * groups });
      })
      .child(claudeBlock)
      .child(divider)
      .child(agyBlock);

    return h_flex()
      .size_full()
      .px(14)
      .gap(16)
      .items_center()
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(11.8)
      .text_color(t.muted)
      // Left side: Workspace Machine, Git Branch, Agents count
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), (el) => el.child(label("branch", space.branch)))
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(div().size(6).rounded(3).bg(t.dim))
          .child(`${list.length} agents`)
          .when(needs > 0, (el) =>
            el.child(div().text_color(t.blocked).child(`· ${needs} needs you`)),
          ),
      )
      .child(div().flex_1())
      // Right side: AI Telemetry + Palette shortcut
      .child(telemetryBar)
      .child(
        div()
          .id("palette")
          .text_color(t.dim)
          .cursor_pointer()
          .hover((s) => s.text_color(t.foreground))
          .on_click(() => run("app.palette"))
          .child(this.hint(t)),
      );
  }
}
