import type { Embeddings } from "../../processing/embeddings.js";
import type { DatabaseProvider, TableName } from "../../db/types.js";
import type { MemoryConfig } from "../../config.js";
import type { IngestionPipeline } from "../../ingest/pipeline.js";
import type { RoutingEngine } from "../../routing/rules.js";
import type { CommanderLike } from "./cli.js";
import {
  handleMemoryScanDirectory,
  resolveCategoryName,
  resolveTableName,
} from "./tools.js";

export interface RegisterLegacyCliOptions {
  config: MemoryConfig;
  db: DatabaseProvider;
  embeddings: Embeddings;
  ingestionPipeline: IngestionPipeline;
  routingEngine: RoutingEngine | null;
  resolvedDbPath: string;
  resolvePath(path: string): string;
}

export function registerLegacyCliCommands(
  memory: CommanderLike,
  options: RegisterLegacyCliOptions,
): void {
  const { config, db, embeddings, ingestionPipeline, routingEngine } = options;

  memory
    .command("list")
    .description("List memory statistics")
    .action(async () => {
      const totalCount = await db.count();
      const memoryCount = await db.count({ dataType: "memory" });
      const documentCount = await db.count({ dataType: "document" });

      console.log(`Total memories: ${totalCount}`);
      console.log(`- User memories: ${memoryCount}`);
      console.log(`- Document memories: ${documentCount}`);
    });

  memory
    .command("tables")
    .description("List all tables")
    .action(async () => {
      if (db.getTableNames) {
        const tableNames = await db.getTableNames();
        console.log("Available tables:");
        for (const tableName of tableNames) {
          const count = await db.count({ tableName });
          console.log(`- ${tableName}: ${count} entries`);
        }
      } else {
        console.log("Table listing not supported by current database provider");
      }
    });

  memory
    .command("stats")
    .description("Show memory statistics")
    .action(async () => {
      const totalCount = await db.count();
      const memoryCount = await db.count({ dataType: "memory" });
      const documentCount = await db.count({ dataType: "document" });

      console.log("Memory Statistics:");
      console.log(`- Total entries: ${totalCount}`);
      console.log(`- User memories: ${memoryCount}`);
      console.log(`- Scanned documents: ${documentCount}`);
      console.log(`- Database type: ${config.dbType}`);

      if (db.getTableStats) {
        const tableStats = await db.getTableStats();
        console.log("\nStorage Categories:");
        for (const stat of tableStats) {
          const categoryName = resolveCategoryName(stat.name);
          console.log(`- ${categoryName} (${stat.name}): ${stat.count} entries`);
        }
      }

      if (config.supabase) {
        console.log(`- Supabase URL: ${config.supabase.url}`);
      } else {
        console.log(`- LanceDB path: ${options.resolvedDbPath}`);
      }
    });

  memory
    .command("search <query>")
    .description("Search memories")
    .option("--limit <n>", "Max results", "5")
    .option("--include-documents", "Include scanned documents", false)
    .option("--category <name>", "Storage category: 核心记忆 | 知识库")
    .option("--search-all", "Search across all categories", false)
    .action(async (query: unknown, opts: unknown) => {
      const values = opts as {
        limit?: string;
        includeDocuments?: boolean;
        category?: string;
        searchAll?: boolean;
      };
      const vector = await embeddings.embed(query as string);
      const tableName = resolveTableName(values.category);
      const results = await db.query({
        vector,
        limit: parseInt(values.limit ?? "5", 10),
        minScore: 0.3,
        dataTypes: values.includeDocuments ? ["memory", "document", "knowledge"] : ["memory"],
        tableName,
        searchAll: values.searchAll,
      });
      const output = results.map((record) => ({
        id: record.id,
        text: record.text,
        category: record.category,
        dataType: record.dataType,
        storageCategory: resolveCategoryName(record.tableName),
        filePath: record.metadata?.filePath,
        importance: record.importance,
        score: record.score,
      }));
      console.log(JSON.stringify(output, null, 2));
    });

  memory
    .command("query")
    .description("Advanced query with filters")
    .option("--category <name>", "Storage category: 核心记忆 | 知识库")
    .option("--filter <json>", "Filter conditions as JSON")
    .option("--limit <n>", "Max results", "100")
    .action(async (opts) => {
      const values = opts as { category?: string; filter?: string; limit?: string };
      let filter: Record<string, unknown> = {};
      if (values.filter) {
        try {
          filter = JSON.parse(values.filter);
        } catch (err) {
          console.error("Invalid JSON filter:", err);
          process.exit(1);
        }
      }

      const tableName = resolveTableName(values.category);
      const count = await db.count({ ...filter, tableName });
      console.log(`Found ${count} entries matching filter`);

      const results = await db.query({
        limit: parseInt(values.limit ?? "100", 10),
        filter,
        tableName,
      });

      const output = results.map((record) => ({
        id: record.id,
        text: record.text.slice(0, 100) + (record.text.length > 100 ? "..." : ""),
        category: record.category,
        dataType: record.dataType,
        storageCategory: resolveCategoryName(record.tableName),
        metadata: record.metadata,
        importance: record.importance,
      }));
      console.log(JSON.stringify(output, null, 2));
    });

  memory
    .command("scan <directory>")
    .description("Scan directory of Markdown files")
    .option("--ignore <paths...>", "Paths to ignore")
    .option("--category <name>", "Storage category: 核心记忆 | 知识库 (default: 知识库)", "知识库")
    .action(async (directory: unknown, opts: unknown) => {
      const values = opts as { ignore?: string[]; category?: string };
      const resolvedDir = options.resolvePath(directory as string);
      const tableName = resolveTableName(values.category) || "knowledge";

      console.log(`Scanning directory: ${resolvedDir}`);
      console.log(`Storage category: ${resolveCategoryName(tableName)}`);
      const response = await handleMemoryScanDirectory(
        {
          directory: directory as string,
          ignorePaths: values.ignore || [],
          targetTable: tableName,
        },
        {
          pipeline: ingestionPipeline,
          resolvePath: options.resolvePath,
          defaultIgnorePaths: config.scanner?.defaultIgnorePaths,
          defaultIgnoreRules: config.scanner?.customIgnoreRules,
          defaultTargetTable: config.scanner?.targetTable,
          defaultAutoEnrichMetadata: config.scanner?.autoEnrichMetadata,
        },
      );
      const result = response.details as {
        totalFiles: number;
        processedFiles: number;
        failedFiles: number;
        totalChunks: number;
        storedChunks: number;
        duplicateChunks: number;
        jobsQueued: number;
        chunksAdmitted: number;
        chunksDropped: number;
      };

      console.log("\nScan completed:");
      console.log(`- Total files: ${result.totalFiles}`);
      console.log(`- Processed: ${result.processedFiles}`);
      console.log(`- Failed: ${result.failedFiles}`);
      console.log(`- Total chunks: ${result.totalChunks}`);
      console.log(`- Stored: ${result.storedChunks}`);
      console.log(`- Duplicates skipped: ${result.duplicateChunks}`);
      console.log(`- Jobs queued: ${result.jobsQueued}`);
      console.log(`- Chunks admitted: ${result.chunksAdmitted}`);
      console.log(`- Chunks dropped: ${result.chunksDropped}`);
    });

  memory
    .command("cleanup")
    .description("Clean up old memories")
    .option("--data-type <type>", "Data type to delete: memory or document")
    .option("--older-than <days>", "Delete entries older than N days")
    .option("--category <name>", "Storage category: 核心记忆 | 知识库")
    .action(async (opts) => {
      const values = opts as { dataType?: string; olderThan?: string; category?: string };
      const filter: Record<string, unknown> = {};

      if (values.dataType) {
        filter.dataType = values.dataType;
      }
      if (values.olderThan) {
        const days = parseInt(values.olderThan, 10);
        filter.createdAt = { $lt: Date.now() - (days * 24 * 60 * 60 * 1000) };
      }
      if (values.category) {
        filter.tableName = resolveTableName(values.category);
      }

      if (Object.keys(filter).length === 0) {
        console.error("Error: Please specify at least one filter condition");
        process.exit(1);
      }

      const deletedCount = await db.deleteByFilter(filter);
      console.log(`Deleted ${deletedCount} entries`);
    });

  memory
    .command("export")
    .description("Export memory data")
    .option("--category <name>", "Storage category: 核心记忆 | 知识库")
    .option("--format <format>", "Export format: json or csv", "json")
    .option("--output <file>", "Output file path")
    .action(async (opts) => {
      const values = opts as { category?: string; format?: string; output?: string };
      const tableName = resolveTableName(values.category);
      const results = await db.query({
        limit: 10000,
        tableName,
      });

      let output: string;
      if (values.format === "csv") {
        const headers = ["id", "text", "category", "dataType", "importance", "createdAt"];
        output = `${headers.join(",")}\n`;
        for (const record of results) {
          const row = [
            record.id,
            `"${record.text.replace(/"/g, '""')}"`,
            record.category,
            record.dataType,
            record.importance,
            record.createdAt,
          ];
          output += `${row.join(",")}\n`;
        }
      } else {
        output = JSON.stringify(results.map((record) => ({
          id: record.id,
          text: record.text,
          category: record.category,
          dataType: record.dataType,
          storageCategory: resolveCategoryName(record.tableName),
          importance: record.importance,
          metadata: record.metadata,
          createdAt: record.createdAt,
        })), null, 2);
      }

      if (values.output) {
        const fs = await import("node:fs/promises");
        await fs.writeFile(values.output, output, "utf-8");
        console.log(`Exported ${results.length} entries to ${values.output}`);
      } else {
        console.log(output);
      }
    });

  registerKnowledgeBaseCommands(memory, db);
  registerRoutingRuleCommands(memory, routingEngine);
}

function registerKnowledgeBaseCommands(memory: CommanderLike, db: DatabaseProvider): void {
  memory
    .command("kb:list")
    .description("List all knowledge bases")
    .action(async () => {
      if (!db.getTableStats) {
        console.log("Knowledge base listing not supported by current database provider");
        return;
      }

      const stats = await db.getTableStats();
      const knowledgeBaseStats = stats.filter((stat) => stat.name.startsWith("knowledge"));

      if (knowledgeBaseStats.length === 0) {
        console.log("No knowledge bases found");
        return;
      }

      console.log("Knowledge Bases:");
      for (const stat of knowledgeBaseStats) {
        const categoryName = resolveCategoryName(stat.name);
        console.log(`- ${categoryName} (${stat.name}): ${stat.count} entries`);
      }
    });

  memory
    .command("kb:stats <name>")
    .description("Show statistics for a specific knowledge base")
    .action(async (name) => {
      const tableName = name as TableName;
      const count = await db.count({ tableName });
      const categoryName = resolveCategoryName(tableName);
      console.log(`${categoryName} (${tableName}): ${count} entries`);
    });

  memory
    .command("kb:create <name>")
    .description("Create a new knowledge base table")
    .action(async (name) => {
      if (!db.ensureTable) {
        console.log("Table creation not supported by current database provider");
        return;
      }

      const tableName = name as TableName;
      if (!tableName.startsWith("knowledge_")) {
        console.error("Error: Knowledge base table name must start with 'knowledge_'");
        process.exit(1);
      }

      await db.ensureTable(tableName);
      const categoryName = resolveCategoryName(tableName);
      console.log(`Created knowledge base: ${categoryName} (${tableName})`);
    });

  memory
    .command("kb:delete <name>")
    .description("Delete a knowledge base table (WARNING: this will delete all data!)")
    .action(async (name) => {
      console.warn("Warning: Deleting a knowledge base will permanently delete all data.");
      console.warn("This operation cannot be undone.");
      console.log("");
      console.log("To delete a knowledge base, please use the Supabase web console or run SQL command:");
      console.log(`  DROP TABLE IF EXISTS ${name};`);
    });
}

function registerRoutingRuleCommands(memory: CommanderLike, routingEngine: RoutingEngine | null): void {
  memory
    .command("rules:list")
    .description("List all routing rules")
    .action(async () => {
      if (!routingEngine) {
        console.log("Routing engine not initialized. Enable knowledgeBases in config to use routing rules.");
        return;
      }

      const rules = routingEngine.getAllRules();
      const enabledRules = routingEngine.getEnabledRules();

      console.log("Routing Rules:");
      console.log("");

      if (rules.length === 0) {
        console.log("  No rules configured");
        return;
      }

      for (const rule of rules) {
        const status = rule.enabled === false ? "(disabled)" : "(enabled)";
        const patterns = rule.patterns.map((pattern: string | RegExp) =>
          typeof pattern === "string" ? pattern : pattern.source
        ).join(", ");
        console.log(`  ${rule.name} ${status}`);
        console.log(`    Patterns: ${patterns}`);
        console.log(`    Target: ${resolveCategoryName(rule.targetTable)} (${rule.targetTable})`);
        console.log("");
      }

      console.log(`Total: ${rules.length} rules (${enabledRules.length} enabled)`);
    });

  memory
    .command("rules:enable <name>")
    .description("Enable a routing rule")
    .action(async (name) => {
      if (routingEngine) {
        routingEngine.toggleRule(name as string, true);
        console.log(`Enabled rule: ${name}`);
      } else {
        console.log("Routing engine not initialized");
      }
    });

  memory
    .command("rules:disable <name>")
    .description("Disable a routing rule")
    .action(async (name) => {
      if (routingEngine) {
        routingEngine.toggleRule(name as string, false);
        console.log(`Disabled rule: ${name}`);
      } else {
        console.log("Routing engine not initialized");
      }
    });
}
