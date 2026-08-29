import { parseFrontMatter } from "../ingest/front-matter.js";
import {
  canonicalizePublicContent,
  computePublicContentHash,
  validateGovernedDocumentAssetVersion,
} from "./canonical.js";
import type {
  CanonicalPublicDocumentContent,
  DocumentGovernanceState,
  DocumentLifecycleState,
  GovernedDocumentAssetVersion,
  GovernedDocumentKind,
  GovernedDocumentPurpose,
  GovernedTreeRef,
  ParsedGovernedDocumentMarkdown,
} from "./types.js";
import type { MemorySemanticType } from "../domain/types.js";

const SCHEMA = "governed_document/v1";
const GENERATED_START = "<!-- mengshu:generated:start -->";
const GENERATED_END = "<!-- mengshu:generated:end -->";
const NOTES_START = "<!-- mengshu:user-notes:start -->";
const NOTES_END = "<!-- mengshu:user-notes:end -->";
const SECTION = /^<!-- mengshu:section:([A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}) -->$/;
const CLAIM = /^<!-- mengshu:claim:([A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}) -->$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/;
const KINDS = new Set<GovernedDocumentKind>([
  "memory_document", "tree_document", "index_document",
]);
const MEMORY_PURPOSES = new Set<GovernedDocumentPurpose>(["typed_memory"]);
const TREE_PURPOSES = new Set<GovernedDocumentPurpose>(["tree_summary"]);
const INDEX_PURPOSES = new Set<GovernedDocumentPurpose>([
  "home", "type_index", "tree_index", "project_index", "topic_index",
  "source_index", "document_index", "governance_catalog",
]);
const SEMANTIC_TYPES = new Set<MemorySemanticType>([
  "profile", "task_context", "rules", "experience", "resource",
]);
const LIFECYCLE_STATES = new Set<DocumentLifecycleState>([
  "draft", "review", "active", "deprecated", "revoked",
]);
const GOVERNANCE_STATES = new Set<DocumentGovernanceState>([
  "current", "stale", "review_required", "conflicted",
]);
const COMMON_FRONTMATTER_KEYS = new Set([
  "mengshu_id", "mengshu_version", "mengshu_schema", "mengshu_kind",
  "mengshu_purpose", "mengshu_scope", "mengshu_scope_fingerprint",
  "mengshu_state", "mengshu_governance", "mengshu_public_content_hash",
  "mengshu_updated", "mengshu_projects", "mengshu_topics", "mengshu_sources",
  "mengshu_related", "aliases", "tags",
]);
const OPTIONAL_FRONTMATTER_KEYS = new Set([
  "mengshu_primary_project", "mengshu_primary_topic", "mengshu_primary_source",
]);
const MEMORY_FRONTMATTER_KEYS = new Set(["mengshu_semantic_type"]);
const TREE_FRONTMATTER_KEYS = new Set([
  "mengshu_semantic_types", "mengshu_tree_type", "mengshu_tree_level",
  "mengshu_tree_key", "mengshu_tree_node", "mengshu_seal_version",
]);

function fail(message: string): never {
  throw new Error(`INVALID_GOVERNED_MARKDOWN: ${message}`);
}

function property(
  attributes: Record<string, unknown>,
  key: string,
  expected: "string" | "number",
): string | number {
  const value = attributes[key];
  if (typeof value !== expected) fail(`${key} property is invalid`);
  return value as string | number;
}

function optionalString(attributes: Record<string, unknown>, key: string): string | undefined {
  const value = attributes[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) fail(`${key} property is invalid`);
  return value;
}

function decodeListItem(value: unknown): string {
  if (typeof value !== "string") fail("list property contains non-string item");
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const decoded = JSON.parse(value);
      if (typeof decoded === "string") return decoded;
    } catch {
      fail("list property contains invalid quoted string");
    }
  }
  return value;
}

function list(attributes: Record<string, unknown>, key: string): readonly string[] {
  const value = attributes[key];
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) fail(`${key} property is invalid`);
  return Object.freeze(value.map(decodeListItem));
}

function assertFrontmatterKeys(
  attributes: Record<string, unknown>,
  kind: GovernedDocumentKind,
): void {
  const kindKeys = kind === "memory_document"
    ? MEMORY_FRONTMATTER_KEYS
    : kind === "tree_document"
      ? TREE_FRONTMATTER_KEYS
      : new Set<string>();
  const allowed = new Set([...COMMON_FRONTMATTER_KEYS, ...OPTIONAL_FRONTMATTER_KEYS, ...kindKeys]);
  const keys = Object.keys(attributes);
  if ([...COMMON_FRONTMATTER_KEYS].some((key) => !Object.hasOwn(attributes, key)) ||
      [...kindKeys].some((key) => !Object.hasOwn(attributes, key)) ||
      keys.some((key) => !allowed.has(key))) {
    fail("frontmatter properties do not match the governed_document/v1 schema");
  }
}

function primaryValue(
  attributes: Record<string, unknown>,
  key: string,
  values: readonly string[],
): string | undefined {
  const primary = optionalString(attributes, key);
  if ((values.length === 0) !== (primary === undefined) ||
      primary !== undefined && primary !== values[0]) {
    fail(`${key} must identify the first governed member`);
  }
  return primary;
}

function scopeLabel(asset: GovernedDocumentAssetVersion): string {
  return asset.scope.projectId
    ? `project:${asset.scope.projectId}`
    : asset.scope.appId
      ? `app:${asset.scope.appId}`
      : `scope:${asset.scopeFingerprint}`;
}

function yamlScalar(value: string | number): string {
  return typeof value === "number" ? String(value) : JSON.stringify(value);
}

function yamlList(key: string, values: readonly string[]): string[] {
  return values.length === 0
    ? [`${key}:`]
    : [`${key}:`, ...values.map((value) => `  - ${JSON.stringify(value)}`)];
}

function identityLines(asset: GovernedDocumentAssetVersion): string[] {
  const projects = asset.scope.projectId ? [asset.scope.projectId] : [];
  const lines = [
    "---",
    `mengshu_id: ${yamlScalar(asset.assetId)}`,
    `mengshu_version: ${asset.assetVersion}`,
    `mengshu_schema: ${SCHEMA}`,
    `mengshu_kind: ${asset.kind}`,
    `mengshu_purpose: ${asset.purpose}`,
  ];
  if (asset.semanticType) lines.push(`mengshu_semantic_type: ${asset.semanticType}`);
  if (asset.semanticTypes) lines.push(...yamlList("mengshu_semantic_types", asset.semanticTypes));
  if (asset.treeRef) {
    lines.push(
      `mengshu_tree_type: ${asset.treeRef.treeType}`,
      `mengshu_tree_level: ${asset.treeRef.level}`,
      `mengshu_tree_key: ${yamlScalar(asset.treeRef.treeKey)}`,
      `mengshu_tree_node: ${yamlScalar(asset.treeRef.nodeId)}`,
      `mengshu_seal_version: ${asset.treeRef.sealVersion}`,
    );
  }
  lines.push(
    `mengshu_scope: ${yamlScalar(scopeLabel(asset))}`,
    `mengshu_scope_fingerprint: ${asset.scopeFingerprint}`,
    `mengshu_state: ${asset.lifecycleState}`,
    `mengshu_governance: ${asset.governanceState}`,
    `mengshu_public_content_hash: ${asset.publicContentHash}`,
    `mengshu_updated: ${yamlScalar(asset.updatedAt)}`,
    ...(projects.length > 0
      ? [`mengshu_primary_project: ${yamlScalar(projects[0]!)}`]
      : []),
    ...(asset.content.topics.length > 0
      ? [`mengshu_primary_topic: ${yamlScalar(asset.content.topics[0]!)}`]
      : []),
    ...(asset.content.sourceAssetIds.length > 0
      ? [`mengshu_primary_source: ${yamlScalar(asset.content.sourceAssetIds[0]!)}`]
      : []),
    ...yamlList("mengshu_projects", projects),
    ...yamlList("mengshu_topics", asset.content.topics),
    ...yamlList("mengshu_related", asset.content.relatedAssetIds),
    ...yamlList("mengshu_sources", asset.content.sourceAssetIds),
    ...yamlList("aliases", asset.content.aliases),
    ...yamlList("tags", asset.content.tags),
    "---",
  );
  return lines;
}

export function renderGovernedDocumentMarkdown(
  input: GovernedDocumentAssetVersion,
): string {
  const asset = validateGovernedDocumentAssetVersion(input);
  const lines = [...identityLines(asset), "", `# ${asset.content.title}`, ""];
  if (asset.content.abstract) {
    lines.push("> [!abstract]", `> ${asset.content.abstract}`, "");
  }
  lines.push(GENERATED_START);
  for (const section of asset.content.sections) {
    lines.push(`<!-- mengshu:section:${section.id} -->`, `## ${section.heading}`, "");
    for (const claim of section.claims) {
      lines.push(`<!-- mengshu:claim:${claim.id} -->`, claim.text, "");
    }
  }
  lines.push(GENERATED_END, "", NOTES_START);
  const prefix = `${lines.join("\n")}\n`;
  return `${prefix}${asset.content.userNotes}${NOTES_END}\n`;
}

function parseTitleAndAbstract(prefix: string): { title: string; abstract?: string } {
  const lines = prefix.replace(/^\n+/, "").split("\n");
  if (!lines[0]?.startsWith("# ")) fail("title heading is missing");
  const title = lines[0].slice(2);
  const abstractMarker = lines.indexOf("> [!abstract]");
  if (abstractMarker === -1) return { title };
  const abstractLines: string[] = [];
  for (let index = abstractMarker + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.startsWith("> ")) break;
    abstractLines.push(line.slice(2));
  }
  return { title, abstract: abstractLines.join("\n") };
}

function parseSections(generated: string): CanonicalPublicDocumentContent["sections"] {
  const lines = generated.replace(/^\n|\n$/g, "").split("\n");
  const sections: Array<{
    id: string;
    heading: string;
    claims: Array<{ id: string; text: string }>;
  }> = [];
  let section: typeof sections[number] | undefined;
  let index = 0;
  while (index < lines.length) {
    if (lines[index] === "") {
      index += 1;
      continue;
    }
    const sectionMatch = SECTION.exec(lines[index]!);
    if (!sectionMatch || !lines[index + 1]?.startsWith("## ")) {
      fail("generated section marker is invalid");
    }
    section = { id: sectionMatch[1]!, heading: lines[index + 1]!.slice(3), claims: [] };
    sections.push(section);
    index += 2;
    while (lines[index] === "") index += 1;
    while (index < lines.length && !SECTION.test(lines[index]!)) {
      const claimMatch = CLAIM.exec(lines[index]!);
      if (!claimMatch) fail("generated claim marker is invalid");
      index += 1;
      const claimLines: string[] = [];
      while (index < lines.length && !CLAIM.test(lines[index]!) && !SECTION.test(lines[index]!)) {
        claimLines.push(lines[index]!);
        index += 1;
      }
      while (claimLines.at(-1) === "") claimLines.pop();
      if (claimLines.length === 0) fail("claim text is missing");
      section.claims.push({ id: claimMatch[1]!, text: claimLines.join("\n") });
      while (lines[index] === "") index += 1;
    }
  }
  return sections;
}

function validateParsedIdentity(input: {
  assetId: string;
  assetVersion: number;
  kind: GovernedDocumentKind;
  purpose: GovernedDocumentPurpose;
  semanticType?: MemorySemanticType;
  semanticTypes: readonly string[];
  treeRef?: GovernedTreeRef;
  lifecycleState: DocumentLifecycleState;
  governanceState: DocumentGovernanceState;
  scopeFingerprint: string;
}): void {
  if (!SAFE_ID.test(input.assetId) || !Number.isSafeInteger(input.assetVersion) ||
      input.assetVersion < 1 || !KINDS.has(input.kind) ||
      !LIFECYCLE_STATES.has(input.lifecycleState) ||
      !GOVERNANCE_STATES.has(input.governanceState) ||
      !SHA256.test(input.scopeFingerprint)) {
    fail("identity kind or state is invalid");
  }
  if (input.kind === "memory_document") {
    if (!MEMORY_PURPOSES.has(input.purpose) || !input.semanticType ||
        !SEMANTIC_TYPES.has(input.semanticType) || input.semanticTypes.length > 0 || input.treeRef) {
      fail("memory_document kind properties are invalid");
    }
    return;
  }
  if (input.kind === "tree_document") {
    if (!TREE_PURPOSES.has(input.purpose) || input.semanticType || input.semanticTypes.length === 0 ||
        input.semanticTypes.some((item) => !SEMANTIC_TYPES.has(item as MemorySemanticType)) ||
        !input.treeRef || !["source", "topic", "global"].includes(input.treeRef.treeType) ||
        !["L1", "L2", "L3"].includes(input.treeRef.level) ||
        !SAFE_ID.test(input.treeRef.treeKey) || !SAFE_ID.test(input.treeRef.nodeId) ||
        !Number.isSafeInteger(input.treeRef.sealVersion) || input.treeRef.sealVersion < 1) {
      fail("tree_document kind properties are invalid");
    }
    return;
  }
  if (!INDEX_PURPOSES.has(input.purpose) || input.semanticType ||
      input.semanticTypes.length > 0 || input.treeRef) {
    fail("index_document kind properties are invalid");
  }
}

export function parseGovernedDocumentMarkdown(markdown: string): ParsedGovernedDocumentMarkdown {
  if (typeof markdown !== "string" || markdown.includes("\r")) fail("Markdown must use LF");
  const parsed = parseFrontMatter(markdown);
  const attributes = parsed.attributes;
  if (property(attributes, "mengshu_schema", "string") !== SCHEMA) fail("unknown schema");
  const rawKind = property(attributes, "mengshu_kind", "string") as GovernedDocumentKind;
  if (!KINDS.has(rawKind)) fail("kind is invalid");
  assertFrontmatterKeys(attributes, rawKind);
  const projects = list(attributes, "mengshu_projects");
  const topics = list(attributes, "mengshu_topics");
  const sources = list(attributes, "mengshu_sources");
  const primaryProject = primaryValue(attributes, "mengshu_primary_project", projects);
  primaryValue(attributes, "mengshu_primary_topic", topics);
  primaryValue(attributes, "mengshu_primary_source", sources);
  const declaredScope = property(attributes, "mengshu_scope", "string");
  const scopeFingerprint = property(
    attributes,
    "mengshu_scope_fingerprint",
    "string",
  ) as string;
  const expectedScope = primaryProject ? `project:${primaryProject}` : undefined;
  if (typeof declaredScope !== "string" || declaredScope.length === 0 ||
      /[\p{Cc}\r\n]/u.test(declaredScope) ||
      expectedScope !== undefined && declaredScope !== expectedScope ||
      expectedScope === undefined && declaredScope !== `scope:${scopeFingerprint}` &&
        !declaredScope.startsWith("app:")) {
    fail("mengshu_scope property is invalid");
  }
  const start = parsed.body.indexOf(GENERATED_START);
  const end = parsed.body.indexOf(GENERATED_END);
  const notesStart = parsed.body.indexOf(NOTES_START);
  const notesEnd = parsed.body.indexOf(NOTES_END);
  if (start < 0 || end <= start || notesStart <= end || notesEnd <= notesStart ||
      parsed.body.indexOf(GENERATED_START, start + 1) !== -1 ||
      parsed.body.indexOf(GENERATED_END, end + 1) !== -1 ||
      parsed.body[notesStart + NOTES_START.length] !== "\n") {
    fail("generated/user-notes marker contract is invalid");
  }
  const heading = parseTitleAndAbstract(parsed.body.slice(0, start));
  const userNotesStart = notesStart + NOTES_START.length + 1;
  const content = canonicalizePublicContent({
    ...heading,
    sections: parseSections(parsed.body.slice(start + GENERATED_START.length, end)),
    userNotes: parsed.body.slice(userNotesStart, notesEnd),
    topics,
    relatedAssetIds: list(attributes, "mengshu_related"),
    sourceAssetIds: sources,
    aliases: list(attributes, "aliases"),
    tags: list(attributes, "tags"),
  });
  const publicContentHash = property(attributes, "mengshu_public_content_hash", "string") as string;
  if (!SHA256.test(publicContentHash) || computePublicContentHash(content) !== publicContentHash) {
    fail("publicContentHash mismatch");
  }
  const kind = rawKind;
  const purpose = property(attributes, "mengshu_purpose", "string") as GovernedDocumentPurpose;
  const semanticType = optionalString(attributes, "mengshu_semantic_type") as
    MemorySemanticType | undefined;
  const rawSemanticTypes = list(attributes, "mengshu_semantic_types");
  const treeType = optionalString(attributes, "mengshu_tree_type") as GovernedTreeRef["treeType"];
  const treeRef = treeType ? {
    treeType,
    level: property(attributes, "mengshu_tree_level", "string") as GovernedTreeRef["level"],
    treeKey: property(attributes, "mengshu_tree_key", "string") as string,
    nodeId: property(attributes, "mengshu_tree_node", "string") as string,
    sealVersion: property(attributes, "mengshu_seal_version", "number") as number,
  } : undefined;
  const assetId = property(attributes, "mengshu_id", "string") as string;
  const assetVersion = property(attributes, "mengshu_version", "number") as number;
  const lifecycleState = property(attributes, "mengshu_state", "string") as DocumentLifecycleState;
  const governanceState = property(
    attributes,
    "mengshu_governance",
    "string",
  ) as DocumentGovernanceState;
  validateParsedIdentity({
    assetId,
    assetVersion,
    kind,
    purpose,
    semanticType,
    semanticTypes: rawSemanticTypes,
    treeRef,
    lifecycleState,
    governanceState,
    scopeFingerprint,
  });
  return Object.freeze({
    identity: Object.freeze({
      assetId,
      assetVersion,
      schemaVersion: 1,
      kind,
      purpose,
      ...(semanticType ? { semanticType } : {}),
      ...(rawSemanticTypes.length > 0
        ? { semanticTypes: Object.freeze(rawSemanticTypes as MemorySemanticType[]) }
        : {}),
      ...(treeRef ? { treeRef: Object.freeze(treeRef) } : {}),
      lifecycleState,
      governanceState,
      scopeFingerprint,
      publicContentHash,
    }),
    content,
  });
}
