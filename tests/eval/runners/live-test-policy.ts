export type LiveTestEnvironment = Record<string, string | undefined>;

/**
 * 网络测试只能由专用开关显式启用；provider 凭据本身绝不是执行授权。
 */
export function isLiveTestEnabled(env: LiveTestEnvironment): boolean {
  return env.MENGSHU_RUN_LIVE_TESTS === "1";
}
