// The forge's HTTP server: one process, standard library only.
// Routing order: /healthz -> /api/v3/* -> /api/graphql -> /mcp ->
// /<owner>/<repo>.git/* -> 404 {"message": "Not Found"}.
// Every JSON reply carries a non-empty X-GitHub-Request-Id. Keep-alive stays
// on (the read workload reuses one connection for 2,000 requests).

import { createServer } from 'node:http';
import { nextRequestId as requestId } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit } from './git-http.ts';

const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function authed(req) {
  if (!SHOP_TOKEN) return true; // no token configured: accept anything (dev)
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${SHOP_TOKEN}`;
}

function sendJson(res, status, body, extraHeaders) {
  const data = body === null ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': requestId(),
    ...(body === null ? {} : { 'content-length': Buffer.byteLength(data) }),
    ...(extraHeaders ?? {}),
  });
  res.end(data);
}

function sendBuffer(res, status, contentType, body, extraHeaders) {
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': requestId(),
    'content-length': body.length,
    ...(extraHeaders ?? {}),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > 16 * 1024 * 1024) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createApp() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const path = url.pathname;
      const method = req.method ?? 'GET';
      const segments = path.split('/').filter((s) => s.length > 0).map((s) => decodeURIComponent(s));

      // /healthz (the starter's health answer, no auth).
      if (path === '/healthz' && method === 'GET') {
        sendJson(res, 200, { ok: true });
        return;
      }

      const baseUrl = `http://${req.headers.host ?? 'localhost'}`;

      // REST v3.
      if (path === '/api/v3' || path === '/api/v3/' || path.startsWith('/api/v3/')) {
        const restSegs = path === '/api/v3' || path === '/api/v3/'
          ? []
          : segments.slice(2); // strip the /api/v3 prefix
        const isRootOrMeta = (restSegs.length === 0)
          || (restSegs.length === 1 && restSegs[0] === 'meta');
        if (!isRootOrMeta && !authed(req)) {
          sendJson(res, 401, { message: 'Unauthorized' });
          return;
        }
        const rawBody = await readBody(req);
        let body = null;
        if (rawBody.length > 0) {
          try {
            body = JSON.parse(rawBody.toString('utf8'));
          } catch {
            sendJson(res, 400, { message: 'malformed JSON body' });
            return;
          }
        }
        const out = handleRest({ method, segments: restSegs, query: url.searchParams, body, baseUrl });
        if (out.body === null) {
          res.writeHead(out.status, {
            'content-type': 'application/json',
            'x-github-request-id': requestId(),
            ...(out.headers ?? {}),
          });
          res.end();
          return;
        }
        sendJson(res, out.status, out.body, out.headers);
        return;
      }

      // GraphQL.
      if (path === '/api/graphql' && method === 'POST') {
        if (!authed(req)) {
          sendJson(res, 401, { message: 'Unauthorized' });
          return;
        }
        const rawBody = await readBody(req);
        let body;
        try {
          body = JSON.parse(rawBody.toString('utf8'));
        } catch {
          sendJson(res, 400, { data: null, errors: [{ message: 'malformed JSON body' }] });
          return;
        }
        const out = handleGraphQL(body);
        sendJson(res, 200, out);
        return;
      }

      // MCP.
      if (path === '/mcp') {
        if (!authed(req)) {
          sendJson(res, 401, { message: 'Unauthorized' });
          return;
        }
        if (method === 'DELETE') {
          res.writeHead(200, { 'x-github-request-id': requestId() });
          res.end();
          return;
        }
        if (method !== 'POST') {
          sendJson(res, 405, { message: 'Method Not Allowed' });
          return;
        }
        const rawBody = await readBody(req);
        const out = handleMcp(rawBody.toString('utf8'));
        sendJson(res, out.status, out.body);
        return;
      }

      // Git smart HTTP: /<owner>/<repo>.git/info/refs and /<owner>/<repo>.git/<service>.
      if (segments.length >= 2 && segments[1].endsWith('.git')) {
        const owner = segments[0];
        const repoName = segments[1].slice(0, -4);
        const rest = segments.slice(2);
        if (!authed(req)) {
          sendJson(res, 401, { message: 'Unauthorized' });
          return;
        }
        if (method === 'GET' && rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs') {
          const protocol = req.headers['git-protocol'] ?? '';
          const version = typeof protocol === 'string' && protocol.includes('version=2') ? '2' : '';
          const out = handleGit(owner, repoName, 'info/refs', 'GET', url.searchParams, null, version);
          if (out.status === 404) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          sendBuffer(res, out.status, out.contentType, out.body);
          return;
        }
        if (method === 'POST' && rest.length === 1 && (rest[0] === 'git-upload-pack' || rest[0] === 'git-receive-pack')) {
          const rawBody = await readBody(req);
          const protocol = req.headers['git-protocol'] ?? '';
          const version = typeof protocol === 'string' && protocol.includes('version=2') ? '2' : '';
          const out = handleGit(owner, repoName, rest[0], 'POST', url.searchParams, rawBody, version);
          if (out.status === 404) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (out.body === null) {
            sendJson(res, out.status, { message: 'Not Found' });
            return;
          }
          sendBuffer(res, out.status, out.contentType, out.body);
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }

      // Anything else: 404 JSON, never HTML.
      sendJson(res, 404, { message: 'Not Found' });
    } catch (err) {
      // A handler must never crash the server (the suite checks that the
      // server stays up after errors). Answer 500 JSON and keep serving.
      try {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'internal error' });
      } catch {
        // The response may already be half-written; nothing more to do.
      }
    }
  });

  server.keepAliveTimeout = 30000;
  server.headersTimeout = 35000;
  return server;
}
