// Tracked documents, one file per module, one `### 标题` per item:
//   rules     <rulesDir>/<module>.md, `## 层` sections; the user owns the text.
//   features  <featuresDir>/<module>.md, free `## 分组` sections; the AI writes it, the user may edit it.
// Machine state lives in the two managed lines under each heading:
//   <!-- rule:<id> status=... h=... -->   machine state (values URI-encoded; `feature:` for features)
//   > <!--rule-badge--> ...                visible badge regenerated from the state
// Tools may only add, change or remove managed lines; `userText` must stay identical.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const LAYERS = ["frontend", "api", "backend", "database"] as const;
export type Layer = (typeof LAYERS)[number];
export const LAYER_NAMES: Record<Layer, string> = { frontend: "前端", api: "API", backend: "后端", database: "数据库" };
const LAYER_ALIASES: Record<string, Layer> = {
  前端: "frontend", frontend: "frontend",
  api: "api", 接口: "api",
  后端: "backend", backend: "backend",
  数据库: "database", database: "database", 数据: "database",
};
const layerOf = (heading: string): Layer | null => LAYER_ALIASES[heading.toLowerCase()] ?? LAYER_ALIASES[heading] ?? null;

export const STATUSES = ["new", "confirm", "doing", "done", "parked"] as const;
export type Status = (typeof STATUSES)[number];
export type Effective = Status | "modified";
export const STATUS_NAMES: Record<Effective, string> = {
  new: "新提出", confirm: "待你确认", doing: "进行中", modified: "已修改", done: "已实现", parked: "搁置",
};
const STATUS_ICON: Record<Effective, string> = { new: "⚪", confirm: "🟣", doing: "🔵", modified: "🟠", done: "🟢", parked: "⏸" };

export type DocKind = {
  tag: string;
  dir: string;
  statuses: readonly string[];
  names: Record<string, string>;
  icons: Record<string, string>;
  // Statuses that turn into "modified" once the text no longer matches the hash recorded with them.
  tracked: readonly string[];
  // Id infix: rules are `app-1`, features `app-f1`.
  idPart: string;
  layered: boolean;
  // Lines placed under the `#` title of a newly created file.
  intro: string;
};
export const RULES: DocKind = {
  tag: "rule", dir: "doc/rules", statuses: STATUSES, names: STATUS_NAMES, icons: STATUS_ICON,
  tracked: ["confirm", "doing", "done"], idPart: "", layered: true, intro: "",
};
export const FEATURE_STATUSES = ["new", "confirm", "doing", "done", "released", "parked"] as const;
export const FEATURES: DocKind = {
  tag: "feature", dir: "doc/features", statuses: FEATURE_STATUSES,
  names: { new: "新提出", confirm: "待你确认", doing: "开发中", modified: "已修改", done: "已持久化", released: "已上线", parked: "搁置" },
  icons: { new: "⚪", confirm: "🟣", doing: "🔵", modified: "🟠", done: "🟢", released: "🚀", parked: "⏸" },
  tracked: ["confirm", "doing", "done", "released"], idPart: "f", layered: false,
  intro: "> 功能与架构文档：只写这个模块做什么、怎么组成，不写代码细节。格式与状态见 `doc/features/README.md`。",
};
// The two kinds with the directories a repository configures.
export function kindsFor(cfg: { rulesDir: string; featuresDir: string }): { rules: DocKind; features: DocKind } {
  return {
    rules: { ...RULES, dir: cfg.rulesDir },
    features: { ...FEATURES, dir: cfg.featuresDir, intro: FEATURES.intro.replace("doc/features", cfg.featuresDir) },
  };
}

export type Meta = { id: string; status: string; h: string | null; target: string | null; date: string | null; impl: string[]; note: string | null };

export type RuleItem = {
  id: string | null;
  module: string;
  layer: Layer | null;
  section: string | null;
  title: string;
  body: string;
  hash: string;
  meta: Meta | null;
  status: string;
  effective: string;
  headingLine: number;
  endLine: number;
};

const patterns = new Map<string, { meta: RegExp; badge: RegExp }>();
const re = (kind: DocKind) => {
  let p = patterns.get(kind.tag);
  if (!p) {
    p = { meta: new RegExp(`^<!-- ${kind.tag}:(\\S+)((?:\\s+\\w+=\\S*)*)\\s*-->\\s*$`), badge: new RegExp(`^> <!--${kind.tag}-badge-->`) };
    patterns.set(kind.tag, p);
  }
  return p;
};
export const isManaged = (line: string, kind: DocKind = RULES) => re(kind).meta.test(line) || re(kind).badge.test(line);
// Blank-line runs are collapsed so that tools may keep one blank line between the badge and the text.
export const userText = (text: string, kind: DocKind = RULES) =>
  text
    .split("\n")
    .filter((l) => !isManaged(l, kind))
    .join("\n")
    .replace(/\n[ \t]*(?:\n[ \t]*)+/g, "\n\n")
    .replace(/^(#{1,6} .*)\n\n/gm, "$1\n");

// Version of a whole file, so a whole-document save can refuse to overwrite a newer file.
export const versionOf = (text: string) => (text ? createHash("sha256").update(text).digest("hex").slice(0, 16) : "");

// The file as the user edits it: managed lines removed, with the blank line tools keep after the badge.
export function editableText(text: string, kind: DocKind = RULES): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isManaged(lines[i], kind)) { out.push(lines[i]); continue; }
    if (re(kind).badge.test(lines[i]) && lines[i + 1]?.trim() === "" && lines[i + 2]?.trim()) i++;
  }
  return out.join("\n");
}

export function contentHash(title: string, body: string): string {
  const norm = `${title.trim()}\n${body.replace(/[ \t]+$/gm, "").trim()}`;
  return createHash("sha256").update(norm).digest("hex").slice(0, 10);
}

function parseMeta(line: string, kind: DocKind): Meta | null {
  const m = re(kind).meta.exec(line);
  if (!m) return null;
  const kv: Record<string, string> = {};
  for (const part of m[2].trim().split(/\s+/).filter(Boolean)) {
    const eq = part.indexOf("=");
    kv[part.slice(0, eq)] = decodeURIComponent(part.slice(eq + 1));
  }
  const status = kind.statuses.includes(kv.status) ? kv.status : "new";
  return { id: m[1], status, h: kv.h || null, target: kv.target || null, date: kv.date || null, impl: kv.impl ? kv.impl.split(",").filter(Boolean) : [], note: kv.note || null };
}

function metaLine(meta: Meta, kind: DocKind): string {
  const enc = (v: string) => encodeURIComponent(v);
  const parts = [`status=${meta.status}`];
  if (meta.h) parts.push(`h=${meta.h}`);
  if (meta.date) parts.push(`date=${enc(meta.date)}`);
  if (meta.target) parts.push(`target=${enc(meta.target)}`);
  if (meta.impl.length) parts.push(`impl=${enc(meta.impl.join(","))}`);
  if (meta.note) parts.push(`note=${enc(meta.note)}`);
  return `<!-- ${kind.tag}:${meta.id} ${parts.join(" ")} -->`;
}

function badgeLine(meta: Meta, effective: string, kind: DocKind): string {
  const bits = [`${kind.icons[effective]} **${kind.names[effective]}**`, `\`${meta.id}\``];
  if (meta.date) bits.push(meta.date);
  if (meta.target) bits.push(`针对 \`${meta.target.replace(/^\w+:/, "")}\``);
  if (effective === "modified") bits.push("你改过，等待同步");
  return `> <!--${kind.tag}-badge--> ${bits.join(" · ")}`;
}

function effectiveOf(meta: Meta | null, hash: string, kind: DocKind): string {
  if (!meta) return "new";
  if (kind.tracked.includes(meta.status) && meta.h && meta.h !== hash) return "modified";
  return meta.status;
}

export function parseRules(module: string, text: string, kind: DocKind = RULES): RuleItem[] {
  const lines = text.split("\n");
  const items: RuleItem[] = [];
  let section: string | null = null;
  let cur: { start: number; title: string; meta: Meta | null; body: string[] } | null = null;
  const close = (end: number) => {
    if (!cur) return;
    const body = cur.body.join("\n").replace(/^\s*\n/, "").trimEnd();
    const hash = contentHash(cur.title, body);
    const effective = effectiveOf(cur.meta, hash, kind);
    const layer = kind.layered && section ? layerOf(section) : null;
    items.push({ id: cur.meta?.id ?? null, module, layer, section, title: cur.title, body, hash, meta: cur.meta, status: cur.meta?.status ?? "new", effective, headingLine: cur.start, endLine: end });
    cur = null;
  };
  lines.forEach((line, i) => {
    if (/^#{1,2}\s/.test(line)) {
      close(i);
      const h2 = /^##\s+(.+?)\s*$/.exec(line);
      if (h2) section = h2[1];
      return;
    }
    const h3 = /^###\s+(.+?)\s*$/.exec(line);
    if (h3) {
      close(i);
      cur = { start: i, title: h3[1], meta: null, body: [] };
      return;
    }
    if (!cur) return;
    if (re(kind).meta.test(line)) cur.meta = cur.meta ?? parseMeta(line, kind);
    else if (!re(kind).badge.test(line)) cur.body.push(line);
  });
  close(lines.length);
  return items;
}

// The text above the first `##` (without the `#` title) and the `##` sections in order.
export function outline(text: string): { intro: string; sections: string[] } {
  const lines = text.split("\n");
  const first = lines.findIndex((l) => /^##\s/.test(l));
  const intro = (first < 0 ? lines : lines.slice(0, first)).filter((l) => !/^#\s/.test(l)).join("\n").trim();
  const sections = lines.map((l) => /^##\s+(.+?)\s*$/.exec(l)?.[1]).filter((s): s is string => !!s);
  return { intro, sections };
}

const today = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// Rewrite only the managed lines of every item so they match `metas` (by heading line).
function writeManaged(text: string, module: string, kind: DocKind, update: (item: RuleItem, meta: Meta | null) => Meta | null): string {
  const items = parseRules(module, text, kind);
  const lines = text.split("\n");
  for (const item of [...items].reverse()) {
    const meta = update(item, item.meta);
    const span = lines.slice(item.headingLine + 1, item.endLine);
    const kept = span.filter((l) => !isManaged(l, kind));
    const managed = meta ? [metaLine(meta, kind), badgeLine(meta, effectiveOf(meta, item.hash, kind), kind)] : [];
    // A blockquote badge would absorb a directly following text line, so keep a blank line after it.
    if (managed.length && kept.length && kept[0].trim() !== "") managed.push("");
    lines.splice(item.headingLine + 1, span.length, ...managed, ...kept);
  }
  const out = lines.join("\n");
  if (userText(out, kind) !== userText(text, kind)) throw new Error("internal error: managed-line update changed user text");
  return out;
}

export class RuleStore {
  dir: string;
  titles: Map<string, string>;
  kind: DocKind;
  constructor(root: string, titles: Map<string, string> = new Map(), kind: DocKind = RULES) {
    this.dir = join(root, kind.dir);
    this.titles = titles;
    this.kind = kind;
  }
  file(module: string) {
    if (!/^[a-z0-9_]+$/.test(module)) throw new Error(`invalid module: ${module}`);
    return join(this.dir, `${module}.md`);
  }
  modules(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter((f) => f.endsWith(".md") && f !== "README.md").map((f) => f.slice(0, -3)).sort();
  }
  read(module: string): string {
    return existsSync(this.file(module)) ? readFileSync(this.file(module), "utf8") : "";
  }
  parse(module: string, text = this.read(module)): RuleItem[] {
    return parseRules(module, text, this.kind);
  }
  all(): RuleItem[] {
    return this.modules().flatMap((m) => this.parse(m));
  }
  private numberOf(id: string | null | undefined): number {
    return Number(id?.match(new RegExp(`-${this.kind.idPart}(\\d+)$`))?.[1] ?? 0);
  }
  find(id: string): RuleItem {
    const module = id.replace(new RegExp(`-${this.kind.idPart}\\d+$`), "");
    const item = this.parse(module).find((r) => r.id === id);
    if (!item) throw new Error(`没有编号为 ${id} 的${this.kind === RULES ? "规则" : "条目"}`);
    return item;
  }

  // Give unnumbered items an id and bring every badge in line with its state. Returns true if the file changed.
  refresh(module: string): boolean {
    const text = this.read(module);
    if (!text) return false;
    const items = this.parse(module, text);
    // Number in document order (writeManaged visits items bottom-up).
    let next = Math.max(0, ...items.map((r) => this.numberOf(r.id))) + 1;
    const ids = new Map(items.filter((r) => !r.meta).map((r) => [r.headingLine, `${module}-${this.kind.idPart}${next++}`]));
    const out = writeManaged(text, module, this.kind, (item, meta) => meta ?? { id: ids.get(item.headingLine)!, status: "new", h: null, target: null, date: today(), impl: [], note: null });
    if (out === text) return false;
    writeFileSync(this.file(module), out);
    return true;
  }

  // State change through managed lines only (AI and board status buttons).
  setStatus(id: string, status: string, extra: { impl?: string[]; note?: string | null } = {}): RuleItem {
    if (!this.kind.statuses.includes(status)) throw new Error(`未知状态：${status}`);
    const item = this.find(id);
    const text = this.read(item.module);
    const out = writeManaged(text, item.module, this.kind, (it, meta) => {
      if (it.id !== id || !meta) return meta;
      const keepHash = status === "new" || status === "parked";
      return {
        ...meta,
        status,
        h: keepHash ? meta.h : it.hash,
        date: today(),
        impl: extra.impl ?? meta.impl,
        note: extra.note === undefined ? meta.note : extra.note,
      };
    });
    writeFileSync(this.file(item.module), out);
    return this.find(id);
  }

  // Human edits from the board: these may change user text. `section` is a layer for rules
  // and a free `##` heading for features (created at the end when missing).
  add(module: string, section: string, title: string, body: string, target: string | null): RuleItem {
    const cleanTitle = title.replace(/\s+/g, " ").trim();
    if (!cleanTitle) throw new Error("标题不能为空");
    const heading = this.kind.layered ? LAYER_NAMES[section as Layer] : section.replace(/\s+/g, " ").trim();
    if (!heading) throw new Error("分组不能为空");
    const sameSection = (name: string) => (this.kind.layered ? layerOf(name) === section : name === heading);
    let text = this.read(module);
    if (!text) {
      mkdirSync(this.dir, { recursive: true });
      const name = this.titles.get(module);
      const head = `# ${name ? `${name}（${module}）` : module}\n\n${this.kind.intro ? `${this.kind.intro}\n\n` : ""}`;
      text = head + (this.kind.layered ? LAYERS.map((l) => `## ${LAYER_NAMES[l]}\n`).join("\n") : "");
    }
    const lines = text.split("\n");
    let sectionStart = lines.findIndex((l) => {
      const m = /^##\s+(.+?)\s*$/.exec(l);
      return !!m && sameSection(m[1]);
    });
    if (sectionStart < 0) {
      while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
      lines.push("", `## ${heading}`, "");
      sectionStart = lines.length - 2;
    }
    let insertAt = lines.findIndex((l, i) => i > sectionStart && /^#{1,2}\s/.test(l));
    if (insertAt < 0) insertAt = lines.length;
    while (insertAt > sectionStart + 1 && lines[insertAt - 1].trim() === "") insertAt--;
    const next = Math.max(0, ...this.parse(module, text).map((r) => this.numberOf(r.id))) + 1;
    const id = `${module}-${this.kind.idPart}${next}`;
    const meta: Meta = { id, status: "new", h: null, target, date: today(), impl: [], note: null };
    const block = ["", `### ${cleanTitle}`, metaLine(meta, this.kind), badgeLine(meta, "new", this.kind), "", ...body.trim().split("\n"), ""];
    lines.splice(insertAt, 0, ...block);
    writeFileSync(this.file(module), lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n*$/, "\n"));
    this.refresh(module);
    return this.find(id);
  }

  // Whole-document edit from the board. The user's text replaces the file; an item keeps its id and
  // state when its title is unchanged, otherwise when it is at the same position among the changed
  // items of the same section (a rename). Anything else is a new item; missing items are removed.
  replaceText(module: string, text: string, version: string): RuleItem[] {
    const current = this.read(module);
    if (version !== versionOf(current)) throw Object.assign(new Error("文档在你编辑期间被改过（可能是 AI），请复制你的修改后刷新再编辑"), { status: 409 });
    const clean = text.replace(/\r\n/g, "\n").split("\n").filter((l) => !isManaged(l, this.kind)).join("\n").replace(/\n*$/, "\n");
    if (!clean.trim()) throw new Error("文档不能为空");
    const old = this.parse(module, current).filter((o) => o.meta);
    const next = this.parse(module, clean);
    const metas = new Map<number, Meta>();
    const used = new Set<RuleItem>();
    for (const n of next) {
      const o = old.find((x) => !used.has(x) && x.title === n.title);
      if (o) { used.add(o); metas.set(n.headingLine, o.meta!); }
    }
    for (const section of new Set(next.map((n) => n.section))) {
      const fresh = next.filter((n) => n.section === section && !metas.has(n.headingLine));
      const left = old.filter((o) => o.section === section && !used.has(o));
      fresh.forEach((n, i) => { if (left[i]) { used.add(left[i]); metas.set(n.headingLine, left[i].meta!); } });
    }
    const out = writeManaged(clean, module, this.kind, (item) => metas.get(item.headingLine) ?? null);
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file(module), out);
    this.refresh(module);
    return this.parse(module);
  }

  edit(id: string, title: string, body: string): RuleItem {
    const item = this.find(id);
    const cleanTitle = title.replace(/\s+/g, " ").trim();
    if (!cleanTitle) throw new Error("标题不能为空");
    const lines = this.read(item.module).split("\n");
    const managed = lines.slice(item.headingLine + 1, item.endLine).filter((l) => isManaged(l, this.kind));
    const trailing = item.endLine < lines.length ? [""] : [];
    lines.splice(item.headingLine, item.endLine - item.headingLine, `### ${cleanTitle}`, ...managed, "", ...body.trim().split("\n"), ...trailing);
    writeFileSync(this.file(item.module), lines.join("\n").replace(/\n{3,}/g, "\n\n"));
    this.refresh(item.module);
    return this.find(id);
  }
}
