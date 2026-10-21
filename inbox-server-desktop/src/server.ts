import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { CaptureError, type InboxEngine } from "./engine.ts";

const uiDir = fileURLToPath(new URL("../ui/", import.meta.url));
const staticFiles: Record<string, string> = {
  "/": "index.html",
  "/index.html": "index.html",
  "/app.js": "app.js",
  "/styles.css": "styles.css",
};

export function startServer(options: { engine: InboxEngine; host: string; port: number }): Promise<Server> {
  const server = createServer((request, response) => {
    void handle(options.engine, request, response);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolve(server));
  });
}

async function handle(engine: InboxEngine, request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/overview") {
      sendJson(response, 200, engine.overview());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/capture") {
      sendJson(response, 200, await engine.capture(await readBody(request)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/sync") {
      sendJson(response, 200, await engine.sync("manual"));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/settings") {
      sendJson(response, 200, engine.updateSettings(await readBody(request)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/import") {
      sendJson(response, 200, engine.importCloud(await readBody(request)));
      return;
    }
    const loginMatch = /^\/api\/login\/([a-z_]+)$/.exec(url.pathname);
    if (request.method === "POST" && loginMatch?.[1]) {
      sendJson(response, 200, await engine.beginLogin(loginMatch[1]));
      return;
    }
    const profileMatch = /^\/api\/profiles\/([a-z_]+)$/.exec(url.pathname);
    if (request.method === "POST" && profileMatch?.[1]) {
      sendJson(response, 200, engine.saveCredential(profileMatch[1], await readBody(request)));
      return;
    }
    if (request.method === "GET" && staticFiles[url.pathname]) {
      const name = staticFiles[url.pathname];
      if (!name) return;
      const path = join(uiDir, name);
      const safe = normalize(path);
      if (!safe.startsWith(normalize(uiDir))) {
        sendJson(response, 404, { error: "not found" });
        return;
      }
      const body = readFileSync(safe);
      response.writeHead(200, {
        "content-type": contentType(extname(name)),
        "cache-control": "no-store",
      });
      response.end(body);
      return;
    }
    sendJson(response, 404, { error: "not found" });
  } catch (error) {
    const status = error instanceof CaptureError ? 400 : 500;
    sendJson(response, status, { error: error instanceof Error ? error.message : "error" });
  }
}

function contentType(extension: string): string {
  if (extension === ".js") return "text/javascript; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  return "text/html; charset=utf-8";
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 2_000_000) {
        reject(new CaptureError("请求体过大"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw) as unknown);
      } catch {
        reject(new CaptureError("请求体不是 JSON"));
      }
    });
    request.on("error", reject);
  });
}
