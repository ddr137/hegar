import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, theme, run, window, keys, exec, openOverlay, setShared } from "herdr";

export default class WorkspaceStatus extends View {
  init(_props, cx) {
    this.quota = {
      geminiWeeklyPct: 78,
      claudeWeekPct: 86,
      loading: false,
    };
    this.fetchQuota(cx);
    // Periodically refresh quota every 60 seconds
    cx.timer.every(60000, (cx) => this.fetchQuota(cx));
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
            if (w?.remaining_fraction != null) {
              this.quota.geminiWeeklyPct = Math.round(w.remaining_fraction * 100);
            }
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
        const weekMatch = text.match(/Current week[^:]*:\s*(\d+)%\s*used/i);
        if (weekMatch) {
          this.quota.claudeWeekPct = parseInt(weekMatch[1], 10);
        }
      }
    } catch {
      // Keep previous
    }

    this.quota.loading = false;
    setShared("ai.quota", this.quota);
    if (cx) cx.notify();
  }

  // The palette key as actually bound, not a hardcoded one; without a
  // binding the hint stays useful ("commands") instead of lying.
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

    // AI Quota telemetry
    const gemPct = this.quota.geminiWeeklyPct ?? 78;
    const clPct = this.quota.claudeWeekPct ?? 86;
    const hasClaude = list.some((a) =>
      (a.title || a.program?.name || "").toLowerCase().includes("claude"),
    );
    const hasAgy = list.some(
      (a) =>
        (a.title || a.program?.name || "").toLowerCase().includes("anti") ||
        (a.title || a.program?.name || "").toLowerCase().includes("agy"),
    );

    const showClaude = hasClaude && !hasAgy;
    const textLabel = showClaude ? `Claude ${clPct}%` : `AI ${gemPct}%`;
    const dotColor = showClaude
      ? clPct < 75
        ? (t.ansi2 ?? "#10b981")
        : clPct < 90
        ? (t.ansi3 ?? "#f59e0b")
        : (t.blocked ?? "#ef4444")
      : gemPct > 30
      ? (t.ansi2 ?? "#10b981")
      : gemPct > 15
      ? (t.ansi3 ?? "#f59e0b")
      : (t.blocked ?? "#ef4444");

    const quotaTooltip = `AI Quota: Gemini ${gemPct}% remaining · Claude ${clPct}% used. Click for full breakdown`;

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
      // Clean, interactive AI Quota Pill
      .child(
        h_flex()
          .id("status-ai-quota")
          .gap(5)
          .items_center()
          .px(6)
          .h(20)
          .rounded(4)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip(quotaTooltip)
          .on_click(() => openOverlay({ mod: "ai-usage", kind: "popup", width: 380, height: 490 }))
          .child(svg("mods/workspace-chrome/bot.svg").size(13).text_color(dotColor))
          .child(div().child(textLabel)),
      )
      .child(div().flex_1())
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
