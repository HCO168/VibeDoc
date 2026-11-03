import type { Model, FnNode, RouteNode, ModuleDef, Layer, TypeNode } from "./model.ts";
import { wireShape } from "./serde.ts";

type Page = Layer | "structs";
const LAYER_TITLE: Record<Page, string> = { frontend: "前端", api: "API", backend: "后端", database: "数据库", structs: "结构体" };
const MAX_LIST = 12;

const anchor = (s: string) => s.toLowerCase().replace(/[^a-z0-9_]+/g, "-").replace(/^-|-$/g, "");
export const fnAnchor = (n: FnNode) => `fn-${anchor(n.key)}`;
export const routeAnchor = (r: RouteNode) => `route-${anchor(`${r.method}-${r.path}`)}`;
export const tableAnchor = (key: string) => `table-${anchor(key)}`;
const src = (file: string, line?: number) => `../../../${file.split("/").map(encodeURIComponent).join("/")}${line ? `#L${line}` : ""}`;
const fileName = (file: string) => file.split("/").slice(-1)[0];
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n+/g, " ");
const firstLine = (s: string) => s.split(/\n\s*\n/)[0].replace(/\n/g, " ").trim();

function layerOfFn(n: FnNode): Layer {
  return n.layer;
}

function fnLink(model: Model, id: string, from: string): string {
  const n = model.fns.get(id);
  if (!n) return `\`${id}\``;
  const page = `${layerOfFn(n)}.md`;
  const href = n.module === from ? `${page}#${fnAnchor(n)}` : `../${n.module}/${page}#${fnAnchor(n)}`;
  return `[\`${n.key}\`](${href})`;
}

function routeLink(r: RouteNode, from: string): string {
  const href = r.module === from ? `api.md#${routeAnchor(r)}` : `../${r.module}/api.md#${routeAnchor(r)}`;
  return `[\`${r.method} ${r.path}\`](${href})`;
}

function tableLink(model: Model, key: string, from: string): string {
  const mod = model.tableModule.get(key) ?? "platform";
  const href = mod === from ? `database.md#${tableAnchor(key)}` : `../${mod}/database.md#${tableAnchor(key)}`;
  return `[\`${key}\`](${href})`;
}

function list(items: string[]): string {
  if (items.length <= MAX_LIST) return items.join("、");
  return `${items.slice(0, MAX_LIST).join("、")} 等 ${items.length} 个`;
}

function header(model: Model, mod: ModuleDef, layer: Page, meta: { generatedAt: string; head: string }): string {
  const nav = (["frontend", "api", "backend", "database", "structs"] as Page[])
    .map((l) => (l === layer ? `**${LAYER_TITLE[l]}**` : `[${LAYER_TITLE[l]}](${l}.md)`))
    .join(" · ");
  const docs = mod.docs.length ? mod.docs.map((d) => `[${d.replace(/^doc\//, "")}](${src(d)})`).join("、") : "暂无";
  return [
    `# ${mod.title}（${mod.id}）· ${LAYER_TITLE[layer]}`,
    "",
    `${nav} · [总览](../INDEX.md)`,
    "",
    `> 本文件由 \`vibedoc codemap generate\` 根据代码自动生成（${meta.generatedAt}，\`${meta.head}\`），请勿手改，下次生成会覆盖。`,
    `> 函数说明来自代码中的 \`///\` 注释；要改逻辑请提需求，不要改这里。调用关系按名称推断，方法调用（\`a.b()\`）与 trait 调用不追踪。`,
    `> 叙述性文档：${docs}`,
    "",
  ].join("\n");
}

function fnEntry(model: Model, n: FnNode, from: string): string {
  const lines: string[] = [];
  lines.push(`#### \`${n.fn.implType ? `${n.fn.implType}::` : ""}${n.fn.name}\``);
  lines.push(`<a id="${fnAnchor(n)}"></a>`);
  lines.push("");
  if (n.fn.docs) lines.push(n.fn.docs.split("\n").map((l) => `> ${l}`).join("\n"), "");
  lines.push("```rust");
  lines.push(n.fn.signature);
  lines.push("```");
  lines.push("");
  lines.push(`- 位置：[${fileName(n.file)}:${n.fn.line}](${src(n.file, n.fn.line)})`);
  if (n.sharedWith.length) lines.push(`- 共用：也被 ${n.sharedWith.join("、")} 模块调用`);
  if (n.handlerOf.length) lines.push(`- 接口：${n.handlerOf.map((r) => routeLink(r, from)).join("、")}`);
  const callers = [...n.callers].filter((c) => !n.handlerOf.some((r) => r.owner === c));
  if (callers.length) lines.push(`- 被调用：${list(callers.map((c) => fnLink(model, c, from)))}`);
  if (n.callees.size) lines.push(`- 调用：${list([...n.callees].map((c) => fnLink(model, c, from)))}`);
  const reads = [...n.tables].filter(([, w]) => !w).map(([t]) => tableLink(model, t, from));
  const writes = [...n.tables].filter(([, w]) => w).map(([t]) => tableLink(model, t, from));
  if (reads.length) lines.push(`- 读表：${list(reads)}`);
  if (writes.length) lines.push(`- 写表：${list(writes)}`);
  if (n.sqlFunctions.size) lines.push(`- SQL 函数：${list([...n.sqlFunctions].map((f) => `\`${f}\``))}`);
  lines.push("");
  return lines.join("\n");
}

function fnSections(model: Model, nodes: FnNode[], from: string): string {
  const byFile = new Map<string, FnNode[]>();
  for (const n of nodes) byFile.set(n.file, [...(byFile.get(n.file) ?? []), n]);
  const out: string[] = [];
  for (const [file, group] of [...byFile].sort((a, b) => a[0].localeCompare(b[0]))) {
    group.sort((a, b) => a.fn.line - b.fn.line);
    out.push(`### [${file.replace(/^backend\//, "")}](${src(file)})`);
    out.push("");
    out.push(`${group.length} 个函数。`);
    out.push("");
    out.push("| 函数 | 说明 |");
    out.push("| --- | --- |");
    for (const n of group) out.push(`| [\`${n.fn.implType ? `${n.fn.implType}::` : ""}${n.fn.name}\`](#${fnAnchor(n)}) | ${n.fn.docs ? cell(firstLine(n.fn.docs)) : ""} |`);
    out.push("");
    for (const n of group) out.push(fnEntry(model, n, from));
  }
  return out.join("\n");
}

export const typeAnchor = (t: TypeNode) => `type-${anchor(t.id.replace(/^[^:]+::/, ""))}`;

function typeLink(t: TypeNode, from: string): string {
  const href = t.module === from ? `structs.md#${typeAnchor(t)}` : `../${t.module}/structs.md#${typeAnchor(t)}`;
  return `[\`${t.type.name}\`](${href})`;
}

// `Option<DriveSort>` plus links to the custom types it mentions.
function typeCell(model: Model, file: string, text: string, from: string): string {
  const refs = model.typeRefs(file, text);
  return `\`${cell(text)}\`${refs.length ? ` → ${refs.map((t) => typeLink(t, from)).join("、")}` : ""}`;
}

export function shapeTable(model: Model, t: TypeNode, from: string): string[] {
  const shape = wireShape(t.type);
  const out: string[] = [];
  if (shape.notes.length) out.push(`（${shape.notes.join("；")}）`, "");
  if (t.type.alias) out.push(`类型别名：${typeCell(model, t.file, t.type.alias, from)}`, "");
  if (shape.fields.length) {
    out.push("| 字段 | 类型 | 必填 | 说明 |", "| --- | --- | --- | --- |");
    for (const f of shape.fields) {
      const need = f.required ? "必填" : f.nullable ? "可选" : "可选（有默认值）";
      const note = [f.docs ? firstLine(f.docs) : "", ...f.notes, f.json !== f.rust ? `Rust 字段 \`${f.rust}\`` : ""].filter(Boolean).join("；");
      out.push(`| \`${f.json}\` | ${typeCell(model, t.file, f.type, from)} | ${need} | ${cell(note)} |`);
    }
  } else if (shape.variants.length) {
    out.push("| 取值 | 内容 | 说明 |", "| --- | --- | --- |");
    for (const v of shape.variants) out.push(`| \`${v.json}\` | ${v.payload ? typeCell(model, t.file, v.payload, from) : ""} | ${cell(firstLine(v.docs))} |`);
  } else if (!t.type.tuple.length && !t.type.alias) out.push("无字段。");
  out.push("");
  return out;
}

function apiPart(model: Model, file: string, label: string, text: string, from: string): string[] {
  const refs = model.typeRefs(file, text);
  const bare = refs.length === 1 && text.split("::").pop() === refs[0].type.name;
  const out = [`**${label}**：${bare ? typeLink(refs[0], from) : typeCell(model, file, text, from)}`, ""];
  for (const t of refs) {
    if (t.type.kind === "trait") continue;
    if (refs.length > 1) out.push(`\`${t.type.name}\`${t.type.docs ? `：${firstLine(t.type.docs)}` : ""}`, "");
    else if (t.type.docs) out.push(`> ${firstLine(t.type.docs)}`, "");
    out.push(...shapeTable(model, t, from));
  }
  return out;
}

function renderApi(model: Model, mod: ModuleDef): string {
  const routes = model.routes.filter((r) => r.module === mod.id).sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  const handlers = [...model.fns.values()].filter((n) => n.module === mod.id && n.layer === "api");
  const out: string[] = [];
  const brief = (text: string | null, note: string | null) => (text ? `\`${cell(text)}\`` : note ? cell(note.replace(/`/g, "")) : "");
  out.push(`## 路由一览`, "", `${routes.length} 条路由，${routes.filter((r) => r.frontend.length).length} 条有前端调用。点路径看请求和响应结构。`, "");
  if (routes.length) {
    out.push("| 方法 | 路径 | 说明 | 请求 | 响应 | 前端调用 |", "| --- | --- | --- | --- | --- | --- |");
    for (const r of routes) {
      const h = r.handler ? model.fns.get(r.handler) : undefined;
      const fe = r.frontend.map((f) => `\`${f.fn ?? fileName(f.file)}\``);
      const req = [r.api?.query ? `查询 \`${cell(r.api.query)}\`` : "", r.api?.body ? `${r.api.bodyKind === "form" ? "表单" : "JSON"} \`${cell(r.api.body)}\`` : r.api?.bodyKind === "multipart" ? "multipart" : ""].filter(Boolean).join("<br>");
      out.push(
        `| ${r.method} | [\`${cell(r.path)}\`](#${routeAnchor(r)}) | ${h?.fn.docs ? cell(firstLine(h.fn.docs)) : h ? "" : "（内联闭包）"} | ${req} | ${brief(r.api?.response ?? null, r.api?.responseNote ?? null)} | ${cell(list(fe))} |`,
      );
    }
    out.push("");
  }

  out.push(`## 接口详情`, "");
  for (const r of routes) {
    const h = r.handler ? model.fns.get(r.handler) : undefined;
    out.push(`### \`${r.method} ${r.path}\``, `<a id="${routeAnchor(r)}"></a>`, "");
    out.push(`- 处理函数：${h ? `${fnLink(model, h.id, mod.id)}${h.fn.docs ? ` — ${firstLine(h.fn.docs)}` : ""}` : "（内联闭包）"}`);
    if (r.frontend.length) out.push(`- 前端调用：${list(r.frontend.map((f) => `\`${f.fn ?? fileName(f.file)}\`（${fileName(f.file)}）`))}`);
    out.push("");
    const a = r.api;
    if (!a || !h) continue;
    if (a.path) out.push(...apiPart(model, h.file, "路径参数", a.path, mod.id));
    if (a.query) out.push(...apiPart(model, h.file, "查询参数", a.query, mod.id));
    if (a.body) out.push(...apiPart(model, h.file, a.bodyKind === "form" ? "请求体（表单）" : "请求体（JSON）", a.body, mod.id));
    else if (a.bodyKind === "multipart") out.push("**请求体**：multipart/form-data，字段见处理函数代码", "");
    if (a.response && !a.responseNote) out.push(...apiPart(model, h.file, "响应（JSON）", a.response, mod.id));
    else if (a.responseNote) out.push(`**响应**：${a.responseNote}`, "");
    const direct = new Set([a.path, a.query, a.body, a.response].filter((x): x is string => !!x).flatMap((x) => model.typeRefs(h.file, x).map((t) => t.id)));
    const nested = a.types.filter((id) => !direct.has(id)).map((id) => model.typeById.get(id)!).filter(Boolean);
    if (nested.length) out.push(`**嵌套类型**：${nested.map((t) => typeLink(t, mod.id)).join("、")}`, "");
  }

  out.push(`## 处理函数`, "");
  out.push(handlers.length ? fnSections(model, handlers, mod.id) : "无。\n");
  return out.join("\n");
}

// Types shown on a module's structs page: its DTO-file types plus any type an API route uses.
function structTypes(model: Model, id: string) {
  const referenced = new Set(model.routes.flatMap((r) => r.api?.types ?? []));
  return model.types.filter((t) => t.module === id && t.type.kind !== "trait" && (t.dto || referenced.has(t.id)));
}

function renderStructs(model: Model, mod: ModuleDef): string {
  const out: string[] = [];
  const types = structTypes(model, mod.id).sort((a, b) => a.file.localeCompare(b.file) || a.type.line - b.type.line);
  out.push(`## 结构体与枚举`, "", `${types.length} 个请求、响应及其嵌套类型。`, "");
  for (const t of types) {
    out.push(`### \`${t.type.name}${t.type.generics}\``, `<a id="${typeAnchor(t)}"></a>`, "");
    if (t.type.docs) out.push(t.type.docs.split("\n").map((l) => `> ${l}`).join("\n"), "");
    out.push(`- ${t.type.kind} · [${fileName(t.file)}:${t.type.line}](${src(t.file, t.type.line)})`);
    const users = model.routes.filter((r) => r.api?.types.includes(t.id));
    if (users.length) out.push(`- 用于：${list(users.map((r) => routeLink(r, mod.id)))}`);
    out.push("", ...shapeTable(model, t, mod.id));
  }

  return out.join("\n");
}

function renderBackend(model: Model, mod: ModuleDef): string {
  const nodes = [...model.fns.values()].filter((n) => n.module === mod.id && n.layer === "backend");
  const out: string[] = [];
  out.push(`## 函数`, "", `${nodes.length} 个函数。`, "");
  out.push(nodes.length ? fnSections(model, nodes, mod.id) : "无。\n");
  const types = model.types.filter((t) => t.module === mod.id && !t.dto);
  out.push(`## 类型`, "");
  if (types.length) {
    out.push("| 类型 | 种类 | 说明 | 位置 |", "| --- | --- | --- | --- |");
    for (const t of types) out.push(`| \`${t.type.name}\` | ${t.type.kind} | ${t.type.docs ? cell(firstLine(t.type.docs)) : ""} | [${fileName(t.file)}:${t.type.line}](${src(t.file, t.type.line)}) |`);
  } else out.push("无。");
  out.push("");
  return out.join("\n");
}

function renderDatabase(model: Model, mod: ModuleDef): string {
  const out: string[] = [];
  const tables = [...model.schema.tables.entries()].filter(([k]) => model.tableModule.get(k) === mod.id).sort((a, b) => a[0].localeCompare(b[0]));
  out.push(`## 表`, "", `${tables.length} 张表或视图（按迁移推算，DO 块里的动态 SQL 只识别旧表迁 schema）。`, "");
  if (tables.length) {
    out.push("| 表 | 字段数 | 说明 | 读写函数数 |", "| --- | --- | --- | --- |");
    for (const [key, t] of tables) out.push(`| [\`${key}\`](#${tableAnchor(key)}) | ${t.kind === "view" ? "视图" : t.columns.length} | ${cell(t.comment)} | ${model.tableUsers.get(key)?.length ?? 0} |`);
    out.push("");
  }
  for (const [key, t] of tables) {
    out.push(`### \`${key}\``, `<a id="${tableAnchor(key)}"></a>`, "");
    if (t.comment) out.push(`> ${t.comment}`, "");
    if (t.columns.length) {
      out.push("| 字段 | 类型 | 约束 | 说明 |", "| --- | --- | --- | --- |");
      for (const c of t.columns) {
        const flags = [c.pk ? "主键" : "", c.notNull && !c.pk ? "非空" : "", c.ref ? `引用 \`${c.ref}\`` : ""].filter(Boolean).join("，");
        out.push(`| \`${c.name}\` | \`${cell(c.type)}\` | ${flags} | ${cell(c.comment)} |`);
      }
      out.push("");
    }
    const migs = t.migrations.map((m) => `[${fileName(m)}](${src(m)})`);
    out.push(`- 创建：[${fileName(t.createdIn)}](${src(t.createdIn)})`);
    if (migs.length > 1) out.push(`- 涉及迁移：${list(migs)}`);
    const users = model.tableUsers.get(key) ?? [];
    const reads = users.filter((u) => !u.write).map((u) => fnLink(model, u.fn, mod.id));
    const writes = users.filter((u) => u.write).map((u) => fnLink(model, u.fn, mod.id));
    if (writes.length) out.push(`- 写入：${list(writes)}`);
    if (reads.length) out.push(`- 读取：${list(reads)}`);
    if (!users.length) out.push(`- 代码中未发现直接 SQL 读写（可能只经 SQL 函数或触发器访问）`);
    out.push("");
  }
  const sqlFns = [...model.schema.functions.entries()].filter(([k]) => model.functionModule.get(k) === mod.id).sort((a, b) => a[0].localeCompare(b[0]));
  out.push(`## SQL 函数`, "");
  if (sqlFns.length) {
    out.push("| 函数 | 参数 | 返回 | SECURITY DEFINER | 调用方 |", "| --- | --- | --- | --- | --- |");
    for (const [key, f] of sqlFns) {
      const users = (model.sqlFunctionUsers.get(key) ?? []).map((u) => fnLink(model, u, mod.id));
      out.push(`| \`${key}\` | \`${cell(f.args || "无")}\` | \`${cell(f.returns || "?")}\` | ${f.securityDefiner ? "是" : ""} | ${users.length ? list(users) : "触发器或未发现"} |`);
    }
  } else out.push("无。");
  out.push("");
  const repo = [...model.fns.values()].filter((n) => n.module === mod.id && n.layer === "database");
  out.push(`## 数据访问函数（Rust）`, "");
  out.push(repo.length ? fnSections(model, repo, mod.id) : "无。\n");
  const foreign = new Map<string, Set<string>>();
  for (const n of model.fns.values()) {
    if (n.module !== mod.id) continue;
    for (const t of n.tables.keys()) {
      const owner = model.tableModule.get(t);
      if (owner && owner !== mod.id) foreign.set(t, (foreign.get(t) ?? new Set()).add(n.id));
    }
  }
  out.push(`## 本模块访问的其他模块表`, "");
  if (foreign.size) {
    for (const [t, ids] of [...foreign].sort()) out.push(`- ${tableLink(model, t, mod.id)}：${list([...ids].map((id) => fnLink(model, id, mod.id)))}`);
  } else out.push("无。");
  out.push("");
  return out.join("\n");
}

function renderFrontend(model: Model, mod: ModuleDef): string {
  const out: string[] = [];
  const pageRoutes = model.frontRoutes.filter((r) => r.module === mod.id);
  out.push(`## 页面路由`, "");
  if (pageRoutes.length) {
    out.push("| 路径 | 组件 | 声明位置 |", "| --- | --- | --- |");
    for (const r of pageRoutes) out.push(`| \`${cell(r.path)}\` | ${r.target ? `[\`${r.component}\`](${src(r.target)})` : `\`${r.component}\``} | [${fileName(r.file)}:${r.line}](${src(r.file, r.line)}) |`);
  } else out.push("未发现 `<Route>` 声明（可能由上级路由或独立 App 承载）。");
  out.push("");

  const moduleRoutes = model.routes.filter((r) => r.module === mod.id);
  const clientUses = new Map<string, { file: string; fn: string | null; routes: RouteNode[] }>();
  for (const r of moduleRoutes) {
    for (const f of r.frontend) {
      const k = `${f.file}|${f.fn}`;
      const e = clientUses.get(k) ?? { file: f.file, fn: f.fn, routes: [] };
      e.routes.push(r);
      clientUses.set(k, e);
    }
  }
  out.push(`## 调用本模块接口的前端函数`, "");
  if (clientUses.size) {
    out.push("| 前端函数 | 说明 | 接口 | 被哪些文件使用 |", "| --- | --- | --- | --- |");
    for (const e of [...clientUses.values()].sort((a, b) => a.file.localeCompare(b.file) || String(a.fn).localeCompare(String(b.fn)))) {
      const node = model.front.get(e.file);
      const cf = node?.parsed.clientFns.find((f) => f.name === e.fn);
      const users = [...model.front.values()].filter((n) => n.uses.some((u) => u.file === e.file && u.fn === e.fn)).map((n) => `[${fileName(n.file)}](${src(n.file)})`);
      const where = `[${e.fn ? `\`${e.fn}\`` : fileName(e.file)}](${src(e.file, cf?.line)})`;
      out.push(`| ${where} | ${cell(cf?.docs ?? "")} | ${e.routes.map((r) => routeLink(r, mod.id)).join("<br>")} | ${list(users)} |`);
    }
  } else out.push("无。");
  out.push("");

  const files = [...model.front.values()].filter((n) => n.module === mod.id).sort((a, b) => a.file.localeCompare(b.file));
  out.push(`## 页面与组件文件`, "", `${files.length} 个文件。`, "");
  if (files.length) {
    out.push("| 文件 | 用到的接口 |", "| --- | --- |");
    for (const f of files) {
      const used = new Map<string, RouteNode>();
      for (const r of model.routes) {
        if (r.frontend.some((x) => x.file === f.file)) used.set(r.id, r);
        if (r.frontend.some((x) => f.uses.some((u) => u.file === x.file && u.fn === x.fn))) used.set(r.id, r);
      }
      out.push(`| [${f.file.replace(/^frontend\//, "")}](${src(f.file)}) | ${list([...used.values()].map((r) => routeLink(r, mod.id)))} |`);
    }
  }
  out.push("");
  return out.join("\n");
}

export function renderModule(model: Model, mod: ModuleDef, meta: { generatedAt: string; head: string }): Record<Page, string> {
  return {
    frontend: header(model, mod, "frontend", meta) + "\n" + renderFrontend(model, mod),
    api: header(model, mod, "api", meta) + "\n" + renderApi(model, mod),
    backend: header(model, mod, "backend", meta) + "\n" + renderBackend(model, mod),
    database: header(model, mod, "database", meta) + "\n" + renderDatabase(model, mod),
    structs: header(model, mod, "structs", meta) + "\n" + renderStructs(model, mod),
  };
}

export function moduleStats(model: Model, id: string) {
  const fns = [...model.fns.values()].filter((n) => n.module === id);
  return {
    frontendFiles: [...model.front.values()].filter((n) => n.module === id).length,
    routes: model.routes.filter((r) => r.module === id).length,
    apiFns: fns.filter((n) => n.layer === "api").length,
    backendFns: fns.filter((n) => n.layer === "backend").length,
    dbFns: fns.filter((n) => n.layer === "database").length,
    tables: [...model.tableModule.values()].filter((m) => m === id).length,
    structs: structTypes(model, id).length,
    missing: fns.filter((n) => !n.fn.docs).length,
    total: fns.length,
  };
}

export function renderIndex(model: Model, meta: { generatedAt: string; head: string }): string {
  const out: string[] = [];
  out.push(`# 代码地图总览`, "");
  out.push(`> 由 \`vibedoc codemap generate\` 自动生成（${meta.generatedAt}，\`${meta.head}\`），请勿手改。模块划分见 [modules.yaml](modules.yaml)。`, "");
  out.push("| 模块 | 前端 | API | 后端 | 数据库 | 结构体 |", "| --- | --- | --- | --- | --- | --- |");
  for (const m of model.modules) {
    const s = moduleStats(model, m.id);
    out.push(
      `| ${m.title}（${m.id}） | [${s.frontendFiles} 个文件](${m.id}/frontend.md) | [${s.routes} 条路由](${m.id}/api.md) | [${s.backendFns} 个函数](${m.id}/backend.md) | [${s.tables} 张表 · ${s.dbFns} 个访问函数](${m.id}/database.md) | [${s.structs} 个](${m.id}/structs.md) |`,
    );
  }
  out.push("");
  out.push(`合计 ${model.fns.size} 个后端函数（不含测试）；${model.routes.length} 条路由；${model.schema.tables.size} 张表或视图；${model.schema.functions.size} 个 SQL 函数。`, "");
  if (model.unassigned.backend.length || model.unassigned.frontend.length) {
    out.push(`## 未归属文件`, "", "这些文件没有匹配 `modules.yaml` 中任何模块，请补充清单：", "");
    for (const f of [...model.unassigned.backend, ...model.unassigned.frontend]) out.push(`- \`${f}\``);
    out.push("");
  }
  return out.join("\n");
}
