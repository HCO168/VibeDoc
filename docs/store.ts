// The managed document system besides rules/features/tables: change logs, open questions, todo,
// QA handoffs, goals, requests and sketches. Used by the CLI (for AI agents) and the board.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import type { Config } from "../config.ts";

const pad = (n: number) => String(n).padStart(2, "0");
export const dateOf = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeOf = (d = new Date()) => `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const zone = () => new Intl.DateTimeFormat("en-US", { timeZoneName: "short" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value ?? "";

const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");
const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

export class DocSystem {
  root: string;
  cfg: Config;
  constructor(root: string, cfg: Config) {
    this.root = root;
    this.cfg = cfg;
  }
  abs(rel: string) {
    return join(this.root, rel);
  }

  // A repository-relative path that must stay inside one of the managed document directories.
  safePath(rel: string): string {
    const abs = resolve(this.root, rel);
    const allowed = [this.cfg.docs.root, this.cfg.docs.human, this.cfg.rulesDir, this.cfg.featuresDir, this.cfg.tablesDir].map((d) => resolve(this.root, d));
    if (!allowed.some((d) => abs === d || abs.startsWith(d + sep))) throw Object.assign(new Error("只能访问文档目录内的文件"), { status: 403 });
    return abs;
  }

  // ---------- change logs ----------
  changelogs(limit = 400) {
    const base = this.abs(this.cfg.docs.changelogs);
    if (!existsSync(base)) return [];
    const out: { path: string; date: string; time: string; role: string; slug: string; title: string }[] = [];
    for (const day of readdirSync(base).sort().reverse()) {
      const dir = join(base, day);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !statSync(dir).isDirectory()) continue;
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".md")).sort().reverse()) {
        const m = /^(\d{6})_([^_]+)_(.+)\.md$/.exec(f);
        const text = read(join(dir, f));
        const first = text.split("\n").find((l) => /^\s*-\s+\S/.test(l))?.replace(/^\s*-\s+/, "") ?? "";
        out.push({ path: relative(this.root, join(dir, f)), date: day, time: m?.[1] ?? "", role: m?.[2] ?? "", slug: m?.[3] ?? f.replace(/\.md$/, ""), title: first.slice(0, 160) });
        if (out.length >= limit) return out;
      }
    }
    return out;
  }
  newChangelog(role: string, slug: string): string {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(role) || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error("角色和短名只能用小写字母、数字和连字符");
    const now = new Date();
    const rel = join(this.cfg.docs.changelogs, dateOf(now), `${timeOf(now)}_${role}_${slug}.md`);
    if (existsSync(this.abs(rel))) throw new Error(`${rel} 已存在`);
    const stamp = `${dateOf(now)} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())} ${zone()}`.trim();
    write(this.abs(rel), `## time: ${stamp} | role: ${role}\n\n### 变更内容\n\n- 用户要求：\n- \n\n### 影响范围\n\n- \n\n### 验证\n\n- \n`);
    return rel;
  }

  // ---------- open questions ----------
  // Numbered items under "## 待决策事项": "N. 标题" followed by indented or "-" lines; answers are "> 用户答复…" lines.
  questions() {
    const text = read(this.abs(this.cfg.docs.questions));
    const lines = text.split("\n");
    const items: { n: number; title: string; body: string; answers: string[]; start: number; end: number }[] = [];
    let cur: (typeof items)[number] | null = null;
    lines.forEach((line, i) => {
      const m = /^(\d+)\.\s+(.*)$/.exec(line);
      if (m) {
        if (cur) cur.end = i;
        cur = { n: Number(m[1]), title: m[2].replace(/[：:]\s*$/, ""), body: "", answers: [], start: i, end: lines.length };
        items.push(cur);
      } else if (cur && /^#{1,6}\s/.test(line)) {
        cur.end = i;
        cur = null;
      } else if (cur) {
        const a = /^\s*>\s*用户答复(?:（([^）]*)）)?[：:]\s*(.*)$/.exec(line);
        if (a) cur.answers.push(a[2]);
        else cur.body += `${line}\n`;
      }
    });
    return items.map(({ n, title, body, answers }) => ({ n, title, body: body.trim(), answers }));
  }
  private questionLines() {
    const path = this.abs(this.cfg.docs.questions);
    const lines = read(path).split("\n");
    const spans: { n: number; start: number; end: number }[] = [];
    lines.forEach((line, i) => {
      const m = /^(\d+)\.\s/.exec(line);
      if (m) {
        if (spans.length && spans[spans.length - 1].end === -1) spans[spans.length - 1].end = i;
        spans.push({ n: Number(m[1]), start: i, end: -1 });
      } else if (/^#{1,6}\s/.test(line) && spans.length && spans[spans.length - 1].end === -1) spans[spans.length - 1].end = i;
    });
    if (spans.length && spans[spans.length - 1].end === -1) spans[spans.length - 1].end = lines.length;
    return { path, lines, spans };
  }
  addQuestion(title: string, body: string): number {
    const clean = title.replace(/\s+/g, " ").trim();
    if (!clean) throw new Error("问题不能为空");
    const path = this.abs(this.cfg.docs.questions);
    let text = read(path);
    if (!/^## 待决策事项\s*$/m.test(text)) text = `${text.replace(/\n*$/, "")}${text ? "\n\n" : "# 待决问题\n\n"}## 待决策事项\n`;
    const n = Math.max(0, ...this.questions().map((q) => q.n)) + 1;
    const extra = body.trim() ? `\n${body.trim().split("\n").map((l) => (l.startsWith("-") ? l : `- ${l}`)).join("\n")}` : "";
    const mark = /[？?。！!：:]$/.test(clean) ? "" : "：";
    write(path, `${text.replace(/\n*$/, "")}\n\n${n}. ${clean}${mark}${extra}\n`);
    return n;
  }
  answerQuestion(n: number, answer: string) {
    const clean = answer.trim().replace(/\n+/g, " ");
    if (!clean) throw new Error("答复不能为空");
    const { path, lines, spans } = this.questionLines();
    const span = spans.find((s) => s.n === n);
    if (!span) throw Object.assign(new Error(`没有第 ${n} 个问题`), { status: 404 });
    let at = span.end;
    while (at > span.start + 1 && !lines[at - 1].trim()) at--;
    lines.splice(at, 0, `> 用户答复（${dateOf()}）：${clean}`);
    write(path, lines.join("\n"));
  }
  resolveQuestion(n: number) {
    const { path, lines, spans } = this.questionLines();
    const span = spans.find((s) => s.n === n);
    if (!span) throw new Error(`没有第 ${n} 个问题`);
    lines.splice(span.start, span.end - span.start);
    write(path, lines.join("\n").replace(/\n{3,}/g, "\n\n"));
  }

  // ---------- todo ----------
  static TODO_SECTIONS: Record<string, string> = { backlog: "Backlog", doing: "In Progress", testing: "Under Test" };
  todo() {
    const text = read(this.abs(this.cfg.docs.todo));
    const sections: { name: string; items: string[] }[] = [];
    let cur: (typeof sections)[number] | null = null;
    for (const line of text.split("\n")) {
      const h = /^##\s+(?:\d+\.\s*)?(.+?)\s*$/.exec(line);
      if (h) sections.push((cur = { name: h[1], items: [] }));
      else if (cur && /^- /.test(line)) cur.items.push(line.slice(2));
      else if (cur && /^\s+\S/.test(line) && cur.items.length) cur.items[cur.items.length - 1] += ` ${line.trim()}`;
    }
    return sections;
  }
  addTodo(section: string, item: string) {
    const name = DocSystem.TODO_SECTIONS[section];
    if (!name) throw new Error("分组只能是 backlog、doing、testing");
    const clean = item.replace(/\s+/g, " ").trim();
    if (!clean) throw new Error("内容不能为空");
    const path = this.abs(this.cfg.docs.todo);
    const lines = read(path).split("\n");
    let h = lines.findIndex((l) => new RegExp(`^##\\s+(?:\\d+\\.\\s*)?${name}\\s*$`).test(l));
    if (h < 0) {
      lines.push("", `## ${name}`, "");
      h = lines.length - 2;
    }
    let at = lines.findIndex((l, i) => i > h && /^#{1,2}\s/.test(l));
    if (at < 0) at = lines.length;
    while (at > h + 1 && !lines[at - 1].trim()) at--;
    lines.splice(at, 0, `- ${clean}`);
    write(path, lines.join("\n"));
  }

  // ---------- files for the board ----------
  // Markdown files and images under a directory, newest first.
  listFiles(dirRel: string, exts = [".md"]) {
    const base = this.abs(dirRel);
    const out: { path: string; name: string; size: number; mtime: number }[] = [];
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const name of readdirSync(dir)) {
        if (name.startsWith(".")) continue;
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else if (exts.includes(extname(name).toLowerCase())) out.push({ path: relative(this.root, p), name: relative(base, p), size: st.size, mtime: st.mtimeMs });
      }
    };
    walk(base);
    return out.sort((a, b) => b.mtime - a.mtime);
  }
  overview() {
    const d = this.cfg.docs;
    const files = (dir: string) => this.listFiles(dir).filter((f) => !/(^|\/)(README|AGENTS)\.md$/.test(f.name));
    return {
      paths: d,
      questions: this.questions(),
      todo: this.todo(),
      totest: files(d.totest),
      requests: files(d.requests),
      sketches: this.listFiles(d.sketches, [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".pdf", ".md"]).filter((f) => !/(^|\/)README\.md$/.test(f.name)),
      deliverables: files(d.deliverables),
      goals: existsSync(this.abs(d.goals)),
    };
  }
  readFile(rel: string): string {
    const abs = this.safePath(rel);
    if (!existsSync(abs) || statSync(abs).isDirectory()) throw Object.assign(new Error("文件不存在"), { status: 404 });
    return readFileSync(abs, "utf8");
  }
  // The user's own request files: create or overwrite one under the requests directory.
  saveRequest(name: string, text: string): string {
    const clean = name.trim().replace(/\.md$/, "");
    if (!/^[\p{L}\p{N}][\p{L}\p{N} _-]{0,80}$/u.test(clean)) throw new Error("文件名只能用文字、数字、空格、下划线和连字符");
    const rel = join(this.cfg.docs.requests, `${clean}.md`);
    write(this.abs(rel), `${text.trim()}\n`);
    return rel;
  }
  saveSketch(name: string, data: Buffer): string {
    const clean = name.trim().split(/[\\/]/).pop()!;
    if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,120}\.(png|jpe?g|gif|webp|svg|pdf)$/iu.test(clean)) throw new Error("只能上传图片或 PDF，文件名只能用文字、数字、空格、点、下划线和连字符");
    const rel = join(this.cfg.docs.sketches, clean);
    if (existsSync(this.abs(rel))) throw Object.assign(new Error("同名文件已存在，换个名字再传"), { status: 409 });
    write(this.abs(rel), data as unknown as string);
    return rel;
  }
}
