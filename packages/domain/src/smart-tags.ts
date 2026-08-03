const MAX_CONTENT_CHARACTERS = 1_500;
const MAX_TAGS = 3;
const TAG_NOISE = /[\s#。，,、！!?？:：;；（）()【】\[\]"'“”‘’`]+/gu;

export function buildSmartTagPrompt(content: string): string {
  const snippet = content.slice(0, MAX_CONTENT_CHARACTERS);
  return [
    "阅读以下内容，提取 3 个最能概括主题的中文标签。",
    "严格要求：每个标签 2-6 个汉字，标签内【不能有空格、不能有标点、不能有#号】，用英文逗号分隔，只输出 3 个标签本身，不要解释、不要编号。",
    "示例输出：读书笔记,时间管理,效率工具",
    "",
    `内容：${snippet}`,
  ].join("\n");
}

export function parseSmartTags(value: string | null | undefined): readonly string[] {
  if (!value) return [];
  return value
    .split(/[，,\n、]/u)
    .map((tag) => tag.replace(TAG_NOISE, "").trim())
    .filter((tag) => tag.length >= 2)
    .slice(0, MAX_TAGS);
}

export function formatFlomoContent(content: string, tags: readonly string[]): string {
  const prefix = tags.map((tag) => `#${tag}`).join(" ");
  return prefix ? `${prefix} ${content}` : content;
}
