// Approximate schema state by replaying migrations: CREATE/ALTER/DROP TABLE, views, functions
// and COMMENT ON. Dynamic SQL inside DO blocks or EXECUTE is not interpreted.

export type Column = { name: string; type: string; notNull: boolean; pk: boolean; ref: string | null; comment: string };
export type Table = {
  schema: string;
  name: string;
  kind: "table" | "view";
  columns: Column[];
  comment: string;
  migrations: string[];
  createdIn: string;
};
export type SqlFunction = { schema: string; name: string; securityDefiner: boolean; returns: string; args: string; migrations: string[]; comment: string };
export type Schema = { tables: Map<string, Table>; functions: Map<string, SqlFunction> };

const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const QNAME = String.raw`(${IDENT}(?:\s*\.\s*${IDENT})?)`;
const unquote = (s: string) => s.replace(/"/g, "").replace(/\s+/g, "");

export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") {
      const e = sql.indexOf("\n", i);
      i = e < 0 ? n : e;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const e = sql.indexOf("*/", i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (c === "'") {
      let q = i + 1;
      while (q < n) {
        if (sql[q] === "'" && sql[q + 1] === "'") q += 2;
        else if (sql[q] === "'") break;
        else q++;
      }
      buf += sql.slice(i, q + 1);
      i = q + 1;
      continue;
    }
    if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
      if (m) {
        const tag = m[0];
        const e = sql.indexOf(tag, i + tag.length);
        const stop = e < 0 ? n : e + tag.length;
        buf += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }
    if (c === ";") {
      if (buf.trim()) out.push(buf.trim());
      buf = "";
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let cur = "";
  for (const c of body) {
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      parts.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function parenBody(stmt: string, openIdx: number): [string, number] {
  let depth = 0;
  let quote = "";
  for (let i = openIdx; i < stmt.length; i++) {
    const c = stmt[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return [stmt.slice(openIdx + 1, i), i];
  }
  return [stmt.slice(openIdx + 1), stmt.length];
}

const CONSTRAINT_START = /^(constraint|primary\s+key|unique|check|foreign\s+key|exclude|like)\b/i;

function parseColumn(def: string): Column | null {
  if (CONSTRAINT_START.test(def)) return null;
  const m = new RegExp(`^(${IDENT})\\s+([\\s\\S]*)$`).exec(def);
  if (!m) return null;
  const rest = m[2];
  const stop = /\s+(not\s+null|null|default|primary\s+key|references|check|unique|generated|constraint|collate)\b/i.exec(rest);
  const type = (stop ? rest.slice(0, stop.index) : rest).trim().replace(/\s+/g, " ");
  const ref = /\breferences\s+([A-Za-z0-9_."]+)/i.exec(rest);
  return {
    name: unquote(m[1]),
    type,
    notNull: /\bnot\s+null\b|\bprimary\s+key\b/i.test(rest),
    pk: /\bprimary\s+key\b/i.test(rest),
    ref: ref ? unquote(ref[1]) : null,
    comment: "",
  };
}

function tableConstraints(table: Table, defs: string[]) {
  for (const def of defs) {
    const pk = /^(?:constraint\s+\S+\s+)?primary\s+key\s*\(([^)]*)\)/i.exec(def);
    if (pk) {
      for (const col of pk[1].split(",").map(unquote)) {
        const c = table.columns.find((x) => x.name === col);
        if (c) {
          c.pk = true;
          c.notNull = true;
        }
      }
    }
    const fk = /^(?:constraint\s+\S+\s+)?foreign\s+key\s*\(([^)]*)\)\s*references\s+([A-Za-z0-9_."]+)/i.exec(def);
    if (fk) {
      for (const col of fk[1].split(",").map(unquote)) {
        const c = table.columns.find((x) => x.name === col);
        if (c) c.ref = unquote(fk[2]);
      }
    }
  }
}

export function replayMigrations(files: { path: string; sql: string; defaultSchema: string }[]): Schema {
  const schema: Schema = { tables: new Map(), functions: new Map() };
  for (const file of files) {
    // The migrator runs each domain history with `SET search_path TO <schema>, public`.
    let searchPath = file.defaultSchema;
    const qualify = (name: string) => {
      const u = unquote(name);
      return u.includes(".") ? u : `${searchPath}.${u}`;
    };
    const find = (name: string) => {
      const u = unquote(name);
      if (u.includes(".")) return schema.tables.get(u);
      return schema.tables.get(`${searchPath}.${u}`) ?? schema.tables.get(`public.${u}`);
    };
    const touch = (t: Table | undefined) => {
      if (t && !t.migrations.includes(file.path)) t.migrations.push(file.path);
    };
    for (const raw of splitStatements(file.sql)) {
      const stmt = raw.replace(/^\s*(begin|commit)\s*$/i, "");
      if (!stmt) continue;
      let m: RegExpExecArray | null;
      if ((m = /^set\s+(?:local\s+|session\s+)?search_path\s*(?:to|=)\s*([^,\s]+)/i.exec(stmt))) {
        searchPath = unquote(m[1]).replace(/'/g, "");
        continue;
      }
      if ((m = /^select\s+pg_catalog\.set_config\(\s*'search_path'\s*,\s*'([^',]+)/i.exec(stmt))) {
        searchPath = m[1].trim();
        continue;
      }
      if (/^do\s/i.test(stmt)) {
        // The legacy chain moves tables with `FOREACH name IN ARRAY ARRAY[...] LOOP EXECUTE format('ALTER TABLE public.%I SET SCHEMA x')`.
        for (const loop of stmt.matchAll(/ARRAY\s*\[([^\]]*)\]\s*LOOP([\s\S]*?)END\s+LOOP/gi)) {
          const move = /ALTER\s+TABLE\s+([A-Za-z_]+)\.%I\s+SET\s+SCHEMA\s+([A-Za-z_]+)/i.exec(loop[2]);
          if (!move) continue;
          for (const lit of loop[1].matchAll(/'([^']+)'/g)) {
            const t = schema.tables.get(`${move[1]}.${lit[1]}`);
            if (!t) continue;
            touch(t);
            schema.tables.delete(`${t.schema}.${t.name}`);
            t.schema = move[2];
            schema.tables.set(`${t.schema}.${t.name}`, t);
          }
        }
        continue;
      }
      if ((m = new RegExp(`^create\\s+(?:unlogged\\s+|temp(?:orary)?\\s+)?table\\s+(?:if\\s+not\\s+exists\\s+)?${QNAME}\\s*`, "i").exec(stmt))) {
        const key = qualify(m[1]);
        const rest = stmt.slice(m[0].length);
        const [schemaName, name] = key.split(".");
        const table: Table = schema.tables.get(key) ?? { schema: schemaName, name, kind: "table", columns: [], comment: "", migrations: [], createdIn: file.path };
        if (rest.startsWith("(") && !schema.tables.has(key)) {
          const [body] = parenBody(rest, 0);
          const defs = splitTopLevel(body);
          for (const def of defs) {
            const col = parseColumn(def);
            if (col) table.columns.push(col);
          }
          tableConstraints(table, defs);
        } else if (/^partition\s+of\s+/i.test(rest)) {
          table.comment = `分区：${rest.replace(/\s+/g, " ").slice(0, 80)}`;
        }
        schema.tables.set(key, table);
        touch(table);
        continue;
      }
      if ((m = new RegExp(`^create\\s+(?:or\\s+replace\\s+)?(?:materialized\\s+)?view\\s+(?:if\\s+not\\s+exists\\s+)?${QNAME}`, "i").exec(stmt))) {
        const key = qualify(m[1]);
        const [schemaName, name] = key.split(".");
        const view = schema.tables.get(key) ?? { schema: schemaName, name, kind: "view" as const, columns: [], comment: "", migrations: [], createdIn: file.path };
        schema.tables.set(key, view);
        touch(view);
        continue;
      }
      if ((m = new RegExp(`^drop\\s+(?:table|view|materialized\\s+view)\\s+(?:if\\s+exists\\s+)?([\\s\\S]+?)(?:\\s+cascade|\\s+restrict)?$`, "i").exec(stmt))) {
        for (const name of m[1].split(",")) {
          const t = find(name.trim());
          if (t) schema.tables.delete(`${t.schema}.${t.name}`);
        }
        continue;
      }
      if ((m = new RegExp(`^alter\\s+(?:table|view|materialized\\s+view)\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?${QNAME}\\s+([\\s\\S]*)$`, "i").exec(stmt))) {
        const t = find(m[1]);
        if (!t) continue;
        touch(t);
        const actions = m[2];
        let a: RegExpExecArray | null;
        if ((a = /^rename\s+to\s+(\S+)/i.exec(actions))) {
          schema.tables.delete(`${t.schema}.${t.name}`);
          t.name = unquote(a[1]);
          schema.tables.set(`${t.schema}.${t.name}`, t);
          continue;
        }
        if ((a = /^set\s+schema\s+(\S+)/i.exec(actions))) {
          schema.tables.delete(`${t.schema}.${t.name}`);
          t.schema = unquote(a[1]);
          schema.tables.set(`${t.schema}.${t.name}`, t);
          continue;
        }
        if ((a = /^rename\s+(?:column\s+)?(\S+)\s+to\s+(\S+)/i.exec(actions))) {
          const c = t.columns.find((x) => x.name === unquote(a![1]));
          if (c) c.name = unquote(a[2]);
          continue;
        }
        for (const action of splitTopLevel(actions)) {
          let b: RegExpExecArray | null;
          if ((b = /^add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?([\s\S]+)$/i.exec(action)) && !CONSTRAINT_START.test(b[1])) {
            const col = parseColumn(b[1]);
            if (col && !t.columns.some((x) => x.name === col.name)) t.columns.push(col);
          } else if ((b = /^add\s+([\s\S]+)$/i.exec(action))) {
            tableConstraints(t, [b[1]]);
          } else if ((b = /^drop\s+(?:column\s+)?(?:if\s+exists\s+)?(\S+)/i.exec(action)) && !/^drop\s+constraint/i.test(action)) {
            t.columns = t.columns.filter((x) => x.name !== unquote(b![1]));
          } else if ((b = /^alter\s+(?:column\s+)?(\S+)\s+(?:set\s+data\s+)?type\s+([\s\S]+?)(?:\s+using\b[\s\S]*)?$/i.exec(action))) {
            const c = t.columns.find((x) => x.name === unquote(b![1]));
            if (c) c.type = b[2].trim().replace(/\s+/g, " ");
          } else if ((b = /^alter\s+(?:column\s+)?(\S+)\s+set\s+not\s+null/i.exec(action))) {
            const c = t.columns.find((x) => x.name === unquote(b![1]));
            if (c) c.notNull = true;
          } else if ((b = /^alter\s+(?:column\s+)?(\S+)\s+drop\s+not\s+null/i.exec(action))) {
            const c = t.columns.find((x) => x.name === unquote(b![1]));
            if (c) c.notNull = false;
          }
        }
        continue;
      }
      if ((m = new RegExp(`^comment\\s+on\\s+(table|view|column)\\s+([A-Za-z0-9_."]+)\\s+is\\s+'((?:[^']|'')*)'`, "i").exec(stmt))) {
        const text = m[3].replace(/''/g, "'");
        const target = unquote(m[2]);
        if (m[1].toLowerCase() === "column") {
          const parts = target.split(".");
          const col = parts.pop()!;
          const t = find(parts.join("."));
          const c = t?.columns.find((x) => x.name === col);
          if (c) c.comment = text;
        } else {
          const t = find(target);
          if (t) t.comment = text;
        }
        continue;
      }
      if ((m = new RegExp(`^create\\s+(?:or\\s+replace\\s+)?(?:function|procedure)\\s+${QNAME}\\s*\\(`, "i").exec(stmt))) {
        const key = qualify(m[1]);
        const [schemaName, name] = key.split(".");
        const [args, closeIdx] = parenBody(stmt, m[0].length - 1);
        const returns = /^\s*returns\s+([\s\S]+?)\s+(?:language|as|security|stable|volatile|immutable|set|strict|parallel|begin|cost)\b/i.exec(stmt.slice(closeIdx + 1));
        const prev = schema.functions.get(key);
        const fn: SqlFunction = {
          schema: schemaName,
          name,
          securityDefiner: /\bsecurity\s+definer\b/i.test(stmt),
          returns: returns ? returns[1].replace(/\s+/g, " ") : "",
          args: args.replace(/\s+/g, " ").trim(),
          migrations: [...(prev?.migrations ?? []), file.path],
          comment: prev?.comment ?? "",
        };
        schema.functions.set(key, fn);
        continue;
      }
      if ((m = new RegExp(`^drop\\s+(?:function|procedure)\\s+(?:if\\s+exists\\s+)?${QNAME}`, "i").exec(stmt))) {
        schema.functions.delete(qualify(m[1]));
        continue;
      }
      if ((m = new RegExp(`^alter\\s+function\\s+${QNAME}\\s*\\([^)]*\\)\\s+set\\s+schema\\s+(\\S+)`, "i").exec(stmt))) {
        const key = qualify(m[1]);
        const fn = schema.functions.get(key);
        if (fn) {
          schema.functions.delete(key);
          fn.schema = unquote(m[2]);
          schema.functions.set(`${fn.schema}.${fn.name}`, fn);
        }
        continue;
      }
      if ((m = new RegExp(`^comment\\s+on\\s+function\\s+${QNAME}[\\s\\S]*?\\s+is\\s+'((?:[^']|'')*)'`, "i").exec(stmt))) {
        const fn = schema.functions.get(qualify(m[1]));
        if (fn) fn.comment = m[2].replace(/''/g, "'");
      }
    }
  }
  return schema;
}

export type TableRef = { name: string; write: boolean };
export type SqlRefs = { tables: TableRef[]; functions: string[] };

// Extract table and SQL-function references from a query string. Names that do not resolve
// to a known table or function are dropped, which filters out CTEs and `EXTRACT(x FROM y)`.
export function sqlRefs(sql: string, resolveTable: (name: string) => string | null, resolveFunction: (name: string) => string | null): SqlRefs {
  const tables = new Map<string, boolean>();
  const re = /\b(from|join|into|update|delete\s+from)\s+(?:only\s+)?([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    const kw = m[1].toLowerCase().replace(/\s+/g, " ");
    const before = sql.slice(Math.max(0, m.index - 12), m.index).toLowerCase();
    if (kw === "update" && /\b(for|do)\s*$/.test(before)) continue;
    if (kw === "from" && /\bdelete\s*$/.test(before)) continue;
    const resolved = resolveTable(m[2]);
    if (!resolved) continue;
    const write = kw === "into" || kw === "update" || kw === "delete from";
    tables.set(resolved, (tables.get(resolved) ?? false) || write);
  }
  const functions = new Set<string>();
  const fre = /\b([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*|[A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  while ((m = fre.exec(sql))) {
    const resolved = resolveFunction(m[1]);
    if (resolved) functions.add(resolved);
  }
  return { tables: [...tables].map(([name, write]) => ({ name, write })), functions: [...functions] };
}
