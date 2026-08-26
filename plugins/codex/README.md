# Mengshu Memory Codex Plugin

Codex 插件名为 `mengshu-memory`，通过 MCP 使用 `ms mcp` 暴露的记忆工具。

插件包使用与当前 npm 包同版本的固定 runtime：

- `.codex-plugin/plugin.json` 声明 Codex 插件元数据。
- `.mcp.json` 注册 `mengshu` MCP server。
- `mcp/server.mjs` 默认通过 release marketplace 内的
  `runtime/node_modules/@mengshu/core/dist/bin/ms.js` 启动 MCP，不读取 PATH 中的全局 `ms`。
- `skills/mengshu-memory/SKILL.md` 定义 Codex 侧记忆使用策略。

项目级 Codex 技能放在 `.agents/skills/`：

- `.agents/skills/update-doc/SKILL.md` 复用项目 `.claude` 的文档路由入口，供 Codex 更新内部/对外文档。

运行前应先用当前发布包的 `ms doctor` 验证配置。Codex 通过 `~/.mengshu/config.json` 复用 OpenClaw 配置的 PostgreSQL 后端；`~/.mengshu` 只保存全局配置和运行时元数据。开发或隔离测试可通过 `MENGSHU_CODEX_MS_PATH` 显式指定绝对可执行文件，launcher 会在启动 MCP 前校验其版本与插件一致：

```text
~/.mengshu
```

先生成主 npm tarball，再用 `npm run pack:codex -- --package <tarball> --out <directory>`
组装可安装的 Codex marketplace。组装器会把同版本 `@mengshu/core` 及其生产依赖安装到插件目录；
缺失或版本不一致时 launcher fail-closed，不回退到 PATH。
