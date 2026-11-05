// Document system commands for AI agents (run inside the repository):
//   vibedoc changelog new --role <角色> --slug <短名>   create today's change log file and print its path
//   vibedoc changelog list [N]                          the latest N change logs (default 20)
//   vibedoc question list                               open questions, with the user's answers
//   vibedoc question add "<问题>" [--body "<说明>"]      add an open question for the user
//   vibedoc question resolve <编号>                      remove a question once its conclusion is in the behavior docs
//   vibedoc todo list | add <backlog|doing|testing> "<内容>"
//   vibedoc totest list                                 outstanding QA handoff files
//   vibedoc agents sync | check                         write or check the shared rule blocks in AGENTS.md
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
    for (const s of docs.todo()) {
      console.log(`## ${s.name}（${s.items.length}）`);
      for (const i of s.items) console.log(`- ${i}`);
    }
  } else if (group === "todo" && command === "add") {
    docs.addTodo(positional[0], positional.slice(1).join(" "));
    console.log(`已加入 ${cfg.docs.todo}`);
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
    console.log("用法：vibedoc changelog new|list · question list|add|resolve · todo list|add · totest list · agents sync|check");
    process.exitCode = group ? 1 : 0;
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
