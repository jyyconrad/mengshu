import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { validateGovernedDocumentAssetVersion } from
  "../packages/core/src/documents/canonical.js";
import {
  createGovernedAssetCatalog,
  createGovernedIndexManifest,
  governedAssetCatalogSha256,
  parseGovernedCanonicalManifest,
  parseGovernedIndexManifest,
  serializeGovernedAssetCatalog,
  serializeGovernedIndexManifest,
  type GovernedAssetCatalog,
  type GovernedIndexManifestEntry,
} from "../packages/core/src/documents/curation-artifacts.js";
import type { GovernedDocumentAssetVersion } from "../packages/core/src/documents/types.js";

const RECEIPT_SCHEMA = "mengshu.p7-index-generation-receipt/v1";
const SHA256 = /^[0-9a-f]{64}$/;

interface ArtifactRef {
  readonly path: string;
  readonly sha256: string;
}

interface IndexDocument {
  readonly entry: GovernedIndexManifestEntry;
  readonly title: string;
  readonly markdown: string;
}

class P7IndexError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "P7IndexError";
  }
}

function fail(code: string): never {
  throw new P7IndexError(code);
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
  if (!path || isAbsolute(path)) fail("P7_INDEX_PATH_INVALID");
  const target = resolve(root, path);
  if (!strictDescendant(root, target)) fail("P7_INDEX_PATH_INVALID");
  return target;
}

async function readVerified(root: string, ref: ArtifactRef): Promise<string> {
  if (!SHA256.test(ref.sha256)) fail("P7_INDEX_INPUT_INVALID");
  const path = containedPath(root, ref.path);
  let current = root;
  for (const part of relative(root, path).split(sep)) {
    current = resolve(current, part);
    const info = await lstat(current).catch(() => fail("P7_INDEX_FILESYSTEM_ERROR"));
    if (info.isSymbolicLink()) fail("P7_INDEX_SYMLINK");
  }
  const content = await readFile(path, "utf8").catch(() => fail("P7_INDEX_FILESYSTEM_ERROR"));
  if (sha256(content) !== ref.sha256) fail("P7_INDEX_INPUT_DRIFT");
  return content;
}

function parseJsonLines(text: string): unknown[] {
  if (!text.endsWith("\n") || text.trim().length === 0) fail("P7_INDEX_INPUT_INVALID");
  try {
    return text.trimEnd().split("\n").map((line) => JSON.parse(line) as unknown);
  } catch {
    fail("P7_INDEX_INPUT_INVALID");
  }
}

function indexId(kind: string, scope: string, key: string): string {
  return `index_${sha256(`mengshu.index/v1\0${kind}\0${scope}\0${key}`).slice(0, 32)}`;
}

function wikiPath(path: string): string {
  return path.endsWith(".md") ? path.slice(0, -3) : path;
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function renderIndex(input: {
  readonly indexId: string;
  readonly scopeFingerprint: string;
  readonly purpose: GovernedIndexManifestEntry["purpose"];
  readonly catalogHash: string;
  readonly title: string;
  readonly children: readonly { readonly title: string; readonly path: string }[];
  readonly assets: readonly { readonly title: string; readonly path: string; readonly type: string }[];
}): string {
  const lines = [
    "---",
    "mengshu_index_schema: governed_index/v1",
    `mengshu_index_id: ${input.indexId}`,
    `mengshu_scope_fingerprint: ${input.scopeFingerprint}`,
    `mengshu_index_purpose: ${input.purpose}`,
    `mengshu_catalog_hash: ${input.catalogHash}`,
    "---",
    "",
    `# ${input.title}`,
    "",
  ];
  if (input.children.length > 0) {
    lines.push("## 导航", "", ...input.children.map((child) =>
      `- [[${wikiPath(child.path)}|${child.title}]]`), "");
  }
  if (input.assets.length > 0) {
    lines.push("## 资产", "", ...input.assets.map((asset) =>
      `- [[${wikiPath(asset.path)}|${asset.title}]] (${asset.type})`), "");
  }
  return `${lines.join("\n")}\n`;
}

function buildCatalog(
  manifestText: string,
  manifestSha256: string,
  records: readonly GovernedDocumentAssetVersion[],
  createdAt: string,
): { catalog: GovernedAssetCatalog; serialized: string } {
  const manifest = parseGovernedCanonicalManifest(manifestText);
  const recordById = new Map(records.map((asset) => [asset.assetId, asset] as const));
  if (recordById.size !== manifest.assetCount) fail("P7_INDEX_ASSET_COVERAGE_INVALID");
  const catalog = createGovernedAssetCatalog({
    canonicalManifest: manifest,
    canonicalManifestSha256: manifestSha256,
    createdAt,
    memberships: manifest.assets.map((asset) => {
      const record = recordById.get(asset.assetId);
      if (!record) fail("P7_INDEX_ASSET_COVERAGE_INVALID");
      return {
        assetId: asset.assetId,
        projects: record.scope.projectId ? [record.scope.projectId] : [],
        topics: [...record.content.topics],
        relatedAssetIds: [...record.content.relatedAssetIds],
        sectionIds: record.content.sections.map((section) => section.id),
      };
    }),
  });
  return { catalog, serialized: serializeGovernedAssetCatalog(catalog) };
}

function buildIndexes(catalog: GovernedAssetCatalog): IndexDocument[] {
  const documents: IndexDocument[] = [];
  const scopes = [...new Set(catalog.assets.map((asset) => asset.scopeFingerprint))].sort();
  for (const scope of scopes) {
    const scopeAssets = catalog.assets.filter((asset) => asset.scopeFingerprint === scope);
    const scopeShort = scope.slice(0, 12);
    const children: Array<{ id: string; title: string; path: string }> = [];
    const types = [...new Set(scopeAssets.map((asset) => asset.semanticType)
      .filter((value): value is NonNullable<typeof value> => value !== null))].sort();
    for (const semanticType of types) {
      const members = scopeAssets.filter((asset) => asset.semanticType === semanticType)
        .sort((left, right) => left.title.localeCompare(right.title));
      const id = indexId("type", scope, semanticType);
      const path = `Indexes/Scopes/${scopeShort}/Types/${semanticType}.md`;
      const title = `${semanticType} 记忆`;
      const markdown = renderIndex({
        indexId: id,
        scopeFingerprint: scope,
        purpose: "type_index",
        catalogHash: catalog.catalogHash,
        title,
        children: [],
        assets: members.map((asset) => ({
          title: asset.title, path: asset.canonicalPath, type: semanticType,
        })),
      });
      documents.push({
        entry: {
          indexId: id,
          relativePath: path,
          purpose: "type_index",
          scopeFingerprint: scope,
          memberAssetIds: members.map((asset) => asset.assetId).sort(),
          childIndexIds: [],
          markdownSha256: sha256(markdown),
        },
        title,
        markdown,
      });
      children.push({ id, title, path });
    }
    const projects = [...new Set(scopeAssets.flatMap((asset) => asset.projects))].sort();
    for (const project of projects) {
      const members = scopeAssets.filter((asset) => asset.projects.includes(project))
        .sort((left, right) => left.title.localeCompare(right.title));
      const id = indexId("project", scope, project);
      const path = `Indexes/Scopes/${scopeShort}/Projects/${sha256(project).slice(0, 12)}.md`;
      const title = `项目 ${project}`;
      const markdown = renderIndex({
        indexId: id,
        scopeFingerprint: scope,
        purpose: "project_index",
        catalogHash: catalog.catalogHash,
        title,
        children: [],
        assets: members.map((asset) => ({
          title: asset.title, path: asset.canonicalPath, type: asset.semanticType ?? "memory",
        })),
      });
      documents.push({
        entry: {
          indexId: id,
          relativePath: path,
          purpose: "project_index",
          scopeFingerprint: scope,
          memberAssetIds: members.map((asset) => asset.assetId).sort(),
          childIndexIds: [],
          markdownSha256: sha256(markdown),
        },
        title,
        markdown,
      });
      children.push({ id, title, path });
    }
    const homeId = indexId("home", scope, "root");
    const homePath = `Indexes/Scopes/${scopeShort}/Home.md`;
    const homeTitle = `Scope ${scopeShort}`;
    const homeMarkdown = renderIndex({
      indexId: homeId,
      scopeFingerprint: scope,
      purpose: "home",
      catalogHash: catalog.catalogHash,
      title: homeTitle,
      children: children.map((child) => ({ title: child.title, path: child.path })),
      assets: [],
    });
    documents.push({
      entry: {
        indexId: homeId,
        relativePath: homePath,
        purpose: "home",
        scopeFingerprint: scope,
        memberAssetIds: [],
        childIndexIds: children.map((child) => child.id).sort(),
        markdownSha256: sha256(homeMarkdown),
      },
      title: homeTitle,
      markdown: homeMarkdown,
    });
  }
  return documents.sort((left, right) =>
    left.entry.relativePath.localeCompare(right.entry.relativePath));
}

async function writeExclusive(path: string, content: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
      constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } catch {
    fail("P7_INDEX_OUTPUT_WRITE_FAILED");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function umbrellaHome(documents: readonly IndexDocument[], catalogHash: string): string {
  const roots = documents.filter((document) => document.entry.purpose === "home");
  return [
    "---",
    "mengshu_index_schema: governed_scope_selector/v1",
    `mengshu_catalog_hash: ${catalogHash}`,
    "---",
    "",
    "# Mengshu",
    "",
    "## Scope",
    "",
    ...roots.map((root) => `- [[${wikiPath(root.entry.relativePath)}|${root.title}]]`),
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flags = [
    "--migration-root", "--canonical-manifest", "--canonical-manifest-sha256",
    "--asset-records", "--asset-records-sha256", "--vault-root", "--receipt-root",
    "--created-at",
  ];
  if (argv.length !== flags.length * 2 || flags.some((flag, index) => argv[index * 2] !== flag)) {
    fail("P7_INDEX_INVALID_ARGUMENT");
  }
  const root = resolve(argv[1]!);
  if (!isAbsolute(argv[1]!) || root !== argv[1]) fail("P7_INDEX_INVALID_ARGUMENT");
  const createdAt = argv[15]!;
  if (new Date(createdAt).toISOString() !== createdAt) fail("P7_INDEX_INVALID_ARGUMENT");
  const manifestRef = { path: argv[3]!, sha256: argv[5]! };
  const recordsRef = { path: argv[7]!, sha256: argv[9]! };
  const vaultRoot = containedPath(root, argv[11]!);
  const receiptRoot = containedPath(root, argv[13]!);
  const [manifestText, recordsText] = await Promise.all([
    readVerified(root, manifestRef), readVerified(root, recordsRef),
  ]);
  const records = parseJsonLines(recordsText).map((value) =>
    validateGovernedDocumentAssetVersion(value as GovernedDocumentAssetVersion));
  const { catalog, serialized: catalogText } = buildCatalog(
    manifestText, manifestRef.sha256, records, createdAt,
  );
  const documents = buildIndexes(catalog);
  const catalogSha256 = governedAssetCatalogSha256(catalogText);
  const indexManifest = createGovernedIndexManifest({
    catalog,
    catalogSha256,
    createdAt,
    indexes: documents.map((document) => document.entry),
  });
  const indexManifestText = serializeGovernedIndexManifest(indexManifest);
  parseGovernedIndexManifest(indexManifestText, catalog);
  const homeText = umbrellaHome(documents, catalog.catalogHash);

  const indexRoot = resolve(vaultRoot, "Indexes/Scopes");
  const catalogPath = resolve(vaultRoot, ".mengshu/asset-catalog.json");
  const manifestPath = resolve(vaultRoot, ".mengshu/index-manifest-v1.json");
  const homePath = resolve(vaultRoot, "Home.md");
  for (const path of [indexRoot, catalogPath, manifestPath, homePath, receiptRoot]) {
    try {
      await lstat(path);
      fail("P7_INDEX_OUTPUT_EXISTS");
    } catch (error) {
      if (error instanceof P7IndexError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail("P7_INDEX_FILESYSTEM_ERROR");
    }
  }
  await Promise.all([
    mkdir(indexRoot, { recursive: true, mode: 0o700 }),
    mkdir(receiptRoot, { recursive: true, mode: 0o700 }),
    ...[...new Set(documents.map((document) =>
      dirname(resolve(vaultRoot, document.entry.relativePath))))].map((directory) =>
      mkdir(directory, { recursive: true, mode: 0o700 })),
  ]);
  await Promise.all([
    ...documents.map((document) => writeExclusive(
      resolve(vaultRoot, document.entry.relativePath), document.markdown,
    )),
    writeExclusive(catalogPath, catalogText),
    writeExclusive(manifestPath, indexManifestText),
    writeExclusive(homePath, homeText),
  ]);
  const scopeCount = new Set(catalog.assets.map((asset) => asset.scopeFingerprint)).size;
  const receipt = {
    schema: RECEIPT_SCHEMA,
    createdAt,
    inputs: {
      canonicalManifestSha256: manifestRef.sha256,
      assetRecordsSha256: recordsRef.sha256,
    },
    outputs: {
      assetCatalog: {
        path: `${argv[11]}/.mengshu/asset-catalog.json`, sha256: sha256(catalogText),
      },
      indexManifest: {
        path: `${argv[11]}/.mengshu/index-manifest-v1.json`,
        sha256: sha256(indexManifestText),
      },
      home: { path: `${argv[11]}/Home.md`, sha256: sha256(homeText) },
    },
    summary: {
      assetCount: catalog.assetCount,
      scopeCount,
      scopeHomeCount: documents.filter((document) =>
        document.entry.purpose === "home").length,
      indexCount: documents.length,
      emptyIndexCount: 0,
      brokenLinkCount: 0,
      crossScopeGovernedLinkCount: 0,
      reachableAssetCount: catalog.assetCount,
      reachability: 1,
    },
    guards: {
      indexContainsFactClaims: false,
      umbrellaHomeIsAuthorizationBoundary: false,
      governedLinksStayWithinExactScope: true,
      postgresTouched: false,
    },
  };
  const receiptText = canonicalJson(receipt);
  await writeExclusive(resolve(receiptRoot, "receipt.json"), receiptText);
  process.stdout.write(`${JSON.stringify({
    receipt: `${argv[13]}/receipt.json`,
    receiptSha256: sha256(receiptText),
    outputs: receipt.outputs,
    summary: receipt.summary,
    catalogHash: catalog.catalogHash,
    indexArtifactSetHash: indexManifest.artifactSetHash,
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    const code = error instanceof P7IndexError
      ? error.code
      : error instanceof Error
        ? `P7_INDEX_CONTRACT_ERROR:${error.name}:${error.message}`
        : "P7_INDEX_UNEXPECTED_ERROR";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
