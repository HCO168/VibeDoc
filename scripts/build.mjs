import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, "dist");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// Keep the source layout so templates, web assets and dynamically loaded commands
// resolve the same way in a checkout and in the installed package.
function compile(dir = "") {
  for (const item of readdirSync(join(root, dir), { withFileTypes: true })) {
    const relative = join(dir, item.name);
    if (item.isDirectory() && ["codemap", "docs", "features", "rules", "tables"].includes(relative)) {
      compile(relative);
    } else if (item.isFile() && item.name.endsWith(".ts")) {
      const js = stripTypeScriptTypes(readFileSync(join(root, relative), "utf8"), { mode: "strip" })
        .replace(/(\bfrom\s+["']\.{1,2}\/[^"']+)\.ts(["'])/g, "$1.js$2");
      const target = join(out, relative.replace(/\.ts$/, ".js"));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, js);
    }
  }
}

compile();
for (const dir of ["templates", "web", "skills"]) {
  cpSync(join(root, dir), join(out, dir), { recursive: true });
}
console.log("Built dist/ (JavaScript, templates, web assets and plugin skill).");
