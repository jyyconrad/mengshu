import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  buildSelfBuiltManifest,
  generateSelfBuiltCases,
  serializeSelfBuiltCases,
} from "../generator.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function main(): void {
  const output = path.resolve(argument("--output") ??
    "tests/eval/selfbuilt/data/mengshu-selfbuilt-v1");
  const cases = generateSelfBuiltCases();
  const jsonl = serializeSelfBuiltCases(cases);
  const manifest = buildSelfBuiltManifest(cases, jsonl);
  mkdirSync(output, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(output, "cases.jsonl"), jsonl, { mode: 0o600 });
  writeFileSync(path.join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  const workbook = path.join(output, "cases.xlsx");
  execFileSync(process.env.MENGSHU_PYTHON?.trim() || "python3", [
    path.resolve("tests/eval/selfbuilt/tools/export-selfbuilt-xlsx.py"),
    path.join(output, "cases.jsonl"),
    path.join(output, "manifest.json"),
    workbook,
  ], { stdio: "pipe" });
  chmodSync(workbook, 0o600);
  process.stdout.write(`${JSON.stringify({ output, workbook, manifest }, null, 2)}\n`);
}

main();
