// Per-repository configuration: `vibedoc.config.json` at the root of the repository VibeDoc serves.
// Every path is relative to that root. Only `name` is required; everything else has a default, and the
// code map (Rust + SQL migrations + TS/React frontend analysis) is off unless `codemap` is present.
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

export type Config = {
  name: string;
  port: number;
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
  return {
    name: str(raw.name, root.split("/").pop() || "VibeDoc"),
    port: Number(process.env.PORT ?? raw.port ?? 4870),
    rulesDir: str(raw.rulesDir, "doc/rules"),
    featuresDir: str(raw.featuresDir, "doc/features"),
    tablesDir: str(raw.tablesDir, "doc/table-changes"),
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
  };
}
