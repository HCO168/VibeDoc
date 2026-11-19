## time: 2026-11-19 | role: developer-tooling-engineer

### 变更内容

- 用户要求：以 `vibe-doc` 为包名把 VibeDoc 发布到 npm（`vibedoc` 已被 npm 上一个无关的包占用）。
- `package.json`：包名 `vibe-doc`，去掉 `private`，`license` 改为 SPDX 写法 `AGPL-3.0-or-later`（例外条款 `LICENSE-EXCEPTION.md` 随包发布），`files` 只发布 `bin/`、`dist/` 和例外条款，新增 `prepack` 与 `keywords`。命令名仍是 `vibedoc`。
- 新增 `build.ts`：Node 不在 `node_modules` 里剥离 TypeScript 类型，装好的包直接运行 `.ts` 会报 `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`。打包前用 Node 自带的 `stripTypeScriptTypes` 把程序源码编译成 `.js`，改写相对导入后缀，并把运行时读取的 `package.json`、`templates/`、`skills/`、`web/`、`examples/plugins/` 复制进 `dist/`；编译后仍有相对 `.ts` 引用时报错。不新增依赖。
- `vibedoc.ts` 的子命令与 `docs/cli`、`server.ts` 调用 `init` 的路径改为按当前模块扩展名拼接，源码和编译结果都能运行。
- `bin/vibedoc`：有 `vibedoc.ts` 时（源码检出）照旧运行源码，否则运行 `dist/vibedoc.js`；`dist/` 加入 `.gitignore`。

### 验证

- `npm test`：21 项通过；把同一套测试指向编译后的 `dist/` 再跑一遍，21 项通过。
- `npm pack` 后装到临时前缀：`--help`、`init`、`features list`、`codemap generate`、`index generate`、`changelog new`、`skill path` 正常，`serve --only` 首页返回 200。

### 文档

- `README.md`「安装」加入 npm 安装方式与 `npx vibedoc` 的同名包提醒；「文件」表加入 `build.ts`。
