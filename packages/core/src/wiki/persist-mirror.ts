/**
 * Post-commit Track E mirror.
 *
 * Call only after a memories or knowledge row has committed. EntryWriter
 * runs first, then IndexMaintainer. `metadata.wikiPath` is a forward-slash
 * path relative to the wiki root. A wiki IO failure is logged and must not
 * roll back the committed row. Fused `pages/<slug>/page-NNN.md` paths are
 * left untouched. This module does not write completion or page bodies.
 */

import { EntryWriteError, EntryWriter } from "./entry-writer.js";
import { IndexMaintainer } from "./index-maintainer.js";
import { WikiPathError, type WikiIndexUpdate } from "./root.js";

const FUSED_PAGE_PATH = /^pages\/[^/]+\/page-\d+\.md$/;
const ADMISSION_ROUTES = new Set([
  "drop",
  "candidate_low_priority",
  "candidate",
  "active",
  "lookup_only",
  "evidence_only",
]);

export type WikiMirrorTableName = "memories" | "knowledge" | `knowledge_${string}`;

export interface WikiPersistedEntry {
  readonly id: string;
  readonly kind: "memory" | "knowledge";
  readonly tableName: WikiMirrorTableName;
  readonly scopeKey?: string | null;
  readonly semanticType?: string | null;
  readonly text: string;
  readonly title?: string | null;
  readonly updatedAt?: number | string | Date | null;
  /** Existing `metadata.wikiPath`, if any. */
  readonly wikiPath?: string | null;
  readonly source?: string | null;
  readonly admissionRoute?: string | null;
}

export interface WikiEntryMirrorConfig {
  readonly root: string;
  readonly home?: string;
  readonly entriesDirName?: string;
  /** Default true. False skips the file, the index, and the metadata patch. */
  readonly writeEntriesOnPersist?: boolean;
  /** Default `sync-ancestors`. `off` still writes the entry file. */
  readonly indexUpdate?: WikiIndexUpdate;
  readonly logger?: { warn(message: string): void };
  /**
   * Best-effort metadata merge after the entry file is published.
   * A rejection is logged and does not fail the committed write.
   */
  recordMetadata?(input: {
    readonly id: string;
    readonly tableName: WikiMirrorTableName;
    readonly patch: Readonly<Record<string, string>>;
  }): Promise<void>;
}

export function wikiMirrorTable(input: {
  readonly dataType?: string;
  readonly tableName?: string;
}): { kind: "memory" | "knowledge"; tableName: WikiMirrorTableName } | undefined {
  const table = input.tableName;
  if (table === "documents" || input.dataType === "document") return undefined;
  if (table === "memories") return { kind: "memory", tableName: "memories" };
  if (table === "knowledge") return { kind: "knowledge", tableName: "knowledge" };
  if (typeof table === "string" && /^knowledge_[A-Za-z0-9_]+$/.test(table)) {
    return { kind: "knowledge", tableName: table as `knowledge_${string}` };
  }
  if (input.dataType === "knowledge") return { kind: "knowledge", tableName: "knowledge" };
  if (input.dataType === "memory" || input.dataType === undefined || table === undefined) {
    return { kind: "memory", tableName: "memories" };
  }
  return undefined;
}

/** True for Track F `pages/<slug>/page-NNN.md`. Entry paths do not match. */
export function isFusedWikiPagePath(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) return false;
  const relative = value.startsWith("./") ? value.slice(2) : value;
  return FUSED_PAGE_PATH.test(relative);
}

/**
 * Writes one Track E file and refreshes its ancestor indexes.
 * Never throws. Does not open or modify a fused page.
 */
export async function mirrorPersistedWikiEntry(
  entry: WikiPersistedEntry,
  config: WikiEntryMirrorConfig,
): Promise<void> {
  if (config.writeEntriesOnPersist === false) return;
  if (isFusedWikiPagePath(entry.wikiPath)) return;
  try {
    const writer = new EntryWriter({
      root: config.root,
      ...(config.home === undefined ? {} : { home: config.home }),
      ...(config.entriesDirName === undefined ? {} : { entriesDirName: config.entriesDirName }),
    });
    const written = await writer.write({
      id: entry.id,
      kind: entry.kind,
      scopeKey: entry.scopeKey,
      semanticType: entry.semanticType,
      text: entry.text,
      title: entry.title,
      updatedAt: updatedAtOf(entry.updatedAt),
      source: safeSource(entry.source),
      admissionRoute: safeAdmissionRoute(entry.admissionRoute),
      previousWikiPath: typeof entry.wikiPath === "string" ? entry.wikiPath : undefined,
    });
    if (config.indexUpdate !== "off") {
      const maintainer = new IndexMaintainer({
        root: config.root,
        ...(config.home === undefined ? {} : { home: config.home }),
        ...(config.entriesDirName === undefined ? {} : { entriesDirName: config.entriesDirName }),
      });
      const paths = [written.wikiPath, ...written.movedFrom];
      for (const wikiPath of paths) {
        try {
          maintainer.touchAncestors(wikiPath);
        } catch (error) {
          warn(config, `wiki index update failed for ${entry.id}; committed row kept: ${safeError(error)}`);
        }
      }
    }
    await record(config, entry, {
      wikiPath: written.wikiPath,
      wikiTrack: written.wikiTrack,
    });
  } catch (error) {
    warn(config, `wiki entry mirror failed for ${entry.id}; committed row kept: ${safeError(error)}`);
    await record(config, entry, { wikiStatus: "error" });
  }
}

function updatedAtOf(value: WikiPersistedEntry["updatedAt"]): string | Date | undefined {
  if (value == null || value === "") return undefined;
  if (value instanceof Date || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value);
  return undefined;
}

function safeSource(value: string | null | undefined): string | undefined {
  if (value == null || value === "") return undefined;
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0 || collapsed.length > 300 || /\p{Cc}/u.test(collapsed)) return undefined;
  return collapsed;
}

function safeAdmissionRoute(value: string | null | undefined): string | undefined {
  if (value == null || value === "") return undefined;
  return ADMISSION_ROUTES.has(value) ? value : undefined;
}

async function record(
  config: WikiEntryMirrorConfig,
  entry: WikiPersistedEntry,
  patch: Readonly<Record<string, string>>,
): Promise<void> {
  if (!config.recordMetadata) return;
  try {
    await config.recordMetadata({
      id: entry.id,
      tableName: entry.tableName,
      patch,
    });
  } catch (error) {
    warn(config, `wiki metadata patch failed for ${entry.id}; committed row kept: ${safeError(error)}`);
  }
}

function warn(config: WikiEntryMirrorConfig, message: string): void {
  try {
    if (config.logger) config.logger.warn(message);
    else console.warn(message);
  } catch {
    // Logging must not surface as a failed memory write.
  }
}

function safeError(error: unknown): string {
  if (error instanceof EntryWriteError || error instanceof WikiPathError) return error.message;
  return "wiki entry mirror failed";
}
