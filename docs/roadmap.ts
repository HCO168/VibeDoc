// 里程碑按文件保存，状态和依赖可用 Git 审阅，正文和发布检查也可直接编辑。
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { versionOf } from "../rules/store.ts";

export const MILESTONE_STATUS = ["planned", "doing", "done"] as const;
type MilestoneStatus = (typeof MILESTONE_STATUS)[number];
type Check = { text: string; checked: boolean };
type Milestone = {
  id: string; title: string; status: MilestoneStatus; owner: string; due: string;
  dependsOn: string[]; checks: Check[]; goal: string;
};
const ID = /^[a-z0-9][a-z0-9-]{0,59}$/;
const MARKER = "<!-- vibedoc:milestone -->";
const HEADER = /^# (.+)\n\n<!-- vibedoc:milestone -->\n- 状态：([^\n]*)\n- 负责人：([^\n]*)\n- 目标日期：([^\n]*)\n- 依赖：([^\n]*)\n\n## 检查项\n([\s\S]*?)\n## 目标\n([\s\S]*)$/;
const clean = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();
const fail = (message: string, status = 400) => Object.assign(new Error(message), { status });

function validate(id: string, data: Partial<Milestone>): Milestone {
  if (!ID.test(id)) throw fail("里程碑编号只能包含小写字母、数字和连字符，最多 60 个字符");
  const title = clean(data.title);
  if (!title) throw fail("请填写里程碑名称");
  const status = data.status ?? "planned";
  if (!MILESTONE_STATUS.includes(status)) throw fail("未知的里程碑状态");
  const due = clean(data.due);
  if (due && (!/^\d{4}-\d{2}-\d{2}$/.test(due) || !Number.isFinite(Date.parse(due)) || new Date(due).toISOString().slice(0, 10) !== due)) {
    throw fail("目标日期应为有效的 YYYY-MM-DD 日期");
  }
  const dependsOn = [...new Set((data.dependsOn ?? []).map(clean).filter(Boolean))];
  if (dependsOn.some((id) => !ID.test(id))) throw fail("存在无效的依赖编号");
  if (dependsOn.includes(id)) throw fail("里程碑不能依赖自身");
  const checks = (data.checks ?? []).map((c) => ({ text: clean(c.text), checked: c.checked === true })).filter((c) => c.text);
  return { id, title, status, due, owner: clean(data.owner), dependsOn, checks, goal: String(data.goal ?? "").trim() };
}

function parse(id: string, raw: string) {
  const m = HEADER.exec(raw.replace(/\r\n/g, "\n"));
  if (!m) throw fail("标题、状态或 Markdown 分组格式有误");
  const [, title, status, owner, due, dependencies, checkText, goal] = m;
  const checks = checkText.trim() ? checkText.trim().split("\n").map((line) => {
    const check = /^- \[([ xX])\] (.+)$/.exec(line);
    if (!check) throw fail("检查项每行须为 - [ ] 内容 或 - [x] 内容");
    return { text: check[2], checked: check[1] !== " " };
  }) : [];
  return validate(id, { title, status: status as MilestoneStatus, owner, due, dependsOn: dependencies.split(","), checks, goal });
}

function serialize(m: Milestone) {
  return [
    `# ${m.title}`, "", MARKER, `- 状态：${m.status}`, `- 负责人：${m.owner}`, `- 目标日期：${m.due}`, `- 依赖：${m.dependsOn.join(", ")}`,
    "", "## 检查项", "", ...m.checks.map((c) => `- [${c.checked ? "x" : " "}] ${c.text}`),
    "", "## 目标", "", m.goal, "",
  ].join("\n");
}

export class Roadmap {
  dir: string;
  constructor(root: string, dir: string) {
    this.dir = join(root, dir);
  }
  private list() {
    const items = [];
    const errors: { name: string; message: string }[] = [];
    if (!existsSync(this.dir)) return { items, errors };
    if (!lstatSync(this.dir).isDirectory()) return { items, errors: [{ name: "路线图目录", message: "路线图路径必须是普通目录" }] };
    for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
      const name = entry.name;
      if (!entry.isFile() || name === "README.md" || !name.endsWith(".md")) continue;
      try {
        const raw = readFileSync(join(this.dir, name), "utf8");
        items.push({ ...parse(name.slice(0, -3), raw), version: versionOf(raw) });
      }
      catch (e) { errors.push({ name, message: (e as Error).message }); }
    }
    return { items, errors };
  }
  overview() {
    const { items, errors } = this.list();
    const byId = new Map(items.map((item) => [item.id, item]));
    return {
      errors,
      items: items.sort((a, b) => (a.due || "~").localeCompare(b.due || "~") || a.id.localeCompare(b.id)).map((item) => ({
        ...item,
        blockedBy: item.dependsOn.filter((id) => byId.get(id)?.status !== "done"),
      })),
    };
  }
  save(id: string, data: Partial<Milestone>, version?: string) {
    const m = validate(id, data);
    if (existsSync(this.dir) && !lstatSync(this.dir).isDirectory()) throw fail("路线图路径必须是普通目录");
    const { items } = this.list();
    const byId = new Map(items.map((item) => [item.id, item]));
    const current = byId.get(id);
    const path = join(this.dir, `${id}.md`);
    if (version === undefined && existsSync(path)) throw fail("该里程碑编号已存在", 409);
    if (version !== undefined && version !== current?.version) throw fail("里程碑已在别处修改，请复制你的改动后关闭面板并重新打开", 409);
    const seen = new Set<string>();
    const stack = [...m.dependsOn];
    while (stack.length) {
      const dep = stack.pop()!;
      if (dep === id) throw fail("依赖形成循环，请调整后重试");
      if (seen.has(dep)) continue;
      seen.add(dep);
      const found = byId.get(dep);
      if (!found) throw fail(`找不到依赖的里程碑 ${dep}`);
      stack.push(...found.dependsOn);
    }
    if (m.status === "done") {
      const pending = m.dependsOn.filter((dep) => byId.get(dep)?.status !== "done");
      if (pending.length) throw fail(`请先完成依赖：${pending.join("、")}`);
      if (m.checks.some((c) => !c.checked)) throw fail("请先完成所有检查项");
    }
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(path, serialize(m), { flag: version === undefined ? "wx" : "w" });
    return m;
  }
}
