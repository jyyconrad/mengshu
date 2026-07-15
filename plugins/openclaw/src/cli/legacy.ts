import type { MemoryConfig } from "../../../../config.js";
import type { IngestionPipeline } from "../../../../ingest/pipeline.js";
import type { RoutingEngine } from "../../../../packages/core/src/routing/rules.js";
import {
  requireOpenClawCliAuthority,
  type CommanderLike,
  type OpenClawCliAuthorityContext,
} from "./index.js";
import {
  handleMemoryScanDirectory,
  resolveCategoryName,
  resolveTableName,
} from "../tools.js";

/**
 * Transitional legacy CLI boundary.
 *
 * Raw provider commands cannot express authenticated tenant/user ownership, so
 * they stay visible only to return a clear migration error. The directory scan
 * is retained because it goes through the authority-scoped ingestion handler.
 */
export interface RegisterLegacyCliOptions extends OpenClawCliAuthorityContext {
  config?: MemoryConfig;
  ingestionPipeline?: IngestionPipeline;
  routingEngine?: RoutingEngine | null;
  resolvePath?(path: string): string;
}

const RAW_COMMANDS = [
  ["list", "List memory statistics"],
  ["tables", "List all tables"],
  ["stats", "Show memory statistics"],
  ["search <query>", "Search memories"],
  ["query", "Advanced query with filters"],
  ["cleanup", "Clean up old memories"],
  ["export", "Export memory data"],
  ["kb:list", "List all knowledge bases"],
  ["kb:stats <name>", "Show statistics for a specific knowledge base"],
  ["kb:create <name>", "Create a new knowledge base table"],
  ["kb:delete <name>", "Delete a knowledge base table"],
] as const;

function legacyUnavailable(command: string): never {
  throw new Error(
    `OpenClaw legacy command ${command} is disabled: no authority-safe scoped service contract is available`,
  );
}

export function registerLegacyCliCommands(
  memory: CommanderLike,
  options: RegisterLegacyCliOptions,
): void {
  requireOpenClawCliAuthority(options);

  for (const [command, description] of RAW_COMMANDS) {
    memory
      .command(command)
      .description(`${description} (disabled until authority-scoped migration is available)`)
      .action(async () => legacyUnavailable(command.split(" ")[0]!));
  }

  memory
    .command("scan <directory>")
    .description("Scan a directory through the authority-scoped ingestion pipeline")
    .option("--ignore <paths...>", "Paths to ignore")
    .option("--category <name>", "Storage category", "知识库")
    .action(async (directory: unknown, opts: unknown) => {
      requireOpenClawCliAuthority(options);
      if (!options.ingestionPipeline || !options.resolvePath) {
        throw new Error("OpenClaw legacy scan is unavailable: scoped ingestion dependencies are required");
      }
      const values = (opts ?? {}) as { ignore?: string[]; category?: string };
      const tableName = resolveTableName(values.category) || "knowledge";
      const response = await handleMemoryScanDirectory(
        {
          directory: String(directory ?? ""),
          ignorePaths: values.ignore ?? [],
          targetTable: tableName,
        },
        {
          authority: options.authority!,
          defaultScope: options.defaultScope!,
          pipeline: options.ingestionPipeline,
          resolvePath: options.resolvePath,
          defaultIgnorePaths: options.config?.scanner?.defaultIgnorePaths,
          defaultIgnoreRules: options.config?.scanner?.customIgnoreRules,
          defaultTargetTable: options.config?.scanner?.targetTable,
          defaultAutoEnrichMetadata: options.config?.scanner?.autoEnrichMetadata,
        },
      );
      console.log(
        `Scan completed for ${resolveCategoryName(tableName)}: ` +
        `${String(response.details.processedFiles ?? 0)} files processed`,
      );
    });

  registerRoutingRuleCommands(memory, options);
}

function registerRoutingRuleCommands(
  memory: CommanderLike,
  options: RegisterLegacyCliOptions,
): void {
  memory
    .command("rules:list")
    .description("List routing rules")
    .action(async () => {
      requireOpenClawCliAuthority(options);
      const rules = options.routingEngine?.getAllRules() ?? [];
      console.log(JSON.stringify(rules, null, 2));
    });

  for (const enabled of [true, false] as const) {
    const name = enabled ? "rules:enable <name>" : "rules:disable <name>";
    memory
      .command(name)
      .description(enabled ? "Enable a routing rule" : "Disable a routing rule")
      .action(async (ruleName: unknown) => {
        requireOpenClawCliAuthority(options);
        if (!options.routingEngine) {
          throw new Error("OpenClaw routing engine is unavailable");
        }
        options.routingEngine.toggleRule(String(ruleName), enabled);
      });
  }
}
