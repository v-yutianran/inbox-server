import type { QueueJob } from "@inbox/domain";

export type WorkerComponent = "browser" | "mihomo" | "warp";
export type WorkerComponentPhase = "starting" | "ready" | "degraded" | "stopping" | "failed";
export type WorkerPhase = WorkerComponentPhase;

export interface WorkerComponentState {
  readonly canAcceptWork: boolean;
  readonly observedAt: number;
  readonly reasonCode: string;
  readonly required: boolean;
  readonly state: WorkerComponentPhase;
}

export interface WorkerHealthState {
  readonly acceptingJobs: boolean;
  readonly browserReady: boolean;
  readonly components: Readonly<Record<WorkerComponent, WorkerComponentState>>;
  readonly lastLoopAt: number;
  readonly phase: WorkerPhase;
  readonly startedAt: number;
}

export type WorkerHealthEvent =
  | { readonly at: number; readonly type: "browser-ready" }
  | {
      readonly at: number;
      readonly component: WorkerComponent;
      readonly reasonCode: string;
      readonly state: WorkerComponentPhase;
      readonly type: "component-state";
    }
  | { readonly at: number; readonly type: "loop-error" }
  | { readonly at: number; readonly type: "loop-progress" }
  | { readonly at: number; readonly type: "shutdown-started" };

export type JobAcceptanceDecision =
  | { readonly action: "accept" }
  | {
      readonly action: "defer";
      readonly reasonCode:
        | "browser_unready"
        | "mihomo_unready"
        | "warp_unready"
        | "worker_stopping";
      readonly retryAfterSeconds: number;
    };

interface WorkerHealthSnapshot {
  readonly canAcceptWork: boolean;
  readonly components: Readonly<
    Record<
      WorkerComponent,
      {
        readonly canAcceptWork: boolean;
        readonly observedAt: string;
        readonly reasonCode: string;
        readonly state: WorkerComponentPhase;
      }
    >
  >;
  readonly phase: WorkerPhase;
}

export type ProbeResult =
  | {
      readonly body: WorkerHealthSnapshot & { readonly status: "ok" | "ready" };
      readonly status: 200;
    }
  | {
      readonly body: WorkerHealthSnapshot & {
        readonly status: "degraded" | "failed" | "starting" | "stopping";
      };
      readonly status: 503;
    };

export function createWorkerHealthState(
  startedAt: number,
  requirements: {
    readonly mihomoRequired?: boolean;
    readonly warpRequired?: boolean;
  } = {},
): WorkerHealthState {
  const components = {
    browser: startingComponent(startedAt, true),
    mihomo: startingComponent(startedAt, requirements.mihomoRequired === true),
    warp: startingComponent(startedAt, requirements.warpRequired === true),
  } satisfies Record<WorkerComponent, WorkerComponentState>;
  return deriveState({
    acceptingJobs: true,
    browserReady: false,
    components,
    lastLoopAt: startedAt,
    phase: "starting",
    startedAt,
  });
}

export function reduceWorkerHealthState(
  state: WorkerHealthState,
  event: WorkerHealthEvent,
): WorkerHealthState {
  switch (event.type) {
    case "browser-ready":
      return updateComponent(state, "browser", "ready", "browser_connected", event.at);
    case "component-state":
      return updateComponent(
        state,
        event.component,
        event.state,
        event.reasonCode,
        event.at,
      );
    case "loop-error":
    case "loop-progress":
      return deriveState({ ...state, lastLoopAt: event.at });
    case "shutdown-started": {
      const components = Object.fromEntries(
        Object.entries(state.components).map(([name, component]) => [
          name,
          {
            ...component,
            canAcceptWork: false,
            observedAt: event.at,
            reasonCode: "shutdown_requested",
            state: "stopping",
          },
        ]),
      ) as Record<WorkerComponent, WorkerComponentState>;
      return {
        ...state,
        acceptingJobs: false,
        components,
        lastLoopAt: event.at,
        phase: "stopping",
      };
    }
  }
}

export function evaluateLiveness(
  state: WorkerHealthState,
  _now: number,
  _staleAfterMs: number,
): ProbeResult {
  return { body: { ...healthSnapshot(state), status: "ok" }, status: 200 };
}

export function evaluateReadiness(state: WorkerHealthState): ProbeResult {
  const snapshot = healthSnapshot(state);
  if (state.phase === "ready" && snapshot.canAcceptWork) {
    return { body: { ...snapshot, status: "ready" }, status: 200 };
  }
  return {
    body: {
      ...snapshot,
      status: state.phase === "ready" ? "degraded" : state.phase,
    },
    status: 503,
  };
}

export function decideJobAcceptance(
  state: WorkerHealthState,
  job: QueueJob,
): JobAcceptanceDecision {
  if (!state.acceptingJobs || state.phase === "stopping") {
    return deferred("worker_stopping");
  }
  for (const component of ["warp", "mihomo"] as const) {
    const dependency = state.components[component];
    if (dependency.required && dependency.state !== "ready") {
      return deferred(`${component}_unready`);
    }
  }
  if (jobRequiresBrowser(job) && state.components.browser.state !== "ready") {
    return deferred("browser_unready");
  }
  return { action: "accept" };
}

export function healthSnapshot(state: WorkerHealthState): WorkerHealthSnapshot {
  return {
    canAcceptWork:
      state.acceptingJobs &&
      Object.values(state.components).every(
        (component) => !component.required || component.canAcceptWork,
      ),
    components: Object.fromEntries(
      Object.entries(state.components).map(([name, component]) => [
        name,
        {
          canAcceptWork: component.canAcceptWork,
          observedAt: new Date(component.observedAt).toISOString(),
          reasonCode: component.reasonCode,
          state: component.state,
        },
      ]),
    ) as WorkerHealthSnapshot["components"],
    phase: state.phase,
  };
}

function startingComponent(observedAt: number, required: boolean): WorkerComponentState {
  return required
    ? {
        canAcceptWork: false,
        observedAt,
        reasonCode: "startup_pending",
        required,
        state: "starting",
      }
    : {
        canAcceptWork: true,
        observedAt,
        reasonCode: "not_configured",
        required,
        state: "ready",
      };
}

function updateComponent(
  state: WorkerHealthState,
  component: WorkerComponent,
  phase: WorkerComponentPhase,
  reasonCode: string,
  observedAt: number,
): WorkerHealthState {
  const components = {
    ...state.components,
    [component]: {
      ...state.components[component],
      canAcceptWork: phase === "ready",
      observedAt,
      reasonCode,
      state: phase,
    },
  };
  return deriveState({
    ...state,
    browserReady: components.browser.state === "ready",
    components,
    lastLoopAt: observedAt,
  });
}

function deriveState(state: WorkerHealthState): WorkerHealthState {
  if (!state.acceptingJobs || state.phase === "stopping") {
    return { ...state, phase: "stopping" };
  }
  const required = Object.values(state.components).filter(({ required }) => required);
  const phase = required.some(({ state: componentState }) => componentState === "failed")
    ? "failed"
    : required.some(({ state: componentState }) => componentState === "degraded")
      ? "degraded"
      : required.some(({ state: componentState }) => componentState !== "ready")
        ? "starting"
        : "ready";
  return { ...state, phase };
}

function jobRequiresBrowser(job: QueueJob): boolean {
  return job.kind === "collect-source" || job.payload.itemKind === "article";
}

function deferred(
  reasonCode: Exclude<JobAcceptanceDecision, { action: "accept" }>["reasonCode"],
): JobAcceptanceDecision {
  return { action: "defer", reasonCode, retryAfterSeconds: 30 };
}
