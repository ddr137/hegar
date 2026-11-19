// AI usage popup for Herdr
// Draws the live limits of Claude Code (/usage) and Antigravity (/quota) as the status bar published them
// (shared "ai.usage"). It starts no program of its own: opening it is instant, and Refresh asks the status
// bar (the one place the CLIs are read) to read again.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, closeOverlay, props, readTextFile, home, shared, setShared, checking } from "herdr";

// "Refreshes in 4h 32m" / "Resets in 6d 18h", worked out when drawn so it stays live.
function leftWords(at, verb) {
  if (!at) return "";
  const diffMs = at - Date.now();
  if (diffMs <= 0) return "Refreshing soon";
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return `${verb} in ${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins > 0 ? `${verb} in ${hours}h ${remMins}m` : `${verb} in ${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${verb} in ${days}d ${remHours}h` : `${verb} in ${days}d`;
}

// A limit's colour, from the theme's own green, yellow and red (the same ones the default spaces list uses for ahead and
// behind): green while there is room, yellow getting close, red nearly out. (`done` and `working` are status colours and
// are not green and yellow in every theme.) `isUsage`: the number is what was used (high is bad); else what is left (low is bad).
function getUsageColor(t, pct, isUsage = true) {
  const bad = isUsage ? pct >= 85 : pct <= 15;
  const warn = isUsage ? pct >= 60 : pct <= 40;
  return bad ? t.ansi1 : warn ? t.ansi3 : t.ansi2;
}

// Tall enough for everything, so it never scrolls: the same sum the status bar opens the popup with.
const heightFor = (groups) => 350 + 130 * groups;

export default class AIUsageView extends View {
  init(_props, cx) {
    this.askedAt = 0;
    this.models = "";

    // The models Claude Code knows, from its own settings: ["claude-opus-5-5", ...] -> "Opus 5.5, ..."
    cx.spawn(async (cx) => {
      try {
        const cfg = JSON.parse((await readTextFile(`${home()}/.claude/settings.json`)) || "{}");
        const names = Object.keys(cfg.modelSettings ?? {}).map((id) => {
          const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?/.exec(id);
          return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? "." + m[3] : ""}` : id;
        });
        this.models = names.length ? `Models within this group: ${names.join(", ")}` : "";
        cx.notify();
      } catch {}
    });

    if (checking()) return; // `herdr-app check` runs init for real: no request, no timer
    // Nothing yet, or old: ask the status bar to read once.
    const u = shared("ai.usage");
    if (!u || Date.now() - (u.at ?? 0) > 300000) this.refresh(cx);

    // Herdr redraws this mod when shared state changes (new numbers, a read starting or ending), so only the
    // countdowns need a tick: once a minute.
    cx.timer.every(60000, (cx) => cx.notify());
  }

  refresh(cx) {
    this.askedAt = Date.now();
    setShared("ai.usage.ask", this.askedAt);
    if (cx) cx.notify();
  }

  render(cx) {
    const t = theme();
    const u = shared("ai.usage");
    const cl = u?.claude;
    const groups = u?.agy?.groups ?? [];
    const loading = Boolean(shared("ai.usage.busy")) || Date.now() - this.askedAt < 4000;

    const progressBar = (pct, color) =>
      div()
        .h(4.5)
        .w_full()
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
              .left(`${Math.min(97, Math.max(3, pct))}%`)
              .w(1.5)
              .bg(t.foreground),
          ),
        );

    // One limit: its label and value, the bar, and when it resets.
    const meter = (label, valueText, pct, color, note) =>
      v_flex()
        .gap(2)
        .child(
          h_flex()
            .justify_between()
            .child(div().text_size(11).text_color(t.muted).child(label))
            .child(div().text_size(11.5).font_semibold().text_color(color).child(valueText)),
        )
        .child(progressBar(pct, color))
        .when(Boolean(note), (el) => el.child(div().text_size(10.5).text_color(t.dim).child(note)));

    const sectionHead = (icon, name, right) =>
      h_flex()
        .items_center()
        .justify_between()
        .child(
          h_flex()
            .gap(6)
            .items_center()
            .child(image(icon).w(14).h(14).flex_none())
            .child(div().font_semibold().text_size(12).text_color(t.foreground).child(name)),
        )
        .child(div().text_size(10.5).text_color(t.dim).truncate().child(right));

    const claudeSection = v_flex()
      .gap(6)
      .child(sectionHead("icons/claude.svg", "Claude Code", "Claude Code Subscription"))
      .when(Boolean(this.models), (el) => el.child(div().text_size(10.5).text_color(t.dim).child(this.models)))
      .when(cl?.sessionPct != null, (el) =>
        el.child(
          meter(
            "Current session (5h)",
            `${cl.sessionPct}% used`,
            cl.sessionPct,
            getUsageColor(t, cl.sessionPct, true),
            leftWords(cl.sessionResetAt, "Resets"),
          ),
        ),
      )
      .when(cl?.weekPct != null, (el) =>
        el.child(
          meter(
            "Current week (all models)",
            `${cl.weekPct}% used`,
            cl.weekPct,
            getUsageColor(t, cl.weekPct, true),
            leftWords(cl.weekResetAt, "Resets") || (cl.weekResetText ? `Resets ${cl.weekResetText}` : ""),
          ),
        ),
      )
      .when(Boolean(cl?.topMcp), (el) =>
        el.child(div().text_size(10.5).text_color(t.dim).truncate().child(`Top MCP servers: ${cl.topMcp}`)),
      )
      .when(!cl, (el) => el.child(div().text_size(11).text_color(t.dim).child("Reading the limits…")));

    const order = { "5h": 0, weekly: 1 };
    const groupBlock = (g, i) =>
      v_flex()
        .gap(3)
        .when(i > 0, (el) => el.pt(4).border_t(1).border_color(t.border))
        .child(div().text_size(11).font_semibold().text_color(t.foreground).child(g.name))
        .when(Boolean(g.description), (el) => el.child(div().text_size(10.5).text_color(t.dim).child(g.description)))
        .children(
          [...g.buckets]
            .sort((a, b) => (order[a.window] ?? 9) - (order[b.window] ?? 9))
            .map((b) => {
              const pct = Math.round((b.remaining ?? 0) * 1000) / 10;
              return meter(
                b.name || (b.window === "5h" ? "Five Hour Limit Remaining" : "Weekly Limit Remaining"),
                `${pct}%`,
                pct,
                getUsageColor(t, pct, false),
                b.resetAt ? leftWords(b.resetAt, "Refreshes") : "Quota available",
              );
            }),
        );

    const agySection = v_flex()
      .gap(6)
      .child(sectionHead("icons/antigravity.svg", "Antigravity", "Google AI"))
      .children(groups.map((g, i) => groupBlock(g, i)))
      .when(groups.length === 0, (el) => el.child(div().text_size(11).text_color(t.dim).child("Reading the quota…")));

    return v_flex()
      .w(370)
      .h(heightFor(groups.length || 2))
      .p(12)
      .gap(10)
      .bg(t.popover)
      .rounded(10)
      .border(1)
      .border_color(t.border)
      .shadow_2xl()
      .text_size(12)
      // Title bar
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .pb(6)
          .border_b(1)
          .border_color(t.border)
          .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child("Live AI Quota & Models (/usage)"))
          .child(
            h_flex()
              .gap(4)
              .items_center()
              .child(
                div()
                  .id("usage-refresh")
                  .size(20)
                  .rounded(4)
                  .flex()
                  .items_center()
                  .justify_center()
                  .cursor_pointer()
                  .hover((el) => el.bg(t.hover).text_color(t.foreground))
                  .on_click((_e, cx) => this.refresh(cx))
                  .tooltip("Refresh live quota")
                  .child(
                    svg("mods/aiusage/refresh.svg")
                      .size(12)
                      .text_color(t.dim)
                      .when(loading, (el) => el.spin(900)),
                  ),
              )
              .child(
                div()
                  .id("usage-close")
                  .size(20)
                  .rounded(4)
                  .flex()
                  .items_center()
                  .justify_center()
                  .text_color(t.dim)
                  .hover((el) => el.bg(t.hover).text_color(t.foreground))
                  .cursor_pointer()
                  .on_click(() => closeOverlay(props()?.overlay))
                  .child(svg("mods/workspace-chrome/x.svg").size(12)),
              ),
          ),
      )
      // Content: scrolls only if a window is too short for all of it
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .gap(10)
          .overflow_y_scrollbar()
          .pr(4)
          .child(claudeSection)
          .child(div().h(1).bg(t.border).my(1))
          .child(agySection),
      );
  }
}
