import { describe, expect, it } from "vitest";

import type { MemoryScope, MemorySemanticType } from "../domain/types.js";
import { InMemoryMemoryViewAssetRepository } from "./in-memory-repository.js";
import {
  MemoryViewAssetError,
  MemoryViewAssetService,
  type MemoryViewMemoryFact,
  type MemoryViewSourceResolver,
  type MemoryViewTreeFact,
} from "./memory-view-service.js";

const SCOPE: MemoryScope = {
  tenantId: "tenant-1",
  userId: "user-1",
  appId: "app-1",
  projectId: "project-1",
  agentId: "agent-1",
  namespace: "memory",
  visibility: "private",
};

const CONTENT_REF = {
  type: "memory_projection",
  recordIds: ["memory-1"],
  treeNodeIds: [],
  evidenceIds: ["evidence-1"],
  semanticTypes: ["rules"],
  resolutionHash: "b".repeat(64),
} as const;

const QUALITY = {
  minValueScore: 0.92,
  importance: 0.8,
  confidence: 0.95,
  hotness: 0.4,
  scoringVersion: "v1.0",
} as const;

function memoryFact(overrides: Partial<MemoryViewMemoryFact> = {}): MemoryViewMemoryFact {
  return {
    id: "memory-1",
    scope: SCOPE,
    lifecycleStatus: "active",
    semanticType: "rules",
    evidenceIds: ["evidence-1"],
    riskFlags: [],
    unresolvedConflict: false,
    ...overrides,
  };
}

class MutableResolver implements MemoryViewSourceResolver {
  facts: MemoryViewMemoryFact[] = [memoryFact()];
  trees: MemoryViewTreeFact[] = [];

  async resolveMemories(): Promise<readonly MemoryViewMemoryFact[]> {
    return this.facts;
  }

  async resolveTrees(): Promise<readonly MemoryViewTreeFact[]> {
    return this.trees;
  }
}

function publishInput(overrides: Record<string, unknown> = {}) {
  return {
    assetId: "asset-1",
    idempotencyKey: "publish-request-1",
    expectedLatestVersion: 0,
    scope: SCOPE,
    ownerUserId: "user-1",
    title: "项目安全规则",
    description: "只引用原生记忆，不复制正文",
    semanticTypes: ["rules"] as MemorySemanticType[],
    contentRef: CONTENT_REF,
    riskFlags: [] as string[],
    qualitySnapshot: QUALITY,
    targetStatus: "published" as const,
    ...overrides,
  };
}

describe("MemoryViewAssetService", () => {
  it("发布 exact-scope active memory 的 private overlay，并保存可解释回执", async () => {
    const repository = new InMemoryMemoryViewAssetRepository({
      idFactory: () => "receipt-1",
      now: () => 1_700_000_000_000,
    });
    const service = new MemoryViewAssetService({ repository, sourceResolver: new MutableResolver() });

    const result = await service.createVersion(publishInput());

    expect(result.replayed).toBe(false);
    expect(result.asset).toMatchObject({
      id: "asset-1",
      kind: "memory_view",
      version: 1,
      status: "published",
      visibility: "private",
      contentValidity: undefined,
      owner: { subjectType: "user", subjectId: "user-1" },
      qualitySnapshot: QUALITY,
    });
    expect(result.asset).not.toHaveProperty("text");
    expect(result.asset).not.toHaveProperty("content");
    expect(result.receipt.decisions).toEqual([
      "private_scope",
      "content_ref_valid",
      "exact_scope",
      "active_memory",
      "evidence_complete",
      "semantic_type_consistent",
      "conflict_free",
      "risk_free",
      "faithfulness_passed",
    ]);
  });

  it("兼容缺少 visibility 的旧 scope，但只规范化为 private", async () => {
    const repository = new InMemoryMemoryViewAssetRepository();
    const legacyScope = { ...SCOPE, visibility: undefined };
    const resolver = new MutableResolver();
    resolver.facts = [memoryFact({ scope: legacyScope })];
    const service = new MemoryViewAssetService({ repository, sourceResolver: resolver });

    const result = await service.createVersion(publishInput({
      scope: legacyScope,
    }));

    expect(result.asset.sourceScope.visibility).toBe("private");
  });

  it.each([
    ["PRIVATE_SCOPE_REQUIRED", { scope: { ...SCOPE, visibility: "workspace" } }, memoryFact()],
    ["OWNER_SCOPE_MISMATCH", { ownerUserId: "other-user" }, memoryFact()],
    ["SOURCE_SCOPE_MISMATCH", {}, memoryFact({ scope: { ...SCOPE, projectId: "other" } })],
    ["MEMORY_NOT_ACTIVE", {}, memoryFact({ lifecycleStatus: "revoked" })],
    ["EVIDENCE_REQUIRED", {}, memoryFact({ evidenceIds: [] })],
    ["EVIDENCE_MISMATCH", {}, memoryFact({ evidenceIds: ["other-evidence"] })],
    ["SEMANTIC_TYPE_MISMATCH", { semanticTypes: ["experience"] }, memoryFact()],
    ["UNRESOLVED_CONFLICT", {}, memoryFact({ unresolvedConflict: true })],
    ["RISK_NOT_CLEARED", {}, memoryFact({ riskFlags: ["sensitive"] })],
  ])("发布门禁拒绝 %s", async (code, overrides, fact) => {
    const resolver = new MutableResolver();
    resolver.facts = [fact as MemoryViewMemoryFact];
    const service = new MemoryViewAssetService({
      repository: new InMemoryMemoryViewAssetRepository(),
      sourceResolver: resolver,
    });

    await expect(service.createVersion(publishInput(overrides))).rejects.toMatchObject({ code });
  });

  it("published 版本 append-only，新版本递增并执行 CAS", async () => {
    const repository = new InMemoryMemoryViewAssetRepository();
    const service = new MemoryViewAssetService({ repository, sourceResolver: new MutableResolver() });
    const first = await service.createVersion(publishInput());

    const second = await service.createVersion(publishInput({
      idempotencyKey: "publish-request-2",
      expectedLatestVersion: 1,
      title: "更新后的项目安全规则",
    }));

    expect(second.asset.version).toBe(2);
    expect((await repository.getVersion(SCOPE, "asset-1", 1))?.title).toBe("项目安全规则");
    expect((await repository.getVersion(SCOPE, "asset-1", 2))?.title).toBe("更新后的项目安全规则");
    await expect(service.createVersion(publishInput({
      idempotencyKey: "publish-request-3",
      expectedLatestVersion: 1,
    }))).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  });

  it("latest revoke overrides a Loadout pin to an older published version", async () => {
    const service = new MemoryViewAssetService({
      repository: new InMemoryMemoryViewAssetRepository(),
      sourceResolver: new MutableResolver(),
    });
    const published = await service.createVersion(publishInput());
    const revoked = await service.changeStatus({
      scope: SCOPE,
      assetId: published.asset.id,
      expectedLatestVersion: published.asset.version,
      targetStatus: "revoked",
      idempotencyKey: "revoke-pinned-asset",
    });

    await expect(service.resolveBinding(SCOPE, published.asset.id, published.asset.version))
      .resolves.toEqual(revoked.asset);
    expect(revoked.asset.status).toBe("revoked");
  });

  it("同一 promotion request 幂等重放，key 复用到不同请求则拒绝", async () => {
    const service = new MemoryViewAssetService({
      repository: new InMemoryMemoryViewAssetRepository(),
      sourceResolver: new MutableResolver(),
    });
    const input = publishInput();
    const first = await service.createVersion(input);
    const replay = await service.createVersion(input);

    expect(replay.replayed).toBe(true);
    expect(replay.asset).toEqual(first.asset);
    expect(replay.receipt.id).toBe(first.receipt.id);
    await expect(service.createVersion(publishInput({ title: "不同请求" })))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("读时将底层 revoked/superseded/re-scoped 立即解析为 stale，且不混淆 asset status", async () => {
    const repository = new InMemoryMemoryViewAssetRepository();
    const resolver = new MutableResolver();
    const service = new MemoryViewAssetService({ repository, sourceResolver: resolver });
    await service.createVersion(publishInput());

    expect(await service.read(SCOPE, "asset-1")).toMatchObject({
      asset: { status: "published" },
      contentValidity: "current",
      staleReasons: [],
    });

    resolver.facts = [memoryFact({ lifecycleStatus: "superseded" })];
    expect(await service.read(SCOPE, "asset-1")).toMatchObject({
      asset: { status: "published" },
      contentValidity: "stale",
      staleReasons: ["memory_not_active:memory-1"],
    });

    resolver.facts = [memoryFact({ scope: { ...SCOPE, projectId: "other" } })];
    expect(await service.read(SCOPE, "asset-1")).toMatchObject({
      contentValidity: "stale",
      staleReasons: ["memory_scope_changed:memory-1"],
    });
  });

  it("tree-backed memory_view 发布与每次读取都复验 tree scope/lifecycle/faithfulness", async () => {
    const repository = new InMemoryMemoryViewAssetRepository();
    const resolver = new MutableResolver();
    resolver.trees = [{
      id: "tree-1",
      scope: SCOPE,
      evidenceIds: ["tree-evidence-1"],
      semanticTypes: ["rules"],
      stale: false,
      faithfulnessPassed: true,
    }];
    const service = new MemoryViewAssetService({ repository, sourceResolver: resolver });
    await service.createVersion(publishInput({
      contentRef: {
        ...CONTENT_REF,
        treeNodeIds: ["tree-1"],
        evidenceIds: ["evidence-1", "tree-evidence-1"],
      },
    }));

    await expect(service.read(SCOPE, "asset-1")).resolves.toMatchObject({
      contentValidity: "current",
      staleReasons: [],
    });

    resolver.trees = [{ ...resolver.trees[0]!, faithfulnessPassed: false }];
    await expect(service.read(SCOPE, "asset-1")).resolves.toMatchObject({
      contentValidity: "stale",
      staleReasons: ["tree_faithfulness_failed:tree-1"],
    });
  });

  it("拒绝没有 5-type 或 evidence 的历史 tree，避免把仅可导航摘要当成可注入资产", async () => {
    const resolver = new MutableResolver();
    resolver.trees = [{
      id: "tree-legacy",
      scope: SCOPE,
      evidenceIds: [],
      semanticTypes: [],
      stale: false,
      faithfulnessPassed: true,
    }];
    const service = new MemoryViewAssetService({
      repository: new InMemoryMemoryViewAssetRepository(),
      sourceResolver: resolver,
    });

    await expect(service.createVersion(publishInput({
      contentRef: {
        ...CONTENT_REF,
        treeNodeIds: ["tree-legacy"],
      },
    }))).rejects.toMatchObject({ code: "EVIDENCE_REQUIRED" });

    resolver.trees = [{
      ...resolver.trees[0]!,
      evidenceIds: ["tree-evidence-1"],
    }];
    await expect(service.createVersion(publishInput({
      idempotencyKey: "legacy-tree-with-evidence",
      contentRef: {
        ...CONTENT_REF,
        treeNodeIds: ["tree-legacy"],
        evidenceIds: ["evidence-1", "tree-evidence-1"],
      },
    }))).rejects.toMatchObject({ code: "SEMANTIC_TYPE_MISMATCH" });
  });

  it("search 在 exact private scope 内匹配标题、描述、5 type 与 source ref", async () => {
    const service = new MemoryViewAssetService({
      repository: new InMemoryMemoryViewAssetRepository(),
      sourceResolver: new MutableResolver(),
    });
    await service.createVersion(publishInput());

    await expect(service.search(SCOPE, { query: "rules", limit: 10 })).resolves.toEqual({
      query: "rules",
      assets: [expect.objectContaining({
        asset: expect.objectContaining({ id: "asset-1" }),
        matchedFields: ["semanticTypes"],
      })],
      filtered: [],
    });
    await expect(service.search(SCOPE, { query: "memory-1", limit: 10 })).resolves.toEqual(
      expect.objectContaining({ assets: [expect.objectContaining({ matchedFields: ["sourceRefs"] })] }),
    );
  });

  it("deprecate/revoke 创建新版本且不改变独立的 content validity", async () => {
    const repository = new InMemoryMemoryViewAssetRepository();
    const resolver = new MutableResolver();
    const service = new MemoryViewAssetService({ repository, sourceResolver: resolver });
    await service.createVersion(publishInput());

    const deprecated = await service.changeStatus({
      scope: SCOPE,
      assetId: "asset-1",
      expectedLatestVersion: 1,
      targetStatus: "deprecated",
      idempotencyKey: "deprecate-1",
    });
    const revoked = await service.changeStatus({
      scope: SCOPE,
      assetId: "asset-1",
      expectedLatestVersion: 2,
      targetStatus: "revoked",
      idempotencyKey: "revoke-1",
    });

    expect(deprecated.asset).toMatchObject({ version: 2, status: "deprecated" });
    expect(revoked.asset).toMatchObject({ version: 3, status: "revoked" });
    expect(await service.read(SCOPE, "asset-1")).toMatchObject({
      asset: { status: "revoked" },
      contentValidity: "current",
    });
  });

  it("repository 和 service 均不泄漏可变对象引用", async () => {
    const repository = new InMemoryMemoryViewAssetRepository();
    const service = new MemoryViewAssetService({ repository, sourceResolver: new MutableResolver() });
    const input = publishInput();
    const result = await service.createVersion(input);

    (input.semanticTypes as string[])[0] = "experience";

    const stored = await repository.getVersion(SCOPE, "asset-1", 1);
    expect(stored?.semanticTypes).toEqual(["rules"]);
    expect(stored?.contentRef.evidenceIds).toEqual(["evidence-1"]);
    expect(Object.isFrozen(result.asset.contentRef)).toBe(true);
  });

  it("draft/review 可保存但不能伪装成 published，且禁止非 memory_view 类型", async () => {
    const service = new MemoryViewAssetService({
      repository: new InMemoryMemoryViewAssetRepository(),
    });
    const draft = await service.createVersion({
      ...publishInput(),
      targetStatus: "draft",
    });
    expect(draft.asset.status).toBe("draft");

    await expect(service.createVersion({
      ...publishInput({ idempotencyKey: "bad-kind", expectedLatestVersion: 1 }),
      kind: "skill",
    } as never)).rejects.toBeInstanceOf(MemoryViewAssetError);
  });
});
