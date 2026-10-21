import { parseSmartTags } from "./domain.ts";

const GLM_ENDPOINT = "https://open.bigmodel.cn/api/paas/v4/chat/completions";

export function buildSmartTagPrompt(content: string): string {
  const snippet = content.slice(0, 1_500);
  return [
    "阅读以下内容，提取 3 个最能概括主题的中文标签。",
    "严格要求：每个标签 2-6 个汉字，标签内【不能有空格、不能有标点、不能有#号】，用英文逗号分隔，只输出 3 个标签本身，不要解释、不要编号。",
    "示例输出：读书笔记,时间管理,效率工具",
    "",
    `内容：${snippet}`,
  ].join("\n");
}

export async function generateSmartTags(options: {
  apiKey: string;
  content: string;
  fetcher?: typeof fetch;
  model?: string;
}): Promise<string[]> {
  if (!options.apiKey || !options.content) return [];
  const fetcher = options.fetcher ?? fetch;
  try {
    const response = await fetcher(GLM_ENDPOINT, {
      body: JSON.stringify({
        max_tokens: 60,
        messages: [{ content: buildSmartTagPrompt(options.content), role: "user" }],
        model: options.model || "glm-4-flash",
      }),
      headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
      method: "POST",
    });
    if (!response.ok) return [];
    return [...parseSmartTags(readContent(await response.json()))];
  } catch {
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
