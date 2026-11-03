// What a Rust struct or enum looks like on the wire, as far as its serde attributes say.
import type { RustType, RustField } from "./rust.ts";

export type WireField = { json: string; rust: string; type: string; required: boolean; nullable: boolean; notes: string[]; docs: string };
export type WireVariant = { json: string; rust: string; docs: string; payload: string };
export type WireShape = { fields: WireField[]; variants: WireVariant[]; notes: string[] };

const serdeArgs = (attrs: string[]) =>
  attrs
    .map((a) => /^#\[\s*serde\s*\(([\s\S]*)\)\s*\]$/.exec(a.trim())?.[1] ?? "")
    .filter(Boolean)
    .join(", ");
const str = (args: string, key: string) => new RegExp(`(?:^|[\\s,(])${key}\\s*=\\s*"([^"]*)"`).exec(args)?.[1] ?? null;
const has = (args: string, key: string) => new RegExp(`(?:^|[\\s,(])${key}(?:\\s*[,)=]|\\s*$)`).test(args);

export function renameCase(name: string, rule: string | null, isVariant: boolean): string {
  if (!rule) return name;
  const words = isVariant ? name.split(/(?=[A-Z])/).map((w) => w.toLowerCase()) : name.split("_").filter(Boolean);
  const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
  switch (rule) {
    case "lowercase": return isVariant ? name.toLowerCase() : name.toLowerCase();
    case "UPPERCASE": return name.toUpperCase();
    case "PascalCase": return words.map(cap).join("");
    case "camelCase": return words.map((w, i) => (i ? cap(w) : w)).join("");
    case "snake_case": return words.join("_");
    case "SCREAMING_SNAKE_CASE": return words.join("_").toUpperCase();
    case "kebab-case": return words.join("-");
    case "SCREAMING-KEBAB-CASE": return words.join("-").toUpperCase();
    default: return name;
  }
}

function wireField(f: RustField, renameAll: string | null, typeDefault: boolean): WireField | null {
  const args = serdeArgs(f.attrs);
  if (has(args, "skip")) return null;
  const notes: string[] = [];
  const nullable = /^(?:std::option::)?Option\s*</.test(f.type);
  const hasDefault = has(args, "default") || /(?:^|[\s,(])default\s*=/.test(args) || typeDefault;
  if (has(args, "flatten")) notes.push("展开（flatten）到外层");
  if (/skip_serializing_if/.test(args)) notes.push("为空时响应中省略");
  if (has(args, "skip_serializing")) notes.push("不出现在响应中");
  if (has(args, "skip_deserializing")) notes.push("请求中忽略");
  const alias = str(args, "alias");
  if (alias) notes.push(`也接受 \`${alias}\``);
  return {
    json: str(args, "rename") ?? renameCase(f.name, renameAll, false),
    rust: f.name,
    type: f.type,
    required: !nullable && !hasDefault,
    nullable,
    notes,
    docs: f.docs,
  };
}

export function wireShape(t: RustType): WireShape {
  const args = serdeArgs(t.attrs);
  const notes: string[] = [];
  const renameAll = str(args, "rename_all") ?? /rename_all\s*\(\s*(?:serialize|deserialize)\s*=\s*"([^"]+)"/.exec(args)?.[1] ?? null;
  if (renameAll) notes.push(`字段名按 ${renameAll}`);
  if (has(args, "deny_unknown_fields")) notes.push("拒绝未知字段");
  const tag = str(args, "tag");
  const content = str(args, "content");
  if (has(args, "untagged")) notes.push("无标签（按内容匹配）");
  else if (tag && content) notes.push(`相邻标签：\`${tag}\` 放变体名，\`${content}\` 放内容`);
  else if (tag) notes.push(`内部标签：\`${tag}\` 字段放变体名`);
  if (has(args, "transparent")) notes.push("透明包装：按内部值序列化");
  const typeDefault = has(args, "default");
  if (typeDefault) notes.push("所有字段缺省时用默认值");
  const fields = t.fields.map((f) => wireField(f, renameAll, typeDefault)).filter((f): f is WireField => f !== null);
  if (t.tuple.length === 1) notes.push(`按内部值序列化为 \`${t.tuple[0]}\``);
  else if (t.tuple.length > 1) notes.push(`序列化为数组 \`[${t.tuple.join(", ")}]\``);
  const variants = t.variants
    .filter((v) => !has(serdeArgs(v.attrs), "skip"))
    .map((v) => {
      const vargs = serdeArgs(v.attrs);
      const payload = v.tuple.length ? v.tuple.join(", ") : v.fields.length ? `{ ${v.fields.map((f) => `${renameCase(f.name, str(vargs, "rename_all"), false)}: ${f.type}`).join(", ")} }` : "";
      return { json: str(vargs, "rename") ?? renameCase(v.name, renameAll, true), rust: v.name, docs: v.docs, payload };
    });
  return { fields, variants, notes };
}
