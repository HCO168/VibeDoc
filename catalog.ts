// Standard modules (templates/modules/catalog.json): common modules taken from real projects, each with a
// description and typical features. A project can start from a selection of them (`vibedoc init --modules`,
// the board's 增加项目 form) or add one later; with `features` the module also gets a feature document draft
// whose items start as 新提出 for the user to confirm, edit or delete.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.ts";
import { addModule } from "./configedit.ts";
import { loadModules } from "./codemap/model.ts";
import { RuleStore, kindsFor } from "./rules/store.ts";

export type StandardModule = { id: string; title: string; description: string; features: { title: string; body: string }[] };
export type CatalogGroup = { id: string; title: string; modules: StandardModule[] };

const here = dirname(fileURLToPath(import.meta.url));

export function loadCatalog(): CatalogGroup[] {
  return JSON.parse(readFileSync(join(here, "templates/modules/catalog.json"), "utf8")).groups;
}

export function standardModule(id: string): StandardModule | undefined {
  for (const g of loadCatalog()) for (const m of g.modules) if (m.id === id) return m;
  return undefined;
}

// Adds the given standard modules that the project does not have yet; returns the ids added.
// `cfg` must be re-read by the caller afterwards when it keeps using it.
export function applyStandardModules(root: string, cfg: Config, ids: string[], withFeatures: boolean): string[] {
  const added: string[] = [];
  for (const id of ids) {
    const m = standardModule(id);
    if (!m) throw new Error(`没有标准模块 ${id}（vibedoc module catalog 查看全部）`);
    if (!loadModules(root, cfg).modules.some((x) => x.id === id)) {
      addModule(root, cfg, { id: m.id, title: m.title });
      added.push(id);
    }
    if (withFeatures) writeFeatureDraft(root, cfg, m);
  }
  return added;
}

// The module's feature document, only when it does not exist yet.
function writeFeatureDraft(root: string, cfg: Config, m: StandardModule) {
  const kind = kindsFor(cfg).features;
  const file = join(root, cfg.featuresDir, `${m.id}.md`);
  if (existsSync(file)) return;
  mkdirSync(dirname(file), { recursive: true });
  const items = m.features.map((f) => `### ${f.title}\n${f.body}\n`).join("\n");
  writeFileSync(file, `# ${m.title}（${m.id}）\n\n${kind.intro}\n\n${m.description}\n\n## 常见功能（待确认）\n\n${items}`);
  new RuleStore(root, new Map(), kind).refresh(m.id);
}
