/**
 * profile-layer.test.ts — profile 分层推断与合并测试
 */

import { describe, it, expect } from "vitest";
import {
  inferProfileLayer,
  mergeProfileByLayer,
  enrichProfileLayer,
  isProfileMemory,
} from "./profile-layer.js";
import type { MemoryRecord, MemoryScope, ProfileLayer } from "./types.js";

const mockScope = (partial?: Partial<MemoryScope>): MemoryScope => ({
  tenantId: "tenant-1",
  appId: "app-1",
  userId: "user-1",
  projectId: "project-1",
  agentId: "agent-1",
  namespace: "default",
  ...partial,
});

const mockProfileRecord = (
  text: string,
  partial?: Partial<MemoryRecord>,
): MemoryRecord => ({
  id: `rec-${Date.now()}-${Math.random()}`,
  scope: mockScope(),
  kind: "preference",
  semanticType: "profile",
  text,
  contentHash: `hash-${text.slice(0, 10)}`,
  importance: 0.8,
  category: "preference",
  dataType: "memory",
  metadata: {},
  provenance: { source: "user", createdAt: Date.now() },
  createdAt: Date.now(),
  ...partial,
});

describe("inferProfileLayer", () => {
  describe("project 层推断", () => {
    it("显式项目绑定：中文关键词", () => {
      expect(inferProfileLayer("在这个项目里默认用中文", mockScope())).toBe("project");
      expect(inferProfileLayer("本项目文档用 Markdown", mockScope())).toBe("project");
      expect(inferProfileLayer("当前项目里测试覆盖率要 80%", mockScope())).toBe("project");
      expect(inferProfileLayer("这个仓库的提交格式用 conventional commits", mockScope())).toBe("project");
    });

    it("显式项目绑定：英文关键词", () => {
      expect(inferProfileLayer("in this project use English", mockScope())).toBe("project");
      expect(inferProfileLayer("This project requires 80% coverage", mockScope())).toBe("project");
      expect(inferProfileLayer("For this repo use semantic versioning", mockScope())).toBe("project");
    });

    it("隐式项目绑定：scope.projectId 非空且非占位符", () => {
      expect(
        inferProfileLayer("默认用中文", mockScope({ projectId: "memory-autodb" })),
      ).toBe("project");

      expect(
        inferProfileLayer("文档用 Markdown", mockScope({ projectId: "openclaw-plugin" })),
      ).toBe("project");
    });

    it("隐式项目绑定：projectId=default/unknown 不视为项目绑定", () => {
      // projectId 为占位符时，应降级到 app 或 global
      const scopeDefault = mockScope({ projectId: "default", appId: "codex" });
      expect(inferProfileLayer("默认用中文", scopeDefault)).toBe("app");

      const scopeUnknown = mockScope({ projectId: "unknown", appId: "" });
      expect(inferProfileLayer("默认用中文", scopeUnknown)).toBe("global");
    });
  });

  describe("app 层推断", () => {
    it("显式应用绑定：中文关键词", () => {
      expect(inferProfileLayer("在 Codex 里复杂任务先看代码", mockScope())).toBe("app");
      expect(inferProfileLayer("在 OpenClaw 中默认用英文", mockScope())).toBe("app");
      expect(inferProfileLayer("这个 app 里用简洁风格", mockScope())).toBe("app");
      expect(inferProfileLayer("这个 agent 要先验证后执行", mockScope())).toBe("app");
    });

    it("显式应用绑定：英文关键词", () => {
      expect(inferProfileLayer("in Codex use verbose mode", mockScope())).toBe("app");
      expect(inferProfileLayer("This agent should verify before execution", mockScope())).toBe("app");
      expect(inferProfileLayer("In this tool use confirmation prompts", mockScope())).toBe("app");
    });

    it("隐式应用绑定：scope.appId 非空", () => {
      const scopeWithApp = mockScope({ appId: "codex", projectId: "" });
      expect(inferProfileLayer("默认用中文", scopeWithApp)).toBe("app");
    });

    it("项目绑定优先级高于应用绑定", () => {
      // 同时命中项目和应用关键词，项目优先
      expect(
        inferProfileLayer("在这个项目里的 Codex 中用中文", mockScope()),
      ).toBe("project");
    });
  });

  describe("global 层推断", () => {
    it("显式全局信号：中文关键词", () => {
      expect(inferProfileLayer("总是用中文交流", mockScope())).toBe("global");
      expect(inferProfileLayer("永远不要自动 push", mockScope())).toBe("global");
      expect(inferProfileLayer("所有项目都用 TypeScript", mockScope())).toBe("global");
      expect(inferProfileLayer("全局默认用 Jest 测试框架", mockScope())).toBe("global");
    });

    it("显式全局信号：英文关键词", () => {
      expect(inferProfileLayer("always use English", mockScope())).toBe("global");
      expect(inferProfileLayer("for all projects use TypeScript", mockScope())).toBe("global");
      expect(inferProfileLayer("globally prefer functional style", mockScope())).toBe("global");
    });

    it("兜底默认：无任何绑定信号", () => {
      // 无项目/应用/全局信号，且 scope 无明确绑定 → global（最保守）
      const scopeEmpty = mockScope({ projectId: "", appId: "" });
      expect(inferProfileLayer("默认用中文", scopeEmpty)).toBe("global");
      expect(inferProfileLayer("测试覆盖率要 80%", scopeEmpty)).toBe("global");
    });
  });
});

describe("mergeProfileByLayer", () => {
  it("不同 profileDimension 互不影响，全部保留", () => {
    const profiles: MemoryRecord[] = [
      mockProfileRecord("默认用中文", {
        profileDimension: "language",
        profileLayer: "global",
      }),
      mockProfileRecord("回答要详细", {
        profileDimension: "response_style",
        profileLayer: "project",
      }),
      mockProfileRecord("总是先验证", {
        profileDimension: "verification_preference",
        profileLayer: "app",
      }),
    ];

    const result = mergeProfileByLayer(profiles);

    expect(result.active).toHaveLength(3);
    expect(result.overridden).toHaveLength(0);
    expect(result.unclassified).toHaveLength(0);
  });

  it("同 profileDimension，project 层覆盖 global 层", () => {
    const globalPref = mockProfileRecord("默认用英文", {
      profileDimension: "language",
      profileLayer: "global",
      createdAt: 1000,
    });
    const projectPref = mockProfileRecord("这个项目里用中文", {
      profileDimension: "language",
      profileLayer: "project",
      createdAt: 2000,
    });

    const result = mergeProfileByLayer([globalPref, projectPref]);

    expect(result.active).toHaveLength(1);
    expect(result.active[0].text).toBe("这个项目里用中文");
    expect(result.active[0].profileLayer).toBe("project");

    expect(result.overridden).toHaveLength(1);
    expect(result.overridden[0].text).toBe("默认用英文");
    expect(result.overridden[0].overriddenBy).toBe("project");
  });

  it("同 profileDimension，project 层覆盖 app 层", () => {
    const appPref = mockProfileRecord("在 Codex 里用英文", {
      profileDimension: "language",
      profileLayer: "app",
      createdAt: 1000,
    });
    const projectPref = mockProfileRecord("这个项目里用中文", {
      profileDimension: "language",
      profileLayer: "project",
      createdAt: 2000,
    });

    const result = mergeProfileByLayer([appPref, projectPref]);

    expect(result.active).toHaveLength(1);
    expect(result.active[0].profileLayer).toBe("project");

    expect(result.overridden).toHaveLength(1);
    expect(result.overridden[0].profileLayer).toBe("app");
    expect(result.overridden[0].overriddenBy).toBe("project");
  });

  it("同 profileDimension，app 层覆盖 global 层", () => {
    const globalPref = mockProfileRecord("默认用英文", {
      profileDimension: "language",
      profileLayer: "global",
      createdAt: 1000,
    });
    const appPref = mockProfileRecord("在 Codex 里用中文", {
      profileDimension: "language",
      profileLayer: "app",
      createdAt: 2000,
    });

    const result = mergeProfileByLayer([globalPref, appPref]);

    expect(result.active).toHaveLength(1);
    expect(result.active[0].profileLayer).toBe("app");

    expect(result.overridden).toHaveLength(1);
    expect(result.overridden[0].profileLayer).toBe("global");
    expect(result.overridden[0].overriddenBy).toBe("app");
  });

  it("同 profileDimension 同 layer，保留最新的", () => {
    const older = mockProfileRecord("默认用英文", {
      profileDimension: "language",
      profileLayer: "global",
      createdAt: 1000,
    });
    const newer = mockProfileRecord("总是用中文", {
      profileDimension: "language",
      profileLayer: "global",
      createdAt: 2000,
    });

    const result = mergeProfileByLayer([older, newer]);

    expect(result.active).toHaveLength(1);
    expect(result.active[0].text).toBe("总是用中文");
    expect(result.active[0].createdAt).toBe(2000);

    expect(result.overridden).toHaveLength(1);
    expect(result.overridden[0].text).toBe("默认用英文");
  });

  it("复杂场景：3 层 3 维度混合", () => {
    const profiles: MemoryRecord[] = [
      // language 维度：3 层都有，project 应该胜出
      mockProfileRecord("全局默认英文", {
        profileDimension: "language",
        profileLayer: "global",
        createdAt: 1000,
      }),
      mockProfileRecord("Codex 里用简体中文", {
        profileDimension: "language",
        profileLayer: "app",
        createdAt: 2000,
      }),
      mockProfileRecord("这个项目里用繁体中文", {
        profileDimension: "language",
        profileLayer: "project",
        createdAt: 3000,
      }),
      // response_style 维度：只有 app 层
      mockProfileRecord("回答要详细", {
        profileDimension: "response_style",
        profileLayer: "app",
        createdAt: 4000,
      }),
      // verification_preference 维度：global 和 project
      mockProfileRecord("默认跳过验证", {
        profileDimension: "verification_preference",
        profileLayer: "global",
        createdAt: 5000,
      }),
      mockProfileRecord("这个项目里总是验证", {
        profileDimension: "verification_preference",
        profileLayer: "project",
        createdAt: 6000,
      }),
    ];

    const result = mergeProfileByLayer(profiles);

    // active 应该有 3 条（每个维度 1 条）
    expect(result.active).toHaveLength(3);

    const activeByDimension = new Map(
      result.active.map((r) => [r.profileDimension, r]),
    );

    // language 维度：project 层胜出
    expect(activeByDimension.get("language")?.text).toBe("这个项目里用繁体中文");
    expect(activeByDimension.get("language")?.profileLayer).toBe("project");

    // response_style 维度：只有 app 层
    expect(activeByDimension.get("response_style")?.text).toBe("回答要详细");
    expect(activeByDimension.get("response_style")?.profileLayer).toBe("app");

    // verification_preference 维度：project 层胜出
    expect(activeByDimension.get("verification_preference")?.text).toBe(
      "这个项目里总是验证",
    );
    expect(activeByDimension.get("verification_preference")?.profileLayer).toBe(
      "project",
    );

    // overridden 应该有 3 条（language 2 条，verification_preference 1 条）
    expect(result.overridden).toHaveLength(3);

    const overriddenTexts = result.overridden.map((r) => r.text);
    expect(overriddenTexts).toContain("全局默认英文");
    expect(overriddenTexts).toContain("Codex 里用简体中文");
    expect(overriddenTexts).toContain("默认跳过验证");
  });

  it("无 profileDimension 或 profileLayer 的记忆归入 unclassified", () => {
    const profiles: MemoryRecord[] = [
      mockProfileRecord("默认用中文", {
        profileDimension: "language",
        profileLayer: "global",
      }),
      mockProfileRecord("无维度标记", {
        profileDimension: undefined,
        profileLayer: "global",
      }),
      mockProfileRecord("无层级标记", {
        profileDimension: "language",
        profileLayer: undefined,
      }),
      mockProfileRecord("都没有", {
        profileDimension: undefined,
        profileLayer: undefined,
      }),
    ];

    const result = mergeProfileByLayer(profiles);

    expect(result.active).toHaveLength(1);
    expect(result.active[0].text).toBe("默认用中文");

    expect(result.unclassified).toHaveLength(3);
    const unclassifiedTexts = result.unclassified.map((r) => r.text);
    expect(unclassifiedTexts).toContain("无维度标记");
    expect(unclassifiedTexts).toContain("无层级标记");
    expect(unclassifiedTexts).toContain("都没有");
  });

  it("空数组输入", () => {
    const result = mergeProfileByLayer([]);
    expect(result.active).toHaveLength(0);
    expect(result.overridden).toHaveLength(0);
    expect(result.unclassified).toHaveLength(0);
  });
});

describe("enrichProfileLayer", () => {
  it("为缺失 profileLayer 的 profile 记忆补充", () => {
    const record = mockProfileRecord("在这个项目里用中文", {
      profileLayer: undefined,
    });

    const enriched = enrichProfileLayer(record);

    expect(enriched.profileLayer).toBe("project");
    expect(enriched.text).toBe("在这个项目里用中文");
  });

  it("已有 profileLayer 的记忆不修改", () => {
    const record = mockProfileRecord("默认用中文", {
      profileLayer: "global",
    });

    const enriched = enrichProfileLayer(record);

    expect(enriched.profileLayer).toBe("global");
    expect(enriched).toBe(record); // 应该返回原对象（不可变优化）
  });

  it("非 profile 记忆不处理", () => {
    const record = mockProfileRecord("这是一个任务", {
      semanticType: "task_context",
      profileLayer: undefined,
    });

    const enriched = enrichProfileLayer(record);

    expect(enriched.profileLayer).toBeUndefined();
    expect(enriched).toBe(record);
  });
});

describe("isProfileMemory", () => {
  it("识别 profile 记忆", () => {
    const record = mockProfileRecord("默认用中文");
    expect(isProfileMemory(record)).toBe(true);
  });

  it("非 profile 记忆返回 false", () => {
    const record = mockProfileRecord("这是一个任务", {
      semanticType: "task_context",
    });
    expect(isProfileMemory(record)).toBe(false);
  });

  it("无 semanticType 返回 false", () => {
    const record = mockProfileRecord("默认用中文", {
      semanticType: undefined,
    });
    expect(isProfileMemory(record)).toBe(false);
  });
});
