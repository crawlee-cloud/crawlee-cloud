/**
 * Logging HTTP proxy between the Apify MCP server and the Crawlee Cloud API.
 *
 * Writes one line per request to the log file: method, path, status, and the
 * error body for 4xx/5xx responses. It also keeps every request in memory so
 * run.mjs can count requests in a time window (the `poll-count` assertion).
 *
 * Standalone use (for debugging a session by hand):
 *   PROXY_TARGET=http://localhost:3000 PROXY_PORT=3999 node proxy.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ERROR_BODY_MAX = 2000;

/**
 * @param {{ target: string, logFile: string, port?: number }} opts
 * @returns {Promise<{ url: string, requests: Array<{ seq: number, method: string, path: string, status: number }>, close: () => Promise<void> }>}
 */
export async function startProxy({ target, logFile, port = 0 }) {
  const targetUrl = new URL(target);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const log = fs.createWriteStream(logFile, { flags: 'w' });
  const requests = [];
  let seq = 0;

  const server = http.createServer((req, res) => {
    const id = ++seq;
    const reqPath = req.url ?? '/';
    const headers = { ...req.headers, host: targetUrl.host };

    const upstream = http.request(
      {
        protocol: targetUrl.protocol,
        hostname: targetUrl.hostname,
        port: targetUrl.port,
        method: req.method,
        path: reqPath,
        headers,
      },
      (upRes) => {
        const status = upRes.statusCode ?? 0;
        res.writeHead(status, upRes.headers);
        const chunks = [];
        let captured = 0;
        upRes.on('data', (chunk) => {
          if (status >= 400 && captured < ERROR_BODY_MAX) {
            chunks.push(chunk);
            captured += chunk.length;
          }
          res.write(chunk);
        });
        upRes.on('end', () => {
          res.end();
          record(id, req.method, reqPath, status, status >= 400 ? Buffer.concat(chunks) : null);
        });
      }
    );
    upstream.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'proxy-error', message: err.message } }));
      record(id, req.method, reqPath, 502, Buffer.from(`proxy: ${err.message}`));
    });
    req.pipe(upstream);
  });

  function record(id, method, reqPath, status, errorBody) {
    requests.push({ seq: id, method, path: reqPath, status });
    let line = `${new Date().toISOString()} ${method} ${reqPath} ${status}`;
    if (errorBody) {
      const text = errorBody.toString('utf8').slice(0, ERROR_BODY_MAX).replace(/\s+/g, ' ');
      line += ` ${text}`;
    }
    log.write(`${line}\n`);
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const { port: boundPort } = server.address();

  return {
    url: `http://127.0.0.1:${boundPort}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => log.end(resolve));
      }),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const target = process.env.PROXY_TARGET ?? 'http://localhost:3000';
  const port = Number(process.env.PROXY_PORT ?? 3999);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const logFile = path.join(here, '.out', 'http.log');
  const proxy = await startProxy({ target, logFile, port });
  console.log(`Proxying ${proxy.url} -> ${target}, logging to ${logFile}`);
}
