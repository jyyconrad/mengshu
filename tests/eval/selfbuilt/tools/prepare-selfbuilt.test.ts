import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { parseSelfBuiltEvalCaseV1 } from "../protocol.js";

const projectRoot = path.resolve(import.meta.dirname, "../../../..");

describe("self-built dataset prepare CLI", () => {
  test("writes a private-mode frozen dataset and verifies its manifest hash", () => {
    const output = mkdtempSync(path.join(os.tmpdir(), "mengshu-selfbuilt-"));
    execFileSync("npx", ["tsx", "tests/eval/selfbuilt/tools/prepare-selfbuilt.ts",
      "--output", output], { cwd: projectRoot, stdio: "pipe" });
    const jsonl = readFileSync(path.join(output, "cases.jsonl"));
    const manifest = JSON.parse(readFileSync(path.join(output, "manifest.json"), "utf8"));
    const cases = jsonl.toString("utf8").trim().split("\n")
      .map((line) => parseSelfBuiltEvalCaseV1(JSON.parse(line)));

    expect(cases).toHaveLength(360);
    expect(manifest.casesSha256).toBe(createHash("sha256").update(jsonl).digest("hex"));
    expect(statSync(path.join(output, "cases.jsonl")).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(output, "manifest.json")).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(output, "cases.xlsx")).mode & 0o777).toBe(0o600);
    const workbook = JSON.parse(execFileSync("python3", ["-c", [
      "import json,sys,openpyxl",
      "w=openpyxl.load_workbook(sys.argv[1],read_only=True,data_only=False)",
      "print(json.dumps({'sheets':w.sheetnames,'cases':w['Cases'].max_row-1," +
        "'events':w['Events'].max_row-1,'coverage_formula':w['Coverage']['C2'].value}))",
    ].join(";"), path.join(output, "cases.xlsx")], { encoding: "utf8" }));
    expect(workbook).toMatchObject({
      sheets: ["说明", "Cases", "Events", "Coverage"],
      cases: 360,
      coverage_formula: expect.stringMatching(/^=COUNTIF/),
    });
    expect(workbook.events).toBeGreaterThan(1_000);
  });
});
