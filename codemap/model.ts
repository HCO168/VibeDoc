import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, dirname, basename } from "node:path";
import { parseYaml } from "./yaml.ts";
import type { Config } from "../config.ts";
import { parseRust, type RustFile, type RustFn, type RustType } from "./rust.ts";
import { replayMigrations, sqlRefs, type Schema, type Table, type SqlFunction } from "./sql.ts";
import { parseFront, pathMatches, type FrontFile, type ClientFn } from "./frontend.ts";

export const LAYERS = ["frontend", "api", "backend", "database"] as const;
export type Layer = (typeof LAYERS)[number];

export type ModuleDef = {
  id: string;
  title: string;
  backend: string[];
  frontend: string[];
  schemas: string[];
  functions: string[];
  docs: string[];
};

export type FnNode = {
  id: string;
  key: string;
  crate: string;
  file: string;
  modPath: string;
  fn: RustFn;
  module: string;
  sharedWith: string[];
  layer: "api" | "backend" | "database";
  callees: Set<string>;
  callers: Set<string>;
  tables: Map<string, boolean>;
  sqlFunctions: Set<string>;
  handlerOf: RouteNode[];
  // Backend services (binaries) whose entry point reaches this function through calls or routes.
  backends: string[];
};

export type RouteNode = {
  id: string;
  method: string;
  path: string;
  handler: string | null;
  owner: string;
  module: string;
  file: string;
  line: number;
  frontend: { file: string; fn: string | null }[];
  api: ApiShape | null;
};

// Request and response types read from the handler signature (`Path<T>`, `Query<T>`, `Json<T>`, `ApiJson<T>`).
export type ApiShape = {
  path: string | null;
  query: string | null;
  body: string | null;
  bodyKind: "json" | "form" | "multipart" | null;
  response: string | null;
  responseNote: string | null;
  types: string[];
};

export type TypeNode = { id: string; crate: string; modPath: string; type: RustType; file: string; module: string; dto: boolean };

export type FrontNode = {
  file: string;
  module: string | null;
  parsed: FrontFile;
  uses: { file: string; fn: string }[];
  imports: string[];
};

export type Model = {
  root: string;
  modules: ModuleDef[];
  fns: Map<string, FnNode>;
  routes: RouteNode[];
  types: TypeNode[];
  typeById: Map<string, TypeNode>;
  typeRefs: (file: string, text: string) => TypeNode[];
  schema: Schema;
  tableModule: Map<string, string>;
  functionModule: Map<string, string>;
  tableUsers: Map<string, { fn: string; write: boolean }[]>;
  sqlFunctionUsers: Map<string, string[]>;
  front: Map<string, FrontNode>;
  frontRoutes: { path: string; component: string; file: string; target: string | null; module: string | null; line: number }[];
  backends: { id: string; file: string }[];
  unassigned: { backend: string[]; frontend: string[] };
};

const BUILTIN_TYPES = new Set([
  "Vec", "Option", "String", "Box", "Arc", "Rc", "HashMap", "BTreeMap", "HashSet", "BTreeSet", "VecDeque", "Value", "Uuid",
  "DateTime", "Utc", "NaiveDate", "NaiveDateTime", "Duration", "Bytes", "Cow", "Result", "Self", "PathBuf", "IpAddr", "SocketAddr",
]);


function walkFiles(dir: string, accept: (p: string) => boolean, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules" || name === "dist" || name === "target" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkFiles(p, accept, out);
    else if (accept(p)) out.push(p);
  }
  return out;
}

export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") re += "[^/]*";
    else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

// Modules from the configured modules.yaml, plus inline `modules` from the config (title only).
export function loadModules(root: string, cfg: Config): { modules: ModuleDef[]; shared: Map<string, string> } {
  const file = cfg.modulesFile ? join(root, cfg.modulesFile) : null;
  const raw = (file && existsSync(file) ? parseYaml(readFileSync(file, "utf8")) : {}) as Record<string, any>;
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  const modules: ModuleDef[] = Object.entries(raw.modules ?? {}).map(([id, def]: [string, any]) => ({
    id,
    title: String(def?.title ?? id),
    backend: list(def?.backend),
    frontend: list(def?.frontend),
    schemas: list(def?.schemas),
    functions: list(def?.functions),
    docs: list(def?.docs),
  }));
  for (const [id, title] of Object.entries(cfg.modules)) {
    if (!modules.some((m) => m.id === id)) modules.push({ id, title, backend: [], frontend: [], schemas: [], functions: [], docs: [] });
  }
  const shared = new Map<string, string>(Object.entries(raw.shared_files ?? {}).map(([k, v]) => [k, String(v)]));
  return { modules, shared };
}

function modPathOf(rel: string): string {
  const parts = rel.replace(/\.rs$/, "").split("/");
  if (parts[parts.length - 1] === "mod") parts.pop();
  if (parts.length === 1 && (parts[0] === "lib" || parts[0] === "main")) return "";
  return parts.join("::");
}

// Schema state after replaying every migration. A file's subdirectory under migrationsDir names its
// default schema; files directly inside it and in `publicMigrationDirs` use `public` and replay first.
export function migrationSchema(root: string, cm: Pick<NonNullable<Config["codemap"]>, "migrationsDir" | "publicMigrationDirs">): Schema {
  const migDir = cm.migrationsDir ? join(root, cm.migrationsDir) : null;
  const isPublic = (p: string) => dirname(p) === migDir || cm.publicMigrationDirs.includes(basename(dirname(p)));
  const migFiles = (migDir ? walkFiles(migDir, (p) => p.endsWith(".sql")) : [])
    .map((p) => ({ abs: p, path: relative(root, p), sql: readFileSync(p, "utf8"), defaultSchema: isPublic(p) ? "public" : basename(dirname(p)).replace(/-/g, "_") }))
    .sort((a, b) => (isPublic(a.abs) ? 0 : 1) - (isPublic(b.abs) ? 0 : 1) || basename(a.path).localeCompare(basename(b.path)))
    .map(({ abs: _abs, ...f }) => f);
  return replayMigrations(migFiles);
}

export function buildModel(root: string, cfg: Config): Model {
  const { modules, shared } = loadModules(root, cfg);
  const cm = cfg.codemap ?? { outDir: "", crates: [], migrationsDir: null, publicMigrationDirs: [], frontendRoots: [] };
  const matchers = modules.map((m) => ({
    id: m.id,
    backend: m.backend.map(globToRegExp),
    frontend: m.frontend.map(globToRegExp),
  }));
  const fileModule = (rel: string, layer: "backend" | "frontend") =>
    matchers.find((m) => m[layer].some((re) => re.test(rel)))?.id ?? null;
  const explicitFn = new Map<string, string>();
  for (const m of modules) for (const f of m.functions) explicitFn.set(f, m.id);

  const unassigned = { backend: [] as string[], frontend: [] as string[] };
  const fns = new Map<string, FnNode>();
  const types: TypeNode[] = [];
  const parsedFiles = new Map<string, { crate: string; modPath: string; parsed: RustFile }>();
  const index = new Map<string, Map<string, FnNode[]>>();

  for (const crate of cm.crates) {
    const src = join(root, crate.dir, "src");
    for (const abs of walkFiles(src, (p) => p.endsWith(".rs"))) {
      const rel = relative(root, abs);
      const modPath = modPathOf(relative(src, abs));
      const crateKey = modPath.startsWith("bin::") ? `${crate.lib}/${modPath}` : crate.lib;
      const parsed = parseRust(readFileSync(abs, "utf8"));
      parsedFiles.set(rel, { crate: crateKey, modPath: modPath.startsWith("bin::") ? "" : modPath, parsed });
      const sharedDefault = shared.get(rel) ?? null;
      const mod = sharedDefault ?? fileModule(rel, "backend");
      if (!mod) unassigned.backend.push(rel);
      const stem = basename(rel, ".rs") === "mod" ? basename(dirname(rel)) : basename(rel, ".rs");
      const layer: FnNode["layer"] = /(^|[_/])controller\.rs$|_mcp\.rs$|\/(webhook|realtime)\.rs$/.test(rel)
        ? "api"
        : /(^|[_/])(database|repo)\.rs$/.test(rel)
          ? "database"
          : "backend";
      for (const fn of parsed.fns) {
        if (fn.isTest) continue;
        const local = fn.implType ? `${fn.implType}::${fn.name}` : fn.name;
        const pathKey = modPath.startsWith("bin::") ? "" : modPath;
        let id = `${crateKey}::${pathKey ? pathKey + "::" : ""}${local}`;
        for (let n = 2; fns.has(id); n++) id = `${crateKey}::${pathKey ? pathKey + "::" : ""}${local}#${n}`;
        const node: FnNode = {
          id,
          key: `${stem}::${local}`,
          crate: crateKey,
          file: rel,
          modPath: pathKey,
          fn,
          module: explicitFn.get(`${stem}::${fn.name}`) ?? (sharedDefault ? "" : mod ?? "platform"),
          sharedWith: [],
          layer,
          callees: new Set(),
          callers: new Set(),
          tables: new Map(),
          sqlFunctions: new Set(),
          handlerOf: [],
          backends: [],
        };
        fns.set(id, node);
        const byMod = index.get(crateKey) ?? new Map<string, FnNode[]>();
        index.set(crateKey, byMod);
        const k = `${pathKey}|${local}`;
        byMod.set(k, [...(byMod.get(k) ?? []), node]);
      }
      for (const type of parsed.types) {
        const pathKey = modPath.startsWith("bin::") ? "" : modPath;
        let id = `${crateKey}::${pathKey ? pathKey + "::" : ""}${type.name}`;
        for (let n = 2; types.some((t) => t.id === id); n++) id = `${crateKey}::${pathKey ? pathKey + "::" : ""}${type.name}#${n}`;
        types.push({ id, crate: crateKey, modPath: pathKey, type, file: rel, module: sharedDefault ?? mod ?? "platform", dto: /(_struct|structs)\.rs$/.test(rel) });
      }
    }
  }

  const libNames = new Map(cm.crates.map((c) => [c.lib, c.lib]));
  const modPaths = new Map<string, Set<string>>();
  for (const { crate, modPath } of parsedFiles.values()) {
    const set = modPaths.get(crate) ?? new Set<string>();
    set.add(modPath);
    modPaths.set(crate, set);
  }
  const lookup = (crate: string, segs: string[]): FnNode | null => {
    const byMod = index.get(crate);
    if (!byMod || segs.length === 0) return null;
    for (let cut = segs.length - 1; cut >= 0; cut--) {
      const mp = segs.slice(0, cut).join("::");
      if (!modPaths.get(crate)?.has(mp)) continue;
      const rest = segs.slice(cut).join("::");
      const hit = byMod.get(`${mp}|${rest}`);
      if (hit?.length) return hit[0];
    }
    return null;
  };
  const resolve = (from: FnNode, raw: string[]): FnNode | null => {
    const file = parsedFiles.get(from.file)!;
    let segs = [...raw];
    if (segs[0] === "Self" && from.fn.implType) segs = [from.fn.implType, ...segs.slice(1)];
    const use = file.parsed.uses.get(segs[0]);
    if (use) segs = [...use, ...segs.slice(1)];
    let crate = from.crate;
    const libCrate = crate.split("/")[0];
    if (segs[0] === "crate") {
      segs = segs.slice(1);
      if (crate.includes("/")) crate = libCrate;
    } else if (segs[0] === "self") segs = [...(from.modPath ? from.modPath.split("::") : []), ...segs.slice(1)];
    else if (segs[0] === "super") segs = [...from.modPath.split("::").slice(0, -1), ...segs.slice(1)];
    else if (libNames.has(segs[0])) {
      crate = segs[0];
      segs = segs.slice(1);
    } else {
      const local = lookup(crate, [...(from.modPath ? from.modPath.split("::") : []), ...segs]);
      if (local) return local;
      if (crate.includes("/")) {
        const own = lookup(crate, segs);
        if (own) return own;
      }
      for (const glob of file.parsed.globs) {
        let g = [...glob];
        let gc = crate;
        if (g[0] === "crate") g = g.slice(1);
        else if (libNames.has(g[0])) {
          gc = g[0];
          g = g.slice(1);
        } else if (g[0] === "super") g = [...from.modPath.split("::").slice(0, -1), ...g.slice(1)];
        const hit = lookup(gc, [...g, ...segs]);
        if (hit) return hit;
      }
      crate = libCrate;
    }
    return lookup(crate, segs);
  };

  const routes: RouteNode[] = [];
  for (const node of fns.values()) {
    for (const call of node.fn.calls) {
      const target = resolve(node, call);
      if (target && target.id !== node.id) {
        node.callees.add(target.id);
        target.callers.add(node.id);
      }
    }
    for (const reg of node.fn.routes) {
      for (const m of reg.methods) {
        const handler = m.handler ? resolve(node, m.handler) : null;
        const route: RouteNode = {
          id: `${m.method} ${reg.path}`,
          method: m.method,
          path: reg.path,
          handler: handler?.id ?? null,
          owner: node.id,
          module: "",
          file: node.file,
          line: reg.line,
          frontend: [],
          api: null,
        };
        routes.push(route);
        if (handler) {
          handler.handlerOf.push(route);
          handler.layer = "api";
          node.callees.add(handler.id);
          handler.callers.add(node.id);
        }
      }
    }
  }

  // Shared files: infer each function's module from its callers, falling back to the file default.
  const known = (n: FnNode) => n.module !== "";
  const assign = (n: FnNode, force: boolean) => {
    const callerMods = new Set<string>();
    let unresolved = false;
    for (const c of n.callers) {
      const caller = fns.get(c)!;
      if (n.handlerOf.some((r) => r.owner === c)) continue;
      if (known(caller)) callerMods.add(caller.module);
      else unresolved = true;
    }
    for (const r of n.handlerOf) {
      const owner = fns.get(r.owner)!;
      if (known(owner)) callerMods.add(owner.module);
      else unresolved = true;
    }
    if (unresolved && !force) return false;
    const fallback = shared.get(n.file) ?? "platform";
    if (callerMods.size === 1) n.module = [...callerMods][0];
    else {
      n.module = fallback;
      n.sharedWith = [...callerMods].filter((m) => m !== fallback).sort();
    }
    return true;
  };
  let pending = [...fns.values()].filter((n) => !known(n));
  while (pending.length) {
    const before = pending.length;
    pending = pending.filter((n) => !assign(n, false));
    // A cycle among shared functions: settle one with the callers known so far, then continue.
    if (pending.length === before) assign(pending.shift()!, true);
  }
  for (const r of routes) r.module = fns.get(r.owner)!.module;

  // Backend services: every binary (`src/bin/*.rs`, `src/main.rs`) and what its entry point reaches.
  const backends: Model["backends"] = [];
  const entryFiles = new Map<string, FnNode[]>();
  const crateOf = (file: string) => cm.crates.find((c) => file === `${c.dir}/src/main.rs` || file.startsWith(`${c.dir}/src/bin/`));
  for (const n of fns.values()) {
    const crate = crateOf(n.file);
    if (crate && (n.file === `${crate.dir}/src/main.rs` || /^[^/]+\.rs$/.test(n.file.slice(`${crate.dir}/src/bin/`.length)))) entryFiles.set(n.file, [...(entryFiles.get(n.file) ?? []), n]);
  }
  for (const [file, entry] of [...entryFiles].sort(([a], [b]) => a.localeCompare(b))) {
    const crate = crateOf(file)!;
    const crateName = basename(crate.dir).replace(/-/g, "_");
    let id = basename(file, ".rs");
    if (id === "main") {
      // With `mainName: "build-app"`, main.rs is named after the `build_<x>_app` it starts.
      const app = crate.mainName === "build-app" ? entry.flatMap((n) => [...n.callees]).map((c) => /(?:^|::)build_(\w+)_app$/.exec(fns.get(c)?.key ?? "")?.[1]).find(Boolean) : null;
      id = app ? `${app}_backend` : crateName;
    }
    backends.push({ id, file });
    const seen = new Set<string>();
    const queue = entry.map((n) => n.id);
    while (queue.length) {
      const cur = queue.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      queue.push(...fns.get(cur)!.callees);
    }
    for (const fid of seen) fns.get(fid)!.backends.push(id);
  }

  // API shapes: resolve the handler's extractor and response types to struct definitions.
  const typeById = new Map(types.map((t) => [t.id, t]));
  const typesByName = new Map<string, TypeNode[]>();
  for (const t of types) if (t.type.kind !== "trait") typesByName.set(t.type.name, [...(typesByName.get(t.type.name) ?? []), t]);
  const jsonWrappers = new Set(["Json", ...types.filter((t) => t.type.alias && /\bJson\s*</.test(t.type.alias) && t.type.generics).map((t) => t.type.name)]);
  const resolveType = (file: string, path: string): TypeNode | null => {
    const segs = path.split("::");
    const name = segs[segs.length - 1];
    const cands = typesByName.get(name);
    if (!cands?.length) return null;
    const ctx = parsedFiles.get(file);
    if (!ctx) return cands[0];
    const used = segs.length === 1 ? ctx.parsed.uses.get(name) : segs;
    if (used) {
      const mp = used.filter((s) => s !== "crate" && s !== "self" && !libNames.has(s)).slice(0, -1).join("::");
      const hit = cands.find((t) => t.modPath === mp) ?? cands.find((t) => mp.endsWith(t.modPath) && t.modPath);
      if (hit) return hit;
    }
    return cands.find((t) => t.file === file) ?? cands.find((t) => t.crate === ctx.crate) ?? cands.find((t) => t.crate === ctx.crate.split("/")[0]) ?? cands[0];
  };
  const typeRefs = (file: string, text: string): TypeNode[] => {
    const out: TypeNode[] = [];
    for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*/g)) {
      const last = m[0].split("::").pop()!;
      if (!/^[A-Z]/.test(last) || BUILTIN_TYPES.has(last) || jsonWrappers.has(last)) continue;
      const t = resolveType(file, m[0]);
      if (t && !out.includes(t)) out.push(t);
    }
    return out;
  };
  const genericArg = (text: string, wrapper: string): string | null => {
    const m = new RegExp(`(?:^|[^A-Za-z0-9_])${wrapper}\\s*<`).exec(text);
    if (!m) return null;
    let depth = 0;
    const start = m.index + m[0].length;
    for (let i = start - 1; i < text.length; i++) {
      if (text[i] === "<") depth++;
      else if (text[i] === ">" && text[i - 1] !== "-" && --depth === 0) return text.slice(start, i).trim();
    }
    return null;
  };
  for (const r of routes) {
    const h = r.handler ? fns.get(r.handler) : undefined;
    if (!h) continue;
    const sig = h.fn.signature;
    const arrow = sig.lastIndexOf(") ->");
    const params = arrow >= 0 ? sig.slice(0, arrow + 1) : sig;
    const ret = arrow >= 0 ? sig.slice(arrow + 4) : "";
    const json = genericArg(params, "Json");
    const form = genericArg(params, "Form");
    let response: string | null = null;
    for (const w of jsonWrappers) response ??= genericArg(ret, w);
    let responseNote: string | null = null;
    if (!response) {
      if (/\b(Redirect)\b/.test(ret)) responseNote = "重定向";
      else if (/\bSse\b/.test(ret)) responseNote = "SSE 事件流";
      else if (/\bHtml\b/.test(ret)) responseNote = "HTML";
      else if (/\bResponse\b/.test(ret)) responseNote = "处理函数自行构造响应（JSON、文件或重定向），见代码";
      else if (/\bStatusCode\b/.test(ret)) responseNote = "只返回 HTTP 状态码，无响应体";
      else if (ret.trim()) responseNote = `返回 \`${ret.trim()}\``;
    } else if (/^(?:serde_json::)?Value$/.test(response)) responseNote = "动态 JSON（serde_json::Value），结构见处理函数代码";
    const shape: ApiShape = {
      path: genericArg(params, "Path"),
      query: genericArg(params, "Query"),
      body: json ?? form,
      bodyKind: json ? "json" : form ? "form" : /\bMultipart\b/.test(params) ? "multipart" : null,
      response,
      responseNote,
      types: [],
    };
    // Direct types first, then everything their fields reach.
    const queue: TypeNode[] = [];
    for (const text of [shape.path, shape.query, shape.body, shape.response]) if (text) queue.push(...typeRefs(h.file, text));
    const seen = new Set<string>();
    while (queue.length && seen.size < 60) {
      const t = queue.shift()!;
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      for (const f of t.type.fields) queue.push(...typeRefs(t.file, f.type));
      for (const v of t.type.variants) for (const x of [...v.tuple, ...v.fields.map((f) => f.type)]) queue.push(...typeRefs(t.file, x));
      for (const x of t.type.tuple) queue.push(...typeRefs(t.file, x));
    }
    shape.types = [...seen];
    r.api = shape;
  }

  // Database: replay migrations, then attach SQL literals to tables and SQL functions.
  const schema = migrationSchema(root, cm);
  const schemaModule = new Map<string, string>();
  for (const m of modules) for (const s of m.schemas) schemaModule.set(s, m.id);
  const tableModule = new Map<string, string>();
  for (const [key, t] of schema.tables) tableModule.set(key, schemaModule.get(t.schema) ?? "platform");
  const functionModule = new Map<string, string>();
  for (const [key, f] of schema.functions) functionModule.set(key, schemaModule.get(f.schema) ?? "platform");
  const byName = new Map<string, string[]>();
  for (const [key, t] of schema.tables) byName.set(t.name, [...(byName.get(t.name) ?? []), key]);
  const fnByName = new Map<string, string[]>();
  for (const [key, f] of schema.functions) fnByName.set(f.name, [...(fnByName.get(f.name) ?? []), key]);
  const moduleSchemas = new Map(modules.map((m) => [m.id, new Set(m.schemas)]));

  const tableUsers = new Map<string, { fn: string; write: boolean }[]>();
  const sqlFunctionUsers = new Map<string, string[]>();
  for (const node of fns.values()) {
    const prefer = moduleSchemas.get(node.module) ?? new Set<string>();
    const pick = (cands: string[] | undefined, get: (k: string) => { schema: string } | undefined) => {
      if (!cands?.length) return null;
      return cands.find((k) => prefer.has(get(k)!.schema)) ?? cands[0];
    };
    const resolveTable = (name: string) => {
      const n = name.toLowerCase();
      if (n.includes(".")) return schema.tables.has(n) ? n : null;
      return pick(byName.get(n), (k) => schema.tables.get(k));
    };
    const resolveFunction = (name: string) => {
      const n = name.toLowerCase();
      if (n.includes(".")) return schema.functions.has(n) ? n : null;
      return pick(fnByName.get(n), (k) => schema.functions.get(k));
    };
    for (const sql of node.fn.sql) {
      const refs = sqlRefs(sql, resolveTable, resolveFunction);
      for (const t of refs.tables) node.tables.set(t.name, (node.tables.get(t.name) ?? false) || t.write);
      for (const f of refs.functions) node.sqlFunctions.add(f);
    }
    for (const [t, write] of node.tables) tableUsers.set(t, [...(tableUsers.get(t) ?? []), { fn: node.id, write }]);
    for (const f of node.sqlFunctions) sqlFunctionUsers.set(f, [...(sqlFunctionUsers.get(f) ?? []), node.id]);
  }

  // Frontend.
  const firstSegments = new Set(routes.map((r) => r.path.split("/")[1]).filter((s) => s && !s.startsWith("{") && !s.startsWith("<")));
  const front = new Map<string, FrontNode>();
  for (const base of cm.frontendRoots) {
    for (const abs of walkFiles(join(root, base), (p) => /\.(ts|tsx)$/.test(p) && !/(__tests__|\.test\.|\.spec\.|\.d\.ts$|\/locales\/)/.test(p))) {
      const rel = relative(root, abs);
      const module = fileModule(rel, "frontend");
      if (!module) unassigned.frontend.push(rel);
      front.set(rel, { file: rel, module, parsed: parseFront(readFileSync(abs, "utf8"), firstSegments), uses: [], imports: [] });
    }
  }
  const resolveImport = (fromFile: string, spec: string) => {
    if (!spec.startsWith(".")) return null;
    const base = join(dirname(fromFile), spec);
    for (const cand of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) if (front.has(cand)) return cand;
    return null;
  };
  const matchRoute = (path: string, method: string | null) => {
    // Keep the closest routes: `/drive/files/deleted` hits the literal route, `/drive/files/${id}` the `{file_id}` one.
    const fit = (r: RouteNode) => {
      const f = path.split("/").filter(Boolean);
      return r.path.split("/").filter(Boolean).reduce((s, seg, i) => {
        const param = seg.startsWith("{") || seg.startsWith(":");
        return s + ((param && f[i] === "{}") || (!param && f[i] === seg) ? 1 : 0);
      }, 0);
    };
    const closest = (rs: RouteNode[]) => {
      const best = Math.max(0, ...rs.map(fit));
      return rs.filter((r) => fit(r) === best);
    };
    const all = routes.filter((r) => pathMatches(path, r.path));
    const byMethod = all.filter((r) => r.method === (method ?? "GET"));
    if (byMethod.length || method) return closest(byMethod);
    return closest(all);
  };
  for (const node of front.values()) {
    for (const cf of node.parsed.clientFns) {
      for (const call of cf.calls) for (const r of matchRoute(call.path, call.method)) r.frontend.push({ file: node.file, fn: cf.name });
    }
    for (const call of node.parsed.looseCalls) for (const r of matchRoute(call.path, call.method)) r.frontend.push({ file: node.file, fn: null });
    for (const im of node.parsed.imports) {
      const target = resolveImport(node.file, im.from);
      if (!target) continue;
      if (!node.imports.includes(target)) node.imports.push(target);
      const t = front.get(target)!;
      for (const name of im.names) if (t.parsed.clientFns.some((f) => f.name === name)) node.uses.push({ file: target, fn: name });
    }
    for (const spec of node.parsed.lazyImports.values()) {
      const target = resolveImport(node.file, spec);
      if (target && !node.imports.includes(target)) node.imports.push(target);
    }
  }
  for (const r of routes) {
    const seen = new Set<string>();
    r.frontend = r.frontend.filter((f) => {
      const k = `${f.file}|${f.fn}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  const frontRoutes: Model["frontRoutes"] = [];
  for (const node of front.values()) {
    for (const r of node.parsed.routes) {
      const comp = r.component.split(".")[0];
      let target: string | null = null;
      const lazy = node.parsed.lazyImports.get(comp);
      if (lazy) target = resolveImport(node.file, lazy);
      if (!target) {
        const im = node.parsed.imports.find((i) => i.names.includes(comp) || i.names.includes(`default:${comp}`));
        if (im) target = resolveImport(node.file, im.from);
      }
      if (!target && node.parsed.exports.includes(comp)) target = node.file;
      frontRoutes.push({ path: r.path, component: r.component, file: node.file, target, module: target ? front.get(target)?.module ?? null : node.module, line: r.line });
    }
  }

  return { root, modules, fns, routes, types, typeById, typeRefs, schema, tableModule, functionModule, tableUsers, sqlFunctionUsers, front, frontRoutes, backends, unassigned };
}

export function clientFnsOf(model: Model, file: string): ClientFn[] {
  return model.front.get(file)?.parsed.clientFns ?? [];
}
export type { Table, SqlFunction };
