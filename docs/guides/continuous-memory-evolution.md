# 持续记忆进化

持续记忆进化在 host 绑定的 scope 内，按有限批次检查已有记忆或已注册目录，预览工作量、生成隔离提案并提供独立 owner 审阅。**提案、批准和实际应用是三个不同结果**：应用仍受来源证明、目标版本、撤销与写入事务门禁约束。它不是会话采集 hook，也不会因开启 feature 而持续扫描、自动批准或发布 Skill。

## 启用条件

- `features.continuousMemoryEvolution` 默认 `false`，必须由操作者在可信配置中显式启用。
- 使用提供进化 capability 的 RuntimeHost 与匹配的 native PostgreSQL schema：v36 为批次基础，审阅、changed/due 和 host 状态扩展使用 v37。配置开关、客户端命令存在或 `ms doctor` 连通，都不等于服务端已具备全部能力。LanceDB/Supabase 不提供此 native 治理组合。
- host 的 authority 和 default scope 必须有效。批次、来源、候选和目标记忆受同一 scope 约束，不因同一用户或项目名称相同而自动跨 app 共享。
- 提案使用 Mengshu 全局 `llm` 配置的结构化提取模型；操作者显式指定的 `MENGSHU_CONFIG` 属于可信 host 配置来源。请求、项目材料和被扫描目录中的配置都不能覆盖模型、凭据或 authority。无可用模型时可以预览，不能生成模型提案。

在已有模型、存储配置基础上合并以下片段。`root` 是示意的服务器绝对目录，须替换为操作者明确允许读取的目录，不是客户端上传的路径：

```json
{
  "features": {
    "continuousMemoryEvolution": true
  },
  "evolution": {
    "sources": [
      {
        "sourceId": "project-notes",
        "root": "/srv/mengshu-input/project-notes",
        "parser": "auto",
        "include": ["**/*.md", "**/*.jsonl"],
        "exclude": ["**/.git/**", "**/node_modules/**"]
      }
    ]
  }
}
```

来源省略 `scope` 时沿用 host scope；显式绑定只能使用 host 已授权的维度。一个 host 实例只使用与其当前 scope 精确匹配的来源。来源配置、格式和默认值见[配置说明](configuration.md)。批次由唯一的 RuntimeHost durable worker 承载；CLI 和 MCP proxy 不创建额外 worker。使用独立 `ms serve` 时，不应再让插件拥有第二套后台消费循环；`external-runtime-host` 只声明后台归属，不自动把所有插件读写变成 REST proxy。仅有 standalone MCP 进程不代表具备这些后台能力。

## 两条内容入口

| 入口 | 输入与边界 |
|------|------------|
| `inventory --selection baseline` | 有界读取当前 scope 内符合生命周期条件的已有记忆及可核验原始证据；按冻结的上界与稳定 keyset 分页，不是全库重写 |
| `inventory --selection changed` | native v37 组合读取未确认的外部语义 outbox 事件；冻结有限集合，逐项凭持久处理结果确认，不靠访问热度判断变化 |
| `inventory --selection due` | native v37 组合读取到期复核目标，按 revision/hash 复核后推进对应期限；不是后台定时器 |
| `scan --source-id <id>` | 读取 host 已注册来源中的 Markdown 或受支持的 JSONL，保留必要的标题、相邻条件、片段定位和指纹 |

`changed/due` 的默认 native provider 已接入选择与确认端口；自定义 host 必须提供同一组合，不能仅声明枚举。预览不消费事件；进化自身生成的 outbox 不再次作为外部变化触发循环。冻结集合还受 checkpoint 大小约束，未纳入的事件留给后续新批次，不表示全部增量已处理。`propose` 的确认只证明提案已持久化，不证明内容已应用。

`ms scan` 与 `ms project ingest-history` 属于其他摄入/验证流程，不等同于本指南的进化批次。`ms evolve scan` 不接受位置路径、`--scope`、`--model` 或 `--api-key`。

## 预览、提案与受控应用

| 动作 | CLI | 影响 |
|------|-----|------|
| `preview` | 默认或 `--dry-run` | 读取有限输入并生成批次报告；不调用 LLM/embedding，不改 canonical，不推进已确认来源 manifest；可持久化批次状态 |
| `propose` | `--propose` | 调用全局模型，保存隔离候选和必要证据片段；不改变当前 head、confidence、正常 lookup/context 或有效证据集合 |
| `apply_allowed` | `--apply-allowed` | 进入来源、目标 revision/hash、授权、撤销与写入能力门禁；没有合格证明或专用审阅回执时可被拒绝、转审阅或 no-op，不是内容更新开关 |

上述内容批次的三个动作互斥，未指定时按预览处理。先检查预览，再选择是否生成提案；来源对账与撤销使用下述独立的治理控制合同：

```bash
ms evolve inventory --selection baseline --dry-run \
  --max-records 20 --idempotency-key inventory-preview-001

ms evolve scan --source-id project-notes --dry-run \
  --max-files 5 --max-bytes 1000000 --idempotency-key notes-preview-001

ms evolve scan --source-id project-notes --propose \
  --max-llm-calls 2 --max-input-tokens 8000 --max-output-tokens 2048 \
  --idempotency-key notes-propose-001
```

库存入口也可生成隔离提案：

```bash
ms evolve inventory --selection baseline --propose \
  --max-records 20 --max-llm-calls 2 --idempotency-key inventory-propose-001
```

同一 scope 内，重试同一请求应保留相同幂等键；更换动作、来源、selection 或预算要使用新键。CLI 省略键时会生成新键，不适合需要精确重试身份的自动调用。相同输入及处理指纹已有结果时可复用提案或跳过模型；扫描和 hash 复核仍有 I/O 成本，不能把“无需再次调用模型”理解为“无需读文件”。

### Owner 审阅

native RuntimeHost 提供以下专用流程。先在可信配置中设置独立 `evolution.control.ownerSecret`，不要将其交给普通模型代理、扫描材料或批次 body：

```bash
ms evolve proposals --batch-id <batch-id> --limit 20
ms evolve proposal <proposal-id>
ms evolve review <proposal-id>
ms evolve review-status <review-id>
```

`proposals` 返回有界摘要和可选分页游标；`proposal` 返回必要证据与提案。`review` 重读来源和目标，生成精确 diff、`bindingHash` 与有效期。审阅内容超限会拒绝，不截断后要求批准。操作者核对后使用 [CLI 审阅命令](../api/cli-commands.md#专用审阅合同)作出批准或拒绝；批准响应的 receipt ID 才能提交专用 apply。apply 经同一 durable 队列执行，不在 HTTP 请求中绕过 writer。

普通客户端与 owner 使用不同认证：普通 bearer 或 loopback 不足以审阅，MCP proxy 只有在独立 owner 认证后才暴露相应工具。缺少能力、来源已改变、目标 CAS 不符、回执过期或已撤销，都不能通过再次批准旧 diff 解决。取消批次用 `ms evolve cancel <batch-id>`，不是撤销已提交事实。

### 来源证明与应用边界

- 目录注册只授权读取。当前目录适配器把内容标为不可信来源，日志的 `role=user`、frontmatter 或一段自称权威的文字都不能提升可信度；内容性变更需审阅，`--apply-allowed` 不会把它们自动变成可信用户决定。
- 默认 native PostgreSQL provider 已为目录入口装配 related-target 查找，以有效来源关联或精确内容 hash 发现有限目标，再读取目标当前 revision/hash。来源关联只是发现审阅对象，不增加作者信任或目标修改权；没有命中也不证明全库没有相关目标。
- 目录提案保存持久定位，可由新 reader 实例在原 host binding 内精确重读指定文件/片段；有定位的提案复核失败不退回全树扫描，旧无定位提案仅保留有界 fallback。定位保存身份与指纹，不是来源正文副本或授权。无法重读、来源漂移或预算不足时阻断，不用 staged quote 代替当前来源，也不将单条精确重读当成整页已确认；这不代表实际系统恢复演练已完成。
- 已有 canonical 文本不能为自己增加独立证据。库存 legacy raw evidence 虽可读取原文，其作者/授权没有可信证明，当前统一按 `untrusted` 处理；`MCP/user` 通道名、`remember` intent 都不足以证明用户本人授权。反复总结不能提高 confidence。
- host 可配置可信 Ed25519 issuer，对精确 evidence/source revision/hash、独立证据根、scope、目标绑定和期限核验签名；没有 issuer 或证明无效时仍按 untrusted 处理。owner 批准是行政决定，不证明原始作者身份，不自动成为独立有效支持。
- 专用 `source/attest` 接收可信 issuer 已签名的精确声明，`source/revoke-attestation` 撤销来源信任；REST、SDK、CLI 与 owner-authenticated MCP proxy 已提供对应入口，均要求独立 owner 认证，命令见 [CLI 参考](../api/cli-commands.md#来源与复用控制)。没有通用 host-state put，也不接受把原文标签当作签名。
- 默认 Runtime 已将 host attestation、输入读取预算和 writer 同事务 revocation guard 接入同一 native 组合。证明读取、来源复核及事务内复核均消耗预算；失效、撤销、hash/revision 不匹配或预算不足时不能提交可信写入。这是已接入的治理门，不代表任意提案都能转为 active，也不替代完整应用验收。
- 撤销 attestation 只影响信任资格，不等于现有 canonical evidence/links 已退役，更不是删除来源数据。canonical 支持关系撤销须另行提交 `source_revoke` 治理批次；行政批准回执不能当作该批次的数据库提交或遗忘回执。
- provider 的内容、补证据、争议和等价治理仍受各自动作门禁。不能从操作枚举或数据库字段推出目录支持关系、冲突与缓存传播已经端到端生效。kind-only 保持 lookup-only，不自动映射为 `rules` 或进入 5 槽位。
- pin、重大决策、规则/约束、敏感内容、含糊改写和不可信来源保留审阅要求。普通 candidate 审核/晋升拒绝进化候选；专用审阅也不能绕过来源重读、CAS、撤销与 receipt 门禁。`resume` 不是审批。

## 来源对账与精确撤销

默认 native Runtime 的治理控制复用原 durable 队列、租约及后台 allowlist，不是即时直接 SQL 入口，也不会由自动维护发起。请求限定 `input.mode=control`、`action=execute_control`，`input.work` 只有以下三种：

| 工作 | 合同 |
|------|------|
| `source_reconcile` | 仅传已注册的 `sourceId`，有界扫描、对账来源支持关系；数据库 receipt 之后才确认 manifest，不把 partial 扫描当作所有文件已枚举 |
| `source_revoke` | `sourceId`、`expectedRevision`、`reviewReceiptId`；先由 owner 调用 source-revoke-attestation，批准精确 sourceRevision 与 operationIdempotencyKey，再以该 revision、回执 id 和同一操作幂等键提交批次 |
| `undo_governance` | `operationReceiptId`、`currentStateHash`、`reviewReceiptId`；先预览当前状态，owner 批准精确 hash，再以批准绑定的 operationIdempotencyKey 作为批次 idempotencyKey 执行 |

undo 仅支持有合格操作回执的 `mark_disputed/revalidate/add_evidence/merge_equivalent`，不是任意历史回滚、备份恢复或正文覆盖。预览不写入；批准保存行政状态但尚未执行撤销，后续事务仍复核当前状态、批准有效期、消费绑定和租约。不提供通用 host-state put、客户端 path/authority 或自行填造批准字段。

CLI 为 `ms evolve control --request <json>`、`ms evolve undo-preview <receipt-id>`、`ms evolve undo-approve --request <json>`；完整字段、REST/SDK/MCP 名称及结构示例见[治理控制 API](../api/memory-api.md#治理控制批次)。这三条入口均要求独立 owner 认证。控制请求只接受 `maxRecords/maxFiles/maxBytes/maxDurationMs` 四项 I/O 限额；LLM 调用和 token 预算固定为零。来源对账需要正的文件预算，另外两种工作将文件预算归零；极小预算仍可能无法容纳扫描、复核或事务。

报告的 `work.kind` 标识工作，`work.result` 可给出有限提交 receipt 与已知影响，不能按 `counts.applied` 推导受影响记忆总数。`source_reconcile` 扫描不完整或提交后 manifest 确认失败可返回 `partial`；若已返回数据库 receipt，就可能已有部分治理提交，不能声称完全未写。`usageAccounting=budget_reservation` 是预算计量，不是实际账单。控制入口与原生事务接线存在，不等于完整原生 PG、读取/缓存传播或生产效果已通过统一验收。

## 状态与恢复

使用响应中的真实 `batchId` 查询或恢复，不传客户端构造的 checkpoint：

```bash
ms evolve status <batch-id>
ms evolve resume <batch-id>
```

| 状态 | 含义 |
|------|------|
| `queued` / `running` | 已登记或正在执行；不是应用成功 |
| `completed` | 本批输入边界已处理完，可能全部为 noop、拒绝或提案；不表示整个目录始终无变化 |
| `partial` | 预算、输入 gap 或部分扫描使工作未完成；查看 `reasons` 和 `resumable` |
| `blocked` | 必要能力、治理条件或审阅要求未满足；检查原因，不靠重复恢复绕过 |
| `cancelled` / `failed` | 执行取消或失败；是否可恢复以返回字段及 host 状态为准 |

HTTP `200`、CLI 返回 JSON 或 `counts.proposed > 0` 均不是 canonical 已应用的证明。检查 `status`、`reasons` 和 `counts.applied/review/rejected/noop/skipped`；数据库提交 receipt 才是已提交真源。

显式 `resume` 为可恢复批次开启新的有限执行段（segment），沿用原请求的单段 limits，并累计整个 batch 的 `usage`；响应中的 `segment.attempt/usage` 描述当前段。正常幂等重试和后台 job retry 不重置预算。一次 resume 不代表无上限续跑，`resumable` 也不是跨配置/权限变更的恢复保证；全局模型、来源或 scope 指纹变化时不能混用旧批次配置。

治理控制批次的 resume 仍需独立 owner。CLI/SDK 配置了 owner 凭据时会转发，REST/MCP resume 仅在携带该 header 时严格认证；无 header 的普通批次恢复仍可用，但不能恢复控制批次。请求仍只传 batchId，不新增 action、limits、checkpoint 或 owner body 字段。

客户端 checkpoint 是脱敏摘要，不含可回放的目录路径或完整内部游标。目录迭代游标只在 scanner 实例内有效；进程重启需重扫并依赖已确认 manifest 与数据库身份去重，不承诺恢复操作系统目录偏移。

## 预算与成本

未传 limits 时使用下表默认值；同一批次内读取、核验及模型调用共同消费应用层预算。数值用于批次保护，不是 provider 资源硬配额，也不是吞吐或效果承诺。

| 字段 | CLI 参数 | 默认值 | CLI 上限 |
|------|----------|--------|----------|
| `maxRecords` | `--max-records` | `100`，包括目标与证据读取/复核，不等同于生成记忆数 | `100` |
| `maxFiles` | `--max-files` | `20`，包括来源复核 | `20` |
| `maxBytes` | `--max-bytes` | `1000000` 字节；目录计入源 hash 重读，库存采用下述读后保护 | `10000000` |
| `maxLlmCalls` | `--max-llm-calls` | `8` | `10` |
| `maxInputTokens` | `--max-input-tokens` | `32000` | `40000` |
| `maxOutputTokens` | `--max-output-tokens` | `8000` | `8000` |
| `maxDurationMs` | `--max-duration-ms` | `120000` 毫秒 | `300000` |

库存计量包含 keyset 分页为判断是否还有后续结果而额外读取的 lookahead 行，以及返回的原始证据行。字节量按 SQL 返回行的 JSON 序列化大小计算；`maxBytes` 是这些有界结果返回后的检查（post-read），不是数据库磁盘扫描或网络传输的硬配额。一次结果可先超过剩余字节预算，再触发暂停保护；不能由 `usage.records/bytes` 推导 provider 线上精确 I/O。

报告用 `usageAccounting: "budget_reservation"` 标识保守预算计量，其中 token/calls 是预留上界，不等于 provider 实际使用量或账单；不要把累计 `usage` 当成单段余额。模型真实用量和金额估算见 ledger/`ms cost`，未定价的记录仍为 `unpriced`；数据库实际磁盘/网络 I/O 则需查看数据库及系统监控。CLI 与 REST/MCP 有各自的输入上限，详见 [CLI 参考](../api/cli-commands.md)和 [Memory API](../api/memory-api.md)。

## 来源、容量与保留

- 支持 Markdown 和已识别的 Codex、Claude Code、OpenClaw JSONL 格式；不是任意 JSON/文本/二进制导入器。仅采集受支持的可见消息与必要文本，不将隐藏推理作为证据。
- 文件身份、内容 SHA-256、revision 和片段/事件身份共同用于复核。相同 size/mtime 不能替代 hash；改名、复制、重复导出不能凭文件路径增加独立证据。
- 拒绝 symlink、越界路径、被排除的输出目录和不支持的文件。读取前后发生变化、JSONL 半行/坏行/截断、不可读项或预算耗尽均可能得到 partial 或拒绝结果，不据此宣告全目录完成。
- scanner 还有枚举、深度、单条与 manifest 上限：默认每页 2000 entries、深度 8、单条 64 KiB；manifest 默认 2 MiB，最多跟踪 4096 个文件、每文件 2048 个 span。长目录或大记录需按来源分区并查看原因，不能通过不断 resume 消除结构性上限。
- `source_unavailable` 只表示完整枚举后无法找到此前文件，不等于事实已被推翻或用户要求遗忘；partial 目录扫描不作为文件消失的依据。一个文件已完整读取时，可独立识别该文件内删段，不要求其他文件已全部枚举。来源变更事件只有提交治理回执后才代表对应旧支持关系已处理；明确遗忘仍使用独立的[遗忘接口](../api/memory-api.md)。
- 仅为提案保留必要片段，不复制完整会话库。已应用来源 manifest 必须在数据库 receipt 确认后推进；本地 manifest 不是提交证明。
- 候选带到期元数据，过期不能继续应用，但到期不等于正文已物理删除。默认维护 driver 已接入 maintenance 批次释放租约前的有界 retention；仍须通过预算、前台优先和存储门禁，不是所有批次结束都会清理。已提交 receipt 和去重索引不能为腾空间随意删除。

## 维护、复用与 Skill

`evolution.maintenance` 独立且缺省关闭。启用进化的默认 native Runtime 已组装低频维护 driver，复用既有 scheduler 的空闲检查、批次执行前准入和 maintenance 批次释放租约前的 retention，不创建第二个 timer 或文件 watcher。自动调度仅准备 `inventory/selection=due` 的 `propose` 批次，不自动批准、应用或发布；发现 due 项不等于对应精确目标已全部处理，确认仍依赖批次冻结快照与持久结果。

`paused/evolution_only`、前台忙或静默期不足、未知价格、每日预算不足，以及空间观测缺失/不足均阻止自动维护。owner/day 原子预算跨批次与 scope 共享，金额按可信价格快照换算；实际用量不明时保留 reservation，不把批次预算当真实账单，也不把未知费用记为零。

**当前默认 PostgreSQL 组合没有可信的数据库 backing-store 剩余空间 telemetry，`databaseFreeBytes=null`，自动维护因此保持阻断。** host 本地 `statfs` 的 `localFreeBytes` 不是远端 PG 剩余磁盘；数据库已用量也不能推导剩余量。不能仅设 `enabled=true` 就宣称维护已可运行。`ms evolve maintenance` / `GET /v1/runtime/maintenance` 提供有界状态，不是手动触发入口。

默认 Runtime 已将同 owner 的受控跨 app 读取接入候选检索、hydration、MemoryService、引用与缓存重验。仍要求显式、精确 grant，并检查目标 app/agent、适用范围、有效期、撤销和目标模型/工具兼容性；不会因开启 feature 自动共享，更不会合并不同 tenant/user。grant 替换使用当前 revision CAS；来源关联不产生 grant，旧引用或缓存不保留撤销后的资格。

默认配对 evaluator 通过 `evolution.reuse.evaluations` 注册固定文件与 hash，控制请求只传 `planId`。当前任务域为 `synthetic:fact-selection-v1`，绑定 artifact 内容、目标执行配置、模型两臂输出与单用 holdout；不是任意 Skill 行为评测器。缺任务、模型、有效授权、资源依赖 reader 或持久证明时阻断；注册配置及接口存在不证明完整配对正例已统一验收。`accepted_for_review` 只支持相应适用域的审阅建议，仍返回 `publishAllowed=false/executionAllowed=false`，不等同正式 G/P 或生产效果验收。

**完整 E3 经验到 Skill 闭环尚未实现。** 默认 PostgreSQL 组合缺少能提供独立结果证明的合格 `ExperienceSource`，受治理 Skill 聚合未默认接通。库存 experience 与原始证据存在、Working Set 的 `verified_outcome` 标签或文本一致性检查，都不足以生成独立验证回执、成功/失败反例、适用条件、步骤和风险边界。来源签名、Skill draft gate、候选接口及合成自测不能补成这条生产事实链；Skill 保持 reviewed/suggest-only。

## 历史数据与回滚

历史治理应分别具备 audit、plan、rehearse、apply、verify、rollback 门禁：冻结元数据清单与 hash，逐源说明 disposition，在隔离环境证明备份可恢复，审阅精确计划，凭 receipt 执行有限批次，再独立验证目标与源守恒。没有可用 operator 时不要拼接 SQL、重跑旧物化流程或猜测命令完成激活；`ms evolve scan` 不是这套历史迁移流程。

当前历史 operator 脚本仅支持 synthetic 数据和 loopback 隔离数据库，权限、守恒及回滚仍处于工程验证阶段，不是生产操作入口。当前交付不包含已安装系统升级、真实历史自进化/更新或实际恢复演练；这些操作保持暂停，不提供生产调用命令。

关闭 feature 或暂停后台不回滚数据。schema v37 之后仅换回旧安装包不构成数据库回退；应使用兼容该 ledger 的 runtime，或在独立授权和维护门下恢复已验证的数据备份，禁止删除 ledger 伪装降级。详见 [Schema](../design/schema.md)。源码工程验证、安装产物验证、部署和真实数据效果是独立结论，不能由批次完成数互相替代。
