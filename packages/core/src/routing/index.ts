/**
 * 路由模块
 *
 * 提供知识库路由规则引擎
 */

export {
  createRoutingEngine,
  RoutingEngine,
  type RoutingResult,
} from "./rules.js";

export type { RoutingRule } from "../db/types.js";
