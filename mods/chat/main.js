import { View, div, svg, image, PathBuilder, Background } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { panes, terminals, props, run, theme, exec, readTextFile, home, notify } from "herdr";

const RECT = () =>
  PathBuilder.fill()
    .move_to("0%", "0%")
    .line_to("100%", "0%")
    .line_to("100%", "100%")
    .line_to("0%", "100%")
    .close()
    .build();

export default class ChatView extends View {
  init(_props, cx) {
    this.terminal = props()?.terminal || null;
    this.messages = [];
    this.agentName = "AI Agent";
    this.modelName = "Claude 3.7 Sonnet";
    this.effort = "Thinking (High effort)";
    this.status = "idle";
    this.angle = 0;
    this.inputState = InputState.new({ placeholder: "Type a prompt or instruction... (Press Enter to send)" });
    this.foldedThinking = new Set();
    this.answeredCards = new Set();
    this.interactiveCard = null;
    this.busy = false;

    // Resolve target terminal
    this.resolveTarget();

    // Rotate gradient animation
    cx.timer.every(40, (cx) => {
      this.angle = (this.angle + 4) % 360;
      cx.notify();
    });

    // Polling agent session logs
    this.pollLogs(cx);
    cx.timer.every(1500, (cx) => this.pollLogs(cx));
  }

  resolveTarget() {
    if (!this.terminal) {
      const all = terminals().filter((t) => t.state === "live");
      const ag = all.find((t) => t.foreground?.name === "claude" || t.foreground?.name === "agy" || t.program?.agent);
      this.terminal = ag?.address || all[0]?.address || "t28";
    }
  }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  toTerminal(cx) {
    run("layout.select", { stack: "main-stack", child: "main" });
    if (cx) cx.notify();
  }

  async sendPrompt(text, cx) {
    if (!text || !text.trim()) return;
    const cleanText = text.trim();
    this.inputState.set_value("");

    this.messages.push({
      id: `local-${Date.now()}`,
      role: "user",
      text: cleanText,
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    });

    try {
      await exec("hc", ["send", this.terminal, cleanText]);
    } catch {}

    if (cx) cx.notify();
  }

  async answerCard(cardId, optionText, cx) {
    this.answeredCards.add(cardId);
    this.interactiveCard = null;
    this.messages.push({
      id: `ans-${Date.now()}`,
      role: "user",
      text: `Selected: ${optionText}`,
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    });

    try {
      await exec("hc", ["send", this.terminal, optionText]);
    } catch {}

    if (cx) cx.notify();
  }

  async pollLogs(cx) {
    const term = terminals().find((t) => t.address === this.terminal);
    if (!term) return;

    const isAgy = term.foreground?.name === "agy" || term.program?.key === "antigravity" || term.address === "t28";
    const isClaude = term.foreground?.name === "claude" || term.program?.key === "claude" || term.address === "t2c";

    if (isAgy) {
      this.agentName = "Antigravity";
      this.modelName = "Gemini 3.8 Flash (High)";
      this.effort = "Thinking (High effort)";
      this.status = term.status?.state || (term.status === "working" ? "working" : "idle");
      await this.parseAntigravityLogs();
    } else if (isClaude) {
      this.agentName = "Claude Code";
      this.modelName = "Claude 3.7 Sonnet";
      this.effort = "Thinking (Extended effort)";
      this.status = term.status?.state || (term.status === "working" ? "working" : "idle");
      await this.parseClaudeLogs(term.cwd || "/Users/ddr/projects/hegar");
    } else {
      this.agentName = term.title || term.program?.name || "Agent";
      this.modelName = "AI Model";
      this.effort = "Standard effort";
      this.status = term.status || "idle";
      await this.parseGenericLogs();
    }

    if (cx) cx.notify();
  }

  async parseAntigravityLogs() {
    try {
      const h = home();
      const res = await exec("sh", ["-c", `ls -td "${h}/.gemini/antigravity-cli/brain"/*/ 2>/dev/null | head -n 1`]);
      if (res.code !== 0 || !res.stdout.trim()) return;

      const latestDir = res.stdout.trim();
      const transcriptPath = `${latestDir}/.system_generated/logs/transcript.jsonl`;
      const raw = await readTextFile(transcriptPath);
      if (!raw) return;

      const lines = raw.trim().split("\n");
      const sliceLines = lines.slice(-60);
      const parsedMsgs = [];
      let pendingCard = null;

      for (const line of sliceLines) {
        try {
          const item = JSON.parse(line);
          if (item.model) {
            this.modelName = item.model.includes("flash") ? "Gemini 3.8 Flash (High)" : item.model;
          }

          if (item.source === "USER_EXPLICIT" || item.type === "USER_INPUT") {
            let text = item.content || "";
            text = text.replace(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i, "$1")
              .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, "")
              .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, "")
              .trim();
            if (text) {
              parsedMsgs.push({
                id: `step-${item.step_index}`,
                role: "user",
                text,
                time: item.created_at ? new Date(item.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "",
              });
            }
          } else if (item.type === "PLANNER_RESPONSE") {
            const text = (item.content || "").trim();
            const thinking = (item.thinking || "").trim();
            const toolCalls = (item.tool_calls || []).map((t) => ({
              name: t.name,
              summary: t.args?.toolSummary || t.name,
            }));

            const qCall = (item.tool_calls || []).find((t) => t.name === "ask_question");
            if (qCall?.args?.questions?.[0]) {
              const q = qCall.args.questions[0];
              const cardId = `q-${item.step_index}`;
              if (!this.answeredCards.has(cardId)) {
                pendingCard = {
                  id: cardId,
                  question: q.question,
                  options: q.options || ["Yes", "No"],
                };
              }
            }

            if (text || thinking || toolCalls.length) {
              parsedMsgs.push({
                id: `step-${item.step_index}`,
                role: "assistant",
                text,
                thinking,
                toolCalls,
                time: item.created_at ? new Date(item.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "",
              });
            }
          }
        } catch {}
      }

      if (parsedMsgs.length > 0) {
        this.messages = parsedMsgs;
      }
      this.interactiveCard = pendingCard;
    } catch {}
  }

  async parseClaudeLogs(cwd) {
    try {
      const h = home();
      const slug = cwd.replace(/[\\/]/g, "-");
      const projDir = `${h}/.claude/projects/${slug}`;
      const res = await exec("sh", ["-c", `ls -t "${projDir}"/*.jsonl 2>/dev/null | head -n 1`]);
      if (res.code !== 0 || !res.stdout.trim()) return;

      const latestFile = res.stdout.trim();
      const raw = await readTextFile(latestFile);
      if (!raw) return;

      const lines = raw.trim().split("\n");
      const parsedMsgs = [];
      let pendingCard = null;

      for (const line of lines.slice(-50)) {
        try {
          const item = JSON.parse(line);
          if (item.type === "user" && item.message?.content) {
            let content = item.message.content;
            if (typeof content === "string" && !content.includes("<local-command-caveat>")) {
              const text = content.replace(/<command-name>.*?<\/command-name>/g, "")
                .replace(/<command-message>.*?<\/command-message>/g, "")
                .replace(/<command-args>.*?<\/command-args>/g, "")
                .trim();
              if (text) {
                parsedMsgs.push({
                  id: item.uuid || `u-${parsedMsgs.length}`,
                  role: "user",
                  text,
                  time: item.timestamp ? new Date(item.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "",
                });
              }
            }
          } else if (item.type === "assistant" && item.message?.content) {
            let text = "";
            if (typeof item.message.content === "string") text = item.message.content;
            else if (Array.isArray(item.message.content)) {
              text = item.message.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
            }
            if (text.trim()) {
              parsedMsgs.push({
                id: item.uuid || `a-${parsedMsgs.length}`,
                role: "assistant",
                text: text.trim(),
                time: item.timestamp ? new Date(item.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "",
              });

              if (text.includes("Allow") || text.includes("(y/n)") || text.includes("[y/n]")) {
                const cardId = `perm-${item.uuid || Date.now()}`;
                if (!this.answeredCards.has(cardId)) {
                  pendingCard = {
                    id: cardId,
                    question: "Permission Request from Claude Code",
                    options: ["y (Allow)", "n (Deny)"],
                  };
                }
              }
            }
          }
        } catch {}
      }

      if (parsedMsgs.length > 0) {
        this.messages = parsedMsgs;
      }
      this.interactiveCard = pendingCard;
    } catch {}
  }

  async parseGenericLogs() {
    try {
      const res = await exec("hc", ["read", this.terminal]);
      if (res.code === 0 && res.stdout) {
        const text = res.stdout.trim().split("\n").slice(-30).join("\n");
        if (text && (!this.messages.length || this.messages[0].id === "fallback")) {
          this.messages = [
            {
              id: "fallback",
              role: "assistant",
              text,
              time: "Live terminal screen",
            },
          ];
        }
      }
    } catch {}
  }

  renderHeader(t) {
    const isAgy = this.agentName === "Antigravity";
    const agentIcon = isAgy ? "icons/antigravity.svg" : "icons/claude.svg";

    return h_flex()
      .relative()
      .h(34)
      .px(12)
      .items_center()
      .justify_between()
      .bg(t.chrome ?? t.surface)
      .border_b(1)
      .border_color(t.border)
      // Left: Agent Name, Model Badge, Effort
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(image(agentIcon).w(15).h(15).flex_none())
          .child(
            div()
              .font_semibold()
              .text_size(12.5)
              .text_color(t.foreground)
              .child(this.agentName),
          )
          .child(
            div()
              .px(6)
              .py(1)
              .rounded(4)
              .bg((t.accent ?? "#3b82f6") + "22")
              .border(1)
              .border_color((t.accent ?? "#3b82f6") + "44")
              .text_size(10.5)
              .font_medium()
              .text_color(t.accent ?? "#38bdf8")
              .child(this.modelName),
          )
          .child(
            h_flex()
              .px(6)
              .py(1)
              .gap(4)
              .items_center()
              .rounded(4)
              .bg(t.surface ?? "#1e1e24")
              .border(1)
              .border_color(t.border)
              .when(this.status === "working", (el) =>
                el.child(
                  svg("mods/workspace-chrome/spinner.svg")
                    .size(10)
                    .text_color(t.working ?? "#38bdf8")
                    .spin(900),
                ),
              )
              .child(
                div()
                  .text_size(10.5)
                  .text_color(this.status === "working" ? (t.working ?? "#38bdf8") : t.dim)
                  .child(this.effort),
              ),
          ),
      )
      // Right: [ Terminal | Chat ] Toggle + Window actions
      .child(
        h_flex()
          .gap(8)
          .items_center()
          // Segmented switch
          .child(
            h_flex()
              .p(1.5)
              .gap(2)
              .rounded(5)
              .bg(t.raised ?? "#222228")
              .border(1)
              .border_color(t.border)
              .child(
                div()
                  .px(7)
                  .py(1.5)
                  .rounded(4)
                  .text_size(10.5)
                  .font_medium()
                  .text_color(t.dim)
                  .hover((el) => el.bg(t.hover).text_color(t.foreground))
                  .cursor_pointer()
                  .on_click((_e, cx) => this.toTerminal(cx))
                  .child("Terminal"),
              )
              .child(
                div()
                  .px(7)
                  .py(1.5)
                  .rounded(4)
                  .text_size(10.5)
                  .font_semibold()
                  .bg(t.accent ?? "#3b82f6")
                  .text_color("#ffffff")
                  .child("Chat"),
              ),
          )
          // Zoom button
          .child(
            div()
              .p(3)
              .rounded(4)
              .text_color(t.dim)
              .hover((el) => el.bg(t.hover).text_color(t.foreground))
              .cursor_pointer()
              .on_click(() => {
                const myPane = this.me()?.pane;
                if (myPane) run("pane.zoom", { pane: myPane });
              })
              .child(svg("mods/pane/zoom.svg").size(13)),
          )
          // Close button
          .child(
            div()
              .p(3)
              .rounded(4)
              .text_color(t.dim)
              .hover((el) => el.bg(t.hover).text_color(t.foreground))
              .cursor_pointer()
              .on_click(() => {
                const myPane = this.me()?.pane;
                if (myPane) run("pane.close", { pane: myPane });
              })
              .child(svg("mods/pane/close.svg").size(13)),
          ),
      )
      // Rotating Gradient Line across bottom of header!
      .child(
        div()
          .absolute()
          .bottom(-1)
          .left(0)
          .right(0)
          .h(2)
          .child(
            window.paint_path(
              RECT(),
              Background.linear_gradient(this.angle, "#38bdf8", "#ec4899"),
            ),
          ),
      );
  }

  renderInteractiveCard(t, card) {
    return v_flex()
      .mx(16)
      .mb(8)
      .p(12)
      .gap(8)
      .rounded(8)
      .bg((t.raised ?? "#222228") + "ee")
      .border(1.5)
      .border_color(t.accent ?? "#38bdf8")
      .shadow_lg()
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .child(div().size(7).rounded_full().bg(t.accent ?? "#38bdf8"))
              .child(
                div()
                  .text_size(11.5)
                  .font_bold()
                  .text_color(t.foreground)
                  .child("Action Required from Agent"),
              ),
          )
          .child(
            div()
              .px(6)
              .py(1)
              .rounded(4)
              .bg((t.blocked ?? "#ef4444") + "26")
              .text_size(10)
              .font_semibold()
              .text_color(t.blocked ?? "#ef4444")
              .child("Needs you"),
          ),
      )
      .child(
        div()
          .text_size(12)
          .text_color(t.muted)
          .child(card.question),
      )
      .child(
        h_flex()
          .flex_wrap()
          .gap(6)
          .children(
            card.options.map((opt) =>
              div()
                .px(10)
                .py(4)
                .rounded(5)
                .bg(opt.toLowerCase().includes("allow") || opt.toLowerCase().includes("yes") || opt.startsWith("y ") ? (t.accent ?? "#3b82f6") : (t.hover ?? "#333"))
                .hover((el) => el.opacity(0.85))
                .cursor_pointer()
                .text_size(11.5)
                .font_medium()
                .text_color("#ffffff")
                .on_click((_e, cx) => this.answerCard(card.id, opt.split(" ")[0], cx))
                .child(opt),
            ),
          ),
      );
  }

  renderMessageItem(t, m) {
    const isUser = m.role === "user";
    const isFolded = this.foldedThinking.has(m.id);

    if (isUser) {
      return h_flex()
        .w_full()
        .justify_end()
        .px(16)
        .py(4)
        .child(
          v_flex()
            .max_w(560)
            .gap(3)
            .child(
              h_flex()
                .justify_end()
                .gap(6)
                .items_center()
                .child(div().text_size(10).text_color(t.dim).child(m.time))
                .child(div().text_size(11).font_semibold().text_color(t.muted).child("You")),
            )
            .child(
              div()
                .px(12)
                .py(8)
                .rounded(10)
                .bg(t.raised ?? "#222228")
                .border(1)
                .border_color(t.border)
                .text_size(12.5)
                .text_color(t.foreground)
                .child(m.text),
            ),
        );
    }

    // Assistant Message
    const isAgy = this.agentName === "Antigravity";
    const agentIcon = isAgy ? "icons/antigravity.svg" : "icons/claude.svg";

    return h_flex()
      .w_full()
      .justify_start()
      .px(16)
      .py(4)
      .child(
        v_flex()
          .max_w(680)
          .gap(4)
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .child(image(agentIcon).w(13).h(13).flex_none())
              .child(div().text_size(11).font_semibold().text_color(t.foreground).child(this.agentName))
              .child(div().text_size(10).text_color(t.dim).child(m.time)),
          )
          // Collapsible Thought / Thinking Process
          .when(Boolean(m.thinking), (el) =>
            el.child(
              v_flex()
                .rounded(6)
                .bg(t.surface ?? "#1b1b20")
                .border(1)
                .border_color(t.border)
                .p(6)
                .gap(4)
                .child(
                  h_flex()
                    .items_center()
                    .justify_between()
                    .cursor_pointer()
                    .on_click((_e, cx) => {
                      if (isFolded) this.foldedThinking.delete(m.id);
                      else this.foldedThinking.add(m.id);
                      cx.notify();
                    })
                    .child(
                      h_flex()
                        .gap(4)
                        .items_center()
                        .child(
                          svg(`mods/workspace-chrome/chevron-${isFolded ? "right" : "down"}.svg`)
                            .size(10)
                            .text_color(t.dim),
                        )
                        .child(
                          div()
                            .text_size(10.5)
                            .font_medium()
                            .text_color(t.dim)
                            .child("Thinking Process (Effort)"),
                        ),
                    ),
                )
                .when(!isFolded, (body) =>
                  body.child(
                    div()
                      .pt(2)
                      .text_size(11)
                      .font_family("monospace")
                      .text_color(t.muted)
                      .child(m.thinking.slice(0, 400) + (m.thinking.length > 400 ? "..." : "")),
                  ),
                ),
            ),
          )
          // Tool calls chips
          .when(Boolean(m.toolCalls && m.toolCalls.length > 0), (el) =>
            el.child(
              h_flex()
                .flex_wrap()
                .gap(4)
                .children(
                  m.toolCalls.map((tc) =>
                    h_flex()
                      .px(6)
                      .py(2)
                      .rounded(4)
                      .bg(t.surface ?? "#1a1a20")
                      .border(1)
                      .border_color(t.border)
                      .text_size(10)
                      .text_color(t.dim)
                      .child(`🔧 ${tc.summary || tc.name}`),
                  ),
                ),
            ),
          )
          // Main text content
          .when(Boolean(m.text), (el) =>
            el.child(
              div()
                .px(12)
                .py(8)
                .rounded(10)
                .bg(t.surface ?? "#18181c")
                .border(1)
                .border_color(t.border)
                .text_size(12.5)
                .text_color(t.foreground)
                .child(m.text),
            ),
          ),
      );
  }

  render(cx) {
    const t = theme();

    return v_flex()
      .size_full()
      .bg(t.background)
      .rounded(10)
      .border(1)
      .border_color(t.border)
      .overflow_hidden()
      // 1. Header with [ Terminal | Chat ] toggle & rotating gradient
      .child(this.renderHeader(t))
      // 2. Chat messages list
      .child(
        v_flex()
          .id("chat-messages-container")
          .flex_1()
          .min_h(0)
          .py(8)
          .gap(6)
          .overflow_y_scrollbar()
          .mode("always")
          .children(this.messages.map((m) => this.renderMessageItem(t, m))),
      )
      // 3. Interactive Question / Permission Card if pending
      .when(Boolean(this.interactiveCard), (el) =>
        el.child(this.renderInteractiveCard(t, this.interactiveCard)),
      )
      // 4. Rich Input Box
      .child(
        v_flex()
          .px(14)
          .py(8)
          .gap(6)
          .bg(t.chrome ?? t.surface)
          .border_t(1)
          .border_color(t.border)
          // Shortcut chips
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .child(
                div()
                  .px(6)
                  .py(1.5)
                  .rounded(4)
                  .bg(t.surface ?? "#222")
                  .hover((el) => el.bg(t.hover))
                  .cursor_pointer()
                  .text_size(10.5)
                  .text_color(t.dim)
                  .on_click((_e, cx) => this.sendPrompt("/usage", cx))
                  .child("/usage"),
              )
              .child(
                div()
                  .px(6)
                  .py(1.5)
                  .rounded(4)
                  .bg(t.surface ?? "#222")
                  .hover((el) => el.bg(t.hover))
                  .cursor_pointer()
                  .text_size(10.5)
                  .text_color(t.dim)
                  .on_click((_e, cx) => this.sendPrompt("/quota", cx))
                  .child("/quota"),
              )
              .child(
                div()
                  .px(6)
                  .py(1.5)
                  .rounded(4)
                  .bg(t.surface ?? "#222")
                  .hover((el) => el.bg(t.hover))
                  .cursor_pointer()
                  .text_size(10.5)
                  .text_color(t.dim)
                  .on_click((_e, cx) => this.sendPrompt("/clear", cx))
                  .child("/clear"),
              ),
          )
          // Input field and send button
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .child(
                div()
                  .flex_1()
                  .px(10)
                  .h(32)
                  .rounded(6)
                  .bg(t.background)
                  .border(1)
                  .border_color(t.border)
                  .flex()
                  .items_center()
                  .on_action("enter", (_e, cx) => {
                    this.sendPrompt(this.inputState.text(), cx);
                  })
                  .child(
                    Input.new(this.inputState)
                      .flex_1()
                      .h(32)
                      .text_size(12)
                      .text_color(t.foreground),
                  ),
              )
              .child(
                div()
                  .h(32)
                  .px(12)
                  .rounded(6)
                  .bg(t.accent ?? "#3b82f6")
                  .hover((el) => el.opacity(0.85))
                  .cursor_pointer()
                  .flex()
                  .items_center()
                  .justify_center()
                  .gap(4)
                  .text_size(11.5)
                  .font_semibold()
                  .text_color("#ffffff")
                  .on_click((_e, cx) => this.sendPrompt(this.inputState.text(), cx))
                  .child("Send")
                  .child(svg("mods/workspace-chrome/chevron-right.svg").size(11)),
              ),
          ),
      );
  }
}
