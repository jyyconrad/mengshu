/**
 * 安全的本地文件内容加载器（memory_ingest sourceType="file" 专用）。
 *
 * 本文件做什么：
 *   - 在把外部文件喂给 ingestion pipeline 之前，强制三道安全校验：
 *     1. 路径遍历防护：拒绝任何包含 `..` 段的路径（防止逃逸到仓库/系统敏感目录）。
 *     2. 扩展名白名单：只允许 .txt / .md / .json（避免误读二进制或可执行文件）。
 *     3. 存在性校验：文件必须存在且是普通文件。
 *   - 通过校验后读取 UTF-8 文本内容并原样返回，不做内容改写（注入防护在调用侧统一处理）。
 *
 * 关键边界：
 *   - 安全关键：`..` 检测在 path.normalize 之前做，避免 normalize 把遍历段悄悄消化掉。
 *   - 不解析符号链接目标，调用方对可访问目录负责。
 */

import fs from "node:fs/promises";
import path from "node:path";

/** 允许加载的扩展名白名单。 */
const ALLOWED_EXTENSIONS = new Set([".txt", ".md", ".json"]);

export interface LoadedFile {
  /** 解析后的绝对路径。 */
  filePath: string;
  /** UTF-8 文本内容。 */
  content: string;
}

/**
 * 安全加载文件内容。校验失败时抛出明确错误，绝不静默降级。
 */
export async function loadFileContent(filePath: string): Promise<LoadedFile> {
  if (typeof filePath !== "string" || filePath.trim().length === 0) {
    throw new Error("file path is required");
  }

  // 1. 路径遍历防护：任何 `..` 段都拒绝（在 normalize 之前判断）。
  const segments = filePath.split(/[\\/]+/);
  if (segments.includes("..")) {
    throw new Error(`refusing path traversal in file path: ${filePath}`);
  }

  // 2. 扩展名白名单校验。
  const ext = path.extname(filePath).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(
      `unsupported file extension "${ext}"; allowed: ${Array.from(ALLOWED_EXTENSIONS).join(", ")}`,
    );
  }

  const resolved = path.resolve(filePath);

  // 3. 存在性 + 普通文件校验。
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch {
    throw new Error(`file not found: ${filePath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`not a regular file: ${filePath}`);
  }

  const content = await fs.readFile(resolved, "utf8");
  return { filePath: resolved, content };
}
