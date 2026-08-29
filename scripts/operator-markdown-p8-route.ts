import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import type { MemorySemanticType } from "../packages/core/src/domain/types.js";
import {
  parseGovernedAssetCatalog,
  parseGovernedCanonicalManifest,
} from "../packages/core/src/documents/curation-artifacts.js";
import {
  computeImportanceWithBreakdown,
  detectExplicitSave,
} from "../packages/core/src/scoring/importance-score.js";
import { SCORING_WEIGHTS_V1 } from "../packages/core/src/scoring/scoring-weights.js";
import { computeValueScoreWithBreakdown } from "../packages/core/src/scoring/value-score.js";
import { routeLeaf } from "../packages/core/src/tree/leaf-routing.js";
import { computeHotness, TOPIC_CREATION_THRESHOLD } from "../packages/core/src/tree/topic.js";
import { normalizeTopicLabel } from "../packages/core/src/tree/tree-fan-out.js";
import type { GraphEntityRecord } from "../packages/core/src/graph/types.js";
import type { GovernedDocumentAssetVersion } from "../packages/core/src/documents/types.js";

const ROUTE_SCHEMA = "mengshu.p8-asset-route-receipt/v1";
const TOPIC_REGISTRY_SCHEMA = "mengshu.p8-topic-registry/v1";
const SOURCE_REGISTRY_SCHEMA = "mengshu.p8-source-registry/v1";
const RECEIPT_SCHEMA = "mengshu.p8-score-route-receipt/v1";
const SHA256 = /^[0-9a-f]{64}$/;

interface ArtifactRef {
  readonly path: string;
  readonly sha256: string;
}

interface InventoryTopic {
  readonly key: string;
  readonly confidence: number;
}

interface InventorySourceIdentity {
  readonly identity: string;
  readonly confidence: number;
}

interface InventoryNode {
  readonly sourceRef: string;
  readonly topicCandidates: readonly InventoryTopic[];
  readonly logicalSourceCandidates: readonly InventorySourceIdentity[];
  readonly routeCandidates: { readonly importance?: number };
}

interface RouteDraft {
  readonly asset: GovernedDocumentAssetVersion;
  readonly sources: readonly string[];
  readonly valueScore: ReturnType<typeof computeValueScoreWithBreakdown>;
  readonly importance: ReturnType<typeof computeImportanceWithBreakdown>;
  readonly salienceInput: number;
  readonly topicKeys: readonly string[];
  readonly sourceIdentityHash: string | null;
  readonly requestedTreeTypes: readonly string[];
  readonly routeReason: string;
}

class P8RouteError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "P8RouteError";
  }
}

function fail(code: string): never {
  throw new P8RouteError(code);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function canonicalLine(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function strictDescendant(root: string, target: string): boolean {
  const child = relative(root, target);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function containedPath(root: string, path: string): string {
  if (!path || isAbsolute(path)) fail("P8_ROUTE_PATH_INVALID");
  const target = resolve(root, path);
  if (!strictDescendant(root, target)) fail("P8_ROUTE_PATH_INVALID");
  return target;
}

async function readVerified(root: string, ref: ArtifactRef): Promise<string> {
  if (!SHA256.test(ref.sha256)) fail("P8_ROUTE_INPUT_INVALID");
  const path = containedPath(root, ref.path);
  let current = root;
  for (const part of relative(root, path).split(sep)) {
    current = resolve(current, part);
    const info = await lstat(current).catch(() => fail("P8_ROUTE_FILESYSTEM_ERROR"));
    if (info.isSymbolicLink()) fail("P8_ROUTE_SYMLINK");
  }
  const text = await readFile(path, "utf8").catch(() => fail("P8_ROUTE_FILESYSTEM_ERROR"));
  if (sha256(text) !== ref.sha256) fail("P8_ROUTE_INPUT_DRIFT");
  return text;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    fail("P8_ROUTE_INPUT_INVALID");
  }
}

function parseJsonLines(text: string): unknown[] {
  if (!text.endsWith("\n") || text.trim().length === 0) fail("P8_ROUTE_INPUT_INVALID");
  return text.trimEnd().split("\n").map(parseJson);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("P8_ROUTE_INPUT_INVALID");
  }
  return value as Record<string, unknown>;
}

function specificity(text: string): number {
  return [/[A-Za-z_$][\w$]{2,}/, /\d/, /[\\/][\w.-]+/, /\.[A-Za-z]{1,6}\b/, /`[^`]+`/]
    .some((pattern) => pattern.test(text)) ? 0.8 : 0.3;
}

function candidateTopics(sourceRefs: readonly string[], nodes: ReadonlyMap<string, InventoryNode>): string[] {
  const support = new Map<string, Set<string>>();
  for (const sourceRef of sourceRefs) {
    for (const topic of nodes.get(sourceRef)?.topicCandidates ?? []) {
      if (topic.confidence < 0.8) continue;
      const key = normalizeTopicLabel(topic.key);
      if (!key || key.includes("/") || key.includes("\\")) continue;
      const refs = support.get(key) ?? new Set<string>();
      refs.add(sourceRef);
      support.set(key, refs);
    }
  }
  return [...support.entries()].filter(([, refs]) => refs.size >= Math.min(2, sourceRefs.length))
    .sort((left, right) => right[1].size - left[1].size || left[0].localeCompare(right[0]))
    .slice(0, 3).map(([key]) => key);
}

function sourceIdentity(sourceRefs: readonly string[], nodes: ReadonlyMap<string, InventoryNode>): string | null {
  const support = new Map<string, Set<string>>();
  for (const sourceRef of sourceRefs) {
    for (const candidate of nodes.get(sourceRef)?.logicalSourceCandidates ?? []) {
      if (candidate.confidence < 0.8) continue;
      const refs = support.get(candidate.identity) ?? new Set<string>();
      refs.add(sourceRef);
      support.set(candidate.identity, refs);
    }
  }
  const winner = [...support.entries()].filter(([, refs]) =>
    refs.size >= Math.min(2, sourceRefs.length)).sort((left, right) =>
    right[1].size - left[1].size || left[0].localeCompare(right[0]))[0];
  return winner
    ? sha256(`mengshu.auditable-logical-source/v1\0${winner[0]}`)
    : null;
}

function average(values: readonly number[], fallback: number): number {
  return values.length === 0 ? fallback : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function draftFor(
  asset: GovernedDocumentAssetVersion,
  sources: readonly string[],
  nodes: ReadonlyMap<string, InventoryNode>,
): RouteDraft {
  const text = asset.content.sections.flatMap((section) =>
    section.claims.map((claim) => claim.text)).join("\n");
  const explicit = detectExplicitSave(text);
  const valueScore = computeValueScoreWithBreakdown({
    explicitness: explicit ? 1 : 0,
    durability: 1,
    actionability: SCORING_WEIGHTS_V1.typePrior[asset.semanticType!],
    specificity: specificity(text),
    evidence: SCORING_WEIGHTS_V1.sourceAuthority.session_user,
    scopeFit: 0.9,
    novelty: 1,
    riskPenalty: 0,
  });
  const salienceInput = average(sources.map((sourceRef) =>
    nodes.get(sourceRef)?.routeCandidates.importance).filter(
      (value): value is number => typeof value === "number" && Number.isFinite(value),
    ), 0.5);
  const importance = computeImportanceWithBreakdown({
    salience_llm: salienceInput,
    sourceKind: "session_user",
    explicitSave: explicit,
    semanticType: asset.semanticType!,
  });
  const topicKeys = asset.semanticType === "profile" ? [] : candidateTopics(sources, nodes);
  const route = routeLeaf({
    valueScore: valueScore.score,
    importance: importance.score,
    semanticType: asset.semanticType,
    hasTopicLabel: topicKeys.length > 0,
    scopeVisibility: "project",
    explicitGlobal: false,
    isWorkspaceRule: false,
    riskFlags: [],
  });
  return {
    asset,
    sources,
    valueScore,
    importance,
    salienceInput,
    topicKeys,
    sourceIdentityHash: sourceIdentity(sources, nodes),
    requestedTreeTypes: route.treeTypes,
    routeReason: route.reason,
  };
}

function topicRegistry(drafts: readonly RouteDraft[], now: number): readonly Record<string, unknown>[] {
  const groups = new Map<string, RouteDraft[]>();
  for (const draft of drafts) {
    for (const topic of draft.topicKeys) {
      const key = `${draft.asset.scopeFingerprint}:${topic}`;
      groups.set(key, [...(groups.get(key) ?? []), draft]);
    }
  }
  return [...groups.entries()].map(([groupKey, members]) => {
    const separator = groupKey.indexOf(":");
    const scopeFingerprint = groupKey.slice(0, separator);
    const topicKey = groupKey.slice(separator + 1);
    const uniqueAssets = [...new Set(members.map((member) => member.asset.assetId))].sort();
    const entity: GraphEntityRecord = {
      id: `topic_${sha256(groupKey).slice(0, 32)}`,
      scope: members[0]!.asset.scope,
      canonicalName: topicKey,
      displayName: topicKey,
      type: "concept",
      aliases: [],
      mentionCount: uniqueAssets.length,
      mentionCount30d: uniqueAssets.length,
      distinctSourceCount: uniqueAssets.length,
      lastSeenAt: now,
      hotness: 0,
      graphCentrality: 0,
      queryHits30d: 0,
      status: "active",
      createdAt: now,
      updatedAt: now,
      metadata: {},
    };
    const hotness = computeHotness(entity, now);
    return {
      schema: "mengshu.p8-topic-registry-entry/v1",
      topicId: entity.id,
      scopeFingerprint,
      topicKey,
      memberAssetIds: uniqueAssets,
      mentionCount30d: uniqueAssets.length,
      distinctCanonicalAssetCount: uniqueAssets.length,
      queryHits30d: 0,
      graphCentrality: 0,
      hotness,
      treeEligible: hotness >= TOPIC_CREATION_THRESHOLD && uniqueAssets.length >= 2,
    };
  }).sort((left, right) => String(left.scopeFingerprint).localeCompare(
    String(right.scopeFingerprint),
  ) || String(left.topicKey).localeCompare(String(right.topicKey)));
}

function sourceRegistry(drafts: readonly RouteDraft[]): readonly Record<string, unknown>[] {
  const groups = new Map<string, RouteDraft[]>();
  for (const draft of drafts) {
    if (!draft.sourceIdentityHash) continue;
    const key = `${draft.asset.scopeFingerprint}:${draft.sourceIdentityHash}`;
    groups.set(key, [...(groups.get(key) ?? []), draft]);
  }
  return [...groups.entries()].map(([key, members]) => {
    const separator = key.indexOf(":");
    const scopeFingerprint = key.slice(0, separator);
    const sourceIdentityHash = key.slice(separator + 1);
    const memberAssetIds = [...new Set(members.map((member) => member.asset.assetId))].sort();
    return {
      schema: "mengshu.p8-source-registry-entry/v1",
      sourceGroupId: `source_group_${sha256(key).slice(0, 32)}`,
      scopeFingerprint,
      sourceIdentityHash,
      memberAssetIds,
      assetCount: memberAssetIds.length,
      treeEligible: memberAssetIds.length >= 2,
      rawIdentityEmitted: false,
    };
  }).sort((left, right) => String(left.scopeFingerprint).localeCompare(
    String(right.scopeFingerprint),
  ) || String(left.sourceIdentityHash).localeCompare(String(right.sourceIdentityHash)));
}

async function writeExclusive(path: string, text: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
      constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } catch {
    fail("P8_ROUTE_OUTPUT_WRITE_FAILED");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flags = [
    "--migration-root", "--canonical-manifest", "--canonical-manifest-sha256",
    "--asset-catalog", "--asset-catalog-sha256", "--asset-records",
    "--asset-records-sha256", "--inventory", "--inventory-sha256", "--output-root",
    "--created-at",
  ];
  if (argv.length !== flags.length * 2 || flags.some((flag, index) => argv[index * 2] !== flag)) {
    fail("P8_ROUTE_INVALID_ARGUMENT");
  }
  const root = resolve(argv[1]!);
  if (!isAbsolute(argv[1]!) || root !== argv[1]) fail("P8_ROUTE_INVALID_ARGUMENT");
  const createdAt = argv[21]!;
  if (new Date(createdAt).toISOString() !== createdAt) fail("P8_ROUTE_INVALID_ARGUMENT");
  const refs = {
    manifest: { path: argv[3]!, sha256: argv[5]! },
    catalog: { path: argv[7]!, sha256: argv[9]! },
    records: { path: argv[11]!, sha256: argv[13]! },
    inventory: { path: argv[15]!, sha256: argv[17]! },
  };
  const outputRoot = containedPath(root, argv[19]!);
  try {
    await lstat(outputRoot);
    fail("P8_ROUTE_OUTPUT_EXISTS");
  } catch (error) {
    if (error instanceof P8RouteError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail("P8_ROUTE_FILESYSTEM_ERROR");
  }
  const [manifestText, catalogText, recordsText, inventoryText] = await Promise.all([
    readVerified(root, refs.manifest), readVerified(root, refs.catalog),
    readVerified(root, refs.records), readVerified(root, refs.inventory),
  ]);
  const manifest = parseGovernedCanonicalManifest(manifestText);
  const catalog = parseGovernedAssetCatalog(catalogText, manifest);
  const assets = parseJsonLines(recordsText).map((value) => value as GovernedDocumentAssetVersion);
  const assetById = new Map(assets.map((asset) => [asset.assetId, asset] as const));
  const inventory = record(parseJson(inventoryText));
  if (!Array.isArray(inventory.nodes)) fail("P8_ROUTE_INPUT_INVALID");
  const nodes = new Map<string, InventoryNode>();
  for (const raw of inventory.nodes) {
    const node = record(raw) as unknown as InventoryNode;
    if (typeof node.sourceRef !== "string" || !Array.isArray(node.topicCandidates) ||
        !Array.isArray(node.logicalSourceCandidates)) fail("P8_ROUTE_INPUT_INVALID");
    nodes.set(node.sourceRef, node);
  }
  const drafts = catalog.assets.map((catalogAsset) => {
    const asset = assetById.get(catalogAsset.assetId);
    if (!asset) fail("P8_ROUTE_ASSET_COVERAGE_INVALID");
    return draftFor(asset, catalogAsset.sources.map((source) => source.sourceRef), nodes);
  }).sort((left, right) => left.asset.assetId.localeCompare(right.asset.assetId));
  const now = Date.parse(createdAt);
  const topics = topicRegistry(drafts, now);
  const sources = sourceRegistry(drafts);
  const eligibleTopics = new Set(topics.filter((topic) => topic.treeEligible === true)
    .map((topic) => `${topic.scopeFingerprint}:${topic.topicKey}`));
  const eligibleSources = new Set(sources.filter((source) => source.treeEligible === true)
    .map((source) => `${source.scopeFingerprint}:${source.sourceIdentityHash}`));
  const routes = drafts.map((draft) => {
    const sourceEligible = draft.sourceIdentityHash !== null && eligibleSources.has(
      `${draft.asset.scopeFingerprint}:${draft.sourceIdentityHash}`,
    );
    const topicKeys = draft.topicKeys.filter((topic) => eligibleTopics.has(
      `${draft.asset.scopeFingerprint}:${topic}`,
    ));
    const materializedTreeTypes = [
      ...(draft.requestedTreeTypes.includes("source") && sourceEligible ? ["source"] : []),
      ...(draft.requestedTreeTypes.includes("topic") && topicKeys.length > 0 ? ["topic"] : []),
      ...(draft.requestedTreeTypes.includes("global") ? ["global"] : []),
    ];
    return {
      schema: ROUTE_SCHEMA,
      assetId: draft.asset.assetId,
      assetVersion: draft.asset.assetVersion,
      scopeFingerprint: draft.asset.scopeFingerprint,
      semanticType: draft.asset.semanticType,
      valueScore: draft.valueScore.score,
      valueScoreBreakdown: draft.valueScore.breakdown,
      valueScoreProvenance: {
        evidence: "session_user_authority",
        novelty: "p5_exact_and_semantic_governance_complete",
        scopeFit: "exact_project_scope",
        risk: "quarantine_excluded_before_p8",
      },
      importance: draft.importance.score,
      importanceBreakdown: draft.importance.breakdown,
      importanceProvenance: {
        salienceInput: draft.salienceInput,
        salienceSource: "frozen_legacy_importance_as_p8_salience_input",
        sourceKind: "session_user",
      },
      sourceIdentityHash: draft.sourceIdentityHash,
      sourceTreeEligible: sourceEligible,
      candidateTopicKeys: draft.topicKeys,
      topicTreeKeys: topicKeys,
      requestedTreeTypes: draft.requestedTreeTypes,
      materializedTreeTypes,
      globalTreeEligible: materializedTreeTypes.includes("global"),
      reason: draft.routeReason,
      thresholds: {
        sourceValueScore: 0.55,
        topicValueScore: 0.70,
        topicImportance: 0.55,
        globalImportance: 0.85,
        topicHotness: TOPIC_CREATION_THRESHOLD,
      },
    };
  });
  const routeText = `${routes.map(canonicalLine).join("\n")}\n`;
  const topicText = canonicalJson({
    schema: TOPIC_REGISTRY_SCHEMA,
    createdAt,
    catalogHash: catalog.catalogHash,
    topics,
  });
  const sourceText = canonicalJson({
    schema: SOURCE_REGISTRY_SCHEMA,
    createdAt,
    catalogHash: catalog.catalogHash,
    sources,
  });
  const receipt = {
    schema: RECEIPT_SCHEMA,
    createdAt,
    inputs: {
      canonicalManifestSha256: refs.manifest.sha256,
      assetCatalogSha256: refs.catalog.sha256,
      assetRecordsSha256: refs.records.sha256,
      inventorySha256: refs.inventory.sha256,
    },
    summary: {
      assetCount: routes.length,
      scoredAssetCount: routes.length,
      admittedAssetCount: routes.filter((route) => route.valueScore >= 0.55).length,
      sourceRoutedAssetCount: routes.filter((route) => route.sourceTreeEligible).length,
      sourceGroupCount: sources.length,
      sourceEligibleGroupCount: sources.filter((source) => source.treeEligible === true).length,
      topicCandidateCount: topics.length,
      topicEligibleCount: topics.filter((topic) => topic.treeEligible === true).length,
      topicRoutedAssetCount: routes.filter((route) => route.topicTreeKeys.length > 0).length,
      globalRoutedAssetCount: routes.filter((route) => route.globalTreeEligible).length,
      profileTopicRouteCount: routes.filter((route) =>
        route.semanticType === "profile" && route.topicTreeKeys.length > 0).length,
      routeCoverage: 1,
    },
    guards: {
      rawLogicalSourceIdentityEmitted: false,
      exactDuplicateRowsCountAsIndependentHotness: false,
      profileTopicRoutingAllowed: false,
      postgresTouched: false,
    },
  };
  const receiptText = canonicalJson(receipt);
  await mkdir(outputRoot, { mode: 0o700 });
  await Promise.all([
    writeExclusive(resolve(outputRoot, "asset-route-receipts.jsonl"), routeText),
    writeExclusive(resolve(outputRoot, "topic-registry.json"), topicText),
    writeExclusive(resolve(outputRoot, "source-registry.json"), sourceText),
    writeExclusive(resolve(outputRoot, "receipt.json"), receiptText),
  ]);
  process.stdout.write(`${JSON.stringify({
    receipt: `${argv[19]}/receipt.json`,
    receiptSha256: sha256(receiptText),
    outputs: {
      routesSha256: sha256(routeText),
      topicsSha256: sha256(topicText),
      sourcesSha256: sha256(sourceText),
    },
    summary: receipt.summary,
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    const code = error instanceof P8RouteError
      ? error.code
      : error instanceof Error
        ? `P8_ROUTE_CONTRACT_ERROR:${error.name}:${error.message}`
        : "P8_ROUTE_UNEXPECTED_ERROR";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
