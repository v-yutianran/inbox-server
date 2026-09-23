import { describe, expect, it, vi } from "vitest";

import type { Channels } from "../src/channels";
import { createNotifier, formatCollectionNotification } from "../src/notifications";

const channels = {
  notification: {
    email_from: "sender@example.com",
    email_to: "recipient@example.com",
    notify_token: "telegram-token",
    smtp_host: "smtp.example.com",
    smtp_pass: "smtp-pass",
    smtp_port: 465,
    smtp_user: "sender@example.com",
    telegram_chat_id: "12345",
  },
  sources: { telegram: { config: {}, enabled: true, kind: "api" } },
} as unknown as Channels;

describe("notifications", () => {
  it("生成不含凭据的收集摘要", () => {
    expect(
      formatCollectionNotification({ collected: 3, published: 2, source: "telegram" }),
    ).toBe("[收件箱同步] telegram：收集 3 条，已入队 2 条");
  });

  it("并行调用 Telegram 与 SMTP，任一失败均不阻塞主流程", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const sendMail = vi.fn().mockRejectedValue(new Error("smtp unavailable"));
    const warn = vi.fn();
    const notify = createNotifier({
      channels,
      emailNotificationsEnabled: true,
      fetcher,
      sendMail,
      warn,
    });

    await expect(
      notify({ collected: 3, published: 2, source: "telegram" }),
    ).resolves.toBeUndefined();

    expect(fetcher).toHaveBeenCalledWith(
      "https://api.telegram.org/bottelegram-token/sendMessage",
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: "12345",
          text: "[收件箱同步] telegram：收集 3 条，已入队 2 条",
        }),
      }),
    );
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "[收件箱同步] telegram：收集 3 条，已入队 2 条",
        host: "smtp.example.com",
        password: "smtp-pass",
        port: 465,
        recipient: "recipient@example.com",
      }),
    );
    expect(warn).toHaveBeenCalledWith("email_notification_failed", "smtp unavailable");
  });

  it("邮件关闭时只发送 Telegram", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const sendMail = vi.fn().mockResolvedValue(undefined);
    const notify = createNotifier({
      channels,
      emailNotificationsEnabled: false,
      fetcher,
      sendMail,
      warn: vi.fn(),
    });

    await notify({ collected: 3, published: 2, source: "telegram" });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("邮件关闭且 Telegram 失败时只记录告警，不回退 SMTP", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("telegram unavailable"));
    const sendMail = vi.fn().mockResolvedValue(undefined);
    const warn = vi.fn();
    const notify = createNotifier({
      channels,
      emailNotificationsEnabled: false,
      fetcher,
      sendMail,
      warn,
    });

    await expect(
      notify({ collected: 3, published: 2, source: "telegram" }),
    ).resolves.toBeUndefined();

    expect(fetcher).toHaveBeenCalledOnce();
    expect(sendMail).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("telegram_notification_failed", "telegram unavailable");
  });
});
