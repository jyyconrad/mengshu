#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

class RuntimePreflightError extends Error {
  constructor(code, description = "failed") {
    super(`Failed to start mengshu MCP: runtime preflight ${description} (${code})`);
    this.name = "RuntimePreflightError";
  }
}

async function main() {
  const inlineAuthority = process.env.MENGSHU_AUTHORITY_JSON?.trim();
  const authorityFile = process.env.MENGSHU_AUTHORITY_FILE?.trim();
  const unresolvedPlaceholder = [inlineAuthority, authorityFile]
    .some((value) => value?.includes("${"));
  if (unresolvedPlaceholder || (inlineAuthority ? 1 : 0) + (authorityFile ? 1 : 0) !== 1) {
    console.error(
      "Failed to start mengshu MCP: authority configuration requires exactly one host-owned source",
    );
    process.exitCode = 1;
    return;
  }
  try {
    await run();
  } catch (error) {
    if (error instanceof RuntimePreflightError) {
      console.error(error.message);
    } else {
      console.error("Failed to start mengshu MCP: runtime preflight failed (UNEXPECTED_ERROR)");
    }
    process.exitCode = 1;
  }
}

function pluginVersion() {
  let manifest;
  try {
    manifest = JSON.parse(
      readFileSync(new URL("../.codex-plugin/plugin.json", import.meta.url), "utf8"),
    );
  } catch {
    throw new RuntimePreflightError("INVALID_PLUGIN_MANIFEST");
  }
  const version = manifest?.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new RuntimePreflightError("INVALID_PLUGIN_VERSION");
  }
  return version;
}

function executableFile(candidate) {
  try {
    const resolved = realpathSync(candidate);
    if (!statSync(resolved).isFile()) return undefined;
    accessSync(resolved, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return resolved;
  } catch {
    return undefined;
  }
}

function runtimeCommand(executable, prefixArgs = []) {
  return Object.freeze({ executable, prefixArgs: Object.freeze(prefixArgs) });
}

function bundledRuntime() {
  const bundled = fileURLToPath(
    new URL("../runtime/node_modules/@mengshu/core/dist/bin/ms.js", import.meta.url),
  );
  try {
    const resolved = realpathSync(bundled);
    if (!statSync(resolved).isFile()) return undefined;
    accessSync(resolved, constants.R_OK);
    return runtimeCommand(process.execPath, [resolved]);
  } catch {
    return undefined;
  }
}

function resolveRuntimeCommand() {
  const override = process.env.MENGSHU_CODEX_MS_PATH?.trim();
  if (override) {
    if (!isAbsolute(override)) {
      throw new RuntimePreflightError("INVALID_RUNTIME_OVERRIDE");
    }
    const executable = executableFile(override);
    if (!executable) throw new RuntimePreflightError("RUNTIME_NOT_EXECUTABLE");
    return runtimeCommand(executable);
  }

  const bundled = bundledRuntime();
  if (!bundled) throw new RuntimePreflightError("BUNDLED_RUNTIME_NOT_FOUND");
  return bundled;
}

function verifyRuntimeVersion(runtime, expectedVersion) {
  const result = spawnSync(runtime.executable, [...runtime.prefixArgs, "--version"], {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
    maxBuffer: 4_096,
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || result.signal !== null) {
    throw new RuntimePreflightError("VERSION_PROCESS_FAILED");
  }
  const version = result.stdout.trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new RuntimePreflightError("INVALID_VERSION_OUTPUT");
  }
  if (version !== expectedVersion) {
    throw new RuntimePreflightError("VERSION_MISMATCH", "version mismatch");
  }
}

async function run() {
  const runtime = resolveRuntimeCommand();
  verifyRuntimeVersion(runtime, pluginVersion());
  const useProcessGroup = process.platform !== "win32";
  const child = spawn(runtime.executable, [...runtime.prefixArgs, "mcp"], {
    stdio: "inherit",
    detached: useProcessGroup,
    env: {
      ...process.env,
      MENGSHU_HOME: process.env.MENGSHU_HOME || `${process.env.HOME}/.mengshu`,
    },
  });
  let forwardedSignal;
  let forceTimer;
  const signalChildTree = (signal) => {
    if (child.pid === undefined) return false;
    try {
      if (useProcessGroup) {
        process.kill(-child.pid, signal);
        return true;
      }
      return child.kill(signal);
    } catch (error) {
      // ESRCH means the group drained. EPERM can occur during the narrow
      // post-reap group-id race; never risk signalling a reused foreign group.
      if (error?.code === "ESRCH" || error?.code === "EPERM") return false;
      throw error;
    }
  };
  const childTreeExists = () => {
    if (child.pid === undefined) return false;
    if (!useProcessGroup) {
      return child.exitCode === null && child.signalCode === null;
    }
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH" || error?.code === "EPERM") return false;
      throw error;
    }
  };
  const waitForChildTreeExit = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (childTreeExists() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return !childTreeExists();
  };
  const forwardSignal = (signal) => {
    forwardedSignal = signal;
    if (!signalChildTree(signal)) return;
    forceTimer ??= setTimeout(() => {
      signalChildTree("SIGKILL");
    }, 5_000);
    forceTimer.unref();
  };
  const onSigint = () => forwardSignal("SIGINT");
  const onSigterm = () => forwardSignal("SIGTERM");
  const onDisconnect = () => forwardSignal("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  process.once("disconnect", onDisconnect);

  const outcome = await new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", () => {
      console.error("Failed to start mengshu MCP server (SPAWN_ERROR)");
      resolve({ code: 1, signal: null });
    });
  });

  // EOF/direct-child exit must not orphan descendants in the detached POSIX group.
  if (useProcessGroup && childTreeExists()) {
    signalChildTree(forwardedSignal ?? "SIGTERM");
  }
  if (!(await waitForChildTreeExit(5_000))) {
    signalChildTree("SIGKILL");
    await waitForChildTreeExit(1_000);
  }
  if (forceTimer) clearTimeout(forceTimer);
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
  process.off("disconnect", onDisconnect);
  if (forwardedSignal === "SIGINT") {
    process.exitCode = 130;
  } else if (forwardedSignal === "SIGTERM") {
    process.exitCode = 143;
  } else if (outcome.code !== null) {
    process.exitCode = outcome.code;
  } else {
    process.exitCode = 1;
  }
}

await main();
