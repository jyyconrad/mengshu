#!/usr/bin/env node
import { runMengshuCli } from "../packages/api/src/cli/ms.js";
import { formatCliError } from "../packages/api/src/cli/error-output.js";

runMengshuCli().catch((error) => {
  console.error(formatCliError(error));
  process.exitCode = 1;
});
