import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { dirname } from "node:path";

export const browserPlatforms = ["zhihu", "bilibili", "inoreader", "youtube", "x"] as const;
export type BrowserPlatform = (typeof browserPlatforms)[number];

export interface Settings {
  archiveEnabled: boolean;
  archiveGit: boolean;
  schedulerEnabled: boolean;
  intervalSeconds: number;
  sources: {
    dida: { enabled: boolean; accessToken: string };
    github_stars: { enabled: boolean; token: string };
    telegram: { enabled: boolean; botToken: string };
    zhihu: { enabled: boolean; collectionId: string };
    bilibili: { enabled: boolean; mediaId: string };
    bilibili_toview: { enabled: boolean };
    inoreader: { enabled: boolean };
    youtube: { enabled: boolean };
    x_bookmarks: { enabled: boolean };
    x_likes: { enabled: boolean; username: string };
  };
  forward: { cuboxUrl: string; flomoWebhook: string };
  jianguoyun: { enabled: boolean; user: string; password: string; baseUrl: string };
  notification: {
    telegramChatId: string;
    notifyToken: string;
    emailEnabled: boolean;
    smtpHost: string;
    smtpPort: number;
    smtpUser: string;
    smtpPass: string;
    emailFrom: string;
    emailTo: string;
  };
  ima: {
    enabled: boolean;
    apiKey: string;
    clientId: string;
    knowledgeBaseName: string;
    webCookie: string;
    webImaCookie: string;
    webBkn: string;
    webKnowledgeBaseId: string;
  };
  llm: { apiKey: string; model: string };
}

export interface PublicSettings {
  archiveEnabled: boolean;
  archiveGit: boolean;
  schedulerEnabled: boolean;
  intervalSeconds: number;
  sources: {
    dida: { enabled: boolean; accessTokenSet: boolean };
    github_stars: { enabled: boolean; tokenSet: boolean };
    telegram: { enabled: boolean; botTokenSet: boolean };
    zhihu: { enabled: boolean; collectionId: string };
    bilibili: { enabled: boolean; mediaId: string };
    bilibili_toview: { enabled: boolean };
    inoreader: { enabled: boolean };
    youtube: { enabled: boolean };
    x_bookmarks: { enabled: boolean };
    x_likes: { enabled: boolean; username: string };
  };
  forward: { cuboxUrlSet: boolean; flomoWebhookSet: boolean };
  jianguoyun: { enabled: boolean; userSet: boolean; passwordSet: boolean; baseUrl: string };
  notification: {
    telegramChatId: string;
    notifyTokenSet: boolean;
    emailEnabled: boolean;
    smtpHost: string;
    smtpPort: number;
    smtpUserSet: boolean;
    smtpPassSet: boolean;
    emailFrom: string;
    emailTo: string;
  };
  ima: {
    enabled: boolean;
    apiKeySet: boolean;
    clientIdSet: boolean;
    knowledgeBaseName: string;
    webCookieSet: boolean;
    webImaCookieSet: boolean;
    webBknSet: boolean;
    webKnowledgeBaseId: string;
  };
  llm: { apiKeySet: boolean; model: string };
}

export const DEFAULT_SETTINGS: Settings = {
  archiveEnabled: true,
  archiveGit: true,
  schedulerEnabled: true,
  intervalSeconds: 300,
  sources: {
    dida: { enabled: false, accessToken: "" },
    github_stars: { enabled: false, token: "" },
    telegram: { enabled: false, botToken: "" },
    zhihu: { enabled: false, collectionId: "" },
    bilibili: { enabled: false, mediaId: "" },
    bilibili_toview: { enabled: false },
    inoreader: { enabled: false },
    youtube: { enabled: false },
    x_bookmarks: { enabled: false },
    x_likes: { enabled: false, username: "" },
  },
  forward: { cuboxUrl: "", flomoWebhook: "" },
  jianguoyun: { enabled: false, user: "", password: "", baseUrl: "https://dav.jianguoyun.com/dav" },
  notification: {
    telegramChatId: "",
    notifyToken: "",
    emailEnabled: false,
    smtpHost: "smtp.163.com",
    smtpPort: 465,
    smtpUser: "",
    smtpPass: "",
    emailFrom: "",
    emailTo: "",
  },
  ima: {
    enabled: false,
    apiKey: "",
    clientId: "",
    knowledgeBaseName: "",
    webCookie: "",
    webImaCookie: "",
    webBkn: "",
    webKnowledgeBaseId: "",
  },
  llm: { apiKey: "", model: "glm-4-flash" },
};

export function mergeSettings(input: Partial<Settings> | null | undefined): Settings {
  const base = structuredClone(DEFAULT_SETTINGS);
  if (!input || typeof input !== "object") return base;
  const record = input as Partial<Settings>;
  if (typeof record.archiveEnabled === "boolean") base.archiveEnabled = record.archiveEnabled;
  if (typeof record.archiveGit === "boolean") base.archiveGit = record.archiveGit;
  if (typeof record.schedulerEnabled === "boolean") base.schedulerEnabled = record.schedulerEnabled;
  if (typeof record.intervalSeconds === "number" && record.intervalSeconds >= 30 && record.intervalSeconds <= 86_400) {
    base.intervalSeconds = Math.floor(record.intervalSeconds);
  }
  copyBoolString(base.sources.dida, record.sources?.dida, ["enabled"], ["accessToken"]);
  copyBoolString(base.sources.github_stars, record.sources?.github_stars, ["enabled"], ["token"]);
  copyBoolString(base.sources.telegram, record.sources?.telegram, ["enabled"], ["botToken"]);
  copyBoolString(base.sources.zhihu, record.sources?.zhihu, ["enabled"], ["collectionId"]);
  copyBoolString(base.sources.bilibili, record.sources?.bilibili, ["enabled"], ["mediaId"]);
  copyBoolString(base.sources.bilibili_toview, record.sources?.bilibili_toview, ["enabled"], []);
  copyBoolString(base.sources.inoreader, record.sources?.inoreader, ["enabled"], []);
  copyBoolString(base.sources.youtube, record.sources?.youtube, ["enabled"], []);
  copyBoolString(base.sources.x_bookmarks, record.sources?.x_bookmarks, ["enabled"], []);
  copyBoolString(base.sources.x_likes, record.sources?.x_likes, ["enabled"], ["username"]);
  copyBoolString(base.forward, record.forward, [], ["cuboxUrl", "flomoWebhook"]);
  copyBoolString(base.jianguoyun, record.jianguoyun, ["enabled"], ["user", "password", "baseUrl"]);
  copyBoolString(base.notification, record.notification, ["emailEnabled"], ["telegramChatId", "notifyToken", "smtpHost", "smtpUser", "smtpPass", "emailFrom", "emailTo"]);
  if (typeof record.notification?.smtpPort === "number" && record.notification.smtpPort > 0) {
    base.notification.smtpPort = Math.floor(record.notification.smtpPort);
  }
  copyBoolString(base.ima, record.ima, ["enabled"], ["apiKey", "clientId", "knowledgeBaseName", "webCookie", "webImaCookie", "webBkn", "webKnowledgeBaseId"]);
  copyBoolString(base.llm, record.llm, [], ["apiKey", "model"]);
  return base;
}

export function toPublicSettings(settings: Settings): PublicSettings {
  return {
    archiveEnabled: settings.archiveEnabled,
    archiveGit: settings.archiveGit,
    schedulerEnabled: settings.schedulerEnabled,
    intervalSeconds: settings.intervalSeconds,
    sources: {
      dida: { enabled: settings.sources.dida.enabled, accessTokenSet: filled(settings.sources.dida.accessToken) },
      github_stars: { enabled: settings.sources.github_stars.enabled, tokenSet: filled(settings.sources.github_stars.token) },
      telegram: { enabled: settings.sources.telegram.enabled, botTokenSet: filled(settings.sources.telegram.botToken) },
      zhihu: { enabled: settings.sources.zhihu.enabled, collectionId: settings.sources.zhihu.collectionId },
      bilibili: { enabled: settings.sources.bilibili.enabled, mediaId: settings.sources.bilibili.mediaId },
      bilibili_toview: { enabled: settings.sources.bilibili_toview.enabled },
      inoreader: { enabled: settings.sources.inoreader.enabled },
      youtube: { enabled: settings.sources.youtube.enabled },
      x_bookmarks: { enabled: settings.sources.x_bookmarks.enabled },
      x_likes: { enabled: settings.sources.x_likes.enabled, username: settings.sources.x_likes.username },
    },
    forward: {
      cuboxUrlSet: filled(settings.forward.cuboxUrl),
      flomoWebhookSet: filled(settings.forward.flomoWebhook),
    },
    jianguoyun: {
      enabled: settings.jianguoyun.enabled,
      userSet: filled(settings.jianguoyun.user),
      passwordSet: filled(settings.jianguoyun.password),
      baseUrl: settings.jianguoyun.baseUrl,
    },
    notification: {
      telegramChatId: settings.notification.telegramChatId,
      notifyTokenSet: filled(settings.notification.notifyToken),
      emailEnabled: settings.notification.emailEnabled,
      smtpHost: settings.notification.smtpHost,
      smtpPort: settings.notification.smtpPort,
      smtpUserSet: filled(settings.notification.smtpUser),
      smtpPassSet: filled(settings.notification.smtpPass),
      emailFrom: settings.notification.emailFrom,
      emailTo: settings.notification.emailTo,
    },
    ima: {
      enabled: settings.ima.enabled,
      apiKeySet: filled(settings.ima.apiKey),
      clientIdSet: filled(settings.ima.clientId),
      knowledgeBaseName: settings.ima.knowledgeBaseName,
      webCookieSet: filled(settings.ima.webCookie),
      webImaCookieSet: filled(settings.ima.webImaCookie),
      webBknSet: filled(settings.ima.webBkn),
      webKnowledgeBaseId: settings.ima.webKnowledgeBaseId,
    },
    llm: { apiKeySet: filled(settings.llm.apiKey), model: settings.llm.model },
  };
}

/** 空字符串表示保留原密钥；null 表示清除。 */
export function overlaySettings(current: Settings, patch: unknown): Settings {
  if (!isRecord(patch)) throw new Error("设置格式无效");
  const merged = mergeSettings(current);
  const next = mergeSettings({ ...merged, ...patch, sources: merged.sources, forward: merged.forward, jianguoyun: merged.jianguoyun, notification: merged.notification, ima: merged.ima, llm: merged.llm });
  if (typeof patch.archiveEnabled === "boolean") next.archiveEnabled = patch.archiveEnabled;
  if (typeof patch.archiveGit === "boolean") next.archiveGit = patch.archiveGit;
  if (typeof patch.schedulerEnabled === "boolean") next.schedulerEnabled = patch.schedulerEnabled;
  if (typeof patch.intervalSeconds === "number" && patch.intervalSeconds >= 30 && patch.intervalSeconds <= 86_400) {
    next.intervalSeconds = Math.floor(patch.intervalSeconds);
  }
  overlayGroup(next.sources, patch.sources);
  overlayGroup(next.forward, patch.forward);
  overlayGroup(next.jianguoyun, patch.jianguoyun);
  overlayGroup(next.notification, patch.notification);
  overlayGroup(next.ima, patch.ima);
  overlayGroup(next.llm, patch.llm);
  if (next.forward.cuboxUrl && !isHttp(next.forward.cuboxUrl)) throw new Error("Cubox 地址必须是 http(s) URL");
  if (next.forward.flomoWebhook && !isHttp(next.forward.flomoWebhook)) throw new Error("flomo 地址必须是 http(s) URL");
  if (next.jianguoyun.baseUrl && !isHttp(next.jianguoyun.baseUrl)) throw new Error("坚果云地址必须是 http(s) URL");
  return next;
}

export function settingsPath(databaseFile: string): string {
  return `${dirname(databaseFile)}/settings.json`;
}

export function readSettingsFile(databaseFile: string): Settings | null {
  const path = settingsPath(databaseFile);
  if (databaseFile === ":memory:" || !existsSync(path)) return null;
  return mergeSettings(JSON.parse(readFileSync(path, "utf8")) as Partial<Settings>);
}

export function writeSettingsFile(databaseFile: string, settings: Settings): void {
  if (databaseFile === ":memory:") return;
  const path = settingsPath(databaseFile);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

function overlayGroup(target: object, patch: unknown): void {
  if (!isRecord(patch)) return;
  for (const [key, value] of Object.entries(patch)) {
    const current = (target as Record<string, unknown>)[key];
    if (isRecord(current) && isRecord(value)) {
      overlayGroup(current, value);
      continue;
    }
    if (!(key in (target as Record<string, unknown>))) continue;
    if (value === null) {
      (target as Record<string, unknown>)[key] = typeof current === "boolean" ? false : typeof current === "number" ? current : "";
      continue;
    }
    if (typeof current === "boolean" && typeof value === "boolean") (target as Record<string, unknown>)[key] = value;
    else if (typeof current === "number" && typeof value === "number") (target as Record<string, unknown>)[key] = value;
    else if (typeof current === "string" && typeof value === "string" && value.length > 0) (target as Record<string, unknown>)[key] = value;
  }
}

function copyBoolString(target: object, source: object | undefined, bools: string[], strings: string[]): void {
  if (!source) return;
  const record = source as Record<string, unknown>;
  const dest = target as Record<string, unknown>;
  for (const key of bools) if (typeof record[key] === "boolean") dest[key] = record[key];
  for (const key of strings) if (typeof record[key] === "string") dest[key] = record[key];
}

function filled(value: string): boolean {
  return value.length > 0;
}

function isHttp(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
