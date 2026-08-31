import type { SkillArtifactRepository } from "./repository.js";
import type {
  SkillArtifactMutationResult,
  SkillArtifactReceipt,
  SkillArtifactVersion,
} from "./types.js";

function key(...parts: readonly (string | number)[]): string {
  return parts.join("\0");
}

function words(value: string): string[] {
  return value.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}_-]+/gu) ?? [];
}

export class InMemorySkillArtifactRepository implements SkillArtifactRepository {
  readonly #versions = new Map<string, SkillArtifactVersion>();
  readonly #heads = new Map<string, number>();
  readonly #receipts = new Map<string, SkillArtifactReceipt>();
  readonly #receiptIds = new Map<string, SkillArtifactReceipt>();

  async getLatest(scopeFingerprint: string, skillId: string): Promise<SkillArtifactVersion | undefined> {
    const version = this.#heads.get(key(scopeFingerprint, skillId));
    return version === undefined ? undefined : this.getVersion(scopeFingerprint, skillId, version);
  }

  async getVersion(
    scopeFingerprint: string,
    skillId: string,
    version: number,
  ): Promise<SkillArtifactVersion | undefined> {
    const artifact = this.#versions.get(key(scopeFingerprint, skillId, version));
    if (artifact === undefined) return undefined;
    return structuredClone({
      ...artifact,
      isHead: this.#heads.get(key(scopeFingerprint, skillId)) === version,
    });
  }

  async listLatest(scopeFingerprint: string): Promise<readonly SkillArtifactVersion[]> {
    const values: SkillArtifactVersion[] = [];
    for (const headKey of this.#heads.keys()) {
      const [fingerprint, skillId] = headKey.split("\0");
      if (fingerprint !== scopeFingerprint || skillId === undefined) continue;
      const artifact = await this.getLatest(fingerprint, skillId);
      if (artifact !== undefined) values.push(artifact);
    }
    return values.sort((left, right) => left.skillId.localeCompare(right.skillId));
  }

  async searchPublished(scopeFingerprint: string, query: string, limit: number) {
    const documents = (await this.listLatest(scopeFingerprint))
      .filter((artifact) => artifact.status === "published")
      .map((artifact) => ({ artifact, terms: words(`${artifact.title} ${artifact.description}`) }));
    const queryTerms = [...new Set(words(query))];
    const averageLength = documents.reduce((sum, document) => sum + document.terms.length, 0) /
      Math.max(1, documents.length);
    const hits = documents.map(({ artifact, terms }) => {
      const score = queryTerms.reduce((sum, term) => {
        const tf = terms.filter((value) => value === term).length;
        if (tf === 0) return sum;
        const df = documents.filter((document) => document.terms.includes(term)).length;
        const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
        const normalizedTf = tf * 2.2 /
          (tf + 1.2 * (0.25 + 0.75 * terms.length / Math.max(1, averageLength)));
        return sum + idf * normalizedTf;
      }, 0);
      return { artifact, score };
    }).filter((hit) => hit.score > 0)
      .sort((left, right) => right.score - left.score ||
        left.artifact.skillId.localeCompare(right.artifact.skillId))
      .slice(0, limit);
    return structuredClone(hits);
  }

  async getReceipt(
    scopeFingerprint: string,
    idempotencyKey: string,
  ): Promise<SkillArtifactReceipt | undefined> {
    return structuredClone(this.#receipts.get(key(scopeFingerprint, idempotencyKey)));
  }

  async getReceiptById(
    scopeFingerprint: string,
    receiptId: string,
  ): Promise<SkillArtifactReceipt | undefined> {
    return structuredClone(this.#receiptIds.get(key(scopeFingerprint, receiptId)));
  }

  async listReceipts(
    scopeFingerprint: string,
    skillId: string,
  ): Promise<readonly SkillArtifactReceipt[]> {
    return [...this.#receipts.values()]
      .filter((receipt) => receipt.scopeFingerprint === scopeFingerprint && receipt.skillId === skillId)
      .sort((left, right) => left.artifactVersion - right.artifactVersion ||
        left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id))
      .map((receipt) => structuredClone(receipt));
  }

  async appendVersion(input: {
    readonly scopeFingerprint: string;
    readonly artifact: SkillArtifactVersion;
    readonly receipt: SkillArtifactReceipt;
    readonly expectedLatestVersion: number;
  }): Promise<SkillArtifactMutationResult> {
    const receiptKey = key(input.scopeFingerprint, input.receipt.idempotencyKey);
    const existingReceipt = this.#receipts.get(receiptKey);
    if (existingReceipt !== undefined) {
      if (existingReceipt.requestHash !== input.receipt.requestHash) throw new Error("SKILL_IDEMPOTENCY_CONFLICT");
      const artifact = await this.getVersion(
        input.scopeFingerprint,
        existingReceipt.skillId,
        existingReceipt.artifactVersion,
      );
      if (artifact === undefined) throw new Error("SKILL_ARTIFACT_NOT_FOUND");
      return { artifact, receipt: structuredClone(existingReceipt), replayed: true };
    }
    const headKey = key(input.scopeFingerprint, input.artifact.skillId);
    const latest = this.#heads.get(headKey) ?? 0;
    if (latest !== input.expectedLatestVersion || input.artifact.version !== latest + 1) {
      throw new Error("SKILL_VERSION_STALE");
    }
    this.#versions.set(
      key(input.scopeFingerprint, input.artifact.skillId, input.artifact.version),
      structuredClone(input.artifact),
    );
    this.#heads.set(headKey, input.artifact.version);
    this.#receipts.set(receiptKey, structuredClone(input.receipt));
    this.#receiptIds.set(key(input.scopeFingerprint, input.receipt.id), structuredClone(input.receipt));
    return {
      artifact: (await this.getVersion(
        input.scopeFingerprint,
        input.artifact.skillId,
        input.artifact.version,
      ))!,
      receipt: structuredClone(input.receipt),
      replayed: false,
    };
  }

  async recordUnchangedAppend(input: {
    readonly scopeFingerprint: string;
    readonly artifact: SkillArtifactVersion;
    readonly receipt: SkillArtifactReceipt;
    readonly expectedLatestVersion: number;
  }): Promise<SkillArtifactMutationResult> {
    const receiptStorageKey = key(input.scopeFingerprint, input.receipt.idempotencyKey);
    const existingReceipt = this.#receipts.get(receiptStorageKey);
    if (existingReceipt !== undefined) {
      if (existingReceipt.requestHash !== input.receipt.requestHash) {
        throw new Error("SKILL_IDEMPOTENCY_CONFLICT");
      }
      const replay = await this.getVersion(
        input.scopeFingerprint,
        existingReceipt.skillId,
        existingReceipt.artifactVersion,
      );
      if (replay === undefined) throw new Error("SKILL_ARTIFACT_NOT_FOUND");
      return { artifact: replay, receipt: structuredClone(existingReceipt), replayed: true };
    }
    const current = await this.getLatest(input.scopeFingerprint, input.artifact.skillId);
    if (current === undefined || current.version !== input.expectedLatestVersion ||
        input.artifact.version !== current.version || input.artifact.contentHash !== current.contentHash) {
      throw new Error("SKILL_VERSION_STALE");
    }
    this.#receipts.set(receiptStorageKey, structuredClone(input.receipt));
    this.#receiptIds.set(
      key(input.scopeFingerprint, input.receipt.id),
      structuredClone(input.receipt),
    );
    return {
      artifact: current,
      receipt: structuredClone(input.receipt),
      replayed: false,
    };
  }
}
