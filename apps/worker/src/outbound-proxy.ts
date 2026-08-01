import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { createServer, type Server } from "node:http";
import { isIP } from "node:net";
import {
  connect as connectTcp,
  type Socket,
} from "node:net";
import type { Duplex } from "node:stream";
import { connect as connectTls } from "node:tls";

import { fetch as undiciFetch, ProxyAgent } from "undici";
import { z } from "zod";

const DOH_HOSTNAME = "cloudflare-dns.com";
const DOH_ADDRESS = "1.1.1.1";
const DOH_PATH = "/dns-query";
const DEFAULT_TIMEOUT_MS = 15_000;

const dohResponseSchema = z.object({
  Answer: z.array(z.object({
    TTL: z.number().int().nonnegative(),
    data: z.string(),
    type: z.number().int(),
  })).optional(),
  Status: z.number().int(),
});

export interface Ipv4Answer {
  readonly address: string;
  readonly ttlSeconds: number;
}

export interface ProxyEndpoint {
  readonly hostname: string;
  readonly port: number;
}

export interface HttpConnectProxy {
  readonly hostname: string;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

export interface WarpOutboundProxy extends HttpConnectProxy {
  readonly fetcher: typeof fetch;
}

type ResolveIpv4 = (hostname: string) => Promise<readonly string[]>;
type ConnectTarget = (address: string, port: number) => Promise<Socket>;

export function parseConnectAuthority(authority: string): ProxyEndpoint {
  if (!authority || /[\s/@?#]/.test(authority)) {
    throw new Error("invalid CONNECT authority");
  }
  const parsed = new URL(`http://${authority}`);
  const port = Number(parsed.port);
  if (!parsed.hostname || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("invalid CONNECT authority");
  }
  return { hostname: parsed.hostname, port };
}

export function parseSocksProxyUrl(value: string): ProxyEndpoint {
  const parsed = new URL(value);
  const port = Number(parsed.port);
  if (
    parsed.protocol !== "socks5:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "" ||
    parsed.search ||
    parsed.hash ||
    !parsed.hostname ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error("WARP SOCKS proxy URL must be socks5://host:port without credentials");
  }
  return { hostname: parsed.hostname, port };
}

export function parseDohIpv4Answers(value: unknown): readonly Ipv4Answer[] {
  const parsed = dohResponseSchema.parse(value);
  if (parsed.Status !== 0) throw new Error(`DoH lookup failed with status ${parsed.Status}`);
  const answers = (parsed.Answer ?? [])
    .filter(({ data, type }) => type === 1 && isIP(data) === 4)
    .map(({ TTL, data }) => ({ address: data, ttlSeconds: Math.max(1, TTL) }));
  if (answers.length === 0) throw new Error("DoH lookup returned no IPv4 address");
  return answers;
}

export function createCachedIpv4Resolver(options: {
  readonly now?: () => number;
  readonly query: (hostname: string) => Promise<readonly Ipv4Answer[]>;
}): ResolveIpv4 {
  const now = options.now ?? Date.now;
  const cache = new Map<string, { readonly addresses: readonly string[]; readonly expiresAt: number }>();
  return async (hostname) => {
    if (isIP(hostname) === 4) return [hostname];
    const key = hostname.toLowerCase();
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return cached.addresses;
    const answers = await options.query(key);
    const addresses = [...new Set(answers.map(({ address }) => address))];
    const ttlSeconds = Math.min(...answers.map(({ ttlSeconds }) => ttlSeconds));
    cache.set(key, { addresses, expiresAt: now() + ttlSeconds * 1_000 });
    return addresses;
  };
}

export async function startHttpConnectProxy(options: {
  readonly connect: ConnectTarget;
  readonly hostname: string;
  readonly port: number;
  readonly resolve: ResolveIpv4;
}): Promise<HttpConnectProxy> {
  const sockets = new Set<Duplex>();
  const server = createServer((_request, response) => {
    response.writeHead(405, { Connection: "close" });
    response.end();
  });
  server.on("connect", (request, client, head) => {
    sockets.add(client);
    client.once("close", () => sockets.delete(client));
    void establishTunnel(request.url, head, client, options).catch((error: unknown) => {
      console.error(JSON.stringify({
        cause: error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined,
        causeCode: error instanceof Error && error.cause instanceof Error && "code" in error.cause
          ? error.cause.code
          : undefined,
        code: error instanceof Error && "code" in error ? error.code : undefined,
        error: error instanceof Error ? error.message : String(error),
        event: "outbound_proxy_tunnel_failed",
        name: error instanceof Error ? error.name : typeof error,
      }));
      if (!client.destroyed) {
        client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      }
    });
  });
  await listen(server, options.hostname, options.port);
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("HTTP CONNECT proxy address missing");
  }
  return {
    hostname: options.hostname,
    port: address.port,
    url: `http://${options.hostname}:${address.port}`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
    },
  };
}

export async function startWarpOutboundProxy(options: {
  readonly listenHostname?: string;
  readonly listenPort: number;
  readonly readyTimeoutMs: number;
  readonly socksProxyUrl: string;
}): Promise<WarpOutboundProxy> {
  const socks = parseSocksProxyUrl(options.socksProxyUrl);
  const resolve = createCachedIpv4Resolver({
    query: (hostname) => queryDohIpv4(hostname, socks),
  });
  const proxy = await startHttpConnectProxy({
    connect: (address, port) => connectViaSocks5(socks, { hostname: address, port }, false),
    hostname: options.listenHostname ?? "127.0.0.1",
    port: options.listenPort,
    resolve,
  });
  const proxied = createProxiedFetch(proxy.url);
  try {
    await waitForWarpConnection(proxied.fetcher, options.readyTimeoutMs);
  } catch (error: unknown) {
    await proxied.close();
    await proxy.close();
    throw error;
  }
  return {
    ...proxy,
    fetcher: proxied.fetcher,
    close: async () => {
      await proxied.close();
      await proxy.close();
    },
  };
}

export async function verifyWarpConnection(fetcher: typeof fetch): Promise<void> {
  const response = await fetcher("https://www.cloudflare.com/cdn-cgi/trace", {
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`WARP trace request failed: ${response.status}`);
  const body = await response.text();
  if (!/^warp=on$/m.test(body)) throw new Error("WARP trace did not return warp=on");
}

async function waitForWarpConnection(fetcher: typeof fetch, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  do {
    try {
      await verifyWarpConnection(fetcher);
      return;
    } catch (error: unknown) {
      lastError = error;
      await delay(Math.min(1_000, Math.max(0, deadline - Date.now())));
    }
  } while (Date.now() < deadline);
  throw lastError instanceof Error ? lastError : new Error("WARP proxy readiness timed out");
}

async function establishTunnel(
  authority: string | undefined,
  head: Buffer,
  client: Duplex,
  options: { readonly connect: ConnectTarget; readonly resolve: ResolveIpv4 },
): Promise<void> {
  const target = parseConnectAuthority(authority ?? "");
  const addresses = await options.resolve(target.hostname).catch((error: unknown) => {
    throw new Error("outbound proxy resolution failed", { cause: error });
  });
  const upstream = await connectFirst(addresses, target.port, options.connect).catch(
    (error: unknown) => {
      throw new Error("outbound proxy target connection failed", { cause: error });
    },
  );
  client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  if (head.length > 0) upstream.write(head);
  upstream.once("error", () => client.destroy());
  client.once("error", () => upstream.destroy());
  upstream.once("close", () => client.destroy());
  client.once("close", () => upstream.destroy());
  client.pipe(upstream).pipe(client);
}

async function connectFirst(
  addresses: readonly string[],
  port: number,
  connectTarget: ConnectTarget,
): Promise<Socket> {
  let lastError: unknown;
  for (const address of addresses) {
    try {
      return await connectTarget(address, port);
    } catch (error: unknown) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("no target address was reachable");
}

async function queryDohIpv4(
  hostname: string,
  socks: ProxyEndpoint,
): Promise<readonly Ipv4Answer[]> {
  const upstream = await connectViaSocks5(
    socks,
    { hostname: DOH_ADDRESS, port: 443 },
    false,
  );
  const value = await requestDohJson(upstream, hostname);
  return parseDohIpv4Answers(value);
}

function requestDohJson(upstream: Socket, hostname: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const agent = new HttpsAgent({ keepAlive: false });
    agent.createConnection = () => connectTls({
      ALPNProtocols: ["http/1.1"],
      servername: DOH_HOSTNAME,
      socket: upstream,
    });
    const request = httpsRequest({
      agent,
      headers: { Accept: "application/dns-json" },
      hostname: DOH_HOSTNAME,
      method: "GET",
      path: `${DOH_PATH}?name=${encodeURIComponent(hostname)}&type=A`,
      port: 443,
      protocol: "https:",
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 65_536) {
          request.destroy(new Error("DoH response too large"));
          return;
        }
        chunks.push(chunk);
      });
      response.once("end", () => {
        if (response.statusCode !== 200) {
          reject(new Error(`DoH request failed: ${response.statusCode ?? 0}`));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
        } catch (error: unknown) {
          reject(error);
        }
      });
    });
    request.setTimeout(DEFAULT_TIMEOUT_MS, () => request.destroy(new Error("DoH timeout")));
    request.once("close", () => agent.destroy());
    request.once("error", reject);
    request.end();
  });
}

async function connectViaSocks5(
  proxy: ProxyEndpoint,
  target: ProxyEndpoint,
  resolveRemotely: boolean,
): Promise<Socket> {
  const socket = await openSocket(proxy);
  socket.setTimeout(DEFAULT_TIMEOUT_MS, () => socket.destroy(new Error("SOCKS5 timeout")));
  socket.write(Buffer.from([5, 1, 0]));
  const greeting = await readExactly(socket, 2);
  if (greeting[0] !== 5 || greeting[1] !== 0) {
    socket.destroy();
    throw new Error("SOCKS5 proxy rejected unauthenticated connection");
  }
  socket.write(createSocksConnectRequest(target, resolveRemotely));
  const header = await readExactly(socket, 4);
  if (header[0] !== 5 || header[1] !== 0) {
    socket.destroy();
    throw new Error(`SOCKS5 connect failed with code ${header[1] ?? -1}`);
  }
  const addressLength = header[3] === 1
    ? 4
    : header[3] === 4
      ? 16
      : header[3] === 3
        ? (await readExactly(socket, 1))[0]
        : undefined;
  if (addressLength === undefined) {
    socket.destroy();
    throw new Error("SOCKS5 proxy returned an invalid address type");
  }
  await readExactly(socket, addressLength + 2);
  socket.setTimeout(0);
  return socket;
}

function createSocksConnectRequest(target: ProxyEndpoint, resolveRemotely: boolean): Buffer {
  const port = Buffer.allocUnsafe(2);
  port.writeUInt16BE(target.port);
  if (!resolveRemotely && isIP(target.hostname) === 4) {
    return Buffer.concat([
      Buffer.from([5, 1, 0, 1, ...target.hostname.split(".").map(Number)]),
      port,
    ]);
  }
  const hostname = Buffer.from(target.hostname, "utf8");
  if (!resolveRemotely || hostname.length === 0 || hostname.length > 255) {
    throw new Error("SOCKS5 target must be an IPv4 address or remote-resolved hostname");
  }
  return Buffer.concat([Buffer.from([5, 1, 0, 3, hostname.length]), hostname, port]);
}

function openSocket(endpoint: ProxyEndpoint): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connectTcp({ host: endpoint.hostname, port: endpoint.port });
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve(socket);
    });
  });
}

function readExactly(socket: Socket, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let remaining = length;
    const consume = () => {
      let chunk = socket.read(remaining) as Buffer | null;
      while (chunk) {
        chunks.push(chunk);
        remaining -= chunk.length;
        if (remaining === 0) {
          cleanup();
          resolve(Buffer.concat(chunks, length));
          return;
        }
        chunk = socket.read(remaining) as Buffer | null;
      }
    };
    const onClose = () => finish(new Error("SOCKS5 connection closed during handshake"));
    const onError = (error: Error) => finish(error);
    const finish = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("readable", consume);
      socket.off("close", onClose);
      socket.off("error", onError);
    };
    socket.on("readable", consume);
    socket.once("close", onClose);
    socket.once("error", onError);
    consume();
  });
}

function createProxiedFetch(proxyUrl: string): {
  readonly close: () => Promise<void>;
  readonly fetcher: typeof fetch;
} {
  const dispatcher = new ProxyAgent(proxyUrl);
  const fetcher: typeof fetch = async (input, init) => {
    const response = await undiciFetch(
      input as Parameters<typeof undiciFetch>[0],
      { ...init, dispatcher } as Parameters<typeof undiciFetch>[1],
    );
    return response as unknown as Response;
  };
  return { close: () => dispatcher.close(), fetcher };
}

function listen(server: Server, hostname: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
