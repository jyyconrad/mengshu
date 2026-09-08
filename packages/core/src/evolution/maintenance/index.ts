export { DEFAULT_MAINTENANCE_BUDGET, planMaintenance, runMaintenanceTick } from "./planner.js";
export { recordMaintenanceOutcome, cleanupMaintenance } from "./retention.js";
export { planEquivalentMerge, applyEquivalentMerge } from "./merge.js";
export { compileExperiencePatterns, candidateFromPattern, skillCandidateContentHash } from "./patterns.js";
export { GovernedSkillAggregationService } from "./skill-aggregation.js";
export type { GovernedSkillAggregationResult } from "./skill-aggregation.js";
export type * from "./types.js";
export type * from "./experience-types.js";
