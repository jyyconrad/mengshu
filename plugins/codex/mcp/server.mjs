#!/usr/bin/env node

import { spawn } from "node:child_process";

const inlineAuthority = process.env.MENGSHU_AUTHORITY_JSON?.trim();
const authorityFile = process.env.MENGSHU_AUTHORITY_FILE?.trim();
const unresolvedPlaceholder = [inlineAuthority, authorityFile]
  .some((value) => value?.includes("${"));
if (unresolvedPlaceholder || (inlineAuthority ? 1 : 0) + (authorityFile ? 1 : 0) !== 1) {
  console.error(
    "Failed to start mengshu MCP: authority configuration requires exactly one host-owned source",
  );
  process.exitCode = 1;
} else {
  await run();
}

async function run() {
  const useProcessGroup = process.platform !== "win32";
  const child = spawn("ms", ["mcp"], {
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
