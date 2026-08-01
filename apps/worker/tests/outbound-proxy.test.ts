import { createServer as createTcpServer, connect as connectTcp, type Socket } from "node:net";
import { request } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createCachedIpv4Resolver,
  parseConnectAuthority,
  parseDohIpv4Answers,
  parseSocksProxyUrl,
  startHttpConnectProxy,
  verifyWarpConnection,
} from "../src/outbound-proxy";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("outbound proxy", () => {
  it("严格解析 CONNECT authority 与 SOCKS5 地址", () => {
    expect(parseConnectAuthority("www.youtube.com:443")).toEqual({
      hostname: "www.youtube.com",
      port: 443,
    });
    expect(parseSocksProxyUrl("socks5://127.0.0.1:40000")).toEqual({
      hostname: "127.0.0.1",
      port: 40_000,
    });
    expect(() => parseConnectAuthority("https://example.com")).toThrow();
    expect(() => parseSocksProxyUrl("http://127.0.0.1:40000")).toThrow();
  });

  it("只接受成功 DoH 响应中的 IPv4 记录", () => {
    expect(
      parseDohIpv4Answers({
        Answer: [
          { TTL: 60, data: "142.251.156.4", type: 1 },
          { TTL: 60, data: "2607:f8b0::1", type: 28 },
        ],
        Status: 0,
      }),
    ).toEqual([{ address: "142.251.156.4", ttlSeconds: 60 }]);
    expect(() => parseDohIpv4Answers({ Status: 3 })).toThrow();
  });

  it("按 DNS TTL 缓存解析结果", async () => {
    let now = 1_000;
    const query = vi.fn(async () => [{ address: "149.154.166.110", ttlSeconds: 30 }]);
    const resolve = createCachedIpv4Resolver({ now: () => now, query });

    await expect(resolve("api.telegram.org")).resolves.toEqual(["149.154.166.110"]);
    await expect(resolve("api.telegram.org")).resolves.toEqual(["149.154.166.110"]);
    expect(query).toHaveBeenCalledTimes(1);

    now += 30_001;
    await resolve("api.telegram.org");
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("HTTP CONNECT 使用已解析 IP 建立双向隧道", async () => {
    const target = createTcpServer((socket) => socket.pipe(socket));
    const targetPort = await listen(target);
    cleanups.push(() => closeServer(target));
    const resolve = vi.fn(async () => ["127.0.0.1"]);
    const proxy = await startHttpConnectProxy({
      connect: (address, port) => openSocket(address, port),
      hostname: "127.0.0.1",
      port: 0,
      resolve,
    });
    cleanups.push(() => proxy.close());

    const echoed = await tunnelRoundTrip(proxy.port, `blocked.example:${targetPort}`, "ping");

    expect(echoed).toBe("ping");
    expect(resolve).toHaveBeenCalledWith("blocked.example");
  });

  it("只有 warp=on 才通过启动门禁", async () => {
    await expect(
      verifyWarpConnection(async () => new Response("warp=on\n")),
    ).resolves.toBeUndefined();
    await expect(
      verifyWarpConnection(async () => new Response("warp=off\n")),
    ).rejects.toThrow("warp=on");
  });
});

function listen(server: ReturnType<typeof createTcpServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("TCP server address missing");
      resolve(address.port);
    });
  });
}

function closeServer(server: ReturnType<typeof createTcpServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function openSocket(hostname: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connectTcp({ host: hostname, port });
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve(socket);
    });
  });
}

function tunnelRoundTrip(
  proxyPort: number,
  authority: string,
  payload: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const connectRequest = request({
      host: "127.0.0.1",
      method: "CONNECT",
      path: authority,
      port: proxyPort,
    });
    connectRequest.once("error", reject);
    connectRequest.once("connect", (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`proxy returned ${response.statusCode}`));
        return;
      }
      if (head.length > 0) socket.unshift(head);
      socket.once("error", reject);
      socket.once("data", (chunk) => {
        socket.destroy();
        resolve(chunk.toString("utf8"));
      });
      socket.write(payload);
    });
    connectRequest.end();
  });
}
