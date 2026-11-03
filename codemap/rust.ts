// Lightweight Rust source scanner: enough structure for a code map (items, doc comments,
// call paths, SQL literals, axum `.route(...)` registrations). It does not type-check, so
// method calls (`value.method()`) and calls through traits or closures are not resolved.

export type Tok = { k: "id" | "p" | "s" | "doc" | "ch" | "lt" | "n"; t: string; v?: string; line: number; pos: number; end: number };

export type RouteReg = { path: string; methods: { method: string; handler: string[] | null }[]; line: number };

export type RustFn = {
  name: string;
  implType: string | null;
  vis: "pub" | "crate" | "private";
  signature: string;
  docs: string;
  line: number;
  endLine: number;
  calls: string[][];
  sql: string[];
  routes: RouteReg[];
  isTest: boolean;
};

export type RustField = { name: string; type: string; docs: string; attrs: string[] };
export type RustVariant = { name: string; docs: string; attrs: string[]; fields: RustField[]; tuple: string[] };
export type RustType = {
  name: string;
  kind: string;
  docs: string;
  line: number;
  vis: "pub" | "crate" | "private";
  attrs: string[];
  generics: string;
  fields: RustField[];
  tuple: string[];
  variants: RustVariant[];
  alias: string | null;
};

export type RustFile = {
  fns: RustFn[];
  types: RustType[];
  uses: Map<string, string[]>;
  globs: string[][];
  consts: Map<string, string>;
};

const IDENT_START = /[A-Za-z_À-￿]/;
const IDENT_PART = /[A-Za-z0-9_À-￿]/;

export function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  let line = 1;
  const n = src.length;
  const push = (k: Tok["k"], start: number, end: number, startLine: number, v?: string) =>
    toks.push({ k, t: src.slice(start, end), v, line: startLine, pos: start, end });
  const countLines = (from: number, to: number) => {
    for (let q = from; q < to; q++) if (src.charCodeAt(q) === 10) line++;
  };
  const rawString = (start: number, hashStart: number) => {
    let q = hashStart;
    let hashes = 0;
    while (src[q] === "#") {
      hashes++;
      q++;
    }
    if (src[q] !== '"') return -1;
    const close = '"' + "#".repeat(hashes);
    const endIdx = src.indexOf(close, q + 1);
    const stop = endIdx < 0 ? n : endIdx + close.length;
    const startLine = line;
    countLines(start, stop);
    push("s", start, stop, startLine, src.slice(q + 1, endIdx < 0 ? n : endIdx));
    return stop;
  };
  while (i < n) {
    const c = src[i];
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      let e = src.indexOf("\n", i);
      if (e < 0) e = n;
      if (src[i + 2] === "/" && src[i + 3] !== "/") {
        push("doc", i, e, line, src.slice(i + 3, e).replace(/^ /, ""));
      }
      i = e;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      let depth = 1;
      let q = i + 2;
      while (q < n && depth > 0) {
        if (src[q] === "/" && src[q + 1] === "*") {
          depth++;
          q += 2;
        } else if (src[q] === "*" && src[q + 1] === "/") {
          depth--;
          q += 2;
        } else q++;
      }
      countLines(i, q);
      i = q;
      continue;
    }
    if (c === "r" && (src[i + 1] === "#" || src[i + 1] === '"')) {
      if (src[i + 1] === "#" && IDENT_START.test(src[i + 2] ?? "")) {
        let q = i + 2;
        while (q < n && IDENT_PART.test(src[q])) q++;
        push("id", i + 2, q, line);
        i = q;
        continue;
      }
      const stop = rawString(i, i + 1);
      if (stop > 0) {
        i = stop;
        continue;
      }
    }
    if ((c === "b" || c === "c") && src[i + 1] === "r" && (src[i + 2] === "#" || src[i + 2] === '"')) {
      const stop = rawString(i, i + 2);
      if (stop > 0) {
        i = stop;
        continue;
      }
    }
    if (c === '"' || ((c === "b" || c === "c") && src[i + 1] === '"')) {
      const startLine = line;
      let q = c === '"' ? i + 1 : i + 2;
      const bodyStart = q;
      while (q < n && src[q] !== '"') {
        if (src[q] === "\\") q++;
        q++;
      }
      countLines(i, q);
      push("s", i, q + 1, startLine, src.slice(bodyStart, q));
      i = q + 1;
      continue;
    }
    if (c === "'" || (c === "b" && src[i + 1] === "'")) {
      const q0 = c === "'" ? i + 1 : i + 2;
      if (src[q0] === "\\") {
        let q = q0 + 1;
        while (q < n && src[q] !== "'") q++;
        push("ch", i, q + 1, line);
        i = q + 1;
        continue;
      }
      const cp = src.codePointAt(q0) ?? 0;
      const width = cp > 0xffff ? 2 : 1;
      if (src[q0 + width] === "'") {
        push("ch", i, q0 + width + 1, line);
        i = q0 + width + 1;
        continue;
      }
      if (c === "'") {
        let q = i + 1;
        while (q < n && IDENT_PART.test(src[q])) q++;
        push("lt", i, q, line);
        i = q;
        continue;
      }
    }
    if (IDENT_START.test(c)) {
      let q = i + 1;
      while (q < n && IDENT_PART.test(src[q])) q++;
      push("id", i, q, line);
      i = q;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let q = i + 1;
      while (q < n && /[0-9A-Za-z_]/.test(src[q])) q++;
      if (src[q] === "." && /[0-9]/.test(src[q + 1] ?? "")) {
        q++;
        while (q < n && /[0-9A-Za-z_]/.test(src[q])) q++;
      }
      push("n", i, q, line);
      i = q;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "::" || two === "->" || two === "=>") {
      push("p", i, i + 2, line);
      i += 2;
      continue;
    }
    push("p", i, i + 1, line);
    i++;
  }
  return toks;
}

const MODIFIERS = new Set(["pub", "async", "const", "unsafe", "extern", "default"]);
const NOT_CALLS = new Set([
  "if", "while", "for", "match", "return", "loop", "in", "as", "let", "fn", "move", "async", "await", "where",
  "Some", "Ok", "Err", "None", "Box", "Vec", "String", "Arc", "Rc", "self", "Self", "super", "impl", "dyn", "mut", "ref",
]);
const ROUTE_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "any"]);
const SQL_HINT = /\bselect\b[\s\S]*\bfrom\b|\binsert\s+into\b|\bupdate\s+[a-z_."]+\s+set\b|\bdelete\s+from\b|\bselect\s+[a-z_]+\.[a-z_]+\s*\(/i;

function matchBrackets(toks: Tok[]): Int32Array {
  const match = new Int32Array(toks.length).fill(-1);
  const stack: number[] = [];
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    if (tk.k !== "p") continue;
    if (tk.t === "(" || tk.t === "[" || tk.t === "{") stack.push(i);
    else if (pairs[tk.t]) {
      while (stack.length && toks[stack[stack.length - 1]].t !== pairs[tk.t]) stack.pop();
      const open = stack.pop();
      if (open !== undefined) {
        match[open] = i;
        match[i] = open;
      }
    }
  }
  return match;
}

export function parseRust(src: string): RustFile {
  const toks = tokenize(src);
  const match = matchBrackets(toks);
  const out: RustFile = { fns: [], types: [], uses: new Map(), globs: [], consts: new Map() };
  const at = (i: number) => toks[i] ?? { k: "p", t: "", line: 0, pos: src.length, end: src.length };
  const close = (i: number) => (match[i] >= 0 ? match[i] : toks.length - 1);

  type Head = { start: number; docs: string[]; attrs: string[]; vis: RustFn["vis"] };
  const head = (i: number, floor: number): Head => {
    const h: Head = { start: i, docs: [], attrs: [], vis: "private" };
    let k = i - 1;
    while (k >= floor) {
      const tk = toks[k];
      if (tk.k === "id" && MODIFIERS.has(tk.t)) {
        if (tk.t === "pub" && h.vis === "private") h.vis = "pub";
        h.start = k;
        k--;
      } else if (tk.k === "s" && at(k - 1).t === "extern") {
        h.start = k;
        k--;
      } else if (tk.t === ")" && match[k] >= 0 && at(match[k] - 1).t === "pub") {
        h.vis = "crate";
        h.start = match[k] - 1;
        k = match[k] - 2;
      } else if (tk.t === "]" && match[k] >= 0 && at(match[k] - 1).t === "#") {
        h.attrs.unshift(src.slice(toks[match[k] - 1].pos, tk.end));
        k = match[k] - 2;
      } else if (tk.k === "doc") {
        h.docs.unshift(tk.v ?? "");
        k--;
      } else break;
    }
    return h;
  };
  const isTestAttr = (attrs: string[]) => attrs.some((a) => /^#\[(cfg\(test\)|test|tokio::test|sqlx::test)/.test(a.replace(/\s+/g, "")));

  const useTree = (i: number, prefix: string[]): number => {
    const segs = [...prefix];
    while (i < toks.length) {
      const tk = toks[i];
      if (tk.t === "{") {
        let q = i + 1;
        const end = close(i);
        while (q < end) {
          q = useTree(q, segs);
          if (at(q).t === ",") q++;
          else if (q < end && at(q).t !== "}") q++;
        }
        return end + 1;
      }
      if (tk.t === "*") {
        out.globs.push(segs);
        return i + 1;
      }
      if (tk.t === "::") {
        i++;
        continue;
      }
      if (tk.k === "id") {
        segs.push(tk.t);
        i++;
        if (at(i).t === "::") {
          i++;
          continue;
        }
        let alias = tk.t;
        let path = segs;
        if (at(i).t === "as") {
          alias = at(i + 1).t;
          i += 2;
        }
        if (tk.t === "self") {
          path = segs.slice(0, -1);
          if (alias === "self") alias = path[path.length - 1];
        }
        if (alias !== "_") out.uses.set(alias, path);
        return i;
      }
      return i + 1;
    }
    return i;
  };

  const pathAt = (k: number): [string[], number] => {
    const segs = [toks[k].t];
    let m = k;
    while (at(m + 1).t === "::" && at(m + 2).k === "id") {
      segs.push(toks[m + 2].t);
      m += 2;
    }
    return [segs, m];
  };

  const analyzeBody = (from: number, to: number, fn: RustFn) => {
    for (let k = from; k < to; k++) {
      const tk = toks[k];
      if (tk.k === "s") {
        if (tk.v && tk.v.length > 12 && SQL_HINT.test(tk.v)) fn.sql.push(tk.v);
        continue;
      }
      if (tk.t === "." && at(k + 1).t === "route" && at(k + 2).t === "(") {
        const argsEnd = close(k + 2);
        const first = at(k + 3);
        const path = first.k === "s" ? first.v ?? "" : first.k === "id" ? out.consts.get(first.t) ?? `<${first.t}>` : "<动态路径>";
        const reg: RouteReg = { path, methods: [], line: tk.line };
        for (let q = k + 4; q < argsEnd; q++) {
          const m = toks[q];
          if (m.k === "id" && ROUTE_METHODS.has(m.t) && at(q + 1).t === "(" && [",", ".", "::", "("].includes(at(q - 1).t)) {
            const h = at(q + 2);
            let handler: string[] | null = null;
            if (h.k === "id" && !["move", "async"].includes(h.t)) handler = pathAt(q + 2)[0];
            reg.methods.push({ method: m.t.toUpperCase(), handler });
          }
        }
        fn.routes.push(reg);
        continue;
      }
      if (tk.k !== "id" || NOT_CALLS.has(tk.t)) continue;
      const prev = at(k - 1).t;
      if (prev === "." || prev === "::" || prev === "fn") continue;
      const [segs, m] = pathAt(k);
      let after = m + 1;
      if (at(after).t === "::" && at(after + 1).t === "<") {
        let depth = 0;
        let q = after + 1;
        for (; q < to; q++) {
          if (toks[q].t === "<") depth++;
          else if (toks[q].t === ">") {
            depth--;
            if (depth === 0) break;
          }
        }
        after = q + 1;
      }
      if (at(after).t === "(") fn.calls.push(segs);
      k = m;
    }
  };

  // Doc comments, attributes and visibility in front of a field or variant.
  const leading = (k: number, to: number): [string[], string[], number] => {
    const docs: string[] = [];
    const attrs: string[] = [];
    while (k < to) {
      if (toks[k].k === "doc") docs.push(toks[k++].v ?? "");
      else if (toks[k].t === "#" && at(k + 1).t === "[") {
        attrs.push(src.slice(toks[k].pos, toks[close(k + 1)].end));
        k = close(k + 1) + 1;
      } else if (toks[k].t === "pub") {
        k++;
        if (at(k).t === "(") k = close(k) + 1;
      } else break;
    }
    return [docs, attrs, k];
  };
  // Index of the next depth-0 comma (or `to`), skipping generic and bracket groups.
  const nextComma = (k: number, to: number) => {
    let depth = 0;
    for (; k < to; k++) {
      const t = toks[k].t;
      if (t === "(" || t === "[" || t === "{") k = close(k);
      else if (t === "<") depth++;
      else if (t === ">") depth--;
      else if (t === "," && depth <= 0) break;
    }
    return k;
  };
  const text = (from: number, to: number) => (to > from ? src.slice(toks[from].pos, toks[to - 1].end).replace(/\s+/g, " ") : "");
  const parseFields = (from: number, to: number): RustField[] => {
    const fields: RustField[] = [];
    let k = from;
    while (k < to) {
      const [docs, attrs, start] = leading(k, to);
      if (start >= to) break;
      const end = nextComma(start, to);
      if (toks[start].k === "id" && at(start + 1).t === ":") {
        fields.push({ name: toks[start].t, type: text(start + 2, end), docs: docs.join("\n").trim(), attrs });
      }
      k = end + 1;
    }
    return fields;
  };
  function parseTuple(from: number, to: number): string[] {
    const items: string[] = [];
    let k = from;
    while (k < to) {
      const [, , start] = leading(k, to);
      if (start >= to) break;
      const end = nextComma(start, to);
      items.push(text(start, end));
      k = end + 1;
    }
    return items;
  }
  function parseVariants(from: number, to: number): RustVariant[] {
    const variants: RustVariant[] = [];
    let k = from;
    while (k < to) {
      const [docs, attrs, start] = leading(k, to);
      if (start >= to || toks[start].k !== "id") break;
      const v: RustVariant = { name: toks[start].t, docs: docs.join("\n").trim(), attrs, fields: [], tuple: [] };
      let q = start + 1;
      if (at(q).t === "(") {
        v.tuple = parseTuple(q + 1, close(q));
        q = close(q) + 1;
      } else if (at(q).t === "{") {
        v.fields = parseFields(q + 1, close(q));
        q = close(q) + 1;
      }
      variants.push(v);
      k = nextComma(q, to) + 1;
    }
    return variants;
  }

  const walk = (from: number, to: number, implType: string | null, inTest: boolean) => {
    let floor = from;
    for (let i = from; i < to; i++) {
      const tk = toks[i];
      if (tk.k === "p" && (tk.t === ";" || tk.t === "}")) {
        floor = i + 1;
        continue;
      }
      if (tk.k !== "id") continue;
      if (tk.t === "use") {
        let q = i + 1;
        const end = (() => {
          let e = q;
          while (e < to && toks[e].t !== ";") e = toks[e].t === "{" ? close(e) + 1 : e + 1;
          return e;
        })();
        useTree(q, []);
        i = end;
        floor = i + 1;
        continue;
      }
      if (tk.t === "macro_rules" && at(i + 1).t === "!") {
        let q = i + 2;
        while (q < to && !["{", "(", "["].includes(toks[q].t)) q++;
        i = close(q);
        floor = i + 1;
        continue;
      }
      if (tk.t === "const" && at(i + 1).k === "id" && at(i + 2).t === ":") {
        let q = i + 3;
        while (q < to && toks[q].t !== "=" && toks[q].t !== ";") q++;
        if (toks[q]?.t === "=" && at(q + 1).k === "s" && at(q + 2).t === ";") out.consts.set(toks[i + 1].t, at(q + 1).v ?? "");
        continue;
      }
      if (tk.t === "mod" && at(i + 1).k === "id" && at(i + 2).t === "{") {
        const h = head(i, floor);
        const end = close(i + 2);
        if (!isTestAttr(h.attrs)) walk(i + 3, end, null, inTest);
        i = end;
        floor = i + 1;
        continue;
      }
      if ((tk.t === "impl" || tk.t === "trait") && ![":", "->", "(", ",", "<", "=", "&", "dyn"].includes(at(i - 1).t)) {
        let q = i + 1;
        while (q < to && toks[q].t !== "{" && toks[q].t !== ";") q++;
        if (toks[q]?.t !== "{") continue;
        let name: string | null = null;
        if (tk.t === "trait") {
          name = at(i + 1).t;
          const h = head(i, floor);
          out.types.push({ name, kind: "trait", docs: h.docs.join("\n"), line: tk.line, vis: h.vis, attrs: h.attrs, generics: "", fields: [], tuple: [], variants: [], alias: null });
        } else {
          const depth0: Tok[] = [];
          let depth = 0;
          for (let r = i + 1; r < q; r++) {
            const t = toks[r].t;
            if (t === "<") depth++;
            else if (t === ">") depth--;
            else if (depth === 0) depth0.push(toks[r]);
          }
          const forIdx = depth0.findIndex((t) => t.t === "for");
          const seq = forIdx >= 0 ? depth0.slice(forIdx + 1) : depth0;
          const whereIdx = seq.findIndex((t) => t.t === "where");
          const ids = (whereIdx >= 0 ? seq.slice(0, whereIdx) : seq).filter((t) => t.k === "id" && t.t !== "dyn");
          name = ids.length ? ids[ids.length - 1].t : null;
        }
        const end = close(q);
        walk(q + 1, end, name, inTest);
        i = end;
        floor = i + 1;
        continue;
      }
      if ((tk.t === "struct" || tk.t === "enum" || tk.t === "union" || tk.t === "type") && at(i + 1).k === "id" && at(i - 1).t !== "::") {
        const h = head(i, floor);
        const type: RustType = {
          name: toks[i + 1].t, kind: tk.t, docs: h.docs.join("\n"), line: tk.line, vis: h.vis, attrs: h.attrs,
          generics: "", fields: [], tuple: [], variants: [], alias: null,
        };
        let q = i + 2;
        while (q < to && toks[q].t !== "{" && toks[q].t !== ";" && toks[q].t !== "(" && toks[q].t !== "=") {
          if (toks[q].t === "<") {
            const g0 = q;
            let depth = 0;
            for (; q < to; q++) {
              if (toks[q].t === "<") depth++;
              else if (toks[q].t === ">" && --depth === 0) break;
            }
            if (g0 === i + 2) type.generics = src.slice(toks[g0].pos, toks[q].end);
          }
          q++;
        }
        if (toks[q]?.t === "=") {
          const start = q + 1;
          while (q < to && toks[q].t !== ";") q++;
          type.alias = src.slice(at(start).pos, toks[q - 1].end).replace(/\s+/g, " ");
        }
        if (toks[q]?.t === "(") {
          type.tuple = parseTuple(q + 1, close(q));
          q = close(q) + 1;
          while (q < to && toks[q].t !== ";" && toks[q].t !== "{") q++;
        }
        if (toks[q]?.t === "{") {
          if (tk.t === "enum") type.variants = parseVariants(q + 1, close(q));
          else type.fields = parseFields(q + 1, close(q));
        }
        if (tk.t !== "type" || implType === null) out.types.push(type);
        i = toks[q]?.t === "{" ? close(q) : q;
        floor = i + 1;
        continue;
      }
      if (tk.t === "fn" && at(i + 1).k === "id") {
        const h = head(i, floor);
        let j = i + 2;
        while (j < to) {
          const t = toks[j].t;
          if (t === "(" || t === "[") j = close(j) + 1;
          else if (t === "{" || t === ";") break;
          else j++;
        }
        const bodyOpen = toks[j]?.t === "{";
        const end = bodyOpen ? close(j) : j;
        const fn: RustFn = {
          name: toks[i + 1].t,
          implType,
          vis: h.vis,
          signature: src.slice(toks[h.start].pos, toks[j]?.pos ?? src.length).replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/,\s*\)/g, ")").trim(),
          docs: h.docs.join("\n").trim(),
          line: tk.line,
          endLine: at(end).line,
          calls: [],
          sql: [],
          routes: [],
          isTest: inTest || isTestAttr(h.attrs),
        };
        if (bodyOpen) analyzeBody(j + 1, end, fn);
        out.fns.push(fn);
        i = end;
        floor = i + 1;
        continue;
      }
    }
  };

  walk(0, toks.length, null, false);
  return out;
}
