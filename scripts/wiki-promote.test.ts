/**
 * wiki-promote 离线 fixture 单测。
 *
 * 覆盖（对应实现合同）：
 *   - slug 生成：workspace 段直用、同段冲突尾段消歧、消歧后仍冲突拒绝；
 *   - 跨 part 页号冲突顺延重编号（含 renumbered 计数与无冲突保留原号）；
 *   - INDEX.md 解析与旧路径重写（md + .sources，未知路径登记不替换）；
 *   - runPromote 端到端：双 scope（含 slug 冲突消歧）复制、逐字节一致、
 *     path-map.jsonl 逐页新旧路径、completion.jsonl 路径重写与 id 唯一覆盖校验、
 *     scope-registry.json、回执门禁；
 *   - 失败路径：before-ids 覆盖缺口、completion 重复 id、INDEX 汇总篡改、
 *     dest 非空、未知 scope 页面、期望页数不符；
 *   - 铁律：runPromote 全程不改写 rerun 源目录（前后树哈希快照比对）。
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assignNewPageNumbers,
  buildScopeSlugs,
  parseIndexMarkdown,
  rewriteLegacyPaths,
  runPromote,
  scopeWorkspaceSegment,
  type ScopeTemplateEntry,
} from "./wiki-promote.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const SCOPE_A = "local:tenant:u:ws-alpha:default:knowledge";
const SCOPE_B = "local:tenant:u:ws-alpha:default:working-context";
const SCOPE_C = "local:tenant:u:ws-beta:default:knowledge";
const SPACE_A = `embedding-space:v1:${"a".repeat(64)}`;
const SPACE_B = `embedding-space:v1:${"b".repeat(64)}`;
const SPACE_C = `embedding-space:v1:${"c".repeat(64)}`;

const uuid = (n: number): string => {
  const hex = n.toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-0000-4000-8000-${hex}`;
};

interface PageSpec {
  readonly part: string;
  readonly page: number;
  readonly scope: string;
  readonly ids: readonly number[];
}

/**
 * 8 页 / 14 id，6 个 part（与真实数据同构：每个 part 单一 scope，同 scope 跨 part 页号重启）。
 * 同 slug 跨 part 重号：A part-001 两页 → 003/004；B part-003 一页 → 002；C part-005 一页 → 002，共 4 页顺延。
 */
const PAGES: readonly PageSpec[] = [
  { part: "part-000", page: 1, scope: SCOPE_A, ids: [1, 2] },
  { part: "part-000", page: 2, scope: SCOPE_A, ids: [3] },
  { part: "part-001", page: 1, scope: SCOPE_A, ids: [7, 8] },
  { part: "part-001", page: 2, scope: SCOPE_A, ids: [9] },
  { part: "part-002", page: 1, scope: SCOPE_B, ids: [10, 11] },
  { part: "part-003", page: 1, scope: SCOPE_B, ids: [14] },
  { part: "part-004", page: 1, scope: SCOPE_C, ids: [4, 5, 6] },
  { part: "part-005", page: 1, scope: SCOPE_C, ids: [12, 13] },
];

interface FixtureOptions {
  /** 从 before-ids.txt 删除某个 id（制造覆盖缺口）。 */
  readonly removeBeforeId?: number;
  /** completion.jsonl 追加某 id 的重复行。 */
  readonly duplicateCompletionId?: number;
  /** 把 INDEX 首个汇总的页数 +1（制造汇总篡改）。 */
  readonly tamperIndex?: boolean;
  /** 把 part-002/page-001.md 的 scope_key 改成未注册 scope。 */
  readonly unknownScope?: boolean;
}

const stem = (page: number): string => `page-${String(page).padStart(3, "0")}`;

function pageMarkdown(spec: PageSpec): string {
  return [
    "---",
    `scope_key: ${spec.scope}`,
    "semantic_type: resource",
    "memory_form: fact",
    "tree_type: source",
    "---",
    "",
    `# ${spec.part}/${stem(spec.page)}`,
    "",
    `正文 ${spec.part}/${stem(spec.page)}：用于逐字节比对的唯一正文标记 ${spec.part}-${spec.page}。`,
    "",
  ].join("\n");
}

async function buildFixture(options: FixtureOptions = {}): Promise<{ runRoot: string; destRoot: string }> {
  const base = await mkdtemp(join(tmpdir(), "mengshu-wiki-promote-"));
  roots.push(base);
  const runRoot = join(base, "run");
  const destRoot = join(base, "dest");
  const finalRoot = join(runRoot, "wiki", "final");
  await mkdir(finalRoot, { recursive: true });

  const templates: ScopeTemplateEntry[] = [
    { scopeKey: SCOPE_A, embeddingSpaceId: SPACE_A },
    { scopeKey: SCOPE_B, embeddingSpaceId: SPACE_B },
    { scopeKey: SCOPE_C, embeddingSpaceId: SPACE_C },
  ];
  await writeFile(
    join(runRoot, "scope-templates.json"),
    `${JSON.stringify(templates, null, 2)}\n`,
  );

  const completion: string[] = [];
  const allIds: number[] = [];
  for (const spec of PAGES) {
    await mkdir(join(finalRoot, spec.part), { recursive: true });
    const scope = options.unknownScope && spec.part === "part-005" ? "local:tenant:u:ws-ghost:default:knowledge" : spec.scope;
    await writeFile(join(finalRoot, spec.part, `${stem(spec.page)}.md`), pageMarkdown({ ...spec, scope }));
    await writeFile(
      join(finalRoot, spec.part, `${stem(spec.page)}.sources`),
      `${spec.ids.map((id) => uuid(id)).join("\n")}\n`,
    );
    allIds.push(...spec.ids);
    for (const id of spec.ids) {
      completion.push(JSON.stringify({
        id: uuid(id),
        page: `${spec.part}/${stem(spec.page)}.md`,
        scope: spec.scope,
        semanticType: "resource",
        status: "fused",
      }));
    }
  }
  if (options.duplicateCompletionId !== undefined) {
    completion.push(JSON.stringify({
      id: uuid(options.duplicateCompletionId),
      page: "part-000/page-001.md",
      scope: SCOPE_A,
      semanticType: "resource",
      status: "fused",
    }));
  }
  await writeFile(join(runRoot, "wiki", "completion.jsonl"), `${completion.join("\n")}\n`);

  const beforeIds = allIds.filter((id) => id !== options.removeBeforeId);
  await writeFile(join(runRoot, "before-ids.txt"), `${beforeIds.map((id) => uuid(id)).join("\n")}\n`);

  const indexLines = [
    "# Mengshu Wiki 索引",
    "",
    `共 ${PAGES.length} 页,${allIds.length} 条来源记录。`,
    "",
    `## ${SCOPE_A}`,
    options.tamperIndex ? "- resource: 5 页 / 6 来源" : "- resource: 4 页 / 6 来源",
    "",
    `## ${SCOPE_B}`,
    "- resource: 2 页 / 3 来源",
    "",
    `## ${SCOPE_C}`,
    "- resource: 2 页 / 5 来源",
    "",
    `<!-- 路径引用: part-000/page-001.md 与 part-000/page-001.sources -->`,
    "",
  ];
  await writeFile(join(runRoot, "wiki", "INDEX.md"), indexLines.join("\n"));
  return { runRoot, destRoot };
}

/** 递归快照：相对路径 → sha256（用于证明源目录零改动）。 */
async function snapshotTree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name);
      const stats = statSync(path);
      if (stats.isDirectory()) await walk(path, `${prefix}${name}/`);
      else out[`${prefix}${name}`] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  await walk(root, "");
  return out;
}

const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
const readJsonl = (path: string): Record<string, unknown>[] =>
  readFileSync(path, "utf8").split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as Record<string, unknown>);

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

describe("buildScopeSlugs", () => {
  it("workspace 段直用作 slug；段数不足（__unscoped__）以整个 scopeKey 为基底", () => {
    expect(scopeWorkspaceSegment("local:mengshu:default:knowledge-legacy-tech-writer:default:knowledge")).toBe("knowledge-legacy-tech-writer");
    expect(scopeWorkspaceSegment("__unscoped__")).toBe("__unscoped__");
    const templates: ScopeTemplateEntry[] = [
      { scopeKey: "local:mengshu:default:knowledge-legacy-tech-writer:default:knowledge", embeddingSpaceId: SPACE_A },
      { scopeKey: "__unscoped__", embeddingSpaceId: SPACE_B },
    ];
    const slugs = buildScopeSlugs(templates);
    expect(slugs.get("local:mengshu:default:knowledge-legacy-tech-writer:default:knowledge")).toBe("knowledge-legacy-tech-writer");
    expect(slugs.get("__unscoped__")).toBe("__unscoped__");
  });

  it("同 workspace 段冲突时以尾段消歧", () => {
    const slugs = buildScopeSlugs([
      { scopeKey: SCOPE_A, embeddingSpaceId: SPACE_A },
      { scopeKey: SCOPE_B, embeddingSpaceId: SPACE_B },
      { scopeKey: SCOPE_C, embeddingSpaceId: SPACE_C },
    ]);
    expect(slugs.get(SCOPE_A)).toBe("ws-alpha-knowledge");
    expect(slugs.get(SCOPE_B)).toBe("ws-alpha-working-context");
    expect(slugs.get(SCOPE_C)).toBe("ws-beta");
  });

  it("消歧后仍冲突（同 workspace 且同尾段）时拒绝执行", () => {
    expect(() => buildScopeSlugs([
      { scopeKey: "local:t:u:ws:agent-one:knowledge", embeddingSpaceId: SPACE_A },
      { scopeKey: "local:t:u:ws:agent-two:knowledge", embeddingSpaceId: SPACE_B },
    ])).toThrow(/slug collision persists/i);
  });
});

describe("assignNewPageNumbers", () => {
  it("跨 part 重号顺延：首 part 保留原号，后续 part 从原号起取最小空闲号", () => {
    const { assignments, renumbered } = assignNewPageNumbers([
      { part: "part-001", number: 1, slug: "s" },
      { part: "part-000", number: 2, slug: "s" },
      { part: "part-000", number: 1, slug: "s" },
      { part: "part-001", number: 2, slug: "s" },
    ]);
    const byKey = new Map(assignments.map((item) => [`${item.part}/${item.number}`, item.newNumber]));
    expect(byKey.get("part-000/1")).toBe(1);
    expect(byKey.get("part-000/2")).toBe(2);
    expect(byKey.get("part-001/1")).toBe(3);
    expect(byKey.get("part-001/2")).toBe(4);
    expect(renumbered).toBe(2);
  });

  it("单 part 无冲突时编号原样保留", () => {
    const { assignments, renumbered } = assignNewPageNumbers([
      { part: "part-000", number: 1, slug: "s" },
      { part: "part-000", number: 5, slug: "s" },
      { part: "part-000", number: 9, slug: "other" },
    ]);
    expect(assignments.map((item) => [item.slug, item.number, item.newNumber])).toEqual([
      ["other", 9, 9],
      ["s", 1, 1],
      ["s", 5, 5],
    ]);
    expect(renumbered).toBe(0);
  });
});

describe("parseIndexMarkdown", () => {
  it("解析 totals 与 scope×semantic_type 汇总", () => {
    const parsed = parseIndexMarkdown("# idx\n\n共 8 页,14 条来源记录。\n\n## s1\n- resource: 4 页 / 6 来源\n");
    expect(parsed.totals).toEqual({ pages: 8, sources: 14 });
    expect(parsed.aggregates).toEqual([{ scope: "s1", semanticType: "resource", pages: 4, sources: 6 }]);
    expect(parsed.violations).toEqual([]);
  });

  it("缺 totals 或 scope 标题外的聚合行记 violation", () => {
    const missing = parseIndexMarkdown("## s1\n- resource: 4 页 / 6 来源\n");
    expect(missing.violations.some((violation) => violation.includes("missing the totals"))).toBe(true);
    const orphan = parseIndexMarkdown("共 1 页,2 条来源记录。\n- resource: 4 页 / 6 来源\n");
    expect(orphan.violations.some((violation) => violation.includes("outside any scope"))).toBe(true);
  });
});

describe("rewriteLegacyPaths", () => {
  it("md 与 .sources 旧路径经 map 替换并计数；未知路径登记不替换", () => {
    const map = new Map([
      ["part-000/page-001.md", "pages/s/page-001.md"],
      ["part-000/page-001.sources", "pages/s/page-001.sources"],
    ]);
    const result = rewriteLegacyPaths(
      "见 part-000/page-001.md 与 part-000/page-001.sources，另见 part-009/page-009.md。",
      map,
    );
    expect(result.text).toBe("见 pages/s/page-001.md 与 pages/s/page-001.sources，另见 part-009/page-009.md。");
    expect(result.replacements).toBe(2);
    expect(result.unknownPaths).toEqual(["part-009/page-009.md"]);
  });
});

// ---------------------------------------------------------------------------
// runPromote 端到端
// ---------------------------------------------------------------------------

describe("runPromote 端到端（离线 fixture）", () => {
  it("复制重编号迁移全部产物并通过全部门禁；源目录零改动", async () => {
    const { runRoot, destRoot } = await buildFixture();
    const before = await snapshotTree(runRoot);

    const summary = await runPromote({ runRoot, destRoot, expectedPages: PAGES.length, concurrency: 4 });

    expect(summary).toEqual({
      pages: 8,
      sources: 14,
      uniqueIds: 14,
      contentMismatches: 0,
      renumbered: 4,
      slugs: 3,
    });

    // 源目录零改动铁律。
    expect(await snapshotTree(runRoot)).toEqual(before);

    // 页面落位：重编号后的完整目录结构。
    for (const name of ["page-001", "page-002", "page-003", "page-004"]) {
      expect(existsSync(join(destRoot, "pages", "ws-alpha-knowledge", `${name}.md`))).toBe(true);
      expect(existsSync(join(destRoot, "pages", "ws-alpha-knowledge", `${name}.sources`))).toBe(true);
    }
    for (const slug of ["ws-alpha-working-context", "ws-beta"]) {
      for (const name of ["page-001", "page-002"]) {
        expect(existsSync(join(destRoot, "pages", slug, `${name}.md`))).toBe(true);
      }
    }

    // 逐字节一致：重编号页（part-001/page-001 → page-003）与保留页（part-000/page-001）。
    expect(readFileSync(join(destRoot, "pages/ws-alpha-knowledge/page-003.md"))).toEqual(
      readFileSync(join(runRoot, "wiki/final/part-001/page-001.md")),
    );
    expect(readFileSync(join(destRoot, "pages/ws-alpha-knowledge/page-003.sources"))).toEqual(
      readFileSync(join(runRoot, "wiki/final/part-001/page-001.sources")),
    );
    expect(readFileSync(join(destRoot, "pages/ws-alpha-knowledge/page-001.md"))).toEqual(
      readFileSync(join(runRoot, "wiki/final/part-000/page-001.md")),
    );

    // path-map.jsonl：一页一行（含 .md 与 .sources 的新旧路径）。
    const pathMap = readJsonl(join(destRoot, "path-map.jsonl"));
    expect(pathMap).toHaveLength(8);
    const renamed = pathMap.find((row) => row.md !== undefined && (row.md as Record<string, string>).from === "part-001/page-001.md")!;
    expect(renamed).toMatchObject({
      slug: "ws-alpha-knowledge",
      part: "part-001",
      renumbered: true,
      md: { from: "part-001/page-001.md", to: "pages/ws-alpha-knowledge/page-003.md" },
      sources: { from: "part-001/page-001.sources", to: "pages/ws-alpha-knowledge/page-003.sources" },
    });
    const kept = pathMap.find((row) => (row.md as Record<string, string>).from === "part-000/page-001.md")!;
    expect(kept).toMatchObject({
      slug: "ws-alpha-knowledge",
      renumbered: false,
      md: { from: "part-000/page-001.md", to: "pages/ws-alpha-knowledge/page-001.md" },
    });

    // completion.jsonl：行数保持、路径全部重写、id 唯一覆盖 before-ids、行内路径真实存在。
    const completion = readJsonl(join(destRoot, "completion.jsonl"));
    expect(completion).toHaveLength(14);
    const ids = completion.map((row) => row.id as string);
    expect(new Set(ids).size).toBe(14);
    for (const row of completion) {
      expect(String(row.page).startsWith("pages/")).toBe(true);
      expect(String(row.page).endsWith(".md")).toBe(true);
      expect(existsSync(join(destRoot, String(row.page)))).toBe(true);
    }
    // id → 页面归属与 .sources 一致：uuid(7) 属于 part-001/page-001（已重编号为 page-003）。
    expect(completion.find((row) => row.id === uuid(7))?.page).toBe("pages/ws-alpha-knowledge/page-003.md");

    // INDEX.md：汇总保留、旧路径引用重写。
    const indexText = readFileSync(join(destRoot, "INDEX.md"), "utf8");
    expect(indexText).toContain("共 8 页,14 条来源记录。");
    expect(indexText).toContain("- resource: 4 页 / 6 来源");
    expect(indexText).toContain("pages/ws-alpha-knowledge/page-001.md 与 pages/ws-alpha-knowledge/page-001.sources");
    expect(indexText).not.toContain("part-000/page-001.md");

    // scope-registry.json：slug/scopeKey/embeddingSpaceId/页数/来源 part 列表/重编号数。
    const registry = readJson(join(destRoot, "scope-registry.json"));
    const scopes = registry.scopes as Array<Record<string, unknown>>;
    expect(scopes.map((item) => item.slug)).toEqual(["ws-alpha-knowledge", "ws-alpha-working-context", "ws-beta"]);
    expect(scopes[0]).toMatchObject({
      scopeKey: SCOPE_A,
      embeddingSpaceId: SPACE_A,
      pages: 4,
      sources: 6,
      parts: ["part-000", "part-001"],
      renumbered: 2,
    });
    expect(scopes[1]).toMatchObject({ pages: 2, sources: 3, parts: ["part-002", "part-003"], renumbered: 1 });
    expect(scopes[2]).toMatchObject({ pages: 2, sources: 5, parts: ["part-004", "part-005"], renumbered: 1 });

    // 回执：门禁全真 + 实测计数 + 输入指纹。
    const receipt = readJson(join(destRoot, "receipts", "promotion.json"));
    expect(Object.entries(receipt.gates as Record<string, boolean>).every(([, ok]) => ok)).toBe(true);
    expect(receipt.actual).toMatchObject({
      pages: 8,
      sources: 14,
      uniqueIds: 14,
      contentMismatches: 0,
      renumbered: 4,
      slugs: 3,
      completionLines: 14,
      indexPathReplacements: 2,
    });
    expect(receipt.expected).toEqual({ pages: 8, sources: 14 });
    const inputs = receipt.inputs as Record<string, Record<string, unknown>>;
    expect(inputs.scopeTemplates.scopes).toBe(3);
    expect(inputs.beforeIds.count).toBe(14);
  });

  it("before-ids 缺口：id 覆盖门禁失败并如实记账到回执", async () => {
    const { runRoot, destRoot } = await buildFixture({ removeBeforeId: 14 });
    await expect(runPromote({ runRoot, destRoot, expectedPages: PAGES.length })).rejects.toThrow(/id-coverage-exact/);
    const receipt = readJson(join(destRoot, "receipts", "promotion.json"));
    expect((receipt.gates as Record<string, boolean>)["id-coverage-exact"]).toBe(false);
    expect((receipt.gateViolations as string[]).join("\n")).toContain("extra=1");
  });

  it("completion 重复 id 行：行数与唯一性门禁失败", async () => {
    const { runRoot, destRoot } = await buildFixture({ duplicateCompletionId: 1 });
    await expect(runPromote({ runRoot, destRoot, expectedPages: PAGES.length })).rejects.toThrow(/completion/);
    const receipt = readJson(join(destRoot, "receipts", "promotion.json"));
    const gates = receipt.gates as Record<string, boolean>;
    expect(gates["completion-lines"]).toBe(false);
    expect(gates["completion-id-unique"]).toBe(false);
  });

  it("INDEX 汇总页数篡改：汇总门禁失败", async () => {
    const { runRoot, destRoot } = await buildFixture({ tamperIndex: true });
    await expect(runPromote({ runRoot, destRoot, expectedPages: PAGES.length })).rejects.toThrow(/index-aggregates/);
    const receipt = readJson(join(destRoot, "receipts", "promotion.json"));
    expect((receipt.gates as Record<string, boolean>)["index-aggregates-match-completion"]).toBe(false);
  });

  it("页面 scope_key 不在 canonical scope 内：复制前拒绝", async () => {
    const { runRoot, destRoot } = await buildFixture({ unknownScope: true });
    await expect(runPromote({ runRoot, destRoot, expectedPages: PAGES.length })).rejects.toThrow(/not a canonical scope/);
  });

  it("dest 非空：拒绝执行（保护对账基线）", async () => {
    const { runRoot, destRoot } = await buildFixture();
    await mkdir(destRoot, { recursive: true });
    await writeFile(join(destRoot, "stale.txt"), "x");
    await expect(runPromote({ runRoot, destRoot, expectedPages: PAGES.length })).rejects.toThrow(/dest is not empty/);
  });

  it("dest 位于 run 源树之内或等于 run：拒绝执行，不向冻结源树写任何产物", async () => {
    const { runRoot } = await buildFixture();
    const before = await snapshotTree(runRoot);
    const destInside = join(runRoot, "promoted");
    await expect(runPromote({ runRoot, destRoot: destInside, expectedPages: PAGES.length }))
      .rejects.toThrow(/dest must not be inside the read-only run root/);
    // dest 深埋在 wiki/final 之下同样拒绝。
    await expect(runPromote({ runRoot, destRoot: join(runRoot, "wiki", "final", "dest"), expectedPages: PAGES.length }))
      .rejects.toThrow(/dest must not be inside the read-only run root/);
    // dest === run 也拒绝。
    await expect(runPromote({ runRoot, destRoot: runRoot, expectedPages: PAGES.length }))
      .rejects.toThrow(/dest must not be inside the read-only run root/);
    // 源树零改动、目标目录未被创建。
    expect(await snapshotTree(runRoot)).toEqual(before);
    expect(existsSync(destInside)).toBe(false);
  });

  it("期望页数不符：pages-count 门禁失败", async () => {
    const { runRoot, destRoot } = await buildFixture();
    await expect(runPromote({ runRoot, destRoot, expectedPages: PAGES.length - 1 })).rejects.toThrow(/pages-count/);
    const receipt = readJson(join(destRoot, "receipts", "promotion.json"));
    expect((receipt.gates as Record<string, boolean>)["pages-count"]).toBe(false);
  });
});
