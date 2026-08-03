export interface HeartbeatControlPlane {
  heartbeat(workerId: string, details: Readonly<Record<string, unknown>>): Promise<void>;
}

export interface HeartbeatLoopOptions {
  readonly controlPlane: HeartbeatControlPlane;
  readonly details: () => Readonly<Record<string, unknown>>;
  readonly intervalMs: number;
  readonly onError: (error: unknown) => void;
  readonly signal: AbortSignal;
  readonly wait?: typeof abortableDelay;
  readonly workerId: string;
}

export async function runHeartbeatLoop(options: HeartbeatLoopOptions): Promise<void> {
  const wait = options.wait ?? abortableDelay;
  while (!options.signal.aborted) {
    try {
      await options.controlPlane.heartbeat(options.workerId, options.details());
    } catch (error: unknown) {
      options.onError(error);
    }
    await wait(options.intervalMs, options.signal);
  }
}

export function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}
