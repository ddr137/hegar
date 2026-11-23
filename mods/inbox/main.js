// Inbox: Human-in-the-loop interaction center for coding agents
// Handles approvals (y/n), direct questions, terminal explanations, and execution.
// Matches the visual card frame of Files and Changes.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, Scrollbar } from "gpui-base";
import { agents, spaces, terminals, panes, run, theme, exec, hc, settings, readTextFile, home, shared, checking } from "herdr";

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

// Terminal furniture, not the agent's words: box lines, the empty prompt, footers, update notices.
const BOX = /^[\s\u2500-\u257f\u2580-\u259f]*$/u;
const FOOTER = /auto mode|bypass permissions|shift\+tab|esc to interrupt|\? for shortcuts|Update installed|Restart to update|ctrl\+[a-z]|\btokens\)|weekly limit|^\s*(?:\u23bf\s*)?Tip:|turn off recaps|accept edits on|plan mode on/i;

// A screen line without the box sides a dialog is drawn in, and without trailing spaces.
const norm = (l) =>
  String(l)
    .replace(/\s+$/, "")
    .replace(/^\s*[\u2502\u2503\u2551]\s?/, "")
    .replace(/\s*[\u2502\u2503\u2551]$/, "")
    .replace(/\s+$/, "");

// The words on a terminal screen, minus its furniture: the last `keep` lines.
function screenWords(raw, keep = 8) {
  const out = String(raw ?? "")
    .split("\n")
    .map(norm)
    .filter((l) => l.trim() && !BOX.test(l) && !FOOTER.test(l) && !/^\s*\u276f\s*$/.test(l));
  return out.slice(-keep).join("\n");
}

// What an agent that waits on you is asking, from its screen: numbered choices ("1. Yes"), a y/n question, or nothing
// we recognise. -> { style: "numbered" | "yn" | null, question, options: [{ n, label, on }] }
function parsePrompt(raw) {
  const lines = String(raw ?? "").split("\n").map(norm).slice(-70);
  const opt = (l) => /^\s*(?:([\u276f>\u203a])\s*)?(\d)[.)]\s+(\S.*)$/.exec(l);
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (opt(lines[i])) { end = i; break; }
  if (end >= 0) {
    const options = [];
    let start = end;
    for (let i = end; i >= 0; i--) {
      const m = opt(lines[i]);
      if (m) { options.unshift({ n: Number(m[2]), label: m[3].trim(), on: Boolean(m[1]) }); start = i; }
      else if (/^\s{3,}\S/.test(lines[i]) && i > 0) continue; // a choice's second line
      else break;
    }
    if (options.length >= 2) {
      return { style: "numbered", options, question: screenWords(lines.slice(0, start).join("\n"), 9) };
    }
  }
  const yn = lines.findLastIndex((l) => /\((?:y\/n|Y\/n|yes\/no)\)|\[(?:y\/n|Y\/n)\]/.test(l));
  if (yn >= 0) return { style: "yn", options: [], question: screenWords(lines.slice(0, yn + 1).join("\n"), 5) };
  return { style: null, options: [], question: screenWords(lines.join("\n"), 8) };
}

// One status as a visible badge: tinted ground, coloured text, a border and a dot, so that even Idle reads on the card.
function statusMeta(t, status) {
  const blocked = t.blocked ?? "#ef4444";
  const working = t.working ?? "#3b82f6";
  const done = t.done ?? "#22c55e";
  if (status === "blocked" || status === "error") return { key: "blocked", text: "Needs you", fg: blocked, bg: blocked + "26", bd: blocked + "66" };
  if (status === "working") return { key: "working", text: "Working", fg: working, bg: working + "26", bd: working + "66" };
  if (status === "done") return { key: "done", text: "Done", fg: done, bg: done + "26", bd: done + "66" };
  return { key: "idle", text: "Idle", fg: t.muted ?? "#a1a1aa", bg: t.hover ?? "#2a2a30", bd: t.dim ?? "#52525b" };
}
const STATUS_ORDER = ["blocked", "working", "done", "idle"];

// The same colour the sidebar gives a space's avatar.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

const ago = (ms) => {
  const m = Math.floor((Date.now() - ms) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`;
};

// A reply for a small box: blank runs squeezed, cut at 420 characters.
const snip = (t) => {
  const x = String(t ?? "").replace(/\n{3,}/g, "\n\n").trim();
  return x.length > 420 ? x.slice(0, 420).replace(/\s+\S*$/, "") + "\u2026" : x;
};

// What the CLI says it is doing now (its status line), from terminals().
const doingNow = (term) => {
  const r = [term?.report, term?.status].find((x) => x && typeof x === "object" && typeof x.msg === "string" && x.msg.trim());
  return r && !/^answer:/i.test(r.msg.trim()) ? r.msg.trim().split("\n")[0] : "";
};

// The agent's own last reply, from its session log (read only what the end of the file holds).
async function lastReply(a) {
  // an agent on another machine keeps its session log there: we show its screen instead
  if (String(a.address).includes("/")) return null;
  const app = `${a.app ?? ""} ${a.program?.key ?? ""} ${a.program?.name ?? ""}`.toLowerCase();
  const term = terminals().find((t) => t.address === a.address);
  const h = home();
  try {
    if (/claude/.test(app)) {
      const pid = term?.foreground?.pid;
      const info = pid ? JSON.parse((await readTextFile(`${h}/.claude/sessions/${pid}.json`)) || "null") : null;
      if (!info?.sessionId) return null;
      const file = `${h}/.claude/projects/${String(info.cwd ?? term.cwd ?? "").replace(/[^a-zA-Z0-9]/g, "-")}/${info.sessionId}.jsonl`;
      const r = await exec("sh", ["-c", `tail -c 6000000 "${file}" 2>/dev/null | grep '"type":"assistant"' | grep '"type":"text"' | tail -n 4`]);
      for (const line of r.stdout.split("\n").reverse()) {
        try {
          const it = JSON.parse(line);
          if (it.isSidechain) continue;
          const c = it.message?.content;
          const text = (typeof c === "string" ? c : (c ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n")).trim();
          if (text) return { text, at: it.timestamp ? new Date(it.timestamp).getTime() : null };
        } catch {}
      }
    } else if (/antigravity|agy/.test(app)) {
      const base = `${h}/.gemini/antigravity-cli`;
      const map = JSON.parse((await readTextFile(`${base}/cache/last_conversations.json`)) || "{}");
      const id = map[term?.foreground?.cwd || term?.cwd];
      if (!id) return null;
      const file = `${base}/brain/${id}/.system_generated/logs/transcript.jsonl`;
      const r = await exec("sh", ["-c", `tail -c 6000000 "${file}" 2>/dev/null | grep '"type":"PLANNER_RESPONSE"' | grep -v '"content":""' | tail -n 4`]);
      for (const line of r.stdout.split("\n").reverse()) {
        try {
          const it = JSON.parse(line);
          const text = String(it.content ?? "").trim();
          if (text) return { text, at: it.created_at ? new Date(it.created_at).getTime() : null };
        } catch {}
      }
    }
  } catch {}
  return null;
}

export default class InboxView extends View {
  init(_props, cx) {
    // the first view: what waits on you if anything does, else all of them
    this.filter = agents().some((a) => a.status === "blocked" || a.status === "error") ? "needs_you" : "all"; // "needs_you" | "working" | "done" | "idle" | "all"
    this.inputs = new Map(); // address -> InputState
    this.typingMap = new Map(); // address -> boolean
    this.meta = new Map(); // address -> { seq, status, screenAt }
    this.replies = new Map(); // address -> { text, at } : its last reply
    this.prompts = new Map(); // address -> parsePrompt(...) while it waits on you
    this.screens = new Map(); // address -> cleaned screen words (agents we have no log for)
    this.busy = false;
    this.needsFollow = false; // an agent on the shown tab waits on you (set by render)
    this.lastMinute = -1;
    this.foldedProjects = new Set(); // space ids whose agents are folded away
    this.makingInputs = false;
    for (const a of agents()) this.ensureInput(a.address); // answer boxes exist before the first render

    if (checking()) return; // `herdr-app check` runs init for real: no reads, no timer
    this.refreshSnippets(cx);
    // Herdr redraws this mod when agents change, and render() (below) notices which agent changed state, so
    // nothing is polled for that. This timer is for time only: following the question of an agent that waits on
    // you (its screen is not live data) and the "x min ago" labels, once a minute.
    cx.timer.every(3000, (cx) => {
      if (this.needsFollow) this.refreshSnippets(cx);
      const minute = Math.floor(Date.now() / 60000);
      if (minute !== this.lastMinute) {
        this.lastMinute = minute;
        cx.notify();
      }
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

  // The agents on the shown tab.
  shownAgents() {
    const ags = agents();
    const isBlocked = (a) => a.status === "blocked" || a.status === "error";
    if (this.filter === "needs_you") return ags.filter(isBlocked);
    if (this.filter === "working") return ags.filter((a) => a.status === "working");
    if (this.filter === "done") return ags.filter((a) => a.status === "done");
    if (this.filter === "idle") return ags.filter((a) => !isBlocked(a) && a.status !== "working" && a.status !== "done");
    return ags;
  }

  refreshSnippets(cx, force = false) {
    if (this.busy) return;
    this.busy = true;
    // a task of its own (cx.spawn): a callback's cx must not be used after the callback returns
    cx.spawn(async (cx) => {
      let changed = false;
      try {
        let reads = 0;
        for (const a of this.shownAgents()) {
          this.ensureInput(a.address);
          const m = this.meta.get(a.address) ?? {};
          const blocked = a.status === "blocked" || a.status === "error";
          const moved = force || m.seq !== a.seq || m.status !== a.status;
          const followQuestion = blocked && Date.now() - (m.screenAt ?? 0) > 3000;
          if (!moved && !followQuestion) continue;
          if (++reads > 4) break; // a few per tick

          if (blocked) {
            const res = await hc(["read", a.address]);
            if (res.code === 0 && res.stdout) {
              const next = parsePrompt(res.stdout);
              const prev = this.prompts.get(a.address);
              if (JSON.stringify(prev) !== JSON.stringify(next)) changed = true;
              this.prompts.set(a.address, next);
            }
            m.screenAt = Date.now();
          } else if (this.prompts.has(a.address)) {
            this.prompts.delete(a.address);
            changed = true;
          }

          if (moved) {
            const reply = await lastReply(a);
            if (reply) this.replies.set(a.address, reply);
            else if (!blocked) {
              // an agent we cannot read a log of: its screen, minus the terminal's furniture
              const res = await hc(["read", a.address]);
              if (res.code === 0 && res.stdout) this.screens.set(a.address, screenWords(res.stdout, 6));
            }
            changed = true;
          }
          this.meta.set(a.address, { ...m, seq: a.seq, status: a.status });
        }
      } catch {
        // optional reads
      }
      this.busy = false;
      if (changed) cx.notify();
    });
  }

  // y / n for a "(y/n)" question
  approve(addr, cx) {
    cx.spawn(async (cx) => {
      await hc(["keys", addr, "y", "enter"]);
      run("pane.focus", { terminal: addr });
      this.refreshSnippets(cx, true);
    });
  }

  reject(addr, cx) {
    cx.spawn(async (cx) => {
      await hc(["keys", addr, "n", "enter"]);
      run("pane.focus", { terminal: addr });
      this.refreshSnippets(cx, true);
    });
  }

  // A numbered choice: its number, then Enter
  choose(addr, n, cx) {
    cx.spawn(async (cx) => {
      await hc(["keys", addr, String(n), "enter"]);
      this.refreshSnippets(cx, true);
    });
  }

  sendReply(addr, cx) {
    const inp = this.inputs.get(addr);
    const val = inp?.value()?.trim();
    if (!val) return;
    cx.spawn(async (cx) => {
      await hc(["send", addr, val]);
      inp.set_value("");
      run("pane.focus", { terminal: addr });
      this.refreshSnippets(cx, true);
    });
  }

  interrupt(addr, cx) {
    cx.spawn(async (cx) => {
      await hc(["interrupt", addr]);
      this.refreshSnippets(cx, true);
    });
  }

  // The agents by project (space); the project with the most urgent agent first, else the sidebar's order.
  groupsOf(list) {
    const rank = (a) => {
      const i = STATUS_ORDER.indexOf(a.status === "error" ? "blocked" : STATUS_ORDER.includes(a.status) ? a.status : "idle");
      return i < 0 ? 3 : i;
    };
    const byId = new Map();
    for (const a of list) {
      const id = a.space ?? a.space_name ?? "?";
      if (!byId.has(id)) byId.set(id, { id, name: a.space_name || String(id), agents: [], first: byId.size });
      byId.get(id).agents.push(a);
    }
    const groups = [...byId.values()];
    for (const g of groups) {
      g.agents.sort((x, y) => rank(x) - rank(y));
      g.urgency = Math.min(...g.agents.map(rank));
    }
    return groups.sort((x, y) => x.urgency - y.urgency || x.first - y.first);
  }

  statusBadge(t, status, count) {
    const m = statusMeta(t, status);
    return h_flex()
      .flex_none()
      .gap(5)
      .items_center()
      .px(7)
      .py(2)
      .rounded(5)
      .bg(m.bg)
      .border_1()
      .border_color(m.bd)
      .child(div().size(6).rounded_full().bg(m.fg))
      .child(div().text_size(10.5).font_semibold().text_color(m.fg).child(count ? `${count} ${m.text}` : m.text));
  }

  // One project (space) and the agents running in it: a header you can fold, its agents under it.
  renderGroup(t, g, cx) {
    const colors = shared("space.colors") ?? {};
    const key = colors[g.id] ?? "ansi4";
    const fill = key.startsWith("#") ? key : MARK[key] ?? t[key] ?? "#5b8def";
    const folded = this.foldedProjects.has(g.id);
    const counts = {};
    for (const a of g.agents) {
      const k = statusMeta(t, a.status).key;
      counts[k] = (counts[k] ?? 0) + 1;
    }
    return v_flex()
      .gap(6)
      .child(
        h_flex()
          .id(`inbox-group-${g.id}`)
          .gap(8)
          .items_center()
          .px(4)
          .py(3)
          .rounded(6)
          .cursor_pointer()
          .hover((el) => el.bg(t.hover))
          .on_click((_e, cx) => {
            if (folded) this.foldedProjects.delete(g.id);
            else this.foldedProjects.add(g.id);
            cx.notify();
          })
          .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none().text_color(t.dim))
          .child(
            h_flex()
              .size(18)
              .flex_none()
              .rounded(5)
              .bg(fill)
              .items_center()
              .justify_center()
              .text_size(10.5)
              .font_bold()
              .text_color("#ffffff")
              .child(([...g.name][0] ?? "?").toUpperCase()),
          )
          .child(div().min_w(0).text_size(13).font_semibold().text_color(t.foreground).truncate().child(g.name))
          .child(div().flex_none().text_size(11).text_color(t.muted).child(g.agents.length === 1 ? "1 agent" : `${g.agents.length} agents`))
          .child(div().flex_1())
          .children(STATUS_ORDER.filter((k) => counts[k]).map((k) => this.statusBadge(t, k === "blocked" ? "blocked" : k, counts[k]))),
      )
      .when(!folded, (el) =>
        el.child(
          v_flex()
            .ml(13)
            .pl(10)
            .gap(8)
            .border_l(2)
            .border_color(t.border)
            .children(g.agents.map((a) => this.renderAgentCard(t, a, cx))),
        ),
      );
  }

  openTerminalButton(t, a, flex = false) {
    return h_flex()
      .h(28)
      .px(10)
      .when(flex, (el) => el.flex_1())
      .rounded(6)
      .bg(t.surface)
      .border(1)
      .border_color(t.border)
      .items_center()
      .justify_center()
      .cursor_pointer()
      .hover((btn) => btn.bg(t.hover))
      .on_click(() => run("pane.focus", { terminal: a.address }))
      .child(div().text_size(11).font_medium().text_color(t.muted).child("Open Terminal \u2192"));
  }

  // How to answer: the choices it shows (numbered), Approve / Reject for a y/n question, else only the terminal.
  needsRow(t, a, prompt, cx) {
    if (prompt?.style === "numbered") {
      const yes = (o) => /^(yes|allow|approve|proceed|continue|ok)\b/i.test(o.label);
      return v_flex()
        .gap(4)
        .children(
          prompt.options.map((o) =>
            h_flex()
              .id(`inbox-opt-${a.address}-${o.n}`)
              .min_h(28)
              .px(10)
              .py(4)
              .gap(8)
              .rounded(6)
              .items_center()
              .bg(yes(o) ? (t.accent ?? "#3b82f6") + "20" : t.surface)
              .border(1)
              .border_color(yes(o) ? t.accent ?? "#3b82f6" : t.border)
              .cursor_pointer()
              .hover((btn) => btn.bg(yes(o) ? (t.accent ?? "#3b82f6") + "36" : t.hover))
              .on_click((_e, cx) => this.choose(a.address, o.n, cx))
              .child(div().flex_none().text_size(11).font_semibold().text_color(yes(o) ? t.accent ?? "#3b82f6" : t.dim).child(String(o.n)))
              .child(div().flex_1().min_w(0).text_size(11).text_color(yes(o) ? t.accent ?? "#3b82f6" : t.foreground).child(o.label)),
          ),
        )
        .child(this.openTerminalButton(t, a, true));
    }
    if (prompt?.style === "yn") return this.yesNoRow(t, a, cx);
    return h_flex().child(this.openTerminalButton(t, a, true));
  }

  yesNoRow(t, a, cx) {
    return h_flex()
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
                );
  }

  renderAgentCard(t, a, cx) {
    const pic = icon(a.program, 15, t.foreground);
    const term = terminals().find((x) => x.address === a.address);
    const prompt = this.prompts.get(a.address);
    const reply = this.replies.get(a.address);
    const isNeedsYou = a.status === "blocked" || a.status === "error";
    const isWorking = a.status === "working";
    const isDone = a.status === "done";
    // made outside render (init, or a task render starts): Herdr refuses InputState.new during render
    const inputState = this.inputs.get(a.address);
    const isTyping = this.typingMap.get(a.address) ?? false;

    return v_flex()
      .id(`inbox-card-${a.address}`)
      .p(10)
      .gap(8)
      .rounded(8)
      .bg(t.raised)
      .border(1)
      .border_color(isNeedsYou ? (t.blocked ?? "#ef4444") + "44" : t.border)
      // Card Header: the agent, what it is, and its state
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .gap(8)
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .flex_1()
              .min_w(0)
              .when(Boolean(pic), (el) => el.child(pic))
              .child(
                div()
                  .min_w(0)
                  .text_size(12)
                  .font_semibold()
                  .text_color(t.foreground)
                  .truncate()
                  .child(clean(a.title) || a.program?.name || "Agent"),
              )
          )
          .child(this.statusBadge(t, a.status)),
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
              .child(div().child(isNeedsYou ? "WAITING FOR YOUR ANSWER" : reply?.at ? `LAST REPLY \u00b7 ${ago(reply.at).toUpperCase()}` : reply ? "LAST REPLY" : "ON SCREEN"))
              .child(div().child(a.address)),
          )
          .child(
            div()
              .max_h(isNeedsYou ? 150 : 96)
              .overflow_hidden()
              .text_size(isNeedsYou ? 11 : 11.5)
              .text_color(t.foreground)
              .when(isNeedsYou, (el) => el.font_family(settings().font_family ?? "JetBrains Mono"))
              .child(
                isNeedsYou
                  ? prompt?.question || snip(reply?.text) || clean(a.title) || "Open the terminal to see what it asks."
                  : snip(reply?.text) || this.screens.get(a.address) || clean(a.title) || "No output yet.",
              ),
          ),
      )
      // Execution Actions
      .when(isNeedsYou, (el) =>
        el.child(
          v_flex()
            .gap(6)
            .child(this.needsRow(t, a, prompt, cx))
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
                    .child(inputState
                      ? Input.new(inputState).h_full().text_size(11).text_color(t.foreground)
                      : div().text_size(11).text_color(t.dim).child("Type an answer or instruction to agent…")),
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
                        .text_color(t.accent_foreground ?? "#ffffff")
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
                .flex_1()
                .min_w(0)
                .child(
                  svg("mods/workspace-chrome/spinner.svg")
                    .size(11)
                    .flex_none()
                    .text_color(t.working ?? "#3b82f6")
                    .spin(900),
                )
                .child(
                  div()
                    .flex_1()
                    .min_w(0)
                    .truncate()
                    .text_size(11)
                    .text_color(t.working ?? "#3b82f6")
                    .child(doingNow(term) || "Working\u2026"),
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

    // what changed since the last read: an agent that moved on (its state or `seq`) gets its reply read again
    this.needsFollow = shownList.some((a) => a.status === "blocked" || a.status === "error");
    if (!this.busy && shownList.some((a) => {
      const m = this.meta.get(a.address);
      return !m || m.seq !== a.seq || m.status !== a.status;
    })) this.refreshSnippets(cx);
    // an agent shown for the first time gets its answer box from a task, not from render itself
    const missing = shownList.filter((a) => !this.inputs.has(a.address));
    if (missing.length && !this.makingInputs) {
      this.makingInputs = true;
      cx.spawn(async (cx) => {
        this.makingInputs = false;
        for (const a of missing) this.ensureInput(a.address);
        cx.notify();
      });
    }

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
          this.refreshSnippets(cx);
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
              .hover((el) => el.bg(t.hover).text_color(t.foreground))
              .on_click((_e, cx) => this.refreshSnippets(cx, true))
              .tooltip("Refresh Inbox")
              .child(svg("mods/inbox/refresh.svg").size(13).text_color(t.dim)),
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
            el.children(this.groupsOf(shownList).map((g) => this.renderGroup(t, g, cx))),
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
