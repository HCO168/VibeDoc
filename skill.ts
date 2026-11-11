// The AI skill for building VibeDoc plugins (skills/vibedoc-plugin) and the plugin scaffold it starts from.
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findRoot } from "./config.ts";
import { addPlugin } from "./configedit.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const skillDir = () => join(here, "skills/vibedoc-plugin");

// Copies the skill where an agent loads skills from: Claude Code (~/.claude/skills), Codex (~/.codex/skills)
// or the current repository (.claude/skills, shared with everyone working on it).
export function installSkill(target: "claude" | "codex" | "project"): string {
  const base = target === "codex" ? join(homedir(), ".codex/skills") : target === "project" ? join(findRoot(), ".claude/skills") : join(homedir(), ".claude/skills");
  const dest = join(base, "vibedoc-plugin");
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(base, { recursive: true });
  cpSync(skillDir(), dest, { recursive: true });
  return dest;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;

// tools/vibedoc-plugins/<name>/plugin.ts (+ client.js with `view`), registered in vibedoc.config.json.
export function scaffoldPlugin(root: string, name: string, title: string | undefined, view: boolean): string[] {
  if (!NAME.test(name)) throw new Error("插件名只能用小写字母、数字和连字符，例如 release-notes");
  const dir = join(root, "tools/vibedoc-plugins", name);
  if (existsSync(dir)) throw new Error(`${dir} 已存在`);
  mkdirSync(dir, { recursive: true });
  const label = title?.trim() || name;
  const command = name.replace(/[^a-z0-9]+/g, "-");
  writeFileSync(join(dir, "plugin.ts"), `// VibeDoc plugin "${name}". API and conventions: the vibedoc-plugin skill (vibedoc skill path).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Ctx = { root: string; cfg: any; docs: any; notify: () => void };

// The data this plugin shows; replace with what the plugin is about.
function summary(ctx: Ctx) {
  const readme = join(ctx.root, "README.md");
  return { project: ctx.cfg.name, readmeLines: existsSync(readme) ? readFileSync(readme, "utf8").split("\\n").length : 0 };
}

export default {
  name: "${name}",
  title: "${label.replace(/"/g, "")}",${view ? `\n  client: "client.js",` : ""}
  // watch: ["path/inside/the/repo"],  // changes refresh the open board tab
  // rules: "- What AI agents must know or do because of this plugin.",
  commands: {
    "${command}": {
      describe: "${label.replace(/"/g, "")}：打印摘要",
      run(_args: string[], ctx: Ctx) {
        console.log(JSON.stringify(summary(ctx), null, 2));
      },
    },
  },
  get: {
    summary: (_query: URLSearchParams, ctx: Ctx) => summary(ctx),
  },
  post: {},
};
`);
  const files = [join(dir, "plugin.ts")];
  if (view) {
    writeFileSync(join(dir, "client.js"), `// Board tab of the "${name}" plugin. vd.data(route) reads a GET route once and re-renders when it arrives.
VibeDoc.registerView("${name}", (vd) => {
  const s = vd.data("summary");
  if (!s) return vd.h("div", { class: "empty" }, "加载中…");
  if (s.error) return vd.h("div", { class: "err" }, s.error);
  return [
    vd.h("h2", { style: "margin:0 0 8px;font-size:17px" }, "${label.replace(/"/g, "")}"),
    vd.h("p", {}, \`\${s.project}：README 共 \${s.readmeLines} 行\`),
  ];
});
`);
    files.push(join(dir, "client.js"));
  }
  addPlugin(root, join("tools/vibedoc-plugins", name, "plugin.ts"));
  return files;
}
