// VibeDoc local server: rule board, feature documents, table requests, project documents, code map and
// relationship graph for every registered project (~/.config/vibedoc/projects.json), on http://127.0.0.1:<port>.
//   vibedoc serve          all registered projects (the repository you run it in is registered first)
//   vibedoc serve --only   just the repository found from the current directory (or VIBEDOC_REPO)
// Port: PORT, else the `port` of the repository it runs in, else 4870. Listens on loopback only; writes need
// the per-start token embedded in the served page. Per-project API lives under /api/p/<project id>/.
import { createServer, type IncomingMessage } from "node:http";
import { existsSync, readFileSync, watch } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { CONFIG_FILE, findRoot, loadConfig } from "./config.ts";
import { addProject, listProjects, projectIds, registryFile } from "./registry.ts";
import { Project, send } from "./project.ts";

const here = dirname(fileURLToPath(import.meta.url));
const only = process.argv.includes("--only");
const token = randomBytes(24).toString("hex");

let cwdRoot: string | null = null;
try {
  cwdRoot = findRoot();
} catch {}
if (only && !cwdRoot) throw new Error(`--only 需要在含 ${CONFIG_FILE} 的仓库里运行`);
if (!only && cwdRoot) addProject(cwdRoot);
const port = Number(process.env.PORT ?? (cwdRoot ? loadConfig(cwdRoot).port : 4870));

const projects = new Map<string, Project>();
function loadProjects() {
  const roots = (only ? [cwdRoot!] : listProjects()).filter((r) => existsSync(join(r, CONFIG_FILE)));
  const ids = projectIds(roots);
  const wanted = new Map(roots.map((r) => [ids.get(r)!, r]));
  for (const [id, p] of projects) {
    if (wanted.get(id) !== p.root) {
      p.close();
      projects.delete(id);
    }
  }
  for (const [id, root] of wanted) {
    if (projects.has(id)) continue;
    try {
      projects.set(id, new Project(id, root));
    } catch (error) {
      console.error(`vibedoc: 无法加载 ${root}: ${(error as Error).message}`);
    }
  }
  for (const p of projects.values()) p.emit("projects");
}
loadProjects();
if (!only) {
  // The registry changes when `vibedoc add/remove/init` runs elsewhere.
  const dir = dirname(registryFile());
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (existsSync(dir)) watch(dir, () => {
    clearTimeout(timer);
    timer = setTimeout(loadProjects, 300);
  });
}

const UPLOAD_LIMIT = 20 * 1024 * 1024;
async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("请求太大"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/") {
      const html = readFileSync(join(here, "web/index.html"), "utf8").replace("__BOARD_TOKEN__", token);
      return send(res, 200, html, "text/html; charset=utf-8");
    }
    if (req.method === "GET" && url.pathname === "/api/health") {
      return send(res, 200, { app: "vibedoc", mode: only ? "only" : "registry", root: cwdRoot, roots: [...projects.values()].map((p) => p.root), pid: process.pid });
    }
    if (req.method === "GET" && url.pathname === "/api/projects") return send(res, 200, { projects: [...projects.values()].map((p) => p.info()), mode: only ? "only" : "registry" });
    if (req.method !== "GET" && url.pathname.startsWith("/api/")) {
      if (req.headers["x-board-token"] !== token) return send(res, 403, { error: "缺少或错误的看板令牌，请刷新页面" });
      const host = String(req.headers.host ?? "");
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return send(res, 403, { error: "只接受本机请求" });
    }
    if (req.method === "POST" && url.pathname === "/api/shutdown") {
      send(res, 200, { success: true });
      console.log("VibeDoc: 收到停止请求，退出");
      setTimeout(() => process.exit(0), 100);
      return;
    }
    const scoped = /^\/api\/p\/([a-z0-9-]+)(\/.*)$/.exec(url.pathname);
    if (scoped) {
      const project = projects.get(scoped[1]);
      if (!project) return send(res, 404, { error: "没有这个项目，请刷新页面" });
      let data: any = {};
      if (req.method !== "GET") {
        const upload = scoped[2] === "/docs/sketches";
        const raw = await readBody(req, upload ? UPLOAD_LIMIT : 256 * 1024);
        data = upload ? raw : raw.length ? JSON.parse(raw.toString("utf8")) : {};
      }
      return project.handle(req, res, scoped[2], url.searchParams, data);
    }
    send(res, 404, { error: "not found" });
  } catch (error) {
    const e = error as Error & { status?: number };
    if (!res.headersSent) send(res, e.status ?? 400, { error: e.message });
  }
});

server.listen(port, "127.0.0.1", () => {
  const list = [...projects.values()].map((p) => `${p.cfg.name}（${p.root}）`).join("、") || "（还没有项目，在仓库里运行 vibedoc init 或 vibedoc add）";
  console.log(`VibeDoc: http://127.0.0.1:${port}  ${only ? "仅本仓库" : "全部项目"}：${list}`);
});
