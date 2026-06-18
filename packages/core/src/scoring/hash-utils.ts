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

/**
 * 批量计算文本内容的MD5哈希值
 * @param texts 文本数组
 * @returns 哈希值数组，顺序与输入对应
 */
export function computeContentHashes(texts: string[]): string[] {
  return texts.map(text => computeContentHash(text));
}
