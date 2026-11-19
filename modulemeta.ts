import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type Sources = { manifest?: string; cargo?: string };

function sourceText(root: string, file: string) {
  if (!file || isAbsolute(file)) throw new Error();
  const base = realpathSync(root);
  const path = realpathSync(resolve(base, file));
  const rel = relative(base, path);
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel) || !statSync(path).isFile()) throw new Error();
  return readFileSync(path, "utf8");
}

export function moduleMetadata(root: string, id: string, sources: Sources) {
  const errors: string[] = [];
  let sourceVersion: string | undefined;
  let manifest;
  if (sources.cargo) {
    try {
      const text = sourceText(root, sources.cargo);
      const section = text.split(/^\s*\[package\]\s*(?:#.*)?$/m)[1]?.split(/^\s*\[/m)[0];
      sourceVersion = section?.match(/^\s*version\s*=\s*["']([^"'\n]+)["']\s*(?:#.*)?$/m)?.[1];
      if (!sourceVersion) throw new Error();
    } catch { errors.push("无法读取 Cargo 清单中的 package.version"); }
  }
  if (sources.manifest) {
    try {
      const data = JSON.parse(sourceText(root, sources.manifest));
      if (data.module_id !== id) throw new Error();
      const optionalText = (v: unknown) => {
        if (v === undefined || typeof v === "string") return v;
        throw new Error();
      };
      const requires = data.requires?.map((d: Record<string, unknown>) => {
        if (typeof d.module_id !== "string" || typeof d.required !== "boolean") throw new Error();
        return { id: d.module_id, required: d.required, capability: optionalText(d.capability),
          version: optionalText(d.api_version), scope: optionalText(d.scope) };
      });
      if (data.provides !== undefined && (!data.provides || typeof data.provides !== "object" ||
          Array.isArray(data.provides) || !Object.values(data.provides).every(v => typeof v === "string"))) throw new Error();
      const conflicts = data.conflicts?.map((entry: Record<string, unknown>) => {
        if (!entry || typeof entry.module_id !== "string") throw new Error();
        return [entry.module_id, optionalText(entry.capability), optionalText(entry.api_version)].filter(Boolean).join(" ");
      });
      manifest = { requires, provides: data.provides, conflicts,
        platform: optionalText(data.platform_api), buildVersion: optionalText(data.module_version) };
    } catch { errors.push("模块清单无法读取、字段格式有误或模块 ID 不匹配"); }
  }
  return { sources, sourceVersion, manifest, errors };
}
