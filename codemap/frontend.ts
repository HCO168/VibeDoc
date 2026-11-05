// Frontend scan: API path literals, the function that issues each request, imports between
// files, and `<Route path=...>` declarations. Text-based; computed paths are not followed.

export type ApiCall = { path: string; method: string | null; line: number };
export type ClientFn = { name: string; docs: string; line: number; calls: ApiCall[] };
export type FrontFile = {
  clientFns: ClientFn[];
  looseCalls: ApiCall[];
  imports: { names: string[]; from: string }[];
  routes: { path: string; component: string; line: number }[];
  lazyImports: Map<string, string>;
  exports: string[];
};

const lineAt = (src: string, idx: number) => {
  let line = 1;
  for (let i = 0; i < idx; i++) if (src.charCodeAt(i) === 10) line++;
  return line;
};

export function parseFront(src: string, firstSegments: Set<string>): FrontFile {
  const out: FrontFile = { clientFns: [], looseCalls: [], imports: [], routes: [], lazyImports: new Map(), exports: [] };

  const decls: { name: string; idx: number; docs: string; line: number }[] = [];
  const declRe = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\(|[A-Za-z_$][\w$]*\s*=>|function)/gm;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(src))) {
    const name = m[1] ?? m[2];
    const before = src.slice(0, m.index);
    const doc = /\/\*\*([\s\S]*?)\*\/\s*$/.exec(before);
    const docs = doc
      ? doc[1].split("\n").map((l) => l.replace(/^\s*\*\s?/, "").trim()).filter((l) => l && !l.startsWith("@")).join(" ")
      : "";
    decls.push({ name, idx: m.index, docs, line: lineAt(src, m.index) });
  }
  for (const em of src.matchAll(/^export\s+(?:default\s+)?(?:async\s+)?(?:function\s*\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) out.exports.push(em[1]);

  // A path literal, optionally after one `${base}` prefix (`${API}/items`); route declarations are pages, not requests.
  const literalRe = /(["'`])(?:\$\{[^}]*\})?(\/[A-Za-z][^"'`\s]*?)\1/g;
  while ((m = literalRe.exec(src))) {
    if (/\bpath=\s*$/.test(src.slice(Math.max(0, m.index - 12), m.index))) continue;
    let path = m[2];
    const first = path.split(/[/?$]/)[1];
    if (!firstSegments.has(first)) continue;
    path = path.replace(/\$\{[^}]*\}/g, "{}").split("?")[0];
    if (/\{\}$/.test(path) && !path.endsWith("/{}")) path = path.replace(/\{\}$/, "");
    const tail = src.slice(m.index, m.index + 400);
    const stopAt = tail.search(/\n\s*\}\s*\)?;?\s*\n/);
    const window = stopAt > 0 ? tail.slice(0, stopAt) : tail;
    const method = /\bmethod\s*:\s*["'`]([A-Za-z]+)["'`]/.exec(window);
    const call: ApiCall = { path, method: method ? method[1].toUpperCase() : null, line: lineAt(src, m.index) };
    let owner: (typeof decls)[number] | undefined;
    for (const d of decls) if (d.idx < m.index) owner = d;
    if (owner) {
      let fn = out.clientFns.find((f) => f.name === owner!.name);
      if (!fn) {
        fn = { name: owner.name, docs: owner.docs, line: owner.line, calls: [] };
        out.clientFns.push(fn);
      }
      fn.calls.push(call);
    } else out.looseCalls.push(call);
  }

  for (const im of src.matchAll(/import\s+(?:type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g)) {
    const names: string[] = [];
    const spec = im[1];
    const named = /\{([\s\S]*)\}/.exec(spec);
    if (named) {
      for (const part of named[1].split(",")) {
        const p = part.trim().replace(/^type\s+/, "");
        if (!p) continue;
        const asMatch = /^(\S+)\s+as\s+(\S+)$/.exec(p);
        names.push(asMatch ? asMatch[1] : p);
      }
    }
    const def = /^([A-Za-z_$][\w$]*)/.exec(spec.trim());
    if (def && !spec.trim().startsWith("{")) names.push(`default:${def[1]}`);
    out.imports.push({ names, from: im[2] });
  }
  for (const lz of src.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:React\.)?lazy\w*\(\s*\(\)\s*=>\s*import\(\s*["']([^"']+)["']/g)) {
    out.lazyImports.set(lz[1], lz[2]);
  }
  // `element={<Page />}` or wrapped once, as in `element={userDriveElement(<Page />)}`.
  for (const r of src.matchAll(/<Route\b[^>]*?\bpath=["']([^"']+)["'][^>]*?\belement=\{\s*(?:[A-Za-z_$][\w$.]*\(\s*)?<\s*([A-Za-z_$][\w$.]*)/g)) {
    out.routes.push({ path: r[1], component: r[2], line: lineAt(src, r.index ?? 0) });
  }
  return out;
}

// Match a frontend path (with `{}` placeholders) against an axum route pattern.
export function pathMatches(front: string, route: string): boolean {
  const a = front.split("/").filter(Boolean);
  const b = route.split("/").filter(Boolean);
  const wildcard = b.length > 0 && b[b.length - 1].startsWith("{*");
  if (a.length !== b.length && !(wildcard && a.length >= b.length - 1)) return false;
  for (let i = 0; i < b.length; i++) {
    const r = b[i];
    if (r.startsWith("{*")) return true;
    const f = a[i];
    if (f === undefined) return false;
    if (r.startsWith("{") || r.startsWith(":") || f === "{}") continue;
    if (f.includes("{}")) {
      const re = new RegExp("^" + f.split("{}").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".+") + "$");
      if (!re.test(r)) return false;
      continue;
    }
    if (f !== r) return false;
  }
  return true;
}
