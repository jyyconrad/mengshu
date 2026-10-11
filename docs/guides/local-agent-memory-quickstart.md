# 本地 Agent 记忆快路径（编码 / 工作）

面向：在 Codex / Claude Code / Cursor 等里用 mengshu 做**治理型**长期记忆。  
完整配置见 [configuration.md](./configuration.md)；用法契约见 [`.agents/skills/mengshu/SKILL.md`](../../.agents/skills/mengshu/SKILL.md)。

## 1. 一键 Postgres（推荐）

```bash
cd /path/to/mengshu
docker compose -f docker-compose.postgres.yml up -d
```

默认：`localhost:5432`，用户/库/密码均为 `mengshu`（可用 `MENGSHU_PG_*` 覆盖）。镜像：`pgvector/pgvector:pg16`。

## 2. 安装与配置

```bash
# 源码开发
npm install
npm run build

# 或按发布说明安装 @mengshu/core 后：
ms setup    # 选 postgres，填入上面的连接信息；密钥进 ~/.mengshu/.env
ms init     # 在项目根创建 workspace/project 指针（不碰库）
```

准备 authority（MCP/REST 需要）：

```bash
export MENGSHU_AUTHORITY_FILE="$HOME/.mengshu/authority.json"
# 文件权限建议 0600；格式见 authority-and-project-scope.md
ms doctor
```

## 3. 启动 MCP（默认工具门面）

```bash
# 默认：MENGSHU_MCP_TOOL_MODE=default（主工具集）
ms mcp

# 需要进化/资产/working_set 等完整 ListTools 时：
MENGSHU_MCP_TOOL_MODE=full ms mcp
```

主工具：`memory_context_fast`、`memory_recall`、`memory_save`、`memory_observe`、`memory_observe_light`、`memory_forget`、`memory_lookup`、`memory_explain`、`memory_tools_discover`、`memory_health`、`memory_namespaces`。

## 4. 安装用法 Skill

```bash
mkdir -p ~/.codex/skills   # 或其他 Agent 的 skills 根目录
ln -sfn /path/to/mengshu/.agents/skills/mengshu ~/.codex/skills/mengshu
```

Skill name：`mengshu`。Codex 插件包装：`plugins/codex/skills/mengshu-memory`（指向上述真源）。

## 5. Agent 最小闭环

1. `memory_context_fast` — 确认五槽 key 都在（空槽 `nodeCount=0` 正常）。  
2. 需要写入时带 `semanticType`（五选一）。  
3. 被拒时用 `memory_explain`（候选 dry-run 或已存 why），不要编造。

## 6. LanceDB-only：哪些治理 fail-closed

`dbType=lancedb`（或未具备对应 PostgreSQL capability）时，**兼容存取**仍可能可用，但下列能力应视为 **fail-closed / 不可宣称对等**：

| 能力 | 说明 |
|------|------|
| temporal memory 工具链 | 需 Postgres capability |
| session working set | 需 Postgres capability |
| skill artifacts | 需 Postgres capability |
| memory policy overlay | 需 Postgres capability |
| durable job / worker 治理 | RuntimeHost + PG 参考组合 |
| continuous memory evolution | 需 native PG capability；开关≠自动可用 |
| 部分 forget 事务语义 | 权威 forget 依赖事务 port；缺则工具不广告或失败 |

细节以 [configuration.md](./configuration.md) 的 `features.*` 与 architecture 为准。本地编码 Agent **默认请走本页 Postgres compose**。

## 7. 相关命令

```bash
ms recall "query" --explain
ms why <memoryId>
ms doctor
```

## 8. 会话钩子与 admission 收据

- 钩子推荐表：[agent-session-hooks.md](./agent-session-hooks.md)
- 写入后可用 `memory_explain({ lastDecision: true })` 查看最近一次 accept/reject 收据（Postgres v39+ 耐久；LanceDB 仅当前进程）。

