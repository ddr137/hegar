// Toolkit: the skills and MCP servers an agent carries, kept on one shelf and switched on per project.
// The shelf lives in Herdr's folder: <app>/toolkit/skills/<name>/SKILL.md, <app>/toolkit/mcp.json ({ "mcps": { name: def } })
// and <app>/toolkit/projects.json (which projects have shelf items on, so a deleted item can be turned off in all of them).
// A skill is on for a project when .opencode/skills/<name> links to its folder (.agents/skills and .claude/skills follow);
// an MCP server is on when it is written to .mcp.json (Claude Code), .opencode/opencode.json and
// .agents/plugins/workspace-mcp (Antigravity). Nothing changes until the person presses Apply or Delete.
// Toolkit manages the shelf and the links and entries that come from it. A project's own skills and MCP servers are left alone.
// Find searches skills.sh and the official MCP registry; Add puts a result on the shelf, it does not turn it on.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { spaces, panes, focused, exec, theme, home, appHome, watchFolder } from "herdr";
import * as fs from "fs/promises";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());

// --- the project root: the nearest folder up from the pane (stopping before HOME) that looks like a project ---
const ROOT_SCRIPT = 'd="$1"; h="$2"; while [ "$d" != / ] && [ "$d" != "$h" ]; do for m in .git .opencode .agents pubspec.yaml package.json Cargo.toml go.mod pyproject.toml requirements.txt composer.json settings.gradle settings.gradle.kts; do [ -e "$d/$m" ] && { echo "$d"; exit 0; }; done; d=$(dirname "$d"); done; echo "$1"';

// --- MCP files and shelf operations: no Herdr calls in here; what they use (exec, fs) comes in as an argument ---
const envOf = (def) => def.environment || def.env;
const remote = (def) => Boolean(def.url || def.type === "remote" || def.type === "http");
// Values like ${TOKEN} stay as they are: Claude Code expands them itself, OpenCode gets {env:TOKEN}.
const toOpenEnv = (env) => Object.fromEntries(Object.entries(env).map(([k, v]) => [k, typeof v === "string" ? v.replace(/\$\{([^}]+)\}/g, "{env:$1}") : v]));
function claudeEntry(def) {
  if (remote(def)) return { type: "http", url: def.url, ...(def.headers ? { headers: def.headers } : {}) };
  const e = {};
  if (Array.isArray(def.command)) { e.command = def.command[0]; e.args = def.command.slice(1); }
  else if (typeof def.command === "string") { e.command = def.command; if (def.args) e.args = def.args; }
  if (def.cwd) e.cwd = def.cwd;
  if (envOf(def)) e.env = envOf(def);
  return e;
}
function openEntry(def) {
  if (remote(def)) return { type: "remote", url: def.url, enabled: def.enabled !== undefined ? def.enabled : true, ...(def.headers ? { headers: toOpenEnv(def.headers) } : {}) };
  const e = { type: "local" };
  if (Array.isArray(def.command)) e.command = def.command;
  else if (typeof def.command === "string") e.command = [def.command, ...(def.args || [])];
  if (def.cwd) e.cwd = def.cwd;
  if (envOf(def)) e.environment = toOpenEnv(envOf(def));
  return e;
}
function agyEntry(def) {
  if (remote(def)) return { url: def.url, serverUrl: def.url };
  const e = {};
  if (Array.isArray(def.command)) { e.command = def.command[0]; e.args = def.command.slice(1); }
  else if (typeof def.command === "string") { e.command = def.command; if (def.args) e.args = def.args; }
  if (def.cwd) e.cwd = def.cwd;
  if (envOf(def)) e.env = envOf(def);
  return e;
}
const json = (v) => JSON.stringify(v, null, 2) + "\n";
// What the three files hold once exactly `chosen` of the shelf is on. Servers in a file that are not on the shelf
// are the project's own and stay. `current` = { mcp, opencode } as read (or null). -> { path: text | null (delete) }
function mcpFiles(root, registry, chosen, current) {
  const keys = Object.keys(registry);
  const mcp = current.mcp && typeof current.mcp === "object" ? current.mcp : { mcpServers: {} };
  const oc = current.opencode && typeof current.opencode === "object" ? current.opencode : { $schema: "https://opencode.ai/config.json", mcp: {} };
  const own = (o) => Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => !keys.includes(k)));
  mcp.mcpServers = own(mcp.mcpServers); oc.mcp = own(oc.mcp);
  const agy = { mcpServers: {} };
  for (const k of chosen) {
    const def = registry[k]; if (!def) continue;
    mcp.mcpServers[k] = claudeEntry(def); oc.mcp[k] = openEntry(def); agy.mcpServers[k] = agyEntry(def);
  }
  const out = {};
  out[`${root}/.mcp.json`] = Object.keys(mcp.mcpServers).length ? json(mcp) : null;
  out[`${root}/.opencode/opencode.json`] = Object.keys(oc.mcp).length ? json(oc) : null;
  out[`${root}/.agents/plugins/workspace-mcp/plugin.json`] = chosen.length ? json({ name: "workspace-mcp" }) : null;
  out[`${root}/.agents/plugins/workspace-mcp/mcp_config.json`] = chosen.length ? json(agy) : null;
  return out;
}
// Writing a file, or removing it together with the folders it leaves empty (never one that still holds something).
const WRITE_FILE = 'mkdir -p "$(dirname "$2")" && printf "%s\\n" "$1" > "$2"';
const REMOVE_FILE = 'rm -f "$1"; d=$(dirname "$1"); rmdir "$d" 2>/dev/null; case "$d" in */workspace-mcp) rmdir "$(dirname "$d")" 2>/dev/null; rmdir "$(dirname "$(dirname "$d")")" 2>/dev/null ;; esac; true';
async function writeFiles(exec, files) {
  for (const [path, text] of Object.entries(files)) {
    const r = text === null
      ? await exec("sh", ["-c", REMOVE_FILE, "toolkit", path])
      : await exec("sh", ["-c", WRITE_FILE, "toolkit", text.replace(/\n$/, ""), path]);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `could not write ${path}`);
  }
}
const readJsonWith = async (fs, path) => { try { return JSON.parse(await fs.readFile(path, "utf8")); } catch { return null; } };

// Turns a skill off in every project in `roots` (links into the shelf only), then erases its folder from the shelf.
// If a project cannot be changed it stops there and the folder stays. -> the roots it was turned off in
async function deleteSkill({ exec, fs, shelf, mods, roots, name }) {
  const touched = [];
  for (const root of roots) {
    if (!(await fs.exists(root))) continue;
    const r = await exec("sh", [`${mods}/skill.sh`, "disable", root, `${shelf}/skills`, name]);
    if (r.code !== 0) throw new Error(`${root}: ${(r.stderr || r.stdout).trim()}`);
    touched.push(root);
  }
  const r = await exec("sh", [`${mods}/remove-skill.sh`, `${shelf}/skills`, name]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
  return touched;
}
// Takes an MCP server out of the three files of every project in `roots` that has it, then out of the shelf.
// A project's own servers stay. If a project cannot be changed it stops there and the shelf keeps the entry.
async function deleteMcp({ exec, fs, shelf, roots, name }) {
  const file = `${shelf}/mcp.json`, shelfNow = await readJsonWith(fs, file);
  const registry = shelfNow?.mcps ?? {};
  if (!registry[name]) throw new Error("it is not on the shelf");
  const touched = [];
  for (const root of roots) {
    if (!(await fs.exists(root))) continue;
    const mcp = await readJsonWith(fs, `${root}/.mcp.json`), opencode = await readJsonWith(fs, `${root}/.opencode/opencode.json`);
    if (!mcp?.mcpServers?.[name] && !opencode?.mcp?.[name]) continue;
    const on = new Set([...Object.keys(mcp?.mcpServers ?? {}), ...Object.keys(opencode?.mcp ?? {})]);
    const chosen = [...on].filter((k) => registry[k] && k !== name);
    await writeFiles(exec, mcpFiles(root, registry, chosen, { mcp, opencode }));
    touched.push(root);
  }
  delete registry[name];
  await fs.writeFile(file, json({ ...shelfNow, mcps: registry }));
  return touched;
}
// projects.json: which projects have shelf items on. -> the new index, or null when `root` is already recorded so.
function withProject(index, root, skills, mcps) {
  const projects = { ...(index?.projects ?? {}) };
  const next = skills.length || mcps.length ? { skills: [...skills].sort(), mcps: [...mcps].sort() } : null;
  if (JSON.stringify(projects[root] ?? null) === JSON.stringify(next)) return null;
  if (next) projects[root] = next; else delete projects[root];
  return { projects };
}
const usersOf = (index, kind, name) => Object.entries(index?.projects ?? {}).filter(([, v]) => (kind === "skill" ? v.skills : v.mcps)?.includes(name)).map(([root]) => root);

// A server of the official MCP registry as a shelf entry, or null when it needs something we do not run
// (a templated URL, a Docker image, a bundle). {placeholder} values become ${PLACEHOLDER} for the person's environment.
const envify = (s) => String(s ?? "").replace(/\{([A-Za-z0-9_]+)\}/g, (_, n) => `\${${n.toUpperCase()}}`);
function fromRegistry(s) {
  const slug = (s.name.split("/").pop() || s.name).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  const description = (s.description ?? "").replace(/\s+/g, " ").trim();
  if (!slug) return null;
  const hosted = (s.remotes ?? []).find((r) => r.type === "streamable-http" && r.url && !/[{}]/.test(r.url));
  if (hosted) {
    const headers = {};
    for (const h of hosted.headers ?? []) if (h.name) headers[h.name] = envify(h.value);
    return { slug, kind: "remote", description, def: { type: "remote", url: hosted.url, ...(Object.keys(headers).length ? { headers } : {}), description, source: s.name } };
  }
  const pkg = (s.packages ?? []).find((p) => (p.registryType === "npm" || p.registryType === "pypi") && (!p.transport || p.transport.type === "stdio"));
  if (!pkg) return null;
  const args = [];
  for (const a of pkg.packageArguments ?? []) {
    if (a.type === "named" && a.name) { args.push(a.name); if (a.value) args.push(envify(a.value)); }
    else if (a.value) args.push(envify(a.value));
  }
  const command = pkg.registryType === "npm" ? ["npx", "-y", pkg.version ? `${pkg.identifier}@${pkg.version}` : pkg.identifier, ...args] : ["uvx", pkg.identifier, ...args];
  const env = Object.fromEntries((pkg.environmentVariables ?? []).filter((v) => v.name).map((v) => [v.name, `\${${v.name}}`]));
  return { slug, kind: pkg.registryType, description, def: { type: "local", command, ...(Object.keys(env).length ? { environment: env } : {}), description, source: s.name } };
}
// --- end of the part that does not need Herdr ---

const SHELF = () => `${appHome()}/toolkit`;
const MODS = () => `${appHome()}/mods/toolkit`;
const clean = (s) => (s ?? "").trim().replace(/^["']|["']$/g, "");
const readJson = (path) => readJsonWith(fs, path);
const getJson = async (url) => {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 120)}`);
  return JSON.parse(text);
};
const kfmt = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n ?? 0);
const names = (roots) => {
  const list = roots.map((r) => r.split("/").pop());
  return list.length > 3 ? `${list.slice(0, 3).join(", ")} and ${list.length - 3} more` : list.join(", ");
};
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

export default class Toolkit extends View {
  init(_props, cx) {
    this.tab = (() => { try { const t = localStorage.getItem("tab"); return t === "mcp" || t === "find" ? t : "skills"; } catch { return "skills"; } })();
    this.master = []; this.active = new Set(); this.orphans = []; this.registry = {}; this.mcpOn = new Set(); this.custom = []; this.index = { projects: {} };
    this.staged = new Map();          // "s:name" | "m:name" -> true (turn on) | false (turn off)
    this.confirm = null;              // { kind: "skill" | "mcp", name }: a delete waiting for its button
    this.applying = false; this.adding = new Set();
    this.found = { state: "idle", skills: [], mcps: [], error: null, query: "" };
    this.query = "";
    this.filter = InputState.new({ placeholder: "Filter" });
    this.filter.on("change", (_e, cx) => { this.query = this.filter.value().trim().toLowerCase(); cx.notify(); });
    this.filter.on("focus", (_e, cx) => { this.typing = "filter"; cx.notify(); });
    this.filter.on("blur", (_e, cx) => { this.typing = null; cx.notify(); });
    this.finder = InputState.new({ placeholder: "Search skills & MCP servers online" });
    this.finder.on("submit", (_e, cx) => this.search(cx));
    this.finder.on("focus", (_e, cx) => { this.typing = "find"; cx.notify(); });
    this.finder.on("blur", (_e, cx) => { this.typing = null; cx.notify(); });
    this.refresh(cx, true);
    cx.timer.every(15000, (cx) => this.refresh(cx));
    this.watchShelf(cx);
  }

  // A skill or server put on the shelf by hand, by Find, or by another window shows up without pressing refresh.
  watchShelf(cx) {
    cx.spawn(async (cx) => {
      try {
        await fs.mkdir(`${SHELF()}/skills`, { recursive: true });
        for (;;) { await watchFolder(SHELF()); this.refresh(cx, true); }
      } catch { /* no folder watching here: the refresh button and the timer still work */ }
    });
  }

  async findRoot(cwd) {
    const r = await exec("sh", ["-c", ROOT_SCRIPT, "toolkit", cwd, home()]);
    return r.code === 0 ? r.stdout.trim() || cwd : cwd;
  }

  // Reads what is on for the project; the shelf itself only when asked (it changes rarely).
  refresh(cx, full = false) {
    if (this.loading || this.applying) { this.again = true; if (full) this.reloadShelf = true; return; }
    if (this.reloadShelf) { full = true; this.reloadShelf = false; }
    const { cwd, on } = location(), context = key();
    if (context !== this.context) { this.context = context; this.root = null; this.error = null; full = true; this.note = null; this.notice = null; this.staged.clear(); this.confirm = null; }
    if (on) { this.error = "Skills and MCP are managed for local folders only"; return; }
    if (!cwd) { this.error = "No folder"; return; }
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const root = await this.findRoot(cwd);
        if (key() !== context) return;
        const base = SHELF();
        if (full || !this.master.length) {
          await fs.mkdir(`${base}/skills`, { recursive: true }).catch(() => {});
          const r = await exec("sh", [`${MODS()}/list-skills.sh`, `${base}/skills`]);
          this.master = r.stdout.split("\n").filter(Boolean).map((l) => { const [name, ...d] = l.split("\t"); return { name, description: clean(d.join("\t")) }; });
          this.registry = (await readJson(`${base}/mcp.json`))?.mcps ?? {};
          this.index = (await readJson(`${base}/projects.json`)) ?? { projects: {} };
        }
        const unsafe = root === home() || root === "/";
        const links = unsafe ? [] : (await exec("sh", [`${MODS()}/list-active.sh`, root, `${base}/skills`])).stdout.split("\n").filter(Boolean).map((l) => l.split("\t"));
        const project = Object.keys((await readJson(`${root}/.mcp.json`))?.mcpServers ?? {});
        if (key() !== context) return;
        const onShelf = new Set(this.master.map((m) => m.name));
        this.root = root; this.unsafe = unsafe;
        this.active = new Set(links.filter(([n, k]) => k === "ok" && onShelf.has(n)).map(([n]) => n));
        this.orphans = links.filter(([n, k]) => k !== "ok" || !onShelf.has(n)).map(([n]) => n);   // links into the shelf whose skill is gone
        this.mcpOn = new Set(project.filter((k) => this.registry[k]));
        this.custom = project.filter((k) => !this.registry[k]);
        this.error = null;
        if (!unsafe) {
          const next = withProject(this.index, root, [...this.active], [...this.mcpOn]);
          if (next) { this.index = next; await fs.writeFile(`${base}/projects.json`, json(next)).catch(() => {}); }
        }
      } catch (e) { if (key() === context) this.error = String(e); }
      finally {
        this.loading = false;
        if (this.again) { this.again = false; this.refresh(cx, false); }
        cx.notify();
      }
    });
  }

  // A click only stages the change; Apply makes it.
  stage(id, current, cx) {
    if (this.applying || this.confirm || !this.root || this.unsafe) return;
    const want = this.staged.has(id) ? !this.staged.get(id) : !current;
    if (want === current) this.staged.delete(id); else this.staged.set(id, want);
    this.note = null; this.notice = null; cx.notify();
  }

  apply(cx) {
    if (!this.staged.size || this.applying || this.confirm || !this.root || this.unsafe) return;
    const root = this.root, context = this.context, changes = [...this.staged];
    this.applying = true; this.note = null; this.notice = null;
    cx.spawn(async (cx) => {
      const failed = [];
      try {
        for (const [id, want] of changes.filter(([i]) => i.startsWith("s:"))) {
          const name = id.slice(2);
          const r = await exec("sh", [`${MODS()}/skill.sh`, want ? "enable" : "disable", root, `${SHELF()}/skills`, name]);
          if (r.code === 0) this.staged.delete(id); else failed.push(`${name}: ${(r.stderr || r.stdout).trim()}`);
        }
        const servers = changes.filter(([i]) => i.startsWith("m:"));
        if (servers.length) {
          try {
            const chosen = new Set(this.mcpOn);
            for (const [id, want] of servers) want ? chosen.add(id.slice(2)) : chosen.delete(id.slice(2));
            await writeFiles(exec, mcpFiles(root, this.registry, [...chosen], { mcp: await readJson(`${root}/.mcp.json`), opencode: await readJson(`${root}/.opencode/opencode.json`) }));
            for (const [id] of servers) this.staged.delete(id);
          } catch (e) { failed.push(`MCP: ${String(e).replace(/^Error: /, "")}`); }
        }
      } finally {
        this.applying = false;
        if (failed.length && this.context === context) this.note = failed.join(" · ");
        this.refresh(cx, false); cx.notify();
      }
    });
    cx.notify();
  }

  // --- delete: asks first, says what it will do, and does it only on the button ---
  askDelete(kind, name, cx) {
    if (this.applying) return;
    this.confirm = { kind, name }; this.note = null; this.notice = null; cx.notify();
  }

  doDelete(cx) {
    if (!this.confirm || this.applying) return;
    const { kind, name } = this.confirm, context = this.context;
    const roots = [...new Set([...usersOf(this.index, kind, name), ...(this.root && (kind === "skill" ? this.active.has(name) : this.mcpOn.has(name)) ? [this.root] : [])])];
    this.applying = true; this.note = null; this.notice = null;
    cx.spawn(async (cx) => {
      try {
        const args = { exec, fs, shelf: SHELF(), mods: MODS(), roots, name };
        const done = kind === "skill" ? await deleteSkill(args) : await deleteMcp(args);
        this.staged.delete(`${kind === "skill" ? "s" : "m"}:${name}`);
        this.confirm = null;
        this.notice = `Deleted ${kind === "skill" ? "skill" : "MCP server"} “${name}” from the shelf` + (done.length ? ` and turned it off in ${plural(done.length, "project")}` : "");
      } catch (e) {
        this.confirm = null;
        if (this.context === context) this.note = `Could not delete “${name}”: ${String(e).replace(/^Error: /, "")}. It is still on the shelf; it may already be off in some projects.`;
      } finally {
        this.applying = false;
        this.refresh(cx, true); cx.notify();
      }
    });
    cx.notify();
  }

  setTab(tab, cx) {
    this.tab = tab; this.filter.set_value(""); this.query = ""; this.confirm = null;
    try { localStorage.setItem("tab", tab); } catch {}
    cx.notify();
  }

  // --- Find: skills.sh and the official MCP registry ---
  search(cx) {
    const q = this.finder.value().trim();
    if (q.length < 2 || this.found.state === "loading") return;
    this.found = { state: "loading", skills: [], mcps: [], error: null, query: q };
    cx.notify();
    cx.spawn(async (cx) => {
      const enc = encodeURIComponent(q);
      const [sk, mc] = await Promise.allSettled([
        getJson(`https://skills.sh/api/search?q=${enc}&limit=20`),
        getJson(`https://registry.modelcontextprotocol.io/v0/servers?search=${enc}&limit=30&version=latest`),
      ]);
      const skills = sk.status === "fulfilled" ? (sk.value.skills ?? []).filter((s) => s.source && s.skillId) : [];
      const seen = new Set();
      const mcps = mc.status === "fulfilled" ? (mc.value.servers ?? []).map((x) => ({ raw: x.server, conv: fromRegistry(x.server) })).filter((x) => x.raw?.name && !seen.has(x.raw.name) && seen.add(x.raw.name)) : [];
      const errors = [sk, mc].filter((r) => r.status === "rejected").map((r) => String(r.reason).replace(/^Error: /, ""));
      this.found = { state: "done", skills, mcps, error: errors.length === 2 ? errors[0] : null, partial: errors.length === 1, query: q };
      cx.notify();
    });
  }

  addSkill(s, cx) {
    const id = `s:${s.source}/${s.skillId}`;
    if (this.adding.has(id)) return;
    this.adding.add(id); this.note = null; this.notice = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", [`${MODS()}/add-skill.sh`, s.source, s.skillId, `${SHELF()}/skills`], { timeout: 130000 });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `exit ${r.code}`);
      } catch (e) { this.note = `${s.skillId}: ${String(e).replace(/^Error: /, "")}`; }
      finally { this.adding.delete(id); this.refresh(cx, true); cx.notify(); }
    });
  }

  addMcp(x, cx) {
    const id = `m:${x.raw.name}`;
    if (!x.conv || this.adding.has(id)) return;
    this.adding.add(id); this.note = null; this.notice = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const file = `${SHELF()}/mcp.json`, now = (await readJson(file)) ?? { mcps: {} };
        now.mcps = now.mcps ?? {};
        let slug = x.conv.slug, n = 2;
        while (now.mcps[slug]) slug = `${x.conv.slug}-${n++}`;
        now.mcps[slug] = x.conv.def;
        await fs.writeFile(file, json(now));
      } catch (e) { this.note = `${x.conv.slug}: ${String(e).replace(/^Error: /, "")}`; }
      finally { this.adding.delete(id); this.refresh(cx, true); cx.notify(); }
    });
  }

  // --- drawing ---
  // `kind` is "skill" or "mcp"; `canDelete` is false for what is not on the shelf (a link without its skill).
  row(kind, name, current, title, sub, canDelete, t) {
    const id = `${kind === "skill" ? "s" : "m"}:${name}`;
    const staged = this.staged.has(id), shown = staged ? this.staged.get(id) : current;
    const asking = this.confirm?.kind === kind && this.confirm.name === name;
    return h_flex().id(`row-${id}`).flex_none().min_h(44).px(8).py(6).gap(10).items_center().rounded(7).cursor_pointer().hover((s) => s.bg(t.hover))
      .when(staged, (e) => e.bg(t.raised)).when(asking, (e) => e.bg(t.raised).border_1().border_color(t.ansi1)).when(this.applying, (e) => e.opacity(0.5))
      .on_click((_e, cx) => this.stage(id, current, cx))
      .child(div().size(16).flex_none().flex().items_center().justify_center().rounded(4).border_1().border_color(shown ? t.accent : t.border).bg(shown ? t.accent : t.background)
        .when(shown, (e) => e.child(svg("mods/toolkit/check.svg").size(11).text_color(t.background))))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().truncate().text_size(12.5).text_color(shown ? t.foreground : t.muted).child(title))
        .when(Boolean(sub), (e) => e.child(div().truncate().text_size(11).text_color(t.dim).child(sub))))
      .when(staged, (e) => e.child(div().flex_none().text_size(10.5).text_color(shown ? t.ansi2 : t.ansi1).child(shown ? "turn on" : "turn off")))
      .when(canDelete, (e) => e.child(div().id(`del-${id}`).size(24).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover((s) => s.text_color(t.ansi1).bg(t.hover))
        .on_click((_e, cx) => { cx.stop_propagation(); this.askDelete(kind, name, cx); })
        .child(svg("mods/toolkit/trash.svg").size(14))));
  }

  button(id, label, kind, enabled, click, t) {
    const filled = kind === "primary" || kind === "danger", bg = kind === "danger" ? t.ansi1 : t.solid;
    return div().id(id).h(26).px(11).flex_none().flex().items_center().rounded(7).text_size(12)
      .border_1().border_color(filled && enabled ? bg : t.border)
      .bg(filled && enabled ? bg : t.background).text_color(filled && enabled ? (kind === "danger" ? "#ffffff" : t.solid_foreground) : enabled ? t.foreground : t.dim)
      .when(enabled, (e) => e.cursor_pointer().hover((s) => s.opacity(0.85))).on_click((_e, cx) => { if (enabled) click(cx); }).child(label);
  }

  pill(id, label, count, tab, t) {
    const on = this.tab === tab;
    return h_flex().id(id).h(26).px(9).gap(5).items_center().rounded(6).cursor_pointer().text_size(12).bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.setTab(tab, cx))
      .child(label).when(count !== null, (e) => e.child(div().text_size(10.5).text_color(t.dim).child(String(count))));
  }

  resultRow(id, title, sub, label, state, click, t) {
    // state: "add" | "adding" | "have" | "no"
    return h_flex().id(`res-${id}`).flex_none().min_h(46).px(8).py(6).gap(10).items_center().rounded(7).hover((s) => s.bg(t.hover))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().truncate().text_size(12.5).text_color(t.foreground).child(title))
        .child(div().truncate().text_size(11).text_color(t.dim).child(sub)))
      .child(state === "have" ? div().flex_none().text_size(11).text_color(t.ansi2).child("On shelf")
        : state === "no" ? div().flex_none().text_size(11).text_color(t.dim).child("Not supported")
        : this.button(`add-${id}`, state === "adding" ? "Adding…" : label, "plain", state === "add", click, t));
  }

  findRows(t) {
    const f = this.found, rows = [];
    const head = (text) => div().flex_none().px(8).pt(8).pb(3).text_size(10.5).text_color(t.dim).child(text);
    if (f.state === "idle") return [div().p(10).text_size(12).text_color(t.dim).child("Search skills.sh and the official MCP registry. Add puts a result on the shelf; turning it on for a project is a separate step with its own confirmation.")];
    if (f.state === "loading") return [div().p(10).text_size(12).text_color(t.dim).child(`Searching for “${f.query}”…`)];
    if (f.error) return [div().p(10).text_size(12).text_color(t.ansi1).child(`Search failed: ${f.error}`)];
    if (f.partial) rows.push(div().flex_none().px(10).py(4).text_size(11).text_color(t.ansi1).child("One of the two sources did not answer"));
    if (f.skills.length) {
      rows.push(head(`SKILLS · skills.sh · ${f.skills.length}`));
      for (const s of f.skills) {
        const id = `s:${s.source}/${s.skillId}`, have = this.master.some((m) => m.name === s.skillId), github = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(s.source);
        rows.push(this.resultRow(id, s.name ?? s.skillId, `${s.source} · ${kfmt(s.installs)} installs${github ? "" : " · not on GitHub"}`, "Add", have ? "have" : !github ? "no" : this.adding.has(id) ? "adding" : "add", (cx) => this.addSkill(s, cx), t));
      }
    }
    if (f.mcps.length) {
      rows.push(head(`MCP SERVERS · registry.modelcontextprotocol.io · ${f.mcps.length}`));
      for (const x of f.mcps) {
        const id = `m:${x.raw.name}`, have = Object.values(this.registry).some((d) => d.source === x.raw.name);
        const kind = x.conv ? (x.conv.kind === "remote" ? "remote" : x.conv.kind === "npm" ? "npx" : "uvx") : "needs Docker or a bundle";
        rows.push(this.resultRow(id, x.raw.name, `${kind} · ${x.conv?.description || x.raw.description || ""}`, "Add", !x.conv ? "no" : have ? "have" : this.adding.has(id) ? "adding" : "add", (cx) => this.addMcp(x, cx), t));
      }
    }
    if (!f.skills.length && !f.mcps.length) rows.push(div().p(10).text_size(12).text_color(t.dim).child(`Nothing found for “${f.query}”`));
    return rows;
  }

  // What a delete will do, in words, before the button.
  deleteBar(t) {
    const { kind, name } = this.confirm, where = usersOf(this.index, kind, name);
    const roots = [...new Set([...where, ...(this.root && (kind === "skill" ? this.active.has(name) : this.mcpOn.has(name)) ? [this.root] : [])])];
    const what = kind === "skill" ? "skill" : "MCP server";
    const detail = (kind === "skill" ? "Its folder is erased from the shelf for good. " : "Its entry is erased from the shelf for good. ")
      + (roots.length ? `It is also turned off in ${names(roots)} (${plural(roots.length, "project")}). ` : "It is not turned on in any project Toolkit knows. ")
      + "A project's own skills and servers are not touched, and neither are projects Toolkit has not seen.";
    return v_flex().flex_none().px(10).py(9).gap(7).border_t(1).border_color(t.border).bg(t.raised)
      .child(div().text_size(12).font_semibold().child(`Delete ${what} “${name}”?`))
      .child(div().text_size(11).text_color(t.dim).child(detail))
      .child(h_flex().gap(8).justify_end()
        .child(this.button("toolkit-del-cancel", "Cancel", "plain", !this.applying, (cx) => { this.confirm = null; cx.notify(); }, t))
        .child(this.button("toolkit-del-go", this.applying ? "Deleting…" : "Delete", "danger", !this.applying, (cx) => this.doDelete(cx), t)));
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx, true);
    const t = theme(), q = this.query, find = this.tab === "find", skills = this.tab === "skills";
    const match = (...s) => !q || s.some((x) => x?.toLowerCase().includes(q));
    let rows = [];
    if (find) rows = this.findRows(t);
    else if (skills) {
      const on = (n) => this.staged.has(`s:${n}`) ? this.staged.get(`s:${n}`) : this.active.has(n);
      const list = this.master.filter((s) => match(s.name, s.description)).sort((a, b) => Number(on(b.name)) - Number(on(a.name)) || a.name.localeCompare(b.name));
      for (const s of list) rows.push(this.row("skill", s.name, this.active.has(s.name), s.name, s.description, true, t));
      for (const n of this.orphans.filter((n) => match(n))) rows.push(this.row("skill", n, true, n, "a link to a skill that is no longer on the shelf · turn it off to remove the link", false, t));
    } else {
      const on = (n) => this.staged.has(`m:${n}`) ? this.staged.get(`m:${n}`) : this.mcpOn.has(n);
      const list = Object.entries(this.registry).filter(([k, d]) => match(k, d.description)).sort(([a], [b]) => Number(on(b)) - Number(on(a)) || a.localeCompare(b));
      for (const [k, d] of list) rows.push(this.row("mcp", k, this.mcpOn.has(k), k, `${remote(d) ? "remote" : "local"} · ${d.description ?? ""}`, true, t));
      for (const k of this.custom.filter((k) => match(k))) rows.push(h_flex().flex_none().min_h(36).px(8).gap(10).items_center().text_size(12).text_color(t.dim).child(div().size(16).flex_none()).child(div().flex_1().truncate().child(`${k} · this project's own, not managed here`)));
    }
    const name = this.root?.split("/").pop() ?? "", n = this.staged.size;
    const empty = !find && !rows.length;
    const input = (state, id, typing) => div().id(id).flex_1().min_w(0).h(28).px(9).flex().items_center().rounded(7).border_1().border_color(this.typing === typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(Input.new(state).h_full().text_size(12).text_color(t.foreground));
    return v_flex().id("toolkit").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Toolkit"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(name))
        .child(div().id("toolkit-refresh").size(24).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.refresh(cx, true))
          .child(svg("mods/toolkit/refresh.svg").size(14).text_color(t.muted))))
      .child(h_flex().flex_none().p(10).gap(6).items_center().border_b(1).border_color(t.border)
        .child(this.pill("tab-skills", "Skills", this.active.size, "skills", t)).child(this.pill("tab-mcp", "MCP", this.mcpOn.size, "mcp", t)).child(this.pill("tab-find", "Find", null, "find", t))
        .child(find ? input(this.finder, "toolkit-find", "find") : input(this.filter, "toolkit-filter", "filter"))
        .when(find, (e) => e.child(this.button("toolkit-search", this.found.state === "loading" ? "…" : "Search", "primary", this.found.state !== "loading", (cx) => this.search(cx), t))))
      .child(v_flex().id("toolkit-list").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(rows)
        .when(!find && (Boolean(this.error) || this.unsafe || empty), (e) => e.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.unsafe ? "Open a project folder: HOME and / are not managed" : this.loading ? "Loading…" : q ? "Nothing matches" : skills ? "No skills on the shelf yet: use Find to add some" : "No MCP servers on the shelf yet: use Find to add some")))))
      .when(Boolean(this.notice), (e) => e.child(div().px(10).py(6).text_size(11).text_color(t.ansi2).child(this.notice)))
      .when(Boolean(this.note), (e) => e.child(div().px(10).py(6).text_size(11).text_color(t.ansi1).child(this.note)))
      .child(this.confirm
        ? this.deleteBar(t)
        : n > 0
        ? h_flex().flex_none().px(10).py(8).gap(8).items_center().border_t(1).border_color(t.border).bg(t.raised)
            .child(div().flex_1().min_w(0).truncate().text_size(12).child(`${plural(n, "change")} for ${name || "this folder"}`))
            .child(this.button("toolkit-cancel", "Cancel", "plain", !this.applying, (cx) => { this.staged.clear(); cx.notify(); }, t))
            .child(this.button("toolkit-apply", this.applying ? "Applying…" : "Apply", "primary", !this.applying, (cx) => this.apply(cx), t))
        : div().flex_none().px(12).py(7).border_t(1).border_color(t.border).text_size(11).text_color(t.dim).truncate()
            .child(find ? "Results come from skills.sh and registry.modelcontextprotocol.io" : `${this.active.size} skills · ${this.mcpOn.size} MCP in ${name || "this folder"} · agents read them on their next start`));
  }
}
