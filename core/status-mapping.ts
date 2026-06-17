/**
 * status-mapping.ts
 *
 * 工作内容：实现 D-19 统一状态模型中"内部状态 → 用户可见视图"的单向聚合映射
 *           （§0.3.1）。四套状态分开定义，本模块只做单向、确定性的呈现层折叠。
 * 核心流程：mapToUserVisibleStatus 按 lifecycle > candidate > admission 的优先级解析，
 *           输出 UserVisibleStatus（或 null 表示不可见）与 lookupOnly 标记。
 * 关键边界：
 *   - drop / 无任何内部状态 → status=null（不可见，不参与算法）
 *   - lookup_only / evidence_only → pending 且 lookupOnly=true（economy 模式，D-20）
 *   - 映射严格单向：仅从内部状态聚合到用户视图，反向不可推导
 *   - UserVisibleStatus 不落库、不参与算法判定
 *
 * 注意：本文件独立于 types.ts，以便同时引用 core 与 lifecycle 类型而不产生循环依赖。
 */

import type {
  AdmissionRoute,
  MemoryLifecycleStatus,
  UserVisibleStatus,
} from "./types.js";
import type { CandidateStatus } from "../lifecycle/candidate-types.js";

/**
 * 聚合输入：三套内部状态均为可选。
 * 同一条记录在不同阶段可能只持有其中一种或多种状态。
 */
export interface UserVisibleStatusInput {
  /** 准入路由结果（准入阶段瞬时结果） */
  admissionRoute?: AdmissionRoute;
  /** 候选区状态机 */
  candidateStatus?: CandidateStatus;
  /** 主库生命周期 */
  lifecycleStatus?: MemoryLifecycleStatus;
}

/**
 * 聚合结果：呈现层状态 + lookup-only 标记。
 * status=null 表示对用户不可见（drop 或无状态）。
 */
export interface UserVisibleStatusResult {
  status: UserVisibleStatus | null;
  /** 是否为 lookup-only（economy 模式：可搜索，不进必读层） */
  lookupOnly: boolean;
}

/** MemoryLifecycleStatus → UserVisibleStatus（§0.3.1）。 */
function mapLifecycle(
  status: MemoryLifecycleStatus
): UserVisibleStatus {
  switch (status) {
    case "active":
    case "promoted":
      return "active";
    case "archived":
    case "superseded":
      return "archived";
    case "revoked":
      return "forgotten";
  }
}

/** CandidateStatus → UserVisibleStatus（§0.3.1）。 */
function mapCandidate(status: CandidateStatus): UserVisibleStatus {
  switch (status) {
    case "pending":
      return "pending";
    case "approved":
      return "active";
    case "rejected":
      return "forgotten";
    case "archived":
    case "expired":
      return "archived";
  }
}

/**
 * AdmissionRoute → UserVisibleStatus（§0.3.1）。
 * lookup_only / evidence_only 由调用方额外标记 lookupOnly。
 */
function mapAdmission(route: AdmissionRoute): UserVisibleStatus | null {
  switch (route) {
    case "drop":
      return null;
    case "candidate_low_priority":
      return "low_priority";
    case "candidate":
    case "lookup_only":
    case "evidence_only":
      return "pending";
    case "active":
      return "active";
  }
}

/**
 * 将三套内部状态单向聚合为用户可见视图。
 *
 * 解析优先级（最确定的状态优先）：
 *   1. lifecycleStatus（已入主库，最终态）
 *   2. candidateStatus（候选区状态机）
 *   3. admissionRoute（准入阶段瞬时结果）
 *
 * lookup-only 标记独立于优先级：只要 admissionRoute 为 lookup_only/evidence_only 即置位，
 * 用于呈现"可搜索但不进必读层"的 economy 语义（D-20）。
 */
export function mapToUserVisibleStatus(
  input: UserVisibleStatusInput
): UserVisibleStatusResult {
  const lookupOnly =
    input.admissionRoute === "lookup_only" ||
    input.admissionRoute === "evidence_only";

  let status: UserVisibleStatus | null = null;

  if (input.lifecycleStatus !== undefined) {
    status = mapLifecycle(input.lifecycleStatus);
  } else if (input.candidateStatus !== undefined) {
    status = mapCandidate(input.candidateStatus);
  } else if (input.admissionRoute !== undefined) {
    status = mapAdmission(input.admissionRoute);
  }

  return { status, lookupOnly };
}
