/**
 * wiki-promote —— wiki 正式化批次 A（plan: work/tasks/2026-10-09-wiki-promotion/plan.md）。
 *
 * 把 rerun 冻结证据升级为正式 wiki 正本：零数据库、零 LLM、零凭据。
 *
 * 命令：
 *   promote --run <rerun根> --dest <wiki根> [--expected-pages 9581] [--concurrency 16]
 *
 * 做什么：
 *   1. 读 <run>/scope-templates.json 的 canonical scope（实测 21 个）→ 唯一短 slug
 *      （取 scopeKey 的 workspace 段；冲突以尾段消歧），写 <dest>/scope-registry.json；
 *   2. 复制 <run>/wiki/final/part-NNN/page-NNN.md 与同名 .sources 到
 *      <dest>/pages/<slug>/page-NNN.{md,sources}；scope 取自页面 frontmatter scope_key；
 *      同 slug 跨 part 重号时顺延重编号（真实数据每 part 页号从 001 重启，重号是
 *      常态而非例外：knowledge-legacy-openclaw-workspace 5,760 页跨 75 part →
 *      renumbered=5,683，全库 8,484/9,581；验收口径以 registry/receipt 实测值为准，
 *      勿按「少量冲突页」预估）；旧→新路径逐页写 <dest>/path-map.jsonl
 *      （一页一行 = 9581 行，同时含 .md 与 .sources 的新旧路径）；
 *   3. 迁移重写 <run>/wiki/INDEX.md 与 <run>/wiki/completion.jsonl 到 dest
 *      （旧相对路径 part-NNN/page-NNN.* 经 path-map 替换为新相对路径 pages/<slug>/…）；
 *   4. 自检门禁（pages/sources/id 唯一覆盖/逐字节一致/scope↔slug/INDEX 汇总），
 *      写 <dest>/receipts/promotion.json；stdout 最后一行输出
 *      {pages,sources,uniqueIds,contentMismatches,renumbered,slugs}。
 *
 * 铁律（与 operator-wiki-knowledge-replace.ts 同源）：
 *   - rerun 源目录只读：不移动、不改名、不修改，全程仅 readFile/lstat；
 *   - 所有产物经临时文件 + 原子 rename 落盘；dest 必须不存在或为空目录，
 *     且不得等于或位于 run 源树之内（防误配把产物写进冻结源树）；
 *   - 复制逐文件回读与源逐字节比对（Buffer.equals），任一不一致计入 contentMismatches；
 *   - 任一门禁不过：回执照写（对账用），进程 exit 1，绝不静默降级；
 *   - 本工具不读取任何配置文件，输出不携带 apiKey/密码/host/用户名。
 */
import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_EXPECTED_PAGES = 9581;
const SPACE_ID = /^embedding-space:v1:[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PART_DIR_RE = /^part-\d{3,}$/;
const PAGE_FILE_RE = /^page-(\d{3,})\.(md|sources)$/;
/** 旧相对路径（相对 wiki/final，与 completion.jsonl 的 page 字段同构）。 */
const LEGACY_PATH_RE = /part-\d{3,}\/page-\d{3,}\.(?:md|sources)/g;
/** slug 允许的目录名形态（首字符字母/数字/下划线——真实数据含 `__unscoped__`；拒绝 "."、".."、路径分隔符）。 */
const SLUG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

function fail(message: string): never {
  throw new Error(message);
}

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

async function atomicWrite(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomUUID()}`);
  await writeFile(tmp, data, "utf8");
  await rename(tmp, path);
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** 临时文件 + 原子 rename 的复制（不保留 mode 之外的任何改写，字节级保真）。 */
async function atomicCopy(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  const tmp = join(dirname(to), `.${basename(to)}.tmp-${process.pid}-${randomUUID()}`);
  await copyFile(from, tmp);
  await rename(tmp, to);
}

async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function arg(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) fail(`missing ${name}`);
  return value;
}

function optionalNumberArg(name: string): number | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) fail(`invalid ${name}: ${value}`);
  return parsed;
}

// ---------------------------------------------------------------------------
// 纯函数（离线可测）
// ---------------------------------------------------------------------------

export interface ScopeTemplateEntry {
  readonly scopeKey: string;
  readonly embeddingSpaceId: string;
}

/**
 * scopeKey 的 workspace 段：`local:tenant:user:workspace:agent:namespace` 取第 4 段；
 * 段数不足（如 `__unscoped__`）时整个 scopeKey 即 slug 基底。
 */
export function scopeWorkspaceSegment(scopeKey: string): string {
  const segments = scopeKey.split(":");
  return segments.length >= 6 ? segments[3]! : scopeKey;
}

/**
 * 21 个 canonical scope → 唯一短 slug：
 * 基底 = workspace 段；同基底冲突时以 scopeKey 尾段消歧（如 default-knowledge /
 * default-memories、switchgear-knowledge / switchgear-working-context）；
 * 消歧后仍冲突（同 workspace 且同尾段的不同 scope）则拒绝执行，不静默再加工。
 */
export function buildScopeSlugs(templates: readonly ScopeTemplateEntry[]): ReadonlyMap<string, string> {
  const byBase = new Map<string, string[]>();
  for (const template of templates) {
    const base = scopeWorkspaceSegment(template.scopeKey);
    if (!SLUG_RE.test(base) || base === "." || base === "..") {
      fail(`workspace segment is not a safe directory name: ${base} (scope ${template.scopeKey})`);
    }
    const group = byBase.get(base) ?? [];
    group.push(template.scopeKey);
    byBase.set(base, group);
  }
  const slugs = new Map<string, string>();
  for (const [base, scopeKeys] of byBase) {
    if (scopeKeys.length === 1) {
      slugs.set(scopeKeys[0]!, base);
      continue;
    }
    for (const scopeKey of scopeKeys) {
      const tail = scopeKey.split(":").at(-1)!;
      const slug = `${base}-${tail}`;
      if (!SLUG_RE.test(slug)) fail(`disambiguated slug is not a safe directory name: ${slug}`);
      slugs.set(scopeKey, slug);
    }
  }
  const distinct = new Set(slugs.values());
  if (distinct.size !== slugs.size) {
    fail(`slug collision persists after tail disambiguation: ${[...slugs.entries()]
      .filter(([scope, slug]) => [...slugs.values()].filter((other) => other === slug).length > 1)
      .map(([scope, slug]) => `${scope}->${slug}`)
      .slice(0, 5)
      .join(", ")}`);
  }
  return slugs;
}

export interface RenumberPageInput {
  /** 来源 part 目录名（如 "part-001"）。 */
  readonly part: string;
  /** 原始页号（文件名 page-NNN 的 N）。 */
  readonly number: number;
  /** 页面归属 slug。 */
  readonly slug: string;
}

export interface RenumberAssignment {
  readonly part: string;
  readonly number: number;
  readonly slug: string;
  readonly newNumber: number;
}

/**
 * 同 slug 内跨 part 页号冲突时顺延重编号：按 (part, 原页号) 顺序贪心分配——
 * 原页号未被占用则保留；已占用则从原页号起向上取最小空闲号（顺延）。
 * 单 part 的 slug 天然零冲突（目录内文件名唯一），编号原样保留。
 */
export function assignNewPageNumbers(pages: readonly RenumberPageInput[]): {
  assignments: RenumberAssignment[];
  renumbered: number;
} {
  const bySlug = new Map<string, RenumberPageInput[]>();
  for (const page of pages) {
    const group = bySlug.get(page.slug) ?? [];
    group.push(page);
    bySlug.set(page.slug, group);
  }
  const assignments: RenumberAssignment[] = [];
  let renumbered = 0;
  for (const [, group] of [...bySlug.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    group.sort((left, right) =>
      left.part === right.part ? left.number - right.number : left.part.localeCompare(right.part),
    );
    const used = new Set<number>();
    for (const page of group) {
      let target = page.number;
      while (used.has(target)) target += 1;
      used.add(target);
      if (target !== page.number) renumbered += 1;
      assignments.push({ part: page.part, number: page.number, slug: page.slug, newNumber: target });
    }
  }
  return { assignments, renumbered };
}

export function pageFileName(number: number): string {
  return `page-${String(number).padStart(3, "0")}`;
}

export interface IndexAggregate {
  readonly scope: string;
  readonly semanticType: string;
  readonly pages: number;
  readonly sources: number;
}

export interface ParsedIndex {
  readonly totals: { pages: number; sources: number } | null;
  readonly aggregates: readonly IndexAggregate[];
  readonly violations: readonly string[];
}

/** 解析 INDEX.md 的「共 N 页,M 条来源记录。」与「## scope /- type: N 页 / M 来源」汇总。 */
export function parseIndexMarkdown(text: string): ParsedIndex {
  const violations: string[] = [];
  let totals: { pages: number; sources: number } | null = null;
  const aggregates: IndexAggregate[] = [];
  let currentScope: string | null = null;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    const totalsMatch = /^共 (\d+) 页,(\d+) 条来源记录。$/.exec(line);
    if (totalsMatch) {
      if (totals) violations.push(`duplicate totals line: ${line}`);
      totals = { pages: Number(totalsMatch[1]), sources: Number(totalsMatch[2]) };
      continue;
    }
    const scopeMatch = /^## (.+)$/.exec(line);
    if (scopeMatch) {
      currentScope = scopeMatch[1]!.trim();
      continue;
    }
    const aggregateMatch = /^- ([A-Za-z_]+): (\d+) 页 \/ (\d+) 来源$/.exec(line);
    if (aggregateMatch) {
      if (!currentScope) {
        violations.push(`aggregate line outside any scope heading: ${line}`);
        continue;
      }
      aggregates.push({
        scope: currentScope,
        semanticType: aggregateMatch[1]!,
        pages: Number(aggregateMatch[2]),
        sources: Number(aggregateMatch[3]),
      });
    }
  }
  if (!totals) violations.push("INDEX.md is missing the totals line");
  return { totals, aggregates, violations };
}

export interface PathRewriteResult {
  readonly text: string;
  readonly replacements: number;
  readonly unknownPaths: readonly string[];
}

/**
 * 通用旧路径重写：把文本中出现的 part-NNN/page-NNN.(md|sources) 经 path-map 替换为
 * pages/<slug>/…。出现 map 外的旧路径属于协议破坏，登记不替换（绝不猜）。
 */
export function rewriteLegacyPaths(text: string, pathMap: ReadonlyMap<string, string>): PathRewriteResult {
  const unknownPaths: string[] = [];
  let replacements = 0;
  const rewritten = text.replace(LEGACY_PATH_RE, (match) => {
    const mapped = pathMap.get(match);
    if (mapped === undefined) {
      unknownPaths.push(match);
      return match;
    }
    replacements += 1;
    return mapped;
  });
  return { text: rewritten, replacements, unknownPaths };
}

export interface CompletionRow {
  readonly id: string;
  readonly page: string;
  readonly scope: string;
  readonly semanticType: string;
}

/** completion.jsonl 单行解析：id 必须是 UUID，page 必须是旧相对路径，字段缺失拒绝。 */
export function parseCompletionRow(line: string): CompletionRow {
  const value = JSON.parse(line) as Partial<CompletionRow>;
  if (typeof value.id !== "string" || !UUID.test(value.id)) fail(`completion row id is invalid: ${line.slice(0, 120)}`);
  if (typeof value.page !== "string" || !/^part-\d{3,}\/page-\d{3,}\.md$/.test(value.page)) {
    fail(`completion row page is not a legacy page path: ${line.slice(0, 120)}`);
  }
  if (typeof value.scope !== "string" || value.scope.length === 0) fail(`completion row scope is missing: ${line.slice(0, 120)}`);
  if (typeof value.semanticType !== "string" || value.semanticType.length === 0) {
    fail(`completion row semanticType is missing: ${line.slice(0, 120)}`);
  }
  return { id: value.id, page: value.page, scope: value.scope, semanticType: value.semanticType };
}

/** frontmatter 单键读取（与 operator-wiki-knowledge-replace.ts 的 header() 同语义的最小实现）。 */
export function frontmatterValue(markdown: string, key: string): string {
  const text = markdown.replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) fail("wiki page is missing frontmatter");
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) fail("wiki page frontmatter is not closed");
  const match = text.slice(4, end).match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  if (!match?.[1]) fail(`wiki page is missing ${key}`);
  return match[1].trim().replace(/^["']|["']$/g, "");
}

// ---------------------------------------------------------------------------
// 输入装载与扫描
// ---------------------------------------------------------------------------

function loadScopeTemplates(path: string): { templates: ScopeTemplateEntry[]; sha256: string } {
  const raw = readFileSync(path, "utf8");
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    fail(`scope-templates.json is not valid JSON: ${path} (${error instanceof Error ? error.message : "error"})`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) fail(`scope templates must be a non-empty array: ${path}`);
  const templates: ScopeTemplateEntry[] = [];
  for (const item of parsed) {
    const scopeKey = (item as { scopeKey?: unknown } | null)?.scopeKey;
    const embeddingSpaceId = (item as { embeddingSpaceId?: unknown } | null)?.embeddingSpaceId;
    if (typeof scopeKey !== "string" || scopeKey.length === 0) fail(`scope template entry has no scopeKey: ${path}`);
    if (typeof embeddingSpaceId !== "string" || !SPACE_ID.test(embeddingSpaceId)) {
      fail(`scope template entry has invalid embeddingSpaceId for ${scopeKey}: ${path}`);
    }
    templates.push({ scopeKey, embeddingSpaceId });
  }
  const distinct = new Set(templates.map((template) => template.scopeKey));
  if (distinct.size !== templates.length) fail(`scope templates contain duplicate scopeKey: ${path}`);
  return { templates, sha256: sha256Hex(raw) };
}

function readIdList(path: string): string[] {
  return readFileSync(path, "utf8").split("\n").map((line) => line.trim()).filter(Boolean);
}

export interface ScannedPage {
  /** 来源 part 目录名。 */
  readonly part: string;
  /** 原始页号。 */
  readonly number: number;
  /** 原始文件名主干（page-NNN，保留原零填充宽度，与 completion.jsonl 的 page 字段同构）。 */
  readonly stem: string;
  readonly mdPath: string;
  readonly sourcesPath: string;
}

/**
 * wiki/final 的严格扫描：只接受 part-NNN 目录与 page-NNN.md / 同名 page-NNN.sources；
 * 拒绝符号链接、嵌套目录、未配对条目与任何其他文件。
 */
export function scanFinalParts(finalRoot: string): { pages: ScannedPage[]; violations: string[] } {
  const violations: string[] = [];
  const pages: ScannedPage[] = [];
  const rootStats = lstatSync(finalRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    fail(`wiki final root is not a plain directory: ${finalRoot}`);
  }
  for (const part of readdirSync(finalRoot, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const partPath = join(finalRoot, part.name);
    if (part.isSymbolicLink()) {
      violations.push(`symlink part entry: ${partPath}`);
      continue;
    }
    if (part.isFile()) {
      violations.push(`unexpected file in final root (only part-NNN dirs allowed): ${partPath}`);
      continue;
    }
    if (!part.isDirectory() || !PART_DIR_RE.test(part.name)) {
      violations.push(`unexpected entry in final root: ${partPath}`);
      continue;
    }
    const mdStems = new Map<string, number>();
    const sourceStems = new Set<string>();
    for (const entry of readdirSync(partPath, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = join(partPath, entry.name);
      if (entry.isSymbolicLink()) {
        violations.push(`symlink page entry: ${entryPath}`);
        continue;
      }
      if (!entry.isFile()) {
        violations.push(`unexpected non-file page entry: ${entryPath}`);
        continue;
      }
      const match = PAGE_FILE_RE.exec(entry.name);
      if (!match) {
        violations.push(`undeclared page file (only page-NNN.md/.sources allowed): ${entryPath}`);
        continue;
      }
      const stem = entry.name.slice(0, -(match[2] === "md" ? 3 : 8));
      if (match[2] === "md") {
        if (mdStems.has(stem)) violations.push(`duplicate page stem in part: ${entryPath}`);
        mdStems.set(stem, Number(match[1]));
        pages.push({ part: part.name, number: Number(match[1]), stem, mdPath: entryPath, sourcesPath: `${entryPath.slice(0, -3)}.sources` });
      } else {
        sourceStems.add(stem);
      }
    }
    for (const [stem] of mdStems) {
      if (!sourceStems.has(stem)) violations.push(`missing paired .sources: ${join(partPath, `${stem}.md`)}`);
    }
    for (const stem of sourceStems) {
      if (!mdStems.has(stem)) violations.push(`orphan .sources without page: ${join(partPath, `${stem}.sources`)}`);
    }
  }
  if (pages.length === 0) violations.push(`wiki final root has no pages: ${finalRoot}`);
  return { pages: pages.sort((left, right) =>
    left.part === right.part ? left.number - right.number : left.part.localeCompare(right.part),
  ), violations };
}

async function assertPlainDirectory(path: string, label: string): Promise<void> {
  if (!isAbsolute(path)) fail(`${label} is not absolute: ${path}`);
  const stats = await lstat(path);
  if (stats.isSymbolicLink()) fail(`${label} is a symlink: ${path}`);
  if (!stats.isDirectory()) fail(`${label} is not a directory: ${path}`);
}

/**
 * dest 只允许不存在或空目录：混入旧内容会破坏对账基线。
 * 且 dest 不得等于或位于 run 源树之内——misconfigure 会把产物写进刚扫描完的
 * 冻结 rerun 树，违背「rerun 源目录只读」铁律且无告警。
 */
async function prepareDest(destRoot: string, runRoot: string): Promise<void> {
  if (!isAbsolute(destRoot)) fail(`dest is not absolute: ${destRoot}`);
  const rel = relative(runRoot, destRoot);
  if (rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel))) {
    fail(`dest must not be inside the read-only run root: ${destRoot} vs ${runRoot}`);
  }
  if (existsSync(destRoot)) {
    await assertPlainDirectory(destRoot, "dest");
    const leftover = readdirSync(destRoot);
    if (leftover.length > 0) fail(`dest is not empty (remove it first): ${destRoot} has ${leftover.length} entries`);
  }
  await mkdir(destRoot, { recursive: true });
}

// ---------------------------------------------------------------------------
// promote 主流程
// ---------------------------------------------------------------------------

export interface PromoteInput {
  readonly runRoot: string;
  readonly destRoot: string;
  /** 门禁期望页数（真实批次 A = 9581）。 */
  readonly expectedPages?: number;
  readonly concurrency?: number;
}

export interface PromoteSummary {
  readonly pages: number;
  readonly sources: number;
  readonly uniqueIds: number;
  readonly contentMismatches: number;
  readonly renumbered: number;
  readonly slugs: number;
}

interface PlannedPage extends ScannedPage {
  readonly scopeKey: string;
  readonly slug: string;
  readonly newNumber: number;
  readonly relOldMd: string;
  readonly relNewMd: string;
  readonly relOldSources: string;
  readonly relNewSources: string;
}

export async function runPromote(input: PromoteInput): Promise<PromoteSummary> {
  const expectedPages = input.expectedPages ?? DEFAULT_EXPECTED_PAGES;
  const concurrency = input.concurrency ?? 16;
  const runRoot = resolve(input.runRoot);
  const destRoot = resolve(input.destRoot);
  await assertPlainDirectory(runRoot, "run root");

  // 1) canonical scope → slug。
  const templatesPath = join(runRoot, "scope-templates.json");
  if (!existsSync(templatesPath)) fail(`scope-templates.json is missing: ${templatesPath}`);
  const { templates, sha256: templatesSha256 } = loadScopeTemplates(templatesPath);
  const slugs = buildScopeSlugs(templates);

  const beforeIdsPath = join(runRoot, "before-ids.txt");
  if (!existsSync(beforeIdsPath)) fail(`before-ids.txt is missing: ${beforeIdsPath}`);
  const beforeIdList = readIdList(beforeIdsPath);
  const beforeIds = new Set(beforeIdList);
  if (beforeIds.size !== beforeIdList.length) {
    fail(`before-ids.txt has ${beforeIdList.length - beforeIds.size} duplicate entries`);
  }
  const expectedSources = beforeIdList.length;

  // 2) 扫描 final parts + 读取 frontmatter scope_key。
  const finalRoot = join(runRoot, "wiki", "final");
  await assertPlainDirectory(finalRoot, "wiki final root");
  const scan = scanFinalParts(finalRoot);
  if (scan.violations.length > 0) {
    fail(`wiki final scan violations (${scan.violations.length}): ${scan.violations.slice(0, 10).join(" | ")}`);
  }
  const canonicalScopes = new Set(templates.map((template) => template.scopeKey));
  const scoped: Array<ScannedPage & { scopeKey: string; slug: string }> = [];
  for (const page of scan.pages) {
    const scopeKey = frontmatterValue(readFileSync(page.mdPath, "utf8"), "scope_key");
    if (!canonicalScopes.has(scopeKey)) {
      fail(`page scope_key is not a canonical scope: ${page.mdPath} -> ${scopeKey}`);
    }
    scoped.push({ ...page, scopeKey, slug: slugs.get(scopeKey)! });
  }

  // 3) 同 slug 顺延重编号 + 新旧相对路径。
  const { assignments, renumbered } = assignNewPageNumbers(
    scoped.map((page) => ({ part: page.part, number: page.number, slug: page.slug })),
  );
  const newNumberByKey = new Map(assignments.map((item) => [`${item.part}\n${item.number}\n${item.slug}`, item.newNumber]));
  const planned: PlannedPage[] = scoped.map((page) => {
    const newNumber = newNumberByKey.get(`${page.part}\n${page.number}\n${page.slug}`)!;
    // 旧相对路径用原始文件名主干（completion.jsonl 同构）；新相对路径用重编号后的规范名。
    const relOldMd = `${page.part}/${page.stem}.md`;
    const relOldSources = `${page.part}/${page.stem}.sources`;
    const relNewMd = `pages/${page.slug}/${pageFileName(newNumber)}.md`;
    const relNewSources = `pages/${page.slug}/${pageFileName(newNumber)}.sources`;
    return { ...page, newNumber, relOldMd, relNewMd, relOldSources, relNewSources };
  });

  await prepareDest(destRoot, runRoot);

  const gateViolations: string[] = [];
  const gateCount = (prefix: string): number =>
    gateViolations.reduce((count, violation) => (violation.startsWith(prefix) ? count + 1 : count), 0);

  // 4) 复制 + 逐字节回读比对 + 收集 .sources 的 id 归属。
  let contentMismatches = 0;
  const idToNewPage = new Map<string, string>();
  const sourcesPerSlug = new Map<string, number>();
  const partsPerSlug = new Map<string, Set<string>>();
  const renumberedPerSlug = new Map<string, number>();
  for (const page of planned) {
    const parts = partsPerSlug.get(page.slug) ?? new Set<string>();
    parts.add(page.part);
    partsPerSlug.set(page.slug, parts);
  }
  for (const assignment of assignments) {
    if (assignment.newNumber !== assignment.number) {
      renumberedPerSlug.set(assignment.slug, (renumberedPerSlug.get(assignment.slug) ?? 0) + 1);
    }
  }

  const pathMap = new Map<string, string>();
  for (const page of planned) {
    pathMap.set(page.relOldMd, page.relNewMd);
    pathMap.set(page.relOldSources, page.relNewSources);
  }

  await mapPool(planned, concurrency, async (page) => {
    // 门禁：frontmatter scope_key 必须与所在 slug 目录一致（slug 由该 scope 唯一映射）。
    if (slugs.get(page.scopeKey) !== page.slug) {
      gateViolations.push(`frontmatter-scope-slug: ${page.relOldMd} scope ${page.scopeKey} lands in slug ${page.slug}`);
    }
    await atomicCopy(page.mdPath, join(destRoot, page.relNewMd));
    await atomicCopy(page.sourcesPath, join(destRoot, page.relNewSources));
    // 逐字节回读比对（.md 与 .sources 都比）。
    for (const [from, relTo] of [
      [page.mdPath, page.relNewMd],
      [page.sourcesPath, page.relNewSources],
    ] as const) {
      const source = await readFile(from);
      const copied = await readFile(join(destRoot, relTo));
      if (!source.equals(copied)) {
        contentMismatches += 1;
        gateViolations.push(`content-byte-mismatch: ${from} -> ${join(destRoot, relTo)}`);
      }
    }
    // .sources 的 id 归属（每 id 恰好一个页面）。
    const ids = readFileSync(page.sourcesPath, "utf8").split("\n").map((line) => line.trim()).filter(Boolean);
    for (const id of ids) {
      if (!UUID.test(id)) gateViolations.push(`invalid source id in ${page.relOldSources}: ${id.slice(0, 40)}`);
      const previous = idToNewPage.get(id);
      if (previous !== undefined) {
        gateViolations.push(`duplicate source id across pages: ${id} (${previous} vs ${page.relNewMd})`);
        continue;
      }
      idToNewPage.set(id, page.relNewMd);
    }
    sourcesPerSlug.set(page.slug, (sourcesPerSlug.get(page.slug) ?? 0) + ids.length);
  });

  // 5) path-map.jsonl：一页一行（含 .md 与 .sources 新旧路径）。
  const pathMapLines = planned
    .map((page) => JSON.stringify({
      scope: page.scopeKey,
      slug: page.slug,
      part: page.part,
      renumbered: page.newNumber !== page.number,
      md: { from: page.relOldMd, to: page.relNewMd },
      sources: { from: page.relOldSources, to: page.relNewSources },
    }))
    .join("\n");
  await atomicWrite(join(destRoot, "path-map.jsonl"), `${pathMapLines}\n`);

  // 6) completion.jsonl 迁移重写：行数保持、每 id 恰好一次、page 路径替换并与 .sources 归属对齐。
  const completionPath = join(runRoot, "wiki", "completion.jsonl");
  const completionRaw = readFileSync(completionPath, "utf8");
  const completionLines = completionRaw.split("\n").filter((line) => line.trim().length > 0);
  const rewrittenLines: string[] = [];
  const completionIds = new Set<string>();
  const completionAggregates = new Map<string, { pages: Set<string>; sources: number }>();
  for (const line of completionLines) {
    let row: CompletionRow;
    try {
      row = parseCompletionRow(line);
    } catch (error) {
      gateViolations.push(`completion-parse: ${error instanceof Error ? error.message : "parse failed"}`);
      continue;
    }
    if (completionIds.has(row.id)) gateViolations.push(`completion duplicate id: ${row.id}`);
    completionIds.add(row.id);
    const newPage = idToNewPage.get(row.id);
    if (newPage === undefined) {
      gateViolations.push(`completion id not owned by any page sources: ${row.id}`);
    } else if (pathMap.get(row.page) !== newPage) {
      gateViolations.push(`completion page mismatch for ${row.id}: row=${row.page} expected-owner=${newPage}`);
    }
    const rewritten = JSON.stringify({ ...JSON.parse(line) as Record<string, unknown>, page: newPage ?? pathMap.get(row.page) ?? row.page });
    rewrittenLines.push(rewritten);
    const aggregateKey = `${row.scope}\n${row.semanticType}`;
    const aggregate = completionAggregates.get(aggregateKey) ?? { pages: new Set<string>(), sources: 0 };
    aggregate.pages.add(newPage ?? row.page);
    aggregate.sources += 1;
    completionAggregates.set(aggregateKey, aggregate);
  }
  await atomicWrite(join(destRoot, "completion.jsonl"), rewrittenLines.length > 0 ? `${rewrittenLines.join("\n")}\n` : "");

  // 7) INDEX.md 迁移重写（旧路径经 path-map 替换）+ 汇总门禁。
  const indexPath = join(runRoot, "wiki", "INDEX.md");
  const indexRaw = readFileSync(indexPath, "utf8");
  const indexRewrite = rewriteLegacyPaths(indexRaw, pathMap);
  for (const unknown of indexRewrite.unknownPaths) {
    gateViolations.push(`index legacy path not in path-map: ${unknown}`);
  }
  await atomicWrite(join(destRoot, "INDEX.md"), indexRewrite.text);
  const parsedIndex = parseIndexMarkdown(indexRewrite.text);
  gateViolations.push(...parsedIndex.violations.map((violation) => `index-parse: ${violation}`));
  if (parsedIndex.totals) {
    if (parsedIndex.totals.pages !== planned.length) {
      gateViolations.push(`index-totals: declared pages ${parsedIndex.totals.pages} != copied ${planned.length}`);
    }
    if (parsedIndex.totals.sources !== idToNewPage.size) {
      gateViolations.push(`index-totals: declared sources ${parsedIndex.totals.sources} != collected ${idToNewPage.size}`);
    }
  }
  const indexAggregateMap = new Map(parsedIndex.aggregates.map((item) => [`${item.scope}\n${item.semanticType}`, item]));
  for (const [key, aggregate] of completionAggregates) {
    const declared = indexAggregateMap.get(key);
    if (!declared) {
      gateViolations.push(`index-aggregates: completion has ${key.replace("\n", "/")} but INDEX does not`);
      continue;
    }
    if (declared.pages !== aggregate.pages.size) {
      gateViolations.push(`index-aggregates: ${key.replace("\n", "/")} pages ${declared.pages} != ${aggregate.pages.size}`);
    }
    if (declared.sources !== aggregate.sources) {
      gateViolations.push(`index-aggregates: ${key.replace("\n", "/")} sources ${declared.sources} != ${aggregate.sources}`);
    }
  }
  for (const key of indexAggregateMap.keys()) {
    if (!completionAggregates.has(key)) gateViolations.push(`index-aggregates: INDEX declares ${key.replace("\n", "/")} absent from completion`);
  }

  // 8) scope-registry.json。
  const pagesPerSlug = new Map<string, number>();
  for (const page of planned) pagesPerSlug.set(page.slug, (pagesPerSlug.get(page.slug) ?? 0) + 1);
  const registry = {
    version: 1,
    generatedAt: new Date().toISOString(),
    sourceRunRoot: runRoot,
    scopes: templates
      .map((template) => ({
        slug: slugs.get(template.scopeKey)!,
        scopeKey: template.scopeKey,
        embeddingSpaceId: template.embeddingSpaceId,
        pages: pagesPerSlug.get(slugs.get(template.scopeKey)!) ?? 0,
        sources: sourcesPerSlug.get(slugs.get(template.scopeKey)!) ?? 0,
        parts: [...(partsPerSlug.get(slugs.get(template.scopeKey)!) ?? [])].sort(),
        renumbered: renumberedPerSlug.get(slugs.get(template.scopeKey)!) ?? 0,
      }))
      .sort((left, right) => left.slug.localeCompare(right.slug)),
  };
  await atomicWriteJson(join(destRoot, "scope-registry.json"), registry);

  // 9) 自检门禁汇总。
  const missingIds = beforeIdList.filter((id) => !idToNewPage.has(id));
  const extraIds = [...idToNewPage.keys()].filter((id) => !beforeIds.has(id));
  if (planned.length !== expectedPages) {
    gateViolations.push(`pages-count: copied ${planned.length} != expected ${expectedPages}`);
  }
  if (idToNewPage.size !== expectedSources) {
    gateViolations.push(`sources-count: collected ${idToNewPage.size} != before-ids ${expectedSources}`);
  }
  if (missingIds.length > 0 || extraIds.length > 0) {
    gateViolations.push(
      `id-coverage-exact: missing=${missingIds.length} extra=${extraIds.length}` +
        ` samples=${missingIds.slice(0, 3).join(",")}/${extraIds.slice(0, 3).join(",")}`,
    );
  }
  if (rewrittenLines.length !== expectedSources) {
    gateViolations.push(`completion-lines: completion ${rewrittenLines.length} != before-ids ${expectedSources}`);
  }
  if (completionIds.size !== rewrittenLines.length) {
    gateViolations.push(`completion-id-unique: ${rewrittenLines.length - completionIds.size} duplicate completion rows`);
  }
  if (completionIds.size !== beforeIds.size || [...beforeIds].some((id) => !completionIds.has(id))) {
    gateViolations.push(`completion-ids-cover-before: completion ids ${completionIds.size} vs before-ids ${beforeIds.size}`);
  }
  if (contentMismatches > 0) gateViolations.push(`content-byte-identical: ${contentMismatches} mismatched files`);
  const gates = {
    "pages-count": gateCount("pages-count") === 0,
    "sources-count": gateCount("sources-count") === 0,
    "id-coverage-exact": gateCount("id-coverage-exact") === 0,
    "completion-lines": gateCount("completion-lines") === 0,
    "completion-id-unique": gateCount("completion-id-unique") === 0,
    "completion-ids-cover-before": gateCount("completion-ids-cover-before") === 0,
    "content-byte-identical": gateCount("content-byte-identical") === 0,
    "frontmatter-scope-slug-consistent": gateCount("frontmatter-scope-slug") === 0,
    "index-aggregates-match-completion": gateCount("index-aggregates") === 0,
    "index-totals-match": gateCount("index-totals") === 0,
    "source-ids-valid-unique": gateCount("invalid source id") === 0 && gateCount("duplicate source id") === 0,
    "completion-rows-consistent":
      gateCount("completion-parse") === 0 && gateCount("completion id not owned") === 0 &&
      gateCount("completion page mismatch") === 0 && gateCount("completion duplicate id") === 0,
    "index-parse-valid": gateCount("index-parse") === 0,
    "index-paths-known": gateCount("index legacy path") === 0,
  };

  const summary: PromoteSummary = {
    pages: planned.length,
    sources: idToNewPage.size,
    uniqueIds: idToNewPage.size,
    contentMismatches,
    renumbered,
    slugs: registry.scopes.length,
  };

  // 10) 回执（无论门禁是否全过都写，供对账；不携带任何凭据）。
  await atomicWriteJson(join(destRoot, "receipts", "promotion.json"), {
    generatedAt: new Date().toISOString(),
    tool: "wiki-promote",
    batch: "A",
    runRoot,
    destRoot,
    inputs: {
      scopeTemplates: { path: templatesPath, sha256: templatesSha256, scopes: templates.length },
      beforeIds: { path: beforeIdsPath, sha256: sha256Hex(readFileSync(beforeIdsPath)), count: beforeIdList.length },
    },
    expected: { pages: expectedPages, sources: expectedSources },
    actual: {
      pages: summary.pages,
      sources: summary.sources,
      uniqueIds: summary.uniqueIds,
      contentMismatches,
      renumbered,
      slugs: summary.slugs,
      completionLines: rewrittenLines.length,
      indexPathReplacements: indexRewrite.replacements,
    },
    gates,
    gateViolations: gateViolations.slice(0, 50),
    scopes: registry.scopes,
  });

  if (gateViolations.length > 0) {
    fail(`promotion gates failed (${gateViolations.length}): ${gateViolations.slice(0, 10).join(" | ")}`);
  }
  return summary;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (process.argv[2] !== "promote") fail("command must be promote");
  const summary = await runPromote({
    runRoot: resolve(arg("--run")),
    destRoot: resolve(arg("--dest")),
    expectedPages: optionalNumberArg("--expected-pages"),
    concurrency: optionalNumberArg("--concurrency"),
  });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "wiki promote failed"}\n`);
    process.exitCode = 1;
  });
}
