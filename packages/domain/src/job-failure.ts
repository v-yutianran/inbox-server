export type JobErrorClass = "permanent" | "retryable";

export interface JobFailure {
  readonly attempts: number;
  readonly errorClass: JobErrorClass;
}

export interface ClassifiedJobFailure {
  readonly errorClass: JobErrorClass;
  readonly safeMessage: string;
}

const RETRYABLE_MESSAGE = /\b(408|409|425|429|5\d\d|fetch|network|timeout|temporar|unavailable|connection|socket)\b/i;
const SECRET_VALUE = /((?:api[_-]?key|authorization|cookie|password|secret|token)\s*[=:]\s*)([^\s,;]+)/gi;

/** 错误分类是跨运行时契约，API 与 Docker worker 必须使用同一纯函数。 */
export function classifyJobFailure(error: unknown): ClassifiedJobFailure {
  const message = error instanceof Error ? error.message : "unknown worker error";
  const retryable = error instanceof TypeError || RETRYABLE_MESSAGE.test(message);
  return {
    errorClass: retryable ? "retryable" : "permanent",
    safeMessage: redactErrorMessage(message),
  };
}

export function decideJobSettlement(
  failure: JobFailure,
  maximumAttempts = 3,
): "dead-letter" | "retry" {
  return failure.errorClass === "retryable" && failure.attempts < maximumAttempts
    ? "retry"
    : "dead-letter";
}

export function redactErrorMessage(message: string): string {
  return message.replace(SECRET_VALUE, "$1[redacted]").slice(0, 500);
}
