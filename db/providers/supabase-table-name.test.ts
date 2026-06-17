/**
 * Supabase 表名白名单单元测试。
 *
 * 验证 ensureTableExists 在 DDL 拼接前会拒绝任何不在白名单内的字符串，
 * 防止 SQL 注入（即使 TS 类型层面已有 TableName 约束，运行时仍需兜底）。
 */
import { describe, expect, it } from "vitest";
import { ALLOWED_TABLE_NAME_RE, assertSafeTableName } from "./supabase";

describe("Supabase 表名白名单", () => {
  describe("合法表名", () => {
    it("允许内置固定表：memories / knowledge / documents", () => {
      expect(() => assertSafeTableName("memories")).not.toThrow();
      expect(() => assertSafeTableName("knowledge")).not.toThrow();
      expect(() => assertSafeTableName("documents")).not.toThrow();
    });

    it("允许 knowledge_<category> 形式的动态知识库表", () => {
      expect(() => assertSafeTableName("knowledge_python")).not.toThrow();
      expect(() => assertSafeTableName("knowledge_design_patterns")).not.toThrow();
      expect(() => assertSafeTableName("knowledge_v2")).not.toThrow();
    });
  });

  describe("非法表名", () => {
    const cases: Array<[string, string]> = [
      ["分号注入", "memories; DROP TABLE users; --"],
      ["空格", "memories table"],
      ["SQL 注释", "memories--"],
      ["大写字母", "Memories"],
      ["数字开头的 knowledge_ 后缀", "knowledge_1abc"],
      ["空字符串", ""],
      ["纯前缀", "knowledge_"],
      ["未授权前缀", "users"],
      ["关键字", "select"],
      ["反引号", "memories`"],
      ["路径符", "memories/admin"],
      ["逗号", "memories,knowledge"],
      ["UNION 注入", "memories UNION SELECT 1"],
      ["超长后缀（>64）", `knowledge_${"a".repeat(65)}`],
    ];

    it.each(cases)("拒绝 %s: %s", (_label, value) => {
      expect(() => assertSafeTableName(value)).toThrow(/Invalid table name/);
    });

    it("拒绝非字符串入参", () => {
      // 模拟运行时被传入非字符串的极端情况。
      expect(() => assertSafeTableName(undefined as unknown as string)).toThrow();
      expect(() => assertSafeTableName(null as unknown as string)).toThrow();
      expect(() => assertSafeTableName(123 as unknown as string)).toThrow();
    });
  });

  describe("正则约束", () => {
    it("ALLOWED_TABLE_NAME_RE 锚定首尾，避免子串绕过", () => {
      expect(ALLOWED_TABLE_NAME_RE.test("xmemoriesx")).toBe(false);
      expect(ALLOWED_TABLE_NAME_RE.test("memories\nDROP TABLE")).toBe(false);
    });
  });
});
