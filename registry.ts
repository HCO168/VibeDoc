// The projects one VibeDoc server manages: ~/.config/vibedoc/projects.json (XDG_CONFIG_HOME respected),
// a list of repository roots that each hold a vibedoc.config.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { CONFIG_FILE } from "./config.ts";

export const registryFile = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "vibedoc", "projects.json");

export function listProjects(): string[] {
  try {
    const raw = JSON.parse(readFileSync(registryFile(), "utf8"));
    return Array.isArray(raw.projects) ? raw.projects.map(String) : [];
  } catch {
    return [];
  }
}

function save(roots: string[]) {
  mkdirSync(dirname(registryFile()), { recursive: true });
  writeFileSync(registryFile(), `${JSON.stringify({ projects: roots }, null, 2)}\n`);
}

// Returns false when it was already registered.
export function addProject(path: string): boolean {
  const root = resolve(path);
  if (!existsSync(join(root, CONFIG_FILE))) throw new Error(`${root} 里没有 ${CONFIG_FILE}，先在那里运行 vibedoc init。`);
  const roots = listProjects();
  if (roots.includes(root)) return false;
  save([...roots, root]);
  return true;
}

// Accepts a path or a project id as `projectIds` assigns it; returns the removed root.
export function removeProject(pathOrId: string): string | null {
  const roots = listProjects();
  const ids = projectIds(roots);
  const root = roots.find((r) => r === resolve(pathOrId)) ?? roots.find((r) => ids.get(r) === pathOrId) ?? null;
  if (root) save(roots.filter((r) => r !== root));
  return root;
}

// Stable URL ids from directory names: lowercase letters, digits and dashes, numbered on collision.
export function projectIds(roots: string[]): Map<string, string> {
  const ids = new Map<string, string>();
  const used = new Set<string>();
  for (const root of roots) {
    const base = basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    ids.set(root, id);
  }
  return ids;
}
