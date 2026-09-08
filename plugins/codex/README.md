# Mengshu Memory Codex Plugin

Codex 插件名为 `mengshu-memory`，通过 MCP 使用 `ms mcp` 暴露的记忆工具。
Codex 不依赖 OpenClaw；两者只是共享 Mengshu Project Memory Workspace 和后端的不同
Agent 产品。

插件包使用与当前 npm 包同版本的固定 runtime：

- `.codex-plugin/plugin.json` 声明 Codex 插件元数据。
- `.mcp.json` 注册 `mengshu` MCP server。
- `mcp/server.mjs` 默认通过 release marketplace 内的
  `runtime/node_modules/@mengshu/core/dist/bin/ms.js` 启动 MCP，不读取 PATH 中的全局 `ms`。
- `skills/mengshu-memory/SKILL.md` 定义 Codex 侧记忆使用策略。

插件在 `.mcp.json` 中显式使用 `MENGSHU_MCP_MODE=standalone`，因此不要求用户另行启动
`ms serve`。通用 `ms mcp` 未指定模式时仍默认连接共享 RuntimeHost；standalone 模式不取得
RuntimeHost durable worker ownership。

项目级 Codex 技能放在 `.agents/skills/`：

- `.agents/skills/update-doc/SKILL.md` 复用项目 `.claude` 的文档路由入口，供 Codex 更新内部/对外文档。

首次使用：

```bash
ms setup
cd /path/to/project
ms init
ms doctor
```

`ms init` 不要求 OpenClaw authority，只创建共享的 `workspaceId/projectId`。Codex MCP
默认读取 `~/.mengshu/authority.json`，其中 `defaultScope.projectId` 应与当前项目
`.mengshu.json` 对应。authority 格式、`0600` 权限和错误排查见
[项目身份与运行时 Authority](../../docs/guides/authority-and-project-scope.md)。

Codex 通过 `~/.mengshu/config.json` 使用 Mengshu 共享 PostgreSQL 后端；`~/.mengshu`
保存全局配置和运行时元数据。开发或隔离测试可通过 `MENGSHU_CODEX_MS_PATH` 显式指定
绝对可执行文件，launcher 会在启动 MCP 前校验其版本与插件一致：

```text
~/.mengshu
```

先生成主 npm tarball，再用 `npm run pack:codex -- --package <tarball> --out <directory>`
组装可安装的 Codex marketplace。组装器会把同版本 `@mengshu/core` 及其生产依赖安装到插件目录；
缺失或版本不一致时 launcher fail-closed，不回退到 PATH。
