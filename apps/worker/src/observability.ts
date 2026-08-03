type JsonRecord = Readonly<Record<string, unknown>>;

export interface WorkerRuntimeMetrics {
  readonly articleExtraction: {
    readonly browserSucceeded: number;
    readonly directRejected: number;
    readonly directSucceeded: number;
    readonly failed: number;
  };
  readonly jobResults: {
    readonly deadLettered: number;
    readonly deferred: number;
    readonly retryableFailed: number;
    readonly succeeded: number;
    readonly uncertain: number;
  };
}

const metricPaths = {
  "article.extract.browser.succeeded": ["articleExtraction", "browserSucceeded"],
  "article.extract.direct.rejected": ["articleExtraction", "directRejected"],
  "article.extract.direct.succeeded": ["articleExtraction", "directSucceeded"],
  "article.extract.failed": ["articleExtraction", "failed"],
  "worker.effect.busy.deferred": ["jobResults", "deferred"],
  "worker.job.dead_lettered": ["jobResults", "deadLettered"],
  "worker.job.deferred": ["jobResults", "deferred"],
  "worker.job.retryable_failed": ["jobResults", "retryableFailed"],
  "worker.job.succeeded": ["jobResults", "succeeded"],
  "worker.job.uncertain": ["jobResults", "uncertain"],
} as const;

export function createRuntimeMetrics(): WorkerRuntimeMetrics {
  return {
    articleExtraction: {
      browserSucceeded: 0,
      directRejected: 0,
      directSucceeded: 0,
      failed: 0,
    },
    jobResults: {
      deadLettered: 0,
      deferred: 0,
      retryableFailed: 0,
      succeeded: 0,
      uncertain: 0,
    },
  };
}

export function reduceRuntimeMetrics(
  current: WorkerRuntimeMetrics,
  event: string,
): WorkerRuntimeMetrics {
  const path = metricPaths[event as keyof typeof metricPaths];
  if (!path) return current;
  const [group, counter] = path;
  if (group === "articleExtraction") {
    const name = counter as keyof WorkerRuntimeMetrics["articleExtraction"];
    return {
      ...current,
      articleExtraction: {
        ...current.articleExtraction,
        [name]: current.articleExtraction[name] + 1,
      },
    };
  }
  const name = counter as keyof WorkerRuntimeMetrics["jobResults"];
  return {
    ...current,
    jobResults: {
      ...current.jobResults,
      [name]: current.jobResults[name] + 1,
    },
  };
}

export function runtimeMetricsSnapshot(metrics: WorkerRuntimeMetrics): WorkerRuntimeMetrics {
  return {
    articleExtraction: { ...metrics.articleExtraction },
    jobResults: { ...metrics.jobResults },
  };
}

export function sanitizeLogContext(context: JsonRecord): JsonRecord {
  return Object.fromEntries(
    Object.entries(context).map(([key, value]) => [
      key,
      isSensitiveKey(key) ? "[redacted]" : sanitizeValue(value),
    ]),
  );
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(
      /((?:authorization|cookie|password|secret|token)\s*[=:]\s*)(?:Bearer\s+)?[^\s,;]+/gi,
      "$1[redacted]",
    );
  }
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (isRecord(value)) return sanitizeLogContext(value);
  return value;
}

function isSensitiveKey(key: string): boolean {
  return /authorization|cookie|password|secret|token/i.test(key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
