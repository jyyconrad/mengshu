# 多产品插件化实施方案

> 日期：2026-06-18
> 范围：把 mengshu / memory-autodb 从“单仓库多适配器”升级为“核心能力包 + 多产品插件包”。首期产品：OpenClaw、Codex。
> 相关：整体仓库目录与包结构见 [项目目录层级与包结构重构方案](project-structure-refactor-plan.md)。

## 背景与判断

当前项目已经有 `adapters/openclaw`、`adapters/mcp`、`adapters/rest`、`adapters/sdk` 等适配层，也已经能通过 `ms mcp` 接入 Codex / Claude Code。但这仍是“核心包附带适配入口”的形态，不是每个 Agent 产品可独立安装、升级、禁用、发布的插件形态。

OpenClaw 的 memory 能力是插件 slot 机制：`kind: "memory"` 的插件只有被 `plugins.slots.memory` 选中时，才会替代默认 `memory-core`。Codex 的插件形态则是 `.codex-plugin/plugin.json` + 可选 `skills/`、`.mcp.json`、app/hook/assets，并通过 marketplace 暴露安装。两者的插件契约不同，不能继续共用根目录的 `package.json`、`index.ts` 和一个插件 id。

因此，本次改造目标不是简单移动文件，而是建立一个长期可扩展的插件包层：核心能力保持产品无关，产品插件只做宿主契约适配。

## 当前问题

1. 根包 `@mengshu/core` 同时承担核心库、CLI、OpenClaw 插件入口和 MCP 入口，发布身份混杂。
2. 根目录 `index.ts` 和 `openclaw.plugin.json` 声明的插件 id 是 `mengshu`，但现有 OpenClaw 配置使用 `memory-autodb`，会导致 `plugins.slots.memory: plugin not found`。
3. `adapters/openclaw` 注册了 tools / CLI / hooks / service，但还没有完整接入 OpenClaw 的 `registerMemoryRuntime`、`registerMemoryPromptSection`、`registerMemoryFlushPlan` 等 memory slot 深层接口。
4. Codex 当前依赖全局 `~/.codex/config.toml` 直接配置 MCP server，尚未形成可安装的 Codex 插件包。
5. 没有 `plugins/` 目录，无法容纳开源/闭源 Agent 产品的独立插件包、清晰 manifest、安装说明和验收用例。

## 目标架构

```text
memory-autodb/
├── packages/
│   ├── core/src/                 # 产品无关领域能力
│   │   ├── domain/
│   │   ├── scoring/
│   │   ├── runtime/
│   │   ├── lifecycle/
│   │   ├── retrieval/
│   │   ├── graph/
│   │   ├── tree/
│   │   ├── ingest/
│   │   ├── db/
│   │   └── storage/
│   ├── mcp/src/                  # MCP 协议包
│   ├── api/src/                  # REST / SDK / CLI / fast path
│   └── ui/src/                   # Console API + Web Console
├── adapters/                     # 旧路径兼容层，逐步 deprecated
├── bin/                          # ms CLI
├── plugins/
│   ├── openclaw/
│   │   ├── package.json
│   │   ├── openclaw.plugin.json
│   │   ├── src/index.ts
│   │   ├── src/runtime.ts
│   │   ├── src/tools.ts
│   │   ├── src/hooks.ts
│   │   ├── src/cli.ts
│   │   └── README.md
│   └── codex/
│       ├── .codex-plugin/plugin.json
│       ├── .mcp.json
│       ├── mcp/server.mjs
│       ├── skills/mengshu-memory/SKILL.md
│       ├── assets/
│       └── README.md
├── .agents/plugins/marketplace.json
└── docs/
```

根 `core/`、`processing/`、`lifecycle/`、`retrieval/`、`graph/`、`tree/`、`ingest/`、`scanner/`、`db/`、`storage/`、`adapters/*` 等旧路径当前只保留 re-export 兼容层。

### 包边界

| 层 | 包/目录 | 职责 | 禁止事项 |
|---|---|---|---|
| 核心 | `packages/core/src`（根包 `@mengshu/core` 出口） | 记忆领域模型、评分、存储、召回、ingest、lifecycle、graph、tree | 不直接依赖 OpenClaw / Codex UI 契约 |
| OpenClaw 插件 | `plugins/openclaw` | OpenClaw plugin manifest、memory slot、tools、hooks、CLI、service、runtime bridge | 不复制核心算法，不保存独立数据库逻辑 |
| Codex 插件 | `plugins/codex` | Codex plugin manifest、MCP server 打包、skills、marketplace | 不依赖用户手工改 `~/.codex/config.toml` 才可用 |
| 通用协议 | `packages/mcp/src`、`packages/api/src/rest`、`packages/api/src/sdk` | 被插件包复用的协议适配 | 不承担具体产品安装形态 |
| 兼容层 | `adapters/*`、根层历史目录 | 旧 deep import re-export | 不新增业务逻辑 |

## 命名策略

OpenClaw 插件使用 `mengshu-openclaw` 作为稳定 id。它表达的是“mengshu 在 OpenClaw 宿主中的插件形态”，避免继续把仓库历史名 `memory-autodb` 当作产品插件身份。为了兼容已安装环境，`memory-autodb` 和更早的 `mengshu` 都保留为 legacy alias：

```json
{
  "id": "mengshu-openclaw",
  "legacyPluginIds": ["memory-autodb", "mengshu"],
  "kind": "memory"
}
```

迁移方式：

```bash
ms migrate-openclaw-plugin-id          # 预览 ~/.openclaw/conf/plugins.json 改动
ms migrate-openclaw-plugin-id --execute
```

该命令会把 `plugins.slots.memory` 改为 `mengshu-openclaw`，并把旧 `entries["memory-autodb"]` 或 `entries["mengshu"]` 的配置复制到 `entries["mengshu-openclaw"]`。默认保留旧 entry 但置为 disabled，便于回滚和审计。

Codex 插件建议命名为 `mengshu-memory`。原因是 Codex 侧不是替换某个内置 memory slot，而是向 Codex 提供 mengshu 的 MCP 工具和记忆使用技能；名称应表达产品能力而非 OpenClaw 插件历史名。

根包继续使用 `@mengshu/core`。如果后续发布到 npm，可拆成：

- `@mengshu/core`
- `@mengshu/cli`
- `@mengshu/plugin-openclaw`
- `@mengshu/plugin-codex`

首期可以先保持单仓单 package 开发，用目录包隔离运行入口，待构建链路稳定后再做 workspace 化。

## OpenClaw 插件设计

### 插件目录

```text
plugins/openclaw/
├── package.json
├── openclaw.plugin.json
├── src/index.ts
├── src/register.ts
├── src/memory-runtime.ts
├── src/tools.ts
├── src/hooks.ts
├── src/cli.ts
└── README.md
```

### Manifest 要点

```json
{
  "id": "mengshu-openclaw",
  "legacyPluginIds": ["memory-autodb", "mengshu"],
  "kind": "memory",
  "name": "Mengshu OpenClaw",
  "description": "mengshu local-first memory middleware for OpenClaw",
  "configSchema": {}
}
```

实际 `configSchema` 继续来自 `memoryConfigSchema` 或生成后的 JSON schema；`uiHints` 保留在插件包内。

### 接入层级

首期分两层验收：

1. Slot 接管层：插件被 OpenClaw 发现，`plugins.slots.memory = "mengshu-openclaw"` 后，`openclaw plugins list/doctor` 不报错，默认 `memory-core` 不再作为 memory slot owner；旧配置可通过 `legacyPluginIds` 和 `ms migrate-openclaw-plugin-id` 迁移。
2. Runtime 兼容层：除现有 tools / hooks / service 外，补齐 OpenClaw memory runtime：
   - `api.registerMemoryRuntime`
   - `api.registerMemoryPromptSection`
   - `api.registerMemoryFlushPlan`

### 现有能力迁移

| 当前文件 | 目标 |
|---|---|
| `index.ts` | 已移到 `plugins/openclaw/src/index.ts`，根目录保留兼容 re-export |
| `openclaw.plugin.json` | 移到 `plugins/openclaw/openclaw.plugin.json`，根目录保留兼容副本或软迁移 |
| `adapters/openclaw/index.ts` | 已迁到 `plugins/openclaw/src/register.ts` |
| `adapters/openclaw/tools.ts` | 已迁到 `plugins/openclaw/src/tools.ts` |
| `adapters/openclaw/hooks.ts` | 已迁到 `plugins/openclaw/src/hooks.ts` |
| `adapters/openclaw/context-fast.ts` | 已迁到 `plugins/openclaw/src/context-fast.ts` |
| `adapters/openclaw/scope.ts` | 已迁到 `plugins/openclaw/src/scope.ts` |
| `adapters/openclaw/manifest.ts` | 已迁到 `plugins/openclaw/src/manifest.ts` |
| `adapters/openclaw/cli-*.ts` | 已迁到 `plugins/openclaw/src/cli/`，旧路径保留兼容 re-export |

迁移时避免一次性删除 `adapters/openclaw`。已完成的模块由旧路径 re-export 新实现；当前 OpenClaw 插件入口、tools、hooks、context-fast、scope、manifest 和 CLI 注册均已收敛到插件包内。

### OpenClaw 配置目标

```json
{
  "plugins": {
    "load": {
      "paths": ["./plugins/openclaw"]
    },
    "slots": {
      "memory": "mengshu-openclaw"
    },
    "entries": {
      "mengshu-openclaw": {
        "enabled": true,
        "config": {
          "dbType": "postgres",
          "postgres": {
            "host": "${PG_HOST}",
            "port": 5432,
            "database": "${PG_DATABASE}",
            "user": "${PG_USER}",
            "password": "${PG_PASSWORD}",
            "ssl": false
          },
          "autoCapture": true,
          "autoRecall": true
        }
      }
    }
  }
}
```

用户环境中可以继续使用绝对路径；仓库示例应使用相对路径或安装路径，不写入真实密钥。

## Codex 插件设计

### 插件目录

```text
plugins/codex/
├── .codex-plugin/plugin.json
├── .mcp.json
├── mcp/server.mjs
├── skills/mengshu-memory/SKILL.md
├── assets/logo.png
├── assets/composer-icon.png
└── README.md
```

### `.codex-plugin/plugin.json`

```json
{
  "name": "mengshu-memory",
  "version": "0.1.0",
  "description": "Use mengshu memory from Codex through MCP and task workflows.",
  "author": {
    "name": "mengshu",
    "email": "support@example.com",
    "url": "https://github.com/jyyconrad/mengshu"
  },
  "homepage": "https://github.com/jyyconrad/mengshu",
  "repository": "https://github.com/jyyconrad/mengshu",
  "license": "MIT",
  "keywords": ["memory", "mcp", "codex", "agent"],
  "skills": "./skills/",
  "mcpServers": "./.mcp.json",
  "interface": {
    "displayName": "Mengshu Memory",
    "shortDescription": "Recall and save long-term agent memory",
    "longDescription": "Connect Codex to mengshu / memory-autodb through MCP, with skills for recalling project context, saving stable decisions, and managing memory hygiene.",
    "developerName": "mengshu",
    "category": "Developer Tools",
    "capabilities": ["Read", "Write"],
    "defaultPrompt": [
      "Recall project memory before changing this code",
      "Save this architecture decision to memory",
      "Check why this memory was recalled"
    ],
    "brandColor": "#2563EB"
  }
}
```

### `.mcp.json`

首期推荐插件自带 MCP 启动器，避免要求用户手动配置全局 `~/.codex/config.toml`：

```json
{
  "mcpServers": {
    "mengshu": {
      "cwd": ".",
      "command": "node",
      "args": ["./mcp/server.mjs"],
      "env": {
        "MENGSHU_HOME": "${MENGSHU_HOME}"
      }
    }
  }
}
```

`mcp/server.mjs` 有两种实现选项：

1. 开发期：调用全局 `ms mcp`，简单但依赖用户已安装 CLI。
2. 发布期：直接 import `@mengshu/core` 的 MCP 启动器，自包含更好。

首期建议先实现开发期启动器，并在 README 标注依赖；第二阶段改为自包含启动器。

### Skill 设计

`skills/mengshu-memory/SKILL.md` 应只写 Codex 使用策略，不复制算法文档。核心内容：

- 何时先 recall：项目偏好、稳定约束、架构决策、历史踩坑。
- 何时 save：长期有效、已验证、可复用的结论。
- 何时 forget/why：冲突、过期、来源不明、召回异常。
- 工具名以 MCP 实际暴露为准：`memory_recall`、`memory_save`、`memory_lookup`、`memory_context_fast`、`memory_forget`、`memory_health`。

### Marketplace

仓库级 marketplace 放在：

```text
.agents/plugins/marketplace.json
```

示例：

```json
{
  "name": "mengshu-local",
  "interface": {
    "displayName": "Mengshu Local"
  },
  "plugins": [
    {
      "name": "mengshu-memory",
      "source": {
        "source": "local",
        "path": "./plugins/codex"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Developer Tools"
    }
  ]
}
```

## 配置与数据目录策略

统一以 `~/.mengshu` 作为 mengshu 全局 home：

- `~/.mengshu/config.json`
- `~/.mengshu/.env`
- PostgreSQL 由 `~/.mengshu/config.json` 中的 `postgres` 配置指向 OpenClaw 同一个库
- `~/.mengshu/memory/lancedb` 仅作为显式 `dbType=lancedb` 或旧数据迁移来源
- `~/.mengshu/projects/<projectId>/manifest.json`

OpenClaw 旧路径 `~/.openclaw/memory/lancedb` 只作为兼容读取，不再作为新文档默认路径。迁移工具继续使用 `ms migrate-home`。

各产品插件可以覆盖 `MENGSHU_HOME`，但不得私自创建产品专属数据库目录，除非用户明确配置。

## 实施阶段

### P0：插件目录与身份修正

目标：先解决“插件形态”和 OpenClaw id 不一致。

任务：

1. 新建 `plugins/openclaw`，复制/包装根 OpenClaw 入口。
2. 将 OpenClaw 插件 id 统一为 `mengshu-openclaw`，加入 `legacyPluginIds: ["memory-autodb", "mengshu"]`。
3. 根目录 `index.ts`、`openclaw.plugin.json` 保留兼容入口，但标注 deprecated。
4. 更新 OpenClaw 安装文档，示例使用 `plugins.slots.memory = "mengshu-openclaw"`。
5. 增加测试覆盖插件 manifest、id、kind、slot 选择和 id 迁移命令。

验收：

```bash
openclaw plugins list --json
openclaw plugins doctor
openclaw config validate
```

预期：无 `plugin not found: mengshu-openclaw`，`mengshu-openclaw` 状态为 loaded / activated；旧 `memory-autodb` / `mengshu` 配置可迁移或通过 legacy alias 识别。

### P1：OpenClaw memory runtime 深度接管

目标：不只是工具和 hook 可用，而是完整替代 OpenClaw memory slot。

任务：

1. 增加 `plugins/openclaw/src/memory-runtime.ts`。
2. 实现 `api.registerMemoryRuntime`，提供：
   - `getMemorySearchManager`
   - `resolveMemoryBackendConfig`
   - `closeAllMemorySearchManagers`
3. 实现 `api.registerMemoryPromptSection`，用 mengshu 召回结果生成 OpenClaw prompt section。
4. 实现 `api.registerMemoryFlushPlan`，将 OpenClaw compaction/memory flush 引导到 mengshu 或兼容文件策略。
5. 增加 `probeEmbeddingAvailability`、`probeVectorAvailability` 的真实健康检查。

验收：

```bash
openclaw status --json
openclaw doctor
openclaw agent --message "..." --no-deliver
```

预期：OpenClaw 状态扫描能通过 mengshu memory runtime 查询健康；agent 启动前可注入 mengshu 召回上下文。

### P2：Codex 插件包

目标：Codex 不再要求用户手写 `~/.codex/config.toml`，而是通过插件安装获得 skill + MCP。

任务：

1. [x] 新建 `plugins/codex/.codex-plugin/plugin.json`。
2. [x] 新建 `plugins/codex/.mcp.json`。
3. [x] 新建 `plugins/codex/mcp/server.mjs`。
4. [x] 新建 `plugins/codex/skills/mengshu-memory/SKILL.md`。
5. [x] 新建 `.agents/plugins/marketplace.json`。
6. [x] 增加 Codex 插件校验脚本或复用 `plugin-creator` 的 `validate_plugin.py`。
7. [ ] 发布期把 `plugins/codex/mcp/server.mjs` 从调用全局 `ms mcp` 改为自包含 MCP 启动器。

验收：

```bash
codex plugin marketplace add .
codex plugin add mengshu-memory@mengshu-local
```

新线程中应能看到插件技能，并通过 MCP handshake 返回 mengshu 工具列表。当前仓库 smoke 已覆盖 `plugins/codex/mcp/server.mjs` 启动后 `tools/list` 返回 `memory_recall`、`memory_save`、`memory_health`。

### P3：Workspace 化与发布

目标：把目录隔离升级为真实多包发布。

任务：

1. 引入 npm workspaces：
   - `packages/core`
   - `packages/cli`
   - `plugins/openclaw`
   - `plugins/codex`
2. 为每个插件生成 dist 包，消除运行时对 `tsx` 和源码路径的依赖。
3. 为 OpenClaw 插件补 `install.minHostVersion`。
4. 为 Codex 插件补 logo、截图、版本 cachebuster 流程。
5. 建立 release checklist。

验收：

```bash
npm test
npx tsc --noEmit
npm pack --workspaces
```

## 测试策略

| 类型 | 覆盖内容 |
|---|---|
| 单元测试 | runtime 创建、工具 handler、scope 映射、manifest id/kind |
| 集成测试 | OpenClaw plugin loader 发现 `plugins/openclaw` 并选中 memory slot |
| MCP smoke | Codex 插件 `.mcp.json` 启动后 `tools/list` 返回预期工具 |
| CLI smoke | `ms doctor`、`ms recall --explain`、`ms mcp` |
| 配置测试 | `~/.mengshu` 默认目录、旧 `~/.openclaw` 兼容回退、环境变量展开 |
| 回归评估 | 修改评分/召回/prompt 后跑 `npm run eval:quick`，重大算法变化跑全量 golden set |

## 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| OpenClaw id 迁移破坏旧配置 | 插件无法加载 | `legacyPluginIds` + 迁移命令 + 文档明确 |
| Codex 插件依赖全局 `ms` | 新用户安装后 MCP 启动失败 | P2 先提示依赖，P3 改为自包含启动器 |
| 多包引入重复依赖 | 包体大、版本漂移 | 核心依赖集中在 `@mengshu/core`，插件包只声明 peer/workspace 依赖 |
| memory runtime 语义不完全匹配 | OpenClaw status/doctor 与 agent 注入不一致 | P1 单独补 runtime adapter，不把 tools/hook 当作完整接管 |
| 敏感配置泄露 | API key / DB 密码进入示例 | 示例只使用环境变量，不提交真实用户配置 |
| 目录一次性迁移过大 | 回归面大 | P0 仅包装旧实现，P1/P2 分阶段迁移 |

## 决策记录

1. `plugins/` 是产品插件包目录，不放核心算法。
2. `adapters/` 保留为协议和兼容层，逐步减少产品专属实现。
3. OpenClaw 插件 id 使用 `mengshu-openclaw`，兼容旧 id `memory-autodb` 和 `mengshu`。
4. Codex 插件名使用 `mengshu-memory`，通过 MCP 和 skill 集成。
5. `~/.mengshu` 是新默认全局 home；`~/.openclaw` 只做兼容回退。
6. 首期先完成目录与安装形态，再补深层 runtime，再做 workspace 化。

## 首期交付清单

- [x] `plugins/openclaw` 目录可被 OpenClaw 插件发现
- [x] OpenClaw `mengshu-openclaw` id 与 slot 配置一致
- [x] OpenClaw 插件保留现有 tools / hooks / CLI / service
- [x] OpenClaw memory runtime bridge 有最小可用实现
- [x] `plugins/codex` 目录符合 Codex plugin manifest
- [x] Codex MCP 插件能启动并列出 mengshu 工具
- [x] `.agents/plugins/marketplace.json` 可用于本地安装
- [x] 文档更新：README、architecture、integration、configuration
- [x] smoke/contract 验证覆盖 OpenClaw / Codex 两条路径

当前实现边界：

- OpenClaw canonical 入口为 `plugins/openclaw/src/index.ts`，根 `index.ts` 仅作为兼容 re-export。
- OpenClaw 注册主实现已迁到 `plugins/openclaw/src/register.ts`，tools / hooks / `memory_context_fast` handler、scope、manifest 和 CLI 注册模块已迁到 `plugins/openclaw/src`；`adapters/openclaw/index.ts`、`tools.ts`、`hooks.ts`、`context-fast.ts`、`scope.ts`、`manifest.ts`、`cli-*.ts` 仅作为兼容 re-export。
- OpenClaw manifest 的 canonical id 已切换为 `mengshu-openclaw`，并通过 `legacyPluginIds: ["memory-autodb", "mengshu"]` 兼容旧配置。
- OpenClaw memory runtime bridge 已注册 prompt section / flush plan / runtime health manager；实际记忆召回和写入复用插件包内 tools、hooks、CLI、service。
- Codex 插件包已包含 `.codex-plugin/plugin.json`、`.mcp.json`、`mcp/server.mjs`、skill 和仓库级 marketplace；`mcp/server.mjs` 首期调用全局 `ms mcp`，自包含 MCP 启动器留到下一阶段。
