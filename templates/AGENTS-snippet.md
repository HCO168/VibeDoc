## VibeDoc（规则与功能文档）

本仓库用 VibeDoc 管理用户的逻辑规则和功能文档，配置见 `vibedoc.config.json`。

- **规则**（`rulesDir`，默认 `doc/rules/<模块>.md`）是用户亲自写的逻辑要求，AI 不得改标题和正文，只能用 `vibedoc rules` 改状态。只有用户要求时才处理（例如「同步规则 app-1」「同步 app 的规则」）：`vibedoc rules list|show` 读取 → 在对话里给计划并 `vibedoc rules confirm <id>` → 等用户批准（或看板显示进行中）后 `vibedoc rules start <id>` → 实现 → `vibedoc rules mark <id> --impl <函数>`。代码或文档与规则冲突时先问用户，不改规则。
- **功能文档**（`featuresDir`，默认 `doc/features/<模块>.md`）是只讲功能和架构、不写代码细节的文档，由 AI 撰写、用户可直接修改。功能变化时同步更新对应条目，并在每次改写后用 `vibedoc features set <状态> <id>` 记录（`done`＝合入开发主分支，`released`＝正式发布）。用户改过的条目显示为「已修改」，视为新要求：只有用户要求时（例如「同步功能 app-f3」）才按 list/show → 计划 → `confirm` → 批准 → `doing` → `done` 处理，不要改写用户改过但尚未同步的内容。
- 启用代码地图时，改代码前可用 `vibedoc codemap fn <名称>`、`vibedoc codemap route <路径>` 查调用方、路由和表。
