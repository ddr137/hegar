import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, theme, run, window, keys, exec, openOverlay, setShared } from "herdr";

function formatResetCompact(isoStr) {
  if (!isoStr) return "";
  const diffMs = new Date(isoStr).getTime() - Date.now();
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

function parseClaudeReset(str) {
  if (!str) return "";
  try {
    let clean = str.replace(/\s*\([^)]*\)/, "").trim();
    clean = clean.replace(/\bat\s+/i, "");
    clean = clean.replace(/(\d+)(am|pm)/i, (_, h, p) => {
      let hr = parseInt(h, 10);
      if (p.toLowerCase() === "pm" && hr < 12) hr += 12;
      if (p.toLowerCase() === "am" && hr === 12) hr = 0;
      return `${hr}:00`;
    });
    const yr = new Date().getFullYear();
    const d = new Date(`${clean} ${yr}`);
    const diffMs = d.getTime() - Date.now();
    if (diffMs > 0) {
      const hours = Math.floor(diffMs / 3600000);
      if (hours < 24) return `${hours}h`;
      const days = Math.floor(hours / 24);
      const remH = hours % 24;
      return remH > 0 ? `${days}d ${remH}h` : `${days}d`;
    }
  } catch {}
  return "";
}

export default class WorkspaceStatus extends View {
  init(_props, cx) {
    this.quota = {
      gemini5hPct: 87,
      gemini5hReset: "2h 38m",
      geminiWeeklyPct: 96,
      geminiWeeklyReset: "6d 21h",
      claudeSessionPct: 0,
      claudeSessionReset: "",
      claudeWeekPct: 86,
      claudeWeekReset: "1d 1h",
      loading: false,
    };
    this.fetchQuota(cx);
    cx.timer.every(30000, (cx) => this.fetchQuota(cx));
  }

  async fetchQuota(cx) {
    this.quota.loading = true;
    try {
      const resAgy = await exec("agy", ["-p", "/quota", "--output-format", "json"]);
      if (resAgy.code === 0 && resAgy.stdout) {
        const parsed = JSON.parse(resAgy.stdout);
        const groups = parsed?.command?.data?.groups;
        if (Array.isArray(groups)) {
          const gemGroup = groups.find((g) => g.name?.toLowerCase().includes("gemini"));
          if (gemGroup) {
            const w = gemGroup.buckets?.find((b) => b.window === "weekly");
            const f = gemGroup.buckets?.find((b) => b.window === "5h");
            if (f?.remaining_fraction != null) {
              this.quota.gemini5hPct = Math.round(f.remaining_fraction * 100);
              this.quota.gemini5hReset = formatResetCompact(f.reset_time);
            }
            if (w?.remaining_fraction != null) {
              this.quota.geminiWeeklyPct = Math.round(w.remaining_fraction * 100);
              this.quota.geminiWeeklyReset = formatResetCompact(w.reset_time);
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

        if (sessMatch) {
          this.quota.claudeSessionPct = parseInt(sessMatch[1], 10);
        }
        if (weekMatch) {
          this.quota.claudeWeekPct = parseInt(weekMatch[1], 10);
        }
        if (resetMatch) {
          this.quota.claudeWeekReset = parseClaudeReset(resetMatch[1].trim());
        }
      }
    } catch {
      // Keep previous valid snapshot
    }

    this.quota.loading = false;
    setShared("ai.quota", this.quota);
    if (cx) cx.notify();
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

    // Mini Progress Bar
    const miniBar = (pct, color) =>
      div()
        .w(26)
        .h(3.5)
        .rounded_full()
        .bg("#28282d")
        .overflow_hidden()
        .child(
          div()
            .h_full()
            .w(`${Math.min(100, Math.max(0, pct))}%`)
            .rounded_full()
            .bg(color),
        );

    // Metric item helper (5h / wk)
    const metricItem = (labelStr, pct, resetStr, isUsage = false) => {
      let color = "#86efac"; // green
      if (isUsage) {
        // For Claude (used %)
        if (pct >= 85) color = "#f87171"; // pink/coral
        else if (pct >= 50) color = "#fbbf24"; // amber/gold
        else color = "#86efac"; // green
      } else {
        // For Antigravity (remaining %)
        if (pct <= 20) color = "#f87171"; // coral/red
        else if (pct <= 60) color = "#fbbf24"; // amber/gold
        else color = "#86efac"; // green
      }

      const textVal = resetStr ? `${pct}% · ${resetStr}` : `${pct}%`;

      return h_flex()
        .gap(4)
        .items_center()
        .child(div().text_size(10.5).text_color(t.dim).child(labelStr))
        .child(miniBar(pct, color))
        .child(div().text_size(11).font_medium().text_color(color).child(textVal));
    };

    // Claude Telemetry Block
    const claudeBlock = h_flex()
      .gap(6)
      .items_center()
      .child(image("icons/claude.svg").w(13).h(13).flex_none())
      .child(metricItem("5h", this.quota.claudeSessionPct ?? 0, this.quota.claudeSessionReset, true))
      .child(metricItem("wk", this.quota.claudeWeekPct ?? 86, this.quota.claudeWeekReset, true));

    // Vertical Divider
    const divider = div().w(1).h(11).bg(t.border).mx(3);

    // Antigravity Telemetry Block
    const agyBlock = h_flex()
      .gap(6)
      .items_center()
      .child(image("icons/antigravity.svg").w(13).h(13).flex_none())
      .child(metricItem("5h", this.quota.gemini5hPct ?? 87, this.quota.gemini5hReset, false))
      .child(metricItem("wk", this.quota.geminiWeeklyPct ?? 96, this.quota.geminiWeeklyReset, false));

    // Inline Telemetry Group
    const telemetryBar = h_flex()
      .id("ai-telemetry-bar")
      .gap(8)
      .items_center()
      .cursor_pointer()
      .hover((s) => s.opacity(0.85))
      .tooltip("AI Quota: Claude & Antigravity Live Limits. Click for details.")
      .on_click((_e, cx) => {
        openOverlay({ mod: "ai-usage", kind: "popup", width: 350, height: 420 });
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
