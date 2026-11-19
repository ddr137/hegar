import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, appHome } from "herdr";
import * as fs from "fs/promises";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;

// Text draws a tab as nothing: pad each to the next 4-column stop.
const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));

// Numbers each diff line once, so a frame only draws the rows on screen.
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: untab(line.slice(1)) || " " };
    if (kind === "+") return { kind, number: next++, text: untab(line.slice(1)) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: untab(line.slice(1)) || " " }; }
    return { kind: "", text: line };
  });
}

// AI commit message: the diff goes to Google's Gemini API with the key the person saved in this panel.
const DEFAULT_MODEL = "gemini-flash-latest";
const DIFF_LIMIT = 30000, FRESH_FILES = 8, FRESH_LIMIT = 2500;
const SYSTEM = "You write git commit messages. Reply with ONLY the commit message, no quotes, no code fences, no explanation. " +
  "One line, imperative mood, at most 72 characters. Follow the style of the recent commit subjects given (for example Conventional Commits " +
  "like 'fix(scope): ...' when they use it). Describe what the change does and why it matters, not which files changed.";
// POST JSON to Gemini with curl: Herdr's fetch gives up long before Gemini answers when Google is busy (a minute or two
// has happened), and curl can wait. curl reads the key and the body from files in a folder only this user can open
// (never from its command line). Where curl cannot start, Herdr's fetch does it.
const WAIT = 170, RETRIES = 4;
async function post(url, key, payload) {
  const body = JSON.stringify(payload);
  const dir = `${appHome()}/data/changesplus`, id = `${Date.now()}`, cfg = `${dir}/${id}.cfg`, req = `${dir}/${id}.json`;
  try {
    const made = await exec("sh", ["-c", 'umask 077; mkdir -p "$1"', "sh", dir]);
    if (made.code !== 0) throw new Error(made.stderr);
    await fs.writeFile(req, body);
    await fs.writeFile(cfg, `url = "${url}"\nheader = "content-type: application/json"\nheader = "x-goog-api-key: ${key.replace(/[\\"\r\n]/g, "")}"\n`);
    const r = await exec("curl", ["-sS", "-m", String(WAIT), "-K", cfg, "--data-binary", `@${req}`, "-w", "\n%{http_code}"], { timeout: (WAIT + 10) * 1000 });
    if (r.code === 127) throw new Error("curl: program not found");
    if (r.code !== 0) throw Object.assign(new Error((r.stderr || r.stdout).trim() || `curl exit ${r.code}`), { sent: true });
    const at = r.stdout.lastIndexOf("\n");
    return { status: Number(r.stdout.slice(at + 1)), text: r.stdout.slice(0, at) };
  } catch (e) {
    if (e.sent || !/not found|cannot start|No such file/i.test(String(e))) throw e;
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key }, body });
    return { status: res.status, text: await res.text() };
  } finally {
    await fs.unlink(cfg).catch(() => {}); await fs.unlink(req).catch(() => {});
  }
}
const store = {
  get: (k) => { try { return localStorage.getItem(k) ?? ""; } catch { return ""; } },
  set: (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} },
};

export default class Changes extends View {
  init(_props, cx) {
    this.files = []; this.rows = []; this.diffWidth = 0; this.message = ""; this.handle = cx.focus_handle();
    this.apiKey = store.get("gemini.key"); this.model = store.get("gemini.model") || DEFAULT_MODEL;
    this.keyInput = InputState.new({ placeholder: "Gemini API key" }); this.keyInput.set_masked(true); this.keyInput.set_value(this.apiKey);
    this.modelInput = InputState.new({ placeholder: DEFAULT_MODEL }); this.modelInput.set_value(this.model === DEFAULT_MODEL ? "" : this.model);
    this.keyInput.on("submit", (_e, cx) => this.saveSetup(cx));
    this.modelInput.on("submit", (_e, cx) => this.saveSetup(cx));
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.root = null; this.files = []; this.open = null;
      this.setLines([]); this.message = ""; this.input.set_value(""); this.error = null; this.note = null; this.watched = null; this.closed = false; this.limited = false;
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.root = null; this.files = []; this.setLines([]); this.open = null; this.error = "Not a git repository"; return; }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(status.stderr);
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        const stats = {};
        const results = head.code === 0 ? [await git(["diff", "HEAD", "--numstat", "-z", "--no-renames"])] : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])];
        for (const result of results) {
          if (result.code !== 0) throw new Error(result.stderr);
          for (const entry of result.stdout.split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (!parts.length) continue;
            const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
            stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
          }
        }
        const files = [];
        const entries = status.stdout.split("\0").filter(Boolean);
        for (const entry of entries.slice(0, 1000)) {
          const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
          const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
          const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
          const stat = stats[path] ?? { add: 0, del: 0 };
          files.push({ path, status: s, fresh, ...stat });
        }
        if (key() !== context) return;
        this.root = root; this.on = on; this.hasHead = head.code === 0; this.files = files; this.limited = entries.length > 1000; this.error = null;
        this.watch(root, cx);
        if (this.open && !files.some((f) => f.path === this.open)) { this.open = null; this.setLines([]); }
        // The first file's diff shows until you pick another.
        if (!this.open && !this.closed && files.length) this.open = files[0].path;
        if (this.open) {
          try { await this.load(this.open, context); }
          catch { if (key() === context) this.setLines(["Cannot preview this diff (too large or unreadable)"]); }
        }
      } catch (e) { if (key() === context) this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  async load(path, context) {
    const file = this.files.find((f) => f.path === path), root = this.root, on = this.on;
    if (!file) return;
    let lines;
    if (file.fresh || (!this.hasHead && file.status === "A")) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        file.add = countLines(text);
        lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map(l => `+${l}`)];
      }
    } else {
      const r = await exec("git", [...READ, "diff", ...(this.hasHead ? ["HEAD"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", path], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    }
    if (key() === context && this.open === path) this.setLines(lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line));
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffWidth = Math.max(300, ...this.rows.map(row => (row.text.length + 1) * 7 + 50));
  }

  pick(path, cx) {
    this.open = this.open === path ? null : path; this.setLines([]); this.note = null;
    this.closed = !this.open;
    const context = this.context;
    if (this.open) cx.spawn(async (cx) => {
      try { await this.load(path, context); }
      catch (e) { if (key() === context && this.open === path) this.note = `Cannot preview this diff (too large or unreadable): ${e}`; }
      cx.notify();
    });
    cx.notify();
  }

  commit(cx) {
    if (!this.message.trim() || !this.root || this.busy || this.loading || this.context !== key()) return;
    const root = this.root, on = this.on, context = this.context, message = this.message.trim();
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of [["add", "-A"], ["commit", "-m", message]]) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (key() === context) { this.message = ""; this.input.set_value(""); }
      } catch (e) { if (key() === context) this.note = `Commit failed: ${e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  saveSetup(cx) {
    this.apiKey = this.keyInput.value().trim(); this.model = this.modelInput.value().trim() || DEFAULT_MODEL;
    store.set("gemini.key", this.apiKey); store.set("gemini.model", this.model === DEFAULT_MODEL ? "" : this.model);
    this.setup = !this.apiKey; this.note = null;
    cx.notify();
  }

  // The change as text for the model: the diff against HEAD, plus the start of each new file, within a size limit.
  async gather(root, on) {
    const git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
    const diff = await git(["diff", ...(this.hasHead ? ["HEAD"] : ["--cached"]), "--no-ext-diff", "--no-textconv", "--no-color", "--unified=2"]);
    if (diff.code !== 0) throw new Error(diff.stderr.trim());
    let body = diff.stdout;
    const fresh = this.files.filter((f) => f.fresh);
    for (const f of fresh.slice(0, FRESH_FILES)) {
      const text = await readTextFile(`${root}/${f.path}`, { on }).catch(() => null);
      if (text === null || text.includes("\0")) { body += `\nnew file: ${f.path} (binary or unreadable)\n`; continue; }
      body += `\nnew file: ${f.path}\n${text.slice(0, FRESH_LIMIT)}${text.length > FRESH_LIMIT ? "\n… (truncated)" : ""}\n`;
    }
    if (fresh.length > FRESH_FILES) body += `\n… and ${fresh.length - FRESH_FILES} more new files: ${fresh.slice(FRESH_FILES).map((f) => f.path).join(", ")}\n`;
    const log = await git(["log", "-8", "--pretty=%s"]).catch(() => null);
    const stat = this.files.map((f) => `${f.status} ${f.path}`).join("\n");
    return { body: body.length > DIFF_LIMIT ? body.slice(0, DIFF_LIMIT) + "\n… (diff truncated)" : body, stat, recent: log?.code === 0 ? log.stdout.trim() : "" };
  }

  generate(cx) {
    if (this.writing || this.busy || this.loading || !this.root || !this.files.length) return;
    if (!this.apiKey) { this.setup = true; this.note = null; cx.notify(); return; }
    const root = this.root, on = this.on, context = this.context, key = this.apiKey, model = this.model;
    this.writing = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        const { body, stat, recent } = await this.gather(root, on);
        const prompt = `Recent commit subjects:\n${recent || "(none yet)"}\n\nChanged files:\n${stat}\n\nDiff:\n${body}`;
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
        const payload = {
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          // Newer Gemini models think before they answer and count it against this limit: a small one leaves an empty answer.
          generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
        };
        // Google answers 503 (busy) or 429 (quota) in spikes: ask again a few times, a little later each time.
        let res;
        for (let attempt = 1; ; attempt++) {
          res = await post(url, key, payload);
          if ((res.status !== 503 && res.status !== 429) || attempt >= RETRIES || this.context !== context) break;
          this.progress = `Gemini is busy · trying again (${attempt + 1}/${RETRIES})…`; cx.notify();
          await exec("sleep", [String(attempt * 4)]);
        }
        const text = res.text;
        let data = null; try { data = JSON.parse(text); } catch {}
        if (res.status < 200 || res.status >= 300) {
          const why = res.status === 503 || res.status === 429 ? "Google's model is busy or over quota, try again in a moment" : data?.error?.message ?? text.slice(0, 160);
          if (res.status === 400 || res.status === 403 || res.status === 404) this.setup = true;
          throw new Error(`${res.status} ${why}`);
        }
        const out = (data?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim()
          .replace(/^```\w*\n?|\n?```$/g, "").split("\n")[0].replace(/^["'`]+|["'`]+$/g, "").trim();
        if (!out) throw new Error(data?.promptFeedback?.blockReason ? `blocked: ${data.promptFeedback.blockReason}` : "empty answer");
        if (key !== this.apiKey || this.context !== context) return;
        this.message = out; this.input.set_value(out);
      } catch (e) { if (this.context === context) this.note = `AI message failed: ${String(e).replace(/^Error: /, "")}`; }
      finally { this.writing = false; this.progress = null; cx.notify(); }
    });
    cx.notify();
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(30).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme(), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading);
    const aiReady = Boolean(this.root && this.files.length && !this.busy && !this.loading && !this.writing);
    return v_flex().id("changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Changes"))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${this.files.length} files`))
        .child(div().flex_1()).child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${del}`))
        .child(div().id("ai-setup").size(24).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.setup = !this.setup; cx.notify(); })
          .child(svg("mods/changesplus/key.svg").size(14).text_color(this.setup ? t.accent : this.apiKey ? t.muted : t.dim))))
      // overflow_y_scrollbar() wraps the list, so its flex sizing never reached the panel's layout.
      .child(div().flex_1().min_h(44).max_h(this.files.length * 28 + 12).relative().border_b(1).border_color(t.border)
        .child(v_flex().id("changes-list").absolute().inset_0().overflow_y_scroll().p(6).children(this.files.map((f) => {
        const parts = f.path.split("/"), name = parts.pop();
        return h_flex().id(`change-${f.path}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer().when(this.open === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick(f.path, cx))
          .child(div().w(14).text_size(11).text_color(f.status === "A" ? t.ansi2 : f.status === "D" ? t.ansi1 : f.status === "U" ? t.ansi1 : t.blocked).child(f.status))
          .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
          .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`))).when(f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
      })).when(!this.files.length, (e) => e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading ? "Loading changes…" : this.root ? "No uncommitted changes" : "No folder")))))
        .child(Scrollbar.vertical("changes-list").absolute().inset_0()))
      .when(this.limited, el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        .child(div().id("changes-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("changes-diff", this.rows.length, 20, (i) => String(i),
            (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
        .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
        .when(!this.open && this.files.length > 0, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child("Select a file to view its changes"))))
      .when(this.writing, (e) => e.child(div().px(10).pb(8).text_size(11).text_color(t.dim).child(this.progress || "Asking Gemini… this can take a minute when Google is busy")))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(8).text_size(11).text_color(t.ansi1).child(this.note)))
      .when(this.setup, (e) => e.child(v_flex().flex_none().p(10).gap(6).border_t(1).border_color(t.border)
        .child(div().text_size(11).text_color(t.dim).child("AI commit message · Gemini API key (saved on this machine). The diff is sent to Google when you press ✦."))
        .child(h_flex().gap(8)
          .child(div().id("ai-key").flex_1().min_w(0).h(30).px(10).flex().items_center().rounded(8).border_1().border_color(t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.keyInput).h_full().text_size(12).text_color(t.foreground)))
          .child(div().id("ai-model").w(130).flex_none().h(30).px(10).flex().items_center().rounded(8).border_1().border_color(t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.modelInput).h_full().text_size(12).text_color(t.foreground)))
          .child(div().id("ai-save").h(30).px(12).flex().items_center().rounded(8).bg(t.solid).text_color(t.solid_foreground).text_size(12).cursor_pointer().on_click((_e, cx) => this.saveSetup(cx)).child("Save")))))
      .child(h_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
        .child(div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(div().id("ai-message").size(32).flex_none().flex().items_center().justify_center().rounded(8).border_1().border_color(t.border)
          .when(aiReady, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover))).on_click((_e, cx) => this.generate(cx))
          .child(this.writing ? svg("mods/changesplus/sparkle.svg").size(15).text_color(t.accent).spin(1000) : svg("mods/changesplus/sparkle.svg").size(15).text_color(aiReady ? t.accent : t.dim)))
        .child(div().id("commit").h(32).px(14).flex().items_center().rounded(8).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(12).when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(this.busy ? "Committing…" : "Commit")));
  }
}
