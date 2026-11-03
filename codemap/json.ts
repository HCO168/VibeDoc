import type { Model } from "./model.ts";
import { moduleStats } from "./render.ts";
import { wireShape } from "./serde.ts";

// Plain-data form of the model, shared by `generate` (codemap.json) and the board server.
export function toJson(model: Model) {
  return {
    modules: model.modules.map((m) => ({ ...m, stats: moduleStats(model, m.id) })),
    functions: [...model.fns.values()].map((n) => ({
      id: n.id,
      key: n.key,
      module: n.module,
      layer: n.layer,
      file: n.file,
      line: n.fn.line,
      signature: n.fn.signature,
      docs: n.fn.docs,
      sharedWith: n.sharedWith,
      callers: [...n.callers],
      callees: [...n.callees],
      tables: [...n.tables].map(([name, write]) => ({ name, write })),
      sqlFunctions: [...n.sqlFunctions],
      backends: n.backends,
    })),
    backends: model.backends,
    routes: model.routes.map((r) => {
      const file = r.handler ? model.fns.get(r.handler)?.file : undefined;
      const refs = (text: string | null) => (text && file ? model.typeRefs(file, text).map((t) => t.id) : []);
      return { ...r, apiRefs: r.api ? { path: refs(r.api.path), query: refs(r.api.query), body: refs(r.api.body), response: refs(r.api.response) } : null };
    }),
    types: model.types
      .filter((t) => t.type.kind !== "trait" && (t.dto || model.routes.some((r) => r.api?.types.includes(t.id))))
      .map((t) => {
        const shape = wireShape(t.type);
        return {
          id: t.id,
          name: t.type.name,
          generics: t.type.generics,
          kind: t.type.kind,
          module: t.module,
          file: t.file,
          line: t.type.line,
          docs: t.type.docs,
          alias: t.type.alias,
          notes: shape.notes,
          fields: shape.fields.map((f) => ({ ...f, refs: model.typeRefs(t.file, f.type).map((x) => x.id) })),
          variants: shape.variants.map((v) => ({ ...v, refs: v.payload ? model.typeRefs(t.file, v.payload).map((x) => x.id) : [] })),
        };
      }),
    tables: [...model.schema.tables].map(([key, t]) => ({ key, module: model.tableModule.get(key), ...t })),
    sqlFunctions: [...model.schema.functions].map(([key, f]) => ({ key, module: model.functionModule.get(key), ...f })),
    frontendRoutes: model.frontRoutes,
    frontendFiles: [...model.front.values()].map((f) => ({
      file: f.file,
      module: f.module,
      clientFns: f.parsed.clientFns.map((c) => ({ name: c.name, docs: c.docs, line: c.line })),
      routes: model.routes
        .filter((r) => r.frontend.some((x) => x.file === f.file || f.uses.some((u) => u.file === x.file && u.fn === x.fn)))
        .map((r) => r.id),
      imports: f.imports,
      // Requests this file itself makes: imported client functions, inline calls, and its own unexported helpers.
      // An exported client function counts where it is imported, so an API module does not claim every route.
      calls: model.routes
        .filter((r) => r.frontend.some((x) =>
          f.uses.some((u) => u.file === x.file && u.fn === x.fn) ||
          (x.file === f.file && (x.fn === null || !f.parsed.exports.includes(x.fn)))))
        .map((r) => r.id),
    })),
  };
}
