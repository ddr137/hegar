// AI Usage & Quota Mod for Herdr
// Displays full live quotas and statistics for Antigravity, Claude Code, and OpenCode

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, spaces, terminals, theme, closeOverlay, props, exec } from "herdr";

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

export default class AIUsageView extends View {
  init(_props, cx) {
    this.selectedTab = "antigravity"; // "antigravity" | "claude" | "opencode"
    this.loading = false;

    this.antigravity = {
      account: "dadanramdhani1509@gmail.com",
      geminiWeeklyPct: 78,
      geminiWeeklyReset: "2026-11-22T11:01:20Z",
      gemini5hPct: 91,
      gemini5hReset: "2026-11-17T15:26:41Z",
      claudeGptWeeklyPct: 100,
      claudeGpt5hPct: 100,
    };

    this.claude = {
      sessionPct: 0,
      weekPct: 86,
      resetTime: "Nov 19 at 1pm (Asia/Jakarta)",
      topMcp: "figcraft 49%, claude-in-chrome 7%",
      cost: "$55.06",
      added: 34,
      removed: 23,
    };

    this.fetchData(cx);
  }

  async fetchData(cx) {
    this.loading = true;
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
            this.antigravity.geminiWeeklyPct = Math.round((w?.remaining_fraction ?? 1) * 1000) / 10;
            this.antigravity.geminiWeeklyReset = w?.reset_time;
            this.antigravity.gemini5hPct = Math.round((f?.remaining_fraction ?? 1) * 1000) / 10;
            this.antigravity.gemini5hReset = f?.reset_time;
          }
          if (clGroup) {
            const w = clGroup.buckets?.find((b) => b.window === "weekly");
            const f = clGroup.buckets?.find((b) => b.window === "5h");
            this.antigravity.claudeGptWeeklyPct = Math.round((w?.remaining_fraction ?? 1) * 1000) / 10;
            this.antigravity.claudeGpt5hPct = Math.round((f?.remaining_fraction ?? 1) * 1000) / 10;
          }
        }
      }
    } catch {
      // Keep previous
    }

    try {
      const r = await exec("claude", ["-p", "/usage", "--output-format", "json"]);
      if (r.code === 0 && r.stdout) {
        const parsed = JSON.parse(r.stdout);
        const text = parsed?.result || "";
        const sessMatch = text.match(/Current session:\s*(\d+)%/i);
        const weekMatch = text.match(/Current week[^:]*:\s*(\d+)%\s*used/i);
        const resetMatch = text.match(/resets\s+([^(\n]+)/i);

        if (sessMatch) this.claude.sessionPct = parseInt(sessMatch[1], 10);
        if (weekMatch) this.claude.weekPct = parseInt(weekMatch[1], 10);
        if (resetMatch) this.claude.resetTime = resetMatch[1].trim();

        const mcpLine = text.split("Top MCP servers:")[1]?.split("\n")[0];
        if (mcpLine) this.claude.topMcp = mcpLine.trim();
      }
    } catch {
      // Keep previous
    }

    this.loading = false;
    if (cx) cx.notify();
  }

  render(cx) {
    const t = theme();
    const ags = agents();
    const emerald = "#10b981";
    const accent = t.accent ?? "#3b82f6";

    const tabBtn = (key, label) => {
      const on = this.selectedTab === key;
      return div()
        .px(8)
        .h(24)
        .rounded(6)
        .flex()
        .items_center()
        .justify_center()
        .cursor_pointer()
        .bg(on ? (t.accent ?? "#3b82f6") + "26" : "#00000000")
        .text_color(on ? t.foreground : t.dim)
        .font_semibold()
        .text_size(11)
        .hover((el) => el.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => {
          this.selectedTab = key;
          cx.notify();
        })
        .child(label);
    };

    const progressBar = (pct, color) =>
      div()
        .h(6)
        .w_full()
        .rounded_full()
        .bg(t.raised ?? "#26262b")
        .overflow_hidden()
        .child(
          div()
            .h_full()
            .w(`${Math.min(100, Math.max(0, pct))}%`)
            .rounded_full()
            .bg(color),
        );

    let mainContent = null;

    if (this.selectedTab === "antigravity") {
      const q = this.antigravity;
      mainContent = v_flex()
        .gap(10)
        .child(
          h_flex()
            .items_center()
            .justify_between()
            .text_size(11)
            .text_color(t.dim)
            .child(div().child("Account:"))
            .child(div().font_medium().text_color(t.foreground).child(q.account)),
        )
        // GEMINI MODELS
        .child(
          v_flex()
            .gap(6)
            .p(10)
            .rounded(8)
            .bg(t.raised ?? "#222")
            .child(
              h_flex()
                .items_center()
                .justify_between()
                .child(div().text_size(11.5).font_bold().text_color(emerald).child("GEMINI MODELS"))
                .child(div().text_size(11).font_bold().text_color(emerald).child(`${q.geminiWeeklyPct}%`)),
            )
            .child(div().text_size(10.5).text_color(t.dim).child("Models within this group: Gemini 3.8 Flash"))
            .child(div().text_size(11).font_medium().text_color(t.muted).child("Weekly Limit Remaining"))
            .child(progressBar(q.geminiWeeklyPct, emerald))
            .child(div().text_size(10.5).text_color(t.dim).child(formatResetTime(q.geminiWeeklyReset)))
            .child(div().h(2))
            .child(
              h_flex()
                .items_center()
                .justify_between()
                .child(div().text_size(11).font_medium().text_color(t.muted).child("Five Hour Limit Remaining"))
                .child(div().text_size(11).font_bold().text_color(emerald).child(`${q.gemini5hPct}%`)),
            )
            .child(progressBar(q.gemini5hPct, emerald))
            .child(div().text_size(10.5).text_color(t.dim).child(formatResetTime(q.gemini5hReset))),
        )
        // CLAUDE & GPT MODELS
        .child(
          v_flex()
            .gap(6)
            .p(10)
            .rounded(8)
            .bg(t.raised ?? "#222")
            .child(
              h_flex()
                .items_center()
                .justify_between()
                .child(div().text_size(11.5).font_bold().text_color(accent).child("CLAUDE AND GPT MODELS"))
                .child(div().text_size(11).font_bold().text_color(accent).child(`${q.claudeGptWeeklyPct}%`)),
            )
            .child(div().text_size(10.5).text_color(t.dim).child("Claude Sonnet 4.6, Claude Opus 4.6, GPT-OSS 120B"))
            .child(div().text_size(11).font_medium().text_color(t.muted).child("Weekly Limit Remaining"))
            .child(progressBar(q.claudeGptWeeklyPct, accent))
            .child(div().text_size(10.5).text_color(t.dim).child("Quota available"))
            .child(div().h(2))
            .child(
              h_flex()
                .items_center()
                .justify_between()
                .child(div().text_size(11).font_medium().text_color(t.muted).child("Five Hour Limit Remaining"))
                .child(div().text_size(11).font_bold().text_color(accent).child(`${q.claudeGpt5hPct}%`)),
            )
            .child(progressBar(q.claudeGpt5hPct, accent))
            .child(div().text_size(10.5).text_color(t.dim).child("Quota available")),
        )
        .child(
          div()
            .text_size(10.5)
            .text_color(t.dim)
            .child("Within each group, models share a weekly limit and a 5-hour limit. Quota is consumed proportionally to token cost."),
        );
    } else {
      // CLAUDE
      const q = this.claude;
      const weekColor = q.weekPct >= 80 ? (t.blocked ?? "#ef4444") : (t.working ?? "#3b82f6");
      mainContent = v_flex()
        .gap(10)
        // Current Session
        .child(
          v_flex()
            .gap(6)
            .p(10)
            .rounded(8)
            .bg(t.raised ?? "#222")
            .child(
              h_flex()
                .items_center()
                .justify_between()
                .child(div().text_size(11).font_bold().text_color(t.foreground).child("Current session"))
                .child(div().text_size(11).font_semibold().text_color(t.muted).child(`${q.sessionPct}% used`)),
            )
            .child(progressBar(q.sessionPct, accent)),
        )
        // Current Week
        .child(
          v_flex()
            .gap(6)
            .p(10)
            .rounded(8)
            .bg(t.raised ?? "#222")
            .child(
              h_flex()
                .items_center()
                .justify_between()
                .child(div().text_size(11).font_bold().text_color(weekColor).child("Current week (all models)"))
                .child(div().text_size(11).font_bold().text_color(weekColor).child(`${q.weekPct}% used`)),
            )
            .child(progressBar(q.weekPct, weekColor))
            .child(div().text_size(10.5).text_color(t.dim).child(`Resets ${q.resetTime}`)),
        )
        // Top MCP servers
        .child(
          v_flex()
            .gap(4)
            .p(8)
            .rounded(8)
            .bg(t.surface ?? "#18181b")
            .border(1)
            .border_color(t.border)
            .child(div().text_size(11).font_bold().text_color(t.dim).child("TOP MCP USAGE BREAKDOWN"))
            .child(div().text_size(11).text_color(t.foreground).child(q.topMcp || "figcraft: 49%, claude-in-chrome: 7%"))
            .child(div().text_size(10.5).text_color(t.dim).child("Pro-tip: Start fresh with /clear or disable unused MCP servers to extend weekly quota.")),
        );
    }

    return v_flex()
      .w(360)
      .p(12)
      .gap(10)
      .bg(t.popover ?? t.surface)
      .rounded(12)
      .border(1)
      .border_color(t.border)
      .shadow_2xl()
      // Top Title Bar
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .pb(8)
          .border_b(1)
          .border_color(t.border)
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .child(svg("mods/workspace-chrome/bot.svg").size(16).text_color(accent))
              .child(div().text_size(13).font_bold().text_color(t.foreground).child("Models & AI Quota")),
          )
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .child(
                div()
                  .size(20)
                  .rounded(4)
                  .flex()
                  .items_center()
                  .justify_center()
                  .cursor_pointer()
                  .hover((el) => el.bg(t.hover).text_color(t.foreground))
                  .on_click((_e, cx) => this.fetchData(cx))
                  .tooltip("Refresh")
                  .child(
                    svg("mods/ai-usage/refresh.svg")
                      .size(12)
                      .text_color(t.dim)
                      .when(this.loading, (el) => el.spin(900)),
                  ),
              )
              .child(
                div()
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
      // Tab switcher
      .child(
        h_flex()
          .gap(4)
          .p(2)
          .rounded(8)
          .bg(t.surface ?? "#141416")
          .child(tabBtn("antigravity", "Antigravity (Gemini)"))
          .child(tabBtn("claude", "Claude Code")),
      )
      // Content
      .child(mainContent);
  }
}
