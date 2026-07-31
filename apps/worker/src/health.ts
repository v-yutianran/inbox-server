export interface WorkerHealthState {
  readonly acceptingJobs: boolean;
  readonly browserReady: boolean;
  readonly lastLoopAt: number;
  readonly phase: "starting" | "running" | "stopping";
  readonly startedAt: number;
}

export type WorkerHealthEvent =
  | { readonly at: number; readonly type: "browser-ready" }
  | { readonly at: number; readonly type: "loop-progress" }
  | { readonly at: number; readonly type: "shutdown-started" };

export type ProbeResult =
  | { readonly body: { readonly status: "ok" | "ready" }; readonly status: 200 }
  | {
      readonly body: {
        readonly status: "stale" | "starting" | "stopping";
      };
      readonly status: 503;
    };

export function createWorkerHealthState(startedAt: number): WorkerHealthState {
  return {
    acceptingJobs: true,
    browserReady: false,
    lastLoopAt: startedAt,
    phase: "starting",
    startedAt,
  };
}

export function reduceWorkerHealthState(
  state: WorkerHealthState,
  event: WorkerHealthEvent,
): WorkerHealthState {
  switch (event.type) {
    case "browser-ready":
      return {
        ...state,
        browserReady: true,
        lastLoopAt: event.at,
        phase: "running",
      };
    case "loop-progress":
      return { ...state, lastLoopAt: event.at };
    case "shutdown-started":
      return {
        ...state,
        acceptingJobs: false,
        lastLoopAt: event.at,
        phase: "stopping",
      };
  }
}

export function evaluateLiveness(
  state: WorkerHealthState,
  now: number,
  staleAfterMs: number,
): ProbeResult {
  if (now - state.lastLoopAt > staleAfterMs) {
    return { body: { status: "stale" }, status: 503 };
  }
  return { body: { status: "ok" }, status: 200 };
}

export function evaluateReadiness(state: WorkerHealthState): ProbeResult {
  if (state.phase === "stopping" || !state.acceptingJobs) {
    return { body: { status: "stopping" }, status: 503 };
  }
  if (!state.browserReady) {
    return { body: { status: "starting" }, status: 503 };
  }
  return { body: { status: "ready" }, status: 200 };
}
