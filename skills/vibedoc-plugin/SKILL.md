---
name: vibedoc-plugin
description: Build a VibeDoc plugin (also called a mod / 插件) for a repository managed by VibeDoc — a project-specific command, board tab, data route or AI rule that VibeDoc itself does not offer. Use when the user asks to add, change or debug a VibeDoc plugin or mod, or to show some project file or workflow in the VibeDoc board.
---

# 创建 VibeDoc 插件

VibeDoc 是本地的项目管理看板（规则、功能文档、表变更、项目管理、代码地图）。只适合某个项目的功能——它自己的数据文件、发布流程、检查脚本——不改 VibeDoc，而是写成**插件**：仓库里的一个 ES 模块（可直接写 TypeScript，Node 23.6+ 原生运行），在 `vibedoc.config.json` 的 `plugins` 里登记。插件可以提供：

- **命令**：`vibedoc <命令>`，给人和 AI 在终端里用；
- **看板标签页**：一个浏览器脚本画的页面；
- **接口**：标签页（或其他程序）读写数据用的 GET／POST 路由；
- **监听**：这些文件变化时，打开的标签页自动刷新；
- **AI 规则**：一段 Markdown，`vibedoc agents sync` 把它写进仓库 `AGENTS.md` 的规则区块，所有 AI 都会读到。

插件是项目自己的代码，按完全信任运行（和项目里的其他脚本一样）。

## 步骤

1. **问清楚要什么**：数据从哪里来（哪个文件、什么格式）、谁用（人在看板上看／点，还是 AI 在终端里调）、要不要改文件、AI 需要遵守什么。只读的需求先做只读。
2. **生成骨架**（在仓库里运行）：
   ```bash
   vibedoc plugins new <名称> --title <标签名> [--view]
   ```
   会创建 `tools/vibedoc-plugins/<名称>/plugin.ts`（加 `--view` 还有 `client.js`）并登记到配置。名称用小写字母、数字、连字符。
3. **实现** `plugin.ts`（字段见下表）；有页面就实现 `client.js`。
4. **检查**：
   - `vibedoc plugins`：列出插件和命令；加载失败会打印原因。
   - 运行自己的命令，确认输出。
   - 看板（VibeDoc App 或 `vibedoc serve` 后打开 http://127.0.0.1:4870）里切到插件的标签页；页面出错会显示在标签页里，浏览器控制台也有。
   - 写了 `rules` 就运行 `vibedoc agents sync`，再用 `vibedoc agents check` 确认是最新。
   - 改文件的操作：确认只改了该改的部分（例如 `git diff`），再还原测试数据。
5. **收尾**：按仓库规则记录（多数 VibeDoc 项目要求 `vibedoc changelog new`），在插件文件开头用注释写清它做什么、读写哪些文件。

## `plugin.ts` 的默认导出

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | 是 | 小写字母、数字、连字符；出现在网址和命令里 |
| `title` | 否 | 看板标签页的名称 |
| `client` | 否 | 浏览器脚本，相对插件文件；有它才有标签页 |
| `commands` | 否 | `{ 命令名: { describe, run(args, ctx) } }`；`vibedoc <命令名> 参数…` 运行，`args` 是命令名后面的参数 |
| `get` | 否 | `{ 路由: (query: URLSearchParams, ctx) => 数据 }`，对应 `GET /api/p/<项目>/plugins/<name>/<路由>` |
| `post` | 否 | `{ 路由: (data, ctx) => 结果 }`，`data` 是请求的 JSON；看板自动带令牌，其他来源会被拒绝 |
| `watch` | 否 | 仓库内的相对路径数组；变化时通知看板刷新这个插件的页面 |
| `rules` | 否 | 给 AI 的规则（Markdown 列表），由 `vibedoc agents sync` 写进 `AGENTS.md` 的「Project Plugins」 |

处理函数可以是异步的。抛出的错误会以 400 返回给页面，`error.message` 就是页面显示的提示；需要别的状态码时给错误对象加 `status`（例如 409）。

**`ctx`**：`root`（仓库根目录绝对路径）、`cfg`（解析后的 `vibedoc.config.json`，例如 `cfg.name`、`cfg.docs.todo`）、`docs`（文档系统：`addQuestion(标题, 说明)`、`addTodo("backlog"|"doing"|"testing", 内容)`、`newChangelog(角色, 短名, 内容)`、`questions()`、`todo()`、`changelogs()`、`listFiles(目录)`）、`notify()`（改了数据后调用，让看板刷新）。

## `client.js`

```js
VibeDoc.registerView("<name>", (vd) => {
  const s = vd.data("summary");            // 读 GET 路由：第一次返回 undefined，到达后自动重绘
  if (!s) return vd.h("div", { class: "empty" }, "加载中…");
  if (s.error) return vd.h("div", { class: "err" }, s.error);
  return [vd.h("h2", {}, "标题"), vd.h("button", { class: "primary small", onclick: () => vd.post("save", { x: 1 }) }, "保存")];
});
```

`vd` 提供：`h(标签, 属性, ...子节点)`（属性里 `class`、`onclick` 等；`checked: null` 表示不勾选）、`mdBlocks(markdown)`、`mdInline(文字)`、`data(路由)`、`post(路由, 数据)`（成功后清缓存并重绘，失败抛错）、`refresh()`、`render()`、`toast(文字)`、`state`（跨重绘保留的对象，放勾选项、筛选词）、`project`（当前项目信息）、`joinNodes(节点数组)`。

可用的现成样式：`chips`／`chip`（标签行）、`md-table`（表格）、`doc`（正文排版）、`empty`（灰色说明）、`err`（错误）、`doc-bar`（按钮行）、按钮 `primary`、`small`。页面放在看板的面板里，宽度自适应。

## 约定

- 只读写仓库内的文件；用 `join(ctx.root, 相对路径)`，不要写死绝对路径。
- 改文件时保持原格式：只改目标行或字段，其余内容逐字节不动；改之前先读最新内容，不要用缓存覆盖别人刚做的修改。
- 不读取或输出密钥、令牌、密码；不往外部服务发数据，除非用户明确要求。
- 命令和接口都应该可以重复执行（幂等）；批量修改给出改了多少条。
- 页面文字跟随项目语言（多数是简体中文）。
- 只给 AI 用的能力做成命令；只给人看的做成标签页；两者都要就共用同一个函数（像骨架里的 `summary`）。

## 例子

`references/examples.md` 有完整例子：只读统计＋批量标记（翻译审核）、只有命令和规则的插件、监听文件的看板页。VibeDoc 仓库的 `examples/plugins/hello/` 是最小可运行示例。
