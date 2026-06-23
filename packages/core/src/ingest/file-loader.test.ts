/**
 * file-loader 安全加载测试。
 *
 * 策略：覆盖白名单（扩展名）、路径遍历拒绝、存在性校验三条安全边界。
 * 关键边界：含 `..` 的路径必须拒绝（防止读取仓库外/系统敏感文件）。
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadFileContent } from "./file-loader.js";

let tmpDir: string;
let txtPath: string;
let mdPath: string;
let jsonPath: string;
let datPath: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mengshu-file-loader-"));
  txtPath = path.join(tmpDir, "test.txt");
  mdPath = path.join(tmpDir, "note.md");
  jsonPath = path.join(tmpDir, "data.json");
  datPath = path.join(tmpDir, "blob.dat");
  fs.writeFileSync(txtPath, "hello txt");
  fs.writeFileSync(mdPath, "# heading\n\nbody");
  fs.writeFileSync(jsonPath, JSON.stringify({ a: 1 }));
  fs.writeFileSync(datPath, "binary-ish");
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadFileContent", () => {
  test("loads .txt content", async () => {
    const result = await loadFileContent(txtPath);
    expect(result.content).toBe("hello txt");
    expect(result.filePath).toBe(txtPath);
  });

  test("loads .md content", async () => {
    const result = await loadFileContent(mdPath);
    expect(result.content).toContain("# heading");
  });

  test("loads .json content", async () => {
    const result = await loadFileContent(jsonPath);
    expect(result.content).toContain("\"a\"");
  });

  test("rejects path traversal (.. segments)", async () => {
    await expect(loadFileContent("../../etc/passwd")).rejects.toThrow(/path traversal|遍历|\.\./i);
  });

  test("rejects path with embedded .. even when absolute", async () => {
    await expect(loadFileContent(`${tmpDir}/../../../etc/passwd`)).rejects.toThrow(
      /path traversal|遍历|\.\./i,
    );
  });

  test("rejects unsupported extension", async () => {
    await expect(loadFileContent(datPath)).rejects.toThrow(/unsupported|扩展名|extension/i);
  });

  test("rejects missing file", async () => {
    await expect(loadFileContent(path.join(tmpDir, "nope.txt"))).rejects.toThrow(
      /not found|不存在|exist/i,
    );
  });
});
