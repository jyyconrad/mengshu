/**
 * Directory governance for `ms scan`.
 *
 * The analyzer only reads Markdown and previews the same validator + admission
 * function used by memory explain. It never opens a database. `--apply` is a
 * separate step and must go through the memory write kernel.
 */

import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { MemorySemanticType } from "../domain/types.js";
import {
  explainAdmissionCandidate,
  type AdmissionExplainOutcome,
} from "../lifecycle/admission-explain.js";
import { computeCanonicalContentHash } from "../scoring/hash-utils.js";
import { redactSecrets } from "./agent-history/redaction.js";
import { FileScanner } from "./scanner/file-scanner.js";

export const DIRECTORY_SCAN_MAX_PROPOSAL_CHARS = 8000;

/** Refuse to read a single Markdown file larger than this. */
export const DIRECTORY_SCAN_MAX_FILE_BYTES = 2_000_000;

/** Preview matches `observeAuto` + `intent: remember` (persistent, salience 0.5). */
export const DIRECTORY_SCAN_PREVIEW_SALIENCE = 0.5;

export const DIRECTORY_SCAN_FILE_ROADMAP =
  "P2 reads .md and .mdx only. Code and structured files are a later phase and still have to pass admission.";

const SEMANTIC_TYPES = [
  "profile",
  "task_context",
  "rules",
  "experience",
  "resource",
] as const satisfies readonly MemorySemanticType[];

const PATH_TYPES: ReadonlyArray<readonly [MemorySemanticType, readonly string[]]> = [
  ["rules", ["rules", "policy", "policies", "agents", "claude"]],
  ["profile", ["profile", "persona"]],
  ["experience", ["experience", "retro", "postmortem", "lesson", "lessons"]],
  ["task_context", ["task", "tasks", "todo", "todos", "plan", "plans"]],
];

export interface DirectoryScanAdmission {
  outcome: "rejected" | "routed" | "skipped_duplicate" | "skipped_invalid_type";
  reasonCodes: string[];
  /** Admission route before the observeAuto active→candidate downgrade. */
  route?: string;
  /** Route that `--apply` asks the write kernel to persist. */
  persistedRoute?: string;
  rejectedReason?: string;
  valueScore?: number;
}

export interface DirectoryScanProposal {
  relativePath: string;
  filePath: string;
  extension: string;
  fingerprint: string;
  annotatedSemanticType: MemorySemanticType | null;
  /** Type after admission calibration. Invalid labels stay null. */
  semanticType: MemorySemanticType | null;
  annotationSource: "frontmatter" | "path" | "default_resource" | "invalid";
  profileDimension?: string;
  text: string;
  truncated: boolean;
  duplicateOf?: string;
  admission: DirectoryScanAdmission;
}

export interface DirectoryScanTypeCounts {
  profile: number;
  task_context: number;
  rules: number;
  experience: number;
  resource: number;
  unlabeled: number;
}

export interface DirectoryScanReport {
  mode: "dry-run" | "apply";
  directory: string;
  /** The analyzer never writes. Apply results live on `DirectoryScanApplyResult`. */
  databaseWrites: 0;
  fileCount: number;
  extensionDistribution: Record<string, number>;
  annotationDistribution: DirectoryScanTypeCounts;
  /** Semantic types of proposals that `--apply` would send to the write kernel. */
  semanticTypeDistribution: DirectoryScanTypeCounts;
  fingerprintSummary: { unique: number; duplicates: number };
  rejectionPreview: Array<{ relativePath: string; reasonCodes: string[] }>;
  proposals: DirectoryScanProposal[];
  errors: Array<{ filePath: string; error: string }>;
  admissionPreview: {
    functionName: "explainAdmissionCandidate";
    intent: "remember";
    temporality: "persistent";
    salience: 0.5;
    targetScope: "project";
    note: string;
  };
  roadmap: typeof DIRECTORY_SCAN_FILE_ROADMAP;
}

export interface DirectoryScanApplyItem {
  relativePath: string;
  status: "persisted" | "rejected" | "duplicate" | "ignored" | "error";
  reason?: string;
  memoryId?: string;
}

export interface DirectoryScanApplyResult {
  written: number;
  skipped: number;
  writerRejected: number;
  writerDuplicates: number;
  errors: number;
  items: DirectoryScanApplyItem[];
}

export interface DirectoryScanWriteResult {
  status: "persisted" | "rejected" | "duplicate" | "ignored";
  reason?: string;
  memoryId?: string;
}

export type DirectoryScanWriter = (
  proposal: DirectoryScanProposal,
) => Promise<DirectoryScanWriteResult>;

export interface AnalyzeDirectoryInput {
  directory: string;
  ignorePaths?: readonly string[];
  ignoreRules?: readonly string[];
  includeHidden?: boolean;
  /** Positive split size. Each slice is still capped at DIRECTORY_SCAN_MAX_PROPOSAL_CHARS. */
  chunkSize?: number;
}

function emptyTypeCounts(): DirectoryScanTypeCounts {
  return {
    profile: 0,
    task_context: 0,
    rules: 0,
    experience: 0,
    resource: 0,
    unlabeled: 0,
  };
}

function isSemanticType(value: string): value is MemorySemanticType {
  return (SEMANTIC_TYPES as readonly string[]).includes(value);
}

function bump(counts: DirectoryScanTypeCounts, semanticType: MemorySemanticType | null): void {
  if (semanticType === null) counts.unlabeled += 1;
  else counts[semanticType] += 1;
}

export function isDirectoryScanWritable(proposal: DirectoryScanProposal): boolean {
  return proposal.admission.outcome === "routed"
    && proposal.semanticType !== null
    && proposal.admission.route !== "drop";
}

function splitFrontmatter(content: string): { fields: Record<string, string>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match || match.index !== 0) return { fields: {}, body: content };
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) fields[key] = value;
  }
  return { fields, body: content.slice(match[0].length) };
}

function annotateFromPath(relativePath: string): MemorySemanticType | undefined {
  const normalized = relativePath.replace(/\\/g, "/");
  const segments = normalized.split("/");
  const base = segments.pop() ?? "";
  const stem = base.replace(/\.mdx?$/i, "").toLowerCase();
  const tokens = new Set([stem, ...segments.map((segment) => segment.toLowerCase())]);
  for (const [semanticType, names] of PATH_TYPES) {
    if (names.some((name) => tokens.has(name))) return semanticType;
  }
  return undefined;
}

function annotate(relativePath: string, fields: Record<string, string>): {
  annotatedSemanticType: MemorySemanticType | null;
  annotationSource: DirectoryScanProposal["annotationSource"];
  profileDimension?: string;
} {
  const requested = fields.semanticType?.trim();
  if (requested) {
    if (!isSemanticType(requested)) {
      return { annotatedSemanticType: null, annotationSource: "invalid" };
    }
    const profileDimension = fields.profileDimension?.trim();
    return {
      annotatedSemanticType: requested,
      annotationSource: "frontmatter",
      ...(requested === "profile" && profileDimension ? { profileDimension } : {}),
    };
  }
  const fromPath = annotateFromPath(relativePath);
  if (fromPath) {
    return { annotatedSemanticType: fromPath, annotationSource: "path" };
  }
  return { annotatedSemanticType: "resource", annotationSource: "default_resource" };
}

function slices(text: string, chunkSize: number | undefined): Array<{ text: string; truncated: boolean }> {
  const cap = chunkSize && chunkSize < DIRECTORY_SCAN_MAX_PROPOSAL_CHARS
    ? chunkSize
    : DIRECTORY_SCAN_MAX_PROPOSAL_CHARS;
  if (text.length <= cap) return [{ text, truncated: false }];
  if (!chunkSize) return [{ text: text.slice(0, cap), truncated: true }];
  const parts: Array<{ text: string; truncated: boolean }> = [];
  for (let offset = 0; offset < text.length; offset += cap) {
    parts.push({ text: text.slice(offset, offset + cap), truncated: false });
  }
  return parts;
}

function withSecretReason(
  admission: DirectoryScanAdmission,
  secretsRedacted: boolean,
): DirectoryScanAdmission {
  if (!secretsRedacted || admission.reasonCodes.includes("secrets_redacted")) return admission;
  return { ...admission, reasonCodes: [...admission.reasonCodes, "secrets_redacted"] };
}

function pathEscapesRoot(rootReal: string, candidateReal: string): boolean {
  const relative = path.relative(rootReal, candidateReal);
  return relative.length === 0
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative);
}

function persistedRoute(route: string | undefined): string | undefined {
  if (route === undefined) return undefined;
  // observeAuto never persists an active row. Preview the kernel downgrade.
  return route === "active" ? "candidate" : route;
}

function admissionFromExplain(
  explained: AdmissionExplainOutcome,
): DirectoryScanAdmission {
  if (explained.outcome === "rejected") {
    return {
      outcome: "rejected",
      reasonCodes: [...explained.reasonCodes],
      rejectedReason: explained.rejectedReason,
    };
  }
  const route = explained.admission.route;
  return {
    outcome: "routed",
    reasonCodes: [...explained.reasonCodes, `persistedRoute:${persistedRoute(route)}`],
    route,
    persistedRoute: persistedRoute(route),
    valueScore: explained.admission.valueScore,
  };
}

function displayPath(relativePath: string, index: number, count: number): string {
  return count > 1 ? `${relativePath}#${index}` : relativePath;
}

export async function analyzeDirectory(input: AnalyzeDirectoryInput): Promise<DirectoryScanReport> {
  let info;
  try {
    info = await stat(input.directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`ms scan directory does not exist: ${input.directory}`);
    }
    throw error;
  }
  if (!info.isDirectory()) {
    throw new Error(`ms scan directory is not a directory: ${input.directory}`);
  }
  const rootReal = await realpath(input.directory);

  const scanner = new FileScanner({
    ignoreRules: [...(input.ignorePaths ?? []), ...(input.ignoreRules ?? [])],
    includeHidden: input.includeHidden ?? false,
  });
  const files = [...await scanner.scan(input.directory)].sort((left, right) =>
    left.localeCompare(right, "en"));

  const extensionDistribution: Record<string, number> = { ".md": 0, ".mdx": 0 };
  const proposals: DirectoryScanProposal[] = [];
  const errors: Array<{ filePath: string; error: string }> = [];
  const seenFingerprints = new Map<string, string>();

  for (const filePath of files) {
    const extension = path.extname(filePath).toLowerCase() || "(none)";
    extensionDistribution[extension] = (extensionDistribution[extension] ?? 0) + 1;
    const relativeFile = path.relative(input.directory, filePath).split(path.sep).join("/");
    let readablePath: string;
    try {
      readablePath = await realpath(filePath);
    } catch (error) {
      errors.push({
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (pathEscapesRoot(rootReal, readablePath)) {
      errors.push({ filePath, error: "path_escapes_scan_root" });
      continue;
    }
    let fileSize = 0;
    try {
      fileSize = (await stat(readablePath)).size;
    } catch (error) {
      errors.push({
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (fileSize > DIRECTORY_SCAN_MAX_FILE_BYTES) {
      errors.push({ filePath, error: "file_too_large" });
      continue;
    }
    let content: string;
    try {
      content = await readFile(readablePath, "utf8");
    } catch (error) {
      errors.push({
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const { fields, body } = splitFrontmatter(content);
    const canonical = body.replace(/\r\n?/g, "\n").trim();
    const annotation = annotate(relativeFile, fields);
    const parts = slices(canonical, input.chunkSize);
    parts.forEach((part, index) => {
      const relativePath = displayPath(relativeFile, index, parts.length);
      const redacted = redactSecrets(part.text);
      const text = redacted.text;
      const secretsRedacted = redacted.redactedCount > 0;
      const fingerprint = computeCanonicalContentHash(text);
      const duplicateOf = seenFingerprints.get(fingerprint);
      if (duplicateOf === undefined) seenFingerprints.set(fingerprint, relativePath);

      const base = {
        relativePath,
        filePath,
        extension,
        fingerprint,
        annotatedSemanticType: annotation.annotatedSemanticType,
        annotationSource: annotation.annotationSource,
        ...(annotation.profileDimension ? { profileDimension: annotation.profileDimension } : {}),
        text,
        truncated: part.truncated,
      };

      if (duplicateOf !== undefined) {
        proposals.push({
          ...base,
          semanticType: annotation.annotatedSemanticType,
          duplicateOf,
          admission: withSecretReason({
            outcome: "skipped_duplicate",
            reasonCodes: ["fingerprint_duplicate"],
          }, secretsRedacted),
        });
        return;
      }
      if (annotation.annotationSource === "invalid" || annotation.annotatedSemanticType === null) {
        proposals.push({
          ...base,
          semanticType: null,
          admission: withSecretReason({
            outcome: "skipped_invalid_type",
            reasonCodes: ["semantic_type_invalid"],
            rejectedReason: "semantic_type_invalid",
          }, secretsRedacted),
        });
        return;
      }

      const explained = explainAdmissionCandidate({
        text,
        semanticType: annotation.annotatedSemanticType,
        temporality: "persistent",
        salience: DIRECTORY_SCAN_PREVIEW_SALIENCE,
        intent: "remember",
        crossContextual: true,
        targetScope: "project",
        ...(annotation.profileDimension ? { profileDimension: annotation.profileDimension } : {}),
        sourceText: text,
      });
      const admission = withSecretReason(admissionFromExplain(explained), secretsRedacted);
      proposals.push({
        ...base,
        semanticType: explained.semanticType ?? annotation.annotatedSemanticType,
        admission,
      });
    });
  }

  const annotationDistribution = emptyTypeCounts();
  const semanticTypeDistribution = emptyTypeCounts();
  let duplicates = 0;
  const rejectionPreview: DirectoryScanReport["rejectionPreview"] = [];
  for (const proposal of proposals) {
    bump(annotationDistribution, proposal.annotatedSemanticType);
    if (proposal.admission.outcome === "skipped_duplicate") duplicates += 1;
    if (isDirectoryScanWritable(proposal)) bump(semanticTypeDistribution, proposal.semanticType);
    const rejected = proposal.admission.outcome === "rejected"
      || proposal.admission.outcome === "skipped_invalid_type"
      || proposal.admission.route === "drop";
    if (rejected) {
      rejectionPreview.push({
        relativePath: proposal.relativePath,
        reasonCodes: [...proposal.admission.reasonCodes],
      });
    }
  }

  return {
    mode: "dry-run",
    directory: input.directory,
    databaseWrites: 0,
    fileCount: files.length,
    extensionDistribution,
    annotationDistribution,
    semanticTypeDistribution,
    fingerprintSummary: {
      unique: proposals.length - duplicates,
      duplicates,
    },
    rejectionPreview,
    proposals,
    errors,
    admissionPreview: {
      functionName: "explainAdmissionCandidate",
      intent: "remember",
      temporality: "persistent",
      salience: DIRECTORY_SCAN_PREVIEW_SALIENCE,
      targetScope: "project",
      note: "Dry-run does not read the database or embeddings, so evidence and novelty stay unknown. --apply reruns admission inside the write kernel and can still reject, drop, or dedup.",
    },
    roadmap: DIRECTORY_SCAN_FILE_ROADMAP,
  };
}

export async function applyDirectoryScan(
  report: DirectoryScanReport,
  write: DirectoryScanWriter,
): Promise<DirectoryScanApplyResult> {
  const items: DirectoryScanApplyItem[] = [];
  let written = 0;
  let skipped = 0;
  let writerRejected = 0;
  let writerDuplicates = 0;
  let errors = 0;
  for (const proposal of report.proposals) {
    if (!isDirectoryScanWritable(proposal)) {
      skipped += 1;
      continue;
    }
    try {
      const result = await write(proposal);
      if (result.status === "persisted") written += 1;
      else if (result.status === "rejected") writerRejected += 1;
      else if (result.status === "duplicate") writerDuplicates += 1;
      items.push({
        relativePath: proposal.relativePath,
        status: result.status,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.memoryId ? { memoryId: result.memoryId } : {}),
      });
    } catch (error) {
      errors += 1;
      items.push({
        relativePath: proposal.relativePath,
        status: "error",
        reason: redactSecrets(error instanceof Error ? error.message : String(error)).text,
      });
    }
  }
  return { written, skipped, writerRejected, writerDuplicates, errors, items };
}

function typeLine(counts: DirectoryScanTypeCounts): string {
  return (["profile", "task_context", "rules", "experience", "resource", "unlabeled"] as const)
    .map((key) => `${key}=${counts[key]}`)
    .join(", ");
}

export function formatDirectoryScanReport(
  report: DirectoryScanReport,
  applyResult?: DirectoryScanApplyResult,
): string {
  const extensions = Object.keys(report.extensionDistribution)
    .sort((left, right) => left.localeCompare(right, "en"))
    .map((key) => `${key}=${report.extensionDistribution[key]}`)
    .join(", ");
  const lines = [
    `Scan mode: ${applyResult ? "apply" : "dry-run"}`,
    `Directory: ${report.directory}`,
    `Files: ${report.fileCount}`,
    `Extensions: ${extensions}`,
    `Annotations: ${typeLine(report.annotationDistribution)}`,
    `Proposed semantic types: ${typeLine(report.semanticTypeDistribution)}`,
    `Fingerprints: unique=${report.fingerprintSummary.unique}, duplicates=${report.fingerprintSummary.duplicates}`,
    "Rejections:",
  ];
  if (report.rejectionPreview.length === 0) lines.push("- none");
  else {
    for (const rejection of report.rejectionPreview) {
      lines.push(`- ${rejection.relativePath}: ${rejection.reasonCodes.join(", ")}`);
    }
  }
  lines.push("Proposals:");
  if (report.proposals.length === 0) lines.push("- none");
  else {
    for (const proposal of report.proposals) {
      const semanticType = proposal.semanticType ?? "unlabeled";
      const route = proposal.admission.persistedRoute ?? proposal.admission.route ?? proposal.admission.outcome;
      lines.push(
        `- ${proposal.relativePath} semanticType=${semanticType} source=${proposal.annotationSource} route=${route} reasons=${proposal.admission.reasonCodes.join(", ")}`,
      );
    }
  }
  lines.push("Errors:");
  if (report.errors.length === 0) lines.push("- none");
  else {
    for (const error of report.errors) lines.push(`- ${error.filePath}: ${error.error}`);
  }
  lines.push(`Analyzer database writes: ${report.databaseWrites}`);
  if (applyResult) {
    lines.push(
      `Apply: written=${applyResult.written}, skipped=${applyResult.skipped}, writerRejected=${applyResult.writerRejected}, writerDuplicates=${applyResult.writerDuplicates}, errors=${applyResult.errors}`,
    );
  } else {
    lines.push("Apply: not requested");
  }
  lines.push(`Roadmap: ${report.roadmap}`);
  lines.push("Boundary: `ms scan` ingests a directory path. `ms evolve scan --source-id` processes a host-registered evolution source and does not take a filesystem path.");
  return lines.join("\n");
}
