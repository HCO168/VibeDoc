## time: 2026-11-18 | role: developer-tooling-engineer

### 变更内容

- 用户要求：修复 HCONet 接入 AI 索引时发现的 VibeDoc 覆盖缺口；部署记录放进专门的文档目录，它和变更日志都不进索引。
- 只有常量或 `static`、没有函数与公开类型的 Rust 文件现在也有索引行，`defines` 列出公开常量；只声明模块或只做 `pub use` 的文件仍不列入。`Model` 新增 `rustFiles`。
- 迁移回放识别 `DO` 块里带条件的 `ALTER TABLE ... RENAME TO` 与 `SET SCHEMA`，改名后的表可以用 `table:` 引用。
- refs 支持目录（可带结尾 `/`）：目录下任一文件增删改都算变化；`index show`、完成门禁和文档浏览器把目录引用关联到其中的文件。
- 一级标题下的开头正文也是一个小节（键名 `文档路径#一级标题`），可以挂 refs；以前这段正文被跳过。
- 新增 `docs.deploylogs`（默认 `<docs.root>/deploy_logs`）：部署与验收记录。`changelogs`、`deploylogs`、`expired` 和索引目录即使位于行为或契约目录之下也不扫描小节。规则模板把部署记录目录列为历史，并说明这三处不进 AI 索引、不加 refs。

### 影响范围

- 已有账本兼容：以前一级标题下没有被登记的小节，现在只有写了 refs 才会被登记；其他小节的键名不变。
- 在 HCONet 上验证：727 个带引用的小节没有误报；新增 8 个只有常量的权限声明文件索引行；`table:drive.drive_share_relations` 与目录引用均可解析。

### 文档

- `README.md`「AI 索引与过期检测」补充引用项种类、小节范围与不扫描的目录；配置表加入 `deploylogs`。

### 验证

- `npm test` 21 项通过（AI 索引用例新增常量文件、带条件改名、目录引用、一级标题小节和历史目录排除的断言）。
