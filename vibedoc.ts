// VibeDoc command line. Run inside the repository it manages (or set VIBEDOC_REPO).
//   vibedoc init [--name <名称>]   create vibedoc.config.json and the two document folders here
//   vibedoc serve                 start the board (http://127.0.0.1:4870 by default)
//   vibedoc rules <命令>           rule status commands for AI agents
//   vibedoc features <命令>        feature document commands for AI agents
//   vibedoc codemap <命令>         code map generation and queries (needs `codemap` in the config)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_FILE } from "./config.ts";

const here = dirname(fileURLToPath(import.meta.url));
const [command, ...rest] = process.argv.slice(2);
const SUBCOMMANDS: Record<string, string> = { serve: "server.ts", rules: "rules/cli.ts", features: "features/cli.ts", codemap: "codemap/cli.ts" };

function init() {
  const root = process.cwd();
  const i = rest.indexOf("--name");
  const name = i >= 0 && rest[i + 1] ? rest[i + 1] : basename(root);
  const file = join(root, CONFIG_FILE);
  if (existsSync(file)) {
    console.log(`${CONFIG_FILE} 已存在，未改动。`);
  } else {
    const config = { name, port: 4870, rulesDir: "doc/rules", featuresDir: "doc/features", modules: { app: name } };
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`已创建 ${CONFIG_FILE}`);
  }
  const cfg = JSON.parse(readFileSync(file, "utf8"));
  for (const [dir, template] of [[cfg.rulesDir ?? "doc/rules", "rules-README.md"], [cfg.featuresDir ?? "doc/features", "features-README.md"]]) {
    const readme = join(root, dir, "README.md");
    if (existsSync(readme)) continue;
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(readme, readFileSync(join(here, "templates", template), "utf8"));
    console.log(`已创建 ${dir}/README.md`);
  }
  console.log(`\n下一步：\n  1. 在 ${CONFIG_FILE} 的 modules 里列出模块（或用 modulesFile 指向 modules.yaml），需要代码地图时加上 codemap。\n  2. 把 ${join(here, "templates/AGENTS-snippet.md")} 的内容加进仓库的 AGENTS.md／CLAUDE.md，让 AI 知道怎么维护。\n  3. 运行 vibedoc serve 打开看板。`);
}

if (command === "init") {
  init();
} else if (command && SUBCOMMANDS[command]) {
  process.argv = [process.argv[0], join(here, SUBCOMMANDS[command]), ...rest];
  await import(join(here, SUBCOMMANDS[command]));
} else {
  console.log("用法：vibedoc init [--name 名称] | serve | rules <命令> | features <命令> | codemap <命令>");
  process.exitCode = command ? 1 : 0;
}
