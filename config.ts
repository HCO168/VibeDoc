// Per-repository configuration: `vibedoc.config.json` at the root of the repository VibeDoc serves.
// Every path is relative to that root. Only `name` is required; everything else has a default, and the
// code map (Rust + SQL migrations + TS/React frontend analysis) is off unless `codemap` is present.
// The document layout (`docs`) defaults to the tree `vibedoc init` creates under `docs.root` ("doc").
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const CONFIG_FILE = "vibedoc.config.json";

export type CrateConfig = {
  dir: string; // crate directory containing src/
  lib: string; // library crate name as used in `use <lib>::...`
  // How to name the service started by src/main.rs: "crate" (directory name) or "build-app"
  // (`<x>_backend` after the `build_<x>_app` function main calls, falling back to the directory name).
  mainName?: "crate" | "build-app";
};

// Where each part of the managed document system lives.
export type DocsLayout = {
  root: string; // AI-maintained area; holds README.md and the local AGENTS.md
  human: string; // the user's own area
  requests: string; // the user's requirements, one file per topic
  sketches: string; // UI sketches and annotated screenshots
  questions: string; // open questions waiting for the user's decision
  deliverables: string; // write-ups for people (manuals, overviews)
  behavior: string; // current product behavior
  contracts: string[]; // API and data contracts
  todo: string; // product backlog / in progress / under test
  goals: string; // multi-step goals and their open decisions
  totest: string; // outstanding manual QA handoffs
  changelogs: string; // dated change logs: <date>/<HHMMSS>_<role>_<slug>.md
  expired: string; // superseded documents
};

export type Config = {
  name: string;
  port: number;
  // Language for every reply and document the AI writes.
  language: string;
  docs: DocsLayout;
  // Integration branch, promotion chain (first = integration, last = release) and task branch prefix.
  git: { promotion: string[]; branchPrefix: string };
  rulesDir: string;
  featuresDir: string;
  tablesDir: string;
  // Module list for grouping: a modules.yaml (see README) and/or inline { id: title }.
  modulesFile: string | null;
  modules: Record<string, string>;
  codemap: null | {
    outDir: string;
    crates: CrateConfig[];
    migrationsDir: string | null;
    // Migration subdirectories whose files use the `public` schema and replay first; other
    // subdirectory names are the default schema of their files.
    publicMigrationDirs: string[];
    frontendRoots: string[];
  };
  // Extra directories whose changes refresh the code map (crate src, migrations and frontend roots are always watched).
  watch: string[];
  // Project plugins: ES module paths relative to the repository root (see plugins.ts).
  plugins: string[];
};

// The repository root: VIBEDOC_REPO, or the nearest directory upward from `start` holding the config file.
export function findRoot(start = process.cwd()): string {
  if (process.env.VIBEDOC_REPO) return resolve(process.env.VIBEDOC_REPO);
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, CONFIG_FILE))) return dir;
    const up = dirname(dir);
    if (up === dir) throw new Error(`没有找到 ${CONFIG_FILE}。在要管理的仓库根目录运行 \`vibedoc init\`，或设置 VIBEDOC_REPO。`);
    dir = up;
  }
}

export function loadConfig(root: string): Config {
  const file = join(root, CONFIG_FILE);
  const raw = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const str = (v: unknown, fallback: string) => (typeof v === "string" && v.trim() ? v.trim() : fallback);
  const strs = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  const cm = raw.codemap;
  const d = raw.docs && typeof raw.docs === "object" ? raw.docs : {};
  const docRoot = str(d.root, "doc");
  const human = str(d.human, `${docRoot}/human`);
  const promotion = strs(raw.git?.promotion);
  return {
    name: str(raw.name, root.split("/").pop() || "VibeDoc"),
    port: Number(process.env.PORT ?? raw.port ?? 4870),
    language: str(raw.language, "简体中文"),
    docs: {
      root: docRoot,
      human,
      requests: str(d.requests, `${human}/requests`),
      sketches: str(d.sketches, `${human}/ui-sketch`),
      questions: str(d.questions, `${human}/open_questions.md`),
      deliverables: str(d.deliverables, `${human}/deliverable`),
      behavior: str(d.behavior, `${docRoot}/behavior`),
      contracts: Array.isArray(d.contracts) ? strs(d.contracts) : [`${docRoot}/backend`, `${docRoot}/tables`],
      todo: str(d.todo, `${docRoot}/todo.md`),
      goals: str(d.goals, `${docRoot}/goal_logs.md`),
      totest: str(d.totest, `${docRoot}/totest`),
      changelogs: str(d.changelogs, `${docRoot}/change_logs`),
      expired: str(d.expired, `${docRoot}/expired`),
    },
    git: { promotion: promotion.length ? promotion : ["dev", "main"], branchPrefix: str(raw.git?.branchPrefix, "codex/") },
    rulesDir: str(raw.rulesDir, `${human}/rules`),
    featuresDir: str(raw.featuresDir, `${docRoot}/features`),
    tablesDir: str(raw.tablesDir, `${docRoot}/table-changes`),
    modulesFile: typeof raw.modulesFile === "string" ? raw.modulesFile : null,
    modules: raw.modules && typeof raw.modules === "object" ? Object.fromEntries(Object.entries(raw.modules).map(([k, v]) => [k, String(v)])) : {},
    codemap: cm
      ? {
          outDir: str(cm.outDir, "doc/modules"),
          crates: Array.isArray(cm.crates) ? cm.crates.map((c: any) => ({ dir: String(c.dir), lib: String(c.lib ?? String(c.dir).split("/").pop()!.replace(/-/g, "_")), mainName: c.mainName === "build-app" ? "build-app" : "crate" })) : [],
          migrationsDir: typeof cm.migrationsDir === "string" ? cm.migrationsDir : null,
          publicMigrationDirs: strs(cm.publicMigrationDirs),
          frontendRoots: strs(cm.frontendRoots),
        }
      : null,
    watch: strs(raw.watch),
    plugins: strs(raw.plugins),
  };
}
