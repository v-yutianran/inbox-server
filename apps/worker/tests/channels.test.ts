import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadChannels, safeChannelSummary } from "../src/channels";

describe("channels config", () => {
  it("从环境变量插值且安全摘要不暴露凭据", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inbox-channels-"));
    const path = join(directory, "channels.yaml");
    await writeFile(
      path,
      `
sources:
  telegram:
    enabled: true
    config: {bot_token: "\${TELEGRAM_BOT_TOKEN}"}
  zhihu:
    enabled: true
    kind: BROWSER
    config: {collection_id: "100", credential_name: "zhihu_creds"}
destinations:
  cubox:
    enabled: true
    item_kind: link
    config: {api_url: "\${CUBOX_API_URL}"}
article_archive:
  enabled: true
  repository_dir: /data/archive/repository
  articles_dir: references/article
credentials: {}
`,
    );

    const channels = await loadChannels(path, {
      CUBOX_API_URL: "https://cubox.example/secret",
      TELEGRAM_BOT_TOKEN: "telegram-secret",
    });
    const summary = safeChannelSummary(channels);

    expect(channels.sources.telegram?.config.bot_token).toBe("telegram-secret");
    expect(summary.sources.zhihu).toEqual({
      credential_name: "zhihu_creds",
      enabled: true,
      kind: "BROWSER",
    });
    expect(JSON.stringify(summary)).not.toContain("telegram-secret");
    expect(JSON.stringify(summary)).not.toContain("cubox.example");
  });

  it("缺少被引用的环境变量时启动失败", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inbox-channels-"));
    const path = join(directory, "channels.yaml");
    await writeFile(
      path,
      "sources:\n  telegram:\n    enabled: true\n    config: {bot_token: \"${MISSING}\"}\n",
    );

    await expect(loadChannels(path, {})).rejects.toThrow("MISSING");
  });
});
