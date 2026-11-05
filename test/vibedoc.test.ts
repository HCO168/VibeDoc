// End-to-end tests: every command and every board API against throwaway repositories.
//   node --test test/
// Nothing outside the temp directory is touched: the project registry lives in a temp XDG_CONFIG_HOME.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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
      token = /const TOKEN = "([a-f0-9]+)"/.exec(html)![1];
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
