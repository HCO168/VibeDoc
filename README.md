# VibeDoc

给「和 AI 一起写代码」的项目用的本地文档看板：你用自然语言写**规则**和**功能文档**，AI 按约定的流程读取、出计划、实现并标注状态；还可以把 Rust + SQL + React/TypeScript 项目的代码画成**代码地图**和**关系图**。

- 一个仓库一份配置（`vibedoc.config.json`），文档就是仓库里的 Markdown 文件，随代码一起提交。
- 纯本地：只监听 `127.0.0.1`，写操作需要每次启动生成的令牌。
- 要求 Node.js 23.6 或更高版本（原生运行 TypeScript），无第三方依赖。

## 四个视图

- **规则看板**：你写的逻辑规则（模块 × 前端／API／后端／数据库四层），按 新提出、待你确认、进行中、已修改、已实现 分列，另有搁置区。卡片可编辑；新提出与搁置之间可拖动；待你确认的卡片可「确认计划，开始做」或「退回」。你改过原文的规则自动变成「已修改」。
- **功能文档**：按模块的功能与架构说明，不写代码细节。整篇渲染阅读，每条功能（`###`）旁显示状态：新提出、待你确认、开发中、已持久化（合入开发主分支）、已上线（正式发布）、已修改、搁置。「编辑文档」或双击正文切换为整篇 Markdown 编辑，⌘／Ctrl+S 保存；保存时按标题保留每条功能的编号与状态，文件在你编辑期间被改过（例如 AI）则拒绝覆盖。「提新功能」快速提一条新需求。
- **代码地图**（需配置 `codemap`）：前端、API、后端、数据库、结构体五个标签，各按自己的方式分组（前端按应用／页面目录，API 按路径首段，后端按服务二进制，结构体按声明文件，数据库按 schema）。接口直接显示请求与响应字段，可切换 TS 写法；每行可「提要求」写规则，或点小图标在关系图中查看。
- **关系图**（需配置 `codemap`）：页面 → 接口（递归展开请求与响应数据体，或点击弹出）→ 处理函数调用链 → 读写的表的思维导图；也可以从任一接口、函数、结构体或表出发，表则反向展开到使用它的接口与前端文件。

文件或代码变化时页面实时刷新。

## 安装

```bash
git clone https://github.com/HCO168/VibeDoc.git ~/Documents/GitHub/VibeDoc
ln -s ~/Documents/GitHub/VibeDoc/bin/vibedoc ~/.local/bin/vibedoc   # 任意在 PATH 中的目录
```

## 在一个仓库里使用

```bash
cd 你的仓库
vibedoc init --name 我的项目     # 生成 vibedoc.config.json、doc/rules/README.md、doc/features/README.md
vibedoc serve                   # 打开 http://127.0.0.1:4870
```

然后把 [`templates/AGENTS-snippet.md`](templates/AGENTS-snippet.md) 的内容加进仓库的 `AGENTS.md` 或 `CLAUDE.md`，AI 就知道如何读写规则与功能文档。

### 像 App 一样启动（macOS）

```bash
~/Documents/GitHub/VibeDoc/mac/install.sh 你的仓库 --name "VibeDoc"
```

生成 `~/Applications/<名称>.app`，之后用 Spotlight、Raycast 或 Alfred 搜名称打开：服务没运行就在后台启动，已运行就直接打开；装了 Chrome 时用独立窗口打开，已有看板窗口则切到前台（服务是这次新启动的就顺带刷新）。管理多个仓库时，每个仓库用不同的 `--name` 和不同的 `port`。

App 是 `osacompile` 生成的 AppleScript 小程序（ad-hoc 签名）。首次打开 macOS 会询问是否允许它访问仓库所在文件夹（如「文稿」）以及控制 Google Chrome，点「允许」即可；重装后会再问一次。后台服务继承 App 的权限，所以小程序在服务运行期间常驻（无 Dock 图标），服务停止后自动退出。App 只记录仓库、VibeDoc 目录和 node 路径，更新 VibeDoc 后无需重装：在页面点「停止服务」再从 App 打开即可。日志在 `~/Library/Logs/vibedoc.log`。

## 配置 `vibedoc.config.json`

```json
{
  "name": "我的项目",
  "port": 4870,
  "rulesDir": "doc/rules",
  "featuresDir": "doc/features",
  "modules": { "app": "应用", "billing": "计费" },
  "modulesFile": "doc/modules/modules.yaml",
  "codemap": {
    "outDir": "doc/modules",
    "crates": [{ "dir": "backend/api", "lib": "api", "mainName": "crate" }],
    "migrationsDir": "backend/migrations",
    "publicMigrationDirs": ["legacy-public"],
    "frontendRoots": ["frontend/src"]
  },
  "watch": []
}
```

| 字段 | 说明 |
| --- | --- |
| `name` | 显示在页面标题上的项目名 |
| `port` | 看板端口，默认 4870；`PORT` 环境变量优先 |
| `rulesDir`、`featuresDir` | 规则与功能文档目录，默认 `doc/rules`、`doc/features` |
| `modules` | 模块 `id → 标题`；只用规则和功能文档时这样列出即可 |
| `modulesFile` | 可选，`modules.yaml`：除标题外还声明每个模块拥有哪些代码文件（代码地图用来归属文件，格式见下） |
| `codemap` | 可选，启用代码地图与关系图；不写则只有规则看板和功能文档 |
| `codemap.crates` | Rust crate 目录与库名；`mainName: "build-app"` 时 `src/main.rs` 以它调用的 `build_<x>_app` 命名为 `<x>_backend` 服务，否则以目录名命名 |
| `codemap.migrationsDir` | SQL 迁移目录：子目录名即该目录下文件的默认 schema；直接放在目录里或位于 `publicMigrationDirs` 的文件使用 `public` 并最先重放 |
| `codemap.frontendRoots` | 前端 TypeScript／React 源码目录 |
| `watch` | 额外需要触发代码地图刷新的目录 |

代码地图目前识别：Rust（axum 路由、serde 结构体、SQL 字面量）、按目录分 schema 的 PostgreSQL 迁移、TypeScript／React 前端（`<Route>` 页面与 `fetch` 封装）。其他技术栈可以只用规则看板与功能文档。

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

## 命令（AI 使用）

```bash
vibedoc rules list [--all] | show <id> | confirm <id> | start <id> | mark <id> [--impl a,b] | refresh
vibedoc features list [--all] [模块] | show <id> | set <状态> <id...> | summary [模块] | refresh
vibedoc codemap generate | fn <名称> | route <路径片段>
```

- 规则：AI 只能改状态行，工具会拒绝任何改动用户原文的写入。`show` 对「已修改」的规则会从 Git 历史找出 AI 上次处理时的原文。
- 功能文档：状态 `new` `confirm` `doing` `done`（已持久化）`released`（已上线）`parked`；`set` 同时记录当前内容为已处理，所以只有用户的修改会显示为「已修改」。
- 代码地图：`generate` 把每个模块 × 前端／API／后端／数据库／结构体写成 Markdown，并输出 `codemap.json`；`fn`、`route` 查询调用方、路由和表。

文档格式与状态流转见 `vibedoc init` 生成的两份 README（模板在 [`templates/`](templates/)）。

## 文件

| 文件 | 作用 |
| --- | --- |
| `vibedoc.ts`、`bin/vibedoc` | 命令入口（`init`、`serve`、`rules`、`features`、`codemap`） |
| `config.ts` | 查找仓库根目录、读取 `vibedoc.config.json` |
| `server.ts` | 本地 HTTP 服务：页面、`/api/health`、`/api/codemap`、`/api/rules`、`/api/features`、`/api/shutdown`、实时事件，监听文档与代码目录 |
| `web/index.html` | 全部页面 |
| `rules/store.ts` | 规则与功能文档的解析、编号、状态行与哈希、整篇保存、原文不变性校验 |
| `rules/cli.ts`、`features/cli.ts` | 状态命令 |
| `codemap/model.ts` | 读取模块清单，扫描 Rust、迁移和前端，解析调用、路由、表并归属模块与服务 |
| `codemap/rust.ts`、`sql.ts`、`frontend.ts`、`serde.ts`、`yaml.ts` | Rust 词法扫描、迁移重放与 SQL 引用、前端 API 调用识别、serde 字段换算、YAML 子集解析 |
| `codemap/render.ts`、`json.ts`、`cli.ts` | Markdown 与 JSON 输出、命令入口 |
| `mac/install.sh`、`mac/launch.sh`、`mac/icon.svg` | macOS 启动器 |
| `templates/` | `init` 写入的 README 与给 AI 的说明片段 |
