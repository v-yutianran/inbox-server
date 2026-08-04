import { createInterface } from "node:readline";
import { connect, type TLSSocket } from "node:tls";

import type { SourceName } from "@inbox/domain";

import type { Channels } from "./channels.js";
import { readOptionalString } from "./channels.js";

const TELEGRAM_API = "https://api.telegram.org";

export interface CollectionNotification {
  readonly collected: number;
  readonly published: number;
  readonly source: SourceName;
}

export interface SmtpMailOptions {
  readonly body: string;
  readonly from: string;
  readonly host: string;
  readonly password: string;
  readonly port: number;
  readonly recipient: string;
  readonly subject: string;
  readonly user: string;
}

type SendMail = (options: SmtpMailOptions) => Promise<void>;
type Warn = (event: string, message: string) => void;

export function formatCollectionNotification(summary: CollectionNotification): string {
  return `[收件箱同步] ${summary.source}：收集 ${summary.collected} 条，已入队 ${summary.published} 条`;
}

export function createNotifier(options: {
  readonly channels: Channels;
  readonly fetcher?: typeof fetch;
  readonly sendMail?: SendMail;
  readonly warn?: Warn;
}): (summary: CollectionNotification) => Promise<void> {
  const fetcher = options.fetcher ?? fetch;
  const sendMail = options.sendMail ?? sendSmtpMail;
  const warn = options.warn ?? defaultWarn;
  const notification = options.channels.notification;
  const telegram = options.channels.sources.telegram?.config ?? {};

  return async (summary) => {
    const message = formatCollectionNotification(summary);
    const tasks: Promise<void>[] = [];
    const chatId = readOptionalString(notification, "telegram_chat_id");
    const token =
      readOptionalString(notification, "notify_token") ??
      readOptionalString(telegram, "bot_token");
    if (chatId && token) {
      tasks.push(
        notifyTelegram(fetcher, token, chatId, message).catch((error: unknown) => {
          warn("telegram_notification_failed", safeErrorMessage(error));
        }),
      );
    }

    const user = readOptionalString(notification, "smtp_user");
    const password = readOptionalString(notification, "smtp_pass");
    const recipient = readOptionalString(notification, "email_to");
    if (user && password && recipient) {
      tasks.push(
        sendMail({
          body: message,
          from: readOptionalString(notification, "email_from") ?? user,
          host: readOptionalString(notification, "smtp_host") ?? "smtp.163.com",
          password,
          port: readPositiveInteger(notification.smtp_port) ?? 465,
          recipient,
          subject: "[收件箱同步]",
          user,
        }).catch((error: unknown) => {
          warn("email_notification_failed", safeErrorMessage(error));
        }),
      );
    }

    await Promise.all(tasks);
  };
}

async function notifyTelegram(
  fetcher: typeof fetch,
  token: string,
  chatId: string,
  message: string,
): Promise<void> {
  const response = await fetcher(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    body: JSON.stringify({ chat_id: chatId, text: message }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!response.ok) throw new Error(`Telegram notification failed: ${response.status}`);
}

export async function sendSmtpMail(options: SmtpMailOptions): Promise<void> {
  assertHeader(options.from, "from");
  assertHeader(options.recipient, "recipient");
  const socket = await connectTls(options.host, options.port);
  const lines = createInterface({ crlfDelay: Number.POSITIVE_INFINITY, input: socket });
  const replies = lines[Symbol.asyncIterator]();
  try {
    await expectReply(replies, [220]);
    await command(socket, replies, `EHLO inbox-server`, [250]);
    await command(socket, replies, "AUTH LOGIN", [334]);
    await command(socket, replies, Buffer.from(options.user).toString("base64"), [334]);
    await command(socket, replies, Buffer.from(options.password).toString("base64"), [235]);
    await command(socket, replies, `MAIL FROM:<${options.from}>`, [250]);
    await command(socket, replies, `RCPT TO:<${options.recipient}>`, [250, 251]);
    await command(socket, replies, "DATA", [354]);
    await write(socket, `${buildMimeMessage(options)}\r\n.\r\n`);
    await expectReply(replies, [250]);
    await command(socket, replies, "QUIT", [221]);
  } finally {
    lines.close();
    socket.destroy();
  }
}

async function connectTls(host: string, port: number): Promise<TLSSocket> {
  const socket = connect({ host, port, rejectUnauthorized: true, servername: host });
  socket.setTimeout(30_000, () => socket.destroy(new Error("SMTP timeout")));
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    socket.once("error", onError);
    socket.once("secureConnect", () => {
      socket.off("error", onError);
      resolve(socket);
    });
  });
}

async function command(
  socket: TLSSocket,
  replies: AsyncIterator<string>,
  value: string,
  expectedCodes: readonly number[],
): Promise<void> {
  await write(socket, `${value}\r\n`);
  await expectReply(replies, expectedCodes);
}

async function write(socket: TLSSocket, value: string): Promise<void> {
  if (socket.write(value)) return;
  await new Promise<void>((resolve, reject) => {
    socket.once("drain", resolve);
    socket.once("error", reject);
  });
}

async function expectReply(
  replies: AsyncIterator<string>,
  expectedCodes: readonly number[],
): Promise<void> {
  while (true) {
    const reply = await replies.next();
    if (reply.done) throw new Error("SMTP connection closed before response");
    const match = /^(\d{3})([ -])/.exec(reply.value);
    if (!match || match[2] === "-") continue;
    const code = Number(match[1]);
    if (!expectedCodes.includes(code)) throw new Error(`SMTP command failed: ${code}`);
    return;
  }
}

function buildMimeMessage(options: SmtpMailOptions): string {
  const subject = Buffer.from(options.subject).toString("base64");
  const body = wrapBase64(Buffer.from(options.body).toString("base64"));
  return [
    `From: ${options.from}`,
    `To: ${options.recipient}`,
    `Subject: =?UTF-8?B?${subject}?=`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    body,
  ].join("\r\n");
}

function wrapBase64(value: string): string {
  return value.match(/.{1,76}/g)?.join("\r\n") ?? "";
}

function assertHeader(value: string, name: string): void {
  if (!/^\S+@\S+$/.test(value) || /[\r\n]/.test(value)) {
    throw new Error(`invalid SMTP ${name}`);
  }
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown error";
  return message.replace(/bot[A-Za-z0-9:_-]+/g, "bot[redacted]").slice(0, 300);
}

function defaultWarn(event: string, message: string): void {
  console.warn(JSON.stringify({ event, message, timestamp: new Date().toISOString() }));
}
