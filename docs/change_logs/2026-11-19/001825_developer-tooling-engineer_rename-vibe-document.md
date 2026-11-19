## time: 2026-11-19 | role: developer-tooling-engineer

### 变更内容

- 用户要求：npm 包名改用 `vibe-document`（用户已在 npm 上占下这个名字）；`vibe-doc` 不再使用。
- `package.json` 的 `name` 改为 `vibe-document`；命令名仍是 `vibedoc`。
- `README.md`「安装」与 `templates/agents/root.md` 的规则改为 `npm install -g vibe-document` / `npx vibe-document <命令>`。

### 验证

- `npm test` 与打包后试装见本次提交前的检查。
