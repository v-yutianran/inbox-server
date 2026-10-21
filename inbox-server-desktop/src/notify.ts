import { createInterface } from "node:readline";
import { connect, type ConnectionOptions, type TLSSocket } from "node:tls";

export interface CollectionNotification {
  collected: number;
  published: number;
  source: string;
}

export interface SmtpMailOptions {
  body: string;
  ca?: string;
  from: string;
  host: string;
  password: string;
  port: number;
  recipient: string;
  rejectUnauthorized?: boolean;
  subject: string;
  user: string;
}

export function formatCollectionNotification(summary: CollectionNotification): string {
  return `[收件箱同步] ${summary.source}：收集 ${summary.collected} 条，已入队 ${summary.published} 条`;
}

export async function notifyTelegram(fetcher: typeof fetch, token: string, chatId: string, message: string): Promise<void> {
  const response = await fetcher(`https://api.telegram.org/bot${token}/sendMessage`, {
    body: JSON.stringify({ chat_id: chatId, text: message }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!response.ok) throw new Error(`Telegram notification failed: ${response.status}`);
}

export async function sendSmtpMail(options: SmtpMailOptions): Promise<void> {
  if (!/^\S+@\S+$/.test(options.from) || /[\r\n]/.test(options.from)) throw new Error("invalid SMTP from");
  if (!/^\S+@\S+$/.test(options.recipient) || /[\r\n]/.test(options.recipient)) throw new Error("invalid SMTP recipient");
  const tlsOptions: ConnectionOptions = {
    host: options.host,
    port: options.port,
    rejectUnauthorized: options.rejectUnauthorized !== false,
    servername: options.host,
  };
  if (options.ca) tlsOptions.ca = options.ca;
  const socket = connect(tlsOptions);
  socket.setTimeout(30_000, () => socket.destroy(new Error("SMTP timeout")));
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    socket.once("error", onError);
    socket.once("secureConnect", () => {
      socket.off("error", onError);
      resolve();
    });
  });
  const lines = createInterface({ crlfDelay: Number.POSITIVE_INFINITY, input: socket });
  const replies = lines[Symbol.asyncIterator]();
  try {
    await expectReply(replies, [220]);
    await command(socket, replies, "EHLO inbox-desktop", [250]);
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

export function buildMimeMessage(options: Pick<SmtpMailOptions, "body" | "from" | "recipient" | "subject">): string {
  const subject = Buffer.from(options.subject).toString("base64");
  const body = Buffer.from(options.body).toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? "";
  return [
    `From: ${options.from}`,
    `To: ${options.recipient}`,
    `Subject: =?UTF-8?B?${subject}?=`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=\"UTF-8\"",
    "Content-Transfer-Encoding: base64",
    "",
    body,
  ].join("\r\n");
}

async function command(socket: TLSSocket, replies: AsyncIterator<string>, value: string, expected: readonly number[]): Promise<void> {
  await write(socket, `${value}\r\n`);
  await expectReply(replies, expected);
}

async function write(socket: TLSSocket, value: string): Promise<void> {
  if (socket.write(value)) return;
  await new Promise<void>((resolve, reject) => {
    socket.once("drain", resolve);
    socket.once("error", reject);
  });
}

async function expectReply(replies: AsyncIterator<string>, expectedCodes: readonly number[]): Promise<void> {
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
