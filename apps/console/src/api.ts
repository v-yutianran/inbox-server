import type {
  HealthComponentsReport,
  OperationsMetricsReport,
  OperationsOverview,
  OperationsReadiness,
  QueueReadinessSummary,
  SyncResponse,
} from "./types";

export const API_KEY_STORAGE = "inbox-admin-api-key:v1";

export function readApiKey(): string {
  try {
    return sessionStorage.getItem(API_KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}

export function writeApiKey(apiKey: string): void {
  try {
    sessionStorage.setItem(API_KEY_STORAGE, apiKey);
  } catch {
    // 禁用存储时仍允许当前 React 状态维持本次连接。
  }
}

export function clearApiKey(): void {
  try {
    sessionStorage.removeItem(API_KEY_STORAGE);
  } catch {
    // 清理失败时 React 状态仍会立即锁定控制台。
  }
}

export class ApiError extends Error {
  constructor(public readonly status: number) {
    super(status === 401 ? "API Key 无效或已失效" : `请求失败（${status}）`);
  }
}

export function createApiUrl(path: string, configuredBase = import.meta.env.VITE_INBOX_API_URL): string {
  const base = configuredBase?.trim();
  if (!base) return path;

  const parsed = new URL(base);
  if (parsed.protocol !== "https:") {
    throw new Error("Cloudflare API 基址必须使用 HTTPS");
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("Cloudflare API 基址不能包含路径、查询参数或片段");
  }

  return `${parsed.origin}${path.startsWith("/") ? path : `/${path}`}`;
}

async function request<T>(path: string, apiKey: string, init?: RequestInit): Promise<T> {
  const response = await fetch(createApiUrl(path), {
    ...init,
    headers: {
      "X-API-Key": apiKey,
      ...init?.headers,
    },
  });
  if (!response.ok) {
    throw new ApiError(response.status);
  }
  return (await response.json()) as T;
}

export function fetchOverview(apiKey: string): Promise<OperationsOverview> {
  return request<OperationsOverview>("/api/operations/overview", apiKey);
}

export async function fetchOperationsReadiness(apiKey: string): Promise<OperationsReadiness> {
  const [health, queue, metrics] = await Promise.all([
    request<HealthComponentsReport>("/api/operations/health/components", apiKey),
    request<QueueReadinessSummary>("/api/operations/queue/summary", apiKey),
    request<OperationsMetricsReport>("/api/operations/metrics?windowHours=24", apiKey),
  ]);
  return { health, metrics, queue };
}

export function triggerSync(apiKey: string): Promise<SyncResponse> {
  return request<SyncResponse>("/sync", apiKey, { method: "POST" });
}
