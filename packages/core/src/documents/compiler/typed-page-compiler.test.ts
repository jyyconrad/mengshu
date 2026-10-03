import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import type { MemoryScope } from "../../domain/types.js";
import {
  createDurableJobHandlerRegistry,
  createDurableJobV2,
  DURABLE_JOB_V2_DOCUMENT_COMPILE_TYPES,
  leaseDurableJobV2,
} from "../../storage/repositories/job-v2.js";
import { GovernedMarkdownVaultAdapter } from "../../vault/asset-adapter.js";
import { resolveCanonicalVaultPlacement } from "../../vault/placement.js";
import type { VaultScopeDescriptor } from "../../vault/scope.js";
import { GovernedDocumentReadService } from "../read-service.js";
import type { GovernedDocumentAssetVersion } from "../types.js";
import { GovernedDocumentAssetWriteKernel } from "../write-kernel.js";
import { createNativeCompileDocumentHandler } from "../../../../../server/native-compile-document-handler.js";
import { DurableJobV2HandlerFailure } from "../../../../../server/workers-v2.js";
import { buildTypedMemoryDocument, type TypedPageSection } from "./assemble-typed-page.js";
import { RetainedGovernedDocumentStore } from "./retained-store.js";
import { hashTypedPageSection } from "./section-hash.js";
import {
  TYPED_PAGE_PUBLISH_STAGE,
  TypedPageCompiler,
  type TypedPageSectionPatch,
} from "./typed-page-compiler.js";

const scope: MemoryScope = {
  tenantId: "tenant",
  userId: "user",
  appId: "app",
  projectId: "project",
  agentId: "agent",
  namespace: "memory",
  visibility: "private",
};
const resolutionHash = "a".repeat(64);
const policyVersion = "document-governance/v1";
const createdAt = "2026-10-03T00:00:00.000Z";

function canonicalPath(asset: GovernedDocumentAssetVersion): string {
  return resolveCanonicalVaultPlacement({
    kind: "memory_document",
    assetId: asset.assetId,
    title: asset.title,
    semanticType: asset.semanticType,
    primaryProject: "mengshu-pilot",
    primarySourceOrProject: "design-notes",
  });
}

function descriptor(rootPath: string): VaultScopeDescriptor {
  return {
    vaultId: "vault-typed",
    owner: { tenantId: scope.tenantId, userId: scope.userId },
    allowedVisibilities: ["private"],
    allowedProjectIds: [scope.projectId],
    namespace: scope.namespace,
    rootPath,
    mode: "standalone",
    profile: "governed-vault",
  };
}

function watermark(sourceId: "source_alpha" | "source_beta", revision: string) {
  return {
    sourceId,
    revision,
    payloadHash: sourceId === "source_alpha" ? "b".repeat(64) : "c".repeat(64),
  };
}

function sectionSnapshot(
  page: { asset: GovernedDocumentAssetVersion; bindings: { claimEvidence: Readonly<Record<string, readonly string[]>> } },
  sectionId: string,
) {
  const section = page.asset.content.sections.find((item) => item.id === sectionId);
  if (!section) throw new Error(`missing ${sectionId}`);
  const claims = section.claims.map((claim) => ({
    id: claim.id,
    text: claim.text,
    evidenceRefs: [...(page.bindings.claimEvidence[claim.id] ?? [])],
  }));
  return {
    sectionId: section.id,
    heading: section.heading,
    hash: hashTypedPageSection({
      sectionId: section.id,
      heading: section.heading,
      claims,
    }),
    claims,
  };
}

async function openHarness() {
  const root = await mkdtemp(join(tmpdir(), "mengshu-typed-page-"));
  const vault = descriptor(root);
  const adapter = new GovernedMarkdownVaultAdapter({ descriptor: vault });
  let commits = 0;
  const store = new RetainedGovernedDocumentStore(() => createdAt);
  const kernel = new GovernedDocumentAssetWriteKernel({
    repository: store,
    markdown: {
      commit: async (input) => {
        commits += 1;
        return adapter.commit(input);
      },
    },
  });
  const compiler = new TypedPageCompiler({
    store,
    kernel,
    vaultId: vault.vaultId,
    canonicalPath,
    policyVersion,
    resolutionHash,
    modelFingerprint: "compiler_offline",
    promptVersion: "typed-page/v1",
  });
  return {
    root,
    store,
    compiler,
    kernel,
    commits: () => commits,
    async close() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function seed(
  harness: Awaited<ReturnType<typeof openHarness>>,
  input: {
    assetId: string;
    semanticType: "task_context" | "resource";
    title: string;
    abstract: string;
    sections: readonly TypedPageSection[];
  },
) {
  const informationRefs = [...new Set(input.sections.flatMap((section) =>
    section.claims.flatMap((claim) => claim.inputRefs)))];
  const built = buildTypedMemoryDocument({
    assetId: input.assetId,
    assetVersion: 1,
    semanticType: input.semanticType,
    scope,
    title: input.title,
    abstract: input.abstract,
    sections: input.sections,
    userNotes: "保留的备注。\n",
    provenanceRefs: ["source_alpha", "source_beta"],
    sourceDispositionRefs: informationRefs,
    resolutionHash,
    policyVersion,
    createdAt,
    updatedAt: createdAt,
    sourceAssetIds: ["source_alpha"],
  });
  harness.store.putBindings(scope, input.assetId, 1, built.bindings);
  const committed = await harness.kernel.commit({
    asset: built.asset,
    vaultId: "vault-typed",
    canonicalPath: canonicalPath(built.asset),
    idempotencyKey: `seed_${input.assetId}`,
    expectedCompleteVersion: 0,
  });
  expect(committed.receipt.disposition).toBe("complete");
  return built;
}

function replaceText(section: TypedPageSection, text: string): TypedPageSectionPatch {
  const [claim, ...rest] = section.claims;
  if (!claim) throw new Error("section has no claim");
  return {
    sectionId: section.sectionId,
    heading: section.heading,
    brief: section.brief,
    claims: [{ ...claim, text }, ...rest],
  };
}

describe("typed page compiler", () => {
  test("两次更新只改受影响章节，旧 head 仍可读，漂移的 source revision 不能发布", async () => {
    const harness = await openHarness();
    try {
      const status: TypedPageSection = {
        sectionId: "sec_status",
        heading: "状态",
        brief: "当前状态",
        claims: [{
          id: "claim_status",
          text: "Alpha 已确认当前状态。",
          evidenceRefs: ["evidence_status"],
          inputRefs: ["info_status"],
        }],
      };
      const next: TypedPageSection = {
        sectionId: "sec_next",
        heading: "下一步",
        brief: "未决事项",
        claims: [{
          id: "claim_next",
          text: "Beta 记录下一步。",
          evidenceRefs: ["evidence_next"],
          inputRefs: ["info_next"],
        }],
      };
      const seeded = await seed(harness, {
        assetId: "doc_task_page",
        semanticType: "task_context",
        title: "项目状态",
        abstract: "综合 Alpha 与 Beta 两份来源的项目页。",
        sections: [status, next],
      });
      const originalNext = sectionSnapshot(seeded, "sec_next");
      const originalStatus = sectionSnapshot(seeded, "sec_status");

      const first = await harness.compiler.publish({
        scope,
        assetId: "doc_task_page",
        expectedLatestVersion: 1,
        updates: [replaceText(status, "Alpha 修订后的当前状态。")],
        plannedWatermarks: [watermark("source_alpha", "rev-2"), watermark("source_beta", "rev-1")],
        observedWatermarks: [watermark("source_alpha", "rev-2"), watermark("source_beta", "rev-1")],
        memoryForm: "fact/claim",
        compiledAt: "2026-10-03T01:00:00.000Z",
        governanceRunId: "run_task_1",
        proposalId: "proposal_task_1",
      });
      expect(first.status).toBe("published");
      if (first.status !== "published") return;
      expect(first.stage).toBe(TYPED_PAGE_PUBLISH_STAGE);
      expect(first.asset.assetVersion).toBe(2);
      expect(first.asset.semanticType).toBe("task_context");
      expect(first.proposal.memoryForm).toBe("fact/claim");
      expect(first.proposal.sourceWatermarks?.map((item) => item.sourceId)).toEqual([
        "source_alpha", "source_beta",
      ]);
      expect(first.preservedSectionIds).toEqual(["sec_next"]);
      expect(sectionSnapshot(first, "sec_next")).toEqual(originalNext);
      expect(sectionSnapshot(first, "sec_status").hash).not.toBe(originalStatus.hash);
      expect(first.asset.content.userNotes).toBe("保留的备注。\n");

      const second = await harness.compiler.publish({
        scope,
        assetId: "doc_task_page",
        expectedLatestVersion: 2,
        updates: [replaceText(next, "Beta 修订后的下一步。")],
        plannedWatermarks: [watermark("source_alpha", "rev-2"), watermark("source_beta", "rev-2")],
        observedWatermarks: [watermark("source_alpha", "rev-2"), watermark("source_beta", "rev-2")],
        memoryForm: "fact/claim",
        compiledAt: "2026-10-03T02:00:00.000Z",
        governanceRunId: "run_task_2",
        proposalId: "proposal_task_2",
        validTimeSelector: { mode: "current" },
      });
      expect(second.status).toBe("published");
      if (second.status !== "published") return;
      expect(second.asset.assetVersion).toBe(3);
      expect(second.preservedSectionIds).toEqual(["sec_status"]);
      expect(sectionSnapshot(second, "sec_status")).toEqual(sectionSnapshot(first, "sec_status"));
      expect(sectionSnapshot(second, "sec_next").sectionId).toBe("sec_next");
      expect(sectionSnapshot(second, "sec_next").hash).not.toBe(originalNext.hash);

      const versionOne = harness.compiler.read(scope, "doc_task_page", 1);
      const versionTwo = harness.compiler.read(scope, "doc_task_page", 2);
      expect(versionOne && sectionSnapshot(versionOne, "sec_status")).toEqual(originalStatus);
      expect(versionOne && sectionSnapshot(versionOne, "sec_next")).toEqual(originalNext);
      expect(versionTwo && sectionSnapshot(versionTwo, "sec_next")).toEqual(originalNext);
      expect(harness.compiler.read(scope, "doc_task_page")?.asset.assetVersion).toBe(3);

      const reader = new GovernedDocumentReadService({ repository: harness.store });
      const historical = await reader.read(scope, "doc_task_page", { assetVersion: 1 });
      const current = await reader.read(scope, "doc_task_page");
      expect(historical).toMatchObject({ kind: "document", assetVersion: 1 });
      expect(current).toMatchObject({ kind: "document", assetVersion: 3 });
      if (historical.kind === "document") {
        expect(historical.content.sections.map((section) => section.id)).toEqual([
          "sec_status", "sec_next",
        ]);
        expect(historical.content.sections[0]?.claims[0]?.text).toBe("Alpha 已确认当前状态。");
      }

      const commitsBeforeDrift = harness.commits();
      const drifted = await harness.compiler.publish({
        scope,
        assetId: "doc_task_page",
        expectedLatestVersion: 3,
        updates: [replaceText(status, "这条不该发布。")],
        plannedWatermarks: [watermark("source_alpha", "rev-3"), watermark("source_beta", "rev-2")],
        observedWatermarks: [watermark("source_alpha", "rev-2"), watermark("source_beta", "rev-2")],
        memoryForm: "fact/claim",
        compiledAt: "2026-10-03T03:00:00.000Z",
        governanceRunId: "run_task_drift",
        proposalId: "proposal_task_drift",
      });
      expect(drifted).toEqual({
        status: "stale_input",
        stage: TYPED_PAGE_PUBLISH_STAGE,
        code: "SOURCE_REVISION_DRIFT",
      });
      expect(harness.store.headVersion(scope, "doc_task_page")).toBe(3);
      expect(harness.commits()).toBe(commitsBeforeDrift);
      expect(harness.compiler.read(scope, "doc_task_page", 1)?.asset.publicContentHash)
        .toBe(seeded.asset.publicContentHash);
    } finally {
      await harness.close();
    }
  });

  test("resource 页同样只替换受影响章节，用户改过的文件不能被覆盖", async () => {
    const harness = await openHarness();
    try {
      const pointer: TypedPageSection = {
        sectionId: "sec_pointer",
        heading: "指针",
        brief: "资料位置",
        claims: [{
          id: "claim_pointer",
          text: "Alpha 指向设计说明。",
          evidenceRefs: ["evidence_pointer"],
          inputRefs: ["info_pointer"],
        }],
      };
      const usage: TypedPageSection = {
        sectionId: "sec_usage",
        heading: "用途",
        brief: "使用方式",
        claims: [{
          id: "claim_usage",
          text: "Beta 说明使用方式。",
          evidenceRefs: ["evidence_usage"],
          inputRefs: ["info_usage"],
        }],
      };
      await seed(harness, {
        assetId: "doc_resource_page",
        semanticType: "resource",
        title: "设计说明",
        abstract: "综合 Alpha 与 Beta 两份来源的资料页。",
        sections: [pointer, usage],
      });
      const first = await harness.compiler.publish({
        scope,
        assetId: "doc_resource_page",
        expectedLatestVersion: 1,
        updates: [replaceText(pointer, "Alpha 指向修订后的设计说明。")],
        plannedWatermarks: [watermark("source_alpha", "rev-2"), watermark("source_beta", "rev-1")],
        observedWatermarks: [watermark("source_alpha", "rev-2"), watermark("source_beta", "rev-1")],
        memoryForm: "fact/claim",
        compiledAt: "2026-10-03T01:00:00.000Z",
        governanceRunId: "run_resource_1",
        proposalId: "proposal_resource_1",
      });
      expect(first.status).toBe("published");
      if (first.status !== "published") return;
      const keptUsage = sectionSnapshot(first, "sec_usage");
      const second = await harness.compiler.publish({
        scope,
        assetId: "doc_resource_page",
        expectedLatestVersion: 2,
        updates: [replaceText(usage, "Beta 修订后的使用方式。")],
        plannedWatermarks: [watermark("source_alpha", "rev-2"), watermark("source_beta", "rev-2")],
        observedWatermarks: [watermark("source_alpha", "rev-2"), watermark("source_beta", "rev-2")],
        memoryForm: "fact/claim",
        compiledAt: "2026-10-03T02:00:00.000Z",
        governanceRunId: "run_resource_2",
        proposalId: "proposal_resource_2",
      });
      expect(second.status).toBe("published");
      if (second.status !== "published") return;
      expect(second.asset.semanticType).toBe("resource");
      expect(second.proposal.memoryForm).toBe("fact/claim");
      expect(sectionSnapshot(second, "sec_pointer")).toEqual(sectionSnapshot(first, "sec_pointer"));
      expect(sectionSnapshot(second, "sec_usage").hash).not.toBe(keptUsage.hash);
      expect(harness.compiler.read(scope, "doc_resource_page", 2)?.bindings.claimEvidence.claim_usage)
        .toEqual(["evidence_usage"]);

      const relativePath = canonicalPath(second.asset);
      const filePath = join(harness.root, relativePath);
      const beforeEdit = await readFile(filePath, "utf8");
      await writeFile(filePath, "用户直接改过的正文。\n");
      const refused = await harness.compiler.publish({
        scope,
        assetId: "doc_resource_page",
        expectedLatestVersion: 3,
        updates: [replaceText(pointer, "这条不该覆盖用户编辑。")],
        plannedWatermarks: [watermark("source_alpha", "rev-3"), watermark("source_beta", "rev-2")],
        observedWatermarks: [watermark("source_alpha", "rev-3"), watermark("source_beta", "rev-2")],
        memoryForm: "fact/claim",
        compiledAt: "2026-10-03T03:00:00.000Z",
        governanceRunId: "run_resource_edit",
        proposalId: "proposal_resource_edit",
      });
      expect(refused).toEqual({ status: "not_published", code: "WRITE_INCOMPLETE" });
      expect(harness.store.headVersion(scope, "doc_resource_page")).toBe(3);
      expect(await readFile(filePath, "utf8")).toBe("用户直接改过的正文。\n");
      expect(await readFile(filePath, "utf8")).not.toBe(beforeEdit);
      const reader = new GovernedDocumentReadService({ repository: harness.store });
      await expect(reader.read(scope, "doc_resource_page", { assetVersion: 1 })).resolves.toMatchObject({
        kind: "document",
        assetVersion: 1,
      });
      await expect(reader.read(scope, "doc_resource_page", { assetVersion: 2 })).resolves.toMatchObject({
        kind: "document",
        assetVersion: 2,
      });
    } finally {
      await harness.close();
    }
  });

  test("compile_document handler 把 source revision 漂移映射为不可重试失败", async () => {
    const harness = await openHarness();
    try {
      const status: TypedPageSection = {
        sectionId: "sec_status",
        heading: "状态",
        brief: "当前状态",
        claims: [{
          id: "claim_status",
          text: "Alpha 已确认当前状态。",
          evidenceRefs: ["evidence_status"],
          inputRefs: ["info_status"],
        }],
      };
      const next: TypedPageSection = {
        sectionId: "sec_next",
        heading: "下一步",
        brief: "未决事项",
        claims: [{
          id: "claim_next",
          text: "Beta 记录下一步。",
          evidenceRefs: ["evidence_next"],
          inputRefs: ["info_next"],
        }],
      };
      await seed(harness, {
        assetId: "doc_task_job",
        semanticType: "task_context",
        title: "项目状态",
        abstract: "综合 Alpha 与 Beta 两份来源的项目页。",
        sections: [status, next],
      });
      const commitsBefore = harness.commits();
      const handler = createNativeCompileDocumentHandler({ compiler: harness.compiler });
      const payload = {
        assetId: "doc_task_job",
        expectedLatestVersion: 1,
        updates: [replaceText(status, "这条不该发布。")],
        plannedWatermarks: [watermark("source_alpha", "rev-9"), watermark("source_beta", "rev-1")],
        observedWatermarks: [watermark("source_alpha", "rev-1"), watermark("source_beta", "rev-1")],
        memoryForm: "fact/claim",
        compiledAt: "2026-10-03T01:00:00.000Z",
        governanceRunId: "run_job_drift",
        proposalId: "proposal_job_drift",
      };
      const queued = createDurableJobV2({
        id: "job_compile_drift",
        type: "compile_document",
        payload,
        dedupeKey: "compile_drift",
        scope: {
          tenantId: scope.tenantId,
          userId: scope.userId,
          appId: scope.appId,
          projectId: scope.projectId,
          agentId: scope.agentId,
          namespace: scope.namespace,
          visibility: "private",
        },
        maxAttempts: 3,
      }, {
        registry: createDurableJobHandlerRegistry(DURABLE_JOB_V2_DOCUMENT_COMPILE_TYPES),
        now: 1_700_000_000_000,
      });
      const leased = leaseDurableJobV2(queued, {
        owner: "worker-a",
        now: 1_700_000_000_100,
        leaseMs: 1_000,
        tokenFactory: () => "a".repeat(32),
      }).job;
      await expect(handler(leased, {
        signal: new AbortController().signal,
        workerId: "worker-a",
      })).rejects.toEqual(new DurableJobV2HandlerFailure("SOURCE_REVISION_DRIFT", false));
      expect(harness.store.headVersion(scope, "doc_task_job")).toBe(1);
      expect(harness.commits()).toBe(commitsBefore);
      expect(DURABLE_JOB_V2_DOCUMENT_COMPILE_TYPES).not.toContain("publish_document");
    } finally {
      await harness.close();
    }
  });

  test("ms wiki 不是已注册命令，编译器本身不调用模型", () => {
    const cli = readFileSync(fileURLToPath(new URL(
      "../../../../../packages/api/src/cli/ms.ts",
      import.meta.url,
    )), "utf8");
    const compilerSource = readFileSync(fileURLToPath(new URL(
      "./typed-page-compiler.ts",
      import.meta.url,
    )), "utf8");
    expect(cli).not.toMatch(/\.command\(\s*["']wiki["']/);
    expect(cli).not.toMatch(/\bwiki\b/i);
    expect(compilerSource).not.toMatch(/extractStructured|LlmClient|temperature/);
  });
});
