// Inbox: Human-in-the-loop interaction center for coding agents
// Handles approvals (y/n), direct questions, terminal explanations, and execution.
// Matches the visual card frame of Files and Changes.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, Scrollbar } from "gpui-base";
import { agents, spaces, terminals, panes, run, theme, exec, hc, settings } from "herdr";

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

export default class InboxView extends View {
  init(_props, cx) {
    this.filter = "needs_you"; // "needs_you" | "working" | "done" | "idle" | "all"
    this.agentOutputs = new Map(); // address -> string (last output snippet)
    this.inputs = new Map(); // address -> InputState
    this.typingMap = new Map(); // address -> boolean

    this.refreshSnippets(cx);
    cx.timer.every(2000, (cx) => {
      this.refreshSnippets(cx);
      cx.notify();
    });
  }

  ensureInput(addr) {
    if (!this.inputs.has(addr)) {
      const state = InputState.new({ placeholder: "Type an answer or instruction to agent…" });
      state.on("submit", (_e, cx) => this.sendReply(addr, cx));
      state.on("focus", (_e, cx) => {
        this.typingMap.set(addr, true);
        cx.notify();
      });
      state.on("blur", (_e, cx) => {
        this.typingMap.set(addr, false);
        cx.notify();
      });
      this.inputs.set(addr, state);
    }
    return this.inputs.get(addr);
  }

  async refreshSnippets(cx) {
    const ags = agents();
    for (const a of ags) {
      this.ensureInput(a.address);
      try {
        const res = await hc(["read", a.address]);
        if (res.code === 0 && res.stdout) {
          const lines = res.stdout
            .trim()
            .split("\n")
            .filter((l) => l.trim().length > 0);
          const snippet = lines.slice(-4).join("\n");
          this.agentOutputs.set(a.address, snippet);
        }
      } catch {
        // optional terminal read
      }
    }
    if (cx) cx.notify();
  }

  async approve(addr, cx) {
    await hc(["keys", addr, "y", "enter"]);
    run("pane.focus", { terminal: addr });
    this.refreshSnippets(cx);
  }

  async reject(addr, cx) {
    await hc(["keys", addr, "n", "enter"]);
    run("pane.focus", { terminal: addr });
    this.refreshSnippets(cx);
  }

  async sendReply(addr, cx) {
    const inp = this.inputs.get(addr);
    const val = inp?.value()?.trim();
    if (!val) return;
    await hc(["send", addr, val]);
    inp.set_value("");
    run("pane.focus", { terminal: addr });
    this.refreshSnippets(cx);
  }

  async interrupt(addr, cx) {
    await hc(["interrupt", addr]);
    this.refreshSnippets(cx);
  }

  renderAgentCard(t, a, cx) {
    const pic = icon(a.program, 15, t.foreground);
    const output = this.agentOutputs.get(a.address) || clean(a.title) || "Agent is running...";
    const isNeedsYou = a.status === "blocked" || a.status === "error";
    const isWorking = a.status === "working";
    const isDone = a.status === "done";
    const inputState = this.ensureInput(a.address);
    const isTyping = this.typingMap.get(a.address) ?? false;

    let badgeText = "Idle";
    let badgeBg = t.surface;
    let badgeColor = t.dim;

    if (isNeedsYou) {
      badgeText = "Needs you";
      badgeBg = (t.blocked ?? "#ef4444") + "20";
      badgeColor = t.blocked ?? "#ef4444";
    } else if (isWorking) {
      badgeText = "Working";
      badgeBg = (t.working ?? "#3b82f6") + "20";
      badgeColor = t.working ?? "#3b82f6";
    } else if (isDone) {
      badgeText = "Done";
      badgeBg = (t.done ?? "#22c55e") + "20";
      badgeColor = t.done ?? "#22c55e";
    }

    return v_flex()
      .id(`inbox-card-${a.address}`)
      .p(10)
      .gap(8)
      .rounded(8)
      .bg(t.raised)
      .border(1)
      .border_color(isNeedsYou ? (t.blocked ?? "#ef4444") + "44" : t.border)
      // Card Header
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .truncate()
              .when(Boolean(pic), (el) => el.child(pic))
              .child(
                div()
                  .text_size(12)
                  .font_semibold()
                  .text_color(t.foreground)
                  .truncate()
                  .child(clean(a.title) || a.program?.name || "Agent"),
              )
              .child(
                div()
                  .px(5)
                  .py(1)
                  .rounded(4)
                  .bg(t.surface)
                  .border_1()
                  .border_color(t.border)
                  .text_size(10)
                  .text_color(t.dim)
                  .child(a.space_name || a.space || "Space"),
              ),
          )
          .child(
            div()
              .px(6)
              .py(1.5)
              .rounded(4)
              .bg(badgeBg)
              .text_size(10)
              .font_semibold()
              .text_color(badgeColor)
              .child(badgeText),
          ),
      )
      // Penjelasan Dulu: Agent Output / Question Snippet
      .child(
        v_flex()
          .p(8)
          .gap(3)
          .rounded(6)
          .bg(t.background)
          .border(1)
          .border_color(t.border)
          .child(
            h_flex()
              .items_center()
              .justify_between()
              .text_size(9)
              .text_color(t.dim)
              .child(div().child("AGENT OUTPUT / QUESTION"))
              .child(div().child(a.address)),
          )
          .child(
            div()
              .font_family(settings().font_family ?? "JetBrains Mono")
              .text_size(11)
              .text_color(t.foreground)
              .child(output),
          ),
      )
      // Execution Actions
      .when(isNeedsYou, (el) =>
        el.child(
          v_flex()
            .gap(6)
            // 1-Click Approve / Reject
            .child(
              h_flex()
                .gap(6)
                .child(
                  h_flex()
                    .h(28)
                    .flex_1()
                    .rounded(6)
                    .bg((t.accent ?? "#3b82f6") + "20")
                    .border(1)
                    .border_color(t.accent ?? "#3b82f6")
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .hover((btn) => btn.bg((t.accent ?? "#3b82f6") + "36"))
                    .on_click((_e, cx) => this.approve(a.address, cx))
                    .child(
                      div()
                        .text_size(11)
                        .font_medium()
                        .text_color(t.accent ?? "#3b82f6")
                        .child("✓ Approve (Yes)"),
                    ),
                )
                .child(
                  h_flex()
                    .h(28)
                    .px(10)
                    .rounded(6)
                    .bg(t.surface)
                    .border(1)
                    .border_color(t.border)
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .hover((btn) => btn.bg(t.hover))
                    .on_click((_e, cx) => this.reject(a.address, cx))
                    .child(
                      div()
                        .text_size(11)
                        .font_medium()
                        .text_color(t.dim)
                        .child("✕ Reject (No)"),
                    ),
                )
                .child(
                  h_flex()
                    .h(28)
                    .px(10)
                    .rounded(6)
                    .bg(t.surface)
                    .border(1)
                    .border_color(t.border)
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .hover((btn) => btn.bg(t.hover))
                    .on_click(() => run("pane.focus", { terminal: a.address }))
                    .child(
                      div()
                        .text_size(11)
                        .font_medium()
                        .text_color(t.muted)
                        .child("Open Terminal →"),
                    ),
                ),
            )
            // Quick reply text box for typing custom answer
            .child(
              h_flex()
                .gap(6)
                .items_center()
                .child(
                  div()
                    .flex_1()
                    .h(28)
                    .px(8)
                    .rounded(6)
                    .bg(t.background)
                    .border(1)
                    .border_color(isTyping ? t.accent : t.border)
                    .flex()
                    .items_center()
                    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                    .child(Input.new(inputState).h_full().text_size(11).text_color(t.foreground)),
                )
                .child(
                  div()
                    .h(28)
                    .px(10)
                    .rounded(6)
                    .bg(t.accent ?? "#3b82f6")
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .hover((btn) => btn.opacity(0.85))
                    .on_click((_e, cx) => this.sendReply(a.address, cx))
                    .child(
                      div()
                        .text_size(11)
                        .font_medium()
                        .text_color("#ffffff")
                        .child("Send ↵"),
                    ),
                ),
            ),
        ),
      )
      .when(isWorking, (el) =>
        el.child(
          h_flex()
            .gap(6)
            .items_center()
            .justify_between()
            .child(
              h_flex()
                .gap(4)
                .items_center()
                .child(
                  svg("mods/workspace-chrome/spinner.svg")
                    .size(11)
                    .text_color(t.working ?? "#3b82f6")
                    .spin(900),
                )
                .child(
                  div()
                    .text_size(11)
                    .text_color(t.working ?? "#3b82f6")
                    .child("Agent is actively processing..."),
                ),
            )
            .child(
              h_flex()
                .gap(6)
                .child(
                  div()
                    .h(26)
                    .px(8)
                    .rounded(5)
                    .bg((t.blocked ?? "#ef4444") + "20")
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .hover((btn) => btn.bg((t.blocked ?? "#ef4444") + "33"))
                    .on_click((_e, cx) => this.interrupt(a.address, cx))
                    .child(
                      div()
                        .text_size(11)
                        .font_semibold()
                        .text_color(t.blocked ?? "#ef4444")
                        .child("Stop"),
                    ),
                )
                .child(
                  div()
                    .h(26)
                    .px(8)
                    .rounded(5)
                    .bg(t.surface ?? "#18181b")
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .hover((btn) => btn.bg(t.hover))
                    .on_click(() => run("pane.focus", { terminal: a.address }))
                    .child(
                      div()
                        .text_size(11)
                        .font_medium()
                        .text_color(t.foreground)
                        .child("Open Terminal →"),
                    ),
                ),
            ),
        ),
      )
      .when(isDone || (!isNeedsYou && !isWorking), (el) =>
        el.child(
          h_flex()
            .gap(6)
            .items_center()
            .justify_between()
            .child(
              h_flex()
                .gap(6)
                .items_center()
                .child(
                  div()
                    .size(6)
                    .rounded_full()
                    .bg(isDone ? (t.done ?? "#22c55e") : t.dim),
                )
                .child(
                  div()
                    .text_size(11)
                    .text_color(t.dim)
                    .child(isDone ? "Completed turn" : "Waiting for next instruction"),
                ),
            )
            .child(
              div()
                .h(26)
                .px(8)
                .rounded(5)
                .bg(t.surface ?? "#18181b")
                .flex()
                .items_center()
                .justify_center()
                .cursor_pointer()
                .hover((btn) => btn.bg(t.hover))
                .on_click(() => run("pane.focus", { terminal: a.address }))
                .child(
                  div()
                    .text_size(11)
                    .font_medium()
                    .text_color(t.foreground)
                    .child("Open Terminal →"),
                ),
            ),
        ),
      );
  }

  render(cx) {
    const t = theme();
    const ags = agents();

    const blockedAgents = ags.filter((a) => a.status === "blocked" || a.status === "error");
    const workingAgents = ags.filter((a) => a.status === "working");
    const doneAgents = ags.filter((a) => a.status === "done");
    const idleAgents = ags.filter(
      (a) => a.status === "idle" || !a.status || (a.status !== "blocked" && a.status !== "working" && a.status !== "done"),
    );

    let shownList = ags;
    if (this.filter === "needs_you") shownList = blockedAgents;
    else if (this.filter === "working") shownList = workingAgents;
    else if (this.filter === "done") shownList = doneAgents;
    else if (this.filter === "idle") shownList = idleAgents;

    // Filter Tab Button
    const filterTab = (key, label, count, color) => {
      const active = this.filter === key;
      return h_flex()
        .id(`inbox-tab-${key}`)
        .h(24)
        .px(7)
        .gap(4)
        .rounded(5)
        .items_center()
        .cursor_pointer()
        .bg(active ? (t.selected ?? t.raised) : "#00000000")
        .text_color(active ? t.foreground : t.dim)
        .hover((el) => el.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => {
          this.filter = key;
          cx.notify();
        })
        .child(
          div()
            .text_size(11)
            .font_medium()
            .child(label),
        )
        .when(count > 0, (el) =>
          el.child(
            div()
              .px(4)
              .h(14)
              .rounded_full()
              .bg(active ? color : (t.raised ?? "#2a2a2e"))
              .text_size(9)
              .font_bold()
              .text_color(active ? "#ffffff" : t.muted)
              .child(String(count)),
          ),
        );
    };

    return v_flex()
      .id("inbox")
      .size_full()
      .min_h(0)
      .rounded(10)
      .overflow_hidden()
      .bg(t.background)
      .border_1()
      .border_color(t.border)
      .text_color(t.foreground)
      .text_size(13)
      // Header: Exactly matches Files and Changes (h=42, px=14)
      .child(
        h_flex()
          .h(42)
          .flex_none()
          .px(14)
          .gap(8)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .child(div().font_semibold().child("Inbox"))
          .when(blockedAgents.length > 0, (el) =>
            el.child(
              div()
                .px(5)
                .py(1)
                .rounded(4)
                .border_1()
                .border_color(t.border)
                .text_size(10)
                .text_color(t.blocked)
                .child(`${blockedAgents.length} needs you`),
            ),
          )
          .child(div().flex_1())
          .child(
            div()
              .size(22)
              .rounded(5)
              .flex()
              .items_center()
              .justify_center()
              .cursor_pointer()
              .hover((el) => el.bg(t.hover))
              .on_click((_e, cx) => this.refreshSnippets(cx))
              .tooltip("Refresh")
              .child(svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.dim)),
          ),
      )
      // Filter Sub-bar: Needs You, Working, Done, Idle, All
      .child(
        h_flex()
          .h(34)
          .flex_none()
          .px(8)
          .gap(4)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .bg(t.chrome ?? t.surface)
          .child(filterTab("needs_you", "Needs you", blockedAgents.length, t.blocked ?? "#ef4444"))
          .child(filterTab("working", "Working", workingAgents.length, t.working ?? "#3b82f6"))
          .child(filterTab("done", "Done", doneAgents.length, t.done ?? "#22c55e"))
          .child(filterTab("idle", "Idle", idleAgents.length, t.dim ?? "#888"))
          .child(filterTab("all", "All", ags.length, t.accent ?? "#3b82f6")),
      )
      // List of Cards
      .child(
        v_flex()
          .id("inbox-list")
          .flex_1()
          .min_h(0)
          .p(8)
          .gap(8)
          .overflow_y_scrollbar()
          .mode("always")
          .when(shownList.length > 0, (el) =>
            el.children(shownList.map((a) => this.renderAgentCard(t, a, cx))),
          )
          .when(shownList.length === 0, (el) =>
            el.child(
              div()
                .p(8)
                .text_size(12)
                .text_color(t.dim)
                .child(
                  this.filter === "needs_you"
                    ? "No agents need approval"
                    : this.filter === "working"
                    ? "No working agents"
                    : this.filter === "done"
                    ? "No completed turns"
                    : this.filter === "idle"
                    ? "No idle agents"
                    : "No agents in inbox",
                ),
            ),
          ),
      );
  }
}
