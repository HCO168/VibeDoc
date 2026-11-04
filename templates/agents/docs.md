## 人类区与 AI 维护区

- `{{docs.human}}/` 是用户区：`{{docs.sketches}}/` 与 `{{docs.requests}}/` 中的草图和需求原话由用户提供，AI 只读，不得修改、重命名、移动或删除；实现依据写入正式文档并注明原件路径。`{{rulesDir}}/` 是用户的逻辑规则，AI 只能通过 `vibedoc rules` 改状态行，格式见 `{{rulesDir}}/README.md`。`{{docs.questions}}` 由 AI 用 `vibedoc question add` 新增待决问题，用户在看板或文件里作答；答复后 AI 把结论写入 `{{docs.behavior}}/*`，再用 `vibedoc question resolve` 删除该条。`{{docs.deliverables}}/` 仅按用户要求更新。
- 涉及 UI 或产品需求的任务，先查看 `{{docs.sketches}}/`、`{{docs.requests}}/` 中相关内容。
- 其余目录由 AI 维护：`{{docs.behavior}}/` 行为、{{contracts}} 接口与数据契约、`{{docs.todo}}`／`{{docs.goals}}`／`{{docs.totest}}/` 进度与交接、`{{docs.changelogs}}/` 历史、`{{docs.expired}}/` 失效文档。`{{featuresDir}}/` 是按模块的功能与架构文档：AI 撰写正文，用户可直接修改；状态行只通过 `vibedoc features` 改，AI 每次改写正文后用 `set` 记录，不改写处于「已修改」的条目；用户直接在对话里提出的功能新增、修改或删除同样要先写进对应条目再实现，格式见 `{{featuresDir}}/README.md`。`{{tablesDir}}/` 是用户提出的表变更，只通过 `vibedoc tables` 改状态，格式见 `{{tablesDir}}/README.md`。{{#codemap}}`{{codemap.outDir}}/` 是代码生成的代码地图，只维护模块清单与 `README.md`，其余文件不手改、不提交。{{/codemap}}新增或移动文档时同步更新 `{{docs.root}}/README.md` 索引。

## 写作与跟踪

- 所有文档正文一律使用{{language}}。代码标识符、文件路径、API 路径、HTTP 方法、字段名、环境变量、命令、日志原文和代码块保持技术原文。已有的其他语言段落不做整体翻译，修改到哪一段时再改写。
- 仅当当前用户目标跨多个步骤或回合、存在待定 API/行为决策，或需要交接时，维护 `{{docs.goals}}`。记录目标、范围、非目标、状态、未决问题和需要落盘的文档；持久文档更新后立即删除对应条目。
- `{{docs.goals}}` 不替代 `{{docs.todo}}`、`{{docs.totest}}/`、当前契约文档或变更日志。产品状态使用 `{{docs.todo}}`（`## Backlog`、`## In Progress`、`## Under Test` 三节，`vibedoc todo`）；仅真实延后或人工 QA 使用 `{{docs.totest}}/`，不得无证据标记完成，并须记录受阻测试的命令、环境和错误。
- 每次完成改动都写一份变更日志：`vibedoc changelog new --role <角色> --slug <英文短名>` 生成 `{{docs.changelogs}}/<日期>/<时分秒>_<角色>_<短名>.md`，填写「变更内容」「影响范围」「验证」三节；写明用户原始要求、做了什么、没做什么与原因。
- 写入文档前先读取当前目标与关联契约，原地更新现有章节；不要用记忆整体重写文档。
