/**
 * core/paths.ts 单测。
 *
 * 覆盖：expandHome、resolveHomeDir 优先级（显式 > env > 默认）、派生路径正确性。
 * 测试用注入的 home/env，避免触碰真实 `~/.mengshu/`。
 */

import { describe, expect, it } from "vitest";
import {
  CONFIG_FILENAME,
  DEFAULT_HOME_DIRNAME,
  ENV_FILENAME,
  LEGACY_HOME_DIRNAME,
  REGISTRY_FILENAME,
  expandHome,
  resolveConfigPath,
  resolveDefaultLanceDbPath,
  resolveEnvPath,
  resolveHomeDir,
  resolveLegacyHomeDir,
  resolveLegacyLanceDbPath,
  resolveProjectDir,
  resolveProjectManifestPath,
  resolveProjectsDir,
  resolveRegistryPath,
} from "./paths.js";

const FAKE_HOME = "/tmp/fake-home";

describe("paths/expandHome", () => {
  it("把单独的 `~` 展开为 home", () => {
    expect(expandHome("~", FAKE_HOME)).toBe(FAKE_HOME);
  });

  it("把 `~/foo/bar` 展开为 home + 子路径", () => {
    expect(expandHome("~/foo/bar", FAKE_HOME)).toBe(`${FAKE_HOME}/foo/bar`);
  });

  it("绝对路径原样返回", () => {
    expect(expandHome("/usr/local/lib", FAKE_HOME)).toBe("/usr/local/lib");
  });

  it("相对路径原样返回（调用方负责再 resolve）", () => {
    expect(expandHome("./config.json", FAKE_HOME)).toBe("./config.json");
  });
});

describe("paths/resolveHomeDir", () => {
  it("默认指向 `<home>/.mengshu`", () => {
    expect(resolveHomeDir({ home: FAKE_HOME, env: {} })).toBe(
      `${FAKE_HOME}/${DEFAULT_HOME_DIRNAME}`,
    );
  });

  it("env.MENGSHU_HOME 可以覆盖默认 home", () => {
    expect(
      resolveHomeDir({
        home: FAKE_HOME,
        env: { MENGSHU_HOME: "~/custom-home" },
      }),
    ).toBe(`${FAKE_HOME}/custom-home`);
  });

  it("options.homeDir 优先于 env", () => {
    expect(
      resolveHomeDir({
        home: FAKE_HOME,
        env: { MENGSHU_HOME: "~/from-env" },
        homeDir: "~/from-option",
      }),
    ).toBe(`${FAKE_HOME}/from-option`);
  });

  it("绝对路径覆盖直接生效", () => {
    expect(resolveHomeDir({ homeDir: "/var/mengshu" })).toBe("/var/mengshu");
  });
});

describe("paths/resolveLegacyHomeDir", () => {
  it("总是指向 `<home>/.openclaw`", () => {
    expect(resolveLegacyHomeDir({ home: FAKE_HOME })).toBe(
      `${FAKE_HOME}/${LEGACY_HOME_DIRNAME}`,
    );
  });
});

describe("paths/派生文件路径", () => {
  const opts = { home: FAKE_HOME, env: {} };

  it("config.json 路径", () => {
    expect(resolveConfigPath(opts)).toBe(
      `${FAKE_HOME}/${DEFAULT_HOME_DIRNAME}/${CONFIG_FILENAME}`,
    );
  });

  it(".env 路径", () => {
    expect(resolveEnvPath(opts)).toBe(`${FAKE_HOME}/${DEFAULT_HOME_DIRNAME}/${ENV_FILENAME}`);
  });

  it("registry.json 路径", () => {
    expect(resolveRegistryPath(opts)).toBe(
      `${FAKE_HOME}/${DEFAULT_HOME_DIRNAME}/${REGISTRY_FILENAME}`,
    );
  });

  it("projects 目录", () => {
    expect(resolveProjectsDir(opts)).toBe(`${FAKE_HOME}/${DEFAULT_HOME_DIRNAME}/projects`);
  });

  it("单个 project 目录", () => {
    expect(resolveProjectDir("proj-abc", opts)).toBe(
      `${FAKE_HOME}/${DEFAULT_HOME_DIRNAME}/projects/proj-abc`,
    );
  });

  it("项目 manifest 路径", () => {
    expect(resolveProjectManifestPath("proj-abc", opts)).toBe(
      `${FAKE_HOME}/${DEFAULT_HOME_DIRNAME}/projects/proj-abc/manifest.json`,
    );
  });

  it("默认 LanceDB 路径", () => {
    expect(resolveDefaultLanceDbPath(opts)).toBe(
      `${FAKE_HOME}/${DEFAULT_HOME_DIRNAME}/memory/lancedb`,
    );
  });

  it("旧 LanceDB 路径", () => {
    expect(resolveLegacyLanceDbPath({ home: FAKE_HOME })).toBe(
      `${FAKE_HOME}/${LEGACY_HOME_DIRNAME}/memory/lancedb`,
    );
  });

  it("空 projectId 抛错", () => {
    expect(() => resolveProjectDir("   ", opts)).toThrow(/非空 projectId/);
  });
});
