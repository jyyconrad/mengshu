import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { authorityScopeFingerprint } from "../../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../../domain/types.js";
import { GovernedDocumentAssetWriteKernel } from "../../documents/write-kernel.js";
import { GovernedDocumentReadService, type GovernedDocumentReadRepository } from "../../documents/read-service.js";
import type { CommitGovernedDocumentMarkdownInput, CompletePreparedDocumentInput, GovernedDocumentMarkdownAdapterPort, GovernedDocumentWriteRepositoryPort, PrepareGovernedDocumentVersionInput, PreparedGovernedDocumentVersion, RecordIncompleteDocumentInput } from "../../documents/repository.js";
import { validateDocumentAssetCommitReceipt } from "../../documents/repository.js";
import type { GovernedDocumentAssetVersion, GovernedDocumentIndex } from "../../documents/types.js";
import { historyHash, rejectHistory } from "./schema.js";
import { historyContentSha256, type HistoryNativeMaterials } from "./native-materials.js";
import { HistoryPostgresJournal } from "./postgres-journal.js";
import type { HistoryPlan, HistoryPlanUnit } from "./types.js";
import type { HistoryPgClient } from "./postgres-read.js";

/** Owner-private immutable output. Existing differing Markdown is never overwritten. */
export class HistoryImmutableMarkdownAdapter implements GovernedDocumentMarkdownAdapterPort {
  constructor(private readonly roots: Readonly<Record<string, string>>) {}
  async commit(input: CommitGovernedDocumentMarkdownInput): Promise<{ markdown: string }> {
    const root = this.roots[input.vaultId];
    if (!root || !isAbsolute(root) || isAbsolute(input.canonicalPath) || input.canonicalPath.includes("\\") || input.canonicalPath.split("/").some(part => !part || part === "." || part === "..") || Buffer.byteLength(input.markdown) > 4 * 1024 * 1024) rejectHistory("HISTORY_MARKDOWN_PATH_INVALID");
    const actualRoot = await realpath(root), rootInfo = await lstat(root);
    if (actualRoot !== resolve(root) || !rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (rootInfo.mode & 0o022) !== 0) rejectHistory("HISTORY_MARKDOWN_ROOT_UNSAFE");
    const file = resolve(root, input.canonicalPath);
    if (relative(root, file).startsWith("..")) rejectHistory("HISTORY_MARKDOWN_PATH_INVALID");
    let parent = root;
    for (const part of relative(root, dirname(file)).split("/").filter(Boolean)) {
      parent = join(parent, part);
      await mkdir(parent, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
      const info = await lstat(parent);
      if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o022) !== 0) rejectHistory("HISTORY_MARKDOWN_PATH_UNSAFE");
    }
    const read = async () => {
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > 4 * 1024 * 1024) rejectHistory("HISTORY_MARKDOWN_BUDGET");
        const markdown = await handle.readFile("utf8");
        if (historyContentSha256(markdown) !== input.renderHash || markdown !== input.markdown) rejectHistory("HISTORY_MARKDOWN_CONFLICT");
        return { markdown };
      } finally { await handle.close(); }
    };
    try { return await read(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const temporary = join(dirname(file), `.history-${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(input.markdown, "utf8"); await handle.sync(); } finally { await handle.close(); }
    try { await link(temporary, file).catch(error => { if (error.code !== "EEXIST") throw error; }); }
    finally { await unlink(temporary); }
    const directory = await open(dirname(file), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
    return read();
  }
}

export class PostgresHistoryDocumentRepository implements GovernedDocumentWriteRepositoryPort, GovernedDocumentReadRepository {
  private prepared?: PreparedGovernedDocumentVersion;
  constructor(private readonly client: HistoryPgClient, private readonly plan: HistoryPlan, private readonly unit: HistoryPlanUnit, private readonly journal: HistoryPostgresJournal, private readonly material: HistoryNativeMaterials["documents"][number], private readonly now: number) {}
  async prepareVersion(input: PrepareGovernedDocumentVersionInput) {
    if (historyHash(input.asset) !== historyHash(this.material.asset) || input.asset.scopeFingerprint !== this.unit.scopeFingerprint || input.asset.assetId !== this.unit.target?.assetId || input.expectedCompleteVersion !== 0 || input.asset.assetVersion !== 1) rejectHistory("HISTORY_DOCUMENT_ADOPTION_INVALID");
    const scope = this.unit.scopeFingerprint, asset = input.asset.assetId, vault = input.vaultId;
    await this.journal.capture({ table: "mengshu_governed_document_bindings", keys: { scope_fingerprint: scope, vault_id: vault, asset_id: asset } });
    await this.journal.capture({ table: "mengshu_asset_versions", keys: { scope_fingerprint: scope, asset_id: asset, version: String(input.asset.assetVersion) } });
    await this.journal.capture({ table: "mengshu_asset_heads", keys: { scope_fingerprint: scope, asset_id: asset } });
    const receiptId = `p16doc:${historyHash([this.plan.input.runId, this.unit.id])}`;
    await this.journal.capture({ table: "mengshu_governed_document_sync_receipts", keys: { receipt_id: receiptId } });
    await this.journal.capture({ table: "mengshu_governed_document_complete_heads", keys: { scope_fingerprint: scope, asset_id: asset } });
    const result = await this.client.query(`/* history:document-pending-lock */ SELECT asset_version,lifecycle_state,sync_state,last_complete_version,
      public_content_hash,governance_projection_hash,normalized_path,governance_descriptor->>'p15RunId' AS parent_run
      FROM mengshu_governed_document_bindings WHERE scope_fingerprint=$1 AND vault_id=$2 AND asset_id=$3 FOR UPDATE`, [scope, vault, asset]);
    const row = result.rows[0];
    if (!row || Number(row.asset_version) !== input.asset.assetVersion || row.lifecycle_state !== "review" || row.sync_state !== "sync_pending" || row.last_complete_version != null || row.parent_run !== this.plan.input.parentRunId || row.public_content_hash !== input.asset.publicContentHash || row.governance_projection_hash !== input.asset.governanceProjectionHash || row.normalized_path !== input.canonicalPath) rejectHistory("HISTORY_DOCUMENT_CAS_FAILED");
    this.prepared = { ...input, prepareToken: receiptId };
    return { state: "prepared" as const, prepared: this.prepared };
  }
  async completePreparedVersion(input: CompletePreparedDocumentInput) {
    const prepared = this.prepared;
    if (!prepared || historyHash(input.prepared) !== historyHash(prepared) || input.markdownPublicContentHash !== prepared.asset.publicContentHash || input.renderHash !== prepared.renderHash) rejectHistory("HISTORY_DOCUMENT_COMPLETION_INVALID");
    const asset = prepared.asset;
    const receipt = validateDocumentAssetCommitReceipt({ receiptId: prepared.prepareToken, vaultId: prepared.vaultId, idempotencyKey: prepared.idempotencyKey, requestHash: prepared.requestHash, assetId: asset.assetId, assetVersion: asset.assetVersion, postgresPublicContentHash: asset.publicContentHash, markdownPublicContentHash: input.markdownPublicContentHash, governanceProjectionHash: asset.governanceProjectionHash, completionContractHash: prepared.completionContractHash, disposition: "complete", createdAt: new Date(this.now).toISOString() });
    const updated = await this.client.query(`/* history:document-native-complete */ UPDATE mengshu_governed_document_bindings
      SET lifecycle_state=$4,governance_state=$5,sync_state='complete',last_complete_version=asset_version,render_hash=$6,synced_at=$7,updated_at=$7,
      governance_descriptor=governance_descriptor || jsonb_build_object('historyP16',$8::jsonb)
      WHERE scope_fingerprint=$1 AND vault_id=$2 AND asset_id=$3 AND sync_state='sync_pending' AND last_complete_version IS NULL RETURNING asset_id`,
    [asset.scopeFingerprint, prepared.vaultId, asset.assetId, asset.lifecycleState, asset.governanceState, input.renderHash, this.now, JSON.stringify({ runId: this.plan.input.runId, asset, ...(this.material.index ? { index: this.material.index } : {}) })]);
    if (updated.rows.length !== 1) return { state: "cas_mismatch" as const };
    const assetUpdated = await this.client.query(`/* history:document-native-asset */ UPDATE mengshu_asset_versions SET status='published' WHERE scope_fingerprint=$1 AND asset_id=$2 AND version=$3 AND status='review' RETURNING asset_id`, [asset.scopeFingerprint, asset.assetId, asset.assetVersion]);
    if (assetUpdated.rows.length !== 1) rejectHistory("HISTORY_DOCUMENT_ASSET_CAS_FAILED");
    await this.client.query(`/* history:document-native-asset-head */ INSERT INTO mengshu_asset_heads(scope_fingerprint,asset_id,latest_version,changed_at) VALUES($1,$2,$3,$4)`, [asset.scopeFingerprint, asset.assetId, asset.assetVersion, this.now]);
    await this.client.query(`/* history:document-native-receipt */ INSERT INTO mengshu_governed_document_sync_receipts
      (receipt_id,scope_fingerprint,vault_id,idempotency_key,request_hash,asset_id,asset_version,postgres_public_content_hash,markdown_public_content_hash,governance_projection_hash,completion_contract_hash,disposition,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'complete',$12)`, [receipt.receiptId, asset.scopeFingerprint, receipt.vaultId, receipt.idempotencyKey, receipt.requestHash, receipt.assetId, receipt.assetVersion, receipt.postgresPublicContentHash, receipt.markdownPublicContentHash, receipt.governanceProjectionHash, receipt.completionContractHash, this.now]);
    await this.client.query(`/* history:document-native-head */ INSERT INTO mengshu_governed_document_complete_heads(scope_fingerprint,asset_id,complete_version,vault_id,completion_receipt_id,changed_at) VALUES($1,$2,$3,$4,$5,$6)`, [asset.scopeFingerprint, asset.assetId, asset.assetVersion, receipt.vaultId, receipt.receiptId, this.now]);
    return { state: "complete" as const, receipt };
  }
  async recordIncomplete(_input: RecordIncompleteDocumentInput): Promise<never> { return rejectHistory("HISTORY_DOCUMENT_INCOMPLETE"); }
  async getComplete(scope: MemoryScope, assetId: string): Promise<GovernedDocumentAssetVersion | undefined> {
    const result = await this.client.query(`/* history:document-authoritative-read */ SELECT binding.governance_descriptor #> '{historyP16,asset}' AS asset
      FROM mengshu_governed_document_complete_heads head JOIN mengshu_governed_document_bindings binding ON binding.scope_fingerprint=head.scope_fingerprint AND binding.asset_id=head.asset_id AND binding.asset_version=head.complete_version AND binding.vault_id=head.vault_id
      WHERE head.scope_fingerprint=$1 AND head.asset_id=$2 AND binding.sync_state='complete'`, [authorityScopeFingerprint(scope), assetId]);
    return result.rows[0]?.asset as GovernedDocumentAssetVersion | undefined;
  }
  async getIndex(scope: MemoryScope, assetId: string, assetVersion: number): Promise<GovernedDocumentIndex | undefined> {
    const result = await this.client.query(`/* history:document-authoritative-index */ SELECT governance_descriptor #> '{historyP16,index}' AS index FROM mengshu_governed_document_bindings WHERE scope_fingerprint=$1 AND asset_id=$2 AND asset_version=$3 AND sync_state='complete'`, [authorityScopeFingerprint(scope), assetId, assetVersion]);
    return result.rows[0]?.index as GovernedDocumentIndex | undefined;
  }
}

export async function commitHistoryDocument(repository: PostgresHistoryDocumentRepository, material: HistoryNativeMaterials["documents"][number], markdown: HistoryImmutableMarkdownAdapter, key: string): Promise<void> {
  const result = await new GovernedDocumentAssetWriteKernel({ repository, markdown }).commit({ ...material, idempotencyKey: key, expectedCompleteVersion: 0 });
  if (result.receipt.disposition !== "complete") rejectHistory("HISTORY_DOCUMENT_INCOMPLETE");
  const read = await new GovernedDocumentReadService({ repository }).read(material.asset.scope, material.asset.assetId);
  if (read.kind === "filtered") rejectHistory("HISTORY_DOCUMENT_READ_REJECTED");
}
