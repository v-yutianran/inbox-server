import { z } from "zod";

const workerConfigSchema = z.object({
  DISPLAY: z.string().min(1),
  HEALTH_PORT: z.coerce.number().int().min(1).max(65_535).default(8_080),
  HEALTH_STALE_AFTER_MS: z.coerce.number().int().positive().default(90_000),
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
});

export interface WorkerConfig {
  readonly display: string;
  readonly healthPort: number;
  readonly healthStaleAfterMs: number;
  readonly heartbeatIntervalMs: number;
}

export function parseWorkerConfig(
  environment: Readonly<Record<string, string | undefined>>,
): WorkerConfig {
  const parsed = workerConfigSchema.parse(environment);
  return {
    display: parsed.DISPLAY,
    healthPort: parsed.HEALTH_PORT,
    healthStaleAfterMs: parsed.HEALTH_STALE_AFTER_MS,
    heartbeatIntervalMs: parsed.HEARTBEAT_INTERVAL_MS,
  };
}
