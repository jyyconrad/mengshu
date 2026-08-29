import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const RECEIPT_SCHEMA = "mengshu.empty-tree-stage-receipt/v1";
const SHA256 = /^[0-9a-f]{64}$/;

type TreeType = "source" | "topic" | "global";

class EmptyTreeStageError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "EmptyTreeStageError";
  }
}

function fail(code: string): never {
  throw new EmptyTreeStageError(code);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function strictDescendant(root: string, target: string): boolean {
  const child = relative(root, target);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function containedPath(root: string, path: string): string {
  if (!path || isAbsolute(path)) fail("EMPTY_TREE_STAGE_PATH_INVALID");
  const target = resolve(root, path);
  if (!strictDescendant(root, target)) fail("EMPTY_TREE_STAGE_PATH_INVALID");
  return target;
}

async function readVerified(root: string, path: string, expectedHash: string): Promise<string> {
  if (!SHA256.test(expectedHash)) fail("EMPTY_TREE_STAGE_INPUT_INVALID");
  const target = containedPath(root, path);
  let current = root;
  for (const part of relative(root, target).split(sep)) {
    current = resolve(current, part);
    const info = await lstat(current).catch(() => fail("EMPTY_TREE_STAGE_FILESYSTEM_ERROR"));
    if (info.isSymbolicLink()) fail("EMPTY_TREE_STAGE_SYMLINK");
  }
  const text = await readFile(target, "utf8").catch(() =>
    fail("EMPTY_TREE_STAGE_FILESYSTEM_ERROR"));
  if (sha256(text) !== expectedHash) fail("EMPTY_TREE_STAGE_INPUT_DRIFT");
  return text;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    fail("EMPTY_TREE_STAGE_INPUT_INVALID");
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("EMPTY_TREE_STAGE_INPUT_INVALID");
  }
  return value as Record<string, unknown>;
}

function eligibleCount(treeType: TreeType, text: string): number {
  if (treeType === "global") {
    if (!text.endsWith("\n") || text.trim().length === 0) {
      fail("EMPTY_TREE_STAGE_INPUT_INVALID");
    }
    return text.trimEnd().split("\n").map(parseJson).filter((raw) =>
      record(raw).globalTreeEligible === true).length;
  }
  const root = record(parseJson(text));
  const key = treeType === "source" ? "sources" : "topics";
  if (!Array.isArray(root[key])) fail("EMPTY_TREE_STAGE_INPUT_INVALID");
  return (root[key] as unknown[]).filter((raw) => record(raw).treeEligible === true).length;
}

async function writeExclusive(path: string, content: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
      constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } catch {
    fail("EMPTY_TREE_STAGE_OUTPUT_WRITE_FAILED");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flags = [
    "--migration-root", "--tree-type", "--eligibility", "--eligibility-sha256",
    "--upstream-receipt", "--upstream-receipt-sha256", "--output-root", "--created-at",
  ];
  if (argv.length !== flags.length * 2 || flags.some((flag, index) => argv[index * 2] !== flag)) {
    fail("EMPTY_TREE_STAGE_INVALID_ARGUMENT");
  }
  const root = resolve(argv[1]!);
  const treeType = argv[3]! as TreeType;
  const createdAt = argv[15]!;
  if (!isAbsolute(argv[1]!) || root !== argv[1] ||
      !["source", "topic", "global"].includes(treeType) ||
      new Date(createdAt).toISOString() !== createdAt) fail("EMPTY_TREE_STAGE_INVALID_ARGUMENT");
  const [eligibilityText] = await Promise.all([
    readVerified(root, argv[5]!, argv[7]!),
    readVerified(root, argv[9]!, argv[11]!),
  ]);
  const eligible = eligibleCount(treeType, eligibilityText);
  if (eligible !== 0) fail("EMPTY_TREE_STAGE_NONEMPTY_INPUT");
  const outputRoot = containedPath(root, argv[13]!);
  try {
    await lstat(outputRoot);
    fail("EMPTY_TREE_STAGE_OUTPUT_EXISTS");
  } catch (error) {
    if (error instanceof EmptyTreeStageError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      fail("EMPTY_TREE_STAGE_FILESYSTEM_ERROR");
    }
  }
  const level = ({ source: "L1", topic: "L2", global: "L3" } as const)[treeType];
  const body = {
    schema: RECEIPT_SCHEMA,
    createdAt,
    treeType,
    level,
    inputs: {
      eligibilitySha256: argv[7]!,
      upstreamReceiptSha256: argv[11]!,
    },
    summary: {
      eligibleGroupCount: 0,
      assignedBatchCount: 0,
      proposalCount: 0,
      crossReviewCount: 0,
      sealedTreeAssetCount: 0,
      faithfulnessFailureCount: 0,
      evidenceCoverage: 1,
    },
    guards: {
      noEligibleBatchDispatched: true,
      thresholdRelaxed: false,
      unsealedTreeWritten: false,
      formalTreeMarkdownWritten: false,
      postgresTouched: false,
    },
  };
  const bodyHash = sha256(JSON.stringify(stableValue(body)));
  const receiptText = canonicalJson({ ...body, receiptHash: bodyHash });
  await mkdir(outputRoot, { mode: 0o700 });
  await writeExclusive(resolve(outputRoot, "receipt.json"), receiptText);
  process.stdout.write(`${JSON.stringify({
    receipt: `${argv[13]}/receipt.json`,
    receiptSha256: sha256(receiptText),
    receiptHash: bodyHash,
    summary: body.summary,
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    const code = error instanceof EmptyTreeStageError
      ? error.code : "EMPTY_TREE_STAGE_UNEXPECTED_ERROR";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
