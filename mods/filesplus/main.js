// A lazy file browser for the focused pane's folder: bounded previews, pictures, Markdown shown as Markdown, text files you can
// edit and save, and files and folders you can create, rename and delete (to the Trash, after asking). Changing files works for local folders only.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView, Input, InputState } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, writeTextFile, watchFolder, theme, settings, window, appHome } from "herdr";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000;
// Pictures the host image loader draws. They are shown, not read as text.
const IMAGES = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg"]);
const IMAGE_LIMIT = 25 * 1024 * 1024;
const PREVIEWS = "data/filesplus";
let previews = 0;
const ZOOM_MIN = 0.1, ZOOM_MAX = 8, ZOOM_STEP = 1.25;
// A text longer than this is shown cut off, so it is view-only: saving a cut-off text would destroy the rest of the file.
const EDIT_LIMIT = 400000;
const MARKDOWN = new Set(["md", "markdown", "mdown", "mkd"]);
const WRAP = new Set(["md", "markdown", "mdown", "mkd", "txt", "text", ""]);
const ENTRY = () => `${appHome()}/mods/filesplus/entry.sh`;   // checks, counts, trashes and removes one entry of the folder
// The extension of the file's own name ("a.d/readme" has none).
const extOf = (path) => { const n = path.split("/").pop() ?? ""; return n.includes(".") ? n.split(".").pop().toLowerCase() : ""; };
const plain = (e) => String(e).replace(/^Error: /, "").replace(/^`herdr\.\w+`: /, "");
const byKind = (a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name);
// Why a file or folder name is not usable (entry.sh checks again), or null.
function nameProblem(name) {
  if (!name) return null;
  if (name !== name.trim()) return "A name cannot start or end with a space";
  if (/[\/\0\r\n]/.test(name)) return "A name cannot contain / or a line break";
  if (name === "." || name === "..") return "That is not a usable name";
  if (name === ".git") return "Files keeps .git out of the way";
  if (utf8Length(name) > 255) return "That name is too long";
  return null;
}
// Bytes in UTF-8 (Herdr's JavaScript has no TextEncoder).
const utf8Length = (s) => { let n = 0; for (const ch of s) { const c = ch.codePointAt(0); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; } return n; };
const stem = (name) => { const i = name.lastIndexOf("."); return i > 0 ? name.slice(0, i) : name; };

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.rev = 0; this.ask = null; this.prompt = null; this.notice = null; this.note = null; this.manage = false;
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
    // Typing is noticed by the editor's change event, and by this look twice a second: whichever is there, the Save button,
    // the ● and the question when leaving always match what is in the editor.
    cx.timer.every(400, cx => this.poll(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  // The open file is still the one a read or write started for.
  live(path, rev, context) {
    return this.file === path && this.rev === rev && this.current(context);
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort(byKind));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      // Leaving a folder with unsaved edits open keeps them: they come back with the file when the folder does.
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file, draft: this.draft() });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.ask = null; this.closePrompt(); this.notice = null; this.note = null; this.manage = !on && window()?.platform !== "windows";
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx, saved.draft);
    }
    if (!cwd) return;
    if (this.loading) { this.again = true; return; }   // something changed while looking: look once more when done
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
        await this.checkDisk(cx, context);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally {
        if (this.context === context) { this.loading = false; if (this.again) { this.again = false; this.refresh(cx); } }
        cx.notify();
      }
    });
  }

  toggle(path, cx) {
    if (this.ask || this.prompt) return;
    this.notice = null; this.note = null;
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  // Opens a file (null closes it). `draft`: unsaved edits that come back with it.
  show(path, cx, draft = null) {
    this.code?.release(); this.code = null; this.file = path; this.fileError = null; this.picture = null; this.zoom = 1; this.ox = 0; this.oy = 0;
    this.rev++; this.disk = null; this.dirty = false; this.editable = false; this.why = null; this.linkTo = null;
    this.conflict = false; this.missing = false; this.leaving = false; this.saving = false; this.justSaved = false;
    this.markdown = Boolean(path) && MARKDOWN.has(extOf(path)); this.mode = "edit"; this.mdText = "";
    if (!path || !cx) return;
    this.notice = null; this.note = null;
    const context = this.context, root = this.root, on = this.on, rev = this.rev, ext = extOf(path);
    if (IMAGES.has(ext)) {
      if (on) { this.fileError = "Image preview works for local folders only"; return; }
      // image() reads from Herdr's own folder: copy the picture there under a name that is new each time,
      // so an edited file is read again. Earlier previews are removed first.
      const name = `preview-${Date.now()}-${previews++}.${ext}`;
      cx.spawn(async cx => {
        try {
          const r = await exec("sh", ["-c", '[ -f "$1" ] || exit 2; [ "$(wc -c < "$1")" -le "$4" ] || exit 3; mkdir -p "$2" && rm -f "$2"/preview-* && cp "$1" "$2/$3"', "files", `${root}/${path}`, `${appHome()}/${PREVIEWS}`, name, String(IMAGE_LIMIT)]);
          if (!this.live(path, rev, context)) return;
          if (r.code === 0) this.picture = `${PREVIEWS}/${name}`;
          else this.fileError = r.code === 3 ? "Image is larger than 25 MB · no preview" : r.code === 2 ? "This file is no longer available" : "Cannot preview this image";
        } catch { if (this.live(path, rev, context)) this.fileError = "Cannot preview this image"; }
        finally { cx.notify(); }
      });
      return;
    }
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (!this.live(path, rev, context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        // Can it be edited? Local folders only, short enough to be shown whole, a regular writable file.
        let why = null, linkTo = null;
        if (on) why = "Editing works for local folders only";
        else if (window()?.platform === "windows") why = "Editing is not available on Windows yet";
        else if (text.length > EDIT_LIMIT) why = "Larger than 400,000 characters · view only";
        else {
          const r = await exec("sh", [ENTRY(), "edit", root, path]);
          if (!this.live(path, rev, context)) return;
          if (r.code === 7) why = "Read-only file (permissions) · view only";
          else if (r.code === 8) why = "Not a regular file · view only";
          else if (r.code !== 0) why = `View only: ${this.said(r)}`;
          else linkTo = (r.stdout.split("\n").find(l => l.startsWith("link\t")) ?? "").slice(5) || null;
        }
        const editable = why === null, restore = draft && editable ? draft : null;
        const shown = text.length > EDIT_LIMIT ? text.slice(0, EDIT_LIMIT) + "\n… (file truncated)" : text;
        // With a draft the file is judged against what it was when the draft began: if it changed since, saving asks first.
        this.disk = restore ? restore.disk : text; this.editable = editable; this.why = why; this.linkTo = linkTo;
        const t = theme();
        this.code = EditorState.new({ language: LANG[ext] ?? (ext || "txt"), readonly: !editable, soft_wrap: WRAP.has(ext), value: shown,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
        this.code.on("change", (_e, cx) => this.edited(cx));
        if (restore) { this.code.set_value(restore.text); this.dirty = restore.text !== restore.disk; this.conflict = text !== restore.disk; }
        this.mode = this.markdown && !this.dirty ? "preview" : "edit";
        this.mdText = this.markdown ? (restore ? restore.text : shown) : "";
      } catch (e) {
        if (!this.live(path, rev, context)) return;
        const m = plain(e);
        this.fileError = /exceeds 1 MiB/.test(m) ? "File is larger than 1 MiB · no preview" : /valid UTF-8/.test(m) ? "Not UTF-8 text · no preview" : "Cannot preview this file (binary, too large, or unreadable)";
      }
      finally { cx.notify(); }
    });
  }

  // The unsaved edits of the open file, to keep while another folder is shown.
  draft() {
    this.sync();
    return this.editable && this.dirty && this.code ? { text: this.code.value(), disk: this.disk } : null;
  }

  // Is the editor's text different from the file's? (Asks the editor; call before deciding anything about unsaved edits.)
  sync() {
    if (!this.code || !this.editable || this.saving) return this.dirty;
    this.dirty = this.code.value() !== this.disk;
    if (this.dirty) this.justSaved = false;
    return this.dirty;
  }

  edited(cx) {
    if (!this.code || !this.editable) return;
    this.sync(); cx.notify();
  }

  poll(cx) {
    const p = this.prompt;
    if (p && !p.busy) { const text = p.input.value(); if (text !== p.text) { p.text = text; p.error = null; cx.notify(); } }
    if (!this.code || !this.editable || this.saving) return;
    const before = this.dirty;
    if (this.sync() !== before) cx.notify();
  }

  // What entry.sh said went wrong, in words.
  said(r) {
    return r.code === 2 ? "that is not a path inside this folder" : r.code === 3 ? "it no longer exists" : r.code === 4 ? "it is reached through a link that leaves this folder"
      : (r.stderr || r.stdout || `exit ${r.code}`).trim();
  }

  // --- editing: save, and what to do when the file changed on disk ---
  save(cx, after) {
    this.sync();
    if (!this.editable || !this.code || this.saving || (!this.dirty && !this.missing)) return;
    this.saving = true; cx.notify();
    const path = this.file, root = this.root, context = this.context, rev = this.rev, text = this.code.value(), expected = this.missing ? null : this.disk;
    cx.spawn(async cx => {
      let saved = false;
      try {
        await writeTextFile(`${root}/${path}`, text, expected);
        saved = true;
        if (this.live(path, rev, context)) {
          this.disk = text; this.missing = false; this.conflict = false; this.rev++;
          this.dirty = this.code.value() !== text; this.justSaved = !this.dirty; this.note = null;
        }
      } catch (e) {
        if (this.live(path, rev, context)) {
          if (/changed outside Herdr/i.test(String(e))) this.conflict = true;
          else this.note = `Could not save: ${plain(e)}`;
        }
      } finally {
        this.saving = false;
        if (saved && after && this.file === path) after(cx);
        this.refresh(cx); cx.notify();
      }
    });
  }

  // The file changed on disk while there are unsaved edits. `keep`: write my text over it; otherwise take the disk's text.
  settle(keep, cx) {
    if (!this.editable || !this.code || this.saving) return;
    this.saving = true; cx.notify();
    const path = this.file, root = this.root, context = this.context, rev = this.rev, mine = this.code.value();
    cx.spawn(async cx => {
      try {
        const now = await readTextFile(`${root}/${path}`, { on: this.on });
        if (!this.live(path, rev, context)) return;
        if (keep) await writeTextFile(`${root}/${path}`, mine, now);
        if (!this.live(path, rev, context)) return;
        this.rev++; this.conflict = false; this.missing = false; this.note = null;
        if (keep) { this.disk = mine; this.dirty = this.code.value() !== mine; this.justSaved = !this.dirty; }
        else if (now === null) { this.missing = true; }
        else {
          this.disk = now; this.code.set_value(now); this.dirty = false; this.justSaved = false;
          if (this.markdown) this.mdText = now;
        }
      } catch (e) { if (this.live(path, rev, context)) this.note = `Could not ${keep ? "save" : "reload"}: ${plain(e)}`; }
      finally { this.saving = false; if (keep) this.refresh(cx); cx.notify(); }
    });
  }

  // Looks at the open file on disk (after a folder refresh): a clean buffer follows the file, one with edits is told it changed.
  async checkDisk(cx, context) {
    if (!this.file || this.picture || !this.code || this.saving) return;
    const path = this.file, rev = this.rev;
    let text;
    try { text = await readTextFile(`${this.root}/${path}`, { on: this.on }); } catch { return; }
    if (!this.live(path, rev, context)) return;   // opened, saved or reloaded meanwhile: this read may be older than that
    this.sync();
    if (text === null) { if (!this.missing) { this.missing = true; cx.notify(); } return; }
    this.missing = false;
    if (text === this.disk) { if (this.conflict) { this.conflict = false; cx.notify(); } return; }
    if (this.dirty) { if (!this.conflict) { this.conflict = true; cx.notify(); } return; }
    if (this.editable && text.length > EDIT_LIMIT) { this.show(path, cx); return; }   // too long to edit now: open it again as view-only
    this.rev++; this.disk = text;
    const shown = text.length > EDIT_LIMIT ? text.slice(0, EDIT_LIMIT) + "\n… (file truncated)" : text;
    this.code.set_value(shown); this.dirty = false; this.conflict = false;
    if (this.markdown) this.mdText = shown;
    cx.notify();
  }

  setMode(mode, cx) {
    if (!this.markdown || !this.code) return;
    if (mode === "preview") this.mdText = this.code.value();   // the preview shows what is in the editor, saved or not
    this.mode = mode; cx.notify();
  }

  // ← : with unsaved edits it asks first.
  back(cx) {
    if (this.ask?.busy || this.prompt?.busy || this.saving) return;
    this.ask = null; this.closePrompt(); this.sync();
    if (this.dirty) { this.leaving = true; cx.notify(); return; }
    this.show(null); cx.notify();
  }

  // --- delete: asks first, says what will happen, and acts only on the button ---
  askDelete(path, dir, cx) {
    if (!this.manage || this.ask?.busy || this.saving) return;
    this.sync(); this.leaving = false; this.closePrompt(); this.notice = null; this.note = null;
    const ask = { path, dir, stage: "trash", count: null, problem: null, why: null, busy: false };
    this.ask = ask; cx.notify();
    const root = this.root;
    cx.spawn(async cx => {
      try {
        const r = await exec("sh", [ENTRY(), "check", root, path]);
        if (r.code !== 0) ask.problem = this.said(r)[0].toUpperCase() + this.said(r).slice(1);
        else if (dir) { const c = Number((await exec("sh", [ENTRY(), "count", root, path])).stdout.trim()); ask.count = Number.isFinite(c) ? c : null; }
      } catch (e) { ask.problem = plain(e); }
      finally { cx.notify(); }
    });
  }

  deleteGo(cx) {
    const ask = this.ask;
    if (!ask || ask.busy || ask.problem) return;
    ask.busy = true; cx.notify();
    const root = this.root, context = this.context;
    cx.spawn(async cx => {
      try {
        const r = await exec("sh", [ENTRY(), ask.stage === "trash" ? "trash" : "remove", root, ask.path], { timeout: 600000 });
        if (r.code === 0) { if (this.ask === ask) this.ask = null; if (this.current(context)) this.removed(ask.path, ask.stage, cx); }
        else if (ask.stage === "trash" && (r.code === 5 || r.code === 6)) { ask.stage = "permanent"; ask.why = this.said(r); }   // no Trash here: a second, explicit question
        else ask.problem = `Could not delete: ${this.said(r)}`;
      } catch (e) { ask.problem = `Could not delete: ${plain(e)}`; }
      finally { ask.busy = false; cx.notify(); }
    });
  }

  cancelDelete(cx) { if (this.ask && !this.ask.busy) { this.ask = null; cx.notify(); } }

  // The entry is gone: take it out of the tree, close the open file if it was inside, and look again.
  removed(path, how, cx) {
    const name = path.split("/").pop(), parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    const list = this.entries.get(parent);
    if (list) this.entries.set(parent, list.filter(e => e.name !== name));
    for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) { this.folders.delete(folder); this.entries.delete(folder); }
    if (this.file && (this.file === path || this.file.startsWith(path + "/"))) this.show(null);
    this.notice = how === "trash" ? `Moved “${name}” to the Trash` : `Deleted “${name}”`; this.note = null;
    this.refresh(cx); cx.notify();
  }

  // --- new file, new folder, rename: a bar with one name field, asking before anything is made ---
  // kind "file" | "folder": `path` is the folder to make it in ("" is the folder shown); kind "rename": `path` is the entry.
  openPrompt(kind, path, cx) {
    if (!this.manage || this.ask?.busy || this.prompt?.busy || this.saving) return;
    this.sync(); this.leaving = false; this.ask = null; this.closePrompt(); this.notice = null; this.note = null;
    const old = kind === "rename" ? path.split("/").pop() : "";
    const input = InputState.new(kind === "rename" ? { value: old } : { placeholder: kind === "file" ? "File name" : "Folder name" });
    const prompt = { kind, path, old, input, text: old, error: null, busy: false };
    input.on("submit", (_e, cx) => this.promptGo(cx));
    this.prompt = prompt;
    if (kind === "rename") input.set_selected_range({ start: 0, end: stem(old).length });
    input.focus(); cx.notify();
  }

  closePrompt() { this.prompt?.input.release(); this.prompt = null; }
  cancelPrompt(cx) { if (this.prompt && !this.prompt.busy) { this.closePrompt(); cx.notify(); } }

  // What is wrong with the name typed now (null when nothing is, or nothing is typed yet).
  promptProblem() {
    const p = this.prompt, name = p.text;
    if (!name) return null;
    const bad = nameProblem(name);
    if (bad) return bad;
    if (p.kind === "rename" && name === p.old) return "That is the current name";
    const parent = p.kind === "rename" ? (p.path.includes("/") ? p.path.slice(0, p.path.lastIndexOf("/")) : "") : p.path;
    if ((this.entries.get(parent) ?? []).some(e => e.name === name && !(p.kind === "rename" && e.name === p.old))) return `“${name}” already exists here`;
    return null;
  }

  promptGo(cx) {
    const p = this.prompt;
    if (!p || p.busy) return;
    p.text = p.input.value();
    if (!p.text || p.error || this.promptProblem()) { cx.notify(); return; }
    p.busy = true; p.error = null; cx.notify();
    const root = this.root, context = this.context, name = p.text;
    const args = p.kind === "rename" ? ["rename", root, p.path, name] : [p.kind === "file" ? "create-file" : "create-dir", root, p.path, name];
    cx.spawn(async cx => {
      try {
        const r = await exec("sh", [ENTRY(), ...args]);
        if (r.code === 0) { if (this.prompt === p) this.closePrompt(); if (this.current(context)) this.made(p, name, cx); }
        else p.error = r.code === 9 ? `“${name}” already exists here` : r.code === 10 ? "That is not a usable name" : r.code === 11 ? "That folder no longer exists" : this.said(r);
      } catch (e) { p.error = plain(e); }
      finally { p.busy = false; cx.notify(); }
    });
  }

  // Something was made or renamed: show it in the tree, and open a new file.
  made(p, name, cx) {
    const parent = p.kind === "rename" ? (p.path.includes("/") ? p.path.slice(0, p.path.lastIndexOf("/")) : "") : p.path;
    const path = parent ? `${parent}/${name}` : name;
    if (p.kind === "rename") {
      const from = p.path, old = p.old;
      for (const f of [...this.folders]) if (f === from || f.startsWith(from + "/")) { this.folders.delete(f); this.folders.add(path + f.slice(from.length)); }
      for (const k of [...this.entries.keys()]) if (k === from || k.startsWith(from + "/")) this.entries.delete(k);
      const list = this.entries.get(parent);
      if (list) this.entries.set(parent, list.map(e => e.name === old ? { ...e, name } : e).sort(byKind));
      if (this.file && (this.file === from || this.file.startsWith(from + "/"))) this.show(path + this.file.slice(from.length), cx, this.draft());   // unsaved edits go with it
      this.notice = `Renamed “${old}” to “${name}”`;
    } else {
      if (parent) this.folders.add(parent);
      if (p.kind === "folder") this.folders.add(path);
      const list = this.entries.get(parent);
      if (list) this.entries.set(parent, [...list.filter(e => e.name !== name), { name, dir: p.kind === "folder" }].sort(byKind));
      if (p.kind === "file") this.show(path, cx); else this.notice = `Created folder “${name}”`;
    }
    this.note = null;
    this.refresh(cx); cx.notify();
  }

  // Pan and zoom are drawn by hand: the picture sits in a box `zoom` times the panel's size (the picture fitted inside it),
  // `ox`/`oy` pixels from the panel's corner. 100% fits; below it shrinks, above it pans. Zooming keeps the point under
  // (px, py) where it is, as Figma does; without a point it zooms about the middle.
  area() { return this.size ?? { width: 340, height: 500 }; }

  zoomAt(factor, point, cx) {
    const { width, height } = this.area(), px = point?.x ?? width / 2, py = point?.y ?? height / 2;
    const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, this.zoom * factor)), f = zoom / this.zoom;
    this.zoom = zoom;
    this.place(px - (px - this.ox) * f, py - (py - this.oy) * f);
    cx.notify();
  }

  // Keeps at least a corner of the picture in view.
  place(x, y) {
    const { width, height } = this.area(), keep = 48;
    this.ox = Math.min(width - keep, Math.max(keep - width * this.zoom, x));
    this.oy = Math.min(height - keep, Math.max(keep - height * this.zoom, y));
  }

  fit(cx) { this.zoom = 1; this.ox = 0; this.oy = 0; cx.notify(); }

  zoomButton(id, label, t, click) {
    return div().id(id).min_w(22).h(22).px(5).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer().text_size(12).text_color(t.muted)
      .hover(s => s.bg(t.hover)).on_click((_e, cx) => click(cx)).child(label);
  }

  pictureView(t) {
    const { width, height } = this.area(), measured = Boolean(this.size), plain = this.zoom === 1 && this.ox === 0 && this.oy === 0;
    const learn = (e) => { if (e.bounds) this.size = { width: e.bounds.width, height: e.bounds.height }; };
    // Like Figma: a trackpad pinch zooms about the pointer; Ctrl or Cmd with the wheel does too; two fingers (the wheel alone) pan.
    return div().id("files-image").flex_1().min_h(0).relative().overflow_hidden().bg(t.raised)
      .on_mouse_move((e, _cx) => learn(e))
      .on_pinch((e, cx) => { learn(e); this.zoomAt(1 + e.delta, e.local_position, cx); cx.stop_propagation(); })
      .on_scroll_wheel((e, cx) => {
        learn(e);
        if (e.modifiers.control || e.modifiers.platform) this.zoomAt(Math.exp(-e.delta.y / 120), e.local_position, cx);
        else { this.place(this.ox + e.delta.x, this.oy + e.delta.y); cx.notify(); }
        cx.stop_propagation();
      })
      .child(div().absolute().left(plain && !measured ? 0 : this.ox).top(plain && !measured ? 0 : this.oy)
        .w(plain && !measured ? "100%" : width * this.zoom).h(plain && !measured ? "100%" : height * this.zoom).p(12)
        .child(image(this.picture).size_full()));
  }

  // --- drawing ---
  button(id, label, kind, enabled, click, t) {
    const filled = kind === "primary" || kind === "danger", bg = kind === "danger" ? t.ansi1 : t.solid;
    return div().id(id).h(26).px(11).flex_none().flex().items_center().rounded(7).text_size(12)
      .border_1().border_color(filled && enabled ? bg : t.border)
      .bg(filled && enabled ? bg : t.background).text_color(filled && enabled ? (kind === "danger" ? "#ffffff" : t.solid_foreground) : enabled ? t.foreground : t.dim)
      .when(enabled, el => el.cursor_pointer().hover(s => s.opacity(0.85))).on_click((_e, cx) => { if (enabled) click(cx); }).child(label);
  }

  // A small icon button; `danger` turns red when pointed at.
  iconButton(id, icon, danger, click, t) {
    return div().id(id).size(22).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.dim)
      .hover(s => s.text_color(danger ? t.ansi1 : t.foreground).bg(t.hover))
      .on_click((_e, cx) => { cx.stop_propagation(); click(cx); })
      .child(svg(`mods/filesplus/${icon}.svg`).size(13));
  }

  trashButton(id, path, dir, t) { return this.iconButton(id, "trash", true, cx => this.askDelete(path, dir, cx), t); }
  renameButton(id, path, t) { return this.iconButton(id, "pencil", false, cx => this.openPrompt("rename", path, cx), t); }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .when(this.ask?.path === path, el => el.bg(t.raised).border_1().border_color(t.ansi1))
        .when(this.prompt && (this.prompt.path === path), el => el.bg(t.raised))
        .on_click((_e, cx) => { if (this.ask || this.prompt) return; if (entry.dir) this.toggle(path, cx); else this.show(path, cx); cx.notify(); })
        .child(entry.dir ? svg(`mods/filesplus/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/filesplus/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark)))
        .when(this.manage && entry.dir, el => el.child(this.iconButton(`new-file-${path}`, "file-plus", false, cx => this.openPrompt("file", path, cx), t))
          .child(this.iconButton(`new-folder-${path}`, "folder-plus", false, cx => this.openPrompt("folder", path, cx), t)))
        .when(this.manage, el => el.child(this.renameButton(`rename-${path}`, path, t)).child(this.trashButton(`del-${path}`, path, entry.dir, t))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  // Preview | Edit for a Markdown file ("Source" when it cannot be edited).
  modeSwitch(t) {
    const item = (id, label, mode) => div().id(id).h(22).px(9).flex().items_center().rounded(6).cursor_pointer().text_size(11.5)
      .bg(this.mode === mode ? t.selected : t.background).text_color(this.mode === mode ? t.foreground : t.muted).hover(s => s.bg(t.hover))
      .on_click((_e, cx) => this.setMode(mode, cx)).child(label);
    return h_flex().flex_none().gap(2).items_center().child(item("files-mode-preview", "Preview", "preview")).child(item("files-mode-edit", this.editable ? "Edit" : "Source", "edit"));
  }

  status(t) {
    if (this.saving) return ["Saving…", t.dim];
    if (this.conflict) return ["Changed on disk", t.ansi1];
    if (this.missing) return ["Deleted on disk", t.ansi1];
    if (this.dirty) return ["Unsaved changes", t.blocked];
    if (this.justSaved) return ["Saved", t.ansi2];
    if (this.code && !this.editable && this.why) return [this.why, t.dim];
    if (this.linkTo) return [`Link to ${this.linkTo}: editing changes that file`, t.dim];
    return ["", t.dim];
  }

  toolbar(t) {
    const [status, color] = this.status(t), editing = this.editable && Boolean(this.code) && !this.picture;
    return h_flex().h(36).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border)
      .when(this.markdown && Boolean(this.code), el => el.child(this.modeSwitch(t)))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(color).child(status))
      .when(editing, el => el.child(this.button("files-save", this.saving ? "Saving…" : "Save", "primary", (this.dirty || this.missing) && !this.saving, cx => this.save(cx), t)))
      .when(this.manage, el => el.child(this.renameButton("files-rename", this.file, t)).child(this.trashButton("files-delete", this.file, false, t)));
  }

  banner(t) {
    if (this.conflict) {
      return v_flex().flex_none().px(10).py(8).gap(6).border_b(1).border_color(t.border).bg(t.raised)
        .child(div().text_size(11.5).child("This file changed on disk since you opened it. Your edits are still here."))
        .child(h_flex().gap(8).justify_end()
          .child(this.button("files-take-disk", "Load the file from disk", "plain", !this.saving, cx => this.settle(false, cx), t))
          .child(this.button("files-keep-mine", "Keep mine and overwrite", "danger", !this.saving, cx => this.settle(true, cx), t)));
    }
    if (this.missing) {
      return v_flex().flex_none().px(10).py(8).gap(6).border_b(1).border_color(t.border).bg(t.raised)
        .child(div().text_size(11.5).child("This file was deleted or moved outside Herdr."))
        .child(h_flex().gap(8).justify_end()
          .child(this.button("files-gone-close", "Close", "plain", !this.saving, cx => { this.show(null); cx.notify(); }, t))
          .when(this.editable, el => el.child(this.button("files-gone-save", "Save it again", "primary", !this.saving, cx => this.save(cx), t))));
    }
    return null;
  }

  // The bar at the bottom: a delete waiting for its button, or a way out of the file with unsaved edits.
  promptBar(t) {
    const p = this.prompt, bad = p.error ?? this.promptProblem();
    const where = p.kind === "rename" ? "" : ` in ${p.path ? `${p.path}/` : `${this.root.split("/").pop()}/`}`;
    const title = p.kind === "rename" ? `Rename “${p.old}”` : `New ${p.kind}${where}`;
    const ready = Boolean(p.text) && !bad && !p.busy && !(p.kind === "rename" && p.text === p.old);
    return v_flex().id("files-prompt").flex_none().px(10).py(9).gap(7).border_t(1).border_color(t.border).bg(t.raised)
      .on_key_down((e, cx) => { if (e.key === "escape") { this.cancelPrompt(cx); cx.stop_propagation(); } })
      .child(div().text_size(12).font_semibold().truncate().child(title))
      .child(div().id("files-prompt-input").h(28).px(9).flex().items_center().rounded(7).border_1().border_color(bad ? t.ansi1 : t.border).bg(t.background).cursor_text()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Input.new(p.input).h_full().text_size(12).text_color(t.foreground)))
      .when(Boolean(bad), el => el.child(div().text_size(11).text_color(t.ansi1).child(bad)))
      .child(h_flex().gap(8).justify_end()
        .child(this.button("files-prompt-cancel", "Cancel", "plain", !p.busy, cx => this.cancelPrompt(cx), t))
        .child(this.button("files-prompt-go", p.busy ? "Working…" : p.kind === "rename" ? "Rename" : "Create", "primary", ready, cx => this.promptGo(cx), t)));
  }

  bottomBar(t) {
    if (this.prompt && !this.ask) return this.promptBar(t);
    const ask = this.ask;
    if (ask) {
      const name = ask.path.split("/").pop(), within = this.dirty && this.file && (this.file === ask.path || this.file.startsWith(ask.path + "/"));
      const items = ask.count === null ? "" : ask.count === 0 ? "It is empty. " : ask.count > 10000 ? "More than 10,000 items inside. " : `${ask.count} ${ask.count === 1 ? "item" : "items"} inside. `;
      const title = ask.stage === "permanent" ? `Delete “${name}” permanently?` : `Move “${name}” to the Trash?`;
      const detail = ask.problem ?? (ask.stage === "permanent"
        ? `${ask.why[0].toUpperCase()}${ask.why.slice(1)}, so it would be erased for good. This cannot be undone.`
        : `${ask.dir ? "The folder and everything in it go to the Trash. " : ""}${items}You can put it back from the Trash.`) + (within && !ask.problem ? " Unsaved changes in the open file are lost." : "");
      return v_flex().flex_none().px(10).py(9).gap(7).border_t(1).border_color(t.border).bg(t.raised)
        .child(div().text_size(12).font_semibold().child(ask.problem ? `Cannot delete “${name}”` : title))
        .child(div().text_size(11).text_color(ask.problem ? t.ansi1 : t.dim).child(detail))
        .child(h_flex().gap(8).justify_end()
          .child(this.button("files-del-cancel", ask.problem ? "Close" : "Cancel", "plain", !ask.busy, cx => this.cancelDelete(cx), t))
          .when(!ask.problem, el => el.child(this.button("files-del-go", ask.busy ? "Working…" : ask.stage === "permanent" ? "Delete permanently" : "Move to the Trash", "danger", !ask.busy, cx => this.deleteGo(cx), t))));
    }
    if (this.leaving) {
      return v_flex().flex_none().px(10).py(9).gap(7).border_t(1).border_color(t.border).bg(t.raised)
        .child(div().text_size(12).font_semibold().child(`Unsaved changes in “${this.file.split("/").pop()}”`))
        .child(div().text_size(11).text_color(t.dim).child("Leaving now loses them."))
        .child(h_flex().gap(8).justify_end()
          .child(this.button("files-leave-stay", "Keep editing", "plain", !this.saving, cx => { this.leaving = false; cx.notify(); }, t))
          .child(this.button("files-leave-discard", "Discard changes", "danger", !this.saving, cx => { this.show(null); cx.notify(); }, t))
          .child(this.button("files-leave-save", this.saving ? "Saving…" : "Save and close", "primary", !this.saving, cx => this.save(cx, cx2 => { this.show(null); cx2.notify(); }), t)));
    }
    return null;
  }

  messages(t) {
    return [this.notice ? div().flex_none().px(10).py(6).text_size(11).text_color(t.ansi2).child(this.notice) : null,
      this.note ? div().flex_none().px(10).py(6).text_size(11).text_color(t.ansi1).child(this.note) : null].filter(Boolean);
  }

  textArea(t) {
    if (!this.code) return div().p(12).text_color(t.dim).child(this.fileError || (IMAGES.has(extOf(this.file)) ? "Loading image…" : "Loading file…"));
    if (this.markdown && this.mode === "preview") {
      return div().id("files-markdown").flex_1().min_h(0).overflow_y_scrollbar().px(16).py(12)
        .child(TextView.markdown("files-markdown-text", this.mdText).selectable());
    }
    return v_flex().id("files-editor").flex_1().min_h(0)
      .on_key_down((e, cx) => { if (e.keystroke === "cmd-s") { this.save(cx); cx.stop_propagation(); } })
      .child(Editor.new(this.code).flex_1().min_h(0));
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme(), banner = this.file && !this.picture ? this.banner(t) : null;
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => this.back(cx)).child("←")))
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.file ? `${this.file}${this.dirty ? " ●" : ""}` : this.root?.split(/[\\/]/).pop() ?? ""))
        .when(this.manage && !this.file, el => el.child(h_flex().flex_none().gap(2).items_center()
          .child(this.iconButton("files-new-file", "file-plus", false, cx => this.openPrompt("file", "", cx), t))
          .child(this.iconButton("files-new-folder", "folder-plus", false, cx => this.openPrompt("folder", "", cx), t))))
        .when(Boolean(this.picture), el => el.child(h_flex().flex_none().gap(2).items_center()
          .child(this.zoomButton("zoom-out", "−", t, cx => this.zoomAt(1 / ZOOM_STEP, null, cx)))
          .child(div().id("zoom-fit").min_w(40).h(22).px(4).flex().items_center().justify_center().rounded(6).cursor_pointer().text_size(11).text_color(t.dim).hover(s => s.bg(t.hover))
            .on_click((_e, cx) => this.fit(cx)).child(`${Math.round(this.zoom * 100)}%`))
          .child(this.zoomButton("zoom-in", "+", t, cx => this.zoomAt(ZOOM_STEP, null, cx))))))
      .when(Boolean(this.file), el => el.child(this.toolbar(t)))
      .when(Boolean(banner), el => el.child(banner))
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file) && Boolean(this.picture), el => el.child(this.pictureView(t)))
      .when(Boolean(this.file) && !this.picture, el => el.child(this.textArea(t)))
      .children(this.messages(t))
      .when(Boolean(this.ask) || Boolean(this.prompt) || this.leaving, el => el.child(this.bottomBar(t)));
  }
}
