// VibeDoc local server: rule board, feature document, code map and relationship graph for one repository,
// on http://127.0.0.1:<port> (vibedoc.config.json `port`, PORT overrides; default 4870).
//   vibedoc serve        (run inside the repository, or set VIBEDOC_REPO)
// Listens on loopback only. Writes need the per-start token embedded in the served page.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, watch } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { buildModel, loadModules } from "./codemap/model.ts";
import { toJson } from "./codemap/json.ts";
import { RuleStore, LAYERS, outline, editableText, versionOf, kindsFor, type Layer, type RuleItem } from "./rules/store.ts";
import { findRoot, loadConfig } from "./config.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = findRoot();
let cfg = loadConfig(root);
const port = cfg.port;
const token = randomBytes(24).toString("hex");
const kinds = kindsFor(cfg);

// Configured modules plus any module that already has a rule or feature file.
const titles = () => {
  const map = new Map(loadModules(root, cfg).modules.map((m) => [m.id, m.title]));
  for (const s of [store, features]) for (const m of s?.modules() ?? []) if (!map.has(m)) map.set(m, m);
  return map;
};
const store: RuleStore = new RuleStore(root, new Map(), kinds.rules);
const features: RuleStore = new RuleStore(root, new Map(), kinds.features);
store.titles = features.titles = titles();

let codemap: string | null = null;
const codemapJson = () =>
  (codemap ??= JSON.stringify(cfg.codemap ? toJson(buildModel(root, cfg)) : { disabled: true, modules: [...titles()].map(([id, title]) => ({ id, title })) }));

const clients = new Set<ServerResponse>();
const emit = (event: string) => {
  for (const res of clients) res.write(`event: ${event}\ndata: {}\n\n`);
};

const debounce = (fn: () => void, ms: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
};
const refreshAll = (s: RuleStore, event: string) => () => {
  for (const m of s.modules()) {
    try {
      s.refresh(m);
    } catch (error) {
      console.error(`vibedoc: refresh ${s.kind.tag} ${m} failed: ${(error as Error).message}`);
    }
  }
  emit(event);
};
const onRules = debounce(refreshAll(store, "rules"), 250);
const onFeatures = debounce(refreshAll(features, "features"), 250);
const onCode = debounce(() => {
  codemap = null;
  cfg = { ...loadConfig(root), port };
  store.titles = features.titles = titles();
  emit("code");
}, 800);

// Watch a directory, or (until it exists) its nearest existing ancestor filtered to paths inside it.
const watchPath = (rel: string, cb: (file: string) => void) => {
  let dir = join(root, rel);
  while (!existsSync(dir) && dir !== root) dir = dirname(dir);
  if (!existsSync(dir)) return;
  const prefix = relative(dir, join(root, rel));
  watch(dir, { recursive: true }, (_e, file) => {
    if (!file) return;
    const f = String(file);
    if (!prefix) cb(f);
    else if (f === prefix || f.startsWith(`${prefix}/`)) cb(f.slice(prefix.length + 1));
  });
};
watchPath(cfg.rulesDir, (f) => f.endsWith(".md") && onRules());
watchPath(cfg.featuresDir, (f) => f.endsWith(".md") && onFeatures());
if (cfg.codemap) {
  const dirs = [...cfg.codemap.crates.map((c) => `${c.dir}/src`), ...(cfg.codemap.migrationsDir ? [cfg.codemap.migrationsDir] : []), ...cfg.codemap.frontendRoots, ...cfg.watch];
  for (const d of new Set(dirs)) watchPath(d, onCode);
}
if (cfg.modulesFile) watchPath(dirname(cfg.modulesFile), (f) => f === cfg.modulesFile!.split("/").pop() && onCode());
watchPath("vibedoc.config.json", () => onCode());

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

// Status changes the user may make from the board; the AI sets the others through rules/cli.ts and features/cli.ts.
const HUMAN_MOVES: Record<string, string[]> = { new: ["parked"], parked: ["new"], confirm: ["doing", "new"], modified: [], doing: [], done: [], released: [] };
const featureDoc = () => ({
  modules: features.modules().map((m) => {
    const text = features.read(m);
    return { module: m, title: store.titles.get(m) ?? m, ...outline(text), text: editableText(text, kinds.features), version: versionOf(text) };
  }),
  items: features.all().map(view),
});

async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) throw Object.assign(new Error("请求太大"), { status: 413 });
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

const send = (res: ServerResponse, status: number, data: unknown, type = "application/json; charset=utf-8") => {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(typeof data === "string" ? data : JSON.stringify(data));
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/") {
      const page = { name: cfg.name, rulesDir: cfg.rulesDir, featuresDir: cfg.featuresDir, codemap: !!cfg.codemap };
      const html = readFileSync(join(here, "web/index.html"), "utf8").replace("__BOARD_TOKEN__", token).replace('"__BOARD_CONFIG__"', JSON.stringify(page).replace(/</g, "\\u003c"));
      return send(res, 200, html, "text/html; charset=utf-8");
    }
    if (req.method === "GET" && url.pathname === "/api/health") return send(res, 200, { app: "vibedoc", name: cfg.name, root, pid: process.pid });
    if (req.method === "GET" && url.pathname === "/api/codemap") return send(res, 200, codemapJson());
    if (req.method === "GET" && url.pathname === "/api/rules") return send(res, 200, { items: store.all().map(view) });
    if (req.method === "GET" && url.pathname === "/api/features") return send(res, 200, featureDoc());
    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      res.write("retry: 2000\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (url.pathname.startsWith("/api/") && req.method !== "GET") {
      if (req.headers["x-board-token"] !== token) return send(res, 403, { error: "缺少或错误的看板令牌，请刷新页面" });
      const host = String(req.headers.host ?? "");
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return send(res, 403, { error: "只接受本机请求" });
      const data = await body(req);
      if (req.method === "POST" && url.pathname === "/api/shutdown") {
        send(res, 200, { success: true });
        console.log("VibeDoc: 收到停止请求，退出");
        setTimeout(() => process.exit(0), 100);
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/rules") {
        if (!titles().has(data.module)) return send(res, 400, { error: "未知模块" });
        if (!(LAYERS as readonly string[]).includes(data.layer)) return send(res, 400, { error: "未知层" });
        const item = store.add(data.module, data.layer as Layer, String(data.title ?? ""), String(data.body ?? ""), data.target ? String(data.target) : null);
        emit("rules");
        return send(res, 201, view(item));
      }
      if (req.method === "POST" && url.pathname === "/api/features") {
        if (!titles().has(data.module)) return send(res, 400, { error: "未知模块" });
        const item = features.add(data.module, String(data.section ?? ""), String(data.title ?? ""), String(data.body ?? ""), null);
        emit("features");
        return send(res, 201, view(item));
      }
      const featureDocPut = /^\/api\/features\/doc\/([a-z0-9_]+)$/.exec(url.pathname);
      if (req.method === "PUT" && featureDocPut) {
        if (!titles().has(featureDocPut[1])) return send(res, 400, { error: "未知模块" });
        features.replaceText(featureDocPut[1], String(data.text ?? ""), String(data.version ?? ""));
        emit("features");
        return send(res, 200, { success: true });
      }
      const featureEdit = /^\/api\/features\/([a-z0-9_]+-f\d+)$/.exec(url.pathname);
      if (req.method === "PUT" && featureEdit) {
        const item = features.edit(featureEdit[1], String(data.title ?? ""), String(data.body ?? ""));
        emit("features");
        return send(res, 200, view(item));
      }
      const featureMove = /^\/api\/features\/([a-z0-9_]+-f\d+)\/status$/.exec(url.pathname);
      if (req.method === "POST" && featureMove) {
        const current = features.find(featureMove[1]);
        if (!HUMAN_MOVES[current.effective]?.includes(data.status)) return send(res, 409, { error: "这个状态需要由 AI 设置" });
        const item = features.setStatus(featureMove[1], data.status);
        emit("features");
        return send(res, 200, view(item));
      }
      const edit = /^\/api\/rules\/([a-z0-9_]+-\d+)$/.exec(url.pathname);
      if (req.method === "PUT" && edit) {
        const item = store.edit(edit[1], String(data.title ?? ""), String(data.body ?? ""));
        emit("rules");
        return send(res, 200, view(item));
      }
      const move = /^\/api\/rules\/([a-z0-9_]+-\d+)\/status$/.exec(url.pathname);
      if (req.method === "POST" && move) {
        const current = store.find(move[1]);
        if (!HUMAN_MOVES[current.effective]?.includes(data.status)) return send(res, 409, { error: "这个状态需要由 AI 设置" });
        const item = store.setStatus(move[1], data.status);
        emit("rules");
        return send(res, 200, view(item));
      }
    }
    send(res, 404, { error: "not found" });
  } catch (error) {
    const e = error as Error & { status?: number };
    send(res, e.status ?? 400, { error: e.message });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`VibeDoc（${cfg.name}）: http://127.0.0.1:${port}  仓库 ${root}`);
});
