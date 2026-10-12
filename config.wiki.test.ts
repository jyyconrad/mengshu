import { homedir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

import { memoryConfigSchema } from "./config.js";

const baseConfig = {
  embedding: {
    apiKey: "test-key",
    baseURL: "https://api.openai.com/v1",
    model: "text-embedding-3-small",
  },
};

describe("wiki config", () => {
  test("applies wiki defaults when the block is omitted", () => {
    const config = memoryConfigSchema.parse(baseConfig);
    expect(config.wiki).toEqual({
      root: resolve(homedir(), ".mengshu", "wiki"),
      entriesDirName: "entries",
      writeEntriesOnPersist: true,
      indexUpdate: "sync-ancestors",
      updateCompletion: true,
    });
  });

  test("expands ~ and honors optional wiki fields for a temporary root", () => {
    const config = memoryConfigSchema.parse({
      ...baseConfig,
      wiki: {
        root: "~/mengshu-wiki-w1-config",
        entriesDirName: "track-e",
        writeEntriesOnPersist: false,
        indexUpdate: "off",
        updateCompletion: false,
      },
    });
    expect(config.wiki).toEqual({
      root: resolve(homedir(), "mengshu-wiki-w1-config"),
      entriesDirName: "track-e",
      writeEntriesOnPersist: false,
      indexUpdate: "off",
      updateCompletion: false,
    });
  });

  test("rejects a relative wiki root and unknown wiki keys", () => {
    expect(() => memoryConfigSchema.parse({
      ...baseConfig,
      wiki: { root: "relative/wiki" },
    })).toThrow(/absolute/);
    expect(() => memoryConfigSchema.parse({
      ...baseConfig,
      wiki: { material: true },
    })).toThrow(/unknown keys: material/);
  });
});
