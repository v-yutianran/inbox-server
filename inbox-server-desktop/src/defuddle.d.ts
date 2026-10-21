declare module "defuddle/node" {
  export function Defuddle(
    html: string,
    url?: string,
    options?: { markdown?: boolean },
  ): Promise<{
    author?: string;
    content?: string;
    contentMarkdown?: string;
    title?: string;
  }>;
}
