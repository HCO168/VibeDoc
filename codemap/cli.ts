// Code map CLI (needs `codemap` in vibedoc.config.json).
//   vibedoc codemap generate      write <outDir>/INDEX.md, <module>/{frontend,api,backend,database,structs}.md, codemap.json
//   vibedoc codemap fn <query>    print functions whose name or key contains <query>
//   vibedoc codemap route <query> print routes whose path contains <query>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { buildModel, LAYERS, type Model, type FnNode } from "./model.ts";
import { renderModule, renderIndex } from "./render.ts";
import { toJson } from "./json.ts";

import { findRoot, loadConfig } from "../config.ts";

const root = findRoot();
const cfg = loadConfig(root);
if (!cfg.codemap) {
  console.error("这个仓库没有启用代码地图：在 vibedoc.config.json 里加上 codemap（见 VibeDoc 的 README）。");
  process.exit(1);
}

function meta() {
  let head = "unknown";
  try {
    head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {}
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return { head, generatedAt: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}` };
}

function generate() {
  const started = Date.now();
  const model = buildModel(root, cfg);
  const m = meta();
  const out = join(root, cfg.codemap!.outDir);
  for (const mod of model.modules) {
    const pages = renderModule(model, mod, m);
    mkdirSync(join(out, mod.id), { recursive: true });
    for (const page of [...LAYERS, "structs"] as const) writeFileSync(join(out, mod.id, `${page}.md`), pages[page]);
  }
  writeFileSync(join(out, "INDEX.md"), renderIndex(model, m));
  writeFileSync(join(out, "codemap.json"), JSON.stringify(toJson(model)));
  const documented = [...model.fns.values()].filter((n) => n.fn.docs).length;
  console.log(
    `codemap: ${model.modules.length} 个模块 × 5 份文档，${model.fns.size} 个函数（${documented} 个有说明），${model.routes.length} 条路由，${model.schema.tables.size} 张表，用时 ${Date.now() - started} ms`,
  );
  const unassigned = model.unassigned.backend.length + model.unassigned.frontend.length;
  if (unassigned) console.log(`codemap: ${unassigned} 个文件未归属任何模块，见 ${cfg.codemap!.outDir}/INDEX.md`);
}

function printFn(model: Model, n: FnNode) {
  const name = (id: string) => model.fns.get(id)?.key ?? id;
  console.log(`\n${n.key}  [${n.module} · ${n.layer}]  ${n.file}:${n.fn.line}`);
  console.log(`  ${n.fn.docs ? n.fn.docs.replace(/\n/g, "\n  ") : "（缺少说明）"}`);
  console.log(`  ${n.fn.signature}`);
  if (n.handlerOf.length) console.log(`  接口：${n.handlerOf.map((r) => r.id).join("，")}`);
  if (n.callers.size) console.log(`  被调用：${[...n.callers].map(name).join("，")}`);
  if (n.callees.size) console.log(`  调用：${[...n.callees].map(name).join("，")}`);
  if (n.tables.size) console.log(`  表：${[...n.tables].map(([t, w]) => `${t}${w ? "（写）" : ""}`).join("，")}`);
}

const [command, ...args] = process.argv.slice(2);
if (command === "generate") generate();
else if (command === "fn" && args[0]) {
  const model = buildModel(root, cfg);
  const q = args[0].toLowerCase();
  const hits = [...model.fns.values()].filter((n) => n.key.toLowerCase().includes(q));
  hits.slice(0, 30).forEach((n) => printFn(model, n));
  if (hits.length > 30) console.log(`\n…共 ${hits.length} 个匹配，只显示前 30 个`);
  if (!hits.length) console.log("没有匹配的函数");
} else if (command === "route" && args[0]) {
  const model = buildModel(root, cfg);
  const q = args[0].toLowerCase();
  for (const r of model.routes.filter((x) => x.path.toLowerCase().includes(q))) {
    const h = r.handler ? model.fns.get(r.handler) : undefined;
    console.log(`${r.method.padEnd(6)} ${r.path}  [${r.module}]  → ${h?.key ?? "（内联闭包）"}  ${h?.fn.docs ? "— " + h.fn.docs.split("\n")[0] : ""}`);
    for (const f of r.frontend) console.log(`         前端：${f.file}${f.fn ? ` · ${f.fn}` : ""}`);
  }
} else {
  console.log("用法：vibedoc codemap generate | fn <名称> | route <路径片段>");
  process.exitCode = command ? 1 : 0;
}
