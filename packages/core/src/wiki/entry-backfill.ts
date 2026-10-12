/**
 * Track E backfill and entries reindex.
 *
 * The database stays the record of record. Dry-run writes nothing.
 * `--apply` creates `pages/<slug>/entries/...` only for rows with no
 * `wikiPath` or a missing file, skips fused `pages/.../page-NNN.md`
 * paths, then reindexes entries once. A file or metadata failure is
 * recorded and must not delete or roll back the committed row.
 * This module does not write `page-*.md`, `.sources`, or completion.
 */

import { lstatSync } from "node:fs";

import type { DatabaseProvider, MemoryEntry, TableName } from "../db/types.js";
import { memoryEntryToRecord } from "../domain/legacy-mapping.js";
import { scopeToKey } from "../domain/scope.js";
import { EntryWriteError, EntryWriter } from "./entry-writer.js";
import { IndexMaintainer, type WikiIndexWrite } from "./index-maintainer.js";
import {
  isFusedWikiPagePath,
  wikiMirrorTable,
  type WikiEntryMirrorConfig,
  type WikiMirrorTableName,
  type WikiPersistedEntry,
} from "./persist-mirror.js";
import {
  parseWikiConfig,
  relativeWikiPath,
  resolveWikiMarkdownPath,
  WikiPathError,
  type WikiPathOptions,
} from "./root.js";

export type WikiBackfillKind = "all" | "memories" | "knowledge";

export interface WikiBackfillRow {
  readonly id: string;
  readonly kind: "memory" | "knowledge";
  readonly tableName: WikiMirrorTableName;
  readonly scopeKey?: string | null;
  readonly semanticType?: string | null;
  readonly text: string;
  readonly title?: string | null;
  readonly updatedAt?: WikiPersistedEntry["updatedAt"];
  readonly wikiPath?: string | null;
  readonly source?: string | null;
  readonly admissionRoute?: string | null;
}

export interface WikiBackfillSource {
  readonly rows: readonly WikiBackfillRow[];
  recordMetadata?: WikiEntryMirrorConfig["recordMetadata"];
  close?(): Promise<void>;
}

export interface WikiBackfillReport {
  readonly mode: "dry-run" | "apply";
  readonly kind: WikiBackfillKind;
  readonly limit: number | null;
  readonly scanned: number;
  readonly skippedKind: number;
  readonly skippedFused: readonly WikiBackfillSkip[];
  readonly skippedPresent: readonly WikiBackfillSkip[];
  readonly eligible: readonly WikiBackfillPlan[];
  readonly written: readonly WikiBackfillPlan[];
  readonly failed: readonly WikiBackfillFailure[];
  readonly metadataPatched: readonly WikiBackfillPlan[];
  readonly metadataPatchFailed: readonly string[];
  readonly reindexed: readonly WikiIndexWrite[] | null;
  readonly reindexError?: string;
}

export interface WikiBackfillSkip {
  readonly id: string;
  readonly wikiPath: string;
}

export interface WikiBackfillPlan {
  readonly id: string;
  readonly kind: "memory" | "knowledge";
  readonly tableName: WikiMirrorTableName;
  readonly wikiPath: string;
}

export interface WikiBackfillFailure {
  readonly id: string;
  readonly message: string;
}

export interface WikiBackfillInput extends WikiPathOptions {
  readonly wikiRoot: string;
  readonly entriesDirName?: string;
  readonly rows: readonly WikiBackfillRow[];
  readonly kind?: WikiBackfillKind;
  readonly limit?: number;
  /** Default false: report only. True writes missing entry files and reindexes. */
  readonly apply?: boolean;
  recordMetadata?: WikiEntryMirrorConfig["recordMetadata"];
  readonly logger?: { warn(message: string): void };
}

const KNOWLEDGE_TABLE = /^knowledge_[A-Za-z0-9_]+$/;

export function reindexWikiEntries(input: {
  readonly wikiRoot: string;
  readonly entriesDirName?: string;
} & WikiPathOptions): WikiIndexWrite[] {
  return new IndexMaintainer({
    root: input.wikiRoot,
    ...(input.home === undefined ? {} : { home: input.home }),
    ...(input.entriesDirName === undefined ? {} : { entriesDirName: input.entriesDirName }),
  }).reindexEntries();
}

/**
 * Map one committed provider row into a backfill row.
 * Documents are omitted. The committed row is not modified.
 */
export function wikiBackfillRowFromEntry(
  entry: MemoryEntry,
  tableName: TableName,
): WikiBackfillRow | undefined {
  if (tableName === "documents" || entry.dataType === "document") return undefined;
  if (typeof entry.id !== "string" || entry.id.length === 0 || typeof entry.text !== "string") {
    return undefined;
  }
  const mirrored = wikiMirrorTable({ dataType: entry.dataType, tableName });
  if (!mirrored) return undefined;
  const record = memoryEntryToRecord({
    ...entry,
    id: entry.id,
    text: entry.text,
    tableName,
    vector: Array.isArray(entry.vector) ? entry.vector : [],
    metadata: entry.metadata ?? {},
  });
  const metadata = record.metadata ?? {};
  return {
    id: record.id,
    kind: mirrored.kind,
    tableName: mirrored.tableName,
    scopeKey: scopeToKey(record.scope),
    semanticType: record.semanticType ?? null,
    text: record.text,
    title: typeof metadata.title === "string" ? metadata.title : null,
    updatedAt: record.updatedAt ?? record.createdAt,
    wikiPath: typeof metadata.wikiPath === "string" ? metadata.wikiPath : null,
    source: typeof record.provenance?.source === "string" ? record.provenance.source : null,
    admissionRoute: typeof metadata.admissionRoute === "string" ? metadata.admissionRoute : null,
  };
}

/** List memories and knowledge rows. Does not delete rows or open a wiki root. */
export async function loadWikiBackfillRows(
  provider: Pick<DatabaseProvider, "query"> & Partial<Pick<DatabaseProvider, "getTableNames">>,
  kind: WikiBackfillKind,
): Promise<WikiBackfillRow[]> {
  const checked = requireKind(kind);
  const names = checked === "memories" || !provider.getTableNames
    ? []
    : await provider.getTableNames();
  const rows: WikiBackfillRow[] = [];
  for (const tableName of tablesForKind(checked, names)) {
    const entries = await provider.query({ tableName });
    for (const entry of entries) {
      try {
        const row = wikiBackfillRowFromEntry(entry, tableName);
        if (row) rows.push(row);
      } catch {
        // A corrupt projection is omitted. The committed row stays as it is.
      }
    }
  }
  return rows;
}

export async function backfillWikiEntries(input: WikiBackfillInput): Promise<WikiBackfillReport> {
  const kind = requireKind(input.kind ?? "all");
  const limit = requireLimit(input.limit);
  if (!Array.isArray(input.rows)) {
    throw new Error("wiki backfill rows must be an array");
  }
  const apply = input.apply === true;
  const skippedFused: WikiBackfillSkip[] = [];
  const skippedPresent: WikiBackfillSkip[] = [];
  const eligible: WikiBackfillPlan[] = [];
  const failed: WikiBackfillFailure[] = [];
  let skippedKind = 0;
  const wiki = parseWikiConfig(
    input.entriesDirName === undefined
      ? { root: input.wikiRoot }
      : { root: input.wikiRoot, entriesDirName: input.entriesDirName },
    input.home === undefined ? {} : { home: input.home },
  );
  const writer = new EntryWriter({
    root: wiki.root,
    ...(input.home === undefined ? {} : { home: input.home }),
    entriesDirName: wiki.entriesDirName,
  });

  for (const row of input.rows) {
    if (!matchesKind(row, kind)) {
      skippedKind += 1;
      continue;
    }
    const stored = storedWikiPath(row.wikiPath);
    if (stored && isFusedWikiPagePath(stored)) {
      skippedFused.push({ id: row.id, wikiPath: stored });
      continue;
    }
    if (stored && wikiFileExists({ ...input, wikiRoot: wiki.root }, stored)) {
      skippedPresent.push({ id: row.id, wikiPath: stored });
      continue;
    }
    try {
      const wikiPath = writer.targetWikiPath(toWriteInput(row));
      if (!isStoreableEntryPath(wikiPath, wiki.entriesDirName)) {
        throw new EntryWriteError("ENTRY_PROTECTED_PATH", "wiki backfill refused a non-entry path");
      }
      eligible.push({
        id: row.id,
        kind: row.kind,
        tableName: row.tableName,
        wikiPath,
      });
    } catch (error) {
      failed.push({ id: row.id, message: safeError(error) });
    }
  }

  const selected = limit === null ? eligible : eligible.slice(0, limit);
  if (!apply) {
    return {
      mode: "dry-run",
      kind,
      limit,
      scanned: input.rows.length,
      skippedKind,
      skippedFused,
      skippedPresent,
      eligible: selected,
      written: [],
      failed,
      metadataPatched: [],
      metadataPatchFailed: [],
      reindexed: null,
    };
  }

  const written: WikiBackfillPlan[] = [];
  const metadataPatched: WikiBackfillPlan[] = [];
  const metadataPatchFailed: string[] = [];
  for (const plan of selected) {
    const row = input.rows.find((item) => item.id === plan.id && item.tableName === plan.tableName);
    if (!row) {
      failed.push({ id: plan.id, message: "wiki backfill row disappeared before write" });
      continue;
    }
    try {
      const result = await writer.write(toWriteInput(row));
      if (result.wikiPath !== plan.wikiPath || !isStoreableEntryPath(result.wikiPath, wiki.entriesDirName)) {
        throw new EntryWriteError("ENTRY_PROTECTED_PATH", "wiki backfill refused a non-entry path");
      }
      written.push(plan);
      const patched = await patchMetadata(input, row, {
        wikiPath: result.wikiPath,
        wikiTrack: "entry",
      });
      if (patched) metadataPatched.push(plan);
      else metadataPatchFailed.push(row.id);
    } catch (error) {
      failed.push({ id: row.id, message: safeError(error) });
      warn(input, `wiki backfill failed for ${row.id}; committed row kept: ${safeError(error)}`);
      const patched = await patchMetadata(input, row, { wikiStatus: "error" });
      if (!patched) metadataPatchFailed.push(row.id);
    }
  }

  let reindexed: WikiIndexWrite[] | null = null;
  let reindexError: string | undefined;
  try {
    reindexed = reindexWikiEntries({
      wikiRoot: wiki.root,
      ...(input.home === undefined ? {} : { home: input.home }),
      entriesDirName: wiki.entriesDirName,
    });
  } catch (error) {
    reindexError = safeError(error);
    warn(input, `wiki backfill reindex failed; committed rows kept: ${reindexError}`);
  }

  return {
    mode: "apply",
    kind,
    limit,
    scanned: input.rows.length,
    skippedKind,
    skippedFused,
    skippedPresent,
    eligible: selected,
    written,
    failed,
    metadataPatched,
    metadataPatchFailed,
    reindexed,
    ...(reindexError === undefined ? {} : { reindexError }),
  };
}

function tablesForKind(kind: WikiBackfillKind, names: readonly string[]): TableName[] {
  const tables: TableName[] = [];
  if (kind !== "knowledge") tables.push("memories");
  if (kind !== "memories") {
    tables.push("knowledge");
    for (const name of names) {
      if (KNOWLEDGE_TABLE.test(name)) tables.push(name as TableName);
    }
  }
  return [...new Set(tables)];
}

function matchesKind(row: WikiBackfillRow, kind: WikiBackfillKind): boolean {
  if (kind === "all") return row.kind === "memory" || row.kind === "knowledge";
  if (kind === "memories") return row.kind === "memory";
  return row.kind === "knowledge";
}

function storedWikiPath(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function wikiFileExists(input: WikiBackfillInput, wikiPath: string): boolean {
  try {
    const resolved = resolveWikiMarkdownPath(
      input.wikiRoot,
      wikiPath,
      input.home === undefined ? {} : { home: input.home },
    );
    const stat = lstatSync(resolved.absolutePath);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function toWriteInput(row: WikiBackfillRow) {
  return {
    id: row.id,
    kind: row.kind,
    scopeKey: row.scopeKey,
    semanticType: row.semanticType,
    text: row.text,
    title: row.title,
    updatedAt: updatedAtOf(row.updatedAt),
    source: row.source,
    admissionRoute: row.admissionRoute,
  };
}

function updatedAtOf(value: WikiBackfillRow["updatedAt"]): string | Date | undefined {
  if (value == null || value === "") return undefined;
  if (value instanceof Date || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value);
  return undefined;
}

function isStoreableEntryPath(wikiPath: string, entriesDirName: string): boolean {
  if (relativeWikiPath(wikiPath) !== wikiPath || isFusedWikiPagePath(wikiPath)) return false;
  const parts = wikiPath.split("/");
  return parts.length === 5
    && parts[0] === "pages"
    && parts[2] === entriesDirName
    && (parts[4] ?? "").endsWith(".md")
    && !wikiPath.includes("\\");
}

async function patchMetadata(
  input: WikiBackfillInput,
  row: WikiBackfillRow,
  patch: Readonly<Record<string, string>>,
): Promise<boolean> {
  if (!input.recordMetadata) return false;
  try {
    await input.recordMetadata({
      id: row.id,
      tableName: row.tableName,
      patch,
    });
    return true;
  } catch (error) {
    warn(input, `wiki metadata patch failed for ${row.id}; committed row kept: ${safeError(error)}`);
    return false;
  }
}

function requireKind(value: WikiBackfillKind | undefined): WikiBackfillKind {
  if (value === undefined) return "all";
  if (value === "all" || value === "memories" || value === "knowledge") return value;
  throw new Error("wiki backfill kind must be all, memories, or knowledge");
}

function requireLimit(value: number | undefined): number | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("wiki backfill limit must be a positive integer");
  }
  return value;
}

function warn(input: WikiBackfillInput, message: string): void {
  try {
    input.logger?.warn(message);
  } catch {
    // Logging must not surface as a rolled-back memory.
  }
}

function safeError(error: unknown): string {
  if (error instanceof EntryWriteError || error instanceof WikiPathError) return error.message;
  return "wiki entry file write failed; a committed memory must not be rolled back";
}
