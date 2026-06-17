/**
 * fake-embeddings 单元测试。
 *
 * 本文件做什么：
 *   验证 FakeEmbeddings 的核心契约：
 *   - 默认维度 1536（与生产一致）。
 *   - hash 模式下相同文本恒等向量、不同文本不同向量、向量已 L2 归一化。
 *   - constant 模式返回固定向量（仅一位非零），可定制 slot 与 value。
 *   - 维度可配置。
 *   - 多次构造同一文本结果稳定（无内部可变状态影响输出）。
 */

import { describe, expect, test } from "vitest";
import {
  DEFAULT_EMBEDDING_DIM,
  FakeEmbeddings,
} from "./fake-embeddings.js";

describe("FakeEmbeddings", () => {
  test("默认维度为生产侧 1536", async () => {
    const fe = new FakeEmbeddings();
    const v = await fe.embed("hello world");
    expect(v).toHaveLength(DEFAULT_EMBEDDING_DIM);
    expect(DEFAULT_EMBEDDING_DIM).toBe(1536);
  });

  test("hash 模式：相同文本得到完全相同的向量", async () => {
    const a = new FakeEmbeddings({ dim: 64 });
    const b = new FakeEmbeddings({ dim: 64 });
    const v1 = await a.embed("用户偏好简洁回答");
    const v2 = await b.embed("用户偏好简洁回答");
    expect(v1).toEqual(v2);
  });

  test("hash 模式：不同文本得到不同向量（cosine < 1）", async () => {
    const fe = new FakeEmbeddings({ dim: 64 });
    const v1 = await fe.embed("text A");
    const v2 = await fe.embed("text B");
    expect(v1).not.toEqual(v2);
    // 单位球，内积即 cosine 相似度
    let dot = 0;
    for (let i = 0; i < v1.length; i++) dot += v1[i] * v2[i];
    expect(dot).toBeLessThan(0.999);
  });

  test("hash 模式：向量经过 L2 归一化", async () => {
    const fe = new FakeEmbeddings({ dim: 128 });
    const v = await fe.embed("normalize me");
    let sumSq = 0;
    for (const x of v) sumSq += x * x;
    expect(Math.sqrt(sumSq)).toBeCloseTo(1, 6);
  });

  test("hash 模式：embedSync 与 embed 输出一致", async () => {
    const fe = new FakeEmbeddings({ dim: 32 });
    const a = await fe.embed("same input");
    const b = fe.embedSync("same input");
    expect(a).toEqual(b);
  });

  test("constant 模式：所有文本返回同一向量", async () => {
    const fe = new FakeEmbeddings({ dim: 8, mode: "constant" });
    const v1 = await fe.embed("foo");
    const v2 = await fe.embed("bar");
    expect(v1).toEqual(v2);
    expect(v1).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
  });

  test("constant 模式：自定义 slot 与 value", async () => {
    const fe = new FakeEmbeddings({
      dim: 4,
      mode: "constant",
      constantSlot: 2,
      constantValue: 0.5,
    });
    const v = await fe.embed("any");
    expect(v).toEqual([0, 0, 0.5, 0]);
  });

  test("非法 dim 抛错", () => {
    expect(() => new FakeEmbeddings({ dim: 0 })).toThrow();
    expect(() => new FakeEmbeddings({ dim: -1 })).toThrow();
    // 浮点维度也算非法
    expect(() => new FakeEmbeddings({ dim: 1.5 })).toThrow();
  });

  test("texts 数组按调用顺序记录", async () => {
    const fe = new FakeEmbeddings({ dim: 4 });
    await fe.embed("first");
    await fe.embed("second");
    expect(fe.texts).toEqual(["first", "second"]);
  });
});
