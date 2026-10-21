export interface ZhihuArticleRequest {
  apiPath: string;
  contentField: "content" | "content_html";
  origin: string;
  titleField: "excerpt_title" | "question" | "title";
}

export function resolveZhihuArticleRequest(url: string): ZhihuArticleRequest | null {
  const parsed = new URL(url);
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (parsed.hostname === "www.zhihu.com" && segments.length >= 4 && segments[0] === "question" && segments[2] === "answer" && segments[3]) {
    return {
      apiPath: `/api/v4/answers/${segments[3]}?include=content,excerpt,question,author,created_time`,
      contentField: "content",
      origin: "https://www.zhihu.com",
      titleField: "question",
    };
  }
  if (parsed.hostname === "zhuanlan.zhihu.com" && segments[0] === "p" && segments[1]) {
    return {
      apiPath: `/api/articles/${segments[1]}`,
      contentField: "content",
      origin: "https://zhuanlan.zhihu.com",
      titleField: "title",
    };
  }
  const pinId = parsed.hostname === "www.zhihu.com" && segments[0] === "pin"
    ? segments[1]
    : parsed.hostname === "www.zhihu.com" && segments[0] === "video" && segments[1] === "immersion" && segments[2] === "feed"
      ? segments[3]
      : undefined;
  return pinId
    ? {
        apiPath: `/api/v4/pins/${pinId}`,
        contentField: "content_html",
        origin: "https://www.zhihu.com",
        titleField: "excerpt_title",
      }
    : null;
}

export function buildZhihuDocument(payload: unknown, request: ZhihuArticleRequest): string {
  if (!isRecord(payload)) throw new Error("zhihu_invalid_response");
  const content = payload[request.contentField];
  if (typeof content !== "string" || content.trim().length === 0) throw new Error("zhihu_empty_content");
  const question = payload.question;
  const titleValue = request.titleField === "question" && isRecord(question) ? question.title : payload[request.titleField];
  const title = String(titleValue ?? "").split(" | ", 1)[0]?.trim() ?? "";
  return `<!doctype html><html><head><title>${escapeHtml(title)}</title></head><body><article>${content}</article></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
