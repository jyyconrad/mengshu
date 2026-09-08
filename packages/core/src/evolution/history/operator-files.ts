import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { historyContentSha256 } from "./native-materials.js";
import { exactObject, isHash, rejectHistory } from "./schema.js";

export interface HistoryArtifactRef { path: string; sha256: string }
export class HistoryArtifactReader {
  private total = 0;
  constructor(readonly root: string, readonly maxFileBytes = 128 * 1024 * 1024, readonly maxTotalBytes = 256 * 1024 * 1024) {}
  async read(ref: HistoryArtifactRef): Promise<string> {
    exactObject(ref, ["path", "sha256"]);
    if (!isAbsolute(this.root) || typeof ref.path !== "string" || !ref.path || !isHash(ref.sha256)) rejectHistory("HISTORY_ARTIFACT_REF_INVALID");
    const root = resolve(this.root), path = resolve(root, ref.path), rel = relative(root, path);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || await realpath(root) !== root) rejectHistory("HISTORY_ARTIFACT_PATH_DENIED");
    let current = root;
    for (const part of rel.split(sep)) {
      current = resolve(current, part);
      if ((await lstat(current)).isSymbolicLink()) rejectHistory("HISTORY_ARTIFACT_SYMLINK_DENIED");
    }
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size > this.maxFileBytes || this.total + before.size > this.maxTotalBytes) rejectHistory("HISTORY_ARTIFACT_READ_BUDGET");
      const data = Buffer.alloc(before.size + 1);
      let bytes = 0;
      while (bytes < data.length) { const result = await file.read(data, bytes, data.length - bytes, bytes); if (!result.bytesRead) break; bytes += result.bytesRead; }
      const after = await file.stat(); this.total += bytes;
      if (bytes !== before.size || after.size !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || historyContentSha256(data.subarray(0, bytes)) !== ref.sha256) rejectHistory("HISTORY_ARTIFACT_DRIFT");
      try { return new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, bytes)); } catch { return rejectHistory("HISTORY_ARTIFACT_UTF8_INVALID"); }
    } finally { await file.close(); }
  }
}

export async function writeHistoryArtifactExclusive(path: string, value: unknown): Promise<void> {
  if (!isAbsolute(path)) rejectHistory("HISTORY_OUTPUT_PATH_INVALID");
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
}
