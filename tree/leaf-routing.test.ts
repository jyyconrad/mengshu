/**
 * Leaf 分级路由测试（D-03 验证）。
 */

import { describe, it, expect } from "vitest";
import {
  routeLeaf,
  shouldRouteToTree,
  LEAF_ADMISSION_THRESHOLD,
  TOPIC_TREE_THRESHOLD,
  GLOBAL_TREE_IMPORTANCE,
  type LeafRoutingInput,
} from "./leaf-routing.js";

describe("leaf-routing", () => {
  describe("D-03 准入阈值验证", () => {
    it("valueScore < 0.55 拒绝准入", () => {
      const input: LeafRoutingInput = {
        valueScore: 0.54,
        importance: 0.8,
        hasTopicLabel: true,
      };
      const decision = routeLeaf(input);
      expect(decision.admitted).toBe(false);
      expect(decision.treeTypes).toEqual([]);
      expect(decision.reason).toContain("0.54 < 0.55");
    });

    it("valueScore = 0.55 准入，仅进 source tree", () => {
      const input: LeafRoutingInput = {
        valueScore: 0.55,
        importance: 0.6,
        hasTopicLabel: true,
      };
      const decision = routeLeaf(input);
      expect(decision.admitted).toBe(true);
      expect(decision.treeTypes).toEqual(["source"]);
      expect(decision.reason).toContain("source tree");
      expect(decision.reason).toContain("< 0.7 → skip topic/global");
    });

    it("valueScore = 0.69 仍然仅进 source tree（边界值测试）", () => {
      const input: LeafRoutingInput = {
        valueScore: 0.69,
        importance: 0.8,
        hasTopicLabel: true,
      };
      const decision = routeLeaf(input);
      expect(decision.admitted).toBe(true);
      expect(decision.treeTypes).toEqual(["source"]);
      expect(decision.reason).toContain("0.69 < 0.7");
    });
  });

  describe("D-03 分级路由：0.55-0.70 仅 source tree", () => {
    it("valueScore = 0.60, 有 topic，importance 足够 → 仍然只进 source", () => {
      const input: LeafRoutingInput = {
        valueScore: 0.60,
        importance: 0.8,
        hasTopicLabel: true,
        semanticType: "experience",
      };
      const decision = routeLeaf(input);
      expect(decision.admitted).toBe(true);
      expect(decision.treeTypes).toEqual(["source"]);
      expect(decision.reason).toContain("0.60 < 0.7 → skip topic/global");
    });

    it("valueScore = 0.65, importance 很高 → 仍然不进 global", () => {
      const input: LeafRoutingInput = {
        valueScore: 0.65,
        importance: 0.9, // 超过 0.85 global 门槛
        hasTopicLabel: true,
      };
      const decision = routeLeaf(input);
      expect(decision.admitted).toBe(true);
      expect(decision.treeTypes).toEqual(["source"]);
      expect(decision.reason).toContain("skip topic/global");
    });
  });

  describe("D-03 分级路由：>= 0.70 进入 topic tree 评估", () => {
    it("valueScore = 0.70, 有 topic, importance 足够 → source + topic", () => {
      const input: LeafRoutingInput = {
        valueScore: 0.70,
        importance: 0.6,
        hasTopicLabel: true,
        semanticType: "experience",
      };
      const decision = routeLeaf(input);
      expect(decision.admitted).toBe(true);
      expect(decision.treeTypes).toContain("source");
      expect(decision.treeTypes).toContain("topic");
      expect(decision.reason).toContain("→ topic tree");
    });

    it("valueScore = 0.75, 但无 topic label → 只进 source", () => {
      const input: LeafRoutingInput = {
        valueScore: 0.75,
        importance: 0.7,
        hasTopicLabel: false,
      };
      const decision = routeLeaf(input);
      expect(decision.admitted).toBe(true);
      expect(decision.treeTypes).toEqual(["source"]);
      expect(decision.reason).toContain("no topic label → skip topic tree");
    });

    it("valueScore = 0.75, importance < 0.55 → 只进 source", () => {
      const input: LeafRoutingInput = {
        valueScore: 0.75,
        importance: 0.50,
        hasTopicLabel: true,
      };
      const decision = routeLeaf(input);
      expect(decision.admitted).toBe(true);
      expect(decision.treeTypes).toEqual(["source"]);
      expect(decision.reason).toContain("importance 0.50 < 0.55 → skip topic tree");
    });

    it("valueScore = 0.75, semanticType = profile → 只进 source（profile 走独立层）", () => {
      const input: LeafRoutingInput = {
        valueScore: 0.75,
        importance: 0.7,
        hasTopicLabel: true,
        semanticType: "profile",
      };
      const decision = routeLeaf(input);
      expect(decision.admitted).toBe(true);
      expect(decision.treeTypes).toEqual(["source"]);
      expect(decision.reason).toContain("semanticType=profile → skip topic tree");
    });
  });

  describe("global tree 路由（最严格门槛）", () => {
    it("importance = 0.85 → source + topic + global", () => {
      const input: LeafRoutingInput = {
        valueScore: 0.80,
        importance: 0.85,
        hasTopicLabel: true,
        semanticType: "rules",
      };
      const decision = routeLeaf(input);
      expect(decision.admitted).toBe(true);
      expect(decision.treeTypes).toContain("source");
      expect(decision.treeTypes).toContain("topic");
      expect(decision.treeTypes).toContain("global");
      expect(decision.reason).toContain("importance 0.85 >= 0.85");
      expect(decision.reason).toContain("→ global tree");
    });

    it("importance = 0.90, 但 sensitive + session scope → 不进 global", () => {
      const input: LeafRoutingInput = {
        valueScore: 0.85,
        importance: 0.90,
        hasTopicLabel: true,
        scopeVisibility: "session",
        riskFlags: ["sensitive"],
      };
      const decision = routeLeaf(input);
      expect(decision.admitted).toBe(true);
      expect(decision.treeTypes).toContain("source");
      expect(decision.treeTypes).toContain("topic");
      expect(decision.treeTypes).not.toContain("global");
      expect(decision.reason).toContain("sensitive + session/project scope → skip global tree");
    });

    it("importance < 0.85, 但 workspace rule → 进 global", () => {
      const input: LeafRoutingInput = {
        valueScore: 0.75,
        importance: 0.70,
        hasTopicLabel: true,
        isWorkspaceRule: true,
        scopeVisibility: "workspace",
      };
      const decision = routeLeaf(input);
      expect(decision.admitted).toBe(true);
      expect(decision.treeTypes).toContain("global");
      expect(decision.reason).toContain("workspace rule");
    });

    it("importance < 0.85, 但用户显式保存到 global → 进 global", () => {
      const input: LeafRoutingInput = {
        valueScore: 0.75,
        importance: 0.60,
        hasTopicLabel: false, // 即使无 topic
        explicitGlobal: true,
      };
      const decision = routeLeaf(input);
      expect(decision.admitted).toBe(true);
      expect(decision.treeTypes).toContain("source");
      expect(decision.treeTypes).toContain("global");
      expect(decision.reason).toContain("explicit global save");
    });
  });

  describe("shouldRouteToTree 便捷函数", () => {
    it("返回是否应路由到指定树", () => {
      const input: LeafRoutingInput = {
        valueScore: 0.75,
        importance: 0.70,
        hasTopicLabel: true,
      };
      expect(shouldRouteToTree(input, "source")).toBe(true);
      expect(shouldRouteToTree(input, "topic")).toBe(true);
      expect(shouldRouteToTree(input, "global")).toBe(false);
    });
  });

  describe("边界值完整性测试", () => {
    it("valueScore = 0.54999 → 拒绝", () => {
      const input: LeafRoutingInput = {
        valueScore: 0.54999,
        importance: 0.8,
        hasTopicLabel: true,
      };
      expect(routeLeaf(input).admitted).toBe(false);
    });

    it("valueScore = 0.55000 → source only", () => {
      const input: LeafRoutingInput = {
        valueScore: 0.55,
        importance: 0.8,
        hasTopicLabel: true,
      };
      const decision = routeLeaf(input);
      expect(decision.admitted).toBe(true);
      expect(decision.treeTypes).toEqual(["source"]);
    });

    it("valueScore = 0.69999 → source only", () => {
      const input: LeafRoutingInput = {
        valueScore: 0.69999,
        importance: 0.8,
        hasTopicLabel: true,
      };
      const decision = routeLeaf(input);
      expect(decision.admitted).toBe(true);
      expect(decision.treeTypes).toEqual(["source"]);
    });

    it("valueScore = 0.70000 → source + topic (if conditions met)", () => {
      const input: LeafRoutingInput = {
        valueScore: 0.70,
        importance: 0.6,
        hasTopicLabel: true,
      };
      const decision = routeLeaf(input);
      expect(decision.admitted).toBe(true);
      expect(decision.treeTypes).toContain("source");
      expect(decision.treeTypes).toContain("topic");
    });
  });

  describe("组合场景测试", () => {
    it("低价值 leaf：valueScore = 0.58, importance = 0.45 → 仅 source", () => {
      const input: LeafRoutingInput = {
        valueScore: 0.58,
        importance: 0.45,
        hasTopicLabel: true,
      };
      const decision = routeLeaf(input);
      expect(decision.treeTypes).toEqual(["source"]);
    });

    it("中价值 leaf：valueScore = 0.75, importance = 0.65 → source + topic", () => {
      const input: LeafRoutingInput = {
        valueScore: 0.75,
        importance: 0.65,
        hasTopicLabel: true,
        semanticType: "experience",
      };
      const decision = routeLeaf(input);
      expect(decision.treeTypes).toEqual(["source", "topic"]);
    });

    it("高价值 leaf：valueScore = 0.90, importance = 0.90 → 全部三棵树", () => {
      const input: LeafRoutingInput = {
        valueScore: 0.90,
        importance: 0.90,
        hasTopicLabel: true,
        semanticType: "rules",
      };
      const decision = routeLeaf(input);
      expect(decision.treeTypes).toEqual(["source", "topic", "global"]);
    });
  });

  describe("常量值验证", () => {
    it("阈值常量与设计文档一致", () => {
      expect(LEAF_ADMISSION_THRESHOLD).toBe(0.55); // D-03
      expect(TOPIC_TREE_THRESHOLD).toBe(0.70);      // D-03
      expect(GLOBAL_TREE_IMPORTANCE).toBe(0.85);    // §7.3
    });
  });
});
