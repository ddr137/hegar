// Toolkit: the skills and MCP servers an agent carries, kept on one shelf and switched on per project and per agent.
// The shelf lives in Herdr's folder: <app>/toolkit/skills/<name>/SKILL.md, <app>/toolkit/mcp.json ({ "mcps": { name: def } })
// and <app>/toolkit/projects.json (which projects have shelf items on, so a deleted item can be turned off in all of them).
// The person picks which agents a change is for (Claude, OpenCode, Antigravity); each agent has its own place in a project,
// the one that agent reads (checked against the three agents themselves):
//   skill      Claude .claude/skills/<name>   OpenCode .opencode/skills/<name>   (symlinks to the shelf)
//              Antigravity .agents/skills/<name>   (a real copy: Antigravity does not follow symlinks; kept in step with the shelf)
//   MCP server Claude .mcp.json               OpenCode .opencode/opencode.json   Antigravity .agents/plugins/workspace-mcp/mcp_config.json
// OpenCode also reads .claude/skills and .agents/skills, so a skill that is on for Claude or Antigravity but not for OpenCode
// gets a "deny" in OpenCode's skill permission: choosing one agent really means that agent.
// Nothing changes until the person presses Apply or Delete. Toolkit manages the shelf and the links and entries that come from
// it. A project's own skills and MCP servers are left alone.
// Find searches skills.sh and the official MCP registry; Add puts a result on the shelf, it does not turn it on.
// Agents (subagents) are kept on the shelf too, as <app>/toolkit/agents/<name>.md (name, description, instructions); each agent gets
// a real file written from it in its own folder (.claude/agents, .opencode/agents, .agents/agents; see agent.sh).
// Plugins and Hooks are not kept on a shelf: they are what the agents themselves have (read from their CLIs and settings files).
// Plugins can be turned on and off and uninstalled with the agent's own command; Hooks are listed only (a hook runs a command by itself).
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, Editor, EditorState } from "gpui-base";
import { spaces, panes, focused, exec, theme, home, appHome, watchFolder, checking, settings } from "herdr";
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
// `icon`: the picture Herdr itself keeps for each agent (<app>/icons). Claude's and Antigravity's are drawn with image(), exactly as
// Herdr's own status bar draws them, so they look the same there and here. OpenCode's has no colour of its own (it is drawn in the
// text colour), so it is drawn with svg() and follows the theme.
const AGENTS = [
  { key: "claude", label: "Claude", icon: "icons/claude.svg", own: true },
  { key: "opencode", label: "OpenCode", icon: "icons/opencode.svg", own: false },
  { key: "antigravity", label: "Antigravity", icon: "icons/antigravity.svg", own: true },
];
const KEYS = AGENTS.map((a) => a.key);
// The lists of the panel, and which agents have each thing (OpenCode has no hooks file; its plugins have no off switch).
const TABS = [
  { key: "skills", label: "Skills" }, { key: "agents", label: "Agents" }, { key: "mcp", label: "MCP" },
  { key: "plugins", label: "Plugins" }, { key: "hooks", label: "Hooks" },
];
const SUPPORT = { skills: KEYS, agents: KEYS, mcp: KEYS, plugins: KEYS, hooks: ["claude", "antigravity"] };
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
// Antigravity keeps to command, args, env, cwd, url, headers, variables (anything else is dropped). It does not expand ${X}
// from the environment unless X is declared in `variables` (the person fills it in on the plugin's page), and a stdio env entry
// that only passes X through ("X": "${X}") is redundant: the server inherits X.
const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const passThrough = ([k, v]) => v === `\${${k}}` || v === `$${k}`;
function agyParts(def) {
  const e = {};
  if (remote(def)) {
    e.url = def.url;
    if (def.headers) e.headers = def.headers;
  } else {
    if (Array.isArray(def.command)) { e.command = def.command[0]; e.args = def.command.slice(1); }
    else if (typeof def.command === "string") { e.command = def.command; if (def.args) e.args = def.args; }
    if (def.cwd) e.cwd = def.cwd;
    const env = Object.fromEntries(Object.entries(envOf(def) ?? {}).filter((kv) => !passThrough(kv)));
    if (Object.keys(env).length) e.env = env;
  }
  const names = new Set(), scan = (v) => { if (typeof v === "string") for (const m of v.matchAll(PLACEHOLDER)) names.add(m[1]); };
  scan(e.url); scan(e.command); (e.args ?? []).forEach(scan); Object.values(e.env ?? {}).forEach(scan); Object.values(e.headers ?? {}).forEach(scan);
  return { e, names: [...names] };
}
function agyEntry(def) {
  const { e, names } = agyParts(def);
  if (names.length) e.variables = names.map((name) => ({ name, title: name, description: `Set ${name} on the workspace-mcp plugin page` }));
  return e;
}
const agyVars = (def) => agyParts(def).names;
const json = (v) => JSON.stringify(v, null, 2) + "\n";
const projectFiles = (root) => ({
  claude: `${root}/.mcp.json`,
  opencode: `${root}/.opencode/opencode.json`,
  antigravity: `${root}/.agents/plugins/workspace-mcp/mcp_config.json`,
});
const AGY_PLUGIN = (root) => `${root}/.agents/plugins/workspace-mcp/plugin.json`;
// The server names a project's file for an agent holds.
const serversOf = (agent, file) => Object.keys((agent === "opencode" ? file?.mcp : file?.mcpServers) ?? {});
// What the files hold once, for each agent in `plan` ({ agent: Set of shelf servers that are on }), exactly those are on.
// Servers in a file that are not on the shelf are the project's own and stay, and so does everything else in the file.
// `deny` ({ skill: true | false }) sets OpenCode's skill permission for shelf skills. `current` = { agent: parsed file | null }.
// -> { path: text | null (delete) }, only for the files it touches.
function mcpFiles(root, registry, plan, current, deny = {}) {
  const keys = Object.keys(registry), own = (o) => Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => !keys.includes(k)));
  const out = {}, files = projectFiles(root);
  if (plan.claude) {
    const file = { ...(current.claude ?? {}) }, servers = own(file.mcpServers);
    for (const k of plan.claude) if (registry[k]) servers[k] = claudeEntry(registry[k]);
    if (Object.keys(servers).length) file.mcpServers = servers; else delete file.mcpServers;
    out[files.claude] = Object.keys(file).length ? json(file) : null;
  }
  const denies = Object.entries(deny);
  if (plan.opencode || denies.length) {
    const oc = current.opencode ? { ...current.opencode } : { $schema: "https://opencode.ai/config.json" };
    if (plan.opencode) {
      const mcp = own(oc.mcp);
      for (const k of plan.opencode) if (registry[k]) mcp[k] = openEntry(registry[k]);
      if (Object.keys(mcp).length) oc.mcp = mcp; else delete oc.mcp;
    }
    if (denies.length) {
      const permission = oc.permission && typeof oc.permission === "object" ? { ...oc.permission } : {};
      const was = permission.skill;
      const skill = typeof was === "string" ? { "*": was } : { ...(was ?? {}) };
      for (const [n, v] of denies) { if (v) skill[n] = "deny"; else if (skill[n] === "deny") delete skill[n]; }
      if (Object.keys(skill).length) permission.skill = skill; else delete permission.skill;
      if (Object.keys(permission).length) oc.permission = permission; else delete oc.permission;
    }
    out[files.opencode] = Object.keys(oc).some((k) => k !== "$schema") ? json(oc) : null;
  }
  if (plan.antigravity) {
    const file = { ...(current.antigravity ?? {}) }, servers = own(file.mcpServers);
    for (const k of plan.antigravity) if (registry[k]) servers[k] = agyEntry(registry[k]);
    if (Object.keys(servers).length) file.mcpServers = servers; else delete file.mcpServers;
    const has = Object.keys(file).length > 0;
    out[AGY_PLUGIN(root)] = has ? json({ name: "workspace-mcp", displayName: "Toolkit", description: "MCP servers turned on from Toolkit" }) : null;
    out[files.antigravity] = has ? json(file) : null;
  }
  return out;
}
// Writing a file, or removing it together with the folders it leaves empty (never one that still holds something).
// Written to a temporary file next to it and moved into place, so a crash cannot leave half a file (the old mode is kept; a file that is a
// link, as in a dotfiles setup, is written through the link).
const WRITE_FILE = 'mkdir -p "$(dirname "$2")" || exit 1; if [ -L "$2" ]; then printf "%s\\n" "$1" > "$2"; exit $?; fi; tmp="$2.toolkit-tmp.$$"; if [ -f "$2" ]; then cp -p "$2" "$tmp" || exit 1; fi; printf "%s\\n" "$1" > "$tmp" && mv -f "$tmp" "$2" || { rm -f "$tmp"; exit 1; }';
const REMOVE_FILE = 'rm -f "$1"; d=$(dirname "$1"); rmdir "$d" 2>/dev/null; case "$d" in */workspace-mcp) rmdir "$(dirname "$d")" 2>/dev/null; rmdir "$(dirname "$(dirname "$d")")" 2>/dev/null ;; esac; true';
// Before a file is changed or removed a copy of it goes to the backups folder (see backup.sh); if that cannot be done the file is not touched.
const SAFETY = { backups: null, mods: null };
const configureSafety = (backups, mods) => { SAFETY.backups = backups; SAFETY.mods = mods; };
async function writeFiles(exec, files) {
  for (const [path, text] of Object.entries(files)) {
    if (SAFETY.backups) {
      const b = await exec("sh", [`${SAFETY.mods}/backup.sh`, path, SAFETY.backups]);
      if (b.code !== 0) throw new Error(`could not keep a copy of ${path} first, so it was not changed`);
    }
    const r = text === null
      ? await exec("sh", ["-c", REMOVE_FILE, "toolkit", path])
      : await exec("sh", ["-c", WRITE_FILE, "toolkit", text.replace(/\n$/, ""), path]);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `could not write ${path}`);
  }
}
// null when the file is not there; an error when it is there but is not plain JSON (a file with comments, say): such a file is
// never read as empty, because the next write would replace it.
const readJsonWith = async (fs, path) => {
  let text;
  try { text = await fs.readFile(path, "utf8"); } catch { return null; }
  if (!text.trim()) return null;
  let value;
  try { value = JSON.parse(text); } catch { throw new Error(`${path} is not plain JSON (comments?), so Toolkit leaves it alone`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} is not a JSON object, so Toolkit leaves it alone`);
  return value;
};
// The parsed files of the given agents (default all) in a project; one that is not plain JSON is an error.
const readProject = async (fs, root, agents = KEYS) => Object.fromEntries(await Promise.all(agents.map(async (a) => [a, await readJsonWith(fs, projectFiles(root)[a])])));

// Turns a skill off for every agent in every project in `roots` (links into the shelf only, and OpenCode's deny for it), then
// erases its folder from the shelf. If a project cannot be changed it stops there and the folder stays. -> the roots it was turned off in
async function deleteSkill({ exec, fs, shelf, mods, roots, name }) {
  const touched = [];
  for (const root of roots) {
    if (!(await fs.exists(root))) continue;
    const r = await exec("sh", [`${mods}/skill.sh`, "disable", root, `${shelf}/skills`, name, ...KEYS]);
    if (r.code !== 0) throw new Error(`${root}: ${(r.stderr || r.stdout).trim()}`);
    const oc = await readJsonWith(fs, projectFiles(root).opencode);
    if (oc?.permission?.skill?.[name] === "deny") await writeFiles(exec, mcpFiles(root, {}, {}, { opencode: oc }, { [name]: false }));
    touched.push(root);
  }
  const r = await exec("sh", [`${mods}/remove-skill.sh`, `${shelf}/skills`, name]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
  return touched;
}
// Turns an agent off for every agent in every project in `roots` (only the files Toolkit wrote), then erases it from the shelf.
// If a project cannot be changed it stops there and the shelf file stays. -> the roots it was turned off in
async function deleteAgent({ exec, fs, shelf, mods, roots, name }) {
  if (!AGENT_NAME.test(name)) throw new Error("not an agent name");
  const touched = [];
  for (const root of roots) {
    if (!(await fs.exists(root))) continue;
    const r = await exec("sh", [`${mods}/agent.sh`, "disable", root, `${shelf}/agents`, name, ...KEYS]);
    if (r.code !== 0) throw new Error(`${root}: ${(r.stderr || r.stdout).trim()}`);
    touched.push(root);
  }
  const file = `${shelf}/agents/${name}.md`;
  const r = await exec("rm", ["-f", "--", file]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || "could not remove it");
  return touched;
}
// Takes an MCP server out of the files of every agent in every project in `roots` that has it, then out of the shelf.
// A project's own servers stay. If a project cannot be changed it stops there and the shelf keeps the entry.
async function deleteMcp({ exec, fs, shelf, roots, name }) {
  const file = `${shelf}/mcp.json`, shelfNow = await readJsonWith(fs, file);
  const registry = shelfNow?.mcps ?? {};
  if (!registry[name]) throw new Error("it is not on the shelf");
  const touched = [];
  for (const root of roots) {
    if (!(await fs.exists(root))) continue;
    const current = await readProject(fs, root), plan = {};
    for (const a of KEYS) {
      const servers = serversOf(a, current[a]);
      if (servers.includes(name)) plan[a] = new Set(servers.filter((k) => registry[k] && k !== name));
    }
    if (!Object.keys(plan).length) continue;
    await writeFiles(exec, mcpFiles(root, registry, plan, current));
    touched.push(root);
  }
  delete registry[name];
  await fs.writeFile(file, json({ ...shelfNow, mcps: registry }));
  return touched;
}
// projects.json: which projects have shelf items on. -> the new index, or null when `root` is already recorded so.
function withProject(index, root, skills, mcps, agents = []) {
  const projects = { ...(index?.projects ?? {}) };
  const next = skills.length || mcps.length || agents.length ? { skills: [...skills].sort(), mcps: [...mcps].sort(), ...(agents.length ? { agents: [...agents].sort() } : {}) } : null;
  if (JSON.stringify(projects[root] ?? null) === JSON.stringify(next)) return null;
  if (next) projects[root] = next; else delete projects[root];
  return { projects };
}
const usersOf = (index, kind, name) => Object.entries(index?.projects ?? {}).filter(([, v]) => (kind === "skill" ? v.skills : kind === "agent" ? v.agents : v.mcps)?.includes(name)).map(([root]) => root);
// What OpenCode must not see: a skill that is on for Claude or Antigravity (OpenCode reads their folders too) but not for OpenCode.
const denied = (on) => Boolean((on.claude || on.antigravity) && !on.opencode);

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
// Tracking where shelf items came from, to find out when they have a newer version. sources.json on the shelf:
// { checkedAt, skills: { name: { repo, id, path, commit, tree, fp, latest: { path, tree, commit } | null, gone } },
//   mcps: { name: { source, version, fp, latest: { version } | null } } }
// `tree` is the git id of the skill's folder in the repo (it changes when anything inside changes); `fp` is a fingerprint of what
// was put on the shelf, so an item edited there afterwards can be told from one that is as it was installed.
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0; return h.toString(16); };
const stable = (v) => Array.isArray(v) ? `[${v.map(stable).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}` : JSON.stringify(v);
const defFp = (def) => hash(stable(def));
function trackOf(kind, rec, fp) {
  if (!rec) return { tracked: false, update: false, edited: false, gone: false };
  const l = rec.latest;
  const newer = Boolean(l) && (kind === "skill" ? Boolean(l.tree) && l.tree !== rec.tree : Boolean(l.version) && l.version !== rec.version);
  return { tracked: true, update: newer && !rec.gone, edited: Boolean(rec.fp) && fp !== rec.fp, gone: Boolean(rec.gone) };
}
// What add-skill.sh printed about where the skill came from (its last line), or null.
function parseSource(stdout) {
  const line = stdout.split("\n").reverse().find((l) => l.startsWith("toolkit-source\t"));
  if (!line) return null;
  const [, commit, tree, path, fp] = line.split("\t");
  return commit && tree && path ? { commit, tree, path, fp: fp ?? "" } : null;
}
// After a server's entry on the shelf changed: write the new entry into every project where it is on, for every agent that has it.
async function reapplyMcp({ exec, fs, roots, name, registry }) {
  const touched = [];
  for (const root of roots) {
    if (!(await fs.exists(root))) continue;
    const current = await readProject(fs, root), plan = {};
    for (const a of KEYS) {
      const servers = serversOf(a, current[a]);
      if (servers.includes(name)) plan[a] = new Set(servers.filter((k) => registry[k]));
    }
    if (!Object.keys(plan).length) continue;
    await writeFiles(exec, mcpFiles(root, registry, plan, current));
    touched.push(root);
  }
  return touched;
}
const ago = (ms) => { if (!ms) return "never"; const m = Math.floor((Date.now() - ms) / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.floor(m / 60)} h ago` : `${Math.floor(m / 1440)} d ago`; };
// --- agents: the shelf file is name + description + instructions; the three agents' own files are written from it (agent.sh) ---
const AGENT_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const oneLine = (s) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
const trimBody = (b) => String(b ?? "").replace(/\r\n?/g, "\n").replace(/^(?:[ \t]*\n)+/, "").replace(/\s+$/, "");
// The frontmatter of a markdown file as { key: text } (a plain, quoted or block value; nested keys are ignored) and what follows it.
function parseFrontmatter(text) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") return { ok: false, fm: {}, body: String(text) };
  let end = -1;
  for (let i = 1; i < lines.length; i++) if (lines[i].trim() === "---") { end = i; break; }
  if (end < 0) return { ok: false, fm: {}, body: String(text) };
  const fm = {};
  for (let i = 1; i < end; i++) {
    const m = lines[i].match(/^([A-Za-z0-9_-]+):[ \t]*(.*)$/);
    if (!m) continue;
    const key = m[1]; let v = m[2].trim();
    if (/^[>|][-+]?$/.test(v)) {
      const parts = [];
      while (i + 1 < end && (/^[ \t]/.test(lines[i + 1]) || lines[i + 1].trim() === "")) parts.push(lines[++i].trim());
      v = v[0] === ">" ? parts.join(" ").replace(/\s+/g, " ").trim() : parts.join("\n").trim();
    } else if (v.startsWith('"')) {
      try { v = JSON.parse(v); } catch { v = v.replace(/^"|"$/g, ""); }
    } else if (v.startsWith("'")) {
      v = v.replace(/^'|'$/g, "").replace(/''/g, "'");
    } else if (v === "" && i + 1 < end && /^[ \t]+-[ \t]/.test(lines[i + 1])) {   // a YAML list: its items
      const items = [];
      while (i + 1 < end && /^[ \t]+-[ \t]/.test(lines[i + 1])) items.push(lines[++i].replace(/^[ \t]+-[ \t]+/, "").trim().replace(/^["']|["']$/g, ""));
      v = items.join(", ");
    } else if (v === "" && i + 1 < end && /^[ \t]+["']?[\w*.-]+["']?:/.test(lines[i + 1])) {   // a nested map: not a text value
      while (i + 1 < end && /^[ \t]/.test(lines[i + 1])) i++;
      fm.__nested = [...(fm.__nested ?? []), key]; fm[key] = "";
      continue;
    } else {
      while (i + 1 < end && /^[ \t]+\S/.test(lines[i + 1])) v += ` ${lines[++i].trim()}`;
    }
    fm[key] = v;
  }
  return { ok: true, fm, body: lines.slice(end + 1).join("\n") };
}
// The shelf file for an agent. The description goes on one line, in double quotes (a JSON string is a valid YAML one). `tools` (Claude's
// spelling: "Read, Grep") and `model` (sonnet, ...) are optional single lines; without `tools` the agent has every tool.
const agentText = (name, description, body, { tools = "", model = "" } = {}) =>
  `---\nname: ${name}\ndescription: ${JSON.stringify(oneLine(description))}\n${oneLine(tools) ? `tools: ${oneLine(tools)}\n` : ""}${oneLine(model) ? `model: ${oneLine(model)}\n` : ""}---\n${trimBody(body)}\n`;
const AGENT_LIMITS = { description: 6000, body: 60000, tools: 500, model: 100 };   // (Claude has no limit; Antigravity took 6000 characters in a check)
const TOOLS_OK = /^[A-Za-z0-9_.,:*() -]+$/, MODEL_OK = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/;
// Why an agent cannot be saved, in one line; "" when it can. `taken`: names already on the shelf.
function agentProblem({ name, description, body, tools = "", model = "" }, { taken = new Set(), editing = false } = {}) {
  if (!name) return "Give it a name";
  if (!AGENT_NAME.test(name)) return "The name takes lowercase letters, digits and single hyphens (like code-reviewer)";
  if (name.length > 64) return "The name is longer than 64 characters";
  if (!editing && taken.has(name)) return `“${name}” is already on the shelf`;
  if (!oneLine(description)) return "Say when to use it: a short description";
  if (oneLine(description).length > AGENT_LIMITS.description) return `The description is longer than ${AGENT_LIMITS.description} characters`;
  if (oneLine(tools) && (oneLine(tools).length > AGENT_LIMITS.tools || !TOOLS_OK.test(oneLine(tools)))) return "Tools: names separated by commas (like Read, Grep), up to 500 characters; leave it empty for every tool";
  if (oneLine(model) && (oneLine(model).length > AGENT_LIMITS.model || !MODEL_OK.test(oneLine(model)))) return "Model: one plain word or id (like sonnet), or empty";
  if (!trimBody(body)) return "Write its instructions";
  if (trimBody(body).length > AGENT_LIMITS.body) return `The instructions are longer than ${AGENT_LIMITS.body} characters`;
  return "";
}
// What each agent can carry of a `tools` list (the same tables as agent.sh, which writes the files and is what counts): the names it has an
// equivalent for, and the grants it cannot take (an MCP tool, a pattern such as Bash(git:*), a tool it does not have). Never widened: a grant
// with no equivalent is dropped.
const OPEN_TOOLS = { Read: "read", Glob: "glob", Grep: "grep", Edit: "edit", MultiEdit: "edit", Write: "write", Bash: "bash", WebFetch: "webfetch", WebSearch: "websearch", Task: "task", TodoWrite: "todowrite", TodoRead: "todoread", LS: "list" };
const AGY_TOOLS = { Read: ["read_file"], Glob: ["read_file"], Grep: ["read_file"], Edit: ["edit_file"], MultiEdit: ["edit_file"], Write: ["write_file"], Bash: ["run_command", "manage_task"], WebSearch: ["search_web"], WebFetch: ["search_web"] };
function mapTools(tools) {
  const items = String(tools ?? "").split(",").map((t) => t.trim().replace(/^\[|\]$/g, "").trim()).filter(Boolean);
  const uniq = (xs) => [...new Set(xs)];
  return {
    opencode: uniq(items.filter((t) => OPEN_TOOLS[t]).map((t) => OPEN_TOOLS[t])), antigravity: uniq(items.flatMap((t) => AGY_TOOLS[t] ?? [])),
    droppedOpencode: items.filter((t) => !OPEN_TOOLS[t]), droppedAntigravity: items.filter((t) => !AGY_TOOLS[t]),
  };
}
// What an agent file of a project gives to the shelf: name (its `name`, else its file name), description, instructions, and its tool limits
// and model when it has them. { error } when it cannot be taken without changing what it may do (tool limits written as a map, say).
function fromAgentFile(text, stem) {
  const p = parseFrontmatter(text);
  if (!p.ok) return { error: "no frontmatter" };
  if (p.fm.__nested?.includes("tools")) return { error: "its tool limits are written as a map (OpenCode's way), which Toolkit cannot carry without changing what the agent may do" };
  const name = oneLine(p.fm.name) || stem, description = oneLine(p.fm.description), body = trimBody(p.body), tools = oneLine(p.fm.tools), model = oneLine(p.fm.model);
  const problem = agentProblem({ name, description, body, tools, model });
  return problem ? { error: problem.replace(/^Give it a name$/, "no name").replace(/^Say when to use it.*$/, "no description").replace(/^Write its instructions$/, "no instructions") } : { name, description, body, tools, model };
}

// --- plugins and hooks: what the agents themselves have; Toolkit reads it and, for plugins, calls the agent's own command ---
const jsonFrom = (stdout) => {
  const text = String(stdout ?? "");
  try { return JSON.parse(text); } catch { /* a line before the JSON (a warning): look for where it starts */ }
  for (const m of text.matchAll(/^[[{]/gm)) {   // a warning that itself starts with [ is not it: try each start in turn
    try { return JSON.parse(text.slice(m.index)); } catch { /* not this one */ }
  }
  return undefined;
};
const safeId = (s) => /^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(String(s ?? ""));
const CLAUDE_SCOPES = { user: "user · every project", project: "this project", local: "this project · only you" };
// `list` = what `claude plugin list --json` printed; `root` = the project folder as the system spells it (pwd -P).
// User plugins apply everywhere; project and local ones belong to the folder in projectPath, so other projects' are left out.
function claudePlugins(list, root) {
  if (!Array.isArray(list)) return [];
  return list.filter((p) => p && typeof p.id === "string" && CLAUDE_SCOPES[p.scope] && (p.scope === "user" || p.projectPath === root))
    .map((p) => ({ agent: "claude", id: p.id, name: p.id.split("@")[0], from: p.id.includes("@") ? p.id.split("@").slice(1).join("@") : "", scope: p.scope, where: CLAUDE_SCOPES[p.scope], version: p.version ? String(p.version) : "", enabled: p.enabled !== false, toggle: true, remove: true }));
}
// `agy plugin list --json`: installed for the person, so every project; and the folders of this project's .agents/plugins
// (`dirs`: [{ dir, manifest | null }]; Toolkit's own workspace-mcp is the MCP tab's business).
function antigravityPlugins(list, dirs = []) {
  const out = [];
  if (Array.isArray(list)) for (const p of list) {
    if (!p || typeof p.name !== "string") continue;
    const parts = Object.entries(p).filter(([, v]) => Array.isArray(v) && v.length).map(([k, v]) => `${v.length} ${k}`);
    out.push({ agent: "antigravity", id: p.name, name: p.name, from: "", scope: "installed", where: "installed · every project", version: p.version ? String(p.version) : "", enabled: p.enabled !== false, toggle: true, remove: true, parts: parts.join(", ") });
  }
  for (const { dir, manifest } of dirs) {
    if (dir === "workspace-mcp") continue;
    out.push({ agent: "antigravity", id: dir, name: String(manifest?.displayName || manifest?.name || dir), from: "", scope: "workspace", where: "this project's .agents/plugins folder", version: manifest?.version ? String(manifest.version) : "", enabled: true, toggle: false, remove: false, parts: "" });
  }
  return out;
}
const pluginName = (e) => (Array.isArray(e) ? e[0] : e);
// OpenCode: the `plugin` list of its config (project and global) and the files in .opencode/plugins.
function openPlugins(project, global, files = []) {
  const entries = (cfg, scope, where, remove) => (Array.isArray(cfg?.plugin) ? cfg.plugin : []).map(pluginName).filter((n) => typeof n === "string").map((n) => ({ agent: "opencode", id: n, name: n, from: "", scope, where, version: "", enabled: true, toggle: false, remove, parts: "" }));
  return [
    ...entries(project, "project", "this project's opencode.json", true),
    ...entries(global, "global", "your global OpenCode config", false),
    ...files.map((f) => ({ agent: "opencode", id: f, name: f, from: "", scope: "file", where: "a file in this project's .opencode/plugins", version: "", enabled: true, toggle: false, remove: false, parts: "" })),
  ];
}
// opencode.json without one plugin entry; null when nothing but $schema is left (the file is then removed, as for MCP).
function withoutPlugin(oc, name) {
  const next = { ...oc }, list = (Array.isArray(oc.plugin) ? oc.plugin : []).filter((e) => pluginName(e) !== name);
  if (list.length) next.plugin = list; else delete next.plugin;
  return Object.keys(next).some((k) => k !== "$schema") ? next : null;
}
const pluginKey = (p) => `${p.agent}|${p.scope}|${p.id}`;
// The command that does `op` ("enable" | "disable" | "uninstall") to a plugin; run in the project folder. null when it cannot be done to it.
// An uninstall keeps Claude's saved data for the plugin (the safer choice).
function pluginCommand(p, op) {
  if (!safeId(p.id)) return null;
  if (p.agent === "claude" && p.toggle) return ["claude", "plugin", op, p.id, "--scope", p.scope, "--json", ...(op === "uninstall" ? ["--keep-data"] : [])];
  if (p.agent === "antigravity" && p.toggle) return ["agy", "plugin", op, p.id];
  return null;
}
// Did the agent's command do it? Claude prints one JSON line with an outcome; agy prints "Error: ..." when it did not.
function pluginResult(agent, r) {
  const text = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim();
  if (agent === "claude") {
    const j = jsonFrom(r.stdout);
    if (j && typeof j === "object" && !Array.isArray(j)) return j.outcome === "ok" ? "" : String(j.message || j.error || "it did not say why");
  }
  if (agent === "opencode" && r.code !== 0) {   // its lines are drawn as "■  Could not install …", "■  404 Not Found …"
    const bad = text.split("\n").filter((l) => l.trim().startsWith("■")).map((l) => l.replace(/^\s*■\s*/, "").trim());
    return bad.slice(-1)[0] || `exit ${r.code}`;
  }
  if (r.code !== 0) return (text.split("\n").filter(Boolean).pop() || `exit ${r.code}`).replace(/^error:?\s*/i, "");
  const bad = text.split("\n").find((l) => /^error\b/i.test(l.trim()));
  return bad ? bad.trim().replace(/^error:?\s*/i, "") : "";
}
// Hooks, one row per handler. Claude: settings files, { hooks: { Event: [{ matcher, hooks: [{ type, command }] }] } }.
// Antigravity: hooks.json, { <hook name>: { enabled?, Event: [{ matcher, hooks: [...] } | a handler] } }.
const handlerText = (h) => oneLine(h?.command ?? h?.prompt ?? h?.url ?? h?.type ?? "");
function claudeHooks(settings, scope, file) {
  const out = [], hooks = settings?.hooks;
  if (!hooks || typeof hooks !== "object") return out;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) for (const h of Array.isArray(g?.hooks) ? g.hooks : []) out.push({ agent: "claude", scope, file, event, matcher: typeof g.matcher === "string" ? g.matcher : "", name: "", enabled: true, type: String(h?.type ?? "command"), text: handlerText(h) });
  }
  return out;
}
function antigravityHooks(data, scope, file) {
  const out = [];
  if (!data || typeof data !== "object" || Array.isArray(data)) return out;
  for (const [name, spec] of Object.entries(data)) {
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) continue;
    for (const [event, items] of Object.entries(spec)) {
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        const handlers = Array.isArray(item?.hooks) ? item.hooks : [item], matcher = typeof item?.matcher === "string" ? item.matcher : "";
        for (const h of handlers) out.push({ agent: "antigravity", scope, file, event, matcher, name, enabled: spec.enabled !== false, type: String(h?.type ?? "command"), text: handlerText(h) });
      }
    }
  }
  return out;
}
// --- Find: agents and hooks from the aitmpl.com catalog (the claude-code-templates repo), plugins from Claude's marketplaces and from npm ---
const CATALOG_URL = "https://www.aitmpl.com/components.json";
const CATALOG_REPO = "davila7/claude-code-templates", SHA_OK = /^[0-9a-f]{40}$/;
const safePath = (p) => typeof p === "string" && /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(p) && !p.split("/").some((x) => x === "" || x === "." || x === "..");
// Where the file of a catalog entry is at ONE commit of the repository (agents are .md, hooks are .json), so what is shown and what is added are
// the same bytes; null for a path that could point anywhere else or a commit that is not a full sha.
const catalogUrl = (kind, path, sha) => SHA_OK.test(String(sha ?? "")) && ((kind === "agents" && safePath(path) && path.endsWith(".md")) || (kind === "hooks" && safePath(path) && path.endsWith(".json"))) ? `https://raw.githubusercontent.com/${CATALOG_REPO}/${sha}/cli-tool/components/${kind}/${path}` : null;
// The entries of `kind` ("agents" | "hooks") that match every word of `q` in their name, category or description: name matches first, then the most downloaded.
function catalogHits(catalog, kind, q, limit = 15) {
  const words = String(q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const list = Array.isArray(catalog?.[kind]) ? catalog[kind] : [];
  const score = (e) => words.filter((w) => String(e.name ?? "").toLowerCase().includes(w)).length;
  return list.filter((e) => e && typeof e.name === "string" && typeof e.path === "string")
    .filter((e) => { const text = `${e.name} ${e.category ?? ""} ${e.description ?? ""}`.toLowerCase(); return words.every((w) => text.includes(w)); })
    .sort((a, b) => score(b) - score(a) || (Number(b.downloads) || 0) - (Number(a.downloads) || 0) || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((e) => ({ name: e.name, path: e.path, category: String(e.category ?? ""), description: oneLine(e.description), downloads: Number(e.downloads) || 0, risk: String(e.skillspector?.recommendation ?? ""),
      findings: (Array.isArray(e.skillspector?.findings) ? e.skillspector.findings : []).map((f) => oneLine(`${f?.severity ?? ""} · ${f?.title ?? ""}`)).filter((x) => x !== "·").slice(0, 5) }));
}
// The hooks a catalog file would add: [{ event, group: { matcher?, hooks: [{ type: "command", command, timeout? }] } }], or { error }.
// Only command hooks are taken, and only those keys: a hook that runs is shown to the person in full before it is written.
function parseHookFile(text) {
  let j;
  try { j = JSON.parse(text); } catch { return { error: "it is not JSON" }; }
  const hooks = j?.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return { error: "it has no hooks" };
  const out = [];
  for (const [event, groups] of Object.entries(hooks)) {
    if (!/^[A-Za-z]+$/.test(event) || !Array.isArray(groups)) return { error: `“${event}” is not a list of hooks` };
    for (const g of groups) {
      if (!g || !Array.isArray(g.hooks) || !g.hooks.length) return { error: `a group under ${event} has no hooks` };
      const handlers = [];
      for (const h of g.hooks) {
        if (!h || (h.type !== undefined && h.type !== "command")) return { error: `it uses a hook type other than a command (${h?.type}), which Toolkit does not add` };
        if (typeof h.command !== "string" || !h.command.trim() || h.command.length > 4000) return { error: "a hook has no command (or one over 4000 characters)" };
        handlers.push({ type: "command", command: h.command, ...(typeof h.timeout === "number" ? { timeout: h.timeout } : {}) });
      }
      out.push({ event, group: { ...(typeof g.matcher === "string" && g.matcher ? { matcher: g.matcher } : {}), hooks: handlers } });
    }
  }
  return out.length ? { hooks: out } : { error: "it has no hooks" };
}
// A settings object with the hook groups added (one that is already there, word for word, is not added twice). -> { next, added }
function withHooks(settings, additions) {
  const next = { ...settings }, hooks = { ...(settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks) ? settings.hooks : {}) };
  let added = 0;
  for (const { event, group } of additions) {
    const list = Array.isArray(hooks[event]) ? [...hooks[event]] : [];
    if (list.some((g) => stable(g) === stable(group))) continue;
    list.push(group); hooks[event] = list; added++;
  }
  next.hooks = hooks;
  return { next, added };
}
// A settings object without the handler(s) that run `text` for `event` under `matcher` ("" = none); empty groups, events and the hooks key go with them.
// -> { next, removed } (removed 0 when it is not there any more)
function withoutHook(settings, { event, matcher, text }) {
  const hooks = settings?.hooks;
  if (!hooks || !Array.isArray(hooks[event])) return { next: settings, removed: 0 };
  let removed = 0;
  const groups = [];
  for (const g of hooks[event]) {
    if ((typeof g?.matcher === "string" ? g.matcher : "") !== (matcher ?? "") || !Array.isArray(g?.hooks)) { groups.push(g); continue; }
    const keep = g.hooks.filter((h) => handlerText(h) !== text || (removed++, false));
    if (keep.length) groups.push({ ...g, hooks: keep });
  }
  const next = { ...settings }, rest = { ...hooks };
  if (groups.length) rest[event] = groups; else delete rest[event];
  if (Object.keys(rest).length) next.hooks = rest; else delete next.hooks;
  return { next, removed };
}
// Plugins to find. Claude: `claude plugin list --available --json` (every marketplace the person added); OpenCode: npm packages tagged opencode-plugin.
function claudeAvailable(json, q, limit = 15) {
  const words = String(q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const list = Array.isArray(json?.available) ? json.available : [];
  const score = (e) => words.filter((w) => String(e.name ?? "").toLowerCase().includes(w)).length;
  return list.filter((e) => e && typeof e.pluginId === "string" && typeof e.name === "string")
    .filter((e) => { const text = `${e.name} ${e.description ?? ""} ${e.marketplaceName ?? ""}`.toLowerCase(); return words.every((w) => text.includes(w)); })
    .sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((e) => ({ agent: "claude", id: e.pluginId, name: e.name, from: String(e.marketplaceName ?? ""), version: e.version ? String(e.version) : "", description: oneLine(e.description), weekly: 0 }));
}
const NPM_NAME = /^(@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;
function npmPlugins(json, limit = 15) {
  return (Array.isArray(json?.objects) ? json.objects : []).filter((o) => o?.package && typeof o.package.name === "string" && NPM_NAME.test(o.package.name))
    .slice(0, limit)
    .map((o) => ({ agent: "opencode", id: o.package.name, name: o.package.name, from: "npm", version: o.package.version ? String(o.package.version) : "", description: oneLine(o.package.description), weekly: Number(o.downloads?.weekly) || 0 }));
}
// The command that installs a found plugin for the project (run in the project folder). null for anything that is not a plain id.
function installCommand(p) {
  if (p.agent === "claude" && safeId(p.id)) return ["claude", "plugin", "install", p.id, "--scope", "project", "--json"];
  if (p.agent === "opencode" && NPM_NAME.test(p.id) && !p.id.startsWith("-")) return ["opencode", "plugin", p.id];
  return null;
}
// The line under an agent on the shelf: the tool limit it carries, and what an agent cannot keep of it (the notes of list-agents.sh).
function carryNote({ tools, notes }) {
  const label = { opencode: "OpenCode", antigravity: "Antigravity" };
  const lost = String(notes ?? "").split(" | ").filter(Boolean).map((part) => {
    const at = part.indexOf(":"), k = part.slice(0, at), v = part.slice(at + 1).trim();
    return k === "model" ? `model (${v}) only for Claude` : `${label[k] ?? k} cannot carry ${v}`;
  });
  return [tools ? `tools: ${tools}` : "", ...lost].filter(Boolean).join(" · ");
}
// --- end of the part that does not need Herdr ---

const SHELF = () => `${appHome()}/toolkit`;
const MODS = () => `${appHome()}/mods/toolkit`;
const clean = (s) => (s ?? "").trim().replace(/^["']|["']$/g, "");
const plain = (e) => String(e?.message ?? e).replace(/^Error: /, "");
const readJson = (path) => readJsonWith(fs, path);
const getJson = async (url) => {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 120)}`);
  return JSON.parse(text);
};
// The registry's newest entry for a server (by its full name), or null.
const latestServer = async (source) => {
  const d = await getJson(`https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(source.split("/").pop())}&limit=30&version=latest`);
  return (d.servers ?? []).map((x) => x.server).find((x) => x?.name === source) ?? null;
};
const kfmt = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n ?? 0);
const names = (roots) => {
  const list = roots.map((r) => r.split("/").pop());
  return list.length > 3 ? `${list.slice(0, 3).join(", ")} and ${list.length - 3} more` : list.join(", ");
};
const PREFIX = { skill: "s", agent: "a", mcp: "m" }, WHAT = { skill: "skill", agent: "agent", mcp: "MCP server" };
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const emptySets = () => Object.fromEntries(KEYS.map((a) => [a, new Set()]));
const loadAgents = () => {
  try { const v = JSON.parse(localStorage.getItem("agents")); const keep = KEYS.filter((k) => Array.isArray(v) && v.includes(k)); return new Set(keep.length ? keep : KEYS); }
  catch { return new Set(KEYS); }
};

export default class Toolkit extends View {
  init(_props, cx) {
    this.tab = (() => { try { const t = localStorage.getItem("tab"); return TABS.some((x) => x.key === t) ? t : "skills"; } catch { return "skills"; } })();
    this.mode = null;                 // null (the lists) | "find" | "form" (a new or edited agent) | "import" (agents of this project)
    this.agentShelf = [];             // [{ name, description, problem }]: <shelf>/agents/<name>.md
    this.agentOn = emptySets(); this.agentOrphanOn = emptySets(); this.agentOrphans = [];   // like active / orphanOn, for agent files
    this.plugins = []; this.pluginsFor = null; this.pluginsLoading = false; this.pluginNotes = [];   // read on demand (they call the agents' CLIs)
    this.hooks = []; this.hookNotes = [];
    this.form = null; this.imports = null; this.review = null;   // review: a catalog agent shown in full before it is added
    this.catalogSha = null;           // the commit of the catalog's repository everything is fetched from (see loadCatalog)
    this.ignoreAsk = null;            // { root, paths }: links into the home folder that git does not ignore yet

    this.agents = loadAgents();       // the agents a change is for
    this.master = []; this.registry = {}; this.custom = new Map(); this.index = { projects: {} }; this.problems = [];
    this.active = emptySets();        // agent -> skills of the shelf that are on for it in this project
    this.orphanOn = emptySets(); this.orphans = [];   // links into the shelf whose skill is gone
    this.mcpOn = emptySets();         // agent -> servers of the shelf that are on for it in this project
    this.sources = { skills: {}, mcps: {}, agents: {}, checkedAt: 0 };   // where shelf items came from (sources.json)
    this.checking = false; this.checkError = null; this.autoChecked = false;
    this.staged = new Map();          // "s:name" | "m:name" -> true (turn on) | false (turn off), for the agents picked
    this.confirm = null;              // { kind: "skill" | "mcp", name }: a delete waiting for its button
    this.applying = false; this.adding = new Set();
    this.found = { state: "idle", skills: [], mcps: [], agents: [], hooks: [], plugins: [], errors: [], error: null, query: "" };
    this.findKind = "all";            // what Find searches: all | skills | agents | mcp | plugins | hooks
    this.catalog = null; this.catalogAt = 0;   // the aitmpl.com catalog of agents and hooks, kept for an hour
    this.query = "";
    this.filter = InputState.new({ placeholder: "Filter" });
    this.filter.on("change", (_e, cx) => { this.query = this.filter.value().trim().toLowerCase(); cx.notify(); });
    this.filter.on("focus", (_e, cx) => { this.typing = "filter"; cx.notify(); });
    this.filter.on("blur", (_e, cx) => { this.typing = null; cx.notify(); });
    this.finder = InputState.new({ placeholder: "Search online" });
    this.finder.on("submit", (_e, cx) => this.search(cx));
    this.finder.on("focus", (_e, cx) => { this.typing = "find"; cx.notify(); });
    this.finder.on("blur", (_e, cx) => { this.typing = null; cx.notify(); });
    configureSafety(`${SHELF()}/backups`, MODS());   // what Toolkit changes in a project is copied there first
    if (checking()) return;           // `herdr-app check` loads the mod for real: start no timer, run no program, write nothing
    this.refresh(cx, true);
    cx.timer.every(15000, (cx) => this.refresh(cx));
    this.watchShelf(cx);
    this.seed(cx);
  }

  // Herdr's own manuals for agents (`hc --skill`, `herdr-app --skill`) go on the shelf as two skills the first time, and are
  // kept current when Herdr updates them. Only on the shelf: a project gets them when the person turns them on and presses Apply.
  seed(cx) {
    cx.spawn(async (cx) => {
      try { await exec("sh", [`${MODS()}/seed-herdr.sh`, SHELF()]); } catch { /* no hc here: the shelf stays as it is */ }
      this.refresh(cx, true); cx.notify();
    });
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

  selected() { return KEYS.filter((k) => this.agents.has(k)); }
  // On for every picked agent / for at least one of them.
  full(sets, name) { return this.selected().every((a) => sets[a].has(name)); }
  some(sets, name) { return this.selected().some((a) => sets[a].has(name)); }

  // Reads what is on for the project; the shelf itself only when asked (it changes rarely).
  refresh(cx, full = false) {
    if (this.loading || this.applying) { this.again = true; if (full) this.reloadShelf = true; return; }
    if (this.reloadShelf) { full = true; this.reloadShelf = false; }
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.root = null; this.error = null; full = true; this.note = null; this.notice = null; this.staged.clear(); this.confirm = null;
      this.pluginsFor = null; this.plugins = []; this.hooks = []; this.imports = null; this.ignoreAsk = null; if (this.mode === "import" || this.mode === "review") this.mode = null;   // (an agent form stays: the shelf is not the project's)
    }
    if (on) { this.error = "Toolkit works on local folders only"; return; }
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
          this.master = r.stdout.split("\n").filter(Boolean).map((l) => { const [name, description, problem, fp] = l.split("\t"); return { name, description: clean(description), problem: (problem ?? "").trim(), fp: (fp ?? "").trim() }; });
          const src = (await readJson(`${base}/sources.json`)) ?? {};
          this.sources = { skills: src.skills ?? {}, mcps: src.mcps ?? {}, agents: src.agents ?? {}, checkedAt: src.checkedAt ?? 0 };
          this.registry = (await readJson(`${base}/mcp.json`))?.mcps ?? {};
          this.index = (await readJson(`${base}/projects.json`)) ?? { projects: {} };
          await fs.mkdir(`${base}/agents`, { recursive: true }).catch(() => {});
          const ra = await exec("sh", [`${MODS()}/list-agents.sh`, `${base}/agents`]);
          this.agentShelf = await Promise.all(ra.stdout.split("\n").filter(Boolean).map(async (l) => {
            const [name, problem, notes] = l.split("\t");
            let description = "", tools = "", model = "";
            try { const fm = parseFrontmatter(await fs.readFile(`${base}/agents/${name}.md`, "utf8")).fm; description = oneLine(fm.description); tools = oneLine(fm.tools); model = oneLine(fm.model); } catch { /* unreadable: the problem column says so */ }
            return { name, description, tools, model, notes: (notes ?? "").trim(), problem: (problem ?? "").trim() };
          }));
        }
        const unsafe = root === home() || root === "/";
        const onShelf = new Set(this.master.map((m) => m.name));
        const listLinks = async () => (await exec("sh", [`${MODS()}/list-active.sh`, root, `${base}/skills`])).stdout.split("\n").filter(Boolean).map((l) => l.split("\t"));   // [agent, name, ok|stale|broken]
        let links = unsafe ? [] : await listLinks();
        // Antigravity's copy of a skill differs from the shelf (the shelf was updated, or an older Toolkit left a symlink it cannot read): copy it again
        const stale = [...new Set(links.filter(([a, n, st]) => a === "antigravity" && st === "stale" && onShelf.has(n)).map(([, n]) => n))];
        for (const n of stale) await exec("sh", [`${MODS()}/skill.sh`, "enable", root, `${base}/skills`, n, "antigravity"]);
        if (stale.length) links = await listLinks();
        // The same for agent files: they are written from the shelf, so one whose shelf file changed is written again
        const onAgents = new Set(this.agentShelf.map((m) => m.name));
        const listAgentFiles = async () => (await exec("sh", [`${MODS()}/list-active-agents.sh`, root, `${base}/agents`])).stdout.split("\n").filter(Boolean).map((l) => l.split("\t"));   // [agent, name, ok|stale|broken]
        let afiles = unsafe ? [] : await listAgentFiles();
        const staleAgents = [...new Set(afiles.filter(([, n, st]) => st === "stale" && onAgents.has(n)).map(([, n]) => n))];
        for (const n of staleAgents) await exec("sh", [`${MODS()}/agent.sh`, "resync", root, `${base}/agents`, n]);
        if (staleAgents.length) afiles = await listAgentFiles();
        const problems = [], servers = emptySets(), own = new Map();
        for (const a of KEYS) {
          if (unsafe) break;
          try {
            for (const k of serversOf(a, await readJson(projectFiles(root)[a]))) {
              if (this.registry[k]) servers[a].add(k); else own.set(k, new Set([...(own.get(k) ?? []), a]));
            }
          } catch (e) { problems.push(String(e).replace(/^Error: /, "")); }
        }
        if (key() !== context) return;
        const active = emptySets(), orphanOn = emptySets(), orphans = new Set();
        for (const [a, n, state] of links) {
          if (!active[a]) continue;
          if (state !== "broken" && onShelf.has(n)) active[a].add(n); else { orphanOn[a].add(n); orphans.add(n); }
        }
        const agentOn = emptySets(), agentOrphanOn = emptySets(), agentOrphans = new Set();
        for (const [a, n, state] of afiles) {
          if (!agentOn[a]) continue;
          if (state !== "broken" && onAgents.has(n)) agentOn[a].add(n); else { agentOrphanOn[a].add(n); agentOrphans.add(n); }
        }
        const hooked = unsafe ? { hooks: [], notes: [] } : await this.readHooks(root);
        if (key() !== context) return;
        this.root = root; this.unsafe = unsafe;
        this.agentOn = agentOn; this.agentOrphanOn = agentOrphanOn; this.agentOrphans = [...agentOrphans].sort();
        this.hooks = hooked.hooks; this.hookNotes = hooked.notes;
        this.active = active; this.orphanOn = orphanOn; this.orphans = [...orphans].sort();
        this.mcpOn = servers; this.custom = own; this.problems = problems;
        this.error = null;
        // Looks for newer versions by itself at most once a day (and never while the person is changing something)
        if (!this.autoChecked && !this.applying && Date.now() - this.sources.checkedAt > 24 * 3600 * 1000 && this.tracked().length) { this.autoChecked = true; this.checkUpdates(cx); }
        if (!unsafe) {
          const any = (sets) => [...new Set(KEYS.flatMap((a) => [...sets[a]]))];
          const next = withProject(this.index, root, any(active), any(servers), any(agentOn));
          if (next) { this.index = next; await fs.writeFile(`${base}/projects.json`, json(next)).catch(() => {}); }
        }
      } catch (e) { if (key() === context) this.error = String(e); }
      finally {
        this.loading = false;
        if (this.again) { this.again = false; this.refresh(cx, false); }
        else if (full && this.tab === "plugins" && !this.mode) this.loadPlugins(cx, true);   // plugins call the agents' own commands: only when looked at or asked for
        cx.notify();
      }
    });
  }

  // The hooks the agents have in this project (and Claude's in the user settings), from their settings files. Read only.
  async readHooks(root) {
    const hooks = [], notes = [];
    const files = [
      ["claude", "project", `${root}/.claude/settings.json`], ["claude", "local", `${root}/.claude/settings.local.json`], ["claude", "user", `${home()}/.claude/settings.json`],
      ["antigravity", "project", `${root}/.agents/hooks.json`],
    ];
    try {   // hooks.json of this project's own Antigravity plugins
      const r = await exec("sh", ["-c", 'for f in "$1"/.agents/plugins/*/hooks.json; do [ -f "$f" ] && printf "%s\\n" "$f"; done; true', "toolkit", root]);
      for (const f of r.stdout.split("\n").filter(Boolean)) files.push(["antigravity", `plugin ${f.split("/").slice(-2, -1)[0]}`, f]);
    } catch { /* no listing: the project file is still read */ }
    for (const [agent, scope, file] of files) {
      try {
        const data = await readJson(file);
        if (data) hooks.push(...(agent === "claude" ? claudeHooks(data, scope, file) : antigravityHooks(data, scope, file)));
      } catch (e) { notes.push(plain(e)); }
    }
    return { hooks, notes };
  }

  // Runs a command (an agent's own CLI) in the project folder. `missing`: the program is not installed.
  async runIn(root, cmd, timeout = 90000) {
    const r = await exec("sh", ["-c", 'cd "$1" || exit 126; shift; command -v "$1" >/dev/null 2>&1 || exit 127; exec "$@"', "toolkit", root, ...cmd], { timeout });
    return { ...r, missing: r.code === 127 };
  }

  // Plugins of the three agents for this project: Claude and Antigravity from their own `plugin list --json`, OpenCode from its config.
  loadPlugins(cx, force = false) {
    if (!this.root || this.unsafe) return;
    if (this.pluginsLoading) { if (force) this.pluginsAgain = true; return; }   // a read in flight may predate the change: read once more after it
    const context = this.context, root = this.root;
    if (!force && this.pluginsFor === context) return;
    this.pluginsLoading = true; cx.notify();
    cx.spawn(async (cx) => {
      const rows = [], notes = [];
      try {
        const phys = (await exec("sh", ["-c", 'cd "$1" && pwd -P', "toolkit", root])).stdout.trim() || root;
        const [c, g, w] = await Promise.all([
          this.runIn(root, ["claude", "plugin", "list", "--json"]),
          this.runIn(root, ["agy", "plugin", "list", "--json"]),
          exec("sh", ["-c", 'for d in "$1"/.agents/plugins/*/; do [ -d "$d" ] || continue; n=${d%/}; n=${n##*/}; if [ -f "$d/plugin.json" ]; then printf "%s\\t%s\\n" "$n" "$d/plugin.json"; else printf "%s\\t\\n" "$n"; fi; done; for f in "$1"/.opencode/plugins/*; do [ -f "$f" ] && printf "file\\t%s\\n" "${f##*/}"; done; true', "toolkit", root]),
        ]);
        if (c.missing) notes.push("Claude is not installed here, so its plugins cannot be listed");
        else { const j = jsonFrom(c.stdout); if (c.code !== 0 || !Array.isArray(j)) notes.push(`Claude's plugin list could not be read${c.stderr.trim() ? `: ${c.stderr.trim().split("\n").pop()}` : ""}`); else rows.push(...claudePlugins(j, phys)); }
        const dirs = [], files = [];
        for (const l of w.stdout.split("\n").filter(Boolean)) {
          const [a, b] = l.split("\t");
          if (a === "file") { files.push(b); continue; }
          let manifest = null;
          if (b) { try { manifest = await readJson(b); } catch { /* an unreadable manifest: listed by folder name */ } }
          dirs.push({ dir: a, manifest });
        }
        let agyList = [];
        if (g.missing) notes.push("Antigravity is not installed here, so its installed plugins cannot be listed");
        else { const j = jsonFrom(g.stdout); if (g.code !== 0 || !Array.isArray(j)) notes.push(`Antigravity's plugin list could not be read${g.stderr.trim() ? `: ${g.stderr.trim().split("\n").pop()}` : ""}`); else agyList = j; }
        rows.push(...antigravityPlugins(agyList, dirs));
        let project = null, global = null;
        try { project = await readJson(projectFiles(root).opencode); } catch (e) { notes.push(plain(e)); }
        try { global = await readJson(`${home()}/.config/opencode/opencode.json`); } catch { notes.push("OpenCode's global config is not plain JSON, so its plugins there are not listed"); }
        rows.push(...openPlugins(project, global, files));
      } catch (e) { notes.push(plain(e)); }
      finally {
        this.pluginsLoading = false;
        if (this.context === context) { this.plugins = rows; this.pluginNotes = notes; this.pluginsFor = context; }
        if (this.pluginsAgain) { this.pluginsAgain = false; this.loadPlugins(cx, true); }
        cx.notify();
      }
    });
  }

  // A click only stages the change; Apply makes it. `blocked`: the item cannot be turned on (it breaks the agents' rules).
  stage(id, current, cx, blocked = false) {
    if (this.applying || this.confirm || !this.root || this.unsafe) return;
    const want = this.staged.has(id) ? !this.staged.get(id) : !current;
    if (blocked && want) return;
    if (want === current) this.staged.delete(id); else this.staged.set(id, want);
    this.note = null; this.notice = null; cx.notify();
  }

  // Which agents a change is for; it can only change while nothing is staged, so a staged change always has one meaning.
  pickAgent(agent, cx) {
    if (this.applying) return;
    if (this.staged.size || this.confirm) { this.note = "Apply or cancel the staged changes before choosing other agents"; cx.notify(); return; }
    const next = new Set(this.agents);
    if (next.has(agent)) { if (next.size === 1) return; next.delete(agent); } else next.add(agent);
    this.agents = next; this.note = null; this.notice = null;
    try { localStorage.setItem("agents", JSON.stringify(KEYS.filter((k) => next.has(k)))); } catch {}
    cx.notify();
  }

  apply(cx) {
    if (!this.staged.size || this.applying || this.confirm || !this.root || this.unsafe) return;
    const root = this.root, context = this.context, changes = [...this.staged], picked = this.selected();
    this.applying = true; this.note = null; this.notice = null;
    cx.spawn(async (cx) => {
      const failed = []; let notice = null, plugs = [];
      try {
        const skills = changes.filter(([i]) => i.startsWith("s:"));
        for (const [id, want] of skills) {
          const name = id.slice(2);
          const r = await exec("sh", [`${MODS()}/skill.sh`, want ? "enable" : "disable", root, `${SHELF()}/skills`, name, ...picked]);
          if (r.code === 0) this.staged.delete(id); else failed.push(`${name}: ${(r.stderr || r.stdout).trim()}`);
        }
        const agents = changes.filter(([i]) => i.startsWith("a:"));
        for (const [id, want] of agents) {
          const name = id.slice(2);
          const r = await exec("sh", [`${MODS()}/agent.sh`, want ? "enable" : "disable", root, `${SHELF()}/agents`, name, ...picked]);
          if (r.code === 0) this.staged.delete(id); else failed.push(`${name}: ${(r.stderr || r.stdout).trim()}`);
        }
        const servers = changes.filter(([i]) => i.startsWith("m:"));
        if (servers.length) {
          try {
            const current = await readProject(fs, root, picked), plan = {};
            for (const a of picked) {
              const chosen = new Set(serversOf(a, current[a]).filter((k) => this.registry[k]));
              for (const [id, want] of servers) want ? chosen.add(id.slice(2)) : chosen.delete(id.slice(2));
              plan[a] = chosen;
            }
            await writeFiles(exec, mcpFiles(root, this.registry, plan, current));
            for (const [id] of servers) this.staged.delete(id);
            const ask = picked.includes("antigravity") ? [...new Set(servers.filter(([, w]) => w).flatMap(([i]) => agyVars(this.registry[i.slice(2)] ?? {})))] : [];
            if (ask.length) notice = `Antigravity asks you for ${ask.join(", ")} on its workspace-mcp plugin page`;
          } catch (e) { failed.push(`MCP: ${String(e).replace(/^Error: /, "")}`); }
        }
        if (skills.length) {
          try { await this.settleDeny(root, skills.map(([i]) => i.slice(2))); }
          catch (e) { failed.push(`OpenCode skill access: ${String(e).replace(/^Error: /, "")}`); }
        }
        try { await this.offerIgnore(root, skills.filter(([id, want]) => want && !this.staged.has(id)).map(([id]) => id.slice(2)), picked); } catch { /* the offer is a courtesy: never a failure */ }
        plugs = changes.filter(([i]) => i.startsWith("p:"));
        for (const [id, want] of plugs) {
          const row = this.plugins.find((x) => `p:${pluginKey(x)}` === id), cmd = row ? pluginCommand(row, want ? "enable" : "disable") : null;
          if (!cmd) { failed.push(`${id.slice(2)}: it cannot be turned ${want ? "on" : "off"} from here`); continue; }
          const r = await this.runIn(root, cmd);
          const why = r.missing ? `${AGENTS.find((a) => a.key === row.agent).label} is not installed here` : pluginResult(row.agent, r);
          if (why) failed.push(`${row.name}: ${why}`); else this.staged.delete(id);
        }
        if (plugs.length) { this.pluginsFor = null; notice = notice ?? "Restart the agent for plugin changes to apply"; }
      } finally {
        this.applying = false;
        if (this.context === context) { if (failed.length) this.note = failed.join(" · "); else if (notice) this.notice = notice; }
        this.refresh(cx, false);
        if (plugs.length) this.loadPlugins(cx, true);   // what the agents' commands did is read back, not assumed
        cx.notify();
      }
    });
    cx.notify();
  }

  // OpenCode also reads .claude/skills and .agents/skills: a skill on for Claude or Antigravity but not for OpenCode is denied there,
  // and the deny goes again once OpenCode has it or nobody does. Works from what is really on disk after the change.
  async settleDeny(root, skills) {
    const r = await exec("sh", [`${MODS()}/list-active.sh`, root, `${SHELF()}/skills`]);
    const rows = r.stdout.split("\n").filter(Boolean).map((l) => l.split("\t"));
    const on = (n) => Object.fromEntries(KEYS.map((a) => [a, rows.some(([a2, n2, st]) => a2 === a && n2 === n && st !== "broken")]));
    const file = projectFiles(root).opencode, current = await readJson(file), have = current?.permission?.skill ?? {};
    const deny = {};
    for (const n of skills) { const want = denied(on(n)); if (want !== (have[n] === "deny")) deny[n] = want; }
    if (Object.keys(deny).length) await writeFiles(exec, mcpFiles(root, this.registry, {}, { opencode: current }, deny));
  }

  // --- delete: asks first, says what it will do, and does it only on the button ---
  askDelete(kind, name, cx) {
    if (this.applying) return;
    this.confirm = { kind, name }; this.note = null; this.notice = null; cx.notify();
  }

  doDelete(cx) {
    if (!this.confirm || this.applying) return;
    const { kind, name } = this.confirm, context = this.context;
    const roots = this.deleteRoots(kind, name);
    this.applying = true; this.note = null; this.notice = null;
    cx.spawn(async (cx) => {
      try {
        const args = { exec, fs, shelf: SHELF(), mods: MODS(), roots, name };
        const done = kind === "skill" ? await deleteSkill(args) : kind === "agent" ? await deleteAgent(args) : await deleteMcp(args);
        this.staged.delete(`${PREFIX[kind]}:${name}`);
        if (kind !== "agent") { delete this.sources[kind === "skill" ? "skills" : "mcps"][name]; await this.saveSources(); }
        this.confirm = null;
        this.notice = `Deleted ${WHAT[kind]} “${name}” from the shelf` + (done.length ? ` and turned it off in ${plural(done.length, "project")}` : "");
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

  // Every project the item is on in (the ones Toolkit has seen, and this one), whatever agents the picker shows.
  deleteRoots(kind, name) {
    const sets = kind === "skill" ? this.active : kind === "agent" ? this.agentOn : this.mcpOn, orphans = kind === "skill" ? this.orphanOn : kind === "agent" ? this.agentOrphanOn : null;
    const here = this.root && KEYS.some((a) => sets[a].has(name) || orphans?.[a].has(name));
    return [...new Set([...usersOf(this.index, kind, name), ...(here ? [this.root] : [])])];
  }

  setTab(tab, cx) {
    if (this.mode) return;
    this.tab = tab; this.filter.set_value(""); this.query = ""; this.confirm = null; this.note = null; this.notice = null;
    try { localStorage.setItem("tab", tab); } catch {}
    if (tab === "plugins") this.loadPlugins(cx);
    cx.notify();
  }

  // Find (online search) and the agent screens replace the lists while they are open.
  toggleFind(cx) {
    if (this.mode === "form" || this.mode === "review" || this.applying) return;
    this.mode = this.mode === "find" ? null : "find"; this.confirm = null; this.note = null; this.notice = null;
    if (this.mode === "find") { this.findKind = this.tab; if (this.found.state !== "idle") this.found = { ...this.found, state: "idle" }; if (this.tab === "plugins") this.loadPlugins(cx); }
    cx.notify();
  }

  // --- .gitignore: the links Toolkit makes for Claude and OpenCode point into the home folder, so they break on another computer ---
  noIgnore() { try { const v = JSON.parse(localStorage.getItem("no-ignore")); return Array.isArray(v) ? v : []; } catch { return []; } }

  async offerIgnore(root, names, picked) {
    if (this.noIgnore().includes(root)) return;
    const paths = names.filter((n) => AGENT_NAME.test(n)).flatMap((n) => [picked.includes("claude") ? `.claude/skills/${n}` : null, picked.includes("opencode") ? `.opencode/skills/${n}` : null]).filter(Boolean);
    if (!paths.length) return;
    const r = await exec("sh", [`${MODS()}/gitignore.sh`, "missing", root, ...paths]);
    if (r.code !== 0) return;
    const missing = [];
    for (const p of r.stdout.split("\n").filter(Boolean)) if (await fs.exists(`${root}/${p}`)) missing.push(p);
    if (!missing.length) return;
    this.ignoreAsk = { root, paths: [...new Set([...(this.ignoreAsk?.root === root ? this.ignoreAsk.paths : []), ...missing])] };
  }

  ignoreBar(t) {
    const { root, paths } = this.ignoreAsk, shown = paths.slice(0, 6);
    return v_flex().flex_none().px(10).py(9).gap(7).border_t(1).border_color(t.border).bg(t.raised)
      .child(div().text_size(12).font_semibold().child("Keep these links out of git?"))
      .child(div().text_size(11).text_color(t.dim).child("They point into your home folder (Toolkit's shelf), so on another computer or in CI they are broken links. Only these paths are added to .gitignore; nothing else in it is touched:"))
      .child(v_flex().id("toolkit-ignore-paths").max_h(110).overflow_y_scrollbar().children([...shown, ...(paths.length > 6 ? [`and ${paths.length - 6} more`] : [])].map((x) => div().text_size(11).child(x))))
      .child(h_flex().gap(8).justify_end().flex_wrap()
        .child(this.button("toolkit-ignore-later", "Not now", "plain", true, (cx) => { this.ignoreAsk = null; cx.notify(); }, t))
        .child(this.button("toolkit-ignore-never", "Never for this project", "plain", true, (cx) => { try { localStorage.setItem("no-ignore", JSON.stringify([...new Set([...this.noIgnore(), root])])); } catch {} this.ignoreAsk = null; cx.notify(); }, t))
        .child(this.button("toolkit-ignore-go", "Add to .gitignore", "primary", !this.applying, (cx) => this.doIgnore(cx), t)));
  }

  doIgnore(cx) {
    if (!this.ignoreAsk || this.applying) return;
    const { root, paths } = this.ignoreAsk;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", [`${MODS()}/gitignore.sh`, "add", root, ...paths]);
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `exit ${r.code}`);
        this.notice = `Added ${plural(paths.length, "path")} to ${root.split("/").pop()}/.gitignore`;
        this.ignoreAsk = null;
      } catch (e) { this.note = `Could not write .gitignore: ${plain(e)}`; this.ignoreAsk = null; }
      cx.notify();
    });
  }

  // --- plugins: uninstalling asks first ---
  askUninstall(row, cx) {
    if (this.applying || this.staged.size) { if (this.staged.size) { this.note = "Apply or cancel the staged changes first"; cx.notify(); } return; }
    this.confirm = { kind: "uninstall", row }; this.note = null; this.notice = null; cx.notify();
  }

  doUninstall(cx) {
    if (this.confirm?.kind !== "uninstall" || this.applying) return;
    const { row } = this.confirm, root = this.root, context = this.context;
    this.applying = true; this.note = null; this.notice = null; cx.notify();
    cx.spawn(async (cx) => {
      let why = "";
      try {
        if (row.agent === "opencode") {
          const file = projectFiles(root).opencode, current = await readJson(file);
          if (!current) throw new Error("its config is gone");
          const next = withoutPlugin(current, row.id);
          await writeFiles(exec, { [file]: next === null ? null : json(next) });
        } else {
          const cmd = pluginCommand(row, "uninstall");
          if (!cmd) throw new Error("it cannot be uninstalled from here");
          const r = await this.runIn(root, cmd);
          why = r.missing ? `${AGENTS.find((a) => a.key === row.agent).label} is not installed here` : pluginResult(row.agent, r);
        }
      } catch (e) { why = plain(e); }
      finally {
        this.confirm = null; this.applying = false; this.pluginsFor = null;
        if (this.context === context) { if (why) this.note = `Could not uninstall “${row.name}”: ${why}`; else this.notice = row.agent === "opencode" ? `Removed “${row.name}” from opencode.json` : `Uninstalled “${row.name}”. Restart ${AGENTS.find((a) => a.key === row.agent).label} to apply`; }
        this.refresh(cx, true); this.loadPlugins(cx, true); cx.notify();
      }
    });
  }

  // --- agents: a form for a new or edited one, and Import from this project ---
  agentForm(kind, name, description, body, tools = "", model = "") {
    const make = (state, where) => {
      state.on("change", (_e, cx) => cx.notify());
      state.on("focus", (_e, cx) => { this.typing = where; cx.notify(); });
      state.on("blur", (_e, cx) => { if (this.typing === where) this.typing = null; cx.notify(); });
      return state;
    };
    const nameIn = make(InputState.new({ placeholder: "code-reviewer", value: name }), "form-name");
    const descIn = make(InputState.new({ placeholder: "When should an agent use this one?", value: description }), "form-desc");
    const toolsIn = make(InputState.new({ placeholder: "every tool", value: tools }), "form-tools");
    const modelIn = make(InputState.new({ placeholder: "the default", value: model }), "form-model");
    const bodyEd = make(EditorState.new({ language: "markdown", soft_wrap: true, line_numbers: false, folding: false, value: body, font_family: settings().font_family, font_size: 12 }), "form-body");
    const f = { kind, name, nameIn, descIn, toolsIn, modelIn, bodyEd, busy: false, error: null, askDiscard: false, initial: "" };
    f.initial = JSON.stringify(this.formValues(f));
    return f;
  }

  formValues(f = this.form) {
    return { name: f.kind === "edit" ? f.name : f.nameIn.value().trim(), description: f.descIn.value(), tools: f.toolsIn.value(), model: f.modelIn.value(), body: f.bodyEd.value() };
  }

  formDirty() { return Boolean(this.form) && JSON.stringify(this.formValues()) !== this.form.initial; }

  formProblem() {
    return this.form ? agentProblem(this.formValues(), { taken: new Set(this.agentShelf.map((a) => a.name)), editing: this.form.kind === "edit" }) : "";
  }

  newAgent(cx) {
    if (this.applying || this.confirm || this.mode) return;
    this.form = this.agentForm("new", "", "", ""); this.mode = "form"; this.note = null; this.notice = null; cx.notify();
  }

  editAgent(name, cx) {
    if (this.applying || this.confirm || this.mode) return;
    cx.spawn(async (cx) => {
      try {
        const p = parseFrontmatter(await fs.readFile(`${SHELF()}/agents/${name}.md`, "utf8"));
        this.form = this.agentForm("edit", name, oneLine(p.fm.description), trimBody(p.body), oneLine(p.fm.tools), oneLine(p.fm.model)); this.mode = "form"; this.note = null; this.notice = null;
      } catch (e) { this.note = `Could not open “${name}”: ${plain(e)}`; }
      cx.notify();
    });
  }

  // What was typed is not thrown away by one click: Cancel with changes asks first.
  cancelForm(cx) {
    const f = this.form;
    if (!f || f.busy) return;
    if (this.formDirty() && !f.askDiscard) { f.askDiscard = true; cx.notify(); return; }
    this.form = null; this.mode = null; cx.notify();
  }

  keepEditing(cx) { if (this.form) { this.form.askDiscard = false; cx.notify(); } }

  saveForm(cx) {
    const f = this.form;
    if (!f || f.busy) return;
    const v = this.formValues(), problem = this.formProblem();
    if (problem) { f.error = problem; cx.notify(); return; }
    f.busy = true; f.error = null; f.askDiscard = false; cx.notify();
    cx.spawn(async (cx) => {
      let saved = false;
      try {
        const file = `${SHELF()}/agents/${v.name}.md`;
        await fs.mkdir(`${SHELF()}/agents`, { recursive: true });
        if (f.kind === "new" && (await fs.exists(file))) throw new Error(`“${v.name}” is already on the shelf`);
        await fs.writeFile(file, agentText(v.name, v.description, v.body, { tools: v.tools, model: v.model }));
        // Each agent's file is written from the shelf file: the ones in projects follow it
        let n = 0;
        if (f.kind === "edit") for (const root of usersOf(this.index, "agent", v.name)) { if ((await exec("sh", [`${MODS()}/agent.sh`, "resync", root, `${SHELF()}/agents`, v.name])).code === 0) n++; }
        this.notice = f.kind === "new" ? `Saved “${v.name}” on the shelf. Click it in the list and Apply to turn it on` : `Saved “${v.name}”` + (n ? ` and rewrote its files in ${plural(n, "project")}` : "");
        saved = true;
      } catch (e) { f.error = plain(e); }
      finally {
        f.busy = false;
        if (saved) { this.form = null; this.mode = null; }
        this.refresh(cx, true); cx.notify();
      }
    });
  }

  openImport(cx) {
    if (this.applying || this.confirm || this.mode || !this.root || this.unsafe) return;
    const context = this.context, root = this.root;
    this.mode = "import"; this.imports = { state: "loading", rows: [] }; this.note = null; this.notice = null; cx.notify();
    cx.spawn(async (cx) => {
      const rows = [];
      try {
        const r = await exec("sh", [`${MODS()}/list-project-agents.sh`, root, `${SHELF()}/agents`]);
        for (const l of r.stdout.split("\n").filter(Boolean)) {
          const [agent, stem, path] = l.split("\t");
          let got;
          try { got = fromAgentFile(await fs.readFile(`${root}/${path}`, "utf8"), stem); } catch (e) { got = { error: plain(e) }; }
          rows.push({ agent, stem, path, ...got });
        }
      } catch (e) { if (this.context === context) this.imports = { state: "error", rows: [], error: plain(e) }; cx.notify(); return; }
      if (this.context === context && this.mode === "import") this.imports = { state: "done", rows };
      cx.notify();
    });
  }

  closeImport(cx) { this.mode = null; this.imports = null; cx.notify(); }

  importAgent(row, cx) {
    if (this.applying || this.adding.has(`i:${row.path}`) || row.error) return;
    this.adding.add(`i:${row.path}`); cx.notify();
    cx.spawn(async (cx) => {
      try {
        const file = `${SHELF()}/agents/${row.name}.md`;
        if (this.agentShelf.some((a) => a.name === row.name) || (await fs.exists(file))) throw new Error(`“${row.name}” is already on the shelf`);
        await fs.mkdir(`${SHELF()}/agents`, { recursive: true });
        await fs.writeFile(file, agentText(row.name, row.description, row.body, { tools: row.tools, model: row.model }));
        this.notice = `Imported “${row.name}” to the shelf. The file in this project stays as it is, so turn it on only for agents that do not have their own file`;
      } catch (e) { this.note = `${row.name}: ${plain(e)}`; }
      finally { this.adding.delete(`i:${row.path}`); this.refresh(cx, true); cx.notify(); }
    });
  }

  // --- Find: skills.sh, the official MCP registry, the aitmpl.com catalog (agents, hooks), Claude's marketplaces and npm (plugins) ---
  setFindKind(kind, cx) {
    if (this.found.state === "loading") return;
    this.findKind = kind; if (this.found.state !== "idle") this.found = { ...this.found, state: "idle" };
    if (kind === "plugins" || kind === "all") this.loadPlugins(cx);
    cx.notify();
  }

  // The catalog list comes from the website; the files of its entries from the repository, and they are all taken from ONE commit found now
  // (so what is shown to the person is exactly what is added). With no commit (git cannot reach GitHub) nothing from it can be added.
  async loadCatalog() {
    if (this.catalog && Date.now() - this.catalogAt < 3600 * 1000) return this.catalog;
    const [cat, sha] = await Promise.all([getJson(CATALOG_URL), exec("sh", [`${MODS()}/catalog-sha.sh`], { timeout: 60000 }).catch(() => ({ code: 1, stdout: "" }))]);
    this.catalog = cat; this.catalogAt = Date.now();
    this.catalogSha = sha.code === 0 && SHA_OK.test(sha.stdout.trim()) ? sha.stdout.trim() : null;
    return this.catalog;
  }

  search(cx) {
    const q = this.finder.value().trim(), kind = this.findKind;
    if (q.length < 2 || this.found.state === "loading") return;
    const wants = (k) => kind === "all" || kind === k;
    this.found = { state: "loading", skills: [], mcps: [], agents: [], hooks: [], plugins: [], errors: [], error: null, query: q, kind };
    cx.notify();
    cx.spawn(async (cx) => {
      const enc = encodeURIComponent(q), jobs = [];
      const job = (name, run) => jobs.push(run().then((value) => ({ name, value }), (reason) => ({ name, reason })));
      if (wants("skills")) job("skills.sh", () => getJson(`https://skills.sh/api/search?q=${enc}&limit=20`));
      if (wants("mcp")) job("the MCP registry", () => getJson(`https://registry.modelcontextprotocol.io/v0/servers?search=${enc}&limit=30&version=latest`));
      if (wants("agents") || wants("hooks")) job("the aitmpl.com catalog", () => this.loadCatalog());
      if (wants("plugins")) {
        job("Claude's marketplaces", async () => { const r = await this.runIn(this.root ?? home(), ["claude", "plugin", "list", "--available", "--json"], 120000); if (r.missing) return null; const j = jsonFrom(r.stdout); if (r.code !== 0 || !j) throw new Error("its list could not be read"); return j; });
        job("npm", () => getJson(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(`keywords:opencode-plugin ${q}`)}&size=15`));
      }
      const done = await Promise.all(jobs), by = Object.fromEntries(done.map((d) => [d.name, d]));
      const ok = (n) => by[n] && "value" in by[n] ? by[n].value : undefined;
      const seen = new Set(), errors = done.filter((d) => "reason" in d).map((d) => `${d.name}: ${plain(d.reason)}`);
      const cat = ok("the aitmpl.com catalog");
      this.found = {
        state: "done", query: q, kind, errors,
        skills: (ok("skills.sh")?.skills ?? []).filter((x) => x.source && x.skillId),
        mcps: (ok("the MCP registry")?.servers ?? []).map((x) => ({ raw: x.server, conv: fromRegistry(x.server) })).filter((x) => x.raw?.name && !seen.has(x.raw.name) && seen.add(x.raw.name)),
        agents: wants("agents") && cat ? catalogHits(cat, "agents", q) : [],
        hooks: wants("hooks") && cat ? catalogHits(cat, "hooks", q, 10) : [],
        plugins: [...(ok("Claude's marketplaces") ? claudeAvailable(ok("Claude's marketplaces"), q) : []), ...(ok("npm") ? npmPlugins(ok("npm")) : [])],
        claudeMissing: by["Claude's marketplaces"] && "value" in by["Claude's marketplaces"] && by["Claude's marketplaces"].value === null,
        error: errors.length === jobs.length ? errors[0] : null,
      };
      this.found.partial = !this.found.error && errors.length > 0;
      cx.notify();
    });
  }

  // An agent from the catalog is fetched at the pinned commit and shown in full first (Review); what is added is those very bytes, not a second fetch.
  askAgentReview(e, cx) {
    const id = `ca:${e.path}`, url = catalogUrl("agents", e.path, this.catalogSha);
    if (this.adding.has(id) || this.applying || !url || e.risk === "DO_NOT_INSTALL") return;
    const sha = this.catalogSha;
    this.adding.add(id); this.note = null; this.notice = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const res = await fetch(url), text = await res.text();
        if (!res.ok) throw new Error(`${res.status} when fetching it`);
        const got = fromAgentFile(text, e.name);
        if (got.error) throw new Error(`cannot be used: ${got.error}`);
        const editor = EditorState.new({ language: "markdown", readonly: true, soft_wrap: true, line_numbers: false, folding: false, value: got.body, font_family: settings().font_family, font_size: 12 });
        this.review = { entry: e, sha, got, editor, url };
        this.mode = "review";
      } catch (err) { this.note = `${e.name}: ${plain(err)}`; }
      finally { this.adding.delete(id); cx.notify(); }
    });
  }

  closeReview(cx) { if (this.applying) return; this.review = null; this.mode = "find"; cx.notify(); }

  addReviewed(cx) {
    const r = this.review;
    if (!r || this.applying || r.entry.risk === "DO_NOT_INSTALL") return;
    const { got, entry, sha } = r;
    this.applying = true; this.note = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const file = `${SHELF()}/agents/${got.name}.md`;
        if (this.agentShelf.some((a) => a.name === got.name) || (await fs.exists(file))) throw new Error(`“${got.name}” is already on the shelf`);
        await fs.mkdir(`${SHELF()}/agents`, { recursive: true });
        await fs.writeFile(file, agentText(got.name, got.description, got.body, { tools: got.tools, model: got.model }));
        this.sources.agents[got.name] = { repo: CATALOG_REPO, sha, path: entry.path, scan: entry.risk || null, addedAt: Date.now() };
        await this.saveSources();
        this.notice = `Added agent “${got.name}” to the shelf (catalog commit ${sha.slice(0, 10)}). Turning it on is a separate step`;
        this.review = null; this.mode = "find";
      } catch (err) { this.note = `${entry.name}: ${plain(err)}`; this.review = null; this.mode = "find"; }
      finally { this.applying = false; this.refresh(cx, true); cx.notify(); }
    });
  }

  // --- hooks: add one from the catalog to this project's Claude settings, remove one; both ask first and show the commands in full ---
  askHookAdd(e, cx) {
    const id = `ch:${e.path}`, url = catalogUrl("hooks", e.path, this.catalogSha);
    if (this.adding.has(id) || this.applying || this.confirm || !url || e.risk === "DO_NOT_INSTALL" || !this.root || this.unsafe) return;
    const sha = this.catalogSha;
    this.adding.add(id); this.note = null; this.notice = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const res = await fetch(url), text = await res.text();
        if (!res.ok) throw new Error(`${res.status} when fetching it`);
        const got = parseHookFile(text);
        if (got.error) throw new Error(`cannot be added: ${got.error}`);
        this.confirm = { kind: "hook-add", entry: e, hooks: got.hooks, root: this.root, sha };
      } catch (err) { this.note = `${e.name}: ${plain(err)}`; }
      finally { this.adding.delete(id); cx.notify(); }
    });
  }

  // Settings of Claude are edited as strict JSON: a file with comments is refused, never overwritten.
  editSettings(root, scope, change) {
    const file = `${root}/.claude/settings${scope === "local" ? ".local" : ""}.json`;
    return readJson(file).then(async (now) => {
      const next = change(now ?? {});
      if (!next) return "";
      await writeFiles(exec, { [file]: Object.keys(next).length ? json(next) : null });
      return now ? " (the old file is kept in Toolkit's backups folder)" : "";
    });
  }

  doHookAdd(cx) {
    if (this.confirm?.kind !== "hook-add" || this.applying) return;
    const { entry, hooks, root } = this.confirm, context = this.context;
    this.applying = true; cx.notify();
    cx.spawn(async (cx) => {
      let result = null;
      try {
        const kept = await this.editSettings(root, "project", (now) => { const r = withHooks(now, hooks); result = r.added; return r.added ? r.next : null; });
        if (this.context === context) { if (result) this.notice = `Added ${plural(result, "hook group")} from “${entry.name}” to .claude/settings.json${kept}. Claude reads it when it starts`; else this.note = `“${entry.name}” is already in .claude/settings.json`; }
      } catch (e) { if (this.context === context) this.note = `Could not add “${entry.name}”: ${plain(e)}`; }
      finally { this.confirm = null; this.applying = false; this.refresh(cx, true); cx.notify(); }
    });
  }

  askHookRemove(h, cx) {
    if (this.applying || this.confirm || this.staged.size) { if (this.staged.size) { this.note = "Apply or cancel the staged changes first"; cx.notify(); } return; }
    this.confirm = { kind: "hook-remove", hook: h, root: this.root }; this.note = null; this.notice = null; cx.notify();
  }

  doHookRemove(cx) {
    if (this.confirm?.kind !== "hook-remove" || this.applying) return;
    const { hook, root } = this.confirm, context = this.context;
    this.applying = true; cx.notify();
    cx.spawn(async (cx) => {
      let removed = 0;
      try {
        const kept = await this.editSettings(root, hook.scope, (now) => { const r = withoutHook(now, { event: hook.event, matcher: hook.matcher, text: hook.text }); removed = r.removed; return r.removed ? r.next : null; });
        if (this.context === context) { if (removed) this.notice = `Removed the ${hook.event} hook from .claude/settings${hook.scope === "local" ? ".local" : ""}.json${kept}`; else this.note = "That hook is not in the file any more"; }
      } catch (e) { if (this.context === context) this.note = `Could not remove it: ${plain(e)}`; }
      finally { this.confirm = null; this.applying = false; this.refresh(cx, true); cx.notify(); }
    });
  }

  // --- plugins: install one that Find found, for this project, with the agent's own command; asks first ---
  askInstall(p, cx) {
    if (this.applying || this.confirm || !installCommand(p) || !this.root || this.unsafe) return;
    this.confirm = { kind: "install", plugin: p, root: this.root }; this.note = null; this.notice = null; cx.notify();
  }

  doInstall(cx) {
    if (this.confirm?.kind !== "install" || this.applying) return;
    const { plugin: p, root } = this.confirm, context = this.context, cmd = installCommand(p), label = AGENTS.find((a) => a.key === p.agent).label;
    this.applying = true; this.note = null; this.notice = null; cx.notify();
    cx.spawn(async (cx) => {
      let why = "";
      try {
        const r = await this.runIn(root, cmd, 170000);
        why = r.missing ? `${label} is not installed here` : pluginResult(p.agent, r);
      } catch (e) { why = plain(e); }
      finally {
        this.confirm = null; this.applying = false;
        if (this.context === context) { if (why) this.note = `Could not install “${p.name}”: ${why}`; else this.notice = `Installed “${p.name}” for ${label} in this project. Restart ${label} to use it`; }
        this.refresh(cx, true); this.loadPlugins(cx, true); cx.notify();
      }
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
        const from = parseSource(r.stdout);
        if (from) { this.sources.skills[s.skillId] = { repo: s.source, id: s.skillId, ...from, latest: null, gone: false }; await this.saveSources(); }
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
        this.sources.mcps[slug] = { source: x.raw.name, version: x.raw.version ?? null, fp: defFp(x.conv.def), latest: null };
        await this.saveSources();
      } catch (e) { this.note = `${x.conv.slug}: ${String(e).replace(/^Error: /, "")}`; }
      finally { this.adding.delete(id); this.refresh(cx, true); cx.notify(); }
    });
  }

  // --- versions: what came from outside is looked up again, and updated on the person's say ---
  async saveSources() { await fs.writeFile(`${SHELF()}/sources.json`, json(this.sources)); }

  // The shelf items Toolkit knows the source of (added from Find) and that are still on the shelf.
  tracked() {
    return [
      ...this.master.filter((m) => this.sources.skills[m.name]).map((m) => ({ kind: "skill", name: m.name })),
      ...Object.keys(this.registry).filter((k) => this.sources.mcps[k]).map((k) => ({ kind: "mcp", name: k })),
    ];
  }

  trackInfo(kind, name) {
    if (kind === "agent") return trackOf(kind, undefined);   // agents are not looked up online
    const rec = (kind === "skill" ? this.sources.skills : this.sources.mcps)[name];
    const fp = kind === "skill" ? this.master.find((m) => m.name === name)?.fp : this.registry[name] ? defFp(this.registry[name]) : undefined;
    return trackOf(kind, rec, fp);
  }

  // Asks GitHub (the repos' file lists only) and the MCP registry whether anything tracked has a newer version. Changes nothing on the shelf.
  checkUpdates(cx) {
    if (this.checking || this.applying) return;
    this.checking = true; this.checkError = null; cx.notify();
    cx.spawn(async (cx) => {
      const errors = [], byRepo = new Map();
      let asked = 0;
      try {
        for (const { kind, name } of this.tracked()) {
          if (kind !== "skill") continue;
          const rec = this.sources.skills[name];
          byRepo.set(rec.repo, [...(byRepo.get(rec.repo) ?? []), rec]);
        }
        for (const [repo, recs] of byRepo) {
          const r = await exec("sh", [`${MODS()}/check-update.sh`, repo, ...recs.flatMap((rec) => [rec.id, rec.path])], { timeout: 120000 });
          if (r.code !== 0) { errors.push((r.stderr || r.stdout).trim().split("\n").pop() || `${repo}: exit ${r.code}`); continue; }
          const lines = r.stdout.split("\n").filter(Boolean).map((l) => l.split("\t"));
          asked++;
          for (const rec of recs) {
            const l = lines.find((x) => x[0] === rec.id);
            if (!l) continue;
            if (l[1] === "missing") rec.gone = true; else { rec.gone = false; rec.latest = { path: l[1], tree: l[2], commit: l[3] }; }
          }
        }
        for (const { kind, name } of this.tracked()) {
          if (kind !== "mcp") continue;
          const rec = this.sources.mcps[name];
          try {
            const server = await latestServer(rec.source);
            if (server?.version) { rec.latest = { version: server.version }; rec.gone = false; } else rec.gone = true;
            asked++;
          } catch (e) { errors.push(`${name}: ${plain(e)}`); }
        }
        if (asked > 0 || !errors.length) this.sources.checkedAt = Date.now();   // "checked" only when something answered
        await this.saveSources();
      } catch (e) { errors.push(plain(e)); }
      finally {
        this.checking = false; this.checkError = errors.length ? errors[0] : null;
        cx.notify();
      }
    });
  }

  // The items with a newer version that were not changed on the shelf since they were put there; asks first.
  updateAll(cx) {
    const todo = this.tracked().filter(({ kind, name }) => { const i = this.trackInfo(kind, name); return i.update && !i.edited; });
    const skipped = this.tracked().filter(({ kind, name }) => { const i = this.trackInfo(kind, name); return i.update && i.edited; });
    if (todo.length) this.askUpdate(todo, skipped, cx);
  }

  askUpdate(items, skipped, cx) {
    if (this.applying || this.checking) return;
    this.confirm = { kind: "update", items, skipped: skipped ?? [], replaces: items.filter(({ kind, name }) => this.trackInfo(kind, name).edited) };
    this.note = null; this.notice = null; cx.notify();
  }

  doUpdate(cx) {
    if (this.confirm?.kind !== "update" || this.applying) return;
    const { items } = this.confirm, context = this.context;
    this.applying = true; this.note = null; this.notice = null; cx.notify();
    cx.spawn(async (cx) => {
      const done = [], failed = [];
      try {
        for (const { kind, name } of items) {
          try { if (kind === "skill") await this.updateSkill(name); else await this.updateMcp(name); done.push(name); }
          catch (e) { failed.push(`${name}: ${plain(e)}`); }
        }
        await this.saveSources();
      } catch (e) { failed.push(plain(e)); }
      finally {
        this.confirm = null; this.applying = false;
        if (this.context === context) {
          if (done.length) this.notice = `Updated ${done.join(", ")}`;
          if (failed.length) this.note = `Could not update ${failed.join(" · ")}`;
        }
        this.refresh(cx, true); cx.notify();
      }
    });
  }

  // Fetches the skill again (the same way Add does), replaces the shelf folder, and brings Antigravity's copies in step.
  async updateSkill(name) {
    const rec = this.sources.skills[name], shelf = SHELF();
    const r = await exec("sh", [`${MODS()}/add-skill.sh`, rec.repo, rec.id, `${shelf}/skills`], { timeout: 130000 });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `exit ${r.code}`);
    const from = parseSource(r.stdout);
    if (!from) throw new Error("it did not say where the new version came from");
    Object.assign(rec, from, { latest: null, gone: false });
    for (const root of usersOf(this.index, "skill", name)) {
      if (await fs.exists(`${root}/.agents/skills/${name}/.toolkit-source`)) await exec("sh", [`${MODS()}/skill.sh`, "enable", root, `${shelf}/skills`, name, "antigravity"]);
    }
  }

  // Takes the newest entry from the registry, replaces the shelf entry, and writes it into the projects where it is on.
  async updateMcp(name) {
    const rec = this.sources.mcps[name], file = `${SHELF()}/mcp.json`;
    const server = await latestServer(rec.source);
    if (!server) throw new Error("the registry no longer has it");
    const conv = fromRegistry(server);
    if (!conv) throw new Error("the new version needs something Toolkit does not run (a Docker image or a bundle)");
    const now = (await readJson(file)) ?? { mcps: {} };
    now.mcps = { ...(now.mcps ?? {}), [name]: conv.def };
    await reapplyMcp({ exec, fs, roots: usersOf(this.index, "mcp", name), name, registry: now.mcps });
    await fs.writeFile(file, json(now));
    this.registry = now.mcps;
    Object.assign(rec, { version: server.version ?? null, fp: defFp(conv.def), latest: null, gone: false });
  }

  // --- drawing ---
  iconButton(id, icon, hoverColor, click, t) {
    return div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover((x) => x.text_color(hoverColor).bg(t.hover))
      .on_click((_e, cx) => { cx.stop_propagation(); click(cx); }).child(svg(`mods/toolkit/${icon}.svg`).size(14));
  }

  checkbox(shown, partial, t, fixed = false) {
    return div().size(16).flex_none().flex().items_center().justify_center().rounded(4).border_1().border_color(shown || partial ? t.accent : t.border).bg(shown ? t.accent : t.background).when(fixed, (e) => e.opacity(0.45))
      .when(shown, (e) => e.child(svg("mods/toolkit/check.svg").size(11).text_color(t.background)))
      .when(partial, (e) => e.child(div().w(8).h(2).rounded(1).bg(t.accent)));
  }

  // One line of a shelf list (skills, agents, MCP servers). `sets`: agent -> names that are on for it. `canDelete` is false for what is not
  // on the shelf (a file or link without its source); `problem`: why it cannot be turned on; `onEdit`: shows a pencil. The agents it is on for
  // are not drawn on the row: the chips above say it, and a row that is on for only some of the picked agents says which.
  row({ kind, name, sets, sub, canDelete, problem = "", onEdit = null, note = "" }, t) {
    const id = `${PREFIX[kind]}:${name}`, sel = this.selected();
    const full = this.full(sets, name), some = this.some(sets, name);
    const staged = this.staged.has(id), shown = staged ? this.staged.get(id) : full, partial = !staged && some && !full;
    const asking = this.confirm?.kind === kind && this.confirm.name === name;
    const info = this.trackInfo(kind, name);
    const subText = [sub, info.edited ? "edited here" : null, info.gone ? "removed upstream" : null].filter(Boolean).join(" · ");
    const have = sel.filter((a) => sets[a].has(name)).map((a) => AGENTS.find((x) => x.key === a).label);
    const side = staged ? { text: shown ? "turn on" : "turn off", color: shown ? t.ansi2 : t.ansi1 } : partial ? { text: have.length <= 2 ? `${have.join(", ")} only` : `${have.length} of ${sel.length} agents`, color: t.dim } : null;
    return h_flex().id(`row-${id}`).flex_none().min_h(44).px(8).py(6).gap(10).items_center().rounded(7).cursor_pointer().hover((x) => x.bg(t.hover))
      .when(staged, (e) => e.bg(t.raised)).when(asking, (e) => e.bg(t.raised).border_1().border_color(t.ansi1)).when(this.applying, (e) => e.opacity(0.5))
      .on_click((_e, cx) => this.stage(id, full, cx, Boolean(problem)))
      .child(this.checkbox(shown, partial, t))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().truncate().text_size(12.5).text_color(shown || partial ? t.foreground : t.muted).child(name))
        .when(Boolean(problem), (e) => e.child(div().truncate().text_size(11).text_color(t.ansi1).child(problem)))
        .when(!problem && Boolean(subText), (e) => e.child(div().truncate().text_size(11).text_color(t.dim).child(subText)))
        .when(!problem && Boolean(note), (e) => e.child(div().truncate().text_size(10.5).text_color(t.dim).child(note))))
      .when(Boolean(side), (e) => e.child(div().flex_none().text_size(10.5).text_color(side.color).child(side.text)))
      .when(info.update, (e) => e.child(this.button(`upd-${id}`, "Update", "plain", !this.applying && !this.checking, (cx) => { cx.stop_propagation(); this.askUpdate([{ kind, name }], [], cx); }, t)))
      .when(Boolean(onEdit), (e) => e.child(this.iconButton(`edit-${id}`, "pencil", t.foreground, onEdit, t)))
      .when(canDelete, (e) => e.child(this.iconButton(`del-${id}`, "trash", t.ansi1, (cx) => this.askDelete(kind, name, cx), t)));
  }

  // One plugin of one agent. A click stages turning it on or off (Apply runs the agent's own command); the trash uninstalls (asks first).
  pluginRow(p, t) {
    const id = `p:${pluginKey(p)}`, label = AGENTS.find((a) => a.key === p.agent).label;
    const staged = this.staged.has(id), shown = staged ? this.staged.get(id) : p.enabled;
    const asking = this.confirm?.kind === "uninstall" && pluginKey(this.confirm.row) === pluginKey(p);
    const sub = [p.from && `from ${p.from}`, p.version && `v${p.version}`, p.where, p.parts, p.toggle ? "" : "always on"].filter(Boolean).join(" · ");
    return h_flex().id(`row-${id}`).flex_none().min_h(44).px(8).py(6).gap(10).items_center().rounded(7).hover((x) => x.bg(t.hover))
      .when(p.toggle, (e) => e.cursor_pointer().on_click((_e, cx) => this.stage(id, p.enabled, cx)))
      .when(staged, (e) => e.bg(t.raised)).when(asking, (e) => e.bg(t.raised).border_1().border_color(t.ansi1)).when(this.applying, (e) => e.opacity(0.5))
      .child(this.checkbox(shown, false, t, !p.toggle))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().truncate().text_size(12.5).text_color(shown ? t.foreground : t.muted).child(p.name))
        .child(div().truncate().text_size(11).text_color(t.dim).child(sub)))
      .child(div().flex_none().text_size(10.5).text_color(staged ? (shown ? t.ansi2 : t.ansi1) : t.dim).child(staged ? (shown ? "turn on" : "turn off") : label))
      .when(p.remove, (e) => e.child(this.iconButton(`del-${id}`, "trash", t.ansi1, (cx) => this.askUninstall(p, cx), t)));
  }

  // One hook: what runs, when, and where it is written. Nothing to click: Toolkit only shows hooks.
  hookRow(h, i, t) {
    const label = AGENTS.find((a) => a.key === h.agent).label, removable = h.agent === "claude" && (h.scope === "project" || h.scope === "local");
    const what = [h.type !== "command" ? `${h.type}:` : "", h.text].filter(Boolean).join(" ");
    const sub = [h.name, what, h.enabled ? "" : "off"].filter(Boolean).join(" · ");
    return h_flex().id(`hook-${i}`).flex_none().min_h(44).px(8).py(6).gap(10).items_center().rounded(7).hover((x) => x.bg(t.hover))
      .child(div().size(16).flex_none())
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().truncate().text_size(12.5).text_color(h.enabled ? t.foreground : t.dim).child(h.matcher ? `${h.event} · ${h.matcher}` : h.event))
        .child(div().truncate().text_size(11).text_color(t.dim).child(sub || "(no command)")))
      .child(div().flex_none().max_w(150).truncate().text_size(10.5).text_color(t.dim).child(`${label} · ${h.scope}`))
      .when(removable, (e) => e.child(this.iconButton(`del-h:${i}`, "trash", t.ansi1, (cx) => this.askHookRemove(h, cx), t)));
  }

  // One agent's picture; `dim` fades it.
  agentIcon(a, size, t, dim = false) {
    return div().flex_none().flex().items_center().justify_center().opacity(dim ? 0.28 : 1)
      .child(a.own ? image(a.icon).w(size).h(size).flex_none() : svg(a.icon).size(size).text_color(t.foreground));
  }

  // Updates on the Skills and MCP tabs: when it last looked, how many are newer, Check and Update all.
  updateStrip(t) {
    const tracked = this.tracked();
    if (!tracked.length) return null;
    const n = tracked.filter(({ kind, name }) => this.trackInfo(kind, name).update).length;
    const text = this.checking ? "Checking for updates…" : this.checkError ? `Could not check: ${this.checkError}` : n ? `${plural(n, "update")} available` : this.sources.checkedAt ? `Up to date · checked ${ago(this.sources.checkedAt)}` : "Not checked yet";
    return h_flex().flex_none().px(10).py(6).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().id("toolkit-update-text").flex_1().min_w(0).truncate().text_size(11.5).text_color(this.checkError ? t.ansi1 : n ? t.foreground : t.dim).child(text))
      .child(this.button("toolkit-check", "Check", "plain", !this.checking && !this.applying, (cx) => this.checkUpdates(cx), t))
      .when(n > 0, (e) => e.child(this.button("toolkit-update-all", "Update all", "primary", !this.checking && !this.applying, (cx) => this.updateAll(cx), t)));
  }

  // What an update will do, in words, before the button.
  updateBar(t) {
    const { items, skipped, replaces } = this.confirm;
    const list = (xs) => xs.length > 6 ? `${xs.slice(0, 6).map((x) => x.name).join(", ")} and ${xs.length - 6} more` : xs.map((x) => x.name).join(", ");
    const detail = `${list(items)} will be replaced by the newest version from where ${items.length === 1 ? "it was" : "they were"} added. Projects that have ${items.length === 1 ? "it" : "them"} on get the new version`
      + (replaces.length ? `. Your edits to ${list(replaces)} on the shelf are replaced.` : ".")
      + (skipped.length ? ` Skipped, because you edited ${skipped.length === 1 ? "it" : "them"} on the shelf: ${list(skipped)}.` : "");
    return v_flex().flex_none().px(10).py(9).gap(7).border_t(1).border_color(t.border).bg(t.raised)
      .child(div().text_size(12).font_semibold().child(`Update ${plural(items.length, "item")}?`))
      .child(div().text_size(11).text_color(t.dim).child(detail))
      .child(h_flex().gap(8).justify_end()
        .child(this.button("toolkit-update-cancel", "Cancel", "plain", !this.applying, (cx) => { this.confirm = null; cx.notify(); }, t))
        .child(this.button("toolkit-update-go", this.applying ? "Updating…" : "Update", "primary", !this.applying, (cx) => this.doUpdate(cx), t)));
  }

  // The number is how many things of this tab are on for that agent in this project ("n/a": that agent has none of them).
  chipCount(a) {
    const tab = this.tab;
    if (!SUPPORT[tab].includes(a.key)) return "n/a";
    if (tab === "skills") return String(this.active[a.key].size);
    if (tab === "agents") return String(this.agentOn[a.key].size);
    if (tab === "mcp") return String(this.mcpOn[a.key].size);
    if (tab === "plugins") return this.pluginsFor === this.context ? String(this.plugins.filter((p) => p.agent === a.key && p.enabled).length) : "";
    return String(this.hooks.filter((h) => h.agent === a.key && h.enabled).length);
  }

  agentChip(a, t) {
    const on = this.agents.has(a.key), count = this.chipCount(a);
    // like the tabs: no border, the picked ones have the selected background
    return h_flex().id(`agent-${a.key}`).h(26).px(9).gap(6).items_center().rounded(6).cursor_pointer().text_size(12)
      .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted)
      .when(this.staged.size > 0 || this.applying, (e) => e.opacity(0.6))
      .hover((x) => x.bg(t.hover)).on_click((_e, cx) => this.pickAgent(a.key, cx)).child(this.agentIcon(a, 14, t, !on)).child(a.label)
      .when(Boolean(count), (e) => e.child(div().text_size(10.5).text_color(t.dim).child(count)));
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

  resultRow(id, title, sub, label, state, click, t, haveText = "On shelf", noText = "Not supported") {
    // state: "add" | "adding" | "have" | "no"
    return h_flex().id(`res-${id}`).flex_none().min_h(46).px(8).py(6).gap(10).items_center().rounded(7).hover((s) => s.bg(t.hover))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().truncate().text_size(12.5).text_color(t.foreground).child(title))
        .child(div().truncate().text_size(11).text_color(t.dim).child(sub)))
      .child(state === "have" ? div().flex_none().text_size(11).text_color(t.ansi2).child(haveText)
        : state === "no" ? div().flex_none().text_size(11).text_color(t.dim).child(noText)
        : this.button(`add-${id}`, state === "adding" ? "Adding…" : label, "plain", state === "add", click, t));
  }

  findRows(t) {
    const f = this.found, rows = [];
    const head = (text) => div().flex_none().px(8).pt(8).pb(3).text_size(10.5).text_color(t.dim).child(text);
    const note = (text, color = t.dim) => div().flex_none().px(10).py(4).text_size(11).text_color(color).child(text);
    if (f.state === "idle") return [div().p(10).text_size(12).text_color(t.dim).child(`Searches ${{ all: "everything below", skills: "skills.sh", agents: "agents on aitmpl.com", mcp: "the official MCP registry", plugins: "Claude's marketplaces and npm (OpenCode)", hooks: "hooks on aitmpl.com" }[this.findKind]}. Pick what to search with the buttons above. Add puts a skill or MCP server on the shelf; Review shows an agent or a hook in full first, and nothing is written until you confirm. A plugin is installed only after a question that shows the exact command.`)];
    if (f.state === "loading") return [div().p(10).text_size(12).text_color(t.dim).child(`Searching for “${f.query}”…`)];
    if (f.error) return [div().p(10).text_size(12).text_color(t.ansi1).child(`Search failed: ${f.error}`)];
    if (f.errors?.length) rows.push(note(`Could not reach: ${f.errors.join(" · ")}`, t.ansi1));
    const risk = (e) => (e.risk && e.risk !== "SAFE" ? ` · scan: ${e.risk}` : e.risk ? " · scan: safe" : "");
    if (f.skills.length) {
      rows.push(head(`SKILLS · skills.sh · ${f.skills.length}`));
      for (const s of f.skills) {
        const id = `s:${s.source}/${s.skillId}`, have = this.master.some((m) => m.name === s.skillId), github = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(s.source);
        const valid = /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s.skillId) && s.skillId.length <= 64;
        rows.push(this.resultRow(id, s.name ?? s.skillId, `${s.source} · ${kfmt(s.installs)} installs${github ? "" : " · not on GitHub"}${valid ? "" : " · name agents do not accept"}`, "Add", have ? "have" : !github || !valid ? "no" : this.adding.has(id) ? "adding" : "add", (cx) => this.addSkill(s, cx), t));
      }
    }
    if ((f.agents?.length || f.hooks?.length) && !this.catalogSha) rows.push(note("Could not pin the catalog to one commit (git could not reach GitHub), so its agents and hooks cannot be added now", t.ansi1));
    if (f.agents?.length) {
      rows.push(head(`AGENTS · aitmpl.com · ${f.agents.length}`));
      for (const e of f.agents) {
        const have = this.agentShelf.some((a) => a.name === e.name), valid = AGENT_NAME.test(e.name), id = `ca:${e.path}`, blocked = e.risk === "DO_NOT_INSTALL" ? "Scan: do not install" : !this.catalogSha ? "Not pinned" : "Not supported";
        rows.push(this.resultRow(id, e.name, `${e.category} · ${kfmt(e.downloads)} downloads${risk(e)}${valid ? "" : " · name agents do not accept"} · ${e.description}`, "Review", have ? "have" : !valid || !catalogUrl("agents", e.path, this.catalogSha) || e.risk === "DO_NOT_INSTALL" ? "no" : this.adding.has(id) ? "adding" : "add", (cx) => this.askAgentReview(e, cx), t, "Name on shelf", blocked));
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
    if (f.plugins?.length || f.claudeMissing || ["all", "plugins"].includes(f.kind)) {
      if (f.plugins?.length) rows.push(head(`PLUGINS · Claude's marketplaces and npm (OpenCode) · ${f.plugins.length}`));
      if (f.claudeMissing) rows.push(note("Claude is not installed here, so its marketplaces cannot be searched"));
      for (const p of f.plugins ?? []) {
        const have = this.plugins.some((x) => x.agent === p.agent && x.id === p.id), label = AGENTS.find((a) => a.key === p.agent).label;
        rows.push(this.resultRow(`p:${p.agent}:${p.id}`, p.name, `${label} · ${p.from}${p.version ? ` · v${p.version}` : ""}${p.weekly ? ` · ${kfmt(p.weekly)} a week` : ""} · ${p.description}`, "Install", have ? "have" : this.confirm || !installCommand(p) ? "no" : "add", (cx) => this.askInstall(p, cx), t, "Installed"));
      }
      if (["all", "plugins"].includes(f.kind)) rows.push(note("Antigravity has no catalog to search: install one from a folder with agy plugin install <folder>."));
    }
    if (f.hooks?.length) {
      rows.push(head(`HOOKS · aitmpl.com · Claude format · ${f.hooks.length}`));
      for (const e of f.hooks) {
        const id = `ch:${e.path}`;
        rows.push(this.resultRow(id, e.name, `${e.category}${risk(e)} · ${e.description}`, "Review", !catalogUrl("hooks", e.path, this.catalogSha) || e.risk === "DO_NOT_INSTALL" ? "no" : this.adding.has(id) ? "adding" : "add", (cx) => this.askHookAdd(e, cx), t, "On shelf", e.risk === "DO_NOT_INSTALL" ? "Scan: do not install" : "Not pinned"));
      }
    }
    if (!f.skills.length && !f.mcps.length && !f.agents?.length && !f.plugins?.length && !f.hooks?.length) rows.push(div().p(10).text_size(12).text_color(t.dim).child(`Nothing found for “${f.query}”`));
    return rows;
  }

  // What a delete will do, in words, before the button.
  deleteBar(t) {
    const { kind, name } = this.confirm, roots = this.deleteRoots(kind, name);
    const detail = (kind === "mcp" ? "Its entry is erased from the shelf for good. " : kind === "agent" ? "Its file is erased from the shelf for good. " : "Its folder is erased from the shelf for good. ")
      + (roots.length ? `It is also turned off for every agent in ${names(roots)} (${plural(roots.length, "project")}). ` : "It is not turned on in any project Toolkit knows. ")
      + `A project's own ${kind === "mcp" ? "servers" : kind === "agent" ? "agents" : "skills"} are not touched, and neither are projects Toolkit has not seen.`;
    return this.confirmBar(`Delete ${WHAT[kind]} “${name}”?`, detail, "toolkit-del", this.applying ? "Deleting…" : "Delete", (cx) => this.doDelete(cx), t);
  }

  // What an uninstall will do, in words, before the button.
  uninstallBar(t) {
    const { row } = this.confirm, label = AGENTS.find((a) => a.key === row.agent).label;
    const detail = row.agent === "opencode" ? `“${row.id}” is taken out of the plugin list of this project's opencode.json. The package itself stays in OpenCode's cache.`
      : row.agent === "claude" ? `Runs claude plugin uninstall for “${row.id}” (${row.where}). Its saved data is kept. Restart Claude to apply.`
      : `Runs agy plugin uninstall for “${row.id}”. It is installed for you, so it goes from every project. Restart Antigravity to apply.`;
    const verb = row.agent === "opencode" ? "Remove" : "Uninstall";
    return this.confirmBar(`${verb} plugin “${row.name}” from ${label}?`, detail, "toolkit-uninstall", this.applying ? `${verb === "Remove" ? "Removing" : "Uninstalling"}…` : verb, (cx) => this.doUninstall(cx), t);
  }

  // The commands a hook would run, IN FULL (the box scrolls; nothing is cut), and what is about to be written.
  hookAddBar(t) {
    const { entry, hooks, sha } = this.confirm;
    const lines = [`Writes into this project's .claude/settings.json (a copy of the old file is kept first). Hooks run these commands by themselves, every time the event happens. From the catalog at commit ${String(sha).slice(0, 10)}:`,
      ...hooks.map(({ event, group }) => `${event}${group.matcher ? ` · ${group.matcher}` : ""} → ${group.hooks.map((h) => h.command).join(" ; ")}`),
      ...(entry.risk && entry.risk !== "SAFE" ? [`The catalog's own scan rates this hook ${entry.risk}${entry.findings?.length ? `: ${entry.findings.join(" · ")}` : ""}. Only add it if you have read every command above.`] : ["Read every command above: you are letting them run on your machine."])];
    return this.confirmBar(`Add hook “${entry.name}” for Claude?`, lines, "toolkit-hook-add", this.applying ? "Adding…" : "Add hook", (cx) => this.doHookAdd(cx), t);
  }

  hookRemoveBar(t) {
    const { hook } = this.confirm;
    return this.confirmBar(`Remove this ${hook.event} hook?`, [`${hook.event}${hook.matcher ? ` · ${hook.matcher}` : ""} → ${hook.text}`, `It is taken out of .claude/settings${hook.scope === "local" ? ".local" : ""}.json and stops running. The rest of the file is kept.`], "toolkit-hook-remove", this.applying ? "Removing…" : "Remove", (cx) => this.doHookRemove(cx), t);
  }

  installBar(t) {
    const { plugin: p } = this.confirm, label = AGENTS.find((a) => a.key === p.agent).label;
    const how = p.agent === "claude" ? `Runs claude ${installCommand(p).slice(1).join(" ")} in this project, so ${label} turns it on for this project (it is written into .claude/settings.json).`
      : `Runs opencode plugin ${p.id} in this project: the package is installed into OpenCode's config folder and added to this project's opencode.json.`;
    return this.confirmBar(`Install plugin “${p.name}” for ${label}?`, [how, "A plugin can bring skills, agents, hooks and MCP servers, all of which run code on your machine. Install it only if you trust where it comes from."], "toolkit-install", this.applying ? "Installing…" : "Install", (cx) => this.doInstall(cx), t);
  }

  confirmBar(title, detail, id, go, run, t) {
    return v_flex().flex_none().px(10).py(9).gap(7).border_t(1).border_color(t.border).bg(t.raised)
      .child(div().text_size(12).font_semibold().child(title))
      .child(v_flex().id(`${id}-detail`).max_h(260).overflow_y_scrollbar().gap(4).children((Array.isArray(detail) ? detail : [detail]).map((line) => div().text_size(11).text_color(t.dim).child(line))))
      .child(h_flex().gap(8).justify_end()
        .child(this.button(`${id}-cancel`, "Cancel", "plain", !this.applying, (cx) => { this.confirm = null; cx.notify(); }, t))
        .child(this.button(`${id}-go`, go, "danger", !this.applying, run, t)));
  }

  input(state, id, typing, t) {
    return div().id(id).flex_1().min_w(0).h(28).px(9).flex().items_center().rounded(7).border_1().border_color(this.typing === typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(Input.new(state).h_full().text_size(12).text_color(t.foreground));
  }

  // Name of the project, the Find button and refresh. Find is a screen of its own, so it has its button here, away from the filter.
  header(t) {
    const finding = this.mode === "find", name = this.root?.split("/").pop() ?? "";
    return h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().font_semibold().child("Toolkit"))
      .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(name))
      .child(h_flex().id("toolkit-find-open").h(26).px(10).gap(6).flex_none().items_center().rounded(6).text_size(12).cursor_pointer().bg(finding ? t.selected : t.background).text_color(finding ? t.foreground : t.muted)
        .when(this.mode === "form" || this.mode === "review" || this.applying, (e) => e.opacity(0.5)).hover((x) => x.bg(t.hover)).on_click((_e, cx) => this.toggleFind(cx)).child(finding ? "Close Find" : "Find"))
      .child(div().id("toolkit-refresh").size(24).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer().hover((x) => x.bg(t.hover)).on_click((_e, cx) => { this.refresh(cx, true); if (this.tab === "plugins") this.loadPlugins(cx, true); })
        .child(svg("mods/toolkit/refresh.svg").size(14).text_color(t.muted)));
  }

  // The sentence under the chips: what this tab is, and what a click, the pencil and the trash do.
  infoText() {
    const sel = this.selected(), labels = (keys) => keys.map((k) => AGENTS.find((a) => a.key === k).label).join(", ");
    switch (this.tab) {
      case "skills": return "Skills on your shelf. Click a row to stage it, then Apply writes it into this project. The trash deletes it from the shelf.";
      case "agents": return "Subagents on your shelf, written as each agent's own file. Click a row, then Apply. The pencil edits, the trash deletes it from the shelf.";
      case "mcp": return "MCP servers on your shelf, written into each agent's own config. Click a row, then Apply. The trash deletes it from the shelf.";
      case "plugins": return "What the agents have installed, from their own commands. Click a row to turn it on or off, then Apply. The trash uninstalls; Find installs. OpenCode plugins have no off switch.";
      default: {
        const none = sel.filter((k) => !SUPPORT.hooks.includes(k));
        return `A hook runs a command by itself. Claude's project hooks can be added with Find and removed with the trash; all others are shown only. ${none.length ? `${labels(none)} ${none.length === 1 ? "has" : "have"} no hooks.` : "OpenCode has no hooks."}`;
      }
    }
  }

  // What the current tab lists: { rows, total, shown, noun, empty, notes }.
  listFor(t) {
    const q = this.query, match = (...x) => !q || x.some((v) => v?.toLowerCase().includes(q)), tab = this.tab, rows = [];
    const on = (id, sets, n) => this.staged.has(`${id}:${n}`) ? this.staged.get(`${id}:${n}`) : this.full(sets, n);
    const byOn = (id, sets) => (a, b) => Number(on(id, sets, b)) - Number(on(id, sets, a)) || a.localeCompare(b);
    let total = 0, shown = 0, noun = "", empty = "", notes = [];
    if (tab === "skills") {
      noun = "skill"; total = this.master.length; empty = "No skills on the shelf yet: use Find to add some";
      const list = this.master.filter((x) => match(x.name, x.description)).sort((a, b) => byOn("s", this.active)(a.name, b.name));
      shown = list.length;
      for (const x of list) rows.push(this.row({ kind: "skill", name: x.name, sets: this.active, sub: x.description, canDelete: true, problem: x.problem }, t));
      for (const n of this.orphans.filter((n) => match(n))) rows.push(this.row({ kind: "skill", name: n, sets: this.orphanOn, sub: "a link to a skill that is no longer on the shelf · turn it off to remove the link", canDelete: false }, t));
    } else if (tab === "agents") {
      noun = "agent"; total = this.agentShelf.length; empty = "No agents on the shelf yet: New writes one, Import takes one from this project";
      const list = this.agentShelf.filter((x) => match(x.name, x.description)).sort((a, b) => byOn("a", this.agentOn)(a.name, b.name));
      shown = list.length;
      for (const x of list) rows.push(this.row({ kind: "agent", name: x.name, sets: this.agentOn, sub: x.description, canDelete: true, problem: x.problem, onEdit: (cx) => this.editAgent(x.name, cx), note: carryNote(x) }, t));
      for (const n of this.agentOrphans.filter((n) => match(n))) rows.push(this.row({ kind: "agent", name: n, sets: this.agentOrphanOn, sub: "a file Toolkit wrote from an agent that is no longer on the shelf · turn it off to remove it", canDelete: false }, t));
    } else if (tab === "mcp") {
      noun = "MCP server"; total = Object.keys(this.registry).length; empty = "No MCP servers on the shelf yet: use Find to add some";
      const list = Object.entries(this.registry).filter(([k, d]) => match(k, d.description)).sort(([a], [b]) => byOn("m", this.mcpOn)(a, b));
      shown = list.length;
      for (const [k, d] of list) rows.push(this.row({ kind: "mcp", name: k, sets: this.mcpOn, sub: `${remote(d) ? "remote" : "local"} · ${d.description ?? ""}`, canDelete: true }, t));
      for (const [k, agents] of [...this.custom].filter(([k]) => match(k))) rows.push(h_flex().flex_none().min_h(36).px(8).gap(10).items_center().text_size(12).text_color(t.dim).child(div().size(16).flex_none()).child(div().flex_1().truncate().child(`${k} · this project's own, not managed here`)).child(div().flex_none().text_size(10.5).child(AGENTS.filter((a) => agents.has(a.key)).map((a) => a.label).join(", "))));
    } else if (tab === "plugins") {
      noun = "plugin"; notes = this.pluginNotes;
      const mine = this.plugins.filter((p) => this.agents.has(p.agent));
      total = mine.length;
      const list = mine.filter((p) => match(p.name, p.from, p.where, p.parts, AGENTS.find((a) => a.key === p.agent).label));
      shown = list.length;
      for (const p of list) rows.push(this.pluginRow(p, t));
      empty = this.pluginsLoading || this.pluginsFor !== this.context ? "Loading plugins…" : "No plugins for the picked agents";
    } else {
      noun = "hook"; notes = this.hookNotes;
      const sel = this.selected(), mine = this.hooks.filter((h) => this.agents.has(h.agent));
      total = mine.length;
      const list = mine.filter((h) => match(h.event, h.matcher, h.text, h.name, h.scope));
      shown = list.length;
      list.forEach((h, i) => rows.push(this.hookRow(h, i, t)));
      empty = sel.length && sel.every((k) => !SUPPORT.hooks.includes(k)) ? `${sel.map((k) => AGENTS.find((a) => a.key === k).label).join(", ")} ${sel.length === 1 ? "has" : "have"} no hooks` : "No hooks in this project's settings files for the picked agents";
    }
    return { rows, total, shown, noun, empty, notes };
  }

  // The agents of the project's own, to take onto the shelf.
  importScreen(t) {
    const im = this.imports ?? { state: "loading", rows: [] };
    const rows = im.rows.map((r) => {
      const have = r.name && this.agentShelf.some((a) => a.name === r.name), label = AGENTS.find((a) => a.key === r.agent).label, busy = this.adding.has(`i:${r.path}`);
      return h_flex().id(`imp-${r.path}`).flex_none().min_h(46).px(8).py(6).gap(10).items_center().rounded(7).hover((x) => x.bg(t.hover))
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(div().truncate().text_size(12.5).text_color(t.foreground).child(r.name ?? r.stem))
          .child(div().truncate().text_size(11).text_color(r.error ? t.ansi1 : t.dim).child(r.error ? `${label} · ${r.path} · cannot import: ${r.error}` : `${label} · ${r.path}${r.description ? ` · ${r.description}` : ""}`)))
        .child(r.error ? div().flex_none().text_size(11).text_color(t.dim).child("Not importable")
          : have ? div().flex_none().text_size(11).text_color(t.ansi2).child("On shelf")
          : this.button(`imp-go-${r.path}`, busy ? "Importing…" : "Import", "plain", !busy && !this.applying, (cx) => this.importAgent(r, cx), t));
    });
    return v_flex().flex_1().min_h(0)
      .child(h_flex().flex_none().px(10).py(8).gap(8).items_center().border_b(1).border_color(t.border)
        .child(this.button("toolkit-import-back", "Back", "plain", true, (cx) => this.closeImport(cx), t))
        .child(div().flex_1().min_w(0).truncate().text_size(12).font_semibold().child(`Import agents from ${this.root?.split("/").pop() ?? "this project"}`)))
      .child(div().flex_none().px(12).py(7).border_b(1).border_color(t.border).text_size(11).text_color(t.dim).child("Takes the name, description and instructions of an agent file this project has on its own. Tools, model and other settings are not carried over: the three agents spell them differently. The original file stays; Toolkit leaves it alone, so the agent it came from keeps its own copy."))
      .child(v_flex().id("toolkit-import-list").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(rows)
        .when(im.state !== "done" || !rows.length, (e) => e.child(div().p(8).text_size(12).text_color(im.state === "error" ? t.ansi1 : t.dim).child(im.state === "loading" ? "Looking for agent files…" : im.state === "error" ? im.error : "This project has no agent files of its own (.claude/agents, .opencode/agents, .agents/agents)"))));
  }

  formScreen(t) {
    const f = this.form, problem = this.formProblem(), editing = f.kind === "edit";
    const label = (text, hint) => h_flex().flex_none().gap(8).items_baseline().child(div().text_size(11.5).font_semibold().child(text)).when(Boolean(hint), (e) => e.child(div().text_size(10.5).text_color(t.dim).child(hint)));
    return v_flex().flex_1().min_h(0)
      .child(h_flex().flex_none().px(10).py(8).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_semibold().child(editing ? `Edit agent “${f.name}”` : "New agent"))
        .child(div().flex_none().text_size(11).text_color(t.dim).child("saved on the shelf")))
      .child(v_flex().id("toolkit-form-fields").flex_1().min_h(0).p(12).gap(10)
        .child(label("Name", editing ? "cannot be renamed" : "lowercase letters, digits and hyphens"))
        .child(editing ? div().flex_none().h(28).px(9).flex().items_center().rounded(7).border_1().border_color(t.border).text_size(12).text_color(t.dim).child(f.name) : this.input(f.nameIn, "toolkit-form-name", "form-name", t).flex_none())
        .child(label("Description", "one line: tells the agent when to use it"))
        .child(this.input(f.descIn, "toolkit-form-desc", "form-desc", t).flex_none())
        .child(h_flex().flex_none().gap(8).items_end()
          .child(v_flex().flex_1().min_w(0).gap(4).child(label("Tools", "optional · empty = every tool")).child(this.input(f.toolsIn, "toolkit-form-tools", "form-tools", t).flex_none()))
          .child(v_flex().w(120).flex_none().gap(4).child(label("Model", "Claude only")).child(this.input(f.modelIn, "toolkit-form-model", "form-model", t).flex_none())))
        .child(div().flex_none().text_size(10.5).text_color(t.dim).child("Tools limit what the agent may do, in Claude's names (like Read, Grep, Bash). OpenCode and Antigravity get the same limit in their own names; a grant they have no name for is left out, never widened."))
        .child(label("Instructions", "what the agent does and how"))
        .child(v_flex().id("toolkit-form-body").flex_1().min_h(120).rounded(7).border_1().border_color(this.typing === "form-body" ? t.accent : t.border).overflow_hidden()
          .on_key_down((e, cx) => { if (e.keystroke === "cmd-s") { this.saveForm(cx); cx.stop_propagation(); } })
          .child(Editor.new(f.bodyEd).flex_1().min_h(0))))
      .child(div().flex_none().px(12).py(6).text_size(11).text_color(f.error ? t.ansi1 : t.dim).child(f.error ?? (problem || "Ready to save")))
      .child(f.askDiscard
        ? h_flex().flex_none().px(10).py(8).gap(8).items_center().border_t(1).border_color(t.border).bg(t.raised)
            .child(div().flex_1().min_w(0).text_size(12).child("Throw away what you typed?"))
            .child(this.button("toolkit-form-keep", "Keep editing", "plain", true, (cx) => this.keepEditing(cx), t))
            .child(this.button("toolkit-form-discard", "Discard", "danger", true, (cx) => this.cancelForm(cx), t))
        : h_flex().flex_none().px(10).py(8).gap(8).justify_end().border_t(1).border_color(t.border).bg(t.raised)
            .child(this.button("toolkit-form-cancel", "Cancel", "plain", !f.busy, (cx) => this.cancelForm(cx), t))
            .child(this.button("toolkit-form-save", f.busy ? "Saving…" : "Save", "primary", !f.busy && !problem, (cx) => this.saveForm(cx), t)));
  }

  // A catalog agent, shown in full before it is added: where it comes from, what the scan found, what is kept, what is not, and its instructions.
  reviewScreen(t) {
    const r = this.review, g = r.got, m = mapTools(g.tools), line = (k, v, color = t.foreground) => h_flex().flex_none().gap(8).items_baseline().child(div().flex_none().w(78).text_size(11).text_color(t.dim).child(k)).child(div().flex_1().min_w(0).text_size(11.5).text_color(color).child(v));
    const risky = r.entry.risk && r.entry.risk !== "SAFE";
    const lost = [m.droppedOpencode.length && g.tools ? `OpenCode cannot carry ${m.droppedOpencode.join(", ")}` : "", m.droppedAntigravity.length && g.tools ? `Antigravity cannot carry ${m.droppedAntigravity.join(", ")}` : "", g.model ? `the model (${g.model}) is for Claude only` : ""].filter(Boolean);
    return v_flex().flex_1().min_h(0)
      .child(h_flex().flex_none().px(10).py(8).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_semibold().child(`Review agent “${g.name}”`))
        .child(div().flex_none().text_size(11).text_color(t.dim).child("nothing is added yet")))
      .child(v_flex().id("toolkit-review-meta").flex_none().max_h(220).overflow_y_scrollbar().px(12).py(8).gap(4).border_b(1).border_color(t.border)
        .child(line("From", `aitmpl.com catalog · ${CATALOG_REPO} at commit ${r.sha.slice(0, 10)} · ${r.entry.path}`))
        .child(line("Scan", r.entry.risk ? `${r.entry.risk}${r.entry.findings.length ? "" : ""}` : "none in the catalog", risky ? t.ansi1 : t.foreground))
        .children(r.entry.findings.map((f) => line("", f, t.dim)))
        .child(line("Tools", g.tools || "every tool (no limit)"))
        .child(line("Model", g.model || "the default"))
        .children(lost.map((x) => line("Not carried", x, t.dim)))
        .child(line("Description", g.description, t.dim)))
      .child(div().flex_none().px(12).pt(8).pb(4).text_size(11.5).font_semibold().child("Instructions (this is what steers the agent)"))
      .child(v_flex().id("toolkit-review-body").flex_1().min_h(120).mx(12).mb(8).rounded(7).border_1().border_color(t.border).overflow_hidden().child(Editor.new(r.editor).flex_1().min_h(0)))
      .child(h_flex().flex_none().px(10).py(8).gap(8).items_center().border_t(1).border_color(t.border).bg(t.raised)
        .child(div().flex_1().min_w(0).text_size(11).text_color(t.dim).child(risky ? "The catalog's own scan did not rate this SAFE: read the instructions first." : "Added to the shelf only; turning it on is a separate step."))
        .child(this.button("toolkit-review-back", "Back", "plain", !this.applying, (cx) => this.closeReview(cx), t))
        .child(this.button("toolkit-review-add", this.applying ? "Adding…" : "Add to shelf", risky ? "danger" : "primary", !this.applying, (cx) => this.addReviewed(cx), t)));
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx, true);
    const t = theme(), mode = this.mode, lists = !mode;
    const name = this.root?.split("/").pop() ?? "", n = this.staged.size, sel = this.selected();
    const agentNames = sel.map((k) => AGENTS.find((a) => a.key === k).label).join(", ");
    const count = (sets, list) => list.filter((x) => this.full(sets, x)).length;
    const nSkills = count(this.active, this.master.map((m) => m.name)), nAgents = count(this.agentOn, this.agentShelf.map((m) => m.name)), nMcp = count(this.mcpOn, Object.keys(this.registry));
    const pluginsLoaded = this.pluginsFor === this.context;
    const counts = {
      skills: nSkills, agents: nAgents, mcp: nMcp,
      plugins: pluginsLoaded ? this.plugins.filter((p) => this.agents.has(p.agent) && p.enabled).length : null,
      hooks: this.hooks.filter((h) => this.agents.has(h.agent) && h.enabled).length,
    };
    const L = lists ? this.listFor(t) : null;
    const strip = lists && (this.tab === "skills" || this.tab === "mcp") ? this.updateStrip(t) : null;
    const showEmpty = lists && (Boolean(this.error) || this.unsafe || !L.rows.length);
    const emptyText = !lists ? "" : this.error || (this.unsafe ? "Open a project folder: HOME and / are not managed" : this.loading && !L.total ? "Loading…" : this.query && L.total ? "Nothing matches" : L.empty);
    const messages = mode === "form" || mode === "review" ? [] : [
      lists && this.problems.length ? div().px(10).py(6).text_size(11).text_color(t.ansi1).child(this.problems.join(" · ")) : null,
      this.notice ? div().px(10).py(6).text_size(11).text_color(t.ansi2).child(this.notice) : null,
      this.note ? div().px(10).py(6).text_size(11).text_color(t.ansi1).child(this.note) : null,
    ].filter(Boolean);
    const foot = (text) => div().flex_none().px(12).py(7).border_t(1).border_color(t.border).text_size(11).text_color(t.dim).truncate().child(text);
    const summary = {
      skills: `${nSkills} skills in ${name || "this folder"} for ${agentNames} · agents read them on their next start`,
      agents: `${nAgents} agents in ${name || "this folder"} for ${agentNames} · agents read them on their next start`,
      mcp: `${nMcp} MCP in ${name || "this folder"} for ${agentNames} · agents read them on their next start`,
      plugins: `${counts.plugins ?? 0} plugins on for ${agentNames} · an agent picks up plugin changes when it restarts`,
      hooks: `${counts.hooks} hooks active for ${agentNames} · read from settings files, never written here`,
    };
    const bottom = this.confirm
      ? (this.confirm.kind === "update" ? this.updateBar(t) : this.confirm.kind === "uninstall" ? this.uninstallBar(t) : this.confirm.kind === "hook-add" ? this.hookAddBar(t) : this.confirm.kind === "hook-remove" ? this.hookRemoveBar(t) : this.confirm.kind === "install" ? this.installBar(t) : this.deleteBar(t))
      : n > 0 && lists
      ? h_flex().flex_none().px(10).py(8).gap(8).items_center().border_t(1).border_color(t.border).bg(t.raised)
          .child(div().flex_1().min_w(0).truncate().text_size(12).child(`${plural(n, "change")} for ${name || "this folder"}${[...this.staged.keys()].every((k) => k.startsWith("p:")) ? "" : ` · ${agentNames}`}`))
          .child(this.button("toolkit-cancel", "Cancel", "plain", !this.applying, (cx) => { this.staged.clear(); cx.notify(); }, t))
          .child(this.button("toolkit-apply", this.applying ? "Applying…" : "Apply", "primary", !this.applying, (cx) => this.apply(cx), t))
      : mode === "find" ? foot("Results come from skills.sh, the MCP registry, aitmpl.com, Claude's marketplaces and npm")
      : lists ? foot(summary[this.tab]) : null;
    const body = mode === "find" ? this.findScreen(t) : mode === "form" ? this.formScreen(t) : mode === "review" ? this.reviewScreen(t) : mode === "import" ? this.importScreen(t) : this.listScreen(t, L, counts, strip, showEmpty, emptyText);
    return v_flex().id("toolkit").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(this.header(t))
      .child(body)
      .children(messages)
      .when(Boolean(this.ignoreAsk) && lists && !this.confirm, (e) => e.child(this.ignoreBar(t)))
      .when(Boolean(bottom) && mode !== "form" && mode !== "review", (e) => e.child(bottom));
  }

  findScreen(t) {
    const kinds = [["all", "Everything"], ["skills", "Skills"], ["agents", "Agents"], ["mcp", "MCP"], ["plugins", "Plugins"], ["hooks", "Hooks"]];
    return v_flex().flex_1().min_h(0)
      .child(h_flex().flex_none().p(10).gap(8).items_center().border_b(1).border_color(t.border)
        .child(this.input(this.finder, "toolkit-find", "find", t))
        .child(this.button("toolkit-search", this.found.state === "loading" ? "…" : "Search", "primary", this.found.state !== "loading", (cx) => this.search(cx), t)))
      .child(h_flex().flex_none().px(10).py(7).gap(4).items_center().flex_wrap().border_b(1).border_color(t.border)
        .child(div().text_size(11).text_color(t.dim).child("Search"))
        .children(kinds.map(([k, label]) => h_flex().id(`find-${k}`).h(26).px(9).items_center().rounded(6).cursor_pointer().text_size(12).bg(this.findKind === k ? t.selected : t.background).text_color(this.findKind === k ? t.foreground : t.muted)
          .hover((x) => x.bg(t.hover)).on_click((_e, cx) => this.setFindKind(k, cx)).child(label))))
      .child(v_flex().id("toolkit-list").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.findRows(t)));
  }

  // Tabs, the filter (with what the tab can do next to it), the agent chips with their numbers, one sentence on the tab, then the list.
  listScreen(t, L, counts, strip, showEmpty, emptyText) {
    const filtering = Boolean(this.query);
    return v_flex().flex_1().min_h(0)
      .child(v_flex().flex_none().border_b(1).border_color(t.border)
        .child(h_flex().flex_none().px(10).pt(10).pb(6).gap(4).items_center().flex_wrap().children(TABS.map((x) => this.pill(`tab-${x.key}`, x.label, counts[x.key], x.key, t))))
        .child(h_flex().flex_none().px(10).pb(8).gap(8).items_center()
          .child(this.input(this.filter, "toolkit-filter", "filter", t))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(filtering ? `${L.shown} of ${L.total}` : plural(L.total, L.noun)))
          .when(this.tab === "agents", (e) => e.child(this.button("toolkit-new-agent", "New", "plain", !this.applying && !this.confirm, (cx) => this.newAgent(cx), t))
            .child(this.button("toolkit-import-agent", "Import", "plain", !this.applying && !this.confirm && Boolean(this.root) && !this.unsafe, (cx) => this.openImport(cx), t))))
        .child(h_flex().flex_none().px(10).pb(7).gap(6).items_center().flex_wrap()
          .child(div().text_size(11).text_color(t.dim).child(this.tab === "plugins" || this.tab === "hooks" ? "Showing" : "For"))
          .children(AGENTS.map((a) => this.agentChip(a, t))))
        .child(div().flex_none().px(12).pb(8).text_size(11).text_color(t.dim).child(this.infoText())))
      .when(Boolean(strip), (e) => e.child(strip))
      .child(v_flex().id("toolkit-list").flex_1().min_h(0).overflow_y_scrollbar().p(6)
        .children(L.notes.map((n) => div().flex_none().px(8).py(3).text_size(11).text_color(t.dim).child(n)))
        .children(L.rows)
        .when(showEmpty, (e) => e.child(div().p(8).text_size(12).text_color(t.dim).child(emptyText))));
  }
}
