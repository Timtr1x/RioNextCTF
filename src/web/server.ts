import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { DomainError } from "../domain/errors.ts";
import { EngineHost } from "./engine-host.ts";
import { TaskRegistry } from "./tasks.ts";
import { registerCampaignRoutes } from "./routes-campaigns.ts";
import { registerProviderRoutes } from "./routes-providers.ts";
import { registerOpsRoutes, type OpsContext } from "./routes-ops.ts";

export interface ApiContext {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  host: EngineHost;
  tasks: TaskRegistry;
  dataDir: string;
  ops: OpsContext;
  json<T = Record<string, unknown>>(): Promise<T>;
  raw(): Promise<Buffer>;
}

export type ApiHandler = (ctx: ApiContext) => unknown | Promise<unknown>;

interface Route {
  method: string;
  segments: string[];
  handler: ApiHandler;
}

const here = dirname(fileURLToPath(import.meta.url));

export function defaultWebRoot(): string {
  // dist/src/web/server.js -> <repo>/web/dist
  return join(here, "..", "..", "..", "web", "dist");
}

export interface UiServerOptions {
  dataDir: string;
  port?: number;
  webRoot?: string;
  maxCycles?: number;
  /** Static + SPA fallback is skipped when false (tests that only exercise API). */
  serveStatic?: boolean;
}

export interface UiServer {
  server: Server;
  host: EngineHost;
  tasks: TaskRegistry;
  port: number;
  url: string;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

export const API_ERROR_SHAPE = "error_shape_v1";

function statusFor(err: unknown): number {
  if (err instanceof DomainError) {
    switch (err.category) {
      case "conflict":
      case "cancelled":
        return 409;
      case "denied":
        return 403;
      case "invalid_input":
        return 400;
      case "budget":
        return 402;
      default:
        return 400;
    }
  }
  return 400;
}

function errorBody(err: unknown): Record<string, unknown> {
  if (err instanceof DomainError) {
    return { error: { code: err.code, category: err.category, message: err.message, details: err.details } };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { error: { code: "error", category: "invalid_input", message } };
}

async function readRaw(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function matchRoute(routes: Route[], method: string, path: string): { route: Route; params: Record<string, string> } | null {
  const parts = path.split("/").filter((s) => s !== "");
  for (const route of routes) {
    if (route.method !== method) continue;
    if (route.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      const seg = route.segments[i];
      const part = parts[i];
      if (seg === undefined || part === undefined) {
        ok = false;
        break;
      }
      if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(part);
      else if (seg !== part) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, params };
  }
  return null;
}

export async function startUiServer(options: UiServerOptions): Promise<UiServer> {
  const host = new EngineHost(options.dataDir, { maxCycles: options.maxCycles });
  const tasks = new TaskRegistry();
  const ops: OpsContext = { healthCache: { at: 0, value: null } };
  const routes: Route[] = [];
  const add = (method: string, pattern: string, handler: ApiHandler): void => {
    routes.push({ method, segments: pattern.split("/").filter((s) => s !== ""), handler });
  };

  registerCampaignRoutes(add, host);
  registerProviderRoutes(add, options.dataDir);
  registerOpsRoutes(add, host, tasks, ops);

  const webRoot = options.webRoot ?? defaultWebRoot();
  const serveStatic = options.serveStatic !== false;
  const port = options.port ?? 7780;

  const server = createServer(async (req, res) => {
    const send = (code: number, body: unknown, type = "application/json; charset=utf-8"): void => {
      res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
      res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const path = url.pathname;
      const method = req.method ?? "GET";

      if (path.startsWith("/api/")) {
        const found = matchRoute(routes, method, path);
        if (!found) {
          send(404, { error: { code: "not_found", category: "invalid_input", message: `no route ${method} ${path}` } });
          return;
        }
        let bodyPromise: Promise<Buffer> | null = null;
        const ctx: ApiContext = {
          method,
          path,
          params: found.params,
          query: url.searchParams,
          headers: req.headers,
          host,
          tasks,
          dataDir: options.dataDir,
          ops,
          json: async <T,>() => {
            bodyPromise ??= readRaw(req);
            const text = (await bodyPromise).toString("utf8");
            return (text ? JSON.parse(text) : {}) as T;
          },
          raw: () => {
            bodyPromise ??= readRaw(req);
            return bodyPromise;
          },
        };
        const result = await found.route.handler(ctx);
        send(200, result === undefined ? { ok: true } : result);
        return;
      }

      if (!serveStatic || method !== "GET") {
        send(404, { error: { code: "not_found", category: "invalid_input", message: `no route ${method} ${path}` } });
        return;
      }
      serveStaticFile(webRoot, path, send);
    } catch (err) {
      send(statusFor(err), errorBody(err));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  return {
    server,
    host,
    tasks,
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}`,
    close: () =>
      new Promise<void>((resolve) => {
        try {
          host.close();
        } catch {
          // close stays idempotent; server shutdown must proceed regardless.
        }
        server.close(() => resolve());
        // fetch keep-alive sockets would otherwise hold the close callback.
        server.closeIdleConnections();
      }),
  };
}

function serveStaticFile(
  webRoot: string,
  path: string,
  send: (code: number, body: unknown, type?: string) => void,
): void {
  const rel = normalize(path).replace(/^([/\\])+/, "");
  const file = join(webRoot, rel);
  if (!file.startsWith(webRoot)) {
    send(403, { error: { code: "forbidden", category: "denied", message: "path escapes web root" } });
    return;
  }
  if (existsSync(file) && statSync(file).isFile()) {
    send(200, readFileSync(file), MIME[extname(file).toLowerCase()] ?? "application/octet-stream");
    return;
  }
  const index = join(webRoot, "index.html");
  if (existsSync(index)) {
    send(200, readFileSync(index), MIME[".html"]);
    return;
  }
  send(
    200,
    `<!doctype html><meta charset="utf-8"><title>RioNext UI</title><body style="font-family:monospace;padding:2rem">
<h1>RioNext UI</h1>
<p>前端尚未构建。运行 <code>npm run web:build</code> 后刷新；开发时用 <code>npm run web:dev</code>（Vite，代理 /api 到本服务）。</p>
<p>API 已在线：<a href="/api/health">/api/health</a></p>
</body>`,
    "text/html; charset=utf-8",
  );
}
