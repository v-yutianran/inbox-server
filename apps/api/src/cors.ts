const PAGES_HOST = "inbox-server-console.pages.dev";

export function isAllowedConsoleOrigin(origin: string, configuredOrigins?: string): boolean {
  const normalizedOrigin = normalizeOrigin(origin);
  if (!normalizedOrigin) return false;

  const host = new URL(normalizedOrigin).hostname;
  if (host === PAGES_HOST || host.endsWith(`.${PAGES_HOST}`)) return true;

  return configuredOrigins
    ?.split(",")
    .map(normalizeOrigin)
    .some((configured) => configured === normalizedOrigin) ?? false;
}

function normalizeOrigin(value: string): string | undefined {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "https:" || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      return undefined;
    }
    return parsed.origin;
  } catch {
    return undefined;
  }
}
