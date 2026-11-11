# VibeDoc Output and Plugin Exception

Copyright (C) 2026 HCO168

VibeDoc is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version (the "AGPL", see [LICENSE](LICENSE)).

As additional permissions under section 7 of the AGPL, the copyright holder grants the following. The English text below is authoritative; the Chinese translation that follows is for convenience only.

## 1. Generated output

Files and text that VibeDoc writes into, or generates for, a project or environment it is used with ("Output") may be used, modified and distributed under terms of your choice, including in proprietary and closed-source projects, even where the Output contains material copied from VibeDoc's templates. Output includes:

- the rule blocks inserted into `AGENTS.md`, `doc/AGENTS.md` and similar files (for example by `vibedoc init` or `vibedoc agents sync`);
- scaffold documents and files copied into a project from `templates/`;
- skill files installed by `vibedoc skill install` and plugin skeletons created by `vibedoc plugins new`;
- change logs, questions, to-do lists, feature and rule status lines, code maps, relationship graphs and other documents or reports VibeDoc produces.

This permission does not cover VibeDoc's own source code (the program itself) when it is copied into, or bundled with, another work.

## 2. Plugins, skills and configuration

You may write, use and distribute plugins, skills, configuration files (such as `vibedoc.config.json` and `modules.yaml`) and project documents that interact with VibeDoc only through its plugin interface, command-line interface or HTTP API, under terms of your choice. Such works are not to be regarded as works based on VibeDoc merely because VibeDoc loads, runs or reads them.

## 3. Use as a development tool

Using VibeDoc, modified or not, as a tool while developing other software does not by itself subject that software to the AGPL.

## What stays under the AGPL

Everything else remains under the AGPL. In particular, modified versions of VibeDoc, works that incorporate VibeDoc's source code, and network services that let others interact with a modified VibeDoc must be made available under the AGPL with their corresponding source code.

When you distribute a modified version of VibeDoc you may keep these additional permissions or remove them, as section 7 of the AGPL allows.

---

# VibeDoc 生成内容与插件例外（中文译文，仅供参考，以英文为准）

版权所有 (C) 2026 HCO168

VibeDoc 是自由软件：你可以按照自由软件基金会发布的 GNU Affero 通用公共许可证第 3 版或（由你选择）任何更新的版本（下称 AGPL，见 [LICENSE](LICENSE)）再发布和修改它。

作为 AGPL 第 7 条下的附加许可，版权人授予以下权利：

1. **生成内容**：VibeDoc 写入或为所管理的项目、环境生成的文件和文本（下称“生成内容”），即使其中含有从 VibeDoc 模板复制的内容，你也可以按自己选择的条款使用、修改和分发，包括用于专有、闭源项目。生成内容包括：`vibedoc init`、`vibedoc agents sync` 等写入 `AGENTS.md`、`doc/AGENTS.md` 的规则区块；从 `templates/` 复制到项目里的文档骨架；`vibedoc skill install` 安装的 skill 文件和 `vibedoc plugins new` 生成的插件骨架；以及变更日志、待决问题、待办、功能与规则状态行、代码地图、关系图等 VibeDoc 产出的文档和报告。本条不适用于把 VibeDoc 程序本身的源代码复制进或打包进其他作品。
2. **插件、skill 与配置**：只通过插件接口、命令行或 HTTP API 与 VibeDoc 交互的插件、skill、配置文件（如 `vibedoc.config.json`、`modules.yaml`）和项目文档，你可以按自己选择的条款编写、使用和分发；它们不因被 VibeDoc 载入、运行或读取就被视为基于 VibeDoc 的作品。
3. **作为开发工具使用**：把 VibeDoc（无论是否修改过）当作工具来开发其他软件，这些软件本身不因此受 AGPL 约束。

**其余一切仍受 AGPL 约束**：VibeDoc 的修改版、包含 VibeDoc 源代码的作品，以及让他人通过网络使用修改版 VibeDoc 的服务，都必须按 AGPL 提供并公开对应的源代码。分发 VibeDoc 修改版时，你可以按 AGPL 第 7 条保留或删除这些附加许可。
