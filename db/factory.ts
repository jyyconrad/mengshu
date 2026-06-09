import type { MemoryConfig } from "../config";
import type { DatabaseProvider } from "./types";
import { LanceDBProvider } from "./providers/lancedb";
import { SupabaseProvider } from "./providers/supabase";
import { HybridProvider } from "./providers/hybrid";
import { PostgresProvider } from "./providers/postgres";

/**
 * 数据库工厂类
 * 根据配置创建对应的数据库提供者实例
 */
export class DatabaseFactory {
  static createProvider(config: MemoryConfig, resolvedDbPath: string): DatabaseProvider {
    const embeddingModel = config.embedding.model ?? "text-embedding-3-small";

    switch (config.dbType) {
      case "supabase":
        if (!config.supabase) {
          throw new Error("Supabase config is required when dbType is 'supabase'");
        }
        return new SupabaseProvider(
          config.supabase.url,
          config.supabase.serviceKey,
          embeddingModel,
          config.knowledgeBases,
        );

      case "postgres":
        if (!config.postgres) {
          throw new Error("Postgres config is required when dbType is 'postgres'");
        }
        return new PostgresProvider(
          config.postgres,
          embeddingModel,
          config.knowledgeBases,
        );

      case "lancedb":
      default:
        // 如果提供了 Supabase 配置，使用混合模式
        if (config.supabase) {
          const lanceDbProvider = new LanceDBProvider(resolvedDbPath, embeddingModel, config.knowledgeBases);
          const supabaseProvider = new SupabaseProvider(
            config.supabase.url,
            config.supabase.serviceKey,
            embeddingModel,
            config.knowledgeBases,
          );
          return new HybridProvider(lanceDbProvider, supabaseProvider);
        }
        // 否则只使用 LanceDB
        return new LanceDBProvider(resolvedDbPath, embeddingModel, config.knowledgeBases);
    }
  }
}
