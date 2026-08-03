import { buildSmartTagPrompt, parseSmartTags } from "@inbox/domain";

const GLM_ENDPOINT = "https://open.bigmodel.cn/api/paas/v4/chat/completions";

type Warn = (event: string, message: string) => void;

export async function generateSmartTags(options: {
  readonly apiKey: string;
  readonly content: string;
  readonly fetcher?: typeof fetch;
  readonly model?: string;
  readonly warn?: Warn;
}): Promise<readonly string[]> {
  if (!options.apiKey || !options.content) return [];
  const fetcher = options.fetcher ?? fetch;
  const warn = options.warn ?? defaultWarn;
  try {
    const response = await fetcher(GLM_ENDPOINT, {
      body: JSON.stringify({
        max_tokens: 60,
        messages: [{ content: buildSmartTagPrompt(options.content), role: "user" }],
        model: options.model ?? "glm-4-flash",
      }),
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    if (!response.ok) throw new Error(`GLM request failed: ${response.status}`);
    return parseSmartTags(readContent(await response.json()));
  } catch (error: unknown) {
    warn("smart_tags_failed", safeErrorMessage(error));
    return [];
  }
}

function readContent(value: unknown): string | undefined {
  if (!isRecord(value) || !Array.isArray(value.choices)) return undefined;
  const first = value.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) return undefined;
  return typeof first.message.content === "string" ? first.message.content : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : "unknown error").slice(0, 300);
}

function defaultWarn(event: string, message: string): void {
  console.warn(JSON.stringify({ event, message, timestamp: new Date().toISOString() }));
}
