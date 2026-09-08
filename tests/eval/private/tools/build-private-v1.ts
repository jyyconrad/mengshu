import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseEvalCaseV2, type EvalCaseV2 } from "../../public/protocol.js";

interface Registry {
  readonly datasetId: string;
  readonly targetCaseCount: number;
  readonly cohortQuotas: Readonly<Record<string, number>>;
  readonly capabilityQuotas: Readonly<Record<string, number>>;
  readonly requiredAnnotators: number;
  readonly minimumKappa: number;
}

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*[^\s"']{8,}/i,
  /\bBearer\s+[A-Za-z0-9._-]{16,}\b/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
] as const;
const DIRECT_IDENTIFIER_PATTERNS = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/,
] as const;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function readCases(file: string | undefined): { cases: readonly EvalCaseV2[]; jsonl: string } {
  if (file === undefined) return { cases: [], jsonl: "" };
  const lines = readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  const cases = lines.map((line) => parseEvalCaseV2(JSON.parse(line)));
  if (cases.some((item) => item.track !== "private") ||
      new Set(cases.map((item) => item.id)).size !== cases.length) {
    throw new Error("private case file contains an invalid track or duplicate id");
  }
  const jsonl = cases.map((item) => JSON.stringify(item)).join("\n") + (cases.length ? "\n" : "");
  return { cases, jsonl };
}

function counts(values: readonly string[], keys: readonly string[]): Record<string, number> {
  return Object.fromEntries(keys.map((key) => [key, values.filter((value) => value === key).length]));
}

function main(): void {
  const registryPath = path.resolve("tests/eval/private/cohort-registry.json");
  const registry = JSON.parse(readFileSync(registryPath, "utf8")) as Registry;
  const input = readCases(argument("--cases"));
  const output = argument("--output") ?? path.join(
    os.homedir(), ".mengshu", "eval-datasets", "private", "private-v1",
  );
  const cohortKeys = Object.keys(registry.cohortQuotas);
  const capabilityKeys = Object.keys(registry.capabilityQuotas);
  const countsByCohort = counts(input.cases.map((item) => item.privateCohort!), cohortKeys);
  const countsByCapability = counts(input.cases.map((item) => item.capability), capabilityKeys);
  const crossDistribution = Object.fromEntries(cohortKeys.map((cohort) => [cohort,
    Object.fromEntries(capabilityKeys.map((capability) => [capability,
      input.cases.filter((item) => item.privateCohort === cohort &&
        item.capability === capability).length]))]));
  const serialized = input.jsonl;
  const privacyFindingCount = [...SECRET_PATTERNS, ...DIRECT_IDENTIFIER_PATTERNS]
    .filter((pattern) => pattern.test(serialized)).length;
  const annotationVerified = input.cases.filter((item) => {
    const official = item.official as Record<string, unknown> | undefined;
    return Number(official?.annotatorCount) >= registry.requiredAnnotators &&
      Number(official?.cohenKappa) >= registry.minimumKappa &&
      official?.annotationState === "verified";
  }).length;
  const blockers: string[] = [];
  for (const [cohort, quota] of Object.entries(registry.cohortQuotas)) {
    if (countsByCohort[cohort] !== quota) blockers.push(`cohort_quota_unmet:${cohort}`);
  }
  for (const [capability, quota] of Object.entries(registry.capabilityQuotas)) {
    if (countsByCapability[capability] !== quota) blockers.push(`capability_quota_unmet:${capability}`);
  }
  if (countsByCohort["fresh-holdout"]! < 150) blockers.push("private_fresh_quota_not_met");
  if (input.cases.length === 0 || annotationVerified !== input.cases.length) {
    blockers.push("independent_annotation_incomplete");
  }
  if (privacyFindingCount > 0) blockers.push("privacy_scan_failed");
  if (input.cases.length !== registry.targetCaseCount) blockers.push("target_case_count_unmet");
  const manifest = Object.freeze({
    schemaVersion: "1",
    datasetId: registry.datasetId,
    status: blockers.length === 0 ? "frozen" as const : "collecting" as const,
    caseCount: input.cases.length,
    targetCaseCount: registry.targetCaseCount,
    countsByCohort,
    countsByCapability,
    crossDistribution,
    casesSha256: sha256(serialized),
    privacyScan: { passed: privacyFindingCount === 0, findingCount: privacyFindingCount },
    annotation: {
      requiredAnnotators: registry.requiredAnnotators,
      minimumKappa: registry.minimumKappa,
      verifiedCaseCount: annotationVerified,
    },
    blockers: [...new Set(blockers)].sort(),
  });
  mkdirSync(output, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(output, "redacted-cases.jsonl"), serialized, { mode: 0o600 });
  writeFileSync(path.join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  process.stdout.write(`${JSON.stringify({ output, manifest }, null, 2)}\n`);
}

main();
