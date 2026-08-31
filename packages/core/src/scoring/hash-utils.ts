import { createHash } from "node:crypto";

/**
 * 计算文本内容的MD5哈希值
 * @param text 要计算哈希的文本
 * @returns MD5哈希字符串
 */
export function computeContentHash(text: string): string {
  return createHash("md5")
    .update(text.trim())
    .digest("hex");
}

/** Markdown 工作集治理使用的规范文本 SHA-256。 */
export function computeCanonicalContentHash(text: string): string {
  return createHash("sha256")
    .update(text.replace(/\r\n?/g, "\n").normalize("NFC"), "utf8")
    .digest("hex");
}

/** 同时验证历史 MD5 与规范 Markdown 工作集 SHA-256，不接受不可重算的占位 hash。 */
export function matchesContentHash(text: string, contentHash: string): boolean {
  if (/^[0-9a-f]{32}$/.test(contentHash)) {
    return contentHash === computeContentHash(text);
  }
  if (/^[0-9a-f]{64}$/.test(contentHash)) {
    return contentHash === computeCanonicalContentHash(text);
  }
  return false;
}

/**
 * 批量计算文本内容的MD5哈希值
 * @param texts 文本数组
 * @returns 哈希值数组，顺序与输入对应
 */
export function computeContentHashes(texts: string[]): string[] {
  return texts.map(text => computeContentHash(text));
}

/**
 * 从稳定逻辑键生成 RFC 9562 UUIDv8。
 *
 * Postgres durable 表使用 UUID 主键；调用方仍可把 sourceId/candidateId 等逻辑键
 * 留在 metadata/provenance，但不得把带前缀的业务字符串直接写入 UUID 列。
 */
export function deterministicUuid(input: string): string {
  const hex = createHash("sha256").update(input).digest("hex").slice(0, 32).split("");
  hex[12] = "8";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 已是 UUID 则保留，否则用带 domain 的逻辑键派生 durable UUID。 */
export function durableUuid(domain: string, logicalId: string): string {
  if (!domain || !logicalId) throw new Error("durable UUID domain and logical id are required");
  return UUID.test(logicalId)
    ? logicalId
    : deterministicUuid(`mengshu:${domain}\0${logicalId}`);
}
