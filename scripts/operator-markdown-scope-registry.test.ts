import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { authorityScopeFingerprint } from "../packages/core/src/domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../packages/core/src/domain/types.js";
import {
  createMarkdownWorksetManifest,
  createMarkdownWorksetRecord,
  markdownWorksetManifestSha256,
  renderNativeRecordMarkdown,
  serializeMarkdownWorksetManifest,
  type MarkdownWorksetNativeRecord,
} from "../packages/core/src/db/migrations/markdown-workset.js";
import { parseMarkdownScopeRegistry } from "../packages/core/src/db/migrations/markdown-scope-registry.js";
import {
  runMarkdownScopeRegistry,
  type RunMarkdownScopeRegistryInput,
} from "./operator-markdown-scope-registry.js";

const roots: string[] = [];
const CREATED_AT = "2026-08-28T08:00:00.000Z";
const SCOPE: MemoryScope = {
  tenantId: "tenant-a",
  appId: "app-a",
  userId: "user-a",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "default",
  visibility: "private",
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<RunMarkdownScopeRegistryInput> {
  const root = await mkdtemp(join(tmpdir(), "mengshu-scope-registry-"));
  roots.push(root);
  const sourceDirectory = join(root, "source-workset");
  const records: MarkdownWorksetNativeRecord[] = ["memory-1", "memory-2"].map((id) => ({
    id,
    sourceTable: "memories",
    text: `正文 ${id}`,
    contentHash: `${id}-content-hash`,
    vector: [0.1, 0.2],
    importance: 0.8,
    category: "test",
    dataType: "fact",
    metadata: {},
    createdAt: "2026-08-28T00:00:00.000Z",
    tenantId: SCOPE.tenantId,
    productId: SCOPE.appId,
    userId: SCOPE.userId,
    canonicalProjectId: SCOPE.projectId,
    producerId: SCOPE.agentId,
    namespace: SCOPE.namespace,
    visibility: SCOPE.visibility,
  }));
  const files = records.map((record, index) => ({
    relativePath: `source/memories/0${index}/${record.id}.md`,
    markdown: renderNativeRecordMarkdown(createMarkdownWorksetRecord({
      phase: "source",
      scopeFingerprint: authorityScopeFingerprint(SCOPE),
      record,
    })),
  }));
  for (const file of files) {
    await mkdir(join(sourceDirectory, file.relativePath, ".."), { recursive: true });
    await writeFile(join(sourceDirectory, file.relativePath), file.markdown);
  }
  const manifest = createMarkdownWorksetManifest({
    migrationRunId: "run-a",
    phase: "source",
    policyVersion: "markdown-export/v1",
    createdAt: CREATED_AT,
    files,
  });
  const serialized = serializeMarkdownWorksetManifest(manifest);
  const manifestPath = join(sourceDirectory, "manifest.json");
  await writeFile(manifestPath, serialized);
  return {
    containmentRoot: root,
    sourceManifestPath: manifestPath,
    sourceManifestFileSha256: markdownWorksetManifestSha256(serialized),
    expectedSourceCount: 2,
    outputPath: join(root, "scope-registry.json"),
    createdAt: CREATED_AT,
  };
}

describe("operator markdown scope registry", () => {
  it("完整验证 source bundle 后排他写入 registry", async () => {
    const input = await fixture();
    const result = await runMarkdownScopeRegistry(input);
    const registry = parseMarkdownScopeRegistry(await readFile(input.outputPath, "utf8"));

    expect(result).toMatchObject({ sourceCount: 2, scopedSourceCount: 2, scopeCount: 1 });
    expect(registry.registrySha256).toBe(result.registrySha256);
    expect(registry.entries[0]!.scope).toEqual(SCOPE);
  });

  it("拒绝覆盖既有输出", async () => {
    const input = await fixture();
    await writeFile(input.outputPath, "reserved");

    await expect(runMarkdownScopeRegistry(input)).rejects.toMatchObject({
      code: "MARKDOWN_SCOPE_REGISTRY_OPERATOR_OUTPUT_EXISTS",
    });
  });

  it("拒绝 source count 漂移和 symlink 输出父目录", async () => {
    const input = await fixture();
    await expect(runMarkdownScopeRegistry({ ...input, expectedSourceCount: 1 }))
      .rejects.toMatchObject({ code: "MARKDOWN_SCOPE_REGISTRY_OPERATOR_INPUT_DRIFT" });

    const real = join(input.containmentRoot, "real-output");
    const linked = join(input.containmentRoot, "linked-output");
    await mkdir(real);
    await symlink(real, linked);
    await expect(runMarkdownScopeRegistry({
      ...input,
      outputPath: join(linked, "registry.json"),
    })).rejects.toMatchObject({ code: "MARKDOWN_SCOPE_REGISTRY_OPERATOR_SYMLINK" });
  });
});
