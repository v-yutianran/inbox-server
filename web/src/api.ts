import type { OperationsOverview, SyncResponse } from "./types";

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

async function request<T>(path: string, apiKey: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
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

export function triggerSync(apiKey: string): Promise<SyncResponse> {
  return request<SyncResponse>("/sync", apiKey, { method: "POST" });
}
