// VibeDoc command line. Run inside the repository it manages (or set VIBEDOC_REPO).
//   vibedoc init [--name <名称>] [--modules auth,profile] [--features]
//                                   create vibedoc.config.json, the document tree, CLAUDE.md and the AGENTS.md rule blocks,
//                                   starting from standard modules (with --features also their feature document drafts)
//   vibedoc serve [--only]          start the board for every registered project (--only: just this repository)
//   vibedoc add [路径] | remove <路径或编号> | projects    manage the projects the board shows
//   vibedoc rules|features|tables <命令>                   status commands for rules, feature documents and table requests
//   vibedoc changelog|question|todo|totest|agents <命令>   document system commands (see docs/cli.ts)
//   vibedoc codemap <命令>           code map generation and queries (needs `codemap` in the config)
//   vibedoc plugins [add <路径>]     the project's plugins and their commands, or register one; vibedoc <插件命令> runs one
//   vibedoc module add <编号> <名称> [--backend a,b] [--frontend a,b] [--schemas a,b]   add a module
//   vibedoc module add --standard auth,profile [--features]   add standard modules; vibedoc module catalog lists them
//   vibedoc plugins new <名称> [--title 标签] [--view]          scaffold a plugin under tools/vibedoc-plugins and register it
//   vibedoc skill install [--claude|--codex|--project] | path  install the AI skill for building plugins
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_FILE, findRoot, loadConfig, type Config } from "./config.ts";
import { renderTemplate, syncAgents, templateVars } from "./agents.ts";
import { addProject, listProjects, projectIds, removeProject } from "./registry.ts";
import { loadPlugins, pluginContext, pluginRules } from "./plugins.ts";
import { addModule, addPlugin } from "./configedit.ts";
import { applyStandardModules, loadCatalog } from "./catalog.ts";
import { installSkill, scaffoldPlugin, skillDir } from "./skill.ts";

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

async function init() {
  const root = process.cwd();
  const i = rest.indexOf("--name");
  const name = i >= 0 && rest[i + 1] ? rest[i + 1] : basename(root);
  const file = join(root, CONFIG_FILE);
  if (existsSync(file)) {
    console.log(`${CONFIG_FILE} 已存在，未改动。`);
  } else {
    // With standard modules chosen the project starts from those instead of a single "app" module.
    const config = { name, port: 4870, language: "简体中文", modules: option("--modules").length ? {} : { app: name }, git: { promotion: ["dev", "main"], branchPrefix: "codex/" } };
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`已创建 ${CONFIG_FILE}`);
  }
  if (option("--modules").length) {
    const added = applyStandardModules(root, loadConfig(root), option("--modules"), rest.includes("--features"));
    if (added.length) console.log(`已加入标准模块：${added.join("、")}`);
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
  const { plugins, errors } = await loadPlugins(root, cfg);
  for (const e of errors) console.error(`插件加载失败：${e}`);
  for (const r of syncAgents(root, cfg, true, pluginRules(plugins))) console.log(`${r.file}：${{ created: "已创建", updated: "已更新", inserted: "已插入规则区块", unchanged: "已是最新" }[r.state as string] ?? r.state}`);
  if (addProject(root)) console.log("已加入 VibeDoc 项目列表");
  console.log(`\n下一步：\n  1. 在 ${CONFIG_FILE} 里列出 modules，按需要调整 git.promotion、docs 路径；需要代码地图时加上 codemap。\n  2. 本项目特有的规则写在 AGENTS.md 区块外；改了配置后运行 vibedoc agents sync。\n  3. 运行 vibedoc serve 打开看板。`);
}

// Commands contributed by the plugins of the repository you are in.
async function pluginCommand(name: string | undefined): Promise<boolean> {
  let root: string;
  try {
    root = findRoot();
  } catch {
    return false;
  }
  const cfg = loadConfig(root);
  const { plugins, errors } = await loadPlugins(root, cfg);
  for (const e of errors) console.error(`插件加载失败：${e}`);
  if (name === "plugins") {
    if (!plugins.length) console.log("这个项目没有插件（vibedoc.config.json 的 plugins）");
    for (const { plugin, file } of plugins) {
      console.log(`${plugin.name}${plugin.title ? `（${plugin.title}）` : ""}  ${file}`);
      for (const [cmd, c] of Object.entries(plugin.commands ?? {})) console.log(`  vibedoc ${cmd}  ${c.describe}`);
    }
    return true;
  }
  for (const { plugin } of plugins) {
    const cmd = name ? plugin.commands?.[name] : undefined;
    if (cmd) {
      await cmd.run(rest, pluginContext(root, cfg));
      return true;
    }
  }
  return false;
}

const option = (name: string) => {
  const i = rest.indexOf(name);
  return i >= 0 ? (rest[i + 1] ?? "").split(",").map((x) => x.trim()).filter(Boolean) : [];
};

if (command === "init") {
  await init();
} else if (command === "module" && rest[0] === "catalog") {
  for (const g of loadCatalog()) {
    console.log(`## ${g.title}`);
    for (const m of g.modules) console.log(`  ${m.id.padEnd(14)} ${m.title}　${m.description}`);
  }
} else if (command === "module" && rest[0] === "add" && rest.includes("--standard")) {
  try {
    const root = findRoot();
    const added = applyStandardModules(root, loadConfig(root), option("--standard"), rest.includes("--features"));
    console.log(added.length ? `已新增标准模块：${added.join("、")}` : "这些模块都已存在");
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
} else if (command === "plugins" && rest[0] === "new") {
  try {
    const i = rest.indexOf("--title");
    const files = scaffoldPlugin(findRoot(), rest[1] ?? "", i >= 0 ? rest[i + 1] : undefined, rest.includes("--view"));
    console.log(`已创建并登记插件：\n  ${files.join("\n  ")}\n下一步：编辑 plugin.ts，用 vibedoc plugins 检查，改了 rules 后运行 vibedoc agents sync。写法见 ${skillDir()}/SKILL.md`);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
} else if (command === "skill" && rest[0] === "path") {
  console.log(skillDir());
} else if (command === "skill" && rest[0] === "install") {
  try {
    const target = rest.includes("--codex") ? "codex" : rest.includes("--project") ? "project" : "claude";
    console.log(`已安装：${installSkill(target)}`);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
} else if (command === "module" && rest[0] === "add") {
  try {
    const root = findRoot();
    const [id, ...title] = rest.slice(1).filter((a, i, all) => !a.startsWith("--") && !(i > 0 && all[i - 1].startsWith("--")));
    const file = addModule(root, loadConfig(root), { id: id ?? "", title: title.join(" "), backend: option("--backend"), frontend: option("--frontend"), schemas: option("--schemas") });
    console.log(`已新增模块 ${id}：${file}`);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
} else if (command === "plugins" && rest[0] === "add") {
  try {
    console.log(`已登记插件：${addPlugin(findRoot(), rest[1] ?? "")}；运行 vibedoc agents sync 更新 AI 规则`);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
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
} else if (!(await pluginCommand(command))) {
  console.log("用法：vibedoc init | serve [--only] | add | remove | projects | module add|catalog | plugins [add|new] | skill install|path | rules | features | tables | changelog | question | todo | totest | agents | codemap | <插件命令>");
  process.exitCode = command ? 1 : 0;
}
