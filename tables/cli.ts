// Table request CLI for AI agents. <tablesDir>/<schema>.md holds the tables the user asked to create or
// change (format in tables/spec.ts); status lives in the managed lines and is changed only here (or by board buttons).
//   vibedoc tables list [--all] [schema]        requests needing action (new, modified, confirm, doing)
//   vibedoc tables show <id>                    one request with its SQL draft, migration directory and, if modified, the text last recorded
//   vibedoc tables sql <id>                     only the SQL draft
//   vibedoc tables set <状态> <id> [<id>...]    set status and record the current text as handled
//   vibedoc tables refresh                      number new requests and refresh badges
// 状态：new confirm doing done(已持久化：迁移已写好并合入开发主分支) parked
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { RuleStore, TABLES, TABLE_STATUSES, parseRules, kindsFor, type RuleItem } from "../rules/store.ts";
import { findRoot, loadConfig } from "../config.ts";
import { migrationSchema } from "../codemap/model.ts";
import { specOf, toSql, appliedIn, SECTIONS } from "./spec.ts";

const root = findRoot();
const cfg = loadConfig(root);
const kind = kindsFor(cfg).tables;
const store = new RuleStore(root, new Map(), kind);
const [command, ...args] = process.argv.slice(2);
// New items written by hand get their ids before anything is listed or shown.
if (["list", "show", "summary", "sql"].includes(command)) for (const m of store.modules()) store.refresh(m);
const NAMES = TABLES.names;

let replayed: Map<string, { columns: { name: string }[] }> | null = null;
const applied = (r: RuleItem) => {
  if (!cfg.codemap?.migrationsDir) return false;
  replayed ??= migrationSchema(root, cfg.codemap).tables;
  return appliedIn(specOf(r), replayed);
};
const line = (r: RuleItem) =>
  `${(r.id ?? "（未编号）").padEnd(16)} ${NAMES[r.effective].padEnd(5)} ${specOf(r).op === "alter" ? SECTIONS.alter : SECTIONS.create}  ${r.module}.${specOf(r).name}${applied(r) ? "  （迁移里已有）" : ""}`;

// Where the migration for a schema goes: the migrations subdirectory whose name maps to it.
function migrationDir(schema: string): string {
  const dir = cfg.codemap?.migrationsDir;
  if (!dir) return "（未配置 codemap.migrationsDir，按仓库约定放置）";
  const abs = join(root, dir);
  const subs = existsSync(abs) ? readdirSync(abs).filter((d) => statSync(join(abs, d)).isDirectory()) : [];
  if (schema === "public" && cfg.codemap!.publicMigrationDirs.length) return `${dir}/${cfg.codemap!.publicMigrationDirs[0]}/`;
  const hit = subs.find((d) => d.replace(/-/g, "_") === schema);
  return hit ? `${dir}/${hit}/` : `${dir}/${schema.replace(/_/g, "-")}/（新 schema，目录尚不存在）`;
}

// The same item at the last commit where its content hash matched the recorded one.
function previousBody(r: RuleItem): string | null {
  if (!r.meta?.h) return null;
  const file = relative(root, store.file(r.module));
  try {
    const commits = execFileSync("git", ["log", "--format=%H", "-n", "50", "--", file], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
    for (const c of commits) {
      const text = execFileSync("git", ["show", `${c}:${file}`], { cwd: root, encoding: "utf8" });
      const old = parseRules(r.module, text, kind).find((x) => x.id === r.id);
      if (old && old.hash === r.meta.h) return `${old.title}\n${old.body}`;
    }
  } catch {}
  return null;
}

try {
  if (command === "list") {
    const schema = args.find((a) => !a.startsWith("--"));
    const all = schema ? store.parse(schema) : store.all();
    const shown = args.includes("--all") ? all : all.filter((r) => ["new", "modified", "confirm", "doing"].includes(r.effective));
    if (!shown.length) console.log("没有待处理的表变更");
    for (const r of shown) console.log(line(r));
  } else if (command === "show" && args[0]) {
    const r = store.find(args[0]);
    console.log(line(r));
    console.log(`\n### ${r.title}\n${r.body}\n`);
    console.log(`迁移目录：${migrationDir(r.module)}\n`);
    console.log(`SQL 草稿：\n${toSql(specOf(r), r.id)}\n`);
    if (r.effective === "modified") {
      const prev = previousBody(r);
      console.log(prev ? `AI 上次记录时的原文：\n${prev}` : "上次记录时的原文不在 Git 历史中（可能尚未提交），请对照当前原文与已写的迁移。");
    }
  } else if (command === "sql" && args[0]) {
    const r = store.find(args[0]);
    console.log(toSql(specOf(r), r.id));
  } else if (command === "set" && args.length >= 2) {
    const [status, ...ids] = args;
    if (!(TABLE_STATUSES as readonly string[]).includes(status)) throw new Error(`未知状态：${status}（可用：${TABLE_STATUSES.join(" ")}）`);
    for (const m of new Set(ids.map((id) => id.replace(/-t\d+$/, "")))) store.refresh(m);
    for (const id of ids) console.log(line(store.setStatus(id, status)));
  } else if (command === "refresh") {
    const changed = store.modules().filter((m) => store.refresh(m));
    console.log(changed.length ? `已刷新：${changed.join("、")}` : "无需刷新");
  } else {
    console.log("用法：vibedoc tables list [--all] [schema] | show <id> | sql <id> | set <状态> <id...> | refresh");
    process.exitCode = command ? 1 : 0;
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
