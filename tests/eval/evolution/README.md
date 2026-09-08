# 持续进化 A/B/C 诊断

本目录是诊断 runner，不是正式 G/P scorer，也不改变发布门。默认不读取配置、不连接数据库、不外呼模型。正式结果由主 Agent 在授权隔离环境统一执行。

## 分组与观测

- A：保留同一冻结 baseline，不做进化；B：确定性治理；C：固定全局模型 proposer 加生产门禁。三个组必须各自独立 store/schema/cache，不能顺序复用 C 已修改的 baseline。
- `--governance auto` 与 `--governance reviewed` 分开运行、分开输出，不汇总成一个 C 效果。每例记录 autoApplied/reviewedApplied；reviewed 必须由独立 owner/source-diff-only policy 决定，不能看 heldout 答案决定 approve。批准仍不是历史作者证明，不提高同源置信度。
- `DiagnosticArmFactory.open` 只收到冻结设置与来源/原 canonical，永远不接收 heldout question/oracle；`answer` 才收到问题；独立 verifier 只使用冻结答案。外部 driver 也不得从别处获取 holdout 答案或让 proposer 裁判自己的结果。
- family 包含同一来源的副本、导出、修订、系统派生摘要；跨 calibration/holdout 重叠拒绝。冻结数据、来源、oracle、模型/工具/prompt/schema/权限快照、时刻、seed、topK、token、cache 的 hash 一并记录。
- 失败、unknown、abstain 不删除；报告覆盖率、answered precision、全体样本成功率，保留配对分母。配对复用已有按 capability 分层 bootstrap 数学，只输出诊断数值/最差子类/CI，不输出 GMS/PMS/release passed。
- 实际 context 为 null 时保真/注入覆盖不足，不以仅 candidates 代替 context。成本 null 是未知，不是 0；batch 的预留 token 不能冒充实际消耗。写后 canonical 与 context 传播延迟分别报告，未发生内容 apply 时保持 null。

## 离线可执行

在仓库根目录运行，输出目录必须明确且 `report.json` 不得已存在：

```bash
npx vitest run tests/contract/memory-evolution-rollout-sources.test.ts tests/eval/evolution/
npx tsx tests/eval/evolution/cli.ts --synthetic --output "$PWD/tests/eval/evolution/results/synthetic-smoke"
```

内置 8 例全部合成。component driver 实际使用 batch service、内存 proposal repository、生产 proposer/validator，模型仅使用受控 completion 传输；B 的确定性补证据/不变分类没有 LLM。其 input port 和 baseline reader 是替身，没有默认 RuntimeHost、真实 PG、真实 context、真实 embedding 或内容 apply。C 在无作者证明时留 review，不能把这组 0 提升当成模型效果证据。

错误注入中的模型失败经过受控 transport，预算经过 batch；embedding mismatch 是显式模拟阻断，绝非生产 embedding-space 验收。具体生产边界由新 contract/live 用例独立证明。

## 主 Agent 隔离环境

`--dataset`/`--adapter` 模式还要求明确的 live opt-in、绝对 config/env 路径、disposable 标记、loopback，拒绝默认全局 config/env 及其符号链接。端口任意显式合法端口，无临时任务路径依赖。adapter 必须导出 `createDiagnosticFactory({configPath,envPath})`，返回 `types.ts` 的真实隔离 PG factory；runner 不自行创建假 factory 或宣称 WeakMap 所有权。

```bash
MENGSHU_RUN_LIVE_TESTS=1 MENGSHU_EVOLUTION_REAL_MODEL=1 MENGSHU_EVOLUTION_ISOLATED_DB=1 \
MENGSHU_CONFIG=/absolute/disposable/config.json MENGSHU_ENV=/absolute/disposable/verification.env \
npx tsx tests/eval/evolution/cli.ts \
  --dataset /absolute/frozen/diagnostic.json \
  --adapter /absolute/owner-reviewed-runtime-driver.ts \
  --output /absolute/new-diagnostic-output
```

`native-driver.ts` 已实现 bounded create-only adapter：每个 arm/case 创建真实隔离 schema、默认 RuntimeHost、实际 global proposer、默认治理和 owner review 控制面；不是测试 writer/kernel。它只接受空 baseline、单条合成来源，其他 correction/history/fault 数据显式拒绝。A 保留空 baseline；B 没有获授权的确定性 create，明确 no-op；C 真正 propose 后再经过 auto 或独立 owner review。这个小样不能代表完整 maintenance/history 的效果。

先用主 Agent 的显式配置冻结合成 pilot，输出父目录必须存在，不能覆盖已有文件：

```bash
MENGSHU_EVOLUTION_ISOLATED_DB=1 \
MENGSHU_CONFIG=/absolute/disposable/config.json MENGSHU_ENV=/absolute/disposable/verification.env \
npx tsx tests/eval/evolution/write-native-pilot.ts --output /absolute/new-native-pilot.json

MENGSHU_RUN_LIVE_TESTS=1 MENGSHU_EVOLUTION_REAL_MODEL=1 MENGSHU_EVOLUTION_ISOLATED_DB=1 \
MENGSHU_CONFIG=/absolute/disposable/config.json MENGSHU_ENV=/absolute/disposable/verification.env \
npx tsx tests/eval/evolution/cli.ts --dataset /absolute/new-native-pilot.json \
  --adapter "$PWD/tests/eval/evolution/native-driver.ts" --governance auto --output /absolute/new-native-auto
```

freeze 工具不连接数据库/模型；模型、配置、价格或 prompt 更换后应新冻结，不能复用旧 fingerprint。native fixture 使用同一个纯配置构造器进行冻结和实际启动；serialized HostAuthority 只包含 tenant/user/allow，九维坐标由真实 host/defaultScope 保持。

reviewed 运行需 operator adapter 导出 `createDiagnosticFactory()`，返回 `createNativeRuntimeDiagnosticFactory({ reviewPolicy: { id, decide: async ({sourceText, review}) => "approve" | "reject" } })`。`decide` 必须是独立 source/diff-only owner 决策，不从 oracle、question、verifier 或 expected score 决定。默认 adapter 没有该策略时保持 blocked；更不能把 approval 当历史作者 attestation。

默认 RuntimeHost 正向 current/raw/receipt 由真实运行结果证明；lookup-only 和 context 拒绝单独报告。该 bounded pilot 的 `injected` 仍为 null，不能宣称 attested active/context、有限自动 correction、缓存撤销或实际目标 Skill 效果通过。schema/session 最后都释放，三个组不能共享 C 修改过的数据。

2026-09-06 的两个实际 component CLI 报告在 `results/synthetic-auto-20260906/` 和 `results/synthetic-reviewed-20260906/`：均为合成诊断，A/B/C 全体成功 7/8、无提升、保留一例 stale/fidelity 错误、gate blocked。原生真实模型/PG 由主 Agent 运行；当前工程结果和未通过边界以 `work/tasks/memory-evolution-rollout/acceptance/result.md` 为准。真实历史自进化、部署及为补数据而进行的模型试验已暂停。

## 正式 G/P

- `npm run eval:g0:round1` / `npm run eval:g0:round2` 当前读取固定 `~/.mengshu/eval-datasets/public/frozen/g0-v1`，没有输入目录开关，只有 `--output`。引擎仅 offline retrieval diagnostic，不能得到正式 QA 效果，禁止在本子任务运行或改 HOME 伪造隔离。
- 注册文件 `tests/eval/public/registry.json` 固定了 LongMemEval、MemoryAgentBench 等数据/scorer 的 revision/hash。现有 retrieval/answer bridge 和 fixture 测试不是已运行完整官方 scorer 的证据。
- P 数据 metadata 当前为 `collecting`、0/500、fresh 0/150。若主 Agent 已持有独立标注/脱敏/授权的完整 case 文件，可用显式命令构建校验：`npx tsx tests/eval/private/tools/build-private-v1.ts --cases /absolute/authorized-cases.jsonl --output /absolute/private-frozen`。该工具是构建/完整性检查，不是 P 效果 runner；本子任务未读取真实 case。
- 正式效果仍需 baseline/candidate 原生快照、独立官方 scorer/答案、P 配额和双人标注 kappa >= 0.85、P-FRESH >= 150、Q 及完整发布门。合成小样、替身 transport 和诊断 CI 不能替代正式 G/P/P-FRESH。
