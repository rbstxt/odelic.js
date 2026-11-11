/**
 * User configuration: app ID, preferred node, connection mode and light names.
 *
 * Stored as JSON at $ODELIC_CONFIG, or $XDG_CONFIG_HOME/odelic/config.json (default ~/.config/odelic/config.json).
 * The format is shared with the Python package (odelic.py), so both can use the same file:
 *
 *     {"id": "12345678", "node": null, "idle_timeout": 60, "lights": {"living": "00000000"}}
 *
 * idle_timeout: seconds of inactivity before the BLE link is released (so the phone app can connect);
 * 0 keeps the link open permanently.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { InputError } from './errors.ts';
import * as P from './protocol.ts';

export const ALL_NAMES: readonly string[] = ['all', '*', '全部', 'すべて'];
export const DEFAULT_IDLE_TIMEOUT = 60;
const KEEP_WORDS = ['0', 'never', 'none', 'off', 'keep', 'forever'];

/** The JSON stored on disk (snake_case, shared with the Python package). */
export interface ConfigData {
  id?: string | null;
  node?: string | null;
  idle_timeout?: number | string | null;
  lights?: Record<string, string>;
}

/** Seconds before an idle connection is closed; 0 (or "never"/"keep") = stay connected; null = not set. */
export function parseIdle(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && KEEP_WORDS.includes(value.trim().toLowerCase())) return 0;
  const v = typeof value === 'string' ? Number(value.trim()) : Number(value);
  if (typeof value === 'boolean' || !Number.isFinite(v)) throw new InputError(`invalid idle timeout: ${String(value)}`);
  if (v < 0) throw new InputError('idle timeout must be >= 0');
  return v;
}

export function configPath(): string {
  if (process.env.ODELIC_CONFIG) return expandHome(process.env.ODELIC_CONFIG);
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'odelic', 'config.json');
}

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

export class Config {
  path: string;
  id: string | null;
  node: string | null;
  idleTimeout: number | null;
  /** name -> vaddr hex (null prototype: names like "constructor" are plain keys) */
  lights: Record<string, string>;

  constructor(data: ConfigData | null = {}, file: string | null = null) {
    data ??= {};
    this.path = file ?? configPath();
    this.id = data.id ?? null;
    this.node = data.node ?? null;
    this.lights = Object.create(null) as Record<string, string>;
    for (const [k, v] of Object.entries(data.lights ?? {})) this.lights[String(k)] = String(v).toLowerCase();
    this.idleTimeout = parseIdle(data.idle_timeout);
  }

  static load(file: string | null = null): Config {
    const p = file ?? configPath();
    let data: ConfigData = {};
    try {
      data = JSON.parse(fs.readFileSync(p, 'utf8')) as ConfigData;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    return new Config(data, p);
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    const tmp = this.path.replace(/\.[^./]*$/, '') + '.tmp';
    const data: ConfigData = { id: this.id, node: this.node, idle_timeout: this.idleTimeout, lights: this.lights };
    // the ID is the mesh password: keep the file private
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    try {
      fs.chmodSync(tmp, 0o600);
    } catch {
      // not supported on this filesystem
    }
    fs.renameSync(tmp, this.path);
  }

  /** Effective app ID: override > $ODELIC_ID > config. */
  appId(override: string | null = null): string | null {
    return override || process.env.ODELIC_ID || this.id;
  }

  /** Effective idle timeout: override > $ODELIC_IDLE_TIMEOUT > config > 60 s. 0 = stay connected. */
  idle(override: number | string | null = null): number {
    for (const v of [override, process.env.ODELIC_IDLE_TIMEOUT, this.idleTimeout]) {
      const parsed = parseIdle(v);
      if (parsed !== null) return parsed;
    }
    return DEFAULT_IDLE_TIMEOUT;
  }

  // ------------------------------------------------------------ names
  nameOf(vaddr: Uint8Array): string | null {
    const hex = Buffer.from(vaddr).toString('hex');
    for (const [name, v] of Object.entries(this.lights)) if (v === hex) return name;
    return null;
  }

  /** light name / "all" / vaddr hex / bytes -> 4-byte vaddr */
  resolve(target: P.VaddrLike | null | undefined): Buffer {
    if (target === null || target === undefined) return P.BROADCAST;
    if (target instanceof Uint8Array) return P.vaddr(target);
    const t = String(target).trim();
    if (t === '' || ALL_NAMES.includes(t.toLowerCase())) return P.BROADCAST;
    for (const [name, v] of Object.entries(this.lights)) {
      if (name.toLowerCase() === t.toLowerCase()) return Buffer.from(v, 'hex');
    }
    try {
      return P.vaddr(t);
    } catch {
      const known = Object.keys(this.lights).join(', ') || '(none)';
      throw new InputError(`unknown light ${JSON.stringify(String(target))} (known names: ${known})`);
    }
  }

  setName(name: string, target: P.VaddrLike): void {
    const v = this.resolve(target);
    if (v.equals(P.BROADCAST)) throw new InputError('cannot name the broadcast address');
    this.lights[name] = v.toString('hex');
  }

  removeName(name: string): void {
    if (!Object.hasOwn(this.lights, name)) throw new InputError(`no light named ${JSON.stringify(name)}`);
    delete this.lights[name];
  }
}
