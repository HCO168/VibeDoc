// Table requests: <tablesDir>/<schema>.md, sections `## 新建表` and `## 修改表`, one `### <表名>` per request.
// The body is the table's purpose, a Markdown column table and free notes:
//
//   发票，每次结算生成一张。
//
//   | 字段 | 类型 | 约束 | 说明 |            修改表 adds a leading `操作` column: 新增 / 修改 / 删除
//   | --- | --- | --- | --- |
//   | id | uuid | 主键，默认 gen_random_uuid() | |
//   | user_id | uuid | 非空，→ public.users(id)，级联删除 | 所属用户 |
//
//   其他要求：按 user_id 建索引……
//
// The board writes the body from a form and reads it back; the AI writes the migration from it,
// starting from the CREATE / ALTER draft generated here.
import type { RuleItem } from "../rules/store.ts";

export type ColumnOp = "add" | "alter" | "drop";
export type ColumnSpec = {
  op: ColumnOp | null; // null in 新建表
  name: string;
  type: string;
  pk: boolean;
  notNull: boolean;
  nullable: boolean; // 修改 only: drop NOT NULL
  unique: boolean;
  default: string;
  ref: string; // `schema.table(column)`; the column defaults to id
  onDelete: "" | "cascade" | "set null";
  extra: string[]; // other constraints (e.g. `check (amount >= 0)`), kept verbatim
  comment: string;
};
export type TableSpec = { op: "create" | "alter"; schema: string; name: string; comment: string; columns: ColumnSpec[]; notes: string };

export const SECTIONS = { create: "新建表", alter: "修改表" } as const;
export const COLUMN_OPS: Record<ColumnOp, string> = { add: "新增", alter: "修改", drop: "删除" };
const OP_ALIASES: Record<string, ColumnOp> = { 新增: "add", 加: "add", 添加: "add", add: "add", 修改: "alter", 改: "alter", alter: "alter", 删除: "drop", 删: "drop", drop: "drop" };
export const IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/;
export const SCHEMA = /^[a-z0-9_]+$/;

const blankColumn = (): ColumnSpec => ({ op: null, name: "", type: "", pk: false, notNull: false, nullable: false, unique: false, default: "", ref: "", onDelete: "", extra: [], comment: "" });

// Split on commas outside parentheses, brackets and quotes.
function splitTop(text: string): string[] {
  const out: string[] = [];
  let depth = 0, quote = "", buf = "";
  for (const c of text) {
    if (quote) { if (c === quote) quote = ""; }
    else if (c === "'" || c === '"') quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (depth <= 0 && "，,、；;".includes(c)) { out.push(buf); buf = ""; continue; }
    buf += c;
  }
  out.push(buf);
  return out.map((s) => s.trim()).filter(Boolean);
}

export function parseConstraints(text: string, col: ColumnSpec = blankColumn()): ColumnSpec {
  for (const tok of splitTop(text)) {
    let m: RegExpExecArray | null;
    if (/^(主键|primary key|pk)$/i.test(tok)) col.pk = true;
    else if (/^(非空|不可空|not null)$/i.test(tok)) col.notNull = true;
    else if (/^(可空|允许空|null)$/i.test(tok)) col.nullable = true;
    else if (/^(唯一|unique)$/i.test(tok)) col.unique = true;
    else if (/^(级联删除|on delete cascade)$/i.test(tok)) col.onDelete = "cascade";
    else if (/^(删除时置空|on delete set null)$/i.test(tok)) col.onDelete = "set null";
    else if ((m = /^(?:默认值?|default)\s*[:：]?\s*(.+)$/i.exec(tok))) col.default = m[1].trim();
    else if ((m = /^(?:→|->|引用|references)\s*(.+)$/i.exec(tok))) col.ref = m[1].trim();
    else col.extra.push(tok);
  }
  return col;
}

export function formatConstraints(c: ColumnSpec): string {
  return [
    c.pk ? "主键" : "",
    c.notNull && !c.pk ? "非空" : "",
    c.nullable && !c.notNull && !c.pk ? "可空" : "",
    c.unique ? "唯一" : "",
    c.default ? `默认 ${c.default}` : "",
    c.ref ? `→ ${c.ref}` : "",
    c.ref && c.onDelete ? (c.onDelete === "cascade" ? "级联删除" : "删除时置空") : "",
    ...c.extra,
  ].filter(Boolean).join("，");
}

const cells = (line: string) =>
  line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/).map((s) => s.trim().replace(/\\\|/g, "|"));
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
const isSeparator = (line: string | undefined) => !!line && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);

// Table name of a request: the first identifier of its title (a `schema.` prefix is dropped).
export const tableName = (title: string) => title.trim().replace(/^[\w$]+\./, "").match(/^[A-Za-z_][\w$]*/)?.[0] ?? title.trim();
export const opOfSection = (section: string | null): TableSpec["op"] => (section && /修改|改表|alter/i.test(section) ? "alter" : "create");

export function parseBody(body: string, op: TableSpec["op"]): Pick<TableSpec, "comment" | "columns" | "notes"> {
  const lines = body.split("\n");
  const start = lines.findIndex((l, i) => /^\s*\|/.test(l) && isSeparator(lines[i + 1]));
  if (start < 0) return { comment: body.trim(), columns: [], notes: "" };
  const head = cells(lines[start]);
  const at = (names: RegExp) => head.findIndex((x) => names.test(x));
  const ix = { op: at(/^(操作|变更|动作)$/), name: at(/^(字段|字段名|名称|列|列名)$/), type: at(/^类型$/), cons: at(/^(约束|属性)$/), comment: at(/^(说明|备注|用途|描述)$/) };
  let end = start + 2;
  const columns: ColumnSpec[] = [];
  for (; end < lines.length && /^\s*\|/.test(lines[end]); end++) {
    const row = cells(lines[end]);
    const get = (i: number) => (i >= 0 ? row[i] ?? "" : "");
    const col = parseConstraints(get(ix.cons));
    col.name = get(ix.name).replace(/^`|`$/g, "");
    col.type = get(ix.type).replace(/^`|`$/g, "");
    col.comment = get(ix.comment);
    if (op === "alter") col.op = OP_ALIASES[get(ix.op).toLowerCase()] ?? "add";
    if (col.name) columns.push(col);
  }
  return { comment: lines.slice(0, start).join("\n").trim(), columns, notes: lines.slice(end).join("\n").trim() };
}

export function specOf(item: Pick<RuleItem, "module" | "section" | "title" | "body">): TableSpec {
  const op = opOfSection(item.section);
  return { op, schema: item.module, name: tableName(item.title), ...parseBody(item.body, op) };
}

// Clean up a spec sent by the board. `strict` (saving) also rejects what a migration could not be written from.
export function normalize(raw: any, strict = true): TableSpec {
  const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v)).trim();
  const op: TableSpec["op"] = raw?.op === "alter" ? "alter" : "create";
  const spec: TableSpec = { op, schema: str(raw?.schema), name: str(raw?.name), comment: str(raw?.comment), notes: str(raw?.notes), columns: [] };
  for (const c of Array.isArray(raw?.columns) ? raw.columns : []) {
    const col: ColumnSpec = {
      op: op === "alter" ? (["add", "alter", "drop"].includes(c?.op) ? c.op : "add") : null,
      name: str(c?.name), type: str(c?.type), pk: !!c?.pk, notNull: !!c?.notNull, nullable: !!c?.nullable && !c?.notNull, unique: !!c?.unique,
      default: str(c?.default), ref: str(c?.ref), onDelete: c?.onDelete === "cascade" || c?.onDelete === "set null" ? c.onDelete : "",
      extra: Array.isArray(c?.extra) ? c.extra.map(str).filter(Boolean) : splitTop(str(c?.extra)), comment: str(c?.comment),
    };
    if (!col.name && !col.type) continue;
    spec.columns.push(col);
  }
  if (!strict) return spec;
  if (!SCHEMA.test(spec.schema)) throw new Error("schema 只能用小写字母、数字和下划线");
  if (!IDENT.test(spec.name)) throw new Error("表名只能用字母、数字和下划线，且不能以数字开头");
  const names = new Set<string>();
  for (const c of spec.columns) {
    if (!IDENT.test(c.name)) throw new Error(`字段名「${c.name || "（空）"}」只能用字母、数字和下划线，且不能以数字开头`);
    if (names.has(`${c.op}:${c.name}`)) throw new Error(`字段 ${c.name} 写了两次`);
    names.add(`${c.op}:${c.name}`);
    if ((op === "create" || c.op === "add") && !c.type) throw new Error(`字段 ${c.name} 缺少类型`);
  }
  if (op === "create" && !spec.columns.length) throw new Error("新建表至少写一个字段");
  if (op === "alter" && !spec.columns.length && !spec.notes) throw new Error("写下要改的字段，或在「其他要求」里说明要怎么改");
  return spec;
}

// Section, title and body of a request as stored in the document.
export function formatSpec(spec: TableSpec): { section: string; title: string; body: string } {
  const alter = spec.op === "alter";
  const head = alter ? ["操作", "字段", "类型", "约束", "说明"] : ["字段", "类型", "约束", "说明"];
  const rows = spec.columns.map((c) => [...(alter ? [COLUMN_OPS[c.op ?? "add"]] : []), c.name, c.type, formatConstraints(c), c.comment].map(cell));
  const table = [head, head.map(() => "---"), ...rows].map((r) => `| ${r.join(" | ")} |`).join("\n");
  const body = [spec.comment, table, spec.notes].filter(Boolean).join("\n\n");
  return { section: SECTIONS[spec.op], title: spec.name, body };
}

// ---------- SQL draft ----------
const RESERVED = new Set("all analyse analyze and any array as asc asymmetric both case cast check collate column constraint create current_catalog current_date current_role current_time current_timestamp current_user default deferrable desc distinct do else end except false fetch for foreign from grant group having in initially intersect into lateral leading limit localtime localtimestamp not null offset on only or order placing primary references returning select session_user some symmetric table then to trailing true union unique user using variadic when where window with".split(" "));
export const quoteIdent = (name: string) => (/^[a-z_][a-z0-9_$]*$/.test(name) && !RESERVED.has(name) ? name : `"${name.replace(/"/g, '""')}"`);
const qualified = (name: string) => name.split(".").map((p) => quoteIdent(p.replace(/^"|"$/g, ""))).join(".");
const literal = (s: string) => `'${s.replace(/\s*\n\s*/g, " ").replace(/'/g, "''")}'`;

// `schema.table(col)` → `schema.table(col)` with quoting; the column defaults to id.
function references(ref: string): string {
  const m = /^([\w$."]+)\s*(?:\(\s*([^)]*)\))?$/.exec(ref.trim());
  if (!m) return ref;
  const cols = (m[2] || "id").split(",").map((c) => quoteIdent(c.trim())).join(", ");
  return `${qualified(m[1])}(${cols})`;
}
const onDelete = (c: ColumnSpec) => (c.onDelete ? ` ON DELETE ${c.onDelete.toUpperCase()}` : "");

export function toSql(spec: TableSpec, id?: string | null): string {
  const table = `${quoteIdent(spec.schema || "public")}.${quoteIdent(spec.name || "新表")}`;
  const out = [`-- 草稿：VibeDoc 按${id ? ` ${id} ` : "表单"}生成。写迁移时按仓库约定补上权限、索引、RLS 等，并放进对应 schema 的迁移目录。`];
  const comments: string[] = [];
  const colComment = (c: ColumnSpec) => { if (c.comment && c.op !== "drop") comments.push(`COMMENT ON COLUMN ${table}.${quoteIdent(c.name)} IS ${literal(c.comment)};`); };
  if (spec.op === "create") {
    const pks = spec.columns.filter((c) => c.pk);
    const defs = spec.columns.map((c) => {
      colComment(c);
      return [
        `${quoteIdent(c.name)} ${c.type || "text"}`,
        pks.length === 1 && c.pk ? "PRIMARY KEY" : "",
        c.notNull || (c.pk && pks.length > 1) ? "NOT NULL" : "",
        c.unique ? "UNIQUE" : "",
        c.default ? `DEFAULT ${c.default}` : "",
        c.ref ? `REFERENCES ${references(c.ref)}${onDelete(c)}` : "",
        ...c.extra,
      ].filter(Boolean).join(" ");
    });
    if (pks.length > 1) defs.push(`PRIMARY KEY (${pks.map((c) => quoteIdent(c.name)).join(", ")})`);
    out.push(`CREATE TABLE ${table} (\n    ${defs.join(",\n    ") || "-- 字段"}\n);`);
    if (spec.comment) out.push(`COMMENT ON TABLE ${table} IS ${literal(spec.comment)};`);
  } else {
    const actions: string[] = [];
    const notes: string[] = [];
    for (const c of spec.columns) {
      const col = quoteIdent(c.name);
      colComment(c);
      if (c.op === "drop") {
        actions.push(`DROP COLUMN ${col}`);
        if (c.comment) notes.push(`-- 删除 ${c.name}：${c.comment}`);
        continue;
      }
      if (c.op === "add") {
        actions.push([`ADD COLUMN ${col} ${c.type || "text"}`, c.pk ? "PRIMARY KEY" : "", c.notNull ? "NOT NULL" : "", c.unique ? "UNIQUE" : "", c.default ? `DEFAULT ${c.default}` : "",
          c.ref ? `REFERENCES ${references(c.ref)}${onDelete(c)}` : "", ...c.extra].filter(Boolean).join(" "));
        continue;
      }
      if (c.type) actions.push(`ALTER COLUMN ${col} TYPE ${c.type}`);
      if (c.notNull) actions.push(`ALTER COLUMN ${col} SET NOT NULL`);
      if (c.nullable) actions.push(`ALTER COLUMN ${col} DROP NOT NULL`);
      if (c.default) actions.push(`ALTER COLUMN ${col} SET DEFAULT ${c.default}`);
      if (c.pk) actions.push(`ADD PRIMARY KEY (${col})`);
      if (c.unique) actions.push(`ADD UNIQUE (${col})`);
      if (c.ref) actions.push(`ADD FOREIGN KEY (${col}) REFERENCES ${references(c.ref)}${onDelete(c)}`);
      for (const x of c.extra) (/^check\b/i.test(x) ? actions.push(`ADD ${x}`) : notes.push(`-- ${c.name}：${x}`));
    }
    if (actions.length) out.push(`ALTER TABLE ${table}\n    ${actions.join(",\n    ")};`);
    out.push(...notes);
    if (spec.comment) out.push(`-- 改动说明：${spec.comment.replace(/\s*\n\s*/g, " ")}`);
  }
  out.push(...comments);
  if (spec.notes) out.push(["-- 其他要求：", ...spec.notes.split("\n").map((l) => `--   ${l}`.trimEnd())].join("\n"));
  return out.join("\n");
}

// Whether the replayed migrations already contain what a request asks for: a new table with all its
// columns, or every added column present and every dropped column gone (changes to an existing
// column cannot be told apart, so a request with only those is never reported as applied).
export function appliedIn(spec: TableSpec, tables: Map<string, { columns: { name: string }[] }>): boolean {
  const t = tables.get(`${spec.schema}.${spec.name}`);
  if (!t) return false;
  const has = (name: string) => t.columns.some((c) => c.name === name);
  if (spec.op === "create") return spec.columns.every((c) => has(c.name));
  const checkable = spec.columns.filter((c) => c.op !== "alter");
  return checkable.length > 0 && checkable.every((c) => (c.op === "drop" ? !has(c.name) : has(c.name)));
}
