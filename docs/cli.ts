// Document system commands for AI agents (run inside the repository):
//   vibedoc changelog new --role <角色> --slug <短名>   create today's change log file and print its path
//   vibedoc changelog list [N]                          the latest N change logs (default 20)
//   vibedoc question list                               open questions, with the user's answers
//   vibedoc question add "<问题>" [--body "<说明>"]      add an open question for the user
//   vibedoc question resolve <编号>                      remove a question once its conclusion is in the behavior docs
//   vibedoc todo list [--numbered] | add <backlog|doing|testing> "<内容>" | move <来源> <编号> <目标> [--evidence "<证据>"]
//   vibedoc totest list                                 outstanding QA handoff files
//   vibedoc agents sync | check                         write or check the shared rule blocks in AGENTS.md
import { Roadmap, MILESTONE_STATUS } from "./roadmap.ts";
import { DocSystem } from "./store.ts";
import { syncAgents } from "../agents.ts";
import { loadPlugins, pluginRules } from "../plugins.ts";
import { findRoot, loadConfig } from "../config.ts";

const [group, command, ...args] = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));

try {
  const root = findRoot();
  const cfg = loadConfig(root);
  const docs = new DocSystem(root, cfg);
  if (group === "changelog" && command === "new") {
    const role = flag("--role"), slug = flag("--slug");
    if (!role || !slug) throw new Error("用法：vibedoc changelog new --role <角色> --slug <英文短名>");
    console.log(docs.newChangelog(role, slug));
  } else if (group === "changelog" && command === "list") {
    for (const c of docs.changelogs(Number(positional[0] ?? 20))) console.log(`${c.date} ${c.time.replace(/(\d\d)(\d\d)(\d\d)/, "$1:$2")}  ${c.role.padEnd(28)} ${c.slug}`);
  } else if (group === "question" && command === "list") {
    const qs = docs.questions();
    if (!qs.length) console.log("没有待决问题");
    for (const q of qs) {
      console.log(`${q.n}. ${q.title}${q.answers.length ? "  【用户已答复】" : ""}`);
      if (q.body) console.log(q.body.replace(/^/gm, "   "));
      for (const a of q.answers) console.log(`   答复：${a}`);
    }
  } else if (group === "question" && command === "add") {
    if (!positional[0]) throw new Error('用法：vibedoc question add "<问题>" [--body "<说明>"]');
    console.log(`已添加第 ${docs.addQuestion(positional[0], flag("--body") ?? "")} 个问题：${cfg.docs.questions}`);
  } else if (group === "question" && command === "resolve") {
    docs.resolveQuestion(Number(positional[0]));
    console.log(`已删除第 ${positional[0]} 个问题`);
  } else if (group === "todo" && command === "list") {
    const numbered = args.includes("--numbered");
    for (const s of docs.todo()) {
      console.log(`## ${s.name}（${s.items.length}）${numbered && s.key ? ` [${s.key}]` : ""}`);
      s.items.forEach((item, i) => console.log(numbered ? `  ${i + 1}. ${item}` : `- ${item}`));
    }
  } else if (group === "todo" && command === "add") {
    docs.addTodo(positional[0], positional.slice(1).join(" "));
    console.log(`已加入 ${cfg.docs.todo}`);
  } else if (group === "todo" && command === "move") {
    const [from, n, to] = positional;
    docs.moveTodo(from, Number(n), to, flag("--evidence") ?? "");
    console.log(`已移动 ${cfg.docs.todo} 中的待办`);
  } else if (group === "roadmap") {
    const roadmap = new Roadmap(root, cfg.docs.roadmap);
    const { items, errors } = roadmap.overview();
    const item = items.find((m) => m.id === positional[0]);
    if (command === "list") {
      for (const m of items) console.log(`${m.id}　[${m.status}] ${m.title}${m.due ? ` · ${m.due}` : ""}${m.owner ? ` · ${m.owner}` : ""}${m.blockedBy.length ? ` · 等待 ${m.blockedBy.join("、")}` : ""}`);
      for (const e of errors) console.error(`${e.name}：${e.message}`);
      if (!items.length && !errors.length) console.log("还没有里程碑");
      if (errors.length) process.exitCode = 1;
    } else if (command === "show" && item) {
      console.log(`# ${item.title}（${item.id}）\n状态：${item.status} · 负责人：${item.owner || "未分配"} · 目标日期：${item.due || "未设置"}`);
      if (item.dependsOn.length) console.log(`依赖：${item.dependsOn.join("、")}`);
      if (item.blockedBy.length) console.log(`等待：${item.blockedBy.join("、")}`);
      if (item.goal) console.log(item.goal);
      for (const c of item.checks) console.log(`- [${c.checked ? "x" : " "}] ${c.text}`);
    } else if (command === "set" && item && MILESTONE_STATUS.includes(positional[1] as typeof MILESTONE_STATUS[number])) {
      roadmap.save(item.id, { ...item, status: positional[1] as typeof MILESTONE_STATUS[number] }, item.version);
      console.log(`已更新里程碑 ${item.id}：${positional[1]}`);
    } else {
      throw new Error("用法：vibedoc roadmap list | show <已有编号> | set <已有编号> <planned|doing|done>");
    }
  } else if (group === "totest" && command === "list") {
    for (const f of docs.listFiles(cfg.docs.totest)) if (!/(README|AGENTS)\.md$/.test(f.name)) console.log(f.path);
  } else if (group === "agents" && (command === "sync" || command === "check")) {
    const { plugins, errors } = await loadPlugins(root, cfg);
    for (const e of errors) console.error(`插件加载失败：${e}`);
    const results = syncAgents(root, cfg, command === "sync", pluginRules(plugins));
    const names: Record<string, string> = { created: "已创建", updated: "已更新", inserted: "已插入区块", unchanged: "已是最新", stale: "需要同步", missing: "缺少区块" };
    for (const r of results) console.log(`${r.file}: ${names[r.state]}`);
    if (command === "check" && results.some((r) => r.state === "stale" || r.state === "missing")) process.exitCode = 1;
    if (results.some((r) => r.state === "inserted")) console.log("提示：区块插在已有文件里，请删除区块外与之重复的通用规则，只留本项目专属规则。");
  } else {
    console.log("用法：vibedoc changelog new|list · question list|add|resolve · todo list|add|move · roadmap list|show|set · totest list · agents sync|check");
    process.exitCode = group ? 1 : 0;
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
