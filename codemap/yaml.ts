// Minimal YAML subset reader for doc/modules/modules.yaml: nested maps, `- item` lists,
// inline `[a, b]` lists, quoted or plain scalars, and `#` comments. No anchors or multi-line scalars.

type Line = { indent: number; text: string; no: number };

function stripComment(raw: string): string {
  let quote = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "#" && (i === 0 || /\s/.test(raw[i - 1]))) {
      return raw.slice(0, i);
    }
  }
  return raw;
}

function scalar(text: string): unknown {
  const t = text.trim();
  if (t === "") return null;
  if (t.startsWith("[") && t.endsWith("]")) {
    const inner = t.slice(1, -1).trim();
    return inner === "" ? [] : inner.split(",").map((part) => scalar(part));
  }
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return t;
}

function splitKey(text: string, no: number): [string, string] {
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ":" && (i + 1 === text.length || text[i + 1] === " ")) {
      return [String(scalar(text.slice(0, i))), text.slice(i + 1)];
    }
  }
  throw new Error(`modules.yaml line ${no}: expected "key: value"`);
}

function parseBlock(lines: Line[], start: number, indent: number): [unknown, number] {
  if (start >= lines.length || lines[start].indent < indent) return [null, start];
  const isList = lines[start].text.startsWith("- ") || lines[start].text === "-";
  if (isList) {
    const items: unknown[] = [];
    let i = start;
    while (i < lines.length && lines[i].indent === indent && (lines[i].text.startsWith("- ") || lines[i].text === "-")) {
      const rest = lines[i].text.slice(1).trim();
      if (rest === "") {
        const [value, next] = parseBlock(lines, i + 1, lines[i + 1]?.indent ?? indent + 1);
        items.push(value);
        i = next;
      } else {
        items.push(scalar(rest));
        i++;
      }
    }
    return [items, i];
  }
  const map: Record<string, unknown> = {};
  let i = start;
  while (i < lines.length && lines[i].indent === indent) {
    const [key, rest] = splitKey(lines[i].text, lines[i].no);
    if (rest.trim() === "") {
      const child = lines[i + 1];
      if (child && child.indent > indent) {
        const [value, next] = parseBlock(lines, i + 1, child.indent);
        map[key] = value;
        i = next;
      } else if (child && child.indent === indent && child.text.startsWith("- ")) {
        const [value, next] = parseBlock(lines, i + 1, indent);
        map[key] = value;
        i = next;
      } else {
        map[key] = null;
        i++;
      }
    } else {
      map[key] = scalar(rest);
      i++;
    }
  }
  if (i < lines.length && lines[i].indent > indent) {
    throw new Error(`modules.yaml line ${lines[i].no}: unexpected indentation`);
  }
  return [map, i];
}

export function parseYaml(source: string): unknown {
  const lines: Line[] = [];
  source.split(/\r?\n/).forEach((raw, index) => {
    const text = stripComment(raw).replace(/\s+$/, "");
    if (text.trim() === "") return;
    lines.push({ indent: text.length - text.trimStart().length, text: text.trim(), no: index + 1 });
  });
  if (lines.length === 0) return {};
  const [value] = parseBlock(lines, 0, lines[0].indent);
  return value;
}
