/**
 * OpenClaw plugin package entry.
 *
 * 这里是 OpenClaw 产品插件形态的 canonical 入口；根目录 index.ts 仅保留兼容转发。
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { memoryConfigSchema } from "../../../config.js";
import { registerOpenClawAdapter } from "./register.js";
import { defaultScopeFromOpenClawAuthority } from "./authority.js";
import {
  OPENCLAW_LEGACY_MEMORY_PLUGIN_IDS,
  OPENCLAW_MEMORY_PLUGIN_ID,
} from "./plugin-id.js";

export {
  escapeMemoryForPrompt,
  formatContextBlock,
  formatRelevantMemoriesContext,
  looksLikePromptInjection,
} from "../../../retrieval/prompt-safety.js";

export {
  detectCategory,
  shouldCapture,
} from "./hooks.js";

const memoryPlugin = {
  id: OPENCLAW_MEMORY_PLUGIN_ID,
  legacyPluginIds: [...OPENCLAW_LEGACY_MEMORY_PLUGIN_IDS],
  name: "Mengshu OpenClaw",
  description: "mengshu local-first memory middleware for OpenClaw, sharing memory data through ~/.mengshu.",
  kind: "memory" as const,
  configSchema: memoryConfigSchema,

  register(api: OpenClawPluginApi) {
    const config = memoryConfigSchema.parse(api.pluginConfig);
    if (!config.authority) {
      throw new Error(
        "Mengshu OpenClaw host integration requires an explicit authenticated AuthorityScope " +
        "in the local operator-owned plugin config",
      );
    }
    const defaultScope = defaultScopeFromOpenClawAuthority(
      config.authority,
      config.defaultAgentId,
    );
    return registerOpenClawAdapter(api, config, {
      authority: config.authority,
      defaultScope,
    });
  },
};

export default memoryPlugin;
