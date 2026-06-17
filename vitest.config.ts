/**
 * Vitest 全局配置。
 *
 * 本文件做什么：
 *   - 显式声明 vitest 测试发现规则（include / exclude），避免 eval/ 黄金集 runner
 *     被纳入单元测试范围。
 *   - 配置 v8 coverage provider，给出 v0.1 release gate 需要的覆盖率门槛。
 *   - 保持 globals = false（与现有显式 import 风格一致），不在测试文件里隐式注入
 *     describe/it/expect 等全局，免得破坏现有 232 条测试的命名解析。
 *
 * 核心流程：
 *   - test.include 沿用项目约定（**\/*.test.ts）。
 *   - test.exclude 在默认基础上叠加 eval/** 与 node_modules/dist 等。
 *   - coverage.thresholds 按 plan §11 定义：lines/functions/statements 80%、branches 70%。
 *
 * 关键边界：
 *   - 不修改 tsconfig 的 include 规则，让 tsc 仍然检查 eval/ 目录的类型；
 *     但 vitest 不在 eval/ 下找单元测试，eval/ 自己的测试以 *.test.ts 出现在
 *     eval/runners/ 下并被显式纳入（match 默认 include）。
 *   - 不强制开启 coverage（CLI --coverage 才启用），避免拖慢日常 npm test。
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    include: ["**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.{idea,git,cache,output,temp}/**",
      "eval/results/**",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: [
        "core/**/*.ts",
        "lifecycle/**/*.ts",
        "retrieval/**/*.ts",
        "storage/**/*.ts",
        "ingest/**/*.ts",
        "api/**/*.ts",
        "adapters/**/*.ts",
        "server/**/*.ts",
        "sdk/**/*.ts",
        "graph/**/*.ts",
        "tree/**/*.ts",
        "config/**/*.ts",
        "routing/**/*.ts",
        "migration/**/*.ts",
      ],
      exclude: [
        "**/*.test.ts",
        "**/*.d.ts",
        "**/types.ts",
        "eval/**",
        "testing/**",
        "node_modules/**",
        "dist/**",
        "console/web/**",
      ],
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 70,
      },
    },
  },
});
