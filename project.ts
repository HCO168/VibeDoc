// One repository served by VibeDoc: its config, rule/feature/table stores, the rest of the document system,
// the code map cache, file watchers, live-event clients, and the per-project API (`/api/p/<id>/...`, prefix removed).
import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { join, dirname, relative, extname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildModel, loadModules } from "./codemap/model.ts";
import { toJson } from "./codemap/json.ts";
import { RuleStore, LAYERS, outline, editableText, versionOf, kindsFor, type DocKind, type Layer, type RuleItem } from "./rules/store.ts";
import { specOf, normalize, formatSpec, toSql } from "./tables/spec.ts";
import { DocSystem } from "./docs/store.ts";
import { syncAgents } from "./agents.ts";
import { loadConfig, type Config } from "./config.ts";
import { loadPlugins, pluginContext, pluginRules, type LoadedPlugin } from "./plugins.ts";

export const send = (res: ServerResponse, status: number, data: unknown, type = "application/json; charset=utf-8") => {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(typeof data === "string" || Buffer.isBuffer(data) ? data : JSON.stringify(data));
};

const view = (r: RuleItem) => ({
  id: r.id,
  module: r.module,
  layer: r.layer,
  section: r.section,
  title: r.title,
  body: r.body,
  status: r.status,
  effective: r.effective,
  target: r.meta?.target ?? null,
  date: r.meta?.date ?? null,
  impl: r.meta?.impl ?? [],
});
const tableView = (r: RuleItem) => {
  const spec = specOf(r);
  return { ...view(r), spec, sql: toSql(spec, r.id) };
};

// Status changes the user may make from the board; the AI sets the others through the `vibedoc` commands.
const HUMAN_MOVES: Record<string, string[]> = { new: ["parked"], parked: ["new"], confirm: ["doing", "new"], modified: [], doing: [], done: [], released: [] };
const MEDIA: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".pdf": "application/pdf" };

const debounce = (fn: () => void, ms: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
};

export class Project {
  id: string;
  root: string;
  cfg: Config;
  kinds: { rules: DocKind; features: DocKind; tables: DocKind };
  rules: RuleStore;
  features: RuleStore;
  tables: RuleStore;
  docs: DocSystem;
  plugins: LoadedPlugin[] = [];
  pluginErrors: string[] = [];
  // Resolves once the plugins are loaded; requests wait for it.
  ready: Promise<void>;
  private codemap: string | null = null;
  private clients = new Set<ServerResponse>();
  private watchers: FSWatcher[] = [];
  private pluginWatchers: FSWatcher[] = [];

  constructor(id: string, root: string) {
    this.id = id;
    this.root = root;
    this.cfg = loadConfig(root);
    this.kinds = kindsFor(this.cfg);
    this.rules = new RuleStore(root, new Map(), this.kinds.rules);
    this.features = new RuleStore(root, new Map(), this.kinds.features);
    // Table requests are filed per schema, so their files have no module title.
    this.tables = new RuleStore(root, new Map(), this.kinds.tables);
    this.docs = new DocSystem(root, this.cfg);
    this.rules.titles = this.features.titles = this.titles();
    this.watch();
    this.ready = this.loadPlugins();
  }

  private async loadPlugins() {
    const { plugins, errors } = await loadPlugins(this.root, this.cfg);
    for (const w of this.pluginWatchers) w.close();
    this.pluginWatchers = [];
    this.plugins = plugins;
    this.pluginErrors = errors;
    for (const e of errors) console.error(`vibedoc: ${this.id}: 插件加载失败：${e}`);
    for (const { plugin } of plugins) {
      for (const rel of plugin.watch ?? []) {
        const abs = join(this.root, rel);
        if (!existsSync(abs)) continue;
        const notify = debounce(() => this.emit("plugin", { name: plugin.name }), 400);
        try {
          this.pluginWatchers.push(watch(abs, { recursive: true }, () => notify()));
        } catch (error) {
          console.error(`vibedoc: ${this.id}: cannot watch ${rel}: ${(error as Error).message}`);
        }
      }
    }
  }
  private ctx(name: string) {
    return pluginContext(this.root, this.cfg, () => this.emit("plugin", { name }));
  }

  info() {
    const c = this.cfg;
    return {
      id: this.id, name: c.name, root: this.root, rulesDir: c.rulesDir, featuresDir: c.featuresDir, tablesDir: c.tablesDir,
      migrationsDir: c.codemap?.migrationsDir ?? null, codemap: !!c.codemap, docs: c.docs,
      agents: syncAgents(this.root, c, false, pluginRules(this.plugins)).filter((r) => r.state !== "unchanged").map((r) => r.file),
      plugins: this.plugins.map(({ plugin }) => ({ name: plugin.name, title: plugin.title ?? plugin.name, view: !!plugin.client })),
      pluginErrors: this.pluginErrors,
    };
  }

  // Configured modules plus any module that already has a rule or feature file.
  titles(): Map<string, string> {
    const map = new Map(loadModules(this.root, this.cfg).modules.map((m) => [m.id, m.title]));
    for (const s of [this.rules, this.features]) for (const m of s?.modules() ?? []) if (!map.has(m)) map.set(m, m);
    return map;
  }

  emit(event: string, data: unknown = {}) {
    for (const res of this.clients) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  close() {
    for (const w of [...this.watchers, ...this.pluginWatchers]) w.close();
    for (const res of this.clients) res.end();
  }

  private codemapJson() {
    return (this.codemap ??= JSON.stringify(
      this.cfg.codemap ? toJson(buildModel(this.root, this.cfg)) : { disabled: true, modules: [...this.titles()].map(([id, title]) => ({ id, title })) },
    ));
  }

  private watch() {
    const refreshAll = (s: RuleStore, event: string) => () => {
      for (const m of s.modules()) {
        try {
          s.refresh(m);
        } catch (error) {
          console.error(`vibedoc: ${this.id}: refresh ${s.kind.tag} ${m} failed: ${(error as Error).message}`);
        }
      }
      this.emit(event);
    };
    const onRules = debounce(refreshAll(this.rules, "rules"), 250);
    const onFeatures = debounce(refreshAll(this.features, "features"), 250);
    const onTables = debounce(refreshAll(this.tables, "tables"), 250);
    const onDocs = debounce(() => this.emit("docs"), 400);
    const onCode = debounce(() => {
      this.codemap = null;
      this.cfg = loadConfig(this.root);
      this.docs = new DocSystem(this.root, this.cfg);
      this.rules.titles = this.features.titles = this.titles();
      this.ready = this.loadPlugins();
      this.ready.then(() => this.emit("code"));
    }, 800);
    // Watch a directory, or (until it exists) its nearest existing ancestor filtered to paths inside it.
    const watchPath = (rel: string, cb: (file: string) => void) => {
      let dir = join(this.root, rel);
      while (!existsSync(dir) && dir !== this.root) dir = dirname(dir);
      if (!existsSync(dir)) return;
      const prefix = relative(dir, join(this.root, rel));
      try {
        this.watchers.push(watch(dir, { recursive: true }, (_e, file) => {
          if (!file) return;
          const f = String(file);
          if (!prefix) cb(f);
          else if (f === prefix || f.startsWith(`${prefix}/`)) cb(f.slice(prefix.length + 1));
        }));
      } catch (error) {
        console.error(`vibedoc: ${this.id}: cannot watch ${rel}: ${(error as Error).message}`);
      }
    };
    const cfg = this.cfg;
    watchPath(cfg.rulesDir, (f) => f.endsWith(".md") && onRules());
    watchPath(cfg.featuresDir, (f) => f.endsWith(".md") && onFeatures());
    watchPath(cfg.tablesDir, (f) => f.endsWith(".md") && onTables());
    for (const d of new Set([cfg.docs.root, cfg.docs.human])) watchPath(d, () => onDocs());
    if (cfg.codemap) {
      const dirs = [...cfg.codemap.crates.map((c) => `${c.dir}/src`), ...(cfg.codemap.migrationsDir ? [cfg.codemap.migrationsDir] : []), ...cfg.codemap.frontendRoots, ...cfg.watch];
      for (const d of new Set(dirs)) watchPath(d, onCode);
    }
    if (cfg.modulesFile) watchPath(dirname(cfg.modulesFile), (f) => f === cfg.modulesFile!.split("/").pop() && onCode());
    watchPath("vibedoc.config.json", () => onCode());
  }

  private featureDoc() {
    return {
      modules: this.features.modules().map((m) => {
        const text = this.features.read(m);
        return { module: m, title: this.rules.titles.get(m) ?? m, ...outline(text), text: editableText(text, this.kinds.features), version: versionOf(text) };
      }),
      items: this.features.all().map(view),
    };
  }

  // Requests under /api/p/<id>; `path` starts with "/". Writes arrive authenticated; `data` is parsed JSON,
  // or the raw bytes for an upload.
  handle(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams, data: any): void {
    const { rules, features, tables, docs } = this;
    const plug = /^\/plugins\/([a-z0-9-]+)\/(.+)$/.exec(path);
    if (plug) return this.handlePlugin(req, res, plug[1], plug[2], query, data);
    if (req.method === "GET") {
      if (path === "/codemap") return send(res, 200, this.codemapJson());
      if (path === "/rules") return send(res, 200, { items: rules.all().map(view) });
      if (path === "/features") return send(res, 200, this.featureDoc());
      if (path === "/tables") return send(res, 200, { items: tables.all().map(tableView) });
      if (path === "/docs") return send(res, 200, docs.overview());
      if (path === "/docs/changelogs") return send(res, 200, { items: docs.changelogs(Number(query.get("limit") ?? 400)) });
      if (path === "/docs/file") {
        const rel = query.get("path") ?? "";
        return send(res, 200, { path: rel, text: docs.readFile(rel) });
      }
      if (path === "/docs/raw") {
        const abs = docs.safePath(query.get("path") ?? "");
        const type = MEDIA[extname(abs).toLowerCase()];
        if (!type || !existsSync(abs)) return send(res, 404, { error: "文件不存在" });
        res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" });
        return void res.end(readFileSync(abs));
      }
      if (path === "/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
        res.write("retry: 2000\n\n");
        this.clients.add(res);
        req.on("close", () => this.clients.delete(res));
        return;
      }
      return send(res, 404, { error: "not found" });
    }
    const known = (module: unknown) => typeof module === "string" && this.titles().has(module);
    const done = (event: string, status: number, body: unknown) => {
      this.emit(event);
      send(res, status, body);
    };
    // ---------- documents ----------
    const answer = /^\/docs\/questions\/(\d+)\/answer$/.exec(path);
    if (req.method === "POST" && answer) {
      docs.answerQuestion(Number(answer[1]), String(data.answer ?? ""));
      return done("docs", 200, { success: true });
    }
    if (req.method === "POST" && path === "/docs/requests") return done("docs", 201, { path: docs.saveRequest(String(data.name ?? ""), String(data.text ?? "")) });
    if (req.method === "POST" && path === "/docs/sketches") return done("docs", 201, { path: docs.saveSketch(query.get("name") ?? "", data as Buffer) });
    if (req.method === "POST" && path === "/docs/todo") {
      docs.addTodo(String(data.section ?? ""), String(data.item ?? ""));
      return done("docs", 201, { success: true });
    }
    // ---------- rules ----------
    if (req.method === "POST" && path === "/rules") {
      if (!known(data.module)) return send(res, 400, { error: "未知模块" });
      if (!(LAYERS as readonly string[]).includes(data.layer)) return send(res, 400, { error: "未知层" });
      return done("rules", 201, view(rules.add(data.module, data.layer as Layer, String(data.title ?? ""), String(data.body ?? ""), data.target ? String(data.target) : null)));
    }
    // ---------- features ----------
    if (req.method === "POST" && path === "/features") {
      if (!known(data.module)) return send(res, 400, { error: "未知模块" });
      return done("features", 201, view(features.add(data.module, String(data.section ?? ""), String(data.title ?? ""), String(data.body ?? ""), null)));
    }
    const docPut = /^\/features\/doc\/([a-z0-9_]+)$/.exec(path);
    if (req.method === "PUT" && docPut) {
      if (!known(docPut[1])) return send(res, 400, { error: "未知模块" });
      features.replaceText(docPut[1], String(data.text ?? ""), String(data.version ?? ""));
      return done("features", 200, { success: true });
    }
    // ---------- table requests: the board sends a structured spec and the server writes the Markdown ----------
    if (req.method === "POST" && path === "/tables/preview") {
      const spec = normalize(data.spec, false);
      return send(res, 200, { sql: toSql(spec, data.id ? String(data.id) : null), body: formatSpec(spec).body });
    }
    if (req.method === "POST" && path === "/tables") {
      const spec = normalize(data.spec);
      const { section, title, body } = formatSpec(spec);
      return done("tables", 201, tableView(tables.add(spec.schema, section, title, body, null)));
    }
    const tableEdit = /^\/tables\/([a-z0-9_]+-t\d+)$/.exec(path);
    if (req.method === "PUT" && tableEdit) {
      const current = tables.find(tableEdit[1]);
      // A request stays in its schema file and section; only the table name and content change.
      const spec = normalize({ ...data.spec, schema: current.module, op: specOf(current).op });
      const { title, body } = formatSpec(spec);
      return done("tables", 200, tableView(tables.edit(tableEdit[1], title, body)));
    }
    if (req.method === "DELETE" && tableEdit) {
      const current = tables.find(tableEdit[1]);
      if (!["new", "parked"].includes(current.effective)) return send(res, 409, { error: "AI 已经处理过这条，不能删除；不需要了可以搁置" });
      tables.remove(tableEdit[1]);
      return done("tables", 200, { success: true });
    }
    // ---------- shared edit / status for rules, features and tables ----------
    const edit = /^\/(rules|features)\/([a-z0-9_]+-f?\d+)$/.exec(path);
    if (req.method === "PUT" && edit) {
      const s = edit[1] === "rules" ? rules : features;
      return done(edit[1], 200, view(s.edit(edit[2], String(data.title ?? ""), String(data.body ?? ""))));
    }
    const move = /^\/(rules|features|tables)\/([a-z0-9_]+-[ft]?\d+)\/status$/.exec(path);
    if (req.method === "POST" && move) {
      const s = move[1] === "rules" ? rules : move[1] === "features" ? features : tables;
      const current = s.find(move[2]);
      if (!HUMAN_MOVES[current.effective]?.includes(data.status)) return send(res, 409, { error: "这个状态需要由 AI 设置" });
      const item = s.setStatus(move[2], data.status);
      return done(move[1], 200, move[1] === "tables" ? tableView(item) : view(item));
    }
    send(res, 404, { error: "not found" });
  }

  // /plugins/<name>/client.js serves the plugin's browser script; other routes go to its get/post handlers.
  private handlePlugin(req: IncomingMessage, res: ServerResponse, name: string, route: string, query: URLSearchParams, data: any) {
    const loaded = this.plugins.find((p) => p.plugin.name === name);
    if (!loaded) return send(res, 404, { error: `没有插件 ${name}` });
    const { plugin, dir } = loaded;
    if (req.method === "GET" && route === "client.js") {
      if (!plugin.client) return send(res, 404, { error: "这个插件没有页面" });
      return send(res, 200, readFileSync(join(dir, plugin.client), "utf8"), "text/javascript; charset=utf-8");
    }
    const handler = req.method === "GET" ? plugin.get?.[route] : req.method === "POST" ? plugin.post?.[route] : undefined;
    if (!handler) return send(res, 404, { error: `插件 ${name} 没有 ${req.method} ${route}` });
    Promise.resolve()
      .then(() => handler(req.method === "GET" ? query : data, this.ctx(name)))
      .then((result) => send(res, 200, result ?? { success: true }))
      .catch((error) => send(res, (error as { status?: number }).status ?? 400, { error: (error as Error).message }));
  }
}
