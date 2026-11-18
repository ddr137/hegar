// AI Usage & Quota Mod for Herdr
// Displays full live quotas, models, and limits for Claude Code and Antigravity matching /usage and /quota

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, closeOverlay, props, exec } from "herdr";

function formatResetTime(isoStr) {
  if (!isoStr) return "Quota available";
  const diffMs = new Date(isoStr).getTime() - Date.now();
  if (diffMs <= 0) return "Refreshing soon";
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return `Refreshes in ${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins > 0 ? `Refreshes in ${hours}h ${remMins}m` : `Refreshes in ${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `Refreshes in ${days}d ${remHours}h` : `Refreshes in ${days}d`;
}

function getUsageColor(pct, isUsage = true) {
  if (isUsage) {
    if (pct >= 85) return "#f87171"; // Coral / Red (Critical)
    if (pct >= 60) return "#facc15"; // Yellow / Amber (Warning)
    return "#86efac"; // Soft green (Normal)
  } else {
    if (pct <= 15) return "#f87171"; // Coral / Red (Critical low)
    if (pct <= 40) return "#facc15"; // Yellow / Amber (Warning)
    return "#86efac"; // Soft green (Healthy)
  }
}

export default class AIUsageView extends View {
  init(_props, cx) {
    this.loading = false;

    this.antigravity = {
      account: "dadanramdhani1509@gmail.com",
      gemini: {
        name: "Gemini Models",
        description: "Models within this group: Gemini 3.8 Flash",
        weeklyPct: 95,
        weeklyReset: "2026-11-25T01:58:45Z",
        fiveHourPct: 83,
        fiveHourReset: "2026-11-18T06:58:45Z",
      },
      claudeGpt: {
        name: "Claude and GPT models",
        description: "Models within this group: Claude Sonnet 4.6, Claude Opus 4.6, GPT-OSS 120B",
        weeklyPct: 100,
        weeklyReset: "2026-11-25T04:20:30Z",
        fiveHourPct: 100,
        fiveHourReset: "2026-11-18T09:20:30Z",
      },
    };

    this.claude = {
      tier: "Claude Code Subscription",
      models: "Models within this group: Claude 3.7 Sonnet, Claude 3.5 Sonnet, Claude Opus",
      sessionPct: 0,
      weekPct: 86,
      resetTime: "Nov 19 at 1pm (Asia/Jakarta)",
      topMcp: "figcraft 56%, claude-in-chrome 5%",
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
            if (gemGroup.description) this.antigravity.gemini.description = gemGroup.description;
            const w = gemGroup.buckets?.find((b) => b.window === "weekly");
            const f = gemGroup.buckets?.find((b) => b.window === "5h");
            if (w?.remaining_fraction != null) {
              this.antigravity.gemini.weeklyPct = Math.round(w.remaining_fraction * 1000) / 10;
              this.antigravity.gemini.weeklyReset = w.reset_time;
            }
            if (f?.remaining_fraction != null) {
              this.antigravity.gemini.fiveHourPct = Math.round(f.remaining_fraction * 1000) / 10;
              this.antigravity.gemini.fiveHourReset = f.reset_time;
            }
          }
          if (clGroup) {
            if (clGroup.description) this.antigravity.claudeGpt.description = clGroup.description;
            const w = clGroup.buckets?.find((b) => b.window === "weekly");
            const f = clGroup.buckets?.find((b) => b.window === "5h");
            if (w?.remaining_fraction != null) {
              this.antigravity.claudeGpt.weeklyPct = Math.round(w.remaining_fraction * 1000) / 10;
              this.antigravity.claudeGpt.weeklyReset = w.reset_time;
            }
            if (f?.remaining_fraction != null) {
              this.antigravity.claudeGpt.fiveHourPct = Math.round(f.remaining_fraction * 1000) / 10;
              this.antigravity.claudeGpt.fiveHourReset = f.reset_time;
            }
          }
        }
      }
    } catch {
      // Keep previous valid snapshot
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
      // Keep previous valid snapshot
    }

    this.loading = false;
    if (cx) cx.notify();
  }

  render(cx) {
    const t = theme();
    const qAgy = this.antigravity;
    const qCl = this.claude;

    const clSess = qCl.sessionPct ?? 0;
    const clWeek = qCl.weekPct ?? 86;
    const gem5h = qAgy.gemini.fiveHourPct ?? 83;
    const gemWk = qAgy.gemini.weeklyPct ?? 95;
    const clGpt5h = qAgy.claudeGpt.fiveHourPct ?? 100;
    const clGptWk = qAgy.claudeGpt.weeklyPct ?? 100;

    const clSessColor = getUsageColor(clSess, true);
    const clWeekColor = getUsageColor(clWeek, true);
    const gem5hColor = getUsageColor(gem5h, false);
    const gemWkColor = getUsageColor(gemWk, false);
    const clGpt5hColor = getUsageColor(clGpt5h, false);
    const clGptWkColor = getUsageColor(clGptWk, false);

    const progressBar = (pct, color) =>
      div()
        .h(4.5)
        .w_full()
        .rounded_full()
        .bg("#242429")
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
              .bg("#ffffffcc"),
          ),
        );

    return v_flex()
      .w(370)
      .max_h(520)
      .p(12)
      .gap(10)
      .bg(t.popover)
      .rounded(10)
      .border(1)
      .border_color(t.border)
      .shadow_2xl()
      .text_size(12)
      // Top Title Bar
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .pb(6)
          .border_b(1)
          .border_color(t.border)
          .child(
            div()
              .text_size(12.5)
              .font_semibold()
              .text_color(t.foreground)
              .child("Live AI Quota & Models (/usage)"),
          )
          .child(
            h_flex()
              .gap(4)
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
                  .tooltip("Refresh live quota")
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
      // Scrollable content area
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .gap(10)
          .overflow_y_scrollbar()
          // Section 1: Claude Code
          .child(
            v_flex()
              .gap(6)
              .child(
                h_flex()
                  .items_center()
                  .justify_between()
                  .child(
                    h_flex()
                      .gap(6)
                      .items_center()
                      .child(image("icons/claude.svg").w(14).h(14).flex_none())
                      .child(
                        div()
                          .font_semibold()
                          .text_size(12)
                          .text_color(t.foreground)
                          .child("Claude Code"),
                      ),
                  )
                  .child(
                    div()
                      .text_size(10.5)
                      .text_color(t.dim)
                      .child("Claude Code Subscription"),
                  ),
              )
              .child(
                div()
                  .text_size(10.5)
                  .text_color(t.dim)
                  .child(qCl.models),
              )
              // 5-Hour Session Limit
              .child(
                v_flex()
                  .gap(2)
                  .child(
                    h_flex()
                      .justify_between()
                      .child(div().text_size(11).text_color(t.muted).child("Current session (5h)"))
                      .child(
                        div()
                          .text_size(11.5)
                          .font_semibold()
                          .text_color(clSessColor)
                          .child(`${clSess}% used`),
                      ),
                  )
                  .child(progressBar(clSess, clSessColor)),
              )
              // Weekly Limit
              .child(
                v_flex()
                  .gap(2)
                  .child(
                    h_flex()
                      .justify_between()
                      .child(
                        div()
                          .text_size(11)
                          .text_color(t.muted)
                          .child("Current week (all models)"),
                      )
                      .child(
                        div()
                          .text_size(11.5)
                          .font_semibold()
                          .text_color(clWeekColor)
                          .child(`${clWeek}% used`),
                      ),
                  )
                  .child(progressBar(clWeek, clWeekColor))
                  .child(
                    div()
                      .text_size(10.5)
                      .text_color(t.dim)
                      .child(qCl.resetTime ? `Resets ${qCl.resetTime}` : "Weekly quota"),
                  ),
              )
              .when(Boolean(qCl.topMcp), (el) =>
                el.child(
                  div().text_size(10.5).text_color(t.dim).truncate().child(`Top MCP servers: ${qCl.topMcp}`),
                ),
              ),
          )
          // Divider
          .child(div().h(1).bg(t.border).my(1))
          // Section 2: Antigravity
          .child(
            v_flex()
              .gap(6)
              .child(
                h_flex()
                  .items_center()
                  .justify_between()
                  .child(
                    h_flex()
                      .gap(6)
                      .items_center()
                      .child(image("icons/antigravity.svg").w(14).h(14).flex_none())
                      .child(
                        div()
                          .font_semibold()
                          .text_size(12)
                          .text_color(t.foreground)
                          .child("Antigravity"),
                      ),
                  )
                  .child(
                    div()
                      .text_size(10.5)
                      .text_color(t.dim)
                      .truncate()
                      .child(qAgy.account || "Google AI Pro"),
                  ),
              )
              // Group 1: Gemini Models
              .child(
                v_flex()
                  .gap(3)
                  .child(
                    div()
                      .text_size(11)
                      .font_semibold()
                      .text_color(t.foreground)
                      .child(qAgy.gemini.name),
                  )
                  .child(
                    div()
                      .text_size(10.5)
                      .text_color(t.dim)
                      .child(qAgy.gemini.description),
                  )
                  // 5-Hour Limit
                  .child(
                    v_flex()
                      .gap(2)
                      .child(
                        h_flex()
                          .justify_between()
                          .child(
                            div().text_size(11).text_color(t.muted).child("Five Hour Limit Remaining"),
                          )
                          .child(
                            div()
                              .text_size(11.5)
                              .font_semibold()
                              .text_color(gem5hColor)
                              .child(`${gem5h}%`),
                          ),
                      )
                      .child(progressBar(gem5h, gem5hColor))
                      .child(
                        div()
                          .text_size(10.5)
                          .text_color(t.dim)
                          .child(formatResetTime(qAgy.gemini.fiveHourReset)),
                      ),
                  )
                  // Weekly Limit
                  .child(
                    v_flex()
                      .gap(2)
                      .child(
                        h_flex()
                          .justify_between()
                          .child(
                            div().text_size(11).text_color(t.muted).child("Weekly Limit Remaining"),
                          )
                          .child(
                            div()
                              .text_size(11.5)
                              .font_semibold()
                              .text_color(gemWkColor)
                              .child(`${gemWk}%`),
                          ),
                      )
                      .child(progressBar(gemWk, gemWkColor))
                      .child(
                        div()
                          .text_size(10.5)
                          .text_color(t.dim)
                          .child(formatResetTime(qAgy.gemini.weeklyReset)),
                      ),
                  ),
              )
              // Group 2: Claude and GPT models in Antigravity
              .child(
                v_flex()
                  .gap(3)
                  .pt(4)
                  .border_t(1)
                  .border_color(t.border)
                  .child(
                    div()
                      .text_size(11)
                      .font_semibold()
                      .text_color(t.foreground)
                      .child(qAgy.claudeGpt.name),
                  )
                  .child(
                    div()
                      .text_size(10.5)
                      .text_color(t.dim)
                      .child(qAgy.claudeGpt.description),
                  )
                  // 5-Hour Limit
                  .child(
                    v_flex()
                      .gap(2)
                      .child(
                        h_flex()
                          .justify_between()
                          .child(
                            div().text_size(11).text_color(t.muted).child("Five Hour Limit Remaining"),
                          )
                          .child(
                            div()
                              .text_size(11.5)
                              .font_semibold()
                              .text_color(clGpt5hColor)
                              .child(`${clGpt5h}%`),
                          ),
                      )
                      .child(progressBar(clGpt5h, clGpt5hColor))
                      .child(
                        div()
                          .text_size(10.5)
                          .text_color(t.dim)
                          .child(formatResetTime(qAgy.claudeGpt.fiveHourReset)),
                      ),
                  )
                  // Weekly Limit
                  .child(
                    v_flex()
                      .gap(2)
                      .child(
                        h_flex()
                          .justify_between()
                          .child(
                            div().text_size(11).text_color(t.muted).child("Weekly Limit Remaining"),
                          )
                          .child(
                            div()
                              .text_size(11.5)
                              .font_semibold()
                              .text_color(clGptWkColor)
                              .child(`${clGptWk}%`),
                          ),
                      )
                      .child(progressBar(clGptWk, clGptWkColor))
                      .child(
                        div()
                          .text_size(10.5)
                          .text_color(t.dim)
                          .child(formatResetTime(qAgy.claudeGpt.weeklyReset)),
                      ),
                  ),
              ),
          ),
      );
  }
}
