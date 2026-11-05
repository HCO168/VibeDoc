// Rule state CLI for AI agents. It only rewrites the managed lines of <rulesDir>/*.md;
// the user's own text is never touched (the store refuses any change that would alter it).
//   vibedoc rules list [--all]      rules needing action (new, modified, confirm, doing)
//   vibedoc rules show <id>         one rule, with the diff since the AI last acted on it
//   vibedoc rules confirm <id>      plan proposed in chat, waiting for the user
//   vibedoc rules start <id>        user approved, implementation in progress
//   vibedoc rules mark <id> [--impl a,b]  implemented
//   vibedoc rules refresh           number new rules and refresh badges
import { relative } from "node:path";
import { execFileSync } from "node:child_process";
import { RuleStore, STATUS_NAMES, LAYER_NAMES, parseRules, kindsFor, type RuleItem } from "./store.ts";
import { findRoot, loadConfig } from "../config.ts";

const root = findRoot();
const kind = kindsFor(loadConfig(root)).rules;
const store = new RuleStore(root, new Map(), kind);
const [command, ...args] = process.argv.slice(2);
// New items written by hand get their ids before anything is listed or shown.
if (["list", "show", "summary", "sql"].includes(command)) for (const m of store.modules()) store.refresh(m);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const line = (r: RuleItem) =>
  `${(r.id ?? "（未编号）").padEnd(14)} ${STATUS_NAMES[r.effective].padEnd(5)} ${r.layer ? LAYER_NAMES[r.layer] : "未分层"}  ${r.title}${r.meta?.target ? `  → ${r.meta.target}` : ""}`;

// The text of the same rule at the last commit where its content hash matched the recorded one.
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
    const all = store.all();
    const shown = args.includes("--all") ? all : all.filter((r) => ["new", "modified", "confirm", "doing"].includes(r.effective));
    if (!shown.length) console.log("没有待处理的规则");
    for (const r of shown) console.log(line(r));
  } else if (command === "show" && args[0]) {
    const r = store.find(args[0]);
    console.log(line(r));
    console.log(`\n### ${r.title}\n${r.body}\n`);
    if (r.effective === "modified") {
      const prev = previousBody(r);
      console.log(prev ? `上次处理时的原文：\n${prev}` : "上次处理时的原文不在 Git 历史中（可能尚未提交），请对照当前原文与已实现代码。");
    }
  } else if ((command === "confirm" || command === "start" || command === "mark") && args[0]) {
    const status = command === "confirm" ? "confirm" : command === "start" ? "doing" : "done";
    const impl = flag("--impl")?.split(",").map((s) => s.trim()).filter(Boolean);
    const r = store.setStatus(args[0], status, { impl });
    console.log(line(r));
  } else if (command === "refresh") {
    const changed = store.modules().filter((m) => store.refresh(m));
    console.log(changed.length ? `已刷新：${changed.join("、")}` : "无需刷新");
  } else {
    console.log("用法：vibedoc rules list [--all] | show <id> | confirm <id> | start <id> | mark <id> [--impl a,b] | refresh");
    process.exitCode = command ? 1 : 0;
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
