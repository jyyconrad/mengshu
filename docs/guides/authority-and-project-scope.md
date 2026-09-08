# 项目身份与运行时 Authority

Mengshu 把“这是哪个项目”和“当前 Agent 有权访问什么”分成两个边界。`ms init`
只建立本地项目身份，不要求 OpenClaw，也不连接数据库；Agent 产品在启动 Runtime、MCP
或 REST 服务时再提供自己的可信 authority。

## 两类信息

| 信息 | 所有者 | 保存位置 | 何时需要 |
|------|--------|----------|----------|
| `workspaceId/projectId` | Project Memory Workspace | 项目 `.mengshu.json` 与 `~/.mengshu/projects/` | `ms init` |
| `tenantId/userId/appId/agentId/namespace` | Agent 产品的可信运行时 | 产品配置或 `authority.json` | recall、write、MCP、REST |

项目目录不能声明 `tenantId/userId`。工具参数和消息正文也不能扩大 authority。

## 初始化项目

```bash
cd /path/to/project
ms init
ms project status
```

默认情况下，Mengshu 用规范化绝对目录派生稳定的 `projectId`，用父目录派生
`workspaceId`。Agent 产品也可以通过项目初始化 resolver，或在调用 CLI 时显式提供：

```bash
ms init /path/to/project \
  --workspace-id workspace-acme \
  --project-id project-api \
  --visibility private
```

最终标识必须匹配 `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`，不能包含路径分隔符。
已有 manifest 默认保持原 identity；只有显式 `--force` 才会覆盖。

`ms init` 不会扫描目录、不写入记忆库，也不会创建或扩大运行时 authority。

## 通用 MCP/REST Authority

直接运行 `ms mcp`、`ms serve`，或使用 Codex 插件时，需要一个由本机操作者或
Agent 产品生成的 authority 配置。示例：

```json
{
  "authority": {
    "tenantId": "local",
    "userId": "owner",
    "allow": {
      "appIds": ["codex"],
      "projectIds": ["project-api"],
      "agentIds": ["codex"],
      "namespaces": ["working-context"],
      "visibilities": ["private"]
    }
  },
  "defaultScope": {
    "tenantId": "local",
    "userId": "owner",
    "appId": "codex",
    "projectId": "project-api",
    "agentId": "codex",
    "namespace": "working-context",
    "visibility": "private"
  }
}
```

保存为 `~/.mengshu/authority.json` 后限制权限：

```bash
chmod 600 ~/.mengshu/authority.json
export MENGSHU_AUTHORITY_FILE="$HOME/.mengshu/authority.json"
```

也可以由进程 supervisor 设置 `MENGSHU_AUTHORITY_JSON`。两个变量必须且只能提供一个。
文件路径必须是绝对路径、普通文件且权限为 `0600`。

`defaultScope` 必须完全落在 `authority.allow` 中。`tenantId/userId` 必须与 authority
一致；客户端只允许在 `appId/projectId/agentId/namespace/visibility` 的 allowlist 内收窄。

## 各产品如何接入

### Codex

Codex 插件默认把 `MENGSHU_AUTHORITY_FILE` 指向
`~/.mengshu/authority.json`。先在项目目录执行 `ms init`，再由 Codex 的可信配置选择与
该 manifest 对应的 `projectId`。Codex 不需要安装 OpenClaw。

### OpenClaw

OpenClaw 从插件配置中的 `authority/defaultAgentId` 和宿主提供的真实 Agent/session
上下文构造 scope。它可以调用同一个产品无关的项目初始化入口，但不能让消息或工具参数
替代宿主认证信息。

### 其他 Agent 或 MCP 客户端

产品应读取当前 Project Memory Workspace，确定 `workspaceId/projectId`，再用自己的登录
身份、产品 id 和 Agent id 构造 exact `defaultScope`。不要把 OpenClaw 的默认值复制到
无关产品，也不要从聊天文本推断身份。

## 常见错误

### `authenticated authority and defaultScope are required`

该错误只应出现在访问记忆库或启动服务时。若 `ms init` 出现此错误，说明使用的是旧版
CLI；升级到包含产品无关初始化修复的版本。

### `does not match defaultScope`

检查 `defaultScope` 每个维度是否属于对应 allowlist，并确认 tenant/user 完全一致。

### `client value is not allowed`

当前项目或 Agent 不在产品 authority 中。由产品操作者更新可信配置；不要通过客户端参数
绕过 allowlist。

## 相关文档

- [快速开始](getting-started.md)
- [配置说明](configuration.md)
- [集成指南](integration.md)
- [CLI 命令](../api/cli-commands.md)
