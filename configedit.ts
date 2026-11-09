// Board edits to a project's own setup: new modules (modules.yaml or the config's inline `modules`) and
// plugins. Text outside the changed entry is left as it is.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { CONFIG_FILE, type Config } from "./config.ts";
import { loadModules } from "./codemap/model.ts";

const MODULE_ID = /^[a-z][a-z0-9_]{0,40}$/;

function updateConfig(root: string, change: (raw: Record<string, any>) => void) {
  const file = join(root, CONFIG_FILE);
  const raw = JSON.parse(readFileSync(file, "utf8"));
  change(raw);
  writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
}

// A YAML scalar our subset reader returns unchanged: plain when safe, otherwise double-quoted.
const yamlScalar = (s: string) => (/^[^\s#:"'\[\]{},&*!|>%@`-][^#:"']*$/.test(s) && !/\s$/.test(s) ? s : `"${s.replace(/"/g, "")}"`);

export type NewModule = { id: string; title: string; backend?: string[]; frontend?: string[]; schemas?: string[] };

// With a modules file the module is inserted first under `modules:`, so its file patterns win over a
// catch-all module further down (files go to the first module that matches).
export function addModule(root: string, cfg: Config, m: NewModule): string {
  const id = m.id.trim();
  const title = m.title.replace(/\s+/g, " ").trim();
  if (!MODULE_ID.test(id)) throw new Error("模块编号以小写字母开头，只能用小写字母、数字和下划线");
  if (!title) throw new Error("模块名称不能为空");
  if (loadModules(root, cfg).modules.some((x) => x.id === id)) throw Object.assign(new Error(`已有模块 ${id}`), { status: 409 });
  const list = (v?: string[]) => (v ?? []).map((s) => s.trim()).filter(Boolean);
  const file = cfg.modulesFile ? join(root, cfg.modulesFile) : null;
  if (file && existsSync(file)) {
    const lines = readFileSync(file, "utf8").split("\n");
    const at = lines.findIndex((l) => /^modules:\s*$/.test(l));
    const block = [`  ${id}:`, `    title: ${yamlScalar(title)}`];
    for (const key of ["backend", "frontend", "schemas"] as const) {
      const items = list(m[key]);
      if (items.length) block.push(`    ${key}:`, ...items.map((i) => `      - ${yamlScalar(i)}`));
    }
    if (at < 0) lines.push("", "modules:", ...block);
    else lines.splice(at + 1, 0, ...block, "");
    writeFileSync(file, lines.join("\n"));
    return cfg.modulesFile!;
  }
  updateConfig(root, (raw) => {
    raw.modules = { ...(raw.modules ?? {}), [id]: title };
  });
  return CONFIG_FILE;
}

// Registers a plugin module (path relative to the repository) in the config.
export function addPlugin(root: string, path: string): string {
  const abs = resolve(root, path.trim());
  const rel = relative(root, abs);
  if (!path.trim() || rel.startsWith("..") || isAbsolute(rel)) throw new Error("插件必须是仓库里的文件");
  if (!existsSync(abs)) throw new Error(`${rel} 不存在`);
  updateConfig(root, (raw) => {
    const plugins: string[] = Array.isArray(raw.plugins) ? raw.plugins : [];
    if (plugins.includes(rel)) throw Object.assign(new Error("这个插件已经登记"), { status: 409 });
    raw.plugins = [...plugins, rel];
  });
  return rel;
}
