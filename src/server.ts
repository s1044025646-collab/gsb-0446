import http from "node:http";
import { ApiError, Store } from "./store";

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 32 * 1024 * 1024) reject(new ApiError("PAYLOAD_TOO_LARGE", "请求体过大", 413));
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** 启动 API 服务。port=0 时自动选择空闲端口（默认）。 */
export function startServer(store: Store, port = 0): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const method = req.method ?? "GET";
      const json = async () => {
        const raw = await readBody(req);
        if (!raw) return {};
        try {
          return JSON.parse(raw);
        } catch {
          throw new ApiError("BAD_JSON", "请求体不是合法 JSON");
        }
      };

      if (method === "GET" && path === "/api/health") {
        return send(res, 200, { ok: true, rulesVersion: store.rulesVersion });
      }
      if (method === "POST" && path === "/api/datasets") {
        const body = await json();
        return send(res, 201, store.createDataset(body.name));
      }
      if (method === "GET" && path === "/api/datasets") {
        return send(res, 200, store.listDatasets());
      }

      const mDataset = /^\/api\/datasets\/(\d+)$/.exec(path);
      const mImport = /^\/api\/datasets\/(\d+)\/imports$/.exec(path);
      const mLines = /^\/api\/datasets\/(\d+)\/lines$/.exec(path);
      const mPairs = /^\/api\/datasets\/(\d+)\/pairs$/.exec(path);
      const mReports = /^\/api\/datasets\/(\d+)\/reports$/.exec(path);
      const mReport = /^\/api\/reports\/(\d+)$/.exec(path);
      const mExport = /^\/api\/reports\/(\d+)\/export$/.exec(path);

      if (method === "POST" && mImport) {
        const body = await json();
        return send(res, 201, store.importText(Number(mImport[1]), {
          requestId: body.requestId, source: body.source,
          utcDate: body.utcDate, text: body.text,
        }));
      }
      if (method === "GET" && mLines) {
        return send(res, 200, store.listLines(Number(mLines[1])));
      }
      if (method === "GET" && mPairs) {
        const tol = url.searchParams.get("toleranceDeg");
        const second = url.searchParams.get("second");
        return send(res, 200, store.queryPairs(Number(mPairs[1]), tol ? Number(tol) : undefined, {
          source: url.searchParams.get("source") ?? undefined,
          date: url.searchParams.get("date") ?? undefined,
          second: second !== null ? Number(second) : undefined,
        }));
      }
      if (method === "POST" && mReports) {
        const body = await json();
        return send(res, 201, store.createReport(Number(mReports[1]), Number(body.toleranceDeg ?? 1e-4)));
      }
      if (method === "GET" && mReport) {
        return send(res, 200, store.getReport(Number(mReport[1])));
      }
      if (method === "GET" && mExport) {
        const report = store.getReport(Number(mExport[1]));
        return send(res, 200, {
          format: "nmea-pairing-report/1",
          ...report,
        });
      }
      if (method === "GET" && mDataset) {
        return send(res, 200, { id: Number(mDataset[1]) });
      }
      throw new ApiError("NOT_FOUND", `未匹配路由: ${method} ${path}`, 404);
    } catch (e) {
      if (e instanceof ApiError) {
        return send(res, e.httpStatus, { error: { code: e.code, message: e.message } });
      }
      return send(res, 500, { error: { code: "INTERNAL", message: String(e) } });
    }
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, port: addr.port });
    });
  });
}
