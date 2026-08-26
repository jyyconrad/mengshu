const FALLBACK_CLI_ERROR = "Error: CLI command failed";
const MAX_CLI_ERROR_LENGTH = 500;

export function formatCliError(error: unknown): string {
  if (!(error instanceof Error)) return FALLBACK_CLI_ERROR;
  const message = error.message
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CLI_ERROR_LENGTH);
  return message.length > 0 ? `Error: ${message}` : FALLBACK_CLI_ERROR;
}
