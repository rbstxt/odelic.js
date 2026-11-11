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
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { InputError } from './errors.ts';
import { log } from './log.ts';
import { toInt } from './controller.ts';
import type { Controller } from './controller.ts';

export const LOOPBACK: readonly string[] = ['127.0.0.1', 'localhost', '::1'];
const MAX_BODY = 65536;

/** The part of Controller the HTTP API uses. */
export type HttpController = Pick<Controller,
  'info' | 'lights' | 'status' | 'on' | 'off' | 'setLight' | 'nightLight' | 'group' | 'scene'>;

type Params = Record<string, unknown>;

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

function need(method: string, expected: string): void {
  if (method !== expected) throw new HttpError(405, `use ${expected}`);
}

const num = (v: unknown, def: number) => (v ?? def) as number | string;

/** Route one request to the controller. Returns the JSON-able result. */
export async function dispatch(ctl: HttpController, method: string, path: string, params: Params): Promise<unknown> {
  let parts: string[];
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
    if (act === 'light') return ctl.setLight(target, num(params.color, 50), num(params.brightness, 100));
    if (act === 'night') return ctl.nightLight(target, num(params.level, 0));
  } else if (head === 'groups' && parts.length === 3) {
    need(method, 'POST');
    return ctl.group(toInt(parts[1], 'group id'), parts[2], num(params.color, 50), num(params.brightness, 100));
  } else if (head === 'scenes' && parts.length === 3 && (parts[2] === 'play' || parts[2] === 'save')) {
    need(method, 'POST');
    return ctl.scene(toInt(parts[1], 'scene index'), parts[2] === 'save');
  }
  throw new HttpError(404, 'not found');
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > MAX_BODY) {
      reject(new HttpError(413, 'body too large'));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
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

const digest = (s: unknown) => createHash('sha256').update(String(s)).digest();

/** A `(req, res)` handler for node:http. */
export function makeHandler(ctl: HttpController, token: string | null = null) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let status = 200;
    let payload: unknown;
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const params: Params = Object.fromEntries(url.searchParams);
      const body = await readBody(req);
      if (body.length) {
        let data: unknown;
        try {
          data = JSON.parse(body.toString('utf8'));
        } catch {
          throw new HttpError(400, 'body must be JSON');
        }
        if (data && typeof data === 'object' && !Array.isArray(data)) Object.assign(params, data);
      }
      if (token) {
        const auth = req.headers.authorization ?? '';
        const given = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : (params.token ?? '');
        if (!timingSafeEqual(digest(given), digest(token))) throw new HttpError(401, 'bad or missing token');
      }
      delete params.token;
      payload = await dispatch(ctl, (req.method ?? 'GET').toUpperCase(), url.pathname, params);
    } catch (e) {
      const err = e as Error;
      if (err instanceof HttpError) {
        status = err.status;
      } else if (err instanceof InputError) {
        status = 400;
      } else { // BLE / login failures
        status = 502;
        log.error('request failed:', err);
      }
      payload = { ok: false, error: err instanceof HttpError || err instanceof InputError ? err.message : `${err.name}: ${err.message}` };
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

export interface ServeOptions {
  host?: string;
  port?: number;
  /** bearer token; required when listening on a non-loopback address */
  token?: string | null;
}

/** Start the HTTP API. Resolves to the listening server; closing the server also closes the controller. */
export async function serve(ctl: Controller, { host = '127.0.0.1', port = 8765, token = null }: ServeOptions = {}): Promise<Server> {
  if (!LOOPBACK.includes(host) && !token) {
    throw new InputError(`refusing to listen on ${host} without a token (use --token or ODELIC_HTTP_TOKEN)`);
  }
  const server = http.createServer(makeHandler(ctl, token));
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000 + 60_000; // BLE operations (scan + login) can take a while
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  server.on('close', () => {
    ctl.close().catch(() => {});
  });
  const addr = server.address() as AddressInfo;
  log.warning(`HTTP API on http://${host}:${addr.port} (${ctl.keepConnected
    ? 'keeping the BLE link open' : `idle disconnect after ${ctl.idleTimeout}s`})`);
  if (ctl.keepConnected) {
    ctl.connect()
      .then(() => log.warning(`connected via ${ctl.mesh.nodeName}`))
      .catch((e: Error) => log.warning(`initial connect failed: ${e.message}`)); // the next request retries
  }
  return server;
}
