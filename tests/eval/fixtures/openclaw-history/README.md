# OpenClaw History Fixtures

本目录包含脱敏后的 OpenClaw 历史数据 fixture，用于 mengshu-openclaw-history 评估套件。

## 数据治理

- 所有 fixture 已通过 `packages/core/src/ingest/agent-history/redaction.ts` 脱敏
- 脱敏版本: `REDACTION_MAP_VERSION`（见文件头部 frontmatter）
- 原始数据不入仓，仅保留在本机 `~/.mengshu/eval-corpus/openclaw/raw/`

## Snippet 列表

（阶段 0 占位，阶段 1 补 8 个 snippet）

1. openclaw-agent-self-improvement.md
2. openclaw-novel-handoff.md
3. openclaw-skill-noise.md
4. openclaw-matrix-collaboration.md
5. openclaw-stale-task-handoff.md
6. openclaw-config-update-evidence.md
7. openclaw-failure-correction.md
8. openclaw-claim-evidence.md

## 注意事项

- fixture 入仓后 version-frozen，不得原地编辑
- evidence span charStart/charEnd 以脱敏后文本为基准
- 标注完成后偏移漂移需要「重生成 + bump 版本号」而非原地编辑

