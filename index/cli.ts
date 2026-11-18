// AI index and freshness CLI (needs `codemap` and `index` in vibedoc.config.json).
//   vibedoc index generate            record what is current in the ledger, rewrite <index.dir>/<module>.txt and INDEX.txt
//   vibedoc index stale [模块] [--bare] [--blank]
//                                     stale function comments, index lines and behavior sections, broken refs;
//                                     --bare also changed functions without a comment, --blank files without a role
//   vibedoc index ack <目标>...        the text is still accurate although only its subject changed
//                                     (function id or 文件::函数名, source path, or 文档路径#标题)
//   vibedoc index show <路径>          one file: its index line, functions and the sections that refer to it
//   vibedoc index check <id> [--impl a,b]   the completion gate for a feature or rule, without changing anything
import { findRoot, loadConfig } from "../config.ts";
import { ack, counts, entryLine, gateIssues, refersTo, scan, sync, writeIndex, writeLedger, type Scan } from "./fresh.ts";

const root = findRoot();
const cfg = loadConfig(root);
if (!cfg.codemap || !cfg.index) {
  console.error("这个仓库没有启用 AI 索引：vibedoc.config.json 里需要 codemap 和 \"index\": {}（见 VibeDoc 的 README）。");
  process.exit(1);
}
const [command, ...args] = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1] === "--impl"));

function generate(s: Scan) {
  sync(s);
  writeLedger(root, cfg, s.ledger);
  const files = writeIndex(root, cfg, s);
  const c = counts(s);
  console.log(`index: ${c.files} 个文件、${s.fns.size} 个函数、${s.sections.length} 个带引用的文档小节，写入 ${files.length} 份索引`);
  const stale = c.staleFns + c.staleEntries + c.staleSections + c.broken;
  console.log(stale ? `index: 有 ${stale} 处过期或失效，运行 vibedoc index stale 查看` : "index: 没有过期内容");
  if (c.blank) console.log(`index: ${c.blank} 个文件还没写 role`);
}

try {
  if (command === "generate") generate(scan(root, cfg));
  else if (command === "stale") {
    const s = scan(root, cfg);
    const module = positional[0];
    const inMod = (m: string) => !module || m === module;
    let n = 0;
    const out = (line: string) => {
      n++;
      console.log(line);
    };
    for (const f of s.fns.values()) if (inMod(f.module) && f.state === "stale") out(`函数注释  ${f.key}  ${f.file}:${f.line}`);
    if (args.includes("--bare")) for (const f of s.fns.values()) if (inMod(f.module) && f.state === "bare" && f.changed && !f.confirmed) out(`缺注释    ${f.key}  ${f.file}:${f.line}`);
    for (const e of s.entries.values()) if (inMod(e.module) && e.state === "stale") out(`索引行    ${e.path}  (${e.module}.txt)`);
    if (args.includes("--blank")) for (const e of s.entries.values()) if (inMod(e.module) && e.state === "blank") out(`缺 role   ${e.path}  (${e.module}.txt)`);
    if (!module) {
      for (const x of s.sections) {
        if (x.state === "stale") out(`文档小节  ${x.key}  ${x.doc}:${x.line}  变了：${x.changed.join("、")}`);
        for (const r of x.refs) if (r.kind === "missing") out(`失效引用  ${x.key}  ${x.doc}:${x.line}  → ${r.ref}`);
      }
    }
    const c = counts(s, module);
    if (!n) console.log("没有过期内容");
    if (!args.includes("--bare") && c.bareChanged) console.log(`（另有 ${c.bareChanged} 个新增或改动过的函数没有注释，--bare 查看）`);
    if (!args.includes("--blank") && c.blank) console.log(`（另有 ${c.blank} 个文件还没写 role，--blank 查看）`);
  } else if (command === "ack" && positional.length) {
    const s = scan(root, cfg);
    for (const t of positional) console.log(`已确认：${ack(s, t)}`);
    writeLedger(root, cfg, s.ledger);
    writeIndex(root, cfg, s);
  } else if (command === "show" && positional[0]) {
    const s = scan(root, cfg);
    const path = positional[0];
    const e = s.entries.get(path);
    if (!e) throw new Error(`索引里没有 ${path}`);
    console.log(entryLine(e));
    for (const f of [...s.fns.values()].filter((x) => x.file === path).sort((a, b) => a.line - b.line)) {
      const mark = f.state === "stale" ? "注释过期" : f.state === "bare" ? (f.confirmed ? "无注释（已确认）" : "无注释") : "";
      console.log(`  ${String(f.line).padStart(5)}  ${f.key}${mark ? `  [${mark}]` : ""}${f.docs ? `  — ${f.docs.split("\n")[0]}` : ""}`);
    }
    for (const x of s.sections.filter((x) => x.refs.some((r) => refersTo(s, r, path)))) {
      console.log(`  文档：${x.key}${x.state === "stale" ? "  [待更新]" : ""}`);
    }
  } else if (command === "check" && positional[0]) {
    const s = scan(root, cfg);
    const id = positional[0];
    const impl = flag("--impl")?.split(",").map((x) => x.trim()).filter(Boolean) ?? s.items.get(id)?.impl ?? [];
    const issues = gateIssues(s, id, impl);
    if (!issues.length) console.log(`${id} 可以标记完成`);
    for (const i of issues) console.log(`- ${i}`);
    process.exitCode = issues.length ? 1 : 0;
  } else {
    console.log("用法：vibedoc index generate | stale [模块] [--bare] [--blank] | ack <目标>... | show <路径> | check <id> [--impl a,b]");
    process.exitCode = command ? 1 : 0;
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
