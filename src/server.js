/**
 * Tiny dependency-free HTTP/JSON API on top of Controller.
 *
 *     GET  /health
 *     GET  /lights                      list lights (ping)
 *     GET  /lights/<target>             state ("all" = every light)
 *     POST /lights/<target>/on | off
 *     POST /lights/<target>/light       {"color": 0..100, "brightness": 1..100}
 *     POST /lights/<target>/night       {"level": 0..2}
 *     POST /groups/<id>/on | off | light
 *     POST /scenes/<index>/play | save
 *
 * Parameters may be sent as a JSON body or as query parameters. <target> is a light name, "all" or a vaddr.
 * When a token is configured every request needs `Authorization: Bearer <token>` (or ?token=...).
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';

import { InputError } from './errors.js';
import { log } from './log.js';
import { toInt } from './controller.js';

export const LOOPBACK = ['127.0.0.1', 'localhost', '::1'];
const MAX_BODY = 65536;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

function need(method, expected) {
  if (method !== expected) throw new HttpError(405, `use ${expected}`);
}

/** Route one request to the controller. Returns the JSON-able result. */
export async function dispatch(ctl, method, path, params) {
  let parts;
  try {
    parts = path.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    throw new HttpError(400, 'bad URL encoding');
  }
  if (parts.length === 1 && parts[0] === 'health') return { ok: true, ...ctl.info() };
  if (!parts.length) throw new HttpError(404, 'not found');
  const [head] = parts;
  if (head === 'lights') {
    if (parts.length === 1) {
      need(method, 'GET');
      return ctl.lights();
    }
    const target = parts[1];
    if (parts.length === 2) {
      need(method, 'GET');
      return ctl.status(target);
    }
    need(method, 'POST');
    const act = parts[2];
    if (act === 'on') return ctl.on(target);
    if (act === 'off') return ctl.off(target);
    if (act === 'light') return ctl.setLight(target, params.color ?? 50, params.brightness ?? 100);
    if (act === 'night') return ctl.nightLight(target, params.level ?? 0);
  } else if (head === 'groups' && parts.length === 3) {
    need(method, 'POST');
    return ctl.group(toInt(parts[1], 'group id'), parts[2], params.color ?? 50, params.brightness ?? 100);
  } else if (head === 'scenes' && parts.length === 3 && (parts[2] === 'play' || parts[2] === 'save')) {
    need(method, 'POST');
    return ctl.scene(toInt(parts[1], 'scene index'), parts[2] === 'save');
  }
  throw new HttpError(404, 'not found');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > MAX_BODY) {
      reject(new HttpError(413, 'body too large'));
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'body too large'));
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const digest = (s) => createHash('sha256').update(String(s)).digest();

/** A `(req, res)` handler for node:http. */
export function makeHandler(ctl, token = null) {
  return async (req, res) => {
    let status = 200;
    let payload;
    try {
      const url = new URL(req.url, 'http://localhost');
      const params = Object.fromEntries(url.searchParams);
      const body = await readBody(req);
      if (body.length) {
        let data;
        try {
          data = JSON.parse(body.toString('utf8'));
        } catch {
          throw new HttpError(400, 'body must be JSON');
        }
        if (data && typeof data === 'object' && !Array.isArray(data)) Object.assign(params, data);
      }
      if (token) {
        const auth = req.headers.authorization || '';
        const given = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : (params.token ?? '');
        if (!timingSafeEqual(digest(given), digest(token))) throw new HttpError(401, 'bad or missing token');
      }
      delete params.token;
      payload = await dispatch(ctl, req.method.toUpperCase(), url.pathname, params);
    } catch (e) {
      if (e instanceof HttpError) {
        status = e.status;
      } else if (e instanceof InputError) {
        status = 400;
      } else { // BLE / login failures
        status = 502;
        log.error('request failed:', e);
      }
      payload = { ok: false, error: e instanceof HttpError || e instanceof InputError ? e.message : `${e.name}: ${e.message}` };
    }
    const data = Buffer.from(JSON.stringify(payload ?? null), 'utf8');
    if (res.headersSent || res.destroyed) return;
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': data.length,
      Connection: 'close',
    });
    res.end(data);
  };
}

/**
 * Start the HTTP API. Resolves to the listening http.Server; closing the server also closes the controller.
 * @param {import('./controller.js').Controller} ctl
 * @param {{host?: string, port?: number, token?: string|null}} [opts]
 */
export async function serve(ctl, { host = '127.0.0.1', port = 8765, token = null } = {}) {
  if (!LOOPBACK.includes(host) && !token) {
    throw new InputError(`refusing to listen on ${host} without a token (use --token or ODELIC_HTTP_TOKEN)`);
  }
  const server = http.createServer(makeHandler(ctl, token));
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000 + 60_000; // BLE operations (scan + login) can take a while
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  server.on('close', () => ctl.close().catch(() => {}));
  const addr = server.address();
  log.warning(`HTTP API on http://${host}:${addr.port} (${ctl.keepConnected
    ? 'keeping the BLE link open' : `idle disconnect after ${ctl.idleTimeout}s`})`);
  if (ctl.keepConnected) {
    ctl.connect()
      .then(() => log.warning(`connected via ${ctl.mesh.nodeName}`))
      .catch((e) => log.warning(`initial connect failed: ${e.message}`)); // the next request retries
  }
  return server;
}
