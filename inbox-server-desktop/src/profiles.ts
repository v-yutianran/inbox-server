import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { browserPlatforms, type BrowserPlatform } from "./settings.ts";

export interface StorageCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

export interface StorageState {
  cookies: StorageCookie[];
  origins: unknown[];
}

export const LOGIN_URLS: Record<BrowserPlatform, string> = {
  bilibili: "https://passport.bilibili.com/login",
  inoreader: "https://www.inoreader.com/login",
  x: "https://x.com/i/flow/login",
  youtube: "https://accounts.google.com/ServiceLogin?service=youtube",
  zhihu: "https://www.zhihu.com/signin",
};

export function isBrowserPlatform(value: string): value is BrowserPlatform {
  return (browserPlatforms as readonly string[]).includes(value);
}

export function profileFile(dataDir: string, platform: string): string {
  return join(dataDir, "profiles", `${platform}.json`);
}

export function readProfile(path: string): StorageState | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRecord(parsed)) return null;
  return {
    cookies: Array.isArray(parsed.cookies) ? parsed.cookies.filter(isCookie) : [],
    origins: Array.isArray(parsed.origins) ? parsed.origins : [],
  };
}

export function writeProfile(path: string, state: StorageState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

export function cookieHeader(state: StorageState, domainIncludes: string): string {
  return state.cookies
    .filter((item) => item.domain.includes(domainIncludes) && item.name && item.value)
    .map((item) => `${item.name}=${item.value}`)
    .join("; ");
}

export function platformForSource(source: string): BrowserPlatform {
  if (source.startsWith("bilibili")) return "bilibili";
  if (source.startsWith("x_")) return "x";
  if (source === "zhihu" || source === "inoreader" || source === "youtube") return source;
  throw new Error(`unsupported browser source: ${source}`);
}

export function credentialToStorageState(platform: string, input: unknown): StorageState {
  if (!isRecord(input)) throw new Error("登录凭据格式无效");
  const nested = isRecord(input.storageState) ? input.storageState : isRecord(input.storage_state) ? input.storage_state : null;
  if (nested && (Array.isArray(nested.cookies) || Array.isArray(nested.origins))) {
    return {
      cookies: Array.isArray(nested.cookies) ? nested.cookies.filter(isCookie) : [],
      origins: Array.isArray(nested.origins) ? nested.origins : [],
    };
  }
  if (platform === "zhihu" && typeof input.z_c0 === "string" && input.z_c0.length > 0) {
    return { cookies: [cookie(".zhihu.com", "z_c0", input.z_c0)], origins: [] };
  }
  if (platform === "bilibili" && typeof input.sessdata === "string" && input.sessdata.length > 0) {
    return { cookies: [cookie(".bilibili.com", "SESSDATA", input.sessdata)], origins: [] };
  }
  throw new Error(`无法识别 ${platform} 的登录凭据`);
}

export function electronCookiesToStorageState(cookies: readonly {
  domain?: string;
  expirationDate?: number;
  httpOnly?: boolean;
  name: string;
  path?: string;
  sameSite?: string;
  secure?: boolean;
  value: string;
}[]): StorageState {
  return {
    cookies: cookies.filter((item) => item.name && item.domain).map((item) => ({
      domain: item.domain ?? "",
      expires: typeof item.expirationDate === "number" ? item.expirationDate : -1,
      httpOnly: item.httpOnly === true,
      name: item.name,
      path: item.path || "/",
      sameSite: item.sameSite === "strict" ? "Strict" : item.sameSite === "no_restriction" ? "None" : "Lax",
      secure: item.secure === true,
      value: item.value,
    })),
    origins: [],
  };
}

function cookie(domain: string, name: string, value: string): StorageCookie {
  return { domain, expires: -1, httpOnly: true, name, path: "/", sameSite: "Lax", secure: true, value };
}

function isCookie(value: unknown): value is StorageCookie {
  return isRecord(value) && typeof value.name === "string" && typeof value.value === "string" && typeof value.domain === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
