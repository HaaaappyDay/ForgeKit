# ForgeKit 使用指南

本指南基于当前仓库的 MVP-0 行为编写，适用于想用 ForgeKit 初始化 `.forgekit/` 配置、编排角色化 CLI agent、查看运行记录、重试失败步骤，以及校验 JSON schema 的使用者。

## 1. ForgeKit 是什么

ForgeKit 是一个本地 CLI，用来把一个任务拆成多个角色步骤，让不同角色通过外部 CLI agent 执行，并把每一步的提示词、原始输出、结构化 handoff、校验结果和最终摘要保存下来。

当前版本的重点能力：

- 初始化项目级 `.forgekit/` 配置。
- 使用内置模板生成 roles、workflows、adapters。
- 启动线性 workflow，并在运行前展示 run plan。
- 调用 Codex 或 Claude Code 这类外部 CLI adapter。
- 要求 agent 输出 `handoff.v1` JSON，并在失败时自动自纠正一次。
- 保存完整运行轨迹到 `.forgekit/runs/<run-id>/`。
- 查看历史、查看 run 详情、重试失败 run。
- 校验 ForgeKit JSON schema。

当前版本的主要限制：

- MVP-0 只支持线性 workflow。
- workflow 运行时有效写入策略是 `no_write_intent`，即外部 agent 会被要求不要修改项目文件。
- 预算是软限制，超出后会记录在 run trace 里，但不会强制终止所有外部进程。
- adapter 的可用性取决于本机是否安装、登录并能运行对应 CLI。

## 2. 环境要求

ForgeKit 目标运行环境是 Node.js `>=20`。项目当前没有运行时依赖；TypeScript 源码需要先编译到 `dist/` 再运行。

确认 Node 可用：

```bash
node --version
```

如果你通过 nvm 管理 Node，请先切换到 Node 20 或更高版本：

```bash
nvm install 20
nvm use 20
```

如果当前 shell 里没有 `node`，但本机已经安装了 Node，也可以临时用绝对路径执行：

```bash
/path/to/node dist/cli.js --help
```

## 3. 运行 CLI

在仓库根目录先编译，再运行编译后的 CLI：

```bash
npm run build
node dist/cli.js --help
```

如果想使用 `forge` 命令，可以在仓库根目录执行本地链接：

```bash
npm run build
npm link
forge --help
```

项目 `package.json` 中的 bin 映射是：

```json
{
  "forge": "./dist/cli.js"
}
```

所以后续命令既可以写成 `forge ...`，也可以写成：

```bash
node dist/cli.js ...
```

## 4. 5 分钟快速开始

### 4.1 初始化 `.forgekit/`

在目标项目根目录执行：

```bash
forge init --template feature-planning --project-name my-project --yes
```

这会生成：

```text
.forgekit/
  config.json
  roles/
  workflows/
  adapters/
  examples/
  runs/
  cache/
  tmp/
```

`runs/`、`cache/`、`tmp/` 默认用于本地状态，不应该提交到 git。

### 4.2 检查 adapter

初始化后先检查外部 agent CLI 是否可用：

```bash
forge adapter probe codex-local
forge adapter probe claude-code
```

需要机器可读输出时加 `--json`：

```bash
forge adapter probe codex-local --json
```

如果 probe 提示命令不存在，编辑对应 adapter 文件：

```text
.forgekit/adapters/codex.json
.forgekit/adapters/claude-code.json
```

把 `command` 改成当前机器上可执行的命令，例如 `codex`、`claude`，或对应的绝对路径。
也可以直接用命令更新：

```bash
forge adapter set-command codex-local /path/to/codex
forge adapter probe codex-local
```

### 4.3 启动 workflow

用内联输入启动：

```bash
forge workflow start --input "为设置页设计一个导出配置功能" --yes
```

用文件作为输入：

```bash
forge workflow start --input-file task.md --yes
```

未显式传入 workflow ID 时，CLI 会使用 `.forgekit/config.json` 里的 `defaults.workflow`。
不加 `--yes` 时，CLI 会先展示 run plan，然后在交互式终端询问是否继续。非交互环境必须加 `--yes`。

### 4.4 查看结果

列出历史：

```bash
forge history
```

查看某次 run：

```bash
forge run show <run-id>
```

查看 JSON 详情：

```bash
forge run show <run-id> --json
```

最终摘要在：

```text
.forgekit/runs/<run-id>/summary.md
```

## 5. 内置模板

`forge init` 支持四个模板：

```bash
forge init --template feature-planning --yes
forge init --template feature-planning-agentic --yes
forge init --template generic-plan-review --yes
forge init --template blank --yes
```

### feature-planning

默认模板。适合把一个功能请求拆成产品、架构、工程计划、测试计划四个阶段。

默认 workflow：`feature-planning`

默认角色：

- `pm`：明确用户价值、范围、约束和验收标准。
- `architect`：给出技术设计和集成风险。
- `engineer`：把设计转成实施计划。
- `qa`：给出测试策略、边界情况和验收风险。

### feature-planning-agentic

与 `feature-planning` 同样的四个角色（`pm`、`architect`、`engineer`、`qa`），但使用 **agentic 模式**（`forgekit.workflow.v2`）。区别在于交接不再固定线性向前，而是运行时由当前角色在候选集内选择下一棒，并且每次交接都带验收标准、由接收方先验收再开工。

默认 workflow：`feature-planning-agentic`

要点：

- `qa` 是一个「混合角色」：它既是终点（可输出 `final` 结束 run），也保留交接目标（不满意时退回 `pm` 返工）。
- 交接被拒绝时会受控退回上一棒发送方，发送方复用会话返工后再前进。
- 反复返工触顶 `max_role_visits` / `max_steps` 预算时，run 会进入 `escalated` 状态，并在 `escalation` 里记录原因与最新产物。

agentic 模式的简要说明见下面的「Agentic 模式简述」。

### Agentic 模式简述

ForgeKit 支持两种 workflow：

- **线性（`forgekit.workflow.v1`，`mode: workflow_run`）**：步骤顺序固定，逐步向前，已通过 MVP-0 验收。
- **Agentic（`forgekit.workflow.v2`，`mode: agentic_run`）**：运行时按图遍历，由角色动态决定下一棒，带验收门和受控回退。

两种模式并存，`forge workflow start` 会根据 workflow 文件的 `schema_version` 自动分派，无需额外参数。agentic run 的产物存为 `forgekit.run.v2`（以 `nodes[]` + `edges[]` 表示），可通过 `forge run show` / `forge history` / `forge run retry` 查看与重跑（仅 `failed` 可重跑，`escalated` 不可重跑）。

启动方式与线性一致：

```bash
forge workflow start feature-planning-agentic --input "为设置页设计一个导出配置功能" --yes
```

### generic-plan-review

适合通用计划和复核流程。

默认 workflow：`generic-plan-review`

默认角色：

- `planner`：明确任务、约束和成功标准。
- `specialist`：输出领域计划或分析。
- `reviewer`：复核完整性、风险和下一步。

### blank

适合自定义 workflow。它会写入 schema 合法的 config 和 examples，但不会把示例 role/workflow 启用到正式配置里。你需要把 `.forgekit/examples/` 里的内容复制或改写到 `.forgekit/roles/`、`.forgekit/workflows/`，并更新 `.forgekit/config.json`。

## 6. 核心配置文件

### `.forgekit/config.json`

项目级配置，包含：

- `project.name`：项目名。
- `defaults.workflow`：默认 workflow ID。
- `roles`：role ID 到 role 定义文件和 adapter ID 的映射。
- `adapters`：adapter ID 到 adapter 配置文件的映射。
- `budgets`：最大调用次数、每步重试次数、最大运行时长、最大输出字节数等软预算。

常见修改是把某个角色切换到另一个 adapter：

```json
{
  "roles": {
    "architect": {
      "definition": ".forgekit/roles/architect.json",
      "adapter": "codex-local"
    }
  }
}
```

### `.forgekit/roles/*.json`

role 定义描述一个角色的边界：

- `id`、`name`、`description`
- `responsibilities`
- `expertise`
- `write_policy`
- `can_do`
- `cannot_do`
- `must_handoff_to`
- `required_sections`

查看某个 role 的文件路径：

```bash
forge role path architect
```

注意：CLI 运行时不会通过命令行参数扩大 role 的写权限。当前 MVP-0 workflow 仍按 no-write intent 运行。

### `.forgekit/workflows/*.json`

workflow 定义步骤顺序和每一步使用的 role。当前 MVP-0 只支持线性 workflow：

- `entrypoint` 必须是第一个 step 的 `id`。
- 每一步最多只能有一个 `next`。
- 非最后一步的 `next` 必须指向数组里的下一步。
- 最后一步不能再指向其他 step。

每个 step 的输出 schema 当前必须是 `handoff.v1`。

### `.forgekit/adapters/*.json`

adapter 定义外部 CLI 的调用方式：

- `type` 当前支持 `codex` 和 `claude-code`。
- `command` 是实际执行的命令，可以是 PATH 中的命令名，也可以是绝对路径。
- `args` 会追加在 ForgeKit 自动生成的 adapter 参数之前。
- `timeout_seconds` 控制单次外部进程超时。
- `auth` 描述认证来源，默认是使用外部 CLI 已登录账号。
- `billing` 描述计费模式，默认是用户订阅或未知成本追踪。
- `env_allowlist` 控制允许传给外部进程的环境变量。

## 7. 命令参考

### `forge --help`

显示当前 CLI 支持的命令。

```bash
forge --help
```

### `forge init`

初始化 `.forgekit/`。

```bash
forge init [--template <blank|generic-plan-review|feature-planning|feature-planning-agentic>] [--project-name <name>] [--yes] [--force]
```

常用参数：

- `--template`：选择模板。
- `--project-name`：写入 `.forgekit/config.json` 的项目名。
- `--yes` 或 `-y`：跳过交互，使用默认值。
- `--force`：允许写入已有 `.forgekit/` 目录。

默认模板规则：

- 指定 `--template` 时使用指定模板。
- 未指定模板且加了 `--yes` 或在非交互环境运行时，默认使用 `feature-planning`。
- 交互式运行时会提示选择模板。

### `forge adapter probe`

检查 adapter 配置、命令解析、轻量启动、认证和计费声明、写策略声明。

```bash
forge adapter probe <adapter-id> [--json]
```

示例：

```bash
forge adapter probe codex-local
forge adapter probe claude-code --json
```

probe 不保证结构化输出在真实 workflow 中一定稳定，它只做基础可用性检查。

### `forge adapter set-command`

更新某个 adapter 配置里的可执行命令。

```bash
forge adapter set-command <adapter-id> <command-or-path>
```

示例：

```bash
forge adapter set-command codex-local /opt/bin/codex
forge adapter probe codex-local
```

这个命令只修改 adapter 的 `command` 字段，不会修改 `args`、认证、计费或写策略配置。

### `forge workflow start`

启动 workflow。

```bash
forge workflow start [<workflow-id>] --input <text> [--yes]
forge workflow start [<workflow-id>] --input-file <path> [--yes]
```

规则：

- `--input` 和 `--input-file` 只能二选一。
- 未提供 `<workflow-id>` 时使用 `defaults.workflow`。
- 不提供输入会失败。
- 非交互环境必须加 `--yes`。
- 启动前会打印 run plan，包含步骤、adapter、上下文模式、认证计费声明、写策略和软预算。

运行结束后，CLI 会打印 `run.json`、`events.jsonl`、`summary.md` 路径，以及 `forge run show <run-id>` 和 `forge tui <run-id>` 下一步命令。

### `forge history`

列出 `.forgekit/runs/` 下可读取的 run。

```bash
forge history
```

输出格式：

```text
<run-id>    <status>    <workflow-id>    <updated-at>
```

损坏或不完整的 run 目录会在列表中被忽略。

### `forge run show`

查看某次 run 的状态、步骤、attempt、预算和 summary 路径。

```bash
forge run show <run-id>
forge run show <run-id> --json
```

文本输出适合人工阅读，`--json` 适合脚本处理或进一步调试。

### `forge run retry`

重试失败的 run。

```bash
forge run retry <run-id>
```

只能重试状态为 `failed` 的 run。ForgeKit 会从第一个失败步骤开始继续执行，并把之前 skipped 的后续步骤恢复为 pending。历史 attempt 不会被覆盖，新 attempt 会追加到对应步骤目录里。

### `forge tui`

交互式的全生命周期终端面板（dashboard）。CLI 与 TUI 并存，互不影响。

```bash
forge tui            # 打开面板首页（Home）
forge tui <run-id>   # 直接挂载到某个 run 的监控视图（向后兼容）
```

要点：

- 无参数时打开 Home，提供：发起新 run（向导）、实时监控、历史浏览、只读配置浏览、adapter 探测、初始化项目。
- 带 `<run-id>` 时直接进入只读监控视图，等价于旧版行为：tail `events.jsonl` 做实时更新，以 `run.json` 为权威状态。
- 同时支持线性 run（`forgekit.run.v1`）与 agentic run（`forgekit.run.v2`）。agentic run 以节点列表/时间线呈现（不绘制图）。
- 需要交互式终端（TTY）。非 TTY 环境会直接报错退出。
- **进程内执行**：在面板内发起的 run 跑在当前进程里，退出 TUI 会结束这些 run（其外部 agent 子进程随进程一起退出）。监控页会标明当前是 live in-process 还是 attached read-only；只要仍有 TUI 内发起的 live run 在运行，从任意非文本输入屏退出 TUI（`q`、Ctrl-C、Home 的 `Esc` 或 Quit 菜单）都会先要求二次确认，`Esc` 可取消确认。如需后台运行，用 `forge workflow start` 启动，再用 `forge tui <run-id>` 挂载查看。

#### 屏幕（Screens）

- **Home（首页）**：菜单（New run / History / Config / Adapters / Initialize project / Quit）与最近 run 列表；最近 run 可直接选中并按 `Enter` 以只读方式打开监控视图。
- **New run（向导，三步）**：① 选 workflow（标注线性/agentic、步骤数；无效配置不可选）→ ② 输入任务（单行文本，或填任务文件路径，`Tab` 切换字段，二者必须只填一个，确认时读取文件）→ ③ 成功构建并预览 run plan（步骤/角色、adapter、预算、警告）后 `Enter` 启动，随即进入实时监控视图；plan 构建失败时需先 `Esc` 返回修正输入。
- **Monitor（监控）**：线性显示步骤列表 + 预算 + 事件流；agentic 显示节点列表（`节点序号 节点ID (角色) [状态] 阶段`、acceptance verdict、下一个角色、escalation、预算），并带 `>`/`*`/`->` 图例和选中节点详情。`Enter` 打开产物阅读器。
- **History（历史）**：列出全部 run（`run_id status workflow_id updated_at`），下方预览选中 run 的任务、失败/escalation 摘要和 summary 路径，`Enter` 以只读方式挂载监控视图。
- **Config（配置浏览，只读）**：Workflows / Roles / Adapters 三个标签页，按 workflow 自身版本显示线性/agentic 类型与校验状态，`Enter` 查看可滚动的详情。
- **Adapters（探测）**：列出 adapter，并把列表状态标为 config validation；`Enter` 运行 runtime probe，探测中保留当前 adapter 标题，完成后展示命令解析、启动检查、auth/billing/write_policy 等运行时结果。
- **Initialize project（初始化）**：选择模板、项目名、`force` 开关，`Enter` 写入 `.forgekit`；已存在时给出提示并建议打开 `force`。`force` 会明确提示将覆盖模板生成的 `config.json`、`roles/`、`workflows/`、`adapters/`、`examples/`，并要求再次 `Enter` 确认。初始化成功后 `Enter` 返回 Home，`n` 进入 New run。

长 ID、任务文本、adapter command、事件消息等关键值会尽量换行显示；主要列表会在下方显示当前选中项详情，避免只能看到被截断的行。

#### 键位

```text
↑ / ↓      在列表/菜单中移动选择，或在阅读器/详情中滚动
Enter      确认 / 打开 / 启动
← / →      切换配置标签页或产物，或在初始化中切换取值
Tab        切换字段（任务/文件，或配置标签页）
g / G      在阅读器、详情页或 probe 结果中跳到顶部 / 底部
Esc        返回上一屏；Home 顶层按退出处理
q          请求退出（非文本输入屏；仍有 live run 时需要二次确认）
```

无论从哪个屏幕，实际退出、SIGTERM 或异常都会干净地复原终端（显示光标、离开备用屏）；Ctrl-C 在没有待确认 live run 时会退出，在仍有 live run 时先进入退出确认。屏幕按键处理或进入屏幕时的异常会以临时 `error: ...` 行显示在 footer 上方，而不是静默无响应。History、Config、attached Monitor 等读取类屏幕走 ForgeKit 的只读接口；New run 会写入 `.forgekit/runs/<run-id>/`，Initialize project 会写入模板生成的 `.forgekit` 配置文件。

### `forge role path`

输出 role 定义文件路径。

```bash
forge role path <role-id>
```

示例：

```bash
forge role path pm
```

### `forge schema list`

列出注册的 schema ID 和文件路径。

```bash
forge schema list
```

当前注册项：

```text
forgekit.adapter.v1          schemas/adapter.schema.json
forgekit.config.v1           schemas/config.schema.json
forgekit.role.v1             schemas/role.schema.json
forgekit.run-event.v1        schemas/run-event.schema.json
forgekit.run.v1              schemas/run.schema.json
forgekit.workflow.v1         schemas/workflow.schema.json
handoff.v1                   schemas/handoff.schema.json
workflow-summary.v1          schemas/workflow-summary.schema.json
forgekit.workflow.v2         schemas/workflow.v2.schema.json
handoff.v2                   schemas/handoff.v2.schema.json
acceptance-verdict.v1        schemas/acceptance-verdict.schema.json
forgekit.run.v2              schemas/run.v2.schema.json
```

### `forge schema validate`

用注册 schema 校验 JSON 文件。

```bash
forge schema validate <schema-id> <json-file>
```

示例：

```bash
forge schema validate forgekit.workflow.v1 .forgekit/workflows/feature-planning.json
forge schema validate forgekit.role.v1 .forgekit/roles/pm.json
forge schema validate forgekit.adapter.v1 .forgekit/adapters/codex.json
forge schema validate forgekit.run.v1 .forgekit/runs/<run-id>/run.json
```

成功时会输出：

```text
valid: <schema-id> <json-file>
```

失败时会逐行打印 schema 错误，并以非零状态码退出。

## 8. 运行产物说明

每次 workflow 运行会创建：

```text
.forgekit/runs/<run-id>/
  run.json
  summary.md
  workflow-summary.json
  context/
    repo-summary.json
  steps/
    01-<step-id>/
      attempt-01/
        prompt.md
        raw.log
        error.log
        handoff.json
        output.md
        validation.json
        correction-prompt.md
        correction-raw.log
        correction-error.log
```

并不是每个文件都会在每次 attempt 中出现。典型规则：

- `prompt.md`：ForgeKit 发给外部 agent 的完整提示。
- `raw.log`：外部 CLI 的 stdout。
- `error.log`：外部 CLI 的 stderr。
- `handoff.json`：通过校验后的结构化 handoff。
- `output.md`：handoff 中 `markdown_body` 的 Markdown 版本。
- `validation.json`：解析、schema 校验和内容校验结果。
- `correction-*`：只有初次输出校验失败并触发一次自纠正时才会出现。
- `summary.md`：整次 run 的最终摘要。
- `run.json`：机器可读的完整运行 trace。

## 9. Handoff 输出要求

每一步 agent 必须输出一个符合 `handoff.v1` 的 JSON 对象。核心字段包括：

- `schema_version`
- `run_id`
- `step_id`
- `role_id`
- `status`
- `summary`
- `decisions`
- `assumptions`
- `risks`
- `open_questions`
- `out_of_scope`
- `markdown_body`
- `next_handoff`
- `artifacts`

如果 ForgeKit 没有从原始输出里解析出合法 handoff，或字段内容不符合当前 run、step、role，它会构造 correction prompt，让同一个外部会话自纠正一次。

## 10. Adapter 行为

### Codex adapter

初次调用会使用 Codex exec 的只读模式，并传入 handoff schema：

```text
codex exec --skip-git-repo-check --json --output-schema <handoff-schema> -s read-only -
```

恢复同一角色会话时使用：

```text
codex exec resume --skip-git-repo-check --json --output-schema <handoff-schema> <session-id> -
```

ForgeKit 会从 Codex JSON 事件中提取 `thread_id` 作为外部 session ID。

### Claude Code adapter

调用 Claude Code 时会使用 stream JSON 输出，并禁用工具：

```text
claude -p --verbose --output-format stream-json --tools "" --json-schema <handoff-schema-json> <prompt>
```

恢复会话时追加：

```text
--resume <session-id>
```

ForgeKit 会从 Claude Code system init 或 result 事件中提取 `session_id`。

## 11. 安全和版本控制建议

不要提交这些本地状态或敏感文件：

```text
.forgekit/runs/
.forgekit/cache/
.forgekit/tmp/
.forgekit/secrets*
.env
.env.*
node_modules/
coverage/
```

这些路径已经在当前仓库 `.gitignore` 中配置。

建议提交的内容：

- `.forgekit/config.json`
- `.forgekit/roles/*.json`
- `.forgekit/workflows/*.json`
- `.forgekit/adapters/*.json`，前提是不包含个人密钥或本机私有路径。

如果 adapter command 使用了个人机器上的绝对路径，团队协作时更建议改成 PATH 中的命令名，例如 `codex` 或 `claude`。

## 12. 常见问题排查

### `node: command not found`

当前 shell 没有 Node。先安装或切换 Node 20 以上版本：

```bash
nvm install 20
nvm use 20
```

### `.forgekit already exists`

目标目录已经有 `.forgekit/` 且非空。确认要写入模板文件时加：

```bash
forge init --template feature-planning --yes --force
```

注意：`--force` 会允许写入已有目录，使用前应确认现有配置是否需要保留。

### `Unknown template`

模板 ID 只能是：

```text
blank
generic-plan-review
feature-planning
feature-planning-agentic
```

### `Unknown adapter id`

检查 `.forgekit/config.json` 的 `adapters` 映射，确认 adapter ID 是否存在。

### `Command not found or not executable`

adapter 的 `command` 找不到或不可执行。编辑对应文件，例如：

```text
.forgekit/adapters/codex.json
```

把 `command` 改成当前机器可运行的命令，或直接运行：

```bash
forge adapter set-command codex-local /path/to/codex
forge adapter probe codex-local
```

### `Use --yes for non-interactive workflow start confirmation`

你在非交互环境启动 workflow，但没有加 `--yes`。改为：

```bash
forge workflow start --input "..." --yes
```

### `Use either --input or --input-file, not both`

`workflow start` 的输入来源只能选一个。删除其中一个参数。

### `MVP-0 supports only linear workflows`

workflow 不是当前版本支持的线性结构。检查：

- step ID 是否重复。
- `entrypoint` 是否等于第一个 step 的 ID。
- 每一步是否最多只有一个 `next`。
- `next` 是否指向数组里的下一步。
- 最后一步是否没有 `next`。

### `Only failed runs can be retried`

`forge run retry` 只能用于状态为 `failed` 的 run。已完成的 run 不能重试。

### handoff 校验失败

查看对应 attempt：

```text
.forgekit/runs/<run-id>/steps/<step-dir>/<attempt-dir>/validation.json
.forgekit/runs/<run-id>/steps/<step-dir>/<attempt-dir>/raw.log
.forgekit/runs/<run-id>/steps/<step-dir>/<attempt-dir>/error.log
```

如果有 `correction-*` 文件，说明 ForgeKit 已经尝试过一次自纠正。

## 13. 推荐工作流

新项目建议按这个顺序使用：

```bash
forge init --template feature-planning --project-name my-project --yes
forge adapter probe codex-local
forge adapter probe claude-code
forge schema validate forgekit.config.v1 .forgekit/config.json
forge workflow start --input-file task.md --yes
forge history
forge run show <run-id>
```

如果想实时观察运行过程，可以另开一个终端，用 `forge workflow start` 输出的 run-id 挂载监控器：

```bash
forge tui <run-id>
```

如果某个 adapter 不可用，先调整 `.forgekit/adapters/*.json` 的 `command`，再重新 probe。真实运行前尽量先 probe，因为 workflow 失败后虽然可以 retry，但外部 CLI 的登录、路径、权限问题最好提前处理。

## 14. 开发者命令

运行测试：

```bash
npm test
```

列出 schema：

```bash
npm run schema:list
```

直接校验 fixture：

```bash
npm run build
node dist/cli.js schema validate forgekit.workflow.v1 tests/fixtures/valid/workflow-feature-planning.json
```

项目使用 TypeScript、原生 ES modules 和 Node 内置 test runner。生产代码编译到 `dist/`，测试代码编译到 `.tmp/ts-tests/` 后执行。
