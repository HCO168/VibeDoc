// Shared AI collaboration rules. `templates/agents/*.md` are rendered with the repository's config and kept
// in a marked block of AGENTS.md (root rules) and <docs.root>/AGENTS.md (documentation rules); text outside
// the blocks is the project's own and is never touched.
//   vibedoc agents sync    write or update both blocks
//   vibedoc agents check   exit 1 when a block is missing or out of date
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.ts";

const here = dirname(fileURLToPath(import.meta.url));

// `{{a.b}}` values and `{{#flag}}…{{/flag}}` sections kept only when the flag is truthy.
export function renderTemplate(text: string, vars: Record<string, unknown>): string {
  const get = (path: string) => path.split(".").reduce<any>((v, k) => (v == null ? undefined : v[k]), vars);
  return text
    .replace(/\{\{#([\w.]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_m, flag, inner) => (get(flag) ? inner : ""))
    .replace(/\{\{([\w.]+)\}\}/g, (m, path) => {
      const v = get(path);
      return v == null ? m : String(v);
    });
}

export function templateVars(cfg: Config, pluginRules = "") {
  const code = (s: string) => `\`${s}\``;
  const promotion = cfg.git.promotion;
  return {
    ...cfg,
    contracts: cfg.docs.contracts.map((c) => code(`${c}/*`)).join(" and "),
    contractsList: cfg.docs.contracts.map((c) => code(`${c}/`)).join("、"),
    git: { ...cfg.git, integration: promotion[0], release: promotion[promotion.length - 1], chain: promotion.map(code).join(" → ") },
    modulesSource: cfg.modulesFile ? code(cfg.modulesFile) : "the `modules` of `vibedoc.config.json`",
    pluginRules,
  };
}

const BLOCKS = [
  { key: "rules", template: "root.md", file: (_cfg: Config) => "AGENTS.md", title: (cfg: Config) => `# ${cfg.name} AI 开发规则` },
  { key: "docs", template: "docs.md", file: (cfg: Config) => `${cfg.docs.root}/AGENTS.md`, title: (_cfg: Config) => "# 文档局部规则" },
];
const begin = (key: string) => `<!-- vibedoc:${key}:begin — 由 \`vibedoc agents sync\` 按 VibeDoc 模板生成；要改通用规则请改模板，本项目专属规则写在区块外 -->`;
const end = (key: string) => `<!-- vibedoc:${key}:end -->`;
const blockRe = (key: string) => new RegExp(`<!-- vibedoc:${key}:begin[^\\n]*-->\\n[\\s\\S]*?<!-- vibedoc:${key}:end -->`);

function renderBlock(key: string, template: string, cfg: Config, pluginRules: string): string {
  const body = renderTemplate(readFileSync(join(here, "templates/agents", template), "utf8"), templateVars(cfg, pluginRules)).trim();
  return `${begin(key)}\n${body}\n${end(key)}`;
}

export type SyncResult = { file: string; state: "created" | "updated" | "inserted" | "unchanged" | "stale" | "missing" };

// With `write` false only reports whether each block is current. `pluginRules` is what the project's
// plugins add (plugins.ts pluginRules), so callers load the plugins first.
export function syncAgents(root: string, cfg: Config, write: boolean, pluginRules = ""): SyncResult[] {
  return BLOCKS.map(({ key, template, file, title }) => {
    const rel = file(cfg);
    const path = join(root, rel);
    const block = renderBlock(key, template, cfg, pluginRules);
    if (!existsSync(path)) {
      if (write) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${title(cfg)}\n\n${block}\n\n## 本项目专属规则\n\n（在这里写本项目特有的规则；上面的区块由 \`vibedoc agents sync\` 维护。）\n`);
      }
      return { file: rel, state: write ? "created" : "missing" };
    }
    const text = readFileSync(path, "utf8");
    const re = blockRe(key);
    if (re.test(text)) {
      const next = text.replace(re, () => block);
      if (next === text) return { file: rel, state: "unchanged" };
      if (write) writeFileSync(path, next);
      return { file: rel, state: write ? "updated" : "stale" };
    }
    // An existing file without the block: put it right after the first heading.
    if (write) {
      const lines = text.split("\n");
      const at = lines.findIndex((l) => /^#\s/.test(l));
      lines.splice(at < 0 ? 0 : at + 1, 0, ...(at < 0 ? [block, ""] : ["", block]));
      writeFileSync(path, lines.join("\n"));
    }
    return { file: rel, state: write ? "inserted" : "missing" };
  });
}
