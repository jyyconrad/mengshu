import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  adaptLongMemEvalCase,
  selectLongMemEvalStratified,
  type OfficialLongMemEvalCase,
} from "../adapters/longmemeval.js";
import {
  adaptMemoryAgentBenchRow,
  type MemoryAgentBenchSplit,
  type OfficialMemoryAgentBenchRow,
} from "../adapters/memoryagentbench.js";
import type { EvalCaseV2 } from "../protocol.js";

const SOURCE_ROOT = path.join(os.homedir(), ".mengshu", "eval-datasets", "public");
const OUTPUT_ROOT = path.join(SOURCE_ROOT, "frozen", "g0-v1");
const LONGMEM_SHA = "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442";
const MAB_SHA: Readonly<Record<MemoryAgentBenchSplit, string>> = Object.freeze({
  Accurate_Retrieval: "56c3cd80fb6731a3e53cd1a6be3148f54df60ff2d290ee50e28f8acebf9655c1",
  Test_Time_Learning: "5338753be48f925d03318eed66117286e3489025fabe050a547bd086cd7d79c0",
  Long_Range_Understanding: "5ab175461954db67770d4a4cb69e569b513ebb96aceb9ee79b57f67488bcd539",
  Conflict_Resolution: "24d5c3f09ce0ce15625cb9f8a98f44f0d864ca6c94d7b4ad04eb697ca3a5ff45",
});
const SPLITS = Object.keys(MAB_SHA) as MemoryAgentBenchSplit[];

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function readJsonl(file: string): Array<{ rowIndex: number; row: OfficialMemoryAgentBenchRow }> {
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as { rowIndex: number; row: OfficialMemoryAgentBenchRow });
}

function memoryAgentSmokeCases(exportDir: string): Readonly<EvalCaseV2>[] {
  const selected: EvalCaseV2[] = [];
  for (const split of SPLITS) {
    const rows = readJsonl(path.join(exportDir, `${split}.jsonl`));
    const coordinates = rows.flatMap(({ rowIndex, row }) =>
      row.questions.map((question, questionIndex) => ({
        rowIndex,
        questionIndex,
        order: sha256(`${split}\0${rowIndex}\0${questionIndex}\0${question}\0${42}`),
      })))
      .sort((left, right) => left.order.localeCompare(right.order))
      .slice(0, 5);
    for (const coordinate of coordinates) {
      const row = rows.find((candidate) => candidate.rowIndex === coordinate.rowIndex)?.row;
      if (row === undefined) throw new Error("MemoryAgentBench selected row is unavailable");
      selected.push(...adaptMemoryAgentBenchRow(row, {
        benchmarkSplit: split,
        datasetVersion: `main@${MAB_SHA[split]}`,
        rowIndex: coordinate.rowIndex,
        questionIndexes: [coordinate.questionIndex],
      }));
    }
  }
  return selected;
}

function main(): void {
  const longMemPath = path.join(
    SOURCE_ROOT,
    "longmemeval-cleaned",
    "longmemeval_s_cleaned.json",
  );
  const memoryAgentExportDir = path.join(SOURCE_ROOT, "memoryagentbench-json");
  const source = readFileSync(longMemPath);
  if (sha256(source) !== LONGMEM_SHA) throw new Error("LongMemEval source hash mismatch");
  const longMem = JSON.parse(source.toString("utf8")) as OfficialLongMemEvalCase[];
  const selectedLongMem = selectLongMemEvalStratified(longMem, 100, 42)
    .map((raw) => adaptLongMemEvalCase(raw, {
      datasetVersion: `s_cleaned@${LONGMEM_SHA}`,
      topK: 10,
      contextTokenBudget: 32_768,
    }));
  const selectedMemoryAgent = memoryAgentSmokeCases(memoryAgentExportDir);
  const cases = [...selectedLongMem, ...selectedMemoryAgent]
    .sort((left, right) => left.benchmarkId.localeCompare(right.benchmarkId) ||
      left.id.localeCompare(right.id));
  const jsonl = cases.map((value) => JSON.stringify(value)).join("\n") + "\n";
  mkdirSync(OUTPUT_ROOT, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(OUTPUT_ROOT, "cases.jsonl"), jsonl, { mode: 0o600 });
  const counts = Object.fromEntries([...new Set(cases.map((value) => value.capability))]
    .sort().map((capability) => [capability,
      cases.filter((value) => value.capability === capability).length]));
  const manifest = {
    schemaVersion: "1",
    datasetId: "mengshu-public-g0-v1",
    status: "frozen",
    randomSeed: 42,
    caseCount: cases.length,
    sourceRegistry: "tests/eval/public/registry.json",
    sources: {
      longmemeval: {
        revision: "9e0b455f4ef0e2ab8f2e582289761153549043fc",
        sha256: LONGMEM_SHA,
        selectedCases: selectedLongMem.length,
      },
      memoryagentbench: {
        revision: "fe1735de8cf8b9908e1e3d3b5612afc815698062",
        splitSha256: MAB_SHA,
        selectedCases: selectedMemoryAgent.length,
      },
    },
    countsByCapability: counts,
    casesSha256: sha256(jsonl),
  };
  writeFileSync(
    path.join(OUTPUT_ROOT, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    { mode: 0o600 },
  );
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

main();
