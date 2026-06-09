# 目录扫描详细设计

本文描述 `memory_scan_directory` 和 `ltm scan` 的当前扫描链路。

## 入口

| 入口 | 参数 |
|------|------|
| OpenClaw 工具 `memory_scan_directory` | `directory`、`ignorePaths`、`ignoreRules`、`targetTable`、`autoEnrichMetadata` |
| CLI `ltm scan` | `<directory>`、`--ignore <paths...>`、`--category <name>` |

## 当前流程

```text
resolve directory
  -> merge defaultIgnorePaths / customIgnoreRules / call arguments
  -> file-system adapter scans Markdown files
  -> canonicalize content
  -> deterministic chunking
  -> dedupe by content hash
  -> store document/chunk baseline
  -> enqueue jobs
  -> return scan statistics
```

## 模块职责

| 文件 | 职责 |
|------|------|
| `adapters/openclaw/tools.ts` | 解析工具参数，调用扫描 handler |
| `ingest/adapters/file-system.ts` | 扫描文件系统并读取 Markdown |
| `ingest/canonicalize.ts` | 规范化 source content |
| `ingest/chunker.ts` | 切分为 deterministic chunks |
| `ingest/pipeline.ts` | 入库、去重、job enqueue 和审计 |
| `ingest/jobs.ts` | job 类型和状态 |

legacy `scanner/` 目录仍保留，用于兼容和旧能力参考；当前新扫描路径优先看 `ingest/`。

## 忽略规则

忽略规则来源按顺序合并：

1. `config.scanner.defaultIgnorePaths`
2. `config.scanner.customIgnoreRules`
3. 工具或 CLI 传入的 `ignorePaths` / `ignoreRules`

CLI 当前只暴露 `--ignore <paths...>`；更复杂的 gitignore 风格规则通过配置或工具参数传入。

## 输出统计

扫描返回两组信息：

| 字段 | 说明 |
|------|------|
| `totalFiles` | 发现的文件数 |
| `processedFiles` | 成功处理文件数 |
| `failedFiles` | 失败文件数 |
| `totalChunks` | 总 chunk 数 |
| `storedChunks` | 新存储 chunk 数 |
| `duplicateChunks` | 重复跳过数 |
| `jobsQueued` | 入队任务数 |
| `chunksAdmitted` | 进入 pipeline 的 chunk 数 |
| `chunksDropped` | pipeline 丢弃 chunk 数 |

## 元数据

`autoEnrichMetadata` 开启时，扫描会补充文件路径、目录、文件修改时间、来源等元数据。具体字段以 handler 和 ingestion adapter 的返回为准。

## 错误处理

| 场景 | 处理 |
|------|------|
| 目录不存在或不可读 | 返回失败 |
| 单文件读取失败 | 记录失败并继续处理其他文件 |
| 重复内容 | 跳过并计入 `duplicateChunks` |
| pipeline 拒绝 chunk | 计入 `chunksDropped` |
| 后台 job 失败 | 后续由 jobs/audit 链路追踪 |

## 已知边界

- 当前扫描重点是 Markdown 文件。
- 完整 embedding、实体抽取、tree seal 等重处理属于后续 warm/cold path。
- 持久化 schema 迁移和 replay 能力以 v4 schema 计划为准。
