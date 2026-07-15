/**
 * ms maintain 命令 - 数据维护工具
 *
 * 提供后台维护任务：
 * - calculate-centrality: 计算 entity 的 graphCentrality
 */

import {
  requireOpenClawCliAuthority,
  resolveOpenClawCliScope,
  type CommanderLike,
  type OpenClawCliAuthorityContext,
} from "./index.js";
import type { CentralityCalculator } from "../../../../graph/centrality-calculator.js";
import type { MemoryScope } from "../../../../core/types.js";

export interface MaintainCliDeps extends OpenClawCliAuthorityContext {
  centralityCalculator: CentralityCalculator;
  getDefaultScope?: () => MemoryScope;
}

export function registerMaintainCommands(
  parent: CommanderLike,
  deps: MaintainCliDeps,
): void {
  const serverScope = requireOpenClawCliAuthority(deps);
  const maintain = parent
    .command("maintain")
    .description("数据维护工具（后台任务）");

  maintain
    .command("calculate-centrality")
    .description("计算 entity 的 graphCentrality（按 degree 归一化）")
    .option("--scope <scope>", "指定 scope (JSON 格式)")
    .action(async (...args: unknown[]) => {
      const options = args[0] as { scope?: string };
      let scope: MemoryScope;
      if (options.scope) {
        const requested = JSON.parse(options.scope) as Record<string, unknown>;
        scope = resolveOpenClawCliScope(deps, requested);
      } else {
        scope = serverScope;
      }

      console.log("🔄 开始计算 graphCentrality...");
      console.log(`   Scope: ${JSON.stringify(scope, null, 2)}`);

      await deps.centralityCalculator.calculateCentrality(scope);

      console.log("✅ graphCentrality 计算完成");
    });

  maintain
    .command("info")
    .description("显示维护任务说明")
    .action(() => {
      console.log(`
📋 数据维护任务

1. calculate-centrality
   功能：计算 entity 的图中心性（graphCentrality）
   算法：degree / max(degree_in_scope)
   触发时机：
     - 手动触发（当前命令）
     - seal 后自动触发（未来）
     - 后台定时任务（未来）

   使用示例：
   ms maintain calculate-centrality
   ms maintain calculate-centrality --scope '{"tenantId":"t1","appId":"a1",...}'

---

💡 提示：P2 阶段，graphCentrality 和 queryHits30d 是 hotness 评分的关键输入。
         定期运行 calculate-centrality 可以使 topic tree 创建更准确。
`);
    });
}
