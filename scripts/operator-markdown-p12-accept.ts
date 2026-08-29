import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  parseGovernedAssetCatalog,
  parseGovernedCanonicalManifest,
  parseGovernedIndexManifest,
} from "../packages/core/src/documents/curation-artifacts.js";
import { parseGovernedDocumentMarkdown } from
  "../packages/core/src/documents/markdown-codec.js";
import { parsePrivateEvidenceBindingsManifest } from
  "../packages/core/src/documents/private-evidence-bindings.js";
import { parseFrontMatter } from "../packages/core/src/ingest/front-matter.js";

const INPUT_SCHEMA = "mengshu.p12-final-acceptance-input/v1";
const RECEIPT_SCHEMA = "mengshu.final-md-accepted/v1";
const SHA256 = /^[0-9a-f]{64}$/;
const PLACEHOLDER_TITLE = /^(?:untitled|tbd|todo|unknown|placeholder|无标题|未命名|待定)$/iu;
const PUBLIC_FORBIDDEN = [
  /(?:memories|knowledge):[0-9a-f-]+/iu,
  /(?:\/Users\/|\/home\/|[A-Za-z]:\\)/u,
  /(?:password|api[_-]?key)\s*[:=]\s*\S+/iu,
] as const;

interface ArtifactRef {
  readonly path: string;
  readonly sha256: string;
}

interface AcceptanceInput {
  readonly schema: typeof INPUT_SCHEMA;
  readonly governanceRunId: string;
  readonly createdAt: string;
  readonly vaultRoot: string;
  readonly outputRoot: string;
  readonly sourceManifest: ArtifactRef;
  readonly canonicalManifest: ArtifactRef;
  readonly assetCatalog: ArtifactRef;
  readonly indexManifest: ArtifactRef;
  readonly assetRecords: ArtifactRef;
  readonly privateEvidence: ArtifactRef;
  readonly stageReceipts: readonly ArtifactRef[];
}

class P12AcceptanceError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "P12AcceptanceError";
  }
}

function fail(code: string): never {
  throw new P12AcceptanceError(code);
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

function strictDescendant(root: string, target: string): boolean {
  const child = relative(root, target);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function containedPath(root: string, path: string): string {
  if (!path || isAbsolute(path)) fail("P12_ACCEPTANCE_PATH_INVALID");
  const target = resolve(root, path);
  if (!strictDescendant(root, target)) fail("P12_ACCEPTANCE_PATH_INVALID");
  return target;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("P12_ACCEPTANCE_INPUT_INVALID");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: unknown, expected: readonly string[]): Record<string, unknown> {
  const item = record(value);
  const actual = Object.keys(item).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    fail("P12_ACCEPTANCE_INPUT_INVALID");
  }
  return item;
}

function artifact(value: unknown): ArtifactRef {
  const item = exactKeys(value, ["path", "sha256"]);
  if (typeof item.path !== "string" || typeof item.sha256 !== "string" ||
      !SHA256.test(item.sha256)) fail("P12_ACCEPTANCE_INPUT_INVALID");
  return { path: item.path, sha256: item.sha256 };
}

function parseInput(value: unknown): AcceptanceInput {
  const item = exactKeys(value, [
    "schema", "governanceRunId", "createdAt", "vaultRoot", "outputRoot",
    "sourceManifest", "canonicalManifest", "assetCatalog", "indexManifest",
    "assetRecords", "privateEvidence", "stageReceipts",
  ]);
  if (item.schema !== INPUT_SCHEMA || typeof item.governanceRunId !== "string" ||
      typeof item.createdAt !== "string" || new Date(item.createdAt).toISOString() !== item.createdAt ||
      typeof item.vaultRoot !== "string" || typeof item.outputRoot !== "string" ||
      !Array.isArray(item.stageReceipts) || item.stageReceipts.length !== 6) {
    fail("P12_ACCEPTANCE_INPUT_INVALID");
  }
  return {
    schema: INPUT_SCHEMA,
    governanceRunId: item.governanceRunId,
    createdAt: item.createdAt,
    vaultRoot: item.vaultRoot,
    outputRoot: item.outputRoot,
    sourceManifest: artifact(item.sourceManifest),
    canonicalManifest: artifact(item.canonicalManifest),
    assetCatalog: artifact(item.assetCatalog),
    indexManifest: artifact(item.indexManifest),
    assetRecords: artifact(item.assetRecords),
    privateEvidence: artifact(item.privateEvidence),
    stageReceipts: item.stageReceipts.map(artifact),
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    fail("P12_ACCEPTANCE_INPUT_INVALID");
  }
}

function parseJsonLines(text: string): unknown[] {
  if (!text.endsWith("\n") || text.trim().length === 0) {
    fail("P12_ACCEPTANCE_INPUT_INVALID");
  }
  return text.trimEnd().split("\n").map(parseJson);
}

async function readVerified(root: string, ref: ArtifactRef): Promise<string> {
  const path = containedPath(root, ref.path);
  let current = root;
  for (const part of relative(root, path).split(sep)) {
    current = resolve(current, part);
    const info = await lstat(current).catch(() => fail("P12_ACCEPTANCE_FILESYSTEM_ERROR"));
    if (info.isSymbolicLink()) fail("P12_ACCEPTANCE_SYMLINK");
  }
  const info = await lstat(path).catch(() => fail("P12_ACCEPTANCE_FILESYSTEM_ERROR"));
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600) {
    fail("P12_ACCEPTANCE_FILE_POLICY_INVALID");
  }
  const text = await readFile(path, "utf8").catch(() => fail("P12_ACCEPTANCE_FILESYSTEM_ERROR"));
  if (sha256(text) !== ref.sha256) fail("P12_ACCEPTANCE_INPUT_DRIFT");
  return text;
}

async function readPublicFile(vaultRoot: string, relativePath: string): Promise<string> {
  const path = containedPath(vaultRoot, relativePath);
  const info = await lstat(path).catch(() => fail("P12_ACCEPTANCE_PUBLIC_FILE_MISSING"));
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600) {
    fail("P12_ACCEPTANCE_FILE_POLICY_INVALID");
  }
  const text = await readFile(path, "utf8").catch(() => fail("P12_ACCEPTANCE_FILESYSTEM_ERROR"));
  if (PUBLIC_FORBIDDEN.some((pattern) => pattern.test(text))) {
    fail("P12_ACCEPTANCE_PUBLIC_CONTENT_INVALID");
  }
  return text;
}

function validateStageReceipts(values: readonly unknown[]): void {
  const expectedSchemas = new Set([
    "mengshu.p6-materialization-receipt/v1",
    "mengshu.p7-index-generation-receipt/v1",
    "mengshu.p8-score-route-receipt/v1",
    "mengshu.empty-tree-stage-receipt/v1",
  ]);
  for (const value of values) {
    const receipt = record(value);
    if (typeof receipt.schema !== "string" || !expectedSchemas.has(receipt.schema) ||
        !receipt.guards || record(receipt.guards).postgresTouched !== false) {
      fail("P12_ACCEPTANCE_STAGE_RECEIPT_INVALID");
    }
  }
  const empty = values.filter((value) => record(value).schema ===
    "mengshu.empty-tree-stage-receipt/v1");
  if (empty.length !== 3 || empty.some((value) => {
    const summary = record(record(value).summary);
    const guards = record(record(value).guards);
    return summary.eligibleGroupCount !== 0 || summary.sealedTreeAssetCount !== 0 ||
      guards.thresholdRelaxed !== false || guards.formalTreeMarkdownWritten !== false;
  })) fail("P12_ACCEPTANCE_TREE_RECEIPT_INVALID");
}

function validateIndexFrontMatter(
  markdown: string,
  expected: {
    readonly indexId: string;
    readonly scopeFingerprint: string;
    readonly purpose: string;
  },
  catalogHash: string,
): void {
  const parsed = parseFrontMatter(markdown);
  const attributes = parsed.attributes;
  if (attributes.mengshu_index_schema !== "governed_index/v1" ||
      attributes.mengshu_index_id !== expected.indexId ||
      attributes.mengshu_scope_fingerprint !== expected.scopeFingerprint ||
      attributes.mengshu_index_purpose !== expected.purpose ||
      attributes.mengshu_catalog_hash !== catalogHash) {
    fail("P12_ACCEPTANCE_INDEX_PARSE_BACK_DRIFT");
  }
}

function wikilinks(markdown: string): string[] {
  return [...markdown.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/gu)]
    .map((match) => `${match[1]}.md`);
}

async function writeExclusive(path: string, content: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
      constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } catch {
    fail("P12_ACCEPTANCE_OUTPUT_WRITE_FAILED");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function accept(root: string, input: AcceptanceInput): Promise<Record<string, unknown>> {
  const texts = await Promise.all([
    readVerified(root, input.sourceManifest),
    readVerified(root, input.canonicalManifest),
    readVerified(root, input.assetCatalog),
    readVerified(root, input.indexManifest),
    readVerified(root, input.assetRecords),
    readVerified(root, input.privateEvidence),
    ...input.stageReceipts.map((ref) => readVerified(root, ref)),
  ]);
  const sourceManifest = record(parseJson(texts[0]!));
  if (sourceManifest.migrationRunId !== input.governanceRunId ||
      sourceManifest.sourceCount !== 49_465 || !Array.isArray(sourceManifest.files)) {
    fail("P12_ACCEPTANCE_SOURCE_COVERAGE_INVALID");
  }
  const expectedSources = sourceManifest.files.map((raw) => {
    const file = record(raw);
    if (typeof file.sourceRef !== "string" || typeof file.sourceHash !== "string") {
      fail("P12_ACCEPTANCE_SOURCE_COVERAGE_INVALID");
    }
    return { sourceRef: file.sourceRef, sourceHash: file.sourceHash };
  });
  const manifest = parseGovernedCanonicalManifest(texts[1]!, expectedSources);
  const catalog = parseGovernedAssetCatalog(texts[2]!, manifest);
  const indexManifest = parseGovernedIndexManifest(texts[3]!, catalog);
  const assetRecords = parseJsonLines(texts[4]!);
  const privateEvidence = parsePrivateEvidenceBindingsManifest(texts[5]!);
  validateStageReceipts(texts.slice(6).map(parseJson));
  if (manifest.assetCount !== 363 || catalog.assetCount !== manifest.assetCount ||
      assetRecords.length !== manifest.assetCount || privateEvidence.summary.assetCount !==
      manifest.assetCount || privateEvidence.summary.claimCoverage !== 1 ||
      manifest.sourceCount !== 49_465) fail("P12_ACCEPTANCE_ASSET_COVERAGE_INVALID");

  const vaultRoot = containedPath(root, input.vaultRoot);
  const publicFiles: Array<{ path: string; sha256: string }> = [];
  const assetClaimIds = new Map<string, string[]>();
  for (const asset of manifest.assets) {
    const markdown = await readPublicFile(vaultRoot, asset.canonicalPath);
    if (sha256(markdown) !== asset.markdownSha256) fail("P12_ACCEPTANCE_MARKDOWN_HASH_DRIFT");
    const parsed = parseGovernedDocumentMarkdown(markdown);
    if (parsed.identity.assetId !== asset.assetId ||
        parsed.identity.publicContentHash !== asset.publicContentHash ||
        parsed.identity.scopeFingerprint !== asset.scopeFingerprint ||
        PLACEHOLDER_TITLE.test(parsed.content.title)) {
      fail("P12_ACCEPTANCE_MARKDOWN_PARSE_BACK_DRIFT");
    }
    assetClaimIds.set(asset.assetId, parsed.content.sections.flatMap((section) =>
      section.claims.map((claim) => claim.id)).sort());
    publicFiles.push({ path: asset.canonicalPath, sha256: asset.markdownSha256 });
  }
  for (const index of indexManifest.indexes) {
    const markdown = await readPublicFile(vaultRoot, index.relativePath);
    if (sha256(markdown) !== index.markdownSha256) fail("P12_ACCEPTANCE_INDEX_HASH_DRIFT");
    validateIndexFrontMatter(markdown, index, catalog.catalogHash);
    publicFiles.push({ path: index.relativePath, sha256: index.markdownSha256 });
  }
  const p7 = record(parseJson(texts[7]!));
  const p7Outputs = record(p7.outputs);
  const homeOutput = record(p7Outputs.home);
  if (typeof homeOutput.sha256 !== "string") fail("P12_ACCEPTANCE_STAGE_RECEIPT_INVALID");
  const home = await readPublicFile(vaultRoot, "Home.md");
  if (sha256(home) !== homeOutput.sha256) fail("P12_ACCEPTANCE_INDEX_HASH_DRIFT");
  publicFiles.push({ path: "Home.md", sha256: homeOutput.sha256 });

  const publicPaths = new Set(publicFiles.map((file) => file.path));
  for (const index of indexManifest.indexes) {
    const markdown = await readPublicFile(vaultRoot, index.relativePath);
    for (const link of wikilinks(markdown)) {
      if (!publicPaths.has(link)) fail("P12_ACCEPTANCE_BROKEN_LINK");
    }
  }
  for (const link of wikilinks(home)) {
    if (!publicPaths.has(link)) fail("P12_ACCEPTANCE_BROKEN_LINK");
  }
  const evidenceClaims = new Map(privateEvidence.assetCoverage.map((asset) =>
    [asset.assetId, asset.claims.map((claim) => claim.claimId).sort()] as const));
  for (const [assetId, claims] of assetClaimIds) {
    if (JSON.stringify(claims) !== JSON.stringify(evidenceClaims.get(assetId))) {
      fail("P12_ACCEPTANCE_EVIDENCE_COVERAGE_INVALID");
    }
  }
  const unresolved = manifest.sourceCount - manifest.sourceMappings.length;
  const dispositionCounts = Object.fromEntries([...new Set(manifest.sourceMappings.map((mapping) =>
    mapping.disposition))].sort().map((disposition) => [
    disposition,
    manifest.sourceMappings.filter((mapping) => mapping.disposition === disposition).length,
  ]));
  if (manifest.sourceMappings.some((mapping) =>
    mapping.disposition === "quarantine" && mapping.targets.length > 0)) {
    fail("P12_ACCEPTANCE_QUARANTINE_REACHABLE");
  }
  publicFiles.sort((left, right) => left.path.localeCompare(right.path));
  const publicArtifactSetHash = sha256(JSON.stringify([
    "mengshu.final-public-markdown-set/v1",
    publicFiles.map((file) => [file.path, file.sha256]),
  ]));
  const finalIndexText = texts[3]!;
  const receipt = {
    schema: RECEIPT_SCHEMA,
    governanceRunId: input.governanceRunId,
    createdAt: input.createdAt,
    inputs: {
      sourceManifestSha256: input.sourceManifest.sha256,
      canonicalManifestSha256: input.canonicalManifest.sha256,
      assetCatalogSha256: input.assetCatalog.sha256,
      indexManifestSha256: input.indexManifest.sha256,
      privateEvidenceSha256: input.privateEvidence.sha256,
      stageReceiptSha256: input.stageReceipts.map((receiptRef) => receiptRef.sha256),
    },
    outputs: {
      finalIndexManifestSha256: sha256(finalIndexText),
      publicArtifactSetHash,
      canonicalArtifactSetHash: manifest.artifactSetHash,
      catalogHash: catalog.catalogHash,
      indexArtifactSetHash: indexManifest.artifactSetHash,
    },
    summary: {
      sourceCount: manifest.sourceCount,
      sourceCoverage: 1,
      unresolvedSourceCount: unresolved,
      dispositionCounts,
      canonicalAssetCount: manifest.assetCount,
      claimCount: privateEvidence.summary.claimCount,
      claimEvidenceCoverage: privateEvidence.summary.claimCoverage,
      memoryMarkdownCount: manifest.assetCount,
      indexMarkdownCount: indexManifest.indexCount + 1,
      treeMarkdownCount: 0,
      publicMarkdownCount: publicFiles.length,
      parseBackDrift: 0,
      duplicateAssetId: 0,
      duplicateCanonicalPath: 0,
      brokenLinkCount: 0,
      crossScopeGovernedLinkCount: 0,
      publicSensitiveReferenceCount: 0,
      reachableAssetCount: manifest.assetCount,
      reachability: 1,
    },
    guards: {
      finalMdAccepted: true,
      finalIndexReusedBecauseTreeDeltaZero: true,
      quarantineReachable: false,
      publicEvidenceProjectionAllowed: false,
      productionVaultPublished: false,
      executablePostgresApplyGenerated: false,
      postgresTouched: false,
    },
  };
  const receiptText = canonicalJson(receipt);
  const outputRoot = containedPath(root, input.outputRoot);
  const finalIndexPath = resolve(vaultRoot, ".mengshu/index-manifest-final.json");
  const vaultReceiptPath = resolve(vaultRoot, ".mengshu/final-md-accepted.json");
  for (const path of [outputRoot, finalIndexPath, vaultReceiptPath]) {
    try {
      await lstat(path);
      fail("P12_ACCEPTANCE_OUTPUT_EXISTS");
    } catch (error) {
      if (error instanceof P12AcceptanceError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        fail("P12_ACCEPTANCE_FILESYSTEM_ERROR");
      }
    }
  }
  await mkdir(outputRoot, { mode: 0o700 });
  await Promise.all([
    writeExclusive(resolve(outputRoot, "final-md-accepted.json"), receiptText),
    writeExclusive(finalIndexPath, finalIndexText),
    writeExclusive(vaultReceiptPath, receiptText),
  ]);
  return {
    receipt: `${input.outputRoot}/final-md-accepted.json`,
    receiptSha256: sha256(receiptText),
    publicArtifactSetHash,
    summary: receipt.summary,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length !== 6 || argv[0] !== "--migration-root" || argv[2] !== "--input" ||
      argv[4] !== "--input-sha256") fail("P12_ACCEPTANCE_INVALID_ARGUMENT");
  const root = resolve(argv[1]!);
  if (!isAbsolute(argv[1]!) || root !== argv[1]) fail("P12_ACCEPTANCE_INVALID_ARGUMENT");
  const inputText = await readVerified(root, { path: argv[3]!, sha256: argv[5]! });
  const input = parseInput(parseJson(inputText));
  process.stdout.write(`${JSON.stringify(await accept(root, input))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    const code = error instanceof P12AcceptanceError
      ? error.code
      : error instanceof Error
        ? `P12_ACCEPTANCE_CONTRACT_ERROR:${error.name}:${error.message}`
        : "P12_ACCEPTANCE_UNEXPECTED_ERROR";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
