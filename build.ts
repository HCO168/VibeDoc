// Builds the npm package contents into dist/: Node refuses to strip types from .ts files under node_modules,
// so the published package runs plain JavaScript. Run by `npm pack` / `npm publish` through the prepack script.
import { stripTypeScriptTypes } from "node:module";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, "dist");
// Directories whose top-level .ts files are program code ("" is the repository root).
const CODE_DIRS = ["", "codemap", "docs", "features", "index", "rules", "tables"];
// Files the program reads next to its own modules; copied unchanged (plugin examples stay TypeScript).
const ASSETS = ["package.json", "templates", "skills", "web", "examples/plugins"];
const SKIP = new Set(["build.ts"]);
const RELATIVE_TS = /(\bfrom\s*|\bimport\s*\(\s*)(["'])(\.{1,2}\/[^"'\n]+)\.ts\2/g;

rmSync(out, { recursive: true, force: true });
let count = 0;
for (const dir of CODE_DIRS) {
  for (const name of readdirSync(join(root, dir))) {
    if (!name.endsWith(".ts") || SKIP.has(name)) continue;
    const rel = join(dir, name);
    const js = stripTypeScriptTypes(readFileSync(join(root, rel), "utf8")).replace(RELATIVE_TS, "$1$2$3.js$2");
    const left = js.match(/["']\.{1,2}\/[^"'\n]+\.ts["']/);
    if (left) throw new Error(`${rel}: relative .ts reference left after build: ${left[0]}`);
    const target = join(out, rel.replace(/\.ts$/, ".js"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, js);
    count++;
  }
}
for (const asset of ASSETS) cpSync(join(root, asset), join(out, asset), { recursive: true });
console.log(`dist/: ${count} modules compiled, ${ASSETS.length} asset entries copied`);
