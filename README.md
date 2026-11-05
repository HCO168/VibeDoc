# VibeDoc

给「和 AI 一起写代码」的项目用的一整套项目管理系统：一份统一的 **AI 协作规则**、一套**文档目录约定**、给 AI 用的**命令**，和一个同时管理多个项目的本地**看板**。你用自然语言写规则、功能文档、需求、表变更和对问题的答复；AI 按约定的流程读取、出计划、实现、记录变更并标注状态。Rust + SQL + React/TypeScript 项目还能画出**代码地图**和**关系图**。

- 一个仓库一份配置（`vibedoc.config.json`），所有文档都是仓库里的 Markdown 文件，随代码一起提交。
- 一个看板服务管理本机所有登记过的项目，页面顶部切换。
- 纯本地：只监听 `127.0.0.1`，写操作需要每次启动生成的令牌。
- 要求 Node.js 23.6 或更高版本（原生运行 TypeScript），无第三方依赖。

## 管理系统由什么组成

**1. AI 协作规则**：`vibedoc init`／`vibedoc agents sync` 在仓库的 `AGENTS.md` 和 `doc/AGENTS.md` 里写入一段带标记的规则区块（模板在 [`templates/agents/`](templates/agents/)），内容包括：回复与文档语言、规则冲突时的权威顺序、工作区安全与方案评估、Git 分支与发布链、规则／功能文档／表变更的处理流程、变更日志与待决问题、安全底线、完成前的检查。区块按你的配置（语言、路径、发布链）渲染；本项目特有的规则写在区块外，同步时不会被改动。改了配置或升级 VibeDoc 后运行 `vibedoc agents sync`，所有项目的通用规则保持一致。

**2. 文档目录**（默认放在 `doc/`，路径都可配置）：

| 区域 | 默认位置 | 谁写 |
| --- | --- | --- |
| 需求原话、UI 草图 | `doc/human/requests/`、`doc/human/ui-sketch/` | 你；AI 只读 |
| 逻辑规则 | `doc/human/rules/<模块>.md` | 你；AI 只改状态行 |
| 待决问题 | `doc/human/open_questions.md` | AI 提问，你回答 |
| 交付说明 | `doc/human/deliverable/` | AI，按你的要求 |
| 功能与架构文档 | `doc/features/<模块>.md` | AI 撰写，你可直接改 |
| 表变更 | `doc/table-changes/<schema>.md` | 你提出，AI 写迁移 |
| 行为规范、接口与数据契约 | `doc/behavior/`、`doc/backend/`、`doc/tables/` | AI |
| 待办、目标记录、待验收 | `doc/todo.md`、`doc/goal_logs.md`、`doc/totest/` | AI |
| 变更日志、失效文档 | `doc/change_logs/<日期>/`、`doc/expired/` | AI |

**3. 命令**：AI 通过 `vibedoc` 命令改状态、写日志、提问，格式统一（见下文）。

**项目插件**：只适合某个项目的功能（例如它自己的翻译表、部署流程）用插件接入，不改 VibeDoc 本身。插件可以加命令、看板标签页、接口和 AI 规则，写法见下文「插件」。

**4. 看板**：

- **规则看板**：规则按 新提出、待你确认、进行中、已修改、已实现 分列，另有搁置区；卡片可编辑，待你确认的可「确认计划，开始做」或「退回」。
- **功能文档**：整篇渲染阅读，每条功能旁显示状态（新提出、待你确认、开发中、已持久化、已上线、已修改、搁置）；「编辑文档」或双击正文整篇编辑，⌘／Ctrl+S 保存，按标题保留每条功能的编号与状态。「提新功能」快速提一条。
- **项目管理**：待决问题（直接在页面上作答）、待办（可添加）、待验收、目标记录、变更日志（按日期、可搜索、点开看全文）、需求原话（新建与编辑）、UI 草图（上传图片或 PDF、缩略图浏览）、交付说明、文档入口；AI 规则区块过期时顶部提醒。
- **代码地图**（需配置 `codemap`）：前端、API、后端、数据库、结构体五个标签，各按自己的方式分组；接口直接显示请求与响应字段；每行可「提要求」写规则，或在关系图中查看。「数据库」标签里可以「新建表」「改表」，表单旁实时显示 SQL 草稿。
- **关系图**（需配置 `codemap`）：页面 → 接口（递归展开数据体）→ 处理函数调用链 → 读写的表；也可从任一接口、函数、结构体或表出发。

文件或代码变化时页面实时刷新。

## 安装

```bash
git clone https://github.com/HCO168/VibeDoc.git ~/Documents/GitHub/VibeDoc
ln -s ~/Documents/GitHub/VibeDoc/bin/vibedoc ~/.local/bin/vibedoc   # 任意在 PATH 中的目录
```

## 在一个仓库里使用

```bash
cd 你的仓库
vibedoc init --name 我的项目     # 配置、整套文档目录、CLAUDE.md、AGENTS.md 规则区块，并登记到项目列表
vibedoc serve                   # 打开 http://127.0.0.1:4870，显示所有登记过的项目
```

已有文档的仓库：`init` 只补缺失的文件，不覆盖已有内容；已有的 `AGENTS.md` 会在第一个标题后插入规则区块，请删掉区块外与之重复的通用规则，只留本项目特有的部分。

管理项目列表：`vibedoc add [路径]`、`vibedoc remove <路径或编号>`、`vibedoc projects`。列表存在 `~/.config/vibedoc/projects.json`，看板会自动跟着变化。`vibedoc serve --only` 只服务当前仓库（例如在 worktree 里临时预览）。

### 像 App 一样启动（macOS）

```bash
~/Documents/GitHub/VibeDoc/mac/install.sh [某个仓库] --name "VibeDoc"
```

生成 `~/Applications/<名称>.app`（给了仓库就顺便登记它），之后用 Spotlight、Raycast 或 Alfred 搜名称打开：服务没运行就在后台启动，已运行就直接打开；装了 Chrome 时用独立窗口打开，已有看板窗口则切到前台（服务是这次新启动的就顺带刷新）。一个 App 管理所有项目。

App 是 `osacompile` 生成的 AppleScript 小程序（ad-hoc 签名）。首次打开 macOS 会询问是否允许它访问项目所在文件夹（如「文稿」）以及控制 Google Chrome，点「允许」即可；重装后会再问一次。后台服务继承 App 的权限，所以小程序在服务运行期间常驻（无 Dock 图标），服务停止后自动退出。App 只记录 VibeDoc 目录和 node 路径，更新 VibeDoc 后无需重装：在页面点「停止服务」再从 App 打开即可。日志在 `~/Library/Logs/vibedoc.log`。

## 配置 `vibedoc.config.json`

```json
{
  "name": "我的项目",
  "port": 4870,
  "language": "简体中文",
  "git": { "promotion": ["dev", "beta", "main"], "branchPrefix": "codex/" },
  "docs": { "root": "doc" },
  "modules": { "app": "应用", "billing": "计费" },
  "modulesFile": "doc/modules/modules.yaml",
  "codemap": {
    "outDir": "doc/modules",
    "crates": [{ "dir": "backend/api", "lib": "api", "mainName": "crate" }],
    "migrationsDir": "backend/migrations",
    "publicMigrationDirs": ["legacy-public"],
    "frontendRoots": ["frontend/src"]
  },
  "watch": [],
  "plugins": ["tools/vibedoc-plugins/translations/plugin.ts"]
}
```

| 字段 | 说明 |
| --- | --- |
| `name` | 项目名，显示在看板的项目切换和标题上 |
| `port` | `vibedoc serve --only` 时的端口，默认 4870；`PORT` 环境变量优先 |
| `language` | AI 回复与写文档用的语言，写进规则区块 |
| `git.promotion` | 发布链：第一个是集成分支，最后一个是发布分支，默认 `["dev", "main"]` |
| `git.branchPrefix` | AI 任务分支前缀，默认 `codex/` |
| `docs.root` | AI 维护区根目录，默认 `doc`；其余位置默认在它下面，也可单独指定：`human`、`requests`、`sketches`、`questions`、`deliverables`、`behavior`、`contracts`（数组）、`todo`、`goals`、`totest`、`changelogs`、`expired` |
| `rulesDir`、`featuresDir`、`tablesDir` | 规则、功能文档、表变更目录，默认 `doc/human/rules`、`doc/features`、`doc/table-changes` |
| `modules` | 模块 `id → 标题`；只用文档功能时这样列出即可 |
| `modulesFile` | 可选，`modules.yaml`：除标题外还声明每个模块拥有哪些代码文件（代码地图用来归属文件，格式见下） |
| `codemap` | 可选，启用代码地图与关系图 |
| `codemap.crates` | Rust crate 目录与库名；`mainName: "build-app"` 时 `src/main.rs` 以它调用的 `build_<x>_app` 命名为 `<x>_backend` 服务，否则以目录名命名 |
| `codemap.migrationsDir` | SQL 迁移目录：子目录名即该目录下文件的默认 schema；直接放在目录里或位于 `publicMigrationDirs` 的文件使用 `public` 并最先重放 |
| `codemap.frontendRoots` | 前端 TypeScript／React 源码目录 |
| `watch` | 额外需要触发代码地图刷新的目录 |
| `plugins` | 项目插件的模块路径（相对仓库根目录），见「插件」 |

代码地图目前识别：Rust（axum 路由、serde 结构体、SQL 字面量）、按目录分 schema 的 PostgreSQL 迁移、TypeScript／React 前端（`<Route>` 页面与 `fetch` 封装）。其他技术栈照样可以用除代码地图外的全部功能。

### `modules.yaml`

```yaml
# 一个文件按清单顺序归入第一个匹配的模块；`*` 匹配单段，`**` 匹配任意层目录。
shared_files:                 # 不整体归属某模块的共享文件：函数按调用方推断，推断不出时回落到这里
  backend/api/src/lib.rs: platform
modules:
  billing:
    title: 计费
    backend: [backend/api/src/billing*]
    frontend: [frontend/src/pages/billing/**]
    schemas: [billing]        # 表与 SQL 函数按 schema 归属
    functions: []             # 把共享文件中的个别函数指定给本模块：`文件名::函数名`
    docs: []                  # 叙述性文档，生成的代码地图会链接过去
```

`examples/` 里有一份真实项目的配置可参考。

## 插件

插件是仓库里的一个 ES 模块（TypeScript 可直接写），默认导出一个对象，所有字段都可选（`name` 除外）：

| 字段 | 作用 |
| --- | --- |
| `name` | 插件名，小写字母、数字、连字符 |
| `title`、`client` | 看板标签页的名称和浏览器脚本（相对插件文件）；脚本里调用 `VibeDoc.registerView(name, render)` |
| `commands` | `{ 命令: { describe, run(args, ctx) } }`，用 `vibedoc <命令>` 运行，`vibedoc plugins` 列出 |
| `get`、`post` | `{ 路由: (query 或 data, ctx) => 数据 }`，对应 `/api/p/<项目>/plugins/<name>/<路由>`；POST 需要看板令牌 |
| `watch` | 这些路径变化时通知打开的看板刷新插件页 |
| `rules` | 一段 Markdown 规则，`vibedoc agents sync` 把它写进 `AGENTS.md` 规则区块的「Project Plugins」 |

`ctx` 提供 `root`（仓库路径）、`cfg`（配置）、`docs`（文档系统：问题、待办、变更日志等）和 `notify()`（通知看板刷新）。浏览器脚本的 `render(vd)` 返回页面节点，`vd` 提供 `h`（建元素）、`mdBlocks`、`data(路由)`（读取一次并在到达后重绘、插件数据变化时自动刷新）、`post(路由, 数据)`、`toast`、`state`（跨重绘保留的状态）。完整例子见 [`examples/plugins/hello/`](examples/plugins/hello/)。插件是项目自己的代码，和项目里的其他脚本一样按完全信任运行。

## 测试

```bash
node --test test/vibedoc.test.ts
```

在临时目录里建两个项目（一个带代码地图和插件），跑遍所有命令和看板接口：初始化与规则区块同步、规则／功能文档／表变更、变更日志／待决问题／待办／待验收、代码地图、插件、多项目服务和越权访问拦截。

## 命令（AI 使用）

```bash
vibedoc rules list [--all] | show <id> | confirm <id> | start <id> | mark <id> [--impl a,b] | refresh
vibedoc features list [--all] [模块] | show <id> | set <状态> <id...> | summary [模块] | refresh
vibedoc tables list [--all] [schema] | show <id> | sql <id> | set <状态> <id...> | refresh
vibedoc changelog new --role <角色> --slug <英文短名> | list [N]
vibedoc question list | add "<问题>" [--body "<说明>"] | resolve <编号>
vibedoc todo list | add <backlog|doing|testing> "<内容>"
vibedoc totest list
vibedoc agents sync | check
vibedoc plugins                      # 本项目插件及其命令
vibedoc codemap generate | fn <名称> | route <路径片段>
```

- 规则：AI 只能改状态行，工具会拒绝任何改动用户原文的写入。`show` 对「已修改」的规则会从 Git 历史找出 AI 上次处理时的原文。
- 功能文档：状态 `new` `confirm` `doing` `done`（已持久化）`released`（已上线）`parked`；`set` 同时记录当前内容为已处理，所以只有用户的修改会显示为「已修改」。
- 表变更：状态 `new` `confirm` `doing` `done`（迁移已合入）`parked`；`show` 输出条目、SQL 草稿和迁移目录，`sql` 只输出草稿。
- 变更日志：`new` 生成当天目录下带时间、角色和短名的文件骨架（变更内容、影响范围、验证），打印路径供 AI 填写。
- 待决问题：`add` 追加编号问题；用户在看板或文件里作答后，`list` 显示答复；AI 把结论写进行为文档后 `resolve` 删除该条。
- `agents check` 在规则区块缺失或过期时以非零状态退出，可放进检查脚本。
- 代码地图：`generate` 把每个模块 × 前端／API／后端／数据库／结构体写成 Markdown，并输出 `codemap.json`；`fn`、`route` 查询调用方、路由和表。

## 文件

| 文件 | 作用 |
| --- | --- |
| `vibedoc.ts`、`bin/vibedoc` | 命令入口 |
| `config.ts` | 查找仓库根目录、读取 `vibedoc.config.json`（含文档布局、发布链、语言） |
| `registry.ts` | 本机项目列表 `~/.config/vibedoc/projects.json` |
| `agents.ts` | 渲染规则模板，写入或检查 `AGENTS.md` 中的规则区块 |
| `server.ts`、`project.ts` | 本地 HTTP 服务：页面、`/api/projects`、`/api/health`、`/api/shutdown`，以及每个项目在 `/api/p/<编号>/` 下的数据、文档与实时事件 |
| `web/index.html` | 全部页面 |
| `rules/store.ts` | 规则、功能文档与表变更的解析、编号、状态行与哈希、整篇保存、原文不变性校验 |
| `rules/cli.ts`、`features/cli.ts`、`tables/cli.ts` | 状态命令 |
| `tables/spec.ts` | 表变更条目的格式：字段表与约束的解析和写回、SQL 草稿、是否已在迁移中 |
| `docs/store.ts`、`docs/cli.ts` | 变更日志、待决问题、待办、待验收、需求与草图的读写和命令 |
| `plugins.ts` | 加载项目插件、插件规则 |
| `test/vibedoc.test.ts` | 端到端测试 |
| `codemap/` | 代码地图：Rust 词法扫描、迁移重放与 SQL 引用、前端 API 调用识别、serde 字段换算、YAML 子集解析、Markdown／JSON 输出 |
| `mac/install.sh`、`mac/launch.sh`、`mac/icon.svg` | macOS 启动器 |
| `templates/agents/` | AGENTS.md 规则区块模板（根目录规则、文档区规则） |
| `templates/scaffold/` | `init` 生成的文档目录说明、待办、待决问题、CLAUDE.md 等 |
