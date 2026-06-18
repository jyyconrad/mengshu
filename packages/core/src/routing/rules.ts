/**
 * 路由规则引擎
 *
 * 根据内容自动路由到对应的知识库表
 */

import type { RoutingRule, TableName } from "../db/types.js";
import { DEFAULT_ROUTING_RULES } from "../../../../config.js";

/**
 * 路由决策结果
 */
export interface RoutingResult {
  /** 目标表列表 */
  targetTables: TableName[];
  /** 匹配的规则 */
  matchedRules: RoutingRule[];
}

/**
 * 路由规则引擎类
 */
export class RoutingEngine {
  private rules: RoutingRule[];

  constructor(customRules?: RoutingRule[]) {
    // 合并内置规则和自定义规则（自定义规则优先级更高）
    const builtinRules = DEFAULT_ROUTING_RULES;

    if (customRules && customRules.length > 0) {
      // 自定义规则覆盖同名的内置规则
      const customRuleNames = new Set(customRules.map(r => r.name));
      const builtinRulesToKeep = builtinRules.filter(r => !customRuleNames.has(r.name));
      this.rules = [...builtinRulesToKeep, ...customRules];
    } else {
      this.rules = builtinRules;
    }
  }

  /**
   * 根据内容路由到知识库表
   * @param content 内容文本
   * @param metadata 元数据（可选）
   * @returns 路由决策结果
   */
  routeToKnowledgeBases(content: string, _metadata?: Record<string, unknown>): RoutingResult {
    const matchedTables = new Set<TableName>();
    const matchedRules: RoutingRule[] = [];

    // 始终存储到通用知识库
    matchedTables.add('knowledge');

    // 根据规则匹配专用知识库
    for (const rule of this.rules) {
      if (rule.enabled === false) continue;

      for (const pattern of rule.patterns) {
        // 如果 pattern 是用 | 分隔的字符串，拆分为多个子模式
        // 例如："个人 | 笔记 | 日记" -> ["个人", "笔记", "日记"]
        const subPatterns = typeof pattern === 'string'
          ? pattern.split('|').map(p => p.trim()).filter(p => p.length > 0)
          : [pattern];

        // 检查是否匹配任何子模式
        const matches = subPatterns.some(subPattern => {
          const regex = typeof subPattern === 'string'
            ? new RegExp(subPattern, 'iu')
            : subPattern;
          return regex.test(content);
        });

        if (matches) {
          matchedTables.add(rule.targetTable as TableName);
          matchedRules.push(rule);
          break;
        }
      }
    }

    return {
      targetTables: Array.from(matchedTables) as TableName[],
      matchedRules
    };
  }

  /**
   * 获取所有启用的规则
   */
  getEnabledRules(): RoutingRule[] {
    return this.rules.filter(rule => rule.enabled !== false);
  }

  /**
   * 添加自定义规则
   * @param rule 路由规则
   */
  addRule(rule: RoutingRule): void {
    // 移除同名的现有规则
    this.rules = this.rules.filter(r => r.name !== rule.name);
    this.rules.push(rule);
  }

  /**
   * 删除规则
   * @param ruleName 规则名称
   */
  removeRule(ruleName: string): void {
    this.rules = this.rules.filter(r => r.name !== ruleName);
  }

  /**
   * 启用/禁用规则
   * @param ruleName 规则名称
   * @param enabled 是否启用
   */
  toggleRule(ruleName: string, enabled: boolean): void {
    const rule = this.rules.find(r => r.name === ruleName);
    if (rule) {
      rule.enabled = enabled;
    }
  }

  /**
   * 获取所有规则（包括禁用的）
   */
  getAllRules(): RoutingRule[] {
    return this.rules;
  }
}

/**
 * 创建路由引擎实例
 * @param customRules 自定义规则
 */
export function createRoutingEngine(customRules?: RoutingRule[]): RoutingEngine {
  return new RoutingEngine(customRules);
}
