import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planKnowledgeResourceCuration, serializeKnowledgeResourcePlan, type PlanKnowledgeResourceCurationInput } from "../../../packages/core/src/db/migrations/knowledge-resource-curation.js";
import { runMarkdownKnowledgeResourceResolution } from "../../../scripts/operator-markdown-knowledge-resource-resolution.js";
import { historyContentSha256 as sha } from "../../../packages/core/src/evolution/history/native-materials.js";
import type { LegacyKnowledgeResolutionInput } from "../../../packages/core/src/evolution/history/knowledge-resolution.js";
import { historyFixture } from "./fixture.js";
import { historyJson } from "../../../packages/core/src/evolution/history/schema.js";

export async function legacyKnowledgeFixture(): Promise<{ root: string; input: LegacyKnowledgeResolutionInput; history: ReturnType<typeof historyFixture> }> {
  const root = await mkdtemp(join(tmpdir(), "history-legacy-knowledge-offline-")), history = historyFixture();
  const sources = history.sources.filter(source => source.sourceRef.startsWith("knowledge:"));
  for (const source of sources) delete source.knowledgeIdentity;
  const hashes = { sourceManifestSha256: history.input.sourceManifestHash, sourceSnapshotSha256: sha("snapshot"), preprocessedManifestSha256: sha("preprocess"), inventoryFileSha256: sha("inventory"), inventorySemanticSha256: sha("semantic") };
  const nodes = sources.map((source, index) => ({ sourceRef: source.sourceRef, sourceHash: source.sourceHash, sourceTable: "knowledge", scopeFingerprint: source.scopeFingerprint,
    normalizedContentHash: sha(source.sourceRef), semanticTypeCandidates: [{ semanticType: "resource", confidence: 1, reason: "synthetic fixture" }], logicalSourceCandidates: [], revisionCandidates: [], ordinalCandidates: [], resourceCandidates: [], topicCandidates: [],
    routeCandidates: { source: "threshold_met", topic: "threshold_not_met", global: "threshold_not_met" }, qualityFlags: index === 0 ? ["legacy_quarantine"] : [] }));
  const createdAt = "2026-09-06T00:00:00.000Z";
  const plan = planKnowledgeResourceCuration({ runId: "knowledge-fixture", policyVersion: "knowledge-resource-curation/v1", createdAt, expectedKnowledgeSourceCount: sources.length, frozenHashes: hashes, observedHashes: hashes,
    preprocessedManifest: { schema: "mengshu.markdown-workset-preprocess-manifest/v1", migrationRunId: "knowledge-fixture", policyVersion: "markdown-preprocess/v1", createdAt, sourceCount: sources.length, ...hashes, inventorySha256: hashes.inventorySemanticSha256,
      files: sources.map((source, i) => ({ relativePath: `knowledge/${i}.md`, sourceRef: source.sourceRef, sourceHash: source.sourceHash, markdownSha256: sha(`md${i}`), nodeSha256: sha(`node${i}`) })), summary: {} },
    inventory: { schema: "mengshu.markdown-workset-preprocess/v1", sourceSnapshotSha256: hashes.sourceSnapshotSha256, policyVersion: "markdown-preprocess/v1", sourceCount: sources.length, nodes, groups: [], relationships: [], summary: {}, inventorySha256: hashes.inventorySemanticSha256 },
    sourceFacts: sources.map((source, i) => ({ sourceRef: source.sourceRef, bytes: 100, contentLength: i === 0 ? 0 : 10 })) } as unknown as PlanKnowledgeResourceCurationInput);
  const planText = serializeKnowledgeResourcePlan(plan), planPath = join(root, "plan.json"), reviewRoot = join(root, "reviews");
  await writeFile(planPath, planText); await mkdir(reviewRoot);
  for (const agent of ["agent-a", "agent-b", "agent-c"]) await mkdir(join(reviewRoot, agent));
  const arbitration = historyJson({ schema: "mengshu.knowledge-resource-arbitration/v1", planFileSha256: sha(planText), semanticPlanSha256: plan.semanticPlanSha256, createdAt, candidateOnly: true, decisions: [] });
  const arbitrationPath = join(root, "arbitration.json"); await writeFile(arbitrationPath, arbitration);
  const outputDirectory = join(root, "resolution");
  await runMarkdownKnowledgeResourceResolution({ containmentRoot: root, planPath, planFileSha256: sha(planText), reviewRoot, arbitrationPath, arbitrationFileSha256: sha(arbitration), outputDirectory, createdAt });
  const receipt = await readFile(join(outputDirectory, "receipt.json"), "utf8");
  return { root, history, input: { plan: planText, planSha256: sha(planText), receipt, receiptSha256: sha(receipt), bindings: await readFile(join(outputDirectory, "knowledge-resource-bindings.jsonl"), "utf8"), dispositions: await readFile(join(outputDirectory, "knowledge-source-dispositions.jsonl"), "utf8"), unitDecisions: await readFile(join(outputDirectory, "unit-decisions.jsonl"), "utf8"), summary: await readFile(join(outputDirectory, "resolution-summary.json"), "utf8") } };
}
