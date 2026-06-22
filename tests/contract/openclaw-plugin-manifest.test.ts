import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const rootDir = process.cwd();

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("OpenClaw plugin manifests", () => {
  test("plugin package manifest uses mengshu-openclaw id with legacy aliases", () => {
    const manifest = readJson(join(rootDir, "plugins/openclaw/openclaw.plugin.json"));

    expect(manifest.id).toBe("mengshu-openclaw");
    expect(manifest.kind).toBe("memory");
    expect(manifest.legacyPluginIds).toEqual(["memory-autodb", "mengshu"]);
  });

  test("plugin package manifest defaults to shared PostgreSQL backend", () => {
    const manifest = readJson(join(rootDir, "plugins/openclaw/openclaw.plugin.json"));
    const configSchema = manifest.configSchema as Record<string, unknown>;
    const properties = configSchema.properties as Record<string, Record<string, unknown>>;

    expect(manifest.id).toBe("mengshu-openclaw");
    expect(manifest.legacyPluginIds).toEqual(["memory-autodb", "mengshu"]);
    expect(properties.dbType.default).toBe("postgres");
    expect(properties.dbPath.default).toBeUndefined();
    expect(properties.dbType.enum).toEqual(["lancedb", "supabase", "postgres"]);
    expect(properties.postgres.properties).toMatchObject({
      host: { type: "string" },
      port: { type: "number" },
      database: { type: "string" },
      user: { type: "string" },
      password: { type: "string" },
      ssl: { type: "boolean" },
    });
    expect(properties.supabase.properties).toMatchObject({
      url: { type: "string" },
      serviceKey: { type: "string" },
    });
  });
});
