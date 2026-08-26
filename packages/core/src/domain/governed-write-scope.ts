import {
  canonicalAuthorityScope,
  type CanonicalAuthorityScope,
} from "./authority-scope-fingerprint.js";
import type { MemoryScope } from "./types.js";

/** D-04：从最窄到最宽的六档逻辑作用域。 */
export type GovernedWriteScopeLevel =
  | "session"
  | "project"
  | "workspace"
  | "app"
  | "user"
  | "global";

export type GovernedWriteScopeErrorCode =
  | "INVALID_INPUT"
  | "INVALID_EXACT_SCOPE"
  | "INVALID_SOURCE_LEVEL"
  | "INVALID_TARGET_LEVEL"
  | "INVALID_SOURCE_LEVEL_AUTHORITY"
  | "SOURCE_LEVEL_AUTHORITY_REQUIRED"
  | "SOURCE_LEVEL_CONTEXT_MISSING"
  | "SOURCE_LEVEL_AMBIGUOUS";

export class GovernedWriteScopeError extends Error {
  readonly code: GovernedWriteScopeErrorCode;

  constructor(code: GovernedWriteScopeErrorCode) {
    super(`Governed write scope resolution failed: ${code}`);
    this.name = "GovernedWriteScopeError";
    this.code = code;
  }
}

export interface GovernedWriteScopeInput {
  /** 完整 9D 存储与权限坐标；不表达 D-04 的逻辑复用上界。 */
  readonly exactScope: MemoryScope;
  /** 由 server runtime 明确提供的事件来源上界；不能从必填 projectId 推断。 */
  readonly sourceLevel?: GovernedWriteScopeLevel;
  /** workspace/app/user/global 必须显式声明由 server 拥有该判断。 */
  readonly sourceLevelAuthority?: "server";
  /** 调用方请求的目标层级；最终结果不会宽于 sourceLevel。 */
  readonly requestedTargetLevel?: GovernedWriteScopeLevel;
}

export interface GovernedWriteScope {
  readonly exactScope: CanonicalAuthorityScope;
  readonly sourceLevel: GovernedWriteScopeLevel;
  readonly requestedTargetLevel: GovernedWriteScopeLevel;
  readonly targetLevel: GovernedWriteScopeLevel;
}

const LEVELS = [
  "session",
  "project",
  "workspace",
  "app",
  "user",
  "global",
] as const satisfies readonly GovernedWriteScopeLevel[];

const LEVEL_RANK = Object.freeze(Object.fromEntries(
  LEVELS.map((level, rank) => [level, rank]),
) as Record<GovernedWriteScopeLevel, number>);

const SERVER_OWNED_LEVELS = new Set<GovernedWriteScopeLevel>([
  "workspace",
  "app",
  "user",
  "global",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLevel(value: unknown): value is GovernedWriteScopeLevel {
  return typeof value === "string" && (LEVELS as readonly string[]).includes(value);
}

function canonicalScope(value: unknown): CanonicalAuthorityScope {
  if (!isRecord(value)) throw new GovernedWriteScopeError("INVALID_EXACT_SCOPE");
  try {
    return canonicalAuthorityScope(value as unknown as MemoryScope);
  } catch {
    throw new GovernedWriteScopeError("INVALID_EXACT_SCOPE");
  }
}

function resolveSourceLevel(
  input: GovernedWriteScopeInput,
  scope: CanonicalAuthorityScope,
): GovernedWriteScopeLevel {
  if (input.sourceLevel === undefined) {
    return scope.sessionId === "" ? "project" : "session";
  }
  if (!isLevel(input.sourceLevel)) {
    throw new GovernedWriteScopeError("INVALID_SOURCE_LEVEL");
  }
  if (input.sourceLevelAuthority !== undefined && input.sourceLevelAuthority !== "server") {
    throw new GovernedWriteScopeError("INVALID_SOURCE_LEVEL_AUTHORITY");
  }
  if (SERVER_OWNED_LEVELS.has(input.sourceLevel) && input.sourceLevelAuthority !== "server") {
    throw new GovernedWriteScopeError("SOURCE_LEVEL_AUTHORITY_REQUIRED");
  }

  if (input.sourceLevel === "session" && scope.sessionId === "") {
    throw new GovernedWriteScopeError("SOURCE_LEVEL_CONTEXT_MISSING");
  }
  if (input.sourceLevel === "workspace" && scope.workspaceId === "") {
    throw new GovernedWriteScopeError("SOURCE_LEVEL_CONTEXT_MISSING");
  }
  if (input.sourceLevel !== "session" && scope.sessionId !== "") {
    throw new GovernedWriteScopeError("SOURCE_LEVEL_AMBIGUOUS");
  }
  return input.sourceLevel;
}

/**
 * 同时解析 9D 权限坐标与 D-04 逻辑层级。
 *
 * exactScope 原样 canonicalize；targetLevel 仅由显式 sourceLevel 和 requestedTargetLevel
 * 决定。projectId 是持久化坐标，绝不充当逻辑层级探针。
 */
export function resolveGovernedWriteScope(input: GovernedWriteScopeInput): GovernedWriteScope {
  if (!isRecord(input)) throw new GovernedWriteScopeError("INVALID_INPUT");
  const exactScope = canonicalScope(input.exactScope);
  const sourceLevel = resolveSourceLevel(input, exactScope);
  const requestedTargetLevel = input.requestedTargetLevel ?? sourceLevel;
  if (!isLevel(requestedTargetLevel)) {
    throw new GovernedWriteScopeError("INVALID_TARGET_LEVEL");
  }
  const targetLevel = LEVEL_RANK[requestedTargetLevel] > LEVEL_RANK[sourceLevel]
    ? sourceLevel
    : requestedTargetLevel;

  return Object.freeze({
    exactScope: Object.freeze({ ...exactScope }),
    sourceLevel,
    requestedTargetLevel,
    targetLevel,
  });
}
