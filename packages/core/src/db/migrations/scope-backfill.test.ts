import { describe, expect, test } from "vitest";
import type { MemoryAutodbRegistry } from "../../runtime/registry.js";
import { planLegacyScopeBackfill } from "./scope-backfill.js";

const registry: MemoryAutodbRegistry = {
  version: 2,
  projects: {
    "project-alpha": {
      workspaceId: "workspace-alpha",
      manifestPath: "/registry/project-alpha/manifest.json",
      canonicalRoot: "/repos/alpha",
      lastSeenRoot: "/repos/alpha",
      aliases: [
        { value: "alpha", normalized: "alpha", source: "slug" },
        { value: "梦枢", normalized: "梦枢", source: "explicit" },
      ],
    },
    "project-beta": {
      workspaceId: "workspace-beta",
      manifestPath: "/registry/project-beta/manifest.json",
      canonicalRoot: "/repos/beta",
      lastSeenRoot: "/repos/beta",
      aliases: [{ value: "beta", normalized: "beta", source: "slug" }],
    },
  },
  workspaces: {
    "workspace-alpha": { projectIds: ["project-alpha"] },
    "workspace-beta": { projectIds: ["project-beta"] },
  },
};

const registryWithExplicitDefault: MemoryAutodbRegistry = {
  ...registry,
  projects: {
    ...registry.projects,
    default: {
      workspaceId: "default",
      manifestPath: "/registry/default/manifest.json",
    },
  },
  workspaces: {
    ...registry.workspaces,
    default: { projectIds: ["default"] },
  },
};

const completeMetadata = {
  tenantId: "tenant-a",
  userId: "user-a",
  appId: "app-a",
  agentId: "agent-a",
  namespace: "memories",
  visibility: "workspace",
  productId: "mengshu",
  producerId: "codex",
};

describe("planLegacyScopeBackfill/resolved", () => {
  test("显式 default 是合法 canonical ID，配合 registry default 可 resolved", () => {
    const plan = planLegacyScopeBackfill({
      metadata: {
        tenantId: "local",
        userId: "default",
        appId: "mengshu",
        agentId: "default",
        namespace: "knowledge",
        visibility: "private",
        productId: "mengshu",
        producerId: "default",
        projectId: "default",
      },
      provenance: {},
    }, registryWithExplicitDefault);

    expect(plan).toMatchObject({
      status: "resolved",
      scope: {
        userId: "default",
        agentId: "default",
        projectId: "default",
        workspaceId: "default",
      },
      producer: { producerId: "default" },
    });
  });

  test("只用显式字段与中文 registry alias 生成 canonical scope + producer", () => {
    const plan = planLegacyScopeBackfill(
      {
        metadata: {
          ...completeMetadata,
          projectAlias: "梦枢",
          apiKey: "fake-sensitive-api-key",
        },
        provenance: { source: "agent", sourceId: "legacy-1" },
      },
      registry,
    );

    expect(plan).toMatchObject({
      status: "resolved",
      scope: {
        tenantId: "tenant-a",
        userId: "user-a",
        appId: "app-a",
        agentId: "agent-a",
        namespace: "memories",
        visibility: "workspace",
        projectId: "project-alpha",
        workspaceId: "workspace-alpha",
      },
      producer: { productId: "mengshu", producerId: "codex" },
      eligibility: {
        eligibleForRecall: true,
        eligibleForContext: true,
        eligibleForAnn: true,
      },
    });
    expect(plan.audit.originalValueHash).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.audit.registryValueHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(plan)).not.toContain("fake-sensitive-api-key");
  });

  test("source path 用 path.relative containment 解析 project，不做字符串前缀匹配", () => {
    const resolved = planLegacyScopeBackfill(
      { metadata: completeMetadata, provenance: { filePath: "/repos/alpha/src/index.ts" } },
      registry,
    );
    const prefixOnly = planLegacyScopeBackfill(
      { metadata: completeMetadata, provenance: { filePath: "/repos/alpha-copy/index.ts" } },
      registry,
    );

    expect(resolved).toMatchObject({ status: "resolved", scope: { projectId: "project-alpha" } });
    expect(prefixOnly).toMatchObject({
      status: "legacy-quarantine",
      reasonCodes: expect.arrayContaining(["unknown-project"]),
    });
  });

  test("manifest 中的显式 projectId 可解析 registry canonical project", () => {
    const plan = planLegacyScopeBackfill(
      {
        metadata: { ...completeMetadata, manifest: { projectId: "PROJECT-ALPHA" } },
        provenance: {},
      },
      registry,
    );

    expect(plan).toMatchObject({ status: "resolved", scope: { projectId: "project-alpha" } });
  });
});

describe("planLegacyScopeBackfill/quarantine", () => {
  test.each([
    { metadata: "scalar", provenance: undefined },
    { metadata: ["array"], provenance: undefined },
    { metadata: null, provenance: undefined },
    { metadata: completeMetadata, provenance: ["array"] },
    { metadata: completeMetadata, provenance: null },
  ])("metadata/provenance 非 object 时返回明确隔离码 %#", ({ metadata, provenance }) => {
    const plan = planLegacyScopeBackfill({ metadata, provenance }, registry);

    expect(plan).toMatchObject({
      status: "legacy-quarantine",
      reasonCodes: ["invalid-metadata-shape"],
      eligibility: {
        eligibleForRecall: false,
        eligibleForContext: false,
        eligibleForAnn: false,
      },
    });
    expect(plan.audit.originalValueHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("不从 source=codex 猜 tenant/user/product/producer/project 或 local/default", () => {
    const plan = planLegacyScopeBackfill(
      { metadata: { appId: "codex" }, provenance: { source: "codex" } },
      registry,
    );

    expect(plan).toMatchObject({
      status: "legacy-quarantine",
      reasonCodes: expect.arrayContaining([
        "missing-tenant-id",
        "missing-user-id",
        "missing-product-id",
        "missing-producer-id",
        "unknown-project",
      ]),
      targetPartition: "legacy-quarantine",
      eligibility: {
        eligibleForRecall: false,
        eligibleForContext: false,
        eligibleForAnn: false,
      },
    });
    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain('"tenantId":"local"');
    expect(serialized).not.toContain('"producerId":"codex"');
    expect(serialized).not.toContain('"projectId":"default"');
  });

  test("未知 project alias 进入 quarantine", () => {
    const plan = planLegacyScopeBackfill(
      { metadata: { ...completeMetadata, projectAlias: "不存在项目" }, provenance: {} },
      registry,
    );

    expect(plan).toMatchObject({
      status: "legacy-quarantine",
      reasonCodes: expect.arrayContaining(["unknown-project-reference"]),
    });
  });

  test("visibility 缺失或非法时进入 quarantine", () => {
    const { visibility: _visibility, ...withoutVisibility } = completeMetadata;
    const missing = planLegacyScopeBackfill(
      { metadata: { ...withoutVisibility, projectId: "project-alpha" }, provenance: {} },
      registry,
    );
    const invalid = planLegacyScopeBackfill(
      {
        metadata: { ...completeMetadata, visibility: "organization", projectId: "project-alpha" },
        provenance: {},
      },
      registry,
    );

    expect(missing).toMatchObject({
      status: "legacy-quarantine",
      reasonCodes: expect.arrayContaining(["missing-visibility"]),
    });
    expect(invalid).toMatchObject({
      status: "legacy-quarantine",
      reasonCodes: expect.arrayContaining(["invalid-visibility"]),
    });
  });

  test("相对 project path 不能作为证明，进入 quarantine", () => {
    const plan = planLegacyScopeBackfill(
      { metadata: completeMetadata, provenance: { cwd: "repos/alpha" } },
      registry,
    );

    expect(plan).toMatchObject({
      status: "legacy-quarantine",
      reasonCodes: expect.arrayContaining(["invalid-project-path", "unknown-project"]),
    });
  });

  test("registry project 缺失 workspace 时进入 quarantine", () => {
    const brokenRegistry: MemoryAutodbRegistry = {
      ...registry,
      projects: {
        ...registry.projects,
        "project-alpha": { ...registry.projects["project-alpha"]!, workspaceId: "" },
      },
    };
    const plan = planLegacyScopeBackfill(
      { metadata: { ...completeMetadata, projectId: "project-alpha" }, provenance: {} },
      brokenRegistry,
    );

    expect(plan).toMatchObject({
      status: "legacy-quarantine",
      reasonCodes: expect.arrayContaining(["missing-workspace-id"]),
    });
  });
});

describe("planLegacyScopeBackfill/conflict", () => {
  test("metadata/provenance 明确字段互相矛盾时返回 conflict", () => {
    const plan = planLegacyScopeBackfill(
      {
        metadata: { ...completeMetadata, projectId: "project-alpha" },
        provenance: { tenantId: "tenant-b" },
      },
      registry,
    );

    expect(plan).toMatchObject({
      status: "conflict",
      reasonCodes: expect.arrayContaining(["conflicting-tenant-id"]),
      eligibility: {
        eligibleForRecall: false,
        eligibleForContext: false,
        eligibleForAnn: false,
      },
    });
  });

  test("显式 project 与 source path 指向不同 registry project 时返回 conflict", () => {
    const plan = planLegacyScopeBackfill(
      {
        metadata: { ...completeMetadata, projectId: "project-alpha" },
        provenance: { filePath: "/repos/beta/src/index.ts" },
      },
      registry,
    );

    expect(plan).toMatchObject({
      status: "conflict",
      reasonCodes: expect.arrayContaining(["conflicting-project-evidence"]),
    });
  });

  test("显式 workspace 与 registry workspace 不同时返回 conflict", () => {
    const plan = planLegacyScopeBackfill(
      {
        metadata: {
          ...completeMetadata,
          projectId: "project-alpha",
          workspaceId: "workspace-other",
        },
        provenance: {},
      },
      registry,
    );

    expect(plan).toMatchObject({
      status: "conflict",
      reasonCodes: expect.arrayContaining(["conflicting-workspace-id"]),
    });
  });

  test("metadata/provenance visibility 不一致时返回 conflict", () => {
    const plan = planLegacyScopeBackfill(
      {
        metadata: { ...completeMetadata, projectId: "project-alpha" },
        provenance: { visibility: "private" },
      },
      registry,
    );

    expect(plan).toMatchObject({
      status: "conflict",
      reasonCodes: expect.arrayContaining(["conflicting-visibility"]),
    });
  });

  test("损坏 registry 的重复 alias 返回 conflict 而非任选一个", () => {
    const ambiguousRegistry: MemoryAutodbRegistry = {
      ...registry,
      projects: {
        ...registry.projects,
        "project-beta": {
          ...registry.projects["project-beta"]!,
          aliases: [{ value: "梦枢", normalized: "梦枢", source: "explicit" }],
        },
      },
    };
    const plan = planLegacyScopeBackfill(
      { metadata: { ...completeMetadata, projectAlias: "梦枢" }, provenance: {} },
      ambiguousRegistry,
    );

    expect(plan).toMatchObject({
      status: "conflict",
      reasonCodes: expect.arrayContaining(["registry-project-conflict"]),
    });
  });

  test("source path 同时落入嵌套 registry roots 时返回 conflict", () => {
    const nestedRegistry: MemoryAutodbRegistry = {
      ...registry,
      projects: {
        ...registry.projects,
        "project-nested": {
          workspaceId: "workspace-nested",
          manifestPath: "/registry/project-nested/manifest.json",
          canonicalRoot: "/repos/alpha/nested",
          lastSeenRoot: "/repos/alpha/nested",
        },
      },
    };
    const plan = planLegacyScopeBackfill(
      {
        metadata: completeMetadata,
        provenance: { filePath: "/repos/alpha/nested/index.ts" },
      },
      nestedRegistry,
    );

    expect(plan).toMatchObject({
      status: "conflict",
      reasonCodes: expect.arrayContaining(["conflicting-project-paths"]),
    });
  });
});

describe("planLegacyScopeBackfill/audit determinism", () => {
  test("对象 key 顺序变化不影响 plan/hash，且 audit 只保留来源与值 hash", () => {
    const first = planLegacyScopeBackfill(
      {
        metadata: { ...completeMetadata, projectId: "project-alpha", secret: "never-output" },
        provenance: { sourceId: "source-1", source: "agent" },
      },
      registry,
    );
    const second = planLegacyScopeBackfill(
      {
        metadata: {
          secret: "never-output",
          projectId: "project-alpha",
          producerId: "codex",
          productId: "mengshu",
          namespace: "memories",
          visibility: "workspace",
          agentId: "agent-a",
          appId: "app-a",
          userId: "user-a",
          tenantId: "tenant-a",
        },
        provenance: { source: "agent", sourceId: "source-1" },
      },
      registry,
    );

    expect(second).toEqual(first);
    expect(JSON.stringify(first)).not.toContain("never-output");
    expect(first.audit.evidence.every((item) => /^[a-f0-9]{64}$/.test(item.valueHash))).toBe(true);
  });
});
