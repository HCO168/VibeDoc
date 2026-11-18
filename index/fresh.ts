// Freshness ledger and AI index.
//
// Every piece of descriptive text is recorded together with a hash of what it describes:
//   function comment (`///`)   ← the function body
//   AI index line (role/note)  ← the source file
//   behavior/contract section  ← each item it lists in `<!-- refs: ... -->` (feature/rule/table ids, functions, files, tables)
// When the described thing changes and the text does not, the text is stale. Text that changed together with
// its subject counts as updated, so recording (`sync`) never hides staleness. The ledger is committed:
// <index.dir>/ledger.json, one entry per line so parallel branches merge cleanly.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { Config } from "../config.ts";
import { buildModel, globToRegExp, loadModules, type FnNode, type Model } from "../codemap/model.ts";
import { RuleStore, kindsFor } from "../rules/store.ts";

export const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 10);
const norm = (s: string) => s.replace(/\r/g, "").replace(/[ \t]+$/gm, "").trim();

// ---------- ledger ----------

export type Skip = { date: string; item: string; reason: string; issues: string[] };
export type Ledger = {
  fns: Record<string, string>; // function id → "<body>:<comment>"; comment "-" = confirmed as fine without one
  files: Record<string, string>; // source path → "<file>:<role+note>"
  sections: Record<string, Record<string, string>>; // "<doc>#<heading>" → { "": text, <ref>: subject }
  skips: Skip[];
};

export function ledgerFile(root: string, cfg: Config) {
  return join(root, cfg.index!.dir, "ledger.json");
}

export function readLedger(root: string, cfg: Config): Ledger {
  const file = ledgerFile(root, cfg);
  const raw = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  return { fns: raw.fns ?? {}, files: raw.files ?? {}, sections: raw.sections ?? {}, skips: raw.skips ?? [] };
}

export function writeLedger(root: string, cfg: Config, ledger: Ledger) {
  const map = (o: Record<string, unknown>) => {
    const keys = Object.keys(o).sort();
    return keys.length ? `{\n${keys.map((k) => `    ${JSON.stringify(k)}: ${JSON.stringify(o[k])}`).join(",\n")}\n  }` : "{}";
  };
  const skips = ledger.skips.length ? `[\n${ledger.skips.map((s) => `    ${JSON.stringify(s)}`).join(",\n")}\n  ]` : "[]";
  const text = `{\n  "version": 1,\n  "fns": ${map(ledger.fns)},\n  "files": ${map(ledger.files)},\n  "sections": ${map(ledger.sections)},\n  "skips": ${skips}\n}\n`;
  mkdirSync(dirname(ledgerFile(root, cfg)), { recursive: true });
  writeFileSync(ledgerFile(root, cfg), text);
}

const pair = (v: string | undefined): [string, string] | null => {
  if (!v) return null;
  const i = v.indexOf(":");
  return [v.slice(0, i), v.slice(i + 1)];
};

// fresh: text matches its subject; stale: subject changed, text did not; new: never recorded.
export type State = "fresh" | "stale" | "new";
function judge(rec: [string, string] | null, subject: string, text: string): State {
  if (!rec) return "new";
  if (rec[0] === subject) return "fresh";
  return rec[1] !== text ? "fresh" : "stale";
}

// ---------- the scanned state of a repository ----------

export type FnState = {
  id: string; key: string; file: string; line: number; endLine: number; module: string; docs: string;
  body: string; comment: string;
  // bare: no comment; for bare functions `confirmed` says the current body was explicitly accepted without one.
  state: State | "bare"; confirmed: boolean; changed: boolean;
};
export type Entry = {
  path: string; module: string; layer: string;
  role: string; note: string;
  uses: string[]; api: string[]; reads: string[]; writes: string[]; defines: string[];
  file: string; text: string; state: State | "blank";
};
export type RefState = { ref: string; kind: "item" | "fn" | "file" | "dir" | "table" | "missing"; target: string; hash: string | null };
export type Section = {
  key: string; doc: string; heading: string; line: number; refs: RefState[]; text: string;
  state: State; changed: string[];
};
export type Scan = {
  model: Model;
  ledger: Ledger;
  fns: Map<string, FnState>;
  entries: Map<string, Entry>;
  sections: Section[];
  items: Map<string, { id: string; hash: string; title: string; module: string; kind: string; status: string; impl: string[] }>;
  modules: { id: string; title: string; role: string }[];
  resolveRef: (ref: string) => RefState;
};

// role/note the AI wrote in <dir>/<module>.txt, by source path.
function readWritten(root: string, cfg: Config): Map<string, { role: string; note: string }> {
  const out = new Map<string, { role: string; note: string }>();
  const dir = join(root, cfg.index!.dir);
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".txt") && n !== "INDEX.txt")) {
    for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
      const m = /^(\S+) \[[^\]]*\] (.*)$/.exec(line);
      if (!m) continue;
      const fields: Record<string, string> = {};
      for (const part of m[2].split(" | ")) {
        const f = /^(\w+): ?(.*)$/.exec(part);
        if (f) fields[f[1]] = f[2].trim();
      }
      const role = fields.role && fields.role !== "?" ? fields.role : "";
      out.set(m[1], { role, note: fields.note ?? "" });
    }
  }
  return out;
}

// The first prose paragraph of the module's feature document: one line saying what the module is.
function moduleRole(root: string, cfg: Config, id: string): string {
  const file = join(root, cfg.featuresDir, `${id}.md`);
  if (!existsSync(file)) return "";
  const para: string[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) {
      if (para.length) break;
      continue;
    }
    if (t.startsWith("#") || t.startsWith(">") || t.startsWith("<!--")) {
      if (para.length) break;
      continue;
    }
    para.push(t);
  }
  const text = para.join(" ");
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}

function walk(dir: string, skip: Set<string>, out: string[] = []): string[] {
  if (!existsSync(dir) || skip.has(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, skip, out);
    else if (name.endsWith(".md") && name !== "README.md" && name !== "AGENTS.md") out.push(p);
  }
  return out;
}

const REFS_RE = /<!--\s*refs:\s*(.*?)\s*-->/;
// A top-level `const`/`static` item; group 1 is set when it is public.
const CONST_RE = /^(pub(?:\([^)]*\))?\s+)?(?:const|static)\s+(?:mut\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*:/gm;

// Every file under a directory, relative to the repository root, for directory references.
function filesUnder(root: string, dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(root, dir)).sort()) {
    if (name.startsWith(".") || name === "node_modules" || name === "target") continue;
    const rel = `${dir}/${name}`;
    if (statSync(join(root, rel)).isDirectory()) filesUnder(root, rel, out);
    else out.push(rel);
  }
  return out;
}

export function scan(root: string, cfg: Config, model = buildModel(root, cfg)): Scan {
  if (!cfg.index) throw new Error("这个仓库没有启用 AI 索引：在 vibedoc.config.json 里加上 \"index\": {}（需要同时启用 codemap）。");
  const ledger = readLedger(root, cfg);
  const sources = new Map<string, string>();
  const source = (path: string) => {
    let text = sources.get(path);
    if (text === undefined) {
      text = existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : "";
      sources.set(path, text);
    }
    return text;
  };

  // Functions.
  const fns = new Map<string, FnState>();
  const byKey = new Map<string, string[]>();
  for (const n of model.fns.values()) {
    const lines = source(n.file).split("\n");
    const body = hash(norm(lines.slice(n.fn.line - 1, n.fn.endLine).join("\n")));
    const comment = n.fn.docs.trim() ? hash(norm(n.fn.docs)) : "";
    const rec = pair(ledger.fns[n.id]);
    const changed = !rec || rec[0] !== body;
    const confirmed = !!rec && rec[0] === body && rec[1] === "-";
    const state = comment ? judge(rec && [rec[0], rec[1] === "-" ? "" : rec[1]], body, comment) : "bare";
    fns.set(n.id, { id: n.id, key: n.key, file: n.file, line: n.fn.line, endLine: n.fn.endLine, module: n.module, docs: n.fn.docs, body, comment, state, confirmed, changed });
    byKey.set(n.key, [...(byKey.get(n.key) ?? []), n.id]);
  }

  // Index entries: every Rust file with items and every scanned frontend file.
  const { modules: defs, shared } = loadModules(root, cfg);
  const matchers = defs.map((m) => ({ id: m.id, backend: m.backend.map(globToRegExp), frontend: m.frontend.map(globToRegExp) }));
  const fileModule = (rel: string, layer: "backend" | "frontend") => shared.get(rel) ?? matchers.find((m) => m[layer].some((re) => re.test(rel)))?.id ?? "platform";
  const written = readWritten(root, cfg);
  const fnsOfFile = new Map<string, FnNode[]>();
  for (const n of model.fns.values()) fnsOfFile.set(n.file, [...(fnsOfFile.get(n.file) ?? []), n]);
  const typesOfFile = new Map<string, string[]>();
  for (const t of model.types) if (t.type.vis === "pub") typesOfFile.set(t.file, [...(typesOfFile.get(t.file) ?? []), t.type.name]);
  // Rust files with neither functions nor public types still get a line when they declare constants or statics
  // (permission tables, limits); files that only declare modules or re-export stay out.
  const constsOfFile = new Map<string, string[]>();
  for (const path of model.rustFiles) {
    if (fnsOfFile.has(path) || typesOfFile.has(path)) continue;
    const names = [...source(path).matchAll(CONST_RE)];
    if (names.length) constsOfFile.set(path, names.filter((m) => m[1]).map((m) => m[2]));
  }
  const paths = [...new Set([...fnsOfFile.keys(), ...typesOfFile.keys(), ...constsOfFile.keys(), ...model.front.keys()])].sort();
  const short = shortNames(paths);
  const cap = (xs: string[], n: number) => (xs.length > n ? [...xs.slice(0, n), `+${xs.length - n}`] : xs);
  const entries = new Map<string, Entry>();
  for (const path of paths) {
    const front = model.front.get(path);
    const own = fnsOfFile.get(path) ?? [];
    let layer = "frontend";
    const uses = new Set<string>();
    const api = new Set<string>();
    const reads = new Set<string>();
    const writes = new Set<string>();
    let defines: string[] = [];
    if (front) {
      for (const f of front.imports) uses.add(short.get(f) ?? f);
      for (const cf of front.parsed.clientFns) for (const c of cf.calls) api.add(`${c.method ?? "GET"} ${c.path}`);
      for (const c of front.parsed.looseCalls) api.add(`${c.method ?? "GET"} ${c.path}`);
      defines = front.parsed.exports;
    } else {
      const counts = new Map<string, number>();
      for (const n of own) counts.set(n.layer, (counts.get(n.layer) ?? 0) + 1);
      layer = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "types";
      for (const n of own) {
        for (const c of n.callees) {
          const f = model.fns.get(c)?.file;
          if (f && f !== path) uses.add(short.get(f) ?? f);
        }
        for (const r of n.handlerOf) api.add(r.id);
        for (const [t, w] of n.tables) (w ? writes : reads).add(t);
      }
      for (const w of writes) reads.delete(w);
      defines = [...own.filter((n) => n.fn.vis === "pub").map((n) => n.fn.name), ...(typesOfFile.get(path) ?? []), ...(constsOfFile.get(path) ?? [])];
    }
    const mine = written.get(path) ?? { role: "", note: "" };
    const file = hash(source(path));
    const text = mine.role || mine.note ? hash(`${mine.role}\n${mine.note}`) : "";
    const module = front ? (front.module ?? "platform") : fileModule(path, "backend");
    entries.set(path, {
      path, module, layer, role: mine.role, note: mine.note,
      uses: cap([...uses].sort(), 12), api: cap([...api].sort(), 12), reads: cap([...reads].sort(), 12), writes: cap([...writes].sort(), 12), defines: cap([...new Set(defines)], 12),
      file, text, state: text ? judge(pair(ledger.files[path]), file, text) : "blank",
    });
  }

  // Feature, rule and table-request items.
  const kinds = kindsFor(cfg);
  const items: Scan["items"] = new Map();
  for (const kind of [kinds.rules, kinds.features, kinds.tables]) {
    const store = new RuleStore(root, new Map(), kind);
    for (const it of store.all()) if (it.id) items.set(it.id, { id: it.id, hash: it.hash, title: it.title, module: it.module, kind: kind.tag, status: it.effective, impl: it.meta?.impl ?? [] });
  }

  const resolveFn = (ref: string): string | null => {
    const r = ref.replace(/^fn:/, "");
    if (model.fns.has(r)) return r;
    const ids = byKey.get(r);
    if (ids?.length === 1) return ids[0];
    const tail = [...model.fns.values()].filter((n) => n.id.endsWith(`::${r}`));
    return tail.length === 1 ? tail[0].id : null;
  };
  const resolveRef = (ref: string): RefState => {
    const item = items.get(ref);
    if (item) return { ref, kind: "item", target: ref, hash: item.hash };
    if (ref.startsWith("table:")) {
      const name = ref.slice(6).toLowerCase();
      const key = model.schema.tables.has(name) ? name : [...model.schema.tables.keys()].find((k) => k.endsWith(`.${name}`));
      const t = key ? model.schema.tables.get(key) : undefined;
      return t ? { ref, kind: "table", target: key!, hash: hash(JSON.stringify(t.columns)) } : { ref, kind: "missing", target: ref, hash: null };
    }
    if (ref.includes("/") && !ref.includes("::")) {
      const rel = ref.replace(/\/+$/, "");
      const p = join(root, rel);
      if (!existsSync(p)) return { ref, kind: "missing", target: ref, hash: null };
      if (statSync(p).isFile()) return { ref, kind: "file", target: rel, hash: hash(source(rel)) };
      // A directory: its file list and every file's content, so adding, removing or editing a file changes it.
      const files = filesUnder(root, rel);
      return { ref, kind: "dir", target: rel, hash: hash(files.map((f) => `${f}\n${hash(source(f))}`).join("\n")) };
    }
    const id = resolveFn(ref);
    return id ? { ref, kind: "fn", target: id, hash: fns.get(id)!.body } : { ref, kind: "missing", target: ref, hash: null };
  };

  // Behavior and contract sections that declare refs.
  const sections: Section[] = [];
  // History never describes current code: change logs, deployment records, expired documents and the index itself
  // are skipped even when they sit inside a scanned directory.
  const skip = new Set([cfg.docs.changelogs, cfg.docs.deploylogs, cfg.docs.expired, cfg.index!.dir].map((d) => join(root, d)));
  for (const dir of [cfg.docs.behavior, ...cfg.docs.contracts]) {
    for (const abs of walk(join(root, dir), skip)) {
      const doc = relative(root, abs);
      const lines = readFileSync(abs, "utf8").split("\n");
      const seen = new Map<string, number>();
      const heads: { i: number; title: string }[] = [];
      let fence = false;
      lines.forEach((l, i) => {
        if (/^\s*```/.test(l)) fence = !fence;
        const m = !fence && /^#{1,3}\s+(.+?)\s*$/.exec(l);
        if (m) heads.push({ i, title: m[1] });
      });
      heads.forEach((hd, k) => {
        const body = lines.slice(hd.i + 1, heads[k + 1]?.i ?? lines.length);
        const refLine = body.find((l) => REFS_RE.test(l));
        if (!refLine) return;
        const n = (seen.get(hd.title) ?? 0) + 1;
        seen.set(hd.title, n);
        const key = `${doc}#${hd.title}${n > 1 ? `#${n}` : ""}`;
        const refs = REFS_RE.exec(refLine)![1].split(/[\s,]+/).filter(Boolean).map(resolveRef);
        const text = hash(norm(body.filter((l) => !REFS_RE.test(l)).join("\n")));
        const rec = ledger.sections[key];
        let state: State = "fresh";
        const changed: string[] = [];
        if (!rec) state = "new";
        else if (rec[""] === text) {
          for (const r of refs) if (r.hash && rec[r.ref] && rec[r.ref] !== r.hash) changed.push(r.ref);
          if (changed.length) state = "stale";
        }
        sections.push({ key, doc, heading: hd.title, line: hd.i + 1, refs, text, state, changed });
      });
    }
  }

  const modules = model.modules.map((m) => ({ id: m.id, title: m.title, role: moduleRole(root, cfg, m.id) }));
  return { model, ledger, fns, entries, sections, items, modules, resolveRef };
}

// Shortest trailing path that still names one file: `drive/service.rs` instead of the full path.
function shortNames(paths: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const parts = new Map(paths.map((p) => [p, p.split("/")]));
  for (const p of paths) {
    const segs = parts.get(p)!;
    for (let n = 1; n <= segs.length; n++) {
      const tail = segs.slice(-n).join("/");
      if (paths.filter((q) => q === tail || q.endsWith(`/${tail}`)).length === 1) {
        out.set(p, tail);
        break;
      }
    }
    if (!out.has(p)) out.set(p, p);
  }
  return out;
}

// Whether a reference points at a source file: the file itself, a directory holding it, or one of its functions.
export function refersTo(s: Scan, r: RefState, path: string): boolean {
  if (r.kind === "file") return r.target === path;
  if (r.kind === "dir") return path.startsWith(`${r.target}/`);
  return r.kind === "fn" && s.fns.get(r.target)?.file === path;
}

// ---------- recording ----------

// Record everything that is not stale: new items get their first record, updated items their new one.
export function sync(s: Scan) {
  const { ledger } = s;
  for (const f of s.fns.values()) {
    if (f.state === "stale") continue;
    ledger.fns[f.id] = `${f.body}:${f.comment || (f.confirmed ? "-" : "")}`;
  }
  for (const e of s.entries.values()) if (e.state !== "stale") ledger.files[e.path] = `${e.file}:${e.text}`;
  for (const sec of s.sections) {
    if (sec.state === "stale") continue;
    const rec: Record<string, string> = { "": sec.text };
    for (const r of sec.refs) if (r.hash) rec[r.ref] = r.hash;
    ledger.sections[sec.key] = rec;
  }
  // Forget what no longer exists.
  for (const id of Object.keys(ledger.fns)) if (!s.fns.has(id)) delete ledger.fns[id];
  for (const p of Object.keys(ledger.files)) if (!s.entries.has(p)) delete ledger.files[p];
  const keys = new Set(s.sections.map((x) => x.key));
  for (const k of Object.keys(ledger.sections)) if (!keys.has(k)) delete ledger.sections[k];
}

// Confirm that a piece of text still matches its subject although only the subject changed.
// target: a function (id or `file::name` key), a source path (its index line) or `<doc>#<heading>`.
export function ack(s: Scan, target: string): string {
  const sec = s.sections.find((x) => x.key === target || `${x.doc}#${x.heading}` === target);
  if (sec) {
    const rec: Record<string, string> = { "": sec.text };
    for (const r of sec.refs) if (r.hash) rec[r.ref] = r.hash;
    s.ledger.sections[sec.key] = rec;
    sec.state = "fresh";
    return `小节 ${sec.key}`;
  }
  const entry = s.entries.get(target);
  if (entry) {
    if (!entry.role) throw new Error(`${target} 还没有 role，先在 ${entry.module}.txt 里写上职责再确认`);
    s.ledger.files[target] = `${entry.file}:${entry.text}`;
    entry.state = "fresh";
    return `索引 ${target}`;
  }
  const r = s.resolveRef(target);
  if (r.kind === "fn") {
    const f = s.fns.get(r.target)!;
    s.ledger.fns[f.id] = `${f.body}:${f.comment || "-"}`;
    f.state = f.comment ? "fresh" : "bare";
    f.confirmed = !f.comment;
    return `函数 ${f.key}`;
  }
  throw new Error(`找不到 ${target}：可以是函数（编号或 文件::函数名）、源码路径或 文档路径#标题`);
}

// ---------- the index files ----------

export function entryLine(e: Entry): string {
  const parts = [`role: ${e.role || "?"}`];
  for (const f of ["uses", "api", "reads", "writes", "defines"] as const) if (e[f].length) parts.push(`${f}: ${e[f].join(", ")}`);
  if (e.note) parts.push(`note: ${e.note}`);
  if (e.state === "stale") parts.push("state: stale");
  return `${e.path} [${e.layer}] ${parts.join(" | ")}`;
}

export function counts(s: Scan, module?: string) {
  const inMod = <T extends { module: string }>(xs: Iterable<T>) => [...xs].filter((x) => !module || x.module === module);
  const entries = inMod(s.entries.values());
  const fns = inMod(s.fns.values());
  const sections = module ? [] : s.sections;
  return {
    files: entries.length,
    blank: entries.filter((e) => e.state === "blank").length,
    staleEntries: entries.filter((e) => e.state === "stale").length,
    staleFns: fns.filter((f) => f.state === "stale").length,
    bareChanged: fns.filter((f) => f.state === "bare" && f.changed && !f.confirmed).length,
    staleSections: sections.filter((x) => x.state === "stale").length,
    broken: sections.reduce((n, x) => n + x.refs.filter((r) => r.kind === "missing").length, 0),
  };
}

export function writeIndex(root: string, cfg: Config, s: Scan): string[] {
  const dir = join(root, cfg.index!.dir);
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  const header = (title: string) => [
    `# ${title} — 由 \`vibedoc index generate\` 生成。只改 role 和 note（不要含 " | "），其余字段每次按代码重新生成。`,
    `# 格式：<路径> [layer] role 职责 | uses 依赖的文件 | api 接口 | reads/writes 读写的表 | defines 定义 | note 约束与坑 | state: stale = 代码变了而 role/note 没跟着更新`,
  ];
  for (const m of s.modules) {
    const entries = [...s.entries.values()].filter((e) => e.module === m.id);
    if (!entries.length) continue;
    const file = join(dir, `${m.id}.txt`);
    writeFileSync(file, [...header(`${m.title}（${m.id}）`), "", ...entries.map(entryLine), ""].join("\n"));
    written.push(relative(root, file));
  }
  const other = [...s.entries.values()].filter((e) => !s.modules.some((m) => m.id === e.module));
  if (other.length) {
    const file = join(dir, "platform.txt");
    writeFileSync(file, [...header("平台与未归属文件（platform）"), "", ...other.map(entryLine), ""].join("\n"));
    written.push(relative(root, file));
  }
  const all = counts(s);
  const lines = [
    `# ${cfg.name} AI 索引总览 — 由 \`vibedoc index generate\` 生成，不要手改。`,
    `# 先读这份，再按模块读 ${cfg.index!.dir}/<模块>.txt（每个源文件一行），需要精确调用关系时用 \`vibedoc codemap fn|route\`。`,
    `# 过期：函数注释 ${all.staleFns}，索引行 ${all.staleEntries}，文档小节 ${all.staleSections}，失效引用 ${all.broken}；未写 role 的文件 ${all.blank}/${all.files}。明细：\`vibedoc index stale\`。`,
    "",
  ];
  for (const m of s.modules) {
    const c = counts(s, m.id);
    if (!c.files && !m.role) continue;
    const stale = c.staleEntries + c.staleFns;
    lines.push(`module ${m.id} [${m.title}] files: ${c.files}${stale ? ` | stale: ${stale}` : ""}${c.blank ? ` | blank: ${c.blank}` : ""}${m.role ? ` | role: ${m.role}` : ""}`);
  }
  if (other.length) lines.push(`module platform [平台与未归属] files: ${other.length}`);
  lines.push("");
  writeFileSync(join(dir, "INDEX.txt"), lines.join("\n"));
  written.push(relative(root, join(dir, "INDEX.txt")));
  return written;
}

// ---------- completion gate ----------

// What still has to be updated before `id` may be marked done. `impl` lists the functions or source
// files that implement it (as recorded with --impl).
export function gateIssues(s: Scan, id: string, impl: string[]): string[] {
  const issues: string[] = [];
  if (!s.items.has(id)) return [`找不到条目 ${id}`];
  if (!impl.length) issues.push(`没有记录实现位置：用 --impl 列出实现它的函数（文件::函数名）或源码文件`);
  const fnIds = new Set<string>();
  const files = new Set<string>();
  for (const ref of impl) {
    const r = s.resolveRef(ref);
    if (r.kind === "fn") {
      fnIds.add(r.target);
      files.add(s.fns.get(r.target)!.file);
    } else if (r.kind === "file") files.add(r.target);
    else issues.push(`实现位置 ${ref} 找不到（函数写成 文件::函数名，或写源码路径）`);
  }
  for (const fid of fnIds) {
    const f = s.fns.get(fid)!;
    if (f.state === "stale") issues.push(`函数注释待更新：${f.key}（${f.file}:${f.line}），函数改了而 /// 没改；仍准确就 \`vibedoc index ack ${f.key}\``);
    else if (f.state === "bare" && !f.confirmed) issues.push(`函数缺注释：${f.key}（${f.file}:${f.line}），补 /// 一句话说明；名字已说明一切就 \`vibedoc index ack ${f.key}\``);
  }
  for (const p of files) {
    const e = s.entries.get(p);
    if (!e) continue;
    if (e.state === "blank") issues.push(`索引行缺 role：${p}，在 ${e.module}.txt 里写上这个文件的职责`);
    else if (e.state === "stale") issues.push(`索引行待更新：${p}，文件改了而 role/note 没改；仍准确就 \`vibedoc index ack ${p}\``);
  }
  const related = s.sections.filter((x) => x.refs.some((r) => r.ref === id || (r.kind === "fn" && fnIds.has(r.target)) || [...files].some((f) => refersTo(s, r, f))));
  if (!related.some((x) => x.refs.some((r) => r.ref === id))) {
    issues.push(`没有行为文档小节引用 ${id}：在描述这项行为的小节标题下加一行 <!-- refs: ${id} ${impl.slice(0, 2).join(" ")} -->`);
  }
  for (const x of related) {
    if (x.state === "stale") issues.push(`行为文档待更新：${x.key}（${x.doc}:${x.line}），引用的 ${x.changed.join("、")} 变了而正文没改；仍准确就 \`vibedoc index ack "${x.key}"\``);
    for (const r of x.refs) if (r.kind === "missing") issues.push(`失效引用：${x.key} 引用的 ${r.ref} 不存在`);
  }
  return issues;
}

export function recordSkip(s: Scan, id: string, reason: string, issues: string[]) {
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  s.ledger.skips.push({ date, item: id, reason, issues });
}


// ---------- board data ----------

// Everything the board's document and code browser lists, without the hashes.
export function browserJson(s: Scan) {
  const place = (r: RefState) => {
    if (r.kind === "fn") {
      const f = s.fns.get(r.target)!;
      return { file: f.file, line: f.line };
    }
    return { file: r.kind === "file" || r.kind === "dir" ? r.target : null, line: null };
  };
  return {
    counts: counts(s),
    modules: s.modules.map((m) => ({ ...m, counts: counts(s, m.id) })),
    entries: [...s.entries.values()].map(({ file: _f, text: _t, ...e }) => e),
    sections: s.sections.map((x) => ({ key: x.key, doc: x.doc, heading: x.heading, line: x.line, state: x.state, changed: x.changed, refs: x.refs.map((r) => ({ ref: r.ref, kind: r.kind, target: r.target, ...place(r) })) })),
    staleFns: [...s.fns.values()].filter((f) => f.state === "stale").map((f) => ({ id: f.id, key: f.key, file: f.file, line: f.line, module: f.module })),
    items: [...s.items.values()].map(({ hash: _h, ...it }) => ({ ...it, impl: it.impl.map((ref) => {
      const r = s.resolveRef(ref);
      return { ref, missing: r.kind === "missing", fn: r.kind === "fn" ? r.target : null, ...place(r) };
    }) })),
  };
}

// One source file for the browser: its text, functions with their comment state, and its index line.
// Only files that are in the index are served, so no other path on disk can be read through it.
export function fileJson(root: string, s: Scan, path: string) {
  const entry = s.entries.get(path);
  if (!entry) throw Object.assign(new Error("索引里没有这个文件"), { status: 404 });
  const { file: _f, text: _t, ...e } = entry;
  return {
    path,
    entry: e,
    text: readFileSync(join(root, path), "utf8"),
    fns: [...s.fns.values()].filter((f) => f.file === path).sort((a, b) => a.line - b.line)
      .map((f) => ({ id: f.id, key: f.key, line: f.line, endLine: f.endLine, docs: f.docs, state: f.state, confirmed: f.confirmed })),
    sections: s.sections.filter((x) => x.refs.some((r) => refersTo(s, r, path))).map((x) => ({ key: x.key, doc: x.doc, line: x.line, state: x.state })),
  };
}
