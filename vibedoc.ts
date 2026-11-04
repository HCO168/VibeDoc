// VibeDoc command line. Run inside the repository it manages (or set VIBEDOC_REPO).
//   vibedoc init [--name <名称>]     create vibedoc.config.json, the document tree, CLAUDE.md and the AGENTS.md rule blocks
//   vibedoc serve [--only]          start the board for every registered project (--only: just this repository)
//   vibedoc add [路径] | remove <路径或编号> | projects    manage the projects the board shows
//   vibedoc rules|features|tables <命令>                   status commands for rules, feature documents and table requests
//   vibedoc changelog|question|todo|totest|agents <命令>   document system commands (see docs/cli.ts)
//   vibedoc codemap <命令>           code map generation and queries (needs `codemap` in the config)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_FILE, findRoot, loadConfig, type Config } from "./config.ts";
import { renderTemplate, syncAgents, templateVars } from "./agents.ts";
import { addProject, listProjects, projectIds, removeProject } from "./registry.ts";

const here = dirname(fileURLToPath(import.meta.url));
const [command, ...rest] = process.argv.slice(2);
const SUBCOMMANDS: Record<string, string> = { serve: "server.ts", rules: "rules/cli.ts", features: "features/cli.ts", tables: "tables/cli.ts", codemap: "codemap/cli.ts" };
const DOC_COMMANDS = new Set(["changelog", "question", "todo", "totest", "agents"]);

// Files `init` creates when missing: [path, template under templates/scaffold].
function scaffold(cfg: Config): [string, string][] {
  const d = cfg.docs;
  return [
    ["CLAUDE.md", "CLAUDE.md"],
    [`${d.root}/README.md`, "doc-README.md"],
    [`${d.human}/README.md`, "human-README.md"],
    [`${d.requests}/README.md`, "requests-README.md"],
    [`${d.sketches}/README.md`, "sketches-README.md"],
    [`${cfg.rulesDir}/README.md`, "rules-README.md"],
    [d.questions, "questions.md"],
    [`${d.deliverables}/README.md`, "deliverables-README.md"],
    [`${d.behavior}/README.md`, "behavior-README.md"],
    ...d.contracts.map((c): [string, string] => [`${c}/README.md`, "contracts-README.md"]),
    [`${cfg.featuresDir}/README.md`, "features-README.md"],
    [`${cfg.tablesDir}/README.md`, "tables-README.md"],
    [d.todo, "todo.md"],
    [d.goals, "goals.md"],
    [`${d.totest}/README.md`, "totest-README.md"],
    [`${d.totest}/AGENTS.md`, "totest-AGENTS.md"],
    [`${d.changelogs}/README.md`, "changelogs-README.md"],
    [`${d.expired}/README.md`, "expired-README.md"],
  ];
}

function init() {
  const root = process.cwd();
  const i = rest.indexOf("--name");
  const name = i >= 0 && rest[i + 1] ? rest[i + 1] : basename(root);
  const file = join(root, CONFIG_FILE);
  if (existsSync(file)) {
    console.log(`${CONFIG_FILE} 已存在，未改动。`);
  } else {
    const config = { name, port: 4870, language: "简体中文", modules: { app: name }, git: { promotion: ["dev", "main"], branchPrefix: "codex/" } };
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`已创建 ${CONFIG_FILE}`);
  }
  const cfg = loadConfig(root);
  const vars = templateVars(cfg);
  for (const [rel, template] of scaffold(cfg)) {
    const path = join(root, rel);
    if (existsSync(path)) continue;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, renderTemplate(readFileSync(join(here, "templates/scaffold", template), "utf8"), vars));
    console.log(`已创建 ${rel}`);
  }
  for (const r of syncAgents(root, cfg, true)) console.log(`${r.file}：${{ created: "已创建", updated: "已更新", inserted: "已插入规则区块", unchanged: "已是最新" }[r.state as string] ?? r.state}`);
  if (addProject(root)) console.log("已加入 VibeDoc 项目列表");
  console.log(`\n下一步：\n  1. 在 ${CONFIG_FILE} 里列出 modules，按需要调整 git.promotion、docs 路径；需要代码地图时加上 codemap。\n  2. 本项目特有的规则写在 AGENTS.md 区块外；改了配置后运行 vibedoc agents sync。\n  3. 运行 vibedoc serve 打开看板。`);
}

if (command === "init") {
  init();
} else if (command === "add") {
  const root = rest[0] ?? findRoot();
  console.log(addProject(root) ? `已加入：${root}` : `已在列表中：${root}`);
} else if (command === "remove" && rest[0]) {
  const root = removeProject(rest[0]);
  console.log(root ? `已移除：${root}（文件不受影响）` : "列表里没有这个项目");
} else if (command === "projects") {
  const roots = listProjects();
  const ids = projectIds(roots);
  if (!roots.length) console.log("还没有项目：在仓库里运行 vibedoc init 或 vibedoc add");
  for (const r of roots) console.log(`${ids.get(r)!.padEnd(20)} ${existsSync(join(r, CONFIG_FILE)) ? loadConfig(r).name.padEnd(16) : "（配置缺失）".padEnd(16)} ${r}`);
} else if (command && DOC_COMMANDS.has(command)) {
  process.argv = [process.argv[0], join(here, "docs/cli.ts"), command, ...rest];
  await import(join(here, "docs/cli.ts"));
} else if (command && SUBCOMMANDS[command]) {
  process.argv = [process.argv[0], join(here, SUBCOMMANDS[command]), ...rest];
  await import(join(here, SUBCOMMANDS[command]));
} else {
  console.log("用法：vibedoc init | serve [--only] | add | remove | projects | rules | features | tables | changelog | question | todo | totest | agents | codemap");
  process.exitCode = command ? 1 : 0;
}
