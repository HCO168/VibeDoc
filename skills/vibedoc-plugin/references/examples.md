# VibeDoc 插件例子

## 1. 只读统计＋批量标记：翻译审核

读一个 CSV，按状态统计，列出待审的行，页面上勾选后改状态列；其余行逐字节不动。

```ts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CSV = "src/locales/translations.csv"; // key,en,zh,...,status，每行一条、所有字段带引号
type Ctx = { root: string; notify: () => void };

function parseLine(line: string): string[] {
  const out: string[] = [];
  let cur = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
const esc = (v: string) => `"${v.replaceAll('"', '""')}"`;

function rows(root: string) {
  const lines = readFileSync(join(root, CSV), "utf8").split("\n");
  return { lines, rows: lines.slice(1).map((l, i) => ({ line: i + 1, cells: parseLine(l) })).filter((r) => r.cells[0]) };
}

export default {
  name: "translations",
  title: "翻译",
  client: "client.js",
  watch: [CSV],
  rules: "- `vibedoc translations` lists keys waiting for review; the user marks them on the 翻译 tab.",
  commands: {
    translations: {
      describe: "按状态统计并列出待审的键",
      run(_args: string[], ctx: Ctx) {
        const { rows: all } = rows(ctx.root);
        for (const r of all.filter((r) => r.cells.at(-1) === "machine-translated")) console.log(r.cells[0]);
      },
    },
  },
  get: {
    summary: (_q: URLSearchParams, ctx: Ctx) => {
      const { rows: all } = rows(ctx.root);
      const statuses: Record<string, number> = {};
      for (const r of all) statuses[r.cells.at(-1)!] = (statuses[r.cells.at(-1)!] ?? 0) + 1;
      return { statuses, pending: all.filter((r) => r.cells.at(-1) === "machine-translated").map((r) => r.cells[0]) };
    },
  },
  post: {
    // { keys: [...] } → 只改这些行的最后一列
    review: (data: { keys?: string[] }, ctx: Ctx) => {
      const wanted = new Set(data.keys ?? []);
      const { lines, rows: all } = rows(ctx.root);
      let changed = 0;
      for (const r of all) {
        if (!wanted.has(r.cells[0]) || r.cells.at(-1) === "human-reviewed") continue;
        lines[r.line] = [...r.cells.slice(0, -1), "human-reviewed"].map(esc).join(",");
        changed++;
      }
      if (changed) writeFileSync(join(ctx.root, CSV), lines.join("\n"));
      ctx.notify();
      return { changed };
    },
  },
};
```

```js
// client.js
VibeDoc.registerView("translations", (vd) => {
  const s = vd.data("summary");
  if (!s) return vd.h("div", { class: "empty" }, "加载中…");
  const picked = (vd.state.picked ??= new Set());
  return [
    vd.h("div", { class: "chips" }, Object.entries(s.statuses).map(([k, n]) => vd.h("span", { class: "chip" }, `${k} ${n}`))),
    vd.h("button", { class: "primary small", onclick: async () => { const r = await vd.post("review", { keys: [...picked] }); picked.clear(); vd.toast(`已标记 ${r.changed} 个`); } }, "标为已审核"),
    vd.h("table", { class: "md-table" }, s.pending.map((key) => {
      const box = vd.h("input", { type: "checkbox", checked: picked.has(key) || null });
      box.addEventListener("change", () => (box.checked ? picked.add(key) : picked.delete(key)));
      return vd.h("tr", {}, vd.h("td", {}, box), vd.h("td", { class: "mono" }, key));
    })),
  ];
});
```

## 2. 只有命令和规则：发布前检查

不需要页面。AI 按规则在发布前运行它，并把发现的问题记成待办。

```ts
import { execFileSync } from "node:child_process";

export default {
  name: "release-check",
  rules: "- Before any release, run `vibedoc release-check`; fix every item it prints or record it with `vibedoc todo add backlog`.",
  commands: {
    "release-check": {
      describe: "发布前检查：未提交的改动与待验收项",
      run(_args: string[], ctx: { root: string; cfg: any; docs: any }) {
        const dirty = execFileSync("git", ["status", "--short"], { cwd: ctx.root, encoding: "utf8" }).trim();
        if (dirty) console.log(`有未提交的改动：\n${dirty}`);
        const open = ctx.docs.listFiles(ctx.cfg.docs.totest).filter((f: any) => !/README|AGENTS/.test(f.name));
        if (open.length) console.log(`还有 ${open.length} 份待验收：${open.map((f: any) => f.name).join("、")}`);
        if (!dirty && !open.length) console.log("可以发布");
      },
    },
  },
};
```

## 3. 监听文件的看板页：路线图

把仓库里的 `ROADMAP.md` 显示成标签页，文件一改页面就刷新。

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export default {
  name: "roadmap",
  title: "路线图",
  client: "client.js",
  watch: ["ROADMAP.md"],
  get: {
    text: (_q: URLSearchParams, ctx: { root: string }) => {
      const file = join(ctx.root, "ROADMAP.md");
      return { text: existsSync(file) ? readFileSync(file, "utf8") : "" };
    },
  },
};
```

```js
VibeDoc.registerView("roadmap", (vd) => {
  const r = vd.data("text");
  if (!r) return vd.h("div", { class: "empty" }, "加载中…");
  return r.text ? vd.h("div", { class: "doc" }, vd.mdBlocks(r.text)) : vd.h("div", { class: "empty" }, "还没有 ROADMAP.md");
});
```
