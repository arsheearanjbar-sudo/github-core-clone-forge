// The HTTP server: routing, authentication, request ids, and body handling.
// Dispatches to the git, REST, GraphQL and MCP handlers, all sharing one
// store. A bad request can never take the server down: every handler runs
// behind a catch that answers 500 JSON.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './githttp.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { Store } from './store.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

interface Outcome {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

function jsonOutcome(status: number, body: unknown, headers: Record<string, string> = {}): Outcome {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
    body: Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'),
  };
}

/** The bearer token this process requires, from the trial environment. */
function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

/**
 * Authentication: a Bearer header must be present, and when the trial token is
 * configured it must match exactly. Only /healthz and the public API root and
 * meta routes skip this check (the caller decides that).
 */
function authenticated(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length);
  if (presented === '') return false;
  const expected = expectedToken();
  if (expected === '') return true;
  return presented === expected;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        failed = true;
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!failed) {
        failed = true;
        reject(err);
      }
    });
  });
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(store: Store = new Store()): Server {
  let requestCounter = 0;

  const send = (res: ServerResponse, outcome: Outcome): void => {
    requestCounter += 1;
    const headers: Record<string, string> = {
      ...outcome.headers,
      'x-github-request-id': `req-${requestCounter.toString(16).padStart(8, '0')}`,
      'content-length': String(outcome.body.length),
    };
    res.writeHead(outcome.status, headers);
    res.end(outcome.body);
  };

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const pathname = url.pathname;
        const method = req.method ?? 'GET';

        if (method === 'GET' && pathname === '/healthz') {
          send(res, jsonOutcome(200, { ok: true }));
          return;
        }

        const isPublicRest = pathname === '/api/v3' || pathname === '/api/v3/' || pathname === '/api/v3/meta';
        if (!isPublicRest && !authenticated(req)) {
          if (pathname === '/mcp') {
            send(
              res,
              jsonOutcome(401, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Requires authentication' } }),
            );
          } else {
            send(res, jsonOutcome(401, { message: 'Requires authentication' }));
          }
          return;
        }

        const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
        const body = needsBody ? await readBody(req) : Buffer.alloc(0);

        const host = typeof req.headers.host === 'string' ? req.headers.host : '127.0.0.1';

        const git = handleGit(store, method, pathname, url.searchParams, req.headers, body);
        if (git) {
          send(res, git);
          return;
        }

        const rest = handleRest(store, method, pathname, url.searchParams, body, host);
        if (rest) {
          send(res, rest);
          return;
        }

        const graphql = handleGraphQL(store, method, pathname, body);
        if (graphql) {
          send(res, graphql);
          return;
        }

        const mcp = handleMcp(store, method, pathname, body);
        if (mcp) {
          send(res, mcp);
          return;
        }

        send(res, jsonOutcome(404, { message: 'Not Found' }));
      } catch (err) {
        process.stderr.write(`[forge] request failed: ${err instanceof Error ? err.message : String(err)}\n`);
        try {
          send(res, jsonOutcome(500, { message: 'Internal Server Error' }));
        } catch {
          try {
            res.destroy();
          } catch {
            // the socket is already gone
          }
        }
      }
    })();
  });
}
