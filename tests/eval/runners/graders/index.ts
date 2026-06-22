/**
 * graders/ 聚合导出（P0-2）。
 *
 * 暴露 3 项 P0 确定性子 grader 及其统一接口，供 judge.ts 聚合调用。
 */

export type {
  Grader,
  GraderInput,
  GraderResult,
  GraderSample,
  GraderViolation,
  RuntimeOutput,
} from "./types.js";
export { toGraderInput } from "./types.js";

export { forbiddenBodyPatternsGrader } from "./identifier.js";
export { scopeMatchGrader } from "./scope.js";
export { answerMustNotContainGrader } from "./safety.js";

import type { Grader } from "./types.js";
import { forbiddenBodyPatternsGrader } from "./identifier.js";
import { scopeMatchGrader } from "./scope.js";
import { answerMustNotContainGrader } from "./safety.js";

/** P0 子 grader 列表（按执行顺序）。 */
export const P0_GRADERS: ReadonlyArray<{ name: string; grader: Grader }> = [
  { name: "forbiddenBodyPatterns", grader: forbiddenBodyPatternsGrader },
  { name: "scopeMatch", grader: scopeMatchGrader },
  { name: "answerMustNotContain", grader: answerMustNotContainGrader },
];
