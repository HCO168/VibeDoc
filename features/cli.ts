// Feature document CLI for AI agents. <featuresDir>/<module>.md is written by the AI and may be edited
// by the user; status lives in the managed lines and is changed only here (or by board buttons).
//   vibedoc features list [--all] [模块]        items needing action (new, modified, confirm, doing)
//   vibedoc features show <id>                  one item, with the text the AI last recorded if modified
//   vibedoc features set <状态> <id> [<id>...]  set status and record the current text as handled
//   vibedoc features summary [模块]              counts per module and status
//   vibedoc features refresh                    number new items and refresh badges
// 状态：new confirm doing done(已持久化，合入开发主分支) released(已上线正式站) parked
import { relative } from "node:path";
import { execFileSync } from "node:child_process";
import { RuleStore, FEATURES, FEATURE_STATUSES, parseRules, kindsFor, type RuleItem } from "../rules/store.ts";
import { findRoot, loadConfig } from "../config.ts";

const root = findRoot();
const kind = kindsFor(loadConfig(root)).features;
const store = new RuleStore(root, new Map(), kind);
const [command, ...args] = process.argv.slice(2);
const NAMES = FEATURES.names;

const line = (r: RuleItem) =>
  `${(r.id ?? "（未编号）").padEnd(16)} ${NAMES[r.effective].padEnd(5)} ${r.section ?? "未分组"}  ${r.title}`;

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
    const module = args.find((a) => !a.startsWith("--"));
    const all = module ? store.parse(module) : store.all();
    const shown = args.includes("--all") ? all : all.filter((r) => ["new", "modified", "confirm", "doing"].includes(r.effective));
    if (!shown.length) console.log("没有待处理的功能");
    for (const r of shown) console.log(line(r));
  } else if (command === "show" && args[0]) {
    const r = store.find(args[0]);
    console.log(line(r));
    console.log(`\n### ${r.title}\n${r.body}\n`);
    if (r.effective === "modified") {
      const prev = previousBody(r);
      console.log(prev ? `AI 上次记录时的原文：\n${prev}` : "上次记录时的原文不在 Git 历史中（可能尚未提交），请对照当前原文与已实现代码。");
    }
  } else if (command === "set" && args.length >= 2) {
    const [status, ...ids] = args;
    if (!(FEATURE_STATUSES as readonly string[]).includes(status)) throw new Error(`未知状态：${status}（可用：${FEATURE_STATUSES.join(" ")}）`);
    for (const m of new Set(ids.map((id) => id.replace(/-f\d+$/, "")))) store.refresh(m);
    for (const id of ids) console.log(line(store.setStatus(id, status)));
  } else if (command === "summary") {
    const modules = args[0] ? [args[0]] : store.modules();
    const order = ["released", "done", "doing", "confirm", "modified", "new", "parked"];
    for (const m of modules) {
      const items = store.parse(m);
      const counts = order.map((s) => [s, items.filter((r) => r.effective === s).length] as const).filter(([, n]) => n);
      console.log(`${m.padEnd(14)} ${counts.map(([s, n]) => `${NAMES[s]} ${n}`).join("　") || "（空）"}`);
    }
  } else if (command === "refresh") {
    const changed = store.modules().filter((m) => store.refresh(m));
    console.log(changed.length ? `已刷新：${changed.join("、")}` : "无需刷新");
  } else {
    console.log("用法：vibedoc features list [--all] [模块] | show <id> | set <状态> <id...> | summary [模块] | refresh");
    process.exitCode = command ? 1 : 0;
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
