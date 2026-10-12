/**
 * `ms scan` command: directory report, dry-run admission preview, explicit apply.
 */

import path from "node:path";
import { Command } from "commander";
import type { MemoryCategory } from "../../../../config.js";
import { expandHome } from "../../../../core/paths.js";
import type { MemoryKind, MemorySemanticType } from "../../../core/src/domain/types.js";
import type { DataType, TableName } from "../../../core/src/db/types.js";
import {
  analyzeDirectory,
  applyDirectoryScan,
  formatDirectoryScanReport,
  isDirectoryScanWritable,
  type DirectoryScanProposal,
  type DirectoryScanWriter,
} from "../../../core/src/ingest/directory-governance.js";
import { redactHomePath, redactSecrets } from "../../../core/src/ingest/agent-history/redaction.js";
import type { MemoryWriteCommand } from "../../../core/src/service/write-kernel.js";

export const DIRECTORY_SCAN_DESCRIPTION =
  "Analyze a Markdown directory and preview 5type admission. Dry-run is the default and writes nothing. --apply stores admitted proposals through the memory write kernel. This is not `ms evolve scan`.";

export const DIRECTORY_SCAN_APPLY_AUTHORITY_ERROR =
  "ms scan --apply requires server authority (MENGSHU_AUTHORITY_JSON or MENGSHU_AUTHORITY_FILE). Refusing to write without authority.";

export const DIRECTORY_SCAN_APPLY_CAPABILITY_ERROR =
  "ms scan --apply refused: memory write capability is unavailable. Directory ingest will not bypass admission. Use a Postgres runtime with the write kernel, or rerun without --apply.";

export const DIRECTORY_SCAN_APPLY_CONFLICT_ERROR =
  "ms scan accepts either --dry-run or --apply, not both.";

export interface DirectoryScanCliDependencies {
  extraIgnorePaths?: readonly string[];
  extraIgnoreRules?: readonly string[];
  createWriter?: (request: { category: string }) => DirectoryScanWriter;
}

interface ScanCommandOptions {
  ignore?: string[];
  ignoreRule?: string[];
  category?: string;
  includeHidden?: boolean;
  dryRun?: boolean;
  apply?: boolean;
  json?: boolean;
  chunkSize?: string;
}

function resolveDirectory(input: string): string {
  const expanded = expandHome(input);
  return path.isAbsolute(expanded) ? expanded : path.resolve(process.cwd(), expanded);
}

function parseChunkSize(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const chunkSize = Number.parseInt(value, 10);
  if (!Number.isFinite(chunkSize) || chunkSize <= 0) {
    throw new Error("--chunk-size must be a positive integer");
  }
  return chunkSize;
}

function kindFor(semanticType: MemorySemanticType): MemoryKind {
  switch (semanticType) {
    case "profile": return "preference";
    case "task_context": return "task";
    case "rules": return "decision";
    case "experience": return "observation";
    case "resource": return "knowledge";
  }
}

export function buildDirectoryScanWriteCommand(input: {
  proposal: DirectoryScanProposal;
  serverAuthority: unknown;
  clientScope: unknown;
  category: MemoryCategory;
  dataType: DataType;
  tableName: TableName;
}): MemoryWriteCommand {
  if (!isDirectoryScanWritable(input.proposal) || input.proposal.semanticType === null) {
    throw new Error(`ms scan refused to build a write for ${input.proposal.relativePath}`);
  }
  const semanticType = input.proposal.semanticType;
  return {
    type: "observeAuto",
    intent: "remember",
    idempotencyKey: `scan:${input.proposal.fingerprint}`,
    serverAuthority: input.serverAuthority,
    clientScope: input.clientScope,
    text: redactSecrets(input.proposal.text).text,
    kind: kindFor(semanticType),
    semanticType,
    category: input.category,
    dataType: input.dataType,
    tableName: input.tableName,
    evidenceIds: [`scan:${input.proposal.fingerprint}`],
    metadata: {
      source: "scan",
      salience: 0.5,
      relativePath: input.proposal.relativePath,
      fingerprint: input.proposal.fingerprint,
      annotationSource: input.proposal.annotationSource,
      ...(input.proposal.profileDimension
        ? { profileDimension: input.proposal.profileDimension }
        : {}),
    },
    provenance: {
      source: "scan",
      sourceId: redactHomePath(input.proposal.filePath),
      filePath: redactHomePath(input.proposal.filePath),
    },
  };
}

export function configureDirectoryScanCommand(command: Command): Command {
  return command
    .description(DIRECTORY_SCAN_DESCRIPTION)
    .option("--ignore <paths...>", "Extra ignore paths, combined with scanner defaults")
    .option("--ignore-rule <rules...>", "Extra gitignore-style ignore rules")
    .option("--category <name>", "Storage category used only by --apply", "知识库")
    .option("--chunk-size <n>", "Split a long Markdown body into admission proposals")
    .option("--include-hidden", "Include hidden Markdown files", false)
    .option("--dry-run", "Preview the admission report and write nothing (default)")
    .option("--apply", "Store admitted proposals through the memory write kernel")
    .option("--json", "Print the machine-readable report");
}

export function registerDirectoryScanCommand(
  program: Command,
  dependencies: DirectoryScanCliDependencies = {},
): Command {
  return configureDirectoryScanCommand(program.command("scan <directory>"))
    .action(async (directory: string, options: ScanCommandOptions = {}) => {
      if (options.apply && options.dryRun) {
        throw new Error(DIRECTORY_SCAN_APPLY_CONFLICT_ERROR);
      }
      const mode = options.apply ? "apply" : "dry-run";
      const report = await analyzeDirectory({
        directory: resolveDirectory(directory),
        ignorePaths: [
          ...(dependencies.extraIgnorePaths ?? []),
          ...(options.ignore ?? []),
        ],
        ignoreRules: [
          ...(dependencies.extraIgnoreRules ?? []),
          ...(options.ignoreRule ?? []),
        ],
        includeHidden: options.includeHidden === true,
        chunkSize: parseChunkSize(options.chunkSize),
      });
      let applyResult;
      if (mode === "apply") {
        const write = dependencies.createWriter?.({ category: options.category ?? "知识库" });
        if (!write) throw new Error(DIRECTORY_SCAN_APPLY_CAPABILITY_ERROR);
        applyResult = await applyDirectoryScan(report, write);
      }
      const payload = { ...report, mode, ...(applyResult ? { apply: applyResult } : {}) };
      if (options.json) console.log(JSON.stringify(payload, null, 2));
      else console.log(formatDirectoryScanReport(report, applyResult));
    });
}
