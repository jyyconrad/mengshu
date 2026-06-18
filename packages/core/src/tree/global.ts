/**
 * Global memory tree digest helpers.
 *
 * 第一阶段按日期把 leaf 汇总为 global SummaryNode，服务“今天/昨天发生了什么”
 * 这类整体预览能力。
 */

import type { TreeLeaf, TreeRepository, TreeSummaryNode } from "./types.js";
import { appendLeafToBuffer } from "./buffer.js";
import { sealBuffer } from "./seal.js";
import type { MemoryScope } from "../core/types.js";

export function dayKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export async function buildDailyDigest(
  repository: TreeRepository,
  scope: MemoryScope,
  date: string,
  leaves: TreeLeaf[],
  now: number,
): Promise<TreeSummaryNode> {
  let buffer = undefined;
  for (const leaf of leaves) {
    const result = await appendLeafToBuffer(repository, {
      scope,
      treeType: "global",
      treeKey: date,
      leaf,
      now,
    });
    buffer = result.buffer;
  }
  if (!buffer) {
    const emptyLeaf: TreeLeaf = {
      id: `empty-${date}`,
      scope,
      chunkId: `empty-${date}`,
      sourceId: `global:${date}`,
      entityIds: [],
      importance: 0,
      eventAt: now,
      createdAt: now,
      text: "No events.",
      tokenCount: 2,
    };
    buffer = (await appendLeafToBuffer(repository, {
      scope,
      treeType: "global",
      treeKey: date,
      leaf: emptyLeaf,
      now,
    })).buffer;
  }
  return sealBuffer(repository, {
    buffer,
    now,
    title: `Daily Digest ${date}`,
  });
}
