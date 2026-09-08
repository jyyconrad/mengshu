#!/usr/bin/env node
import { createRequire } from "node:module";
import { formatCliError } from "../packages/api/src/cli/error-output.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-V")) {
    // Package self-reference anchors both source and dist entries, independently of cwd.
    const { version } = createRequire(import.meta.url)("@mengshu/core/package.json") as { version?: unknown };
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
      throw new Error("Package version is invalid");
    }
    console.log(version);
    return;
  }
  const { runMengshuCli } = await import("../packages/api/src/cli/ms.js");
  await runMengshuCli();
}

main().catch((error) => {
  console.error(formatCliError(error));
  process.exitCode = 1;
});
