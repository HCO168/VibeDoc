## time: 2026-11-19 | role: developer-tooling-engineer

### 变更内容

- 用户要求：AI 不得再下载或运行 npm 上同名的第三方包 `vibedoc`（AI 会话曾用 `npx vibedoc` 拉起它的网页和服务）。
- `templates/agents/root.md` 第 4 节新增一条规则：VibeDoc 一律用 PATH 里的 `vibedoc <命令>`（来自 npm 包 `vibe-doc` 或源码检出）；禁止 `npx vibedoc`、`npm exec vibedoc`、`npm i vibedoc`、`pnpm dlx vibedoc` 等；PATH 里没有时用 `npx vibe-doc <命令>` 或询问用户。各项目运行 `vibedoc agents sync` 后生效。

### 验证

- `npm test`：21 项通过。
