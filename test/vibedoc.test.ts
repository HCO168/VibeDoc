// End-to-end tests: every command and every board API against throwaway repositories.
//   node --test test/
// Nothing outside the temp directory is touched: the project registry lives in a temp XDG_CONFIG_HOME.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "vibedoc-test-"));
const env = { ...process.env, XDG_CONFIG_HOME: join(tmp, "xdg"), VIBEDOC_REPO: "" };
delete (env as Record<string, string | undefined>).VIBEDOC_REPO;
const A = join(tmp, "alpha");
const B = join(tmp, "beta");

function vibedoc(cwd: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [join(HOME, "vibedoc.ts"), ...args], { cwd, env, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const read = (path: string) => readFileSync(path, "utf8");

// alpha: a Rust + SQL + React project with a code map and a plugin; beta: documents only.
function makeAlpha() {
  mkdirSync(A, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: A });
  assert.equal(vibedoc(A, "init", "--name", "Alpha").code, 0);
  const cfg = JSON.parse(read(join(A, "vibedoc.config.json")));
  Object.assign(cfg, {
    modules: { items: "条目" },
    modulesFile: "doc/modules/modules.yaml",
    plugins: ["tools/hello/plugin.ts"],
    codemap: { outDir: "doc/modules", crates: [{ dir: "backend/api", lib: "api" }], migrationsDir: "backend/migrations", frontendRoots: ["frontend/src"] },
  });
  write(join(A, "vibedoc.config.json"), JSON.stringify(cfg, null, 2));
  write(join(A, "doc/modules/modules.yaml"), "modules:\n  items:\n    title: 条目\n    backend: [backend/api/src/**]\n    frontend: [frontend/src/**]\n    schemas: [shop]\n");
  write(join(A, "backend/api/Cargo.toml"), '[package]\nname = "api"\n');
  write(join(A, "backend/api/src/lib.rs"), [
    "use axum::{routing::get, Router, Json};",
    "pub mod items;",
    "/// 组装路由。",
    "pub fn build_app() -> Router {",
    '    Router::new().route("/items", get(items::list_items))',
    "}",
  ].join("\n"));
  write(join(A, "backend/api/src/items.rs"), [
    "use axum::Json;",
    "use serde::Serialize;",
    "#[derive(Serialize)]",
    "pub struct ItemDto {",
    "    pub id: i64,",
    "    pub title: String,",
    "}",
    "/// 列出全部条目。",
    "pub async fn list_items() -> Json<Vec<ItemDto>> {",
    '    let _ = sqlx::query("SELECT id, title FROM shop.items");',
    "    Json(vec![])",
    "}",
  ].join("\n"));
  write(join(A, "backend/api/src/main.rs"), "fn main() { let _ = api::build_app(); }\n");
  write(join(A, "backend/migrations/shop/0001_items.sql"), "CREATE TABLE shop.items (id BIGINT PRIMARY KEY, title TEXT NOT NULL);\n");
  write(join(A, "frontend/src/api.ts"), "const API = 'https://api.example.com';\nexport async function listItems() {\n  return (await fetch(`${API}/items`)).json();\n}\n");
  write(join(A, "frontend/src/App.tsx"), 'import { Route } from "react-router-dom";\nimport ItemsPage from "./ItemsPage";\nexport default function App() { return <Route path="/items" element={<ItemsPage />} />; }\n');
  write(join(A, "frontend/src/ItemsPage.tsx"), 'import { listItems } from "./api";\nexport default function ItemsPage() { listItems(); return null; }\n');
  write(join(A, "tools/hello/plugin.ts"), [
    'import { writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    "export default {",
    '  name: "hello", title: "问候", client: "client.js", watch: ["hello.txt"],',
    '  rules: "- Say hello in `hello.txt` with `vibedoc hello <名字>`.",',
    '  commands: { hello: { describe: "写问候", run(args, ctx) { writeFileSync(join(ctx.root, "hello.txt"), `你好 ${args[0]}`); console.log("done"); } } },',
    '  get: { greeting: (q, ctx) => ({ to: q.get("to") ?? "世界", name: ctx.cfg.name }) },',
    '  post: { greet: (data, ctx) => { writeFileSync(join(ctx.root, "hello.txt"), `你好 ${data.name}`); ctx.notify(); return { ok: true }; } },',
    "};",
  ].join("\n"));
  write(join(A, "tools/hello/client.js"), 'VibeDoc.registerView("hello", (vd) => vd.h("div", {}, "hello"));\n');
  // Plugins and the code map were added after init, so the rule block must be synced again.
  assert.equal(vibedoc(A, "agents", "check").code, 1);
  vibedoc(A, "agents", "sync");
}

let server: ChildProcess;
let base = "";
let token = "";
async function api(method: string, path: string, data?: unknown, withToken = true) {
  const res = await fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json", ...(withToken ? { "X-Board-Token": token } : {}) }, body: data === undefined ? undefined : JSON.stringify(data) });
  const text = await res.text();
  let json: any = text;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json };
}

before(async () => {
  makeAlpha();
  mkdirSync(B, { recursive: true });
  assert.equal(vibedoc(B, "init", "--name", "Beta").code, 0);
  const port = 47000 + Math.floor(Math.random() * 1000);
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [join(HOME, "server.ts")], { cwd: tmp, env: { ...env, PORT: String(port) }, stdio: "pipe" });
  for (let i = 0; i < 100; i++) {
    try {
      const html = await (await fetch(`${base}/`)).text();
      token = /(?:const|let) TOKEN = "([a-f0-9]+)"/.exec(html)![1];
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  assert.ok(token, "server did not start");
});
after(() => {
  server?.kill();
  rmSync(tmp, { recursive: true, force: true });
});

test("init scaffolds the document tree, rule blocks and registry", () => {
  for (const f of ["CLAUDE.md", "AGENTS.md", "doc/AGENTS.md", "doc/README.md", "doc/human/open_questions.md", "doc/human/rules/README.md", "doc/features/README.md", "doc/table-changes/README.md", "doc/todo.md", "doc/totest/AGENTS.md", "doc/change_logs/README.md"]) {
    assert.ok(existsSync(join(B, f)), f);
  }
  assert.match(read(join(B, "AGENTS.md")), /<!-- vibedoc:rules:begin[\s\S]*`dev` → `main`[\s\S]*<!-- vibedoc:rules:end -->/);
  assert.doesNotMatch(read(join(B, "doc/README.md")), /\{\{/);
  assert.match(vibedoc(B, "projects").out, /alpha[\s\S]*beta/);
});

test("agents sync keeps project text, follows config and plugin rules", () => {
  const path = join(B, "AGENTS.md");
  write(path, read(path).replace("（在这里写本项目特有的规则", "- 只属于 Beta 的规则\n（在这里写本项目特有的规则"));
  assert.equal(vibedoc(B, "agents", "check").code, 0);
  const cfgPath = join(B, "vibedoc.config.json");
  const cfg = JSON.parse(read(cfgPath));
  cfg.git.promotion = ["dev", "beta", "main"];
  write(cfgPath, JSON.stringify(cfg));
  assert.equal(vibedoc(B, "agents", "check").code, 1);
  assert.match(vibedoc(B, "agents", "sync").out, /AGENTS.md: 已更新/);
  assert.match(read(path), /`dev` → `beta` → `main`/);
  assert.match(read(path), /只属于 Beta 的规则/);
  assert.match(read(join(A, "AGENTS.md")), /vibedoc codemap generate[\s\S]*## Project Plugins[\s\S]*vibedoc hello/);
});

test("document commands: change logs, questions, todo, totest", () => {
  const log = vibedoc(B, "changelog", "new", "--role", "tester", "--slug", "first").out.trim();
  assert.match(log, /^doc\/change_logs\/\d{4}-\d{2}-\d{2}\/\d{6}_tester_first\.md$/);
  assert.match(read(join(B, log)), /### 变更内容[\s\S]*### 文档[\s\S]*### 验证/);
  assert.equal(vibedoc(B, "changelog", "new", "--role", "Bad Role", "--slug", "x").code, 1);
  assert.match(vibedoc(B, "changelog", "list").out, /tester\s+first/);
  vibedoc(B, "question", "add", "要不要深色模式？", "--body", "默认跟随系统");
  vibedoc(B, "question", "add", "是否允许匿名");
  assert.match(vibedoc(B, "question", "list").out, /1\. 要不要深色模式？[\s\S]*默认跟随系统[\s\S]*2\. 是否允许匿名/);
  vibedoc(B, "question", "resolve", "1");
  assert.doesNotMatch(read(join(B, "doc/human/open_questions.md")), /深色模式/);
  vibedoc(B, "todo", "add", "backlog", "支持导出");
  assert.equal(vibedoc(B, "todo", "add", "later", "x").code, 1);
  assert.match(vibedoc(B, "todo", "list").out, /## Backlog（1）\n- 支持导出/);
  write(join(B, "doc/totest/login.md"), "# 登录\n");
  assert.match(vibedoc(B, "totest", "list").out, /doc\/totest\/login\.md/);
});

test("rule, feature and table commands", () => {
  write(join(B, "doc/human/rules/app.md"), "# 应用\n\n## 后端\n\n### 登录失败五次锁定\n锁十分钟。\n");
  assert.match(vibedoc(B, "rules", "list").out, /app-1\s+新提出/);
  vibedoc(B, "rules", "confirm", "app-1");
  vibedoc(B, "rules", "start", "app-1");
  assert.match(vibedoc(B, "rules", "mark", "app-1", "--impl", "login").out, /已实现/);
  write(join(B, "doc/human/rules/app.md"), read(join(B, "doc/human/rules/app.md")).replace("锁十分钟。", "锁三十分钟。"));
  assert.match(vibedoc(B, "rules", "list").out, /app-1\s+已修改/);
  write(join(B, "doc/features/app.md"), "# 应用\n\n## 账号\n\n### 登录\n密码登录。\n");
  vibedoc(B, "features", "refresh");
  assert.match(vibedoc(B, "features", "set", "done", "app-f1").out, /已持久化/);
  assert.match(vibedoc(B, "features", "summary").out, /app\s+已持久化 1/);
  assert.equal(vibedoc(B, "features", "set", "bogus", "app-f1").code, 1);
});

test("plugins: listing, commands", () => {
  assert.match(vibedoc(A, "plugins").out, /hello（问候）[\s\S]*vibedoc hello/);
  assert.match(vibedoc(A, "hello", "小明").out, /done/);
  assert.equal(read(join(A, "hello.txt")), "你好 小明");
  assert.equal(vibedoc(A, "no-such-command").code, 1);
});

test("code map: routes, handlers, tables and frontend calls", () => {
  assert.match(vibedoc(A, "codemap", "route", "/items").out, /GET\s+\/items[\s\S]*list_items[\s\S]*列出全部条目/);
  assert.match(vibedoc(A, "codemap", "fn", "list_items").out, /shop\.items/);
  assert.equal(vibedoc(A, "codemap", "generate").code, 0);
  assert.ok(existsSync(join(A, "doc/modules/items/api.md")));
  assert.equal(vibedoc(B, "codemap", "generate").code, 1);
});

test("server: projects, health and token checks", async () => {
  const health = await api("GET", "/api/health");
  assert.equal(health.json.mode, "registry");
  const { json } = await api("GET", "/api/projects");
  const alpha = json.projects.find((p: any) => p.id === "alpha");
  const beta = json.projects.find((p: any) => p.id === "beta");
  assert.ok(alpha && beta);
  assert.equal(alpha.codemap, true);
  assert.equal(beta.codemap, false);
  assert.deepEqual(alpha.plugins, [{ name: "hello", title: "问候", view: true }]);
  assert.deepEqual(beta.agents, []);
  assert.equal((await api("POST", "/api/p/beta/rules", { module: "app", layer: "api", title: "x", body: "" }, false)).status, 403);
  assert.equal((await api("GET", "/api/p/nope/rules")).status, 404);
});

// A raw request, so Origin and Host can be set like a browser on another site would.
function raw(method: string, path: string, headers: Record<string, string>): Promise<{ status: number; headers: Record<string, any>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, { method, headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("hosted board: allowed origins, preflight and loopback-only hosts", async () => {
  const site = "https://vibedoc.hconet.com";
  // Off by default: a website gets no CORS access and no token.
  let r = await raw("GET", "/api/session", { Origin: site });
  assert.equal(r.status, 403);
  assert.equal(r.headers["access-control-allow-origin"], undefined);
  assert.equal(vibedoc(tmp, "web", "on").code, 0);
  r = await raw("GET", "/api/session", { Origin: site });
  assert.equal(r.status, 200);
  assert.equal(r.headers["access-control-allow-origin"], site);
  assert.equal(JSON.parse(r.body).token, token);
  assert.equal(JSON.parse(r.body).api, 1);
  const pre = await raw("OPTIONS", "/api/p/beta/rules", { Origin: site, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,x-board-token", "Access-Control-Request-Private-Network": "true" });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers["access-control-allow-private-network"], "true");
  assert.match(pre.headers["access-control-allow-headers"], /X-Board-Token/);
  // Other websites stay refused, and so does a request addressed to another host name (DNS rebinding).
  assert.equal((await raw("GET", "/api/projects", { Origin: "https://evil.example" })).status, 403);
  assert.equal((await raw("GET", "/api/p/alpha/rules", { Host: "evil.example:80" })).status, 403);
  assert.equal((await raw("GET", "/", { Host: "evil.example" })).status, 403);
  // The board page cannot be framed by another site.
  assert.equal((await raw("GET", "/", {})).headers["x-frame-options"], "DENY");
  // Self-hosted copies are added explicitly; plain http websites are rejected.
  assert.equal(vibedoc(tmp, "web", "on", "--origin", "https://board.example.org/x").code, 0);
  assert.equal((await raw("GET", "/api/session", { Origin: "https://board.example.org" })).status, 200);
  assert.equal(vibedoc(tmp, "web", "on", "--origin", "http://example.com").code, 1);
  assert.equal(vibedoc(tmp, "web", "off").code, 0);
  assert.equal((await raw("GET", "/api/session", { Origin: site })).status, 403);
});

test("server: rules board", async () => {
  const created = await api("POST", "/api/p/beta/rules", { module: "app", layer: "api", title: "分享链接 7 天过期", body: "可延长", target: null });
  assert.equal(created.status, 201);
  const id = created.json.id;
  assert.equal((await api("PUT", `/api/p/beta/rules/${id}`, { title: "分享链接 30 天过期", body: "可延长" })).json.title, "分享链接 30 天过期");
  assert.equal((await api("POST", `/api/p/beta/rules/${id}/status`, { status: "parked" })).json.effective, "parked");
  assert.equal((await api("POST", `/api/p/beta/rules/${id}/status`, { status: "done" })).status, 409);
  assert.equal((await api("POST", "/api/p/beta/rules", { module: "nope", layer: "api", title: "x" })).status, 400);
  assert.ok((await api("GET", "/api/p/beta/rules")).json.items.some((r: any) => r.id === id));
});

test("server: feature document", async () => {
  const f = await api("POST", "/api/p/beta/features", { module: "app", section: "待规划", title: "深色模式", body: "跟随系统" });
  assert.equal(f.status, 201);
  const doc = (await api("GET", "/api/p/beta/features")).json.modules.find((m: any) => m.module === "app");
  const text = doc.text.replace("### 登录\n密码登录。", "### 密码登录\n用户名或邮箱加密码。").replace("跟随系统", "跟随系统，可手动切换");
  assert.equal((await api("PUT", "/api/p/beta/features/doc/app", { text, version: doc.version })).status, 200);
  const items = (await api("GET", "/api/p/beta/features")).json.items;
  assert.equal(items.find((i: any) => i.title === "密码登录").effective, "modified"); // renamed in place keeps its state
  assert.equal(items.find((i: any) => i.title === "深色模式").effective, "new");
  assert.equal((await api("PUT", "/api/p/beta/features/doc/app", { text, version: doc.version })).status, 409); // stale version
});

test("server: table requests", async () => {
  const spec = { op: "create", schema: "shop", name: "orders", comment: "订单", columns: [{ name: "id", type: "uuid", pk: true }, { name: "total", type: "integer", notNull: true }], notes: "" };
  const preview = await api("POST", "/api/p/alpha/tables/preview", { spec });
  assert.match(preview.json.sql, /CREATE TABLE shop\.orders/);
  const created = await api("POST", "/api/p/alpha/tables", { spec });
  assert.equal(created.status, 201);
  assert.match(vibedoc(A, "tables", "show", created.json.id).out, /CREATE TABLE/);
  const edited = await api("PUT", `/api/p/alpha/tables/${created.json.id}`, { spec: { ...spec, comment: "订单，每次结算一张" } });
  assert.equal(edited.status, 200);
  assert.equal((await api("DELETE", `/api/p/alpha/tables/${created.json.id}`)).status, 200);
});

test("server: project documents", async () => {
  const docs = (await api("GET", "/api/p/beta/docs")).json;
  assert.equal(docs.questions.length, 1);
  assert.equal((await api("POST", `/api/p/beta/docs/questions/${docs.questions[0].n}/answer`, { answer: "允许，但要登录" })).status, 200);
  assert.match(vibedoc(B, "question", "list").out, /用户已答复[\s\S]*允许，但要登录/);
  assert.equal((await api("POST", "/api/p/beta/docs/todo", { section: "doing", item: "改登录页" })).status, 201);
  assert.equal((await api("POST", "/api/p/beta/docs/requests", { name: "分享", text: "我想要分享链接" })).status, 201);
  const up = await fetch(`${base}/api/p/beta/docs/sketches?name=login%20v1.png`, { method: "POST", headers: { "X-Board-Token": token }, body: new Uint8Array([137, 80, 78, 71]) });
  assert.equal(up.status, 201);
  assert.equal((await fetch(`${base}/api/p/beta/docs/raw?path=${encodeURIComponent("doc/human/ui-sketch/login v1.png")}`)).headers.get("content-type"), "image/png");
  const after = (await api("GET", "/api/p/beta/docs")).json;
  assert.ok(after.requests.some((f: any) => f.name === "分享.md"));
  assert.ok(after.sketches.some((f: any) => f.name === "login v1.png"));
  assert.ok(after.todo.find((s: any) => s.name === "In Progress").items.includes("改登录页"));
  assert.ok((await api("GET", "/api/p/beta/docs/changelogs")).json.items.length >= 1);
  assert.equal((await api("GET", `/api/p/beta/docs/file?path=${encodeURIComponent("doc/todo.md")}`)).status, 200);
  assert.equal((await api("GET", `/api/p/beta/docs/file?path=${encodeURIComponent("../../etc/passwd")}`)).status, 403);
  assert.equal((await api("GET", `/api/p/beta/docs/file?path=vibedoc.config.json`)).status, 403);
});

test("server: code map and plugin routes", async () => {
  const map = (await api("GET", "/api/p/alpha/codemap")).json;
  const route = map.routes.find((r: any) => r.path === "/items");
  assert.ok(route);
  assert.ok(route.frontend.some((f: any) => f.file === "frontend/src/api.ts" && f.fn === "listItems"), JSON.stringify(route.frontend));
  assert.ok(map.frontendRoutes.some((r: any) => r.path === "/items" && r.component === "ItemsPage"), JSON.stringify(map.frontendRoutes));
  assert.ok(map.tables.some((t: any) => t.key === "shop.items"));
  assert.equal((await api("GET", "/api/p/beta/codemap")).json.disabled, true);
  assert.deepEqual((await api("GET", "/api/p/alpha/plugins/hello/greeting?to=VibeDoc")).json, { to: "VibeDoc", name: "Alpha" });
  assert.equal((await api("POST", "/api/p/alpha/plugins/hello/greet", { name: "看板" })).json.ok, true);
  assert.equal(read(join(A, "hello.txt")), "你好 看板");
  const client = await fetch(`${base}/api/p/alpha/plugins/hello/client.js`);
  assert.match(await client.text(), /registerView\("hello"/);
  assert.equal((await api("GET", "/api/p/alpha/plugins/nope/x")).status, 404);
});

test("registry: add and remove follow into the running server", async () => {
  const C = join(tmp, "gamma");
  mkdirSync(C, { recursive: true });
  vibedoc(C, "init", "--name", "Gamma");
  for (let i = 0; i < 30 && !(await api("GET", "/api/projects")).json.projects.some((p: any) => p.id === "gamma"); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok((await api("GET", "/api/projects")).json.projects.some((p: any) => p.id === "gamma"));
  assert.match(vibedoc(tmp, "remove", "gamma").out, /已移除/);
  for (let i = 0; i < 30 && (await api("GET", "/api/projects")).json.projects.some((p: any) => p.id === "gamma"); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(!(await api("GET", "/api/projects")).json.projects.some((p: any) => p.id === "gamma"));
});

test("adding things: modules, plugins and documents from the board and the CLI", async () => {
  // Module into modules.yaml (alpha): inserted first under modules:, and immediately known.
  const mod = await api("POST", "/api/p/alpha/modules", { id: "billing", title: "计费: 账单", backend: ["backend/api/src/billing*"], schemas: ["billing"] });
  assert.equal(mod.status, 201);
  assert.match(read(join(A, "doc/modules/modules.yaml")), /^modules:\n  billing:\n    title: "计费 账单"|^modules:\n  billing:\n    title: "计费: 账单"/m);
  assert.equal((await api("POST", "/api/p/alpha/modules", { id: "billing", title: "重复" })).status, 409);
  assert.equal((await api("POST", "/api/p/alpha/modules", { id: "Bad-Id", title: "x" })).status, 400);
  const projects = (await api("GET", "/api/projects")).json.projects;
  assert.ok(projects.find((p: any) => p.id === "alpha").modules.some((m: any) => m.id === "billing"));
  assert.equal((await api("POST", "/api/p/alpha/rules", { module: "billing", layer: "backend", title: "发票编号连续", body: "" })).status, 201);
  // Module into the config's inline modules (beta) through the CLI.
  assert.match(vibedoc(B, "module", "add", "search", "搜索").out, /vibedoc\.config\.json/);
  assert.equal(JSON.parse(read(join(B, "vibedoc.config.json"))).modules.search, "搜索");
  assert.equal((await api("POST", "/api/p/beta/modules", { id: "export", title: "导出" })).status, 201);
  assert.ok((await api("GET", "/api/projects")).json.projects.find((p: any) => p.id === "beta").modules.some((m: any) => m.id === "export"));
  // Plugins: registered once, outside paths refused.
  write(join(B, "tools/p/plugin.ts"), 'export default { name: "p", commands: { ping: { describe: "ping", run() { console.log("pong"); } } } };\n');
  assert.equal((await api("POST", "/api/p/beta/plugins", { path: "tools/p/plugin.ts" })).status, 201);
  assert.equal((await api("POST", "/api/p/beta/plugins", { path: "tools/p/plugin.ts" })).status, 409);
  assert.equal((await api("POST", "/api/p/beta/plugins", { path: "../outside.ts" })).status, 400);
  assert.match(vibedoc(B, "ping").out, /pong/);
  // Documents.
  assert.equal((await api("POST", "/api/p/beta/docs/questions", { title: "要不要导出 CSV？", body: "" })).status, 201);
  assert.match(read(join(B, "doc/human/open_questions.md")), /要不要导出 CSV？/);
  assert.equal((await api("POST", "/api/p/beta/docs/goals", { title: "上线 1.0", text: "- 目标：发布" })).status, 201);
  assert.match(read(join(B, "doc/goal_logs.md")), /## 上线 1\.0\n\n- 目标：发布/);
  assert.equal((await api("POST", "/api/p/beta/docs/totest", { name: "export", text: "# 导出\n\n## 待验证行为" })).status, 201);
  assert.equal((await api("POST", "/api/p/beta/docs/totest", { name: "export", text: "again" })).status, 409);
  assert.equal((await api("POST", "/api/p/beta/docs/deliverables", { name: "manual", text: "# 手册" })).status, 201);
  const log = await api("POST", "/api/p/beta/docs/changelogs", { role: "owner", slug: "plan", body: "### 变更内容\n\n- 定计划" });
  assert.equal(log.status, 201);
  assert.match(read(join(B, log.json.path)), /^## time: .* \| role: owner\n\n### 变更内容\n\n- 定计划/);
  // Projects: a plain folder needs init, then appears; removing only unregisters.
  const D = join(tmp, "delta");
  mkdirSync(D, { recursive: true });
  const needs = await api("POST", "/api/projects", { path: D });
  assert.equal(needs.status, 409);
  assert.equal(needs.json.needsInit, true);
  const added = await api("POST", "/api/projects", { path: D, init: true, name: "Delta" });
  assert.equal(added.status, 201);
  assert.equal(added.json.id, "delta");
  assert.ok(existsSync(join(D, "AGENTS.md")));
  assert.ok((await api("GET", "/api/projects")).json.projects.some((p: any) => p.id === "delta"));
  assert.equal((await api("DELETE", "/api/projects/delta")).status, 200);
  assert.ok(!(await api("GET", "/api/projects")).json.projects.some((p: any) => p.id === "delta"));
  assert.ok(existsSync(join(D, "vibedoc.config.json")));
});

test("standard modules, plugin scaffold and the AI skill", async () => {
  assert.match(vibedoc(tmp, "module", "catalog").out, /auth\s+账号与安全[\s\S]*gameplay\s+核心玩法/);
  const catalog = (await api("GET", "/api/module-catalog")).json;
  assert.ok(catalog.groups.some((g: any) => g.modules.some((m: any) => m.id === "files")));
  // init with standard modules and feature drafts
  const E = join(tmp, "epsilon");
  mkdirSync(E, { recursive: true });
  assert.equal(vibedoc(E, "init", "--name", "Epsilon", "--modules", "auth,profile", "--features").code, 0);
  assert.deepEqual(Object.keys(JSON.parse(read(join(E, "vibedoc.config.json"))).modules), ["auth", "profile"]);
  assert.match(read(join(E, "doc/features/auth.md")), /## 常见功能（待确认）[\s\S]*### 注册\n<!-- feature:auth-f1 status=new/);
  assert.match(vibedoc(E, "features", "list").out, /auth-f1\s+新提出/);
  assert.equal(vibedoc(E, "init", "--modules", "nope").code, 1);
  // add standard modules later, from the board and the CLI; existing ones are skipped
  for (let i = 0; i < 30 && !(await api("GET", "/api/projects")).json.projects.some((p: any) => p.id === "epsilon"); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal((await api("POST", "/api/p/epsilon/modules", { standard: ["notifications", "auth"], features: false })).status, 201);
  assert.ok(JSON.parse(read(join(E, "vibedoc.config.json"))).modules.notifications);
  assert.ok(!existsSync(join(E, "doc/features/notifications.md")));
  assert.match(vibedoc(E, "module", "add", "--standard", "settings", "--features").out, /settings/);
  assert.ok(existsSync(join(E, "doc/features/settings.md")));
  // a new project from the board, initialized with modules
  const F = join(tmp, "phi");
  mkdirSync(F, { recursive: true });
  assert.equal((await api("POST", "/api/projects", { path: F, init: true, name: "Phi", modules: ["gameplay", "economy"], features: true })).status, 201);
  assert.deepEqual(Object.keys(JSON.parse(read(join(F, "vibedoc.config.json"))).modules), ["gameplay", "economy"]);
  assert.ok(existsSync(join(F, "doc/features/economy.md")));
  // plugin scaffold: files, registration, command, board route and script
  assert.match(vibedoc(E, "plugins", "new", "release-notes", "--title", "发布说明", "--view").out, /已创建并登记插件/);
  assert.ok(existsSync(join(E, "tools/vibedoc-plugins/release-notes/client.js")));
  assert.match(vibedoc(E, "plugins").out, /release-notes（发布说明）[\s\S]*vibedoc release-notes/);
  assert.match(vibedoc(E, "release-notes").out, /"project": "Epsilon"/);
  assert.equal(vibedoc(E, "plugins", "new", "release-notes").code, 1);
  assert.equal((await api("POST", "/api/p/epsilon/plugins/new", { name: "board-only", title: "看板", view: true })).status, 201);
  for (let i = 0; i < 30 && !(await api("GET", "/api/projects")).json.projects.find((p: any) => p.id === "epsilon").plugins.some((x: any) => x.name === "board-only"); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal((await api("GET", "/api/p/epsilon/plugins/board-only/summary")).json.project, "Epsilon");
  assert.match(await (await fetch(`${base}/api/p/epsilon/plugins/board-only/client.js`)).text(), /registerView\("board-only"/);
  // skill: path and project install
  assert.match(vibedoc(E, "skill", "path").out.trim(), /skills\/vibedoc-plugin$/);
  assert.match(vibedoc(E, "skill", "install", "--project").out, /\.claude\/skills\/vibedoc-plugin/);
  assert.match(read(join(E, ".claude/skills/vibedoc-plugin/SKILL.md")), /^---\nname: vibedoc-plugin/);
  assert.ok(existsSync(join(E, ".claude/skills/vibedoc-plugin/references/examples.md")));
});

test("web and game presets can be previewed and customized without partial writes", async () => {
  const cat = (await api("GET", "/api/module-catalog")).json;
  const known = new Set(cat.groups.flatMap((g: any) => g.modules.map((m: any) => m.id)));
  assert.equal(new Set(cat.presets.map((p: any) => p.id)).size, 8);
  for (const p of cat.presets) assert.ok(p.modules.every((id: string) => known.has(id)), p.id);
  assert.match(vibedoc(tmp, "preset", "show", "website").out, /accessibility\s+响应式与无障碍/);
  const W = join(tmp, "preset-web"), G = join(tmp, "preset-game");
  mkdirSync(W);
  mkdirSync(G);
  assert.equal(vibedoc(W, "init", "--preset", "invalid").code, 1);
  assert.equal(vibedoc(W, "init", "--preset", "website", "--modules", "content,bad").code, 1);
  assert.ok(!existsSync(join(W, "vibedoc.config.json")));
  assert.equal(vibedoc(W, "init", "--preset", "website", "--features").code, 0);
  assert.deepEqual(Object.keys(JSON.parse(read(join(W, "vibedoc.config.json"))).modules), cat.presets.find((p: any) => p.id === "website").modules);
  const contentFile = join(W, "doc/features/content.md");
  write(contentFile, "# 自己维护的内容文档\n");
  assert.equal(vibedoc(W, "module", "add", "--preset", "community-site", "--features").code, 0);
  assert.equal(read(contentFile), "# 自己维护的内容文档\n");
  assert.ok(existsSync(join(W, "doc/features/community.md")));
  const added = await api("POST", "/api/projects", { path: G, init: true, preset: "simulation-game", modules: ["gameplay", "simulation", "playtest"], features: true });
  assert.equal(added.status, 201);
  assert.deepEqual(Object.keys(JSON.parse(read(join(G, "vibedoc.config.json"))).modules), ["gameplay", "simulation", "playtest"]);
  assert.match(read(join(G, "doc/features/simulation.md")), /### 模拟规则\n<!-- feature:simulation-f1 status=new/);
});

test("todo changes preserve Markdown, reject stale moves, and record completion evidence", async () => {
  const doc = join(B, "doc/todo.md");
  const original = read(doc);
  try {
    write(doc, "# 待办\r\n\r\n## 1. Backlog\r\n\r\n- 首次登录\r\n  - 保留原有步骤\r\n  ```text\r\n  - 代码示例\r\n  ```\r\n\r\n## In Progress\r\n\r\n## Under Test\r\n\r\n## 团队笔记\r\n\r\n- 不移动这行\r\n");
    const snapshot = async () => (await api("GET", "/api/p/beta/docs")).json;
    const move = (version: string, from: string, to: string, evidence = "") => api("POST", "/api/p/beta/docs/todo/move", { from, to, version, evidence, number: 1 });
    const version = (await snapshot()).todoVersion;
    assert.equal((await move(version, "backlog", "doing")).status, 200);
    assert.equal((await move(version, "doing", "testing")).status, 409);
    assert.equal(vibedoc(B, "todo", "move", "doing", "1", "testing").code, 0);
    const current = (await snapshot()).todoVersion;
    assert.equal((await move(current, "testing", "done")).status, 400);
    assert.equal((await move(current, "testing", "done", "登录回归用例通过")).status, 200);
    assert.match(read(doc), /## Done\r\n\r\n- 首次登录\r\n  - 保留原有步骤\r\n  ```text\r\n  - 代码示例\r\n  ```\r\n  验收证据：登录回归用例通过/);
    assert.match(read(doc), /## 团队笔记\r\n\r\n- 不移动这行/);
  } finally {
    write(doc, original);
  }
});

test("roadmap milestones validate dependencies, concurrent edits and release checks", async () => {
  const route = "/api/p/beta/docs/roadmap";
  const item = (id: string) => ({ id, title: id === "prototype" ? "可玩原型" : "首发", due: "2027-01-12", owner: "小林", goal: "完成核心流程" });
  const create = (value: object) => api("POST", route, value);
  const update = (value: object) => api("PUT", route, value);
  const list = async () => (await api("GET", route)).json.items;
  assert.equal((await create({ ...item("../secret") })).status, 400);
  assert.equal((await create({ ...item("prototype"), due: "2027-02-30" })).status, 400);
  assert.equal((await create(item("prototype"))).status, 201);
  assert.equal((await create(item("prototype"))).status, 409);
  assert.equal((await create({ ...item("release"), dependsOn: ["absent"] })).status, 400);
  assert.equal((await create({ ...item("release"), dependsOn: ["prototype"], checks: [{ text: "测试包可启动", checked: false }] })).status, 201);
  const [prototype, release] = await list();
  assert.deepEqual(release.blockedBy, ["prototype"]);
  assert.equal((await update({ ...prototype, dependsOn: ["release"] })).status, 400);
  assert.equal((await update({ ...release, status: "done" })).status, 400);
  assert.equal(vibedoc(B, "roadmap", "set", "prototype", "done").code, 0);
  assert.equal((await update({ ...release, status: "done" })).status, 400);
  assert.equal((await update({ ...release, checks: [{ text: "测试包可启动", checked: true }] })).status, 200);
  assert.equal((await update({ ...release, status: "done" })).status, 409);
  assert.equal(vibedoc(B, "roadmap", "set", "release", "done").code, 0);
  const [done] = (await list()).filter((m: any) => m.id === "release");
  assert.equal(done.status, "done");
  assert.deepEqual(done.blockedBy, []);
  assert.match(read(join(B, "doc/roadmap/release.md")), /- 状态：done[\s\S]*- \[x\] 测试包可启动/);
  assert.match(vibedoc(B, "roadmap", "show", "release").out, /首发[\s\S]*完成核心流程/);
});

test("AI index: generation, freshness ledger and the completion gate", () => {
  const G = join(tmp, "gamma");
  mkdirSync(G, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: G });
  assert.equal(vibedoc(G, "init", "--name", "Gamma").code, 0);
  const cfg = JSON.parse(read(join(G, "vibedoc.config.json")));
  Object.assign(cfg, {
    modules: {}, modulesFile: "doc/modules/modules.yaml",
    codemap: { outDir: "doc/modules", crates: [{ dir: "backend/api", lib: "api" }], migrationsDir: "backend/migrations", frontendRoots: ["frontend/src"] },
    index: {},
  });
  write(join(G, "vibedoc.config.json"), JSON.stringify(cfg, null, 2));
  write(join(G, "doc/modules/modules.yaml"), "modules:\n  items:\n    title: 条目\n    backend: [backend/api/src/**]\n    frontend: [frontend/src/**]\n    schemas: [shop]\n");
  write(join(G, "backend/migrations/shop/0001_items.sql"), "CREATE TABLE shop.items (id BIGINT PRIMARY KEY, title TEXT NOT NULL);\n");
  write(join(G, "backend/api/src/lib.rs"), 'use axum::{routing::get, Router};\npub mod items;\n/// 组装路由。\npub fn build_app() -> Router {\n    Router::new().route("/items", get(items::list_items))\n}\n');
  const items = (body: string) => `/// 列出全部条目。\npub async fn list_items() -> Vec<i64> {\n    let _ = sqlx::query("SELECT id, title FROM shop.items");\n    ${body}\n}\n\npub fn helper() -> i64 { 1 }\n`;
  write(join(G, "backend/api/src/items.rs"), items("vec![]"));
  write(join(G, "frontend/src/api.ts"), "export async function listItems() {\n  return (await fetch(`/items`)).json();\n}\n");

  // Generation: one line per file, an overview, and the ledger.
  assert.match(vibedoc(G, "index", "generate").out, /3 个文件/);
  const indexFile = join(G, "doc/index/items.txt");
  assert.match(read(indexFile), /^backend\/api\/src\/items\.rs \[api\] role: \? \| api: GET \/items \| reads: shop\.items \| defines: list_items, helper$/m);
  assert.match(read(indexFile), /^frontend\/src\/api\.ts \[frontend\] role: \? \| api: GET \/items \| defines: listItems$/m);
  assert.match(read(join(G, "doc/index/INDEX.txt")), /module items \[条目\] files: 3 \| blank: 3/);
  assert.match(read(join(G, "doc/index/ledger.json")), /"api::items::list_items": "[0-9a-f]{10}:[0-9a-f]{10}"/);

  // The gate lists everything still missing before a feature may be done.
  write(join(G, "doc/features/items.md"), "# 条目（items）\n\n条目的增删查。\n\n## 列表\n\n### 条目列表\n列出全部条目。\n");
  vibedoc(G, "features", "refresh");
  let r = vibedoc(G, "features", "set", "done", "items-f1", "--impl", "items::list_items,items::helper");
  assert.equal(r.code, 1);
  assert.match(r.out, /函数缺注释：items::helper/);
  assert.match(r.out, /索引行缺 role：backend\/api\/src\/items\.rs/);
  assert.match(r.out, /没有行为文档小节引用 items-f1/);
  assert.match(vibedoc(G, "features", "list", "--all").out, /items-f1\s+新提出/);

  // Do the documentation work, then the gate passes and the overview is refreshed.
  write(indexFile, read(indexFile).replace("items.rs [api] role: ?", "items.rs [api] role: 条目列表接口").replace(" | defines: list_items, helper", " | defines: list_items, helper | note: 只读"));
  write(join(G, "doc/behavior/items.md"), "# 条目行为\n\n## 列表\n<!-- refs: items-f1 items::list_items table:shop.items -->\n返回全部条目。\n");
  assert.match(vibedoc(G, "index", "ack", "items::helper").out, /已确认：函数 items::helper/);
  assert.equal(vibedoc(G, "index", "check", "items-f1", "--impl", "items::list_items,items::helper").code, 0);
  r = vibedoc(G, "features", "set", "done", "items-f1", "--impl", "items::list_items,items::helper");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /已持久化/);
  assert.match(read(join(G, "doc/features/items.md")), /impl=items%3A%3Alist_items%2Citems%3A%3Ahelper/);
  assert.match(read(indexFile), /role: 条目列表接口 \| api: GET \/items[^\n]*\| note: 只读$/m);
  assert.match(vibedoc(G, "index", "stale").out, /没有过期内容/);

  // A code change without its comment, index line or behavior section marks all three stale.
  write(join(G, "backend/api/src/items.rs"), items("vec![1]"));
  let out = vibedoc(G, "index", "stale").out;
  assert.match(out, /函数注释\s+items::list_items/);
  assert.match(out, /索引行\s+backend\/api\/src\/items\.rs/);
  assert.match(out, /文档小节\s+doc\/behavior\/items\.md#列表[^\n]*items::list_items/);
  assert.equal(vibedoc(G, "index", "check", "items-f1").code, 1);
  assert.match(read(indexFile), /role: 条目列表接口/);
  vibedoc(G, "index", "generate");
  assert.match(read(indexFile), /\| state: stale$/m);

  // Updating the text clears it; `ack` confirms text that is still accurate.
  write(join(G, "backend/api/src/items.rs"), items("vec![1]").replace("/// 列出全部条目。", "/// 列出全部条目，至少一条。"));
  write(join(G, "doc/behavior/items.md"), read(join(G, "doc/behavior/items.md")).replace("返回全部条目。", "返回全部条目，至少一条。"));
  assert.match(vibedoc(G, "index", "ack", "backend/api/src/items.rs").out, /已确认：索引/);
  vibedoc(G, "index", "generate");
  assert.match(vibedoc(G, "index", "stale").out, /没有过期内容/);
  assert.doesNotMatch(read(indexFile), /\| state: stale$/m);

  // Broken references are reported; --skip lets an item through and records why.
  write(join(G, "doc/behavior/items.md"), read(join(G, "doc/behavior/items.md")).replace("table:shop.items", "table:shop.items items::gone"));
  assert.match(vibedoc(G, "index", "stale").out, /失效引用\s+doc\/behavior\/items\.md#列表[^\n]*items::gone/);
  write(join(G, "doc/features/items.md"), read(join(G, "doc/features/items.md")) + "\n### 条目导出\n导出 CSV。\n");
  vibedoc(G, "features", "refresh");
  assert.equal(vibedoc(G, "features", "set", "done", "items-f2").code, 1);
  r = vibedoc(G, "features", "set", "done", "items-f2", "--skip", "只改了文案");
  assert.equal(r.code, 0, r.out);
  assert.match(read(join(G, "doc/index/ledger.json")), /"item":"items-f2","reason":"只改了文案"/);
  assert.match(vibedoc(G, "index", "show", "backend/api/src/items.rs").out, /list_items[\s\S]*文档：doc\/behavior\/items\.md#列表/);

  // Coverage: constants-only files, guarded renames, directory references, the body under the title, history skipped.
  write(join(G, "backend/api/src/limits.rs"), "pub const MAX_ITEMS: usize = 10;\nconst SECRET_LEN: usize = 32;\n");
  write(join(G, "backend/api/src/reexport.rs"), "pub use crate::items::helper;\n");
  write(join(G, "backend/migrations/shop/0002_rename.sql"), "DO $$\nBEGIN\n  IF to_regclass('shop.listings') IS NULL THEN\n    ALTER TABLE shop.items RENAME TO listings;\n  END IF;\nEND $$;\n");
  write(join(G, "doc/behavior/limits.md"), "# 限制\n<!-- refs: backend/api/src/ table:shop.listings -->\n条目最多十个。\n\n## 旧表\n<!-- refs: table:shop.items -->\n已改名。\n");
  write(join(G, "doc/behavior/old/x.md"), "# 旧\n\n## 记录\n<!-- refs: items::gone -->\n历史。\n");
  cfg.docs = { deploylogs: "doc/behavior/old" };
  write(join(G, "vibedoc.config.json"), JSON.stringify(cfg, null, 2));
  vibedoc(G, "index", "generate");
  assert.match(read(indexFile), /^backend\/api\/src\/limits\.rs \[types\] role: \? \| defines: MAX_ITEMS$/m);
  assert.doesNotMatch(read(indexFile), /reexport\.rs/);
  out = vibedoc(G, "index", "stale").out;
  assert.doesNotMatch(out, /limits\.md#限制/);
  assert.match(out, /失效引用\s+doc\/behavior\/limits\.md#旧表[^\n]*table:shop\.items/);
  assert.doesNotMatch(out, /old\/x\.md/);
  assert.match(read(join(G, "doc/index/ledger.json")), /"doc\/behavior\/limits\.md#限制"/);
  write(join(G, "backend/api/src/limits.rs"), "pub const MAX_ITEMS: usize = 20;\n");
  assert.match(vibedoc(G, "index", "stale").out, /文档小节\s+doc\/behavior\/limits\.md#限制[^\n]*backend\/api\/src\//);
  assert.match(vibedoc(G, "index", "show", "backend/api/src/limits.rs").out, /文档：doc\/behavior\/limits\.md#限制/);
  write(join(G, "doc/behavior/limits.md"), "# 限制\n<!-- refs: backend/api/src/ table:shop.listings -->\n条目最多二十个。\n");
  vibedoc(G, "index", "generate");

  // The rule blocks tell the AI about the index and the completion chain only when it is configured.
  vibedoc(G, "agents", "sync");
  assert.match(read(join(G, "AGENTS.md")), /`doc\/index\/` is the AI index[\s\S]*vibedoc index check <id>/);
  assert.match(read(join(G, "doc/AGENTS.md")), /`doc\/index\/` 是 AI 索引/);
  assert.match(read(join(G, "doc/AGENTS.md")), /`doc\/behavior\/old\/` 部署与验收记录/);
  assert.doesNotMatch(read(join(A, "AGENTS.md")), /AI index/);
});

test("server: document and code browser", async () => {
  let projects: any[] = [];
  for (let i = 0; i < 50 && !projects.some((p) => p.id === "gamma"); i++) {
    projects = (await api("GET", "/api/projects")).json.projects;
    if (!projects.some((p) => p.id === "gamma")) await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(projects.find((p) => p.id === "gamma")?.index, true);
  assert.equal(projects.find((p) => p.id === "alpha")?.index, false);
  const ix = (await api("GET", "/api/p/gamma/index")).json;
  assert.equal(ix.counts.files, 4);
  const items = ix.entries.find((e: any) => e.path === "backend/api/src/items.rs");
  assert.equal(items.role, "条目列表接口");
  assert.ok(!("file" in items));
  assert.deepEqual(ix.items.find((i: any) => i.id === "items-f1").impl.map((r: any) => [r.ref, r.file, r.fn]), [
    ["items::list_items", "backend/api/src/items.rs", "api::items::list_items"],
    ["items::helper", "backend/api/src/items.rs", "api::items::helper"],
  ]);
  assert.equal(ix.sections[0].key, "doc/behavior/items.md#列表");
  const file = (await api("GET", `/api/p/gamma/index/file?path=${encodeURIComponent("backend/api/src/items.rs")}`)).json;
  assert.match(file.text, /pub async fn list_items/);
  assert.deepEqual(file.fns.map((f: any) => [f.key, f.state]), [["items::list_items", "fresh"], ["items::helper", "bare"]]);
  assert.equal(file.sections[0].key, "doc/behavior/items.md#列表");
  // Only indexed source files are served.
  assert.equal((await api("GET", `/api/p/gamma/index/file?path=${encodeURIComponent("vibedoc.config.json")}`)).status, 404);
  assert.equal((await api("GET", `/api/p/gamma/index/file?path=${encodeURIComponent("../../etc/passwd")}`)).status, 404);
  assert.equal((await api("GET", "/api/p/alpha/index")).json.disabled, true);
});
