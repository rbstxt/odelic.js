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

import { InputError } from './errors.js';
import * as P from './protocol.js';

export const ALL_NAMES = ['all', '*', '全部', 'すべて'];
export const DEFAULT_IDLE_TIMEOUT = 60;
const KEEP_WORDS = ['0', 'never', 'none', 'off', 'keep', 'forever'];

/** Seconds before an idle connection is closed; 0 (or "never"/"keep") = stay connected; null = not set. */
export function parseIdle(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && KEEP_WORDS.includes(value.trim().toLowerCase())) return 0;
  const v = typeof value === 'string' ? Number(value.trim()) : Number(value);
  if (typeof value === 'boolean' || !Number.isFinite(v)) throw new InputError(`invalid idle timeout: ${value}`);
  if (v < 0) throw new InputError('idle timeout must be >= 0');
  return v;
}

export function configPath() {
  if (process.env.ODELIC_CONFIG) return expandHome(process.env.ODELIC_CONFIG);
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'odelic', 'config.json');
}

function expandHome(p) {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

export class Config {
  constructor(data = {}, file = null) {
    data ??= {};
    this.path = file ?? configPath();
    this.id = data.id ?? null;
    this.node = data.node ?? null;
    /** @type {Record<string, string>} name -> vaddr hex */
    this.lights = Object.create(null); // null prototype: names like "constructor" are plain keys
    for (const [k, v] of Object.entries(data.lights ?? {})) this.lights[String(k)] = String(v).toLowerCase();
    this.idleTimeout = parseIdle(data.idle_timeout);
  }

  static load(file = null) {
    const p = file ?? configPath();
    let data = {};
    try {
      data = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    return new Config(data, p);
  }

  save() {
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    const tmp = this.path.replace(/\.[^./]*$/, '') + '.tmp';
    const data = { id: this.id, node: this.node, idle_timeout: this.idleTimeout, lights: this.lights };
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
  appId(override = null) {
    return override || process.env.ODELIC_ID || this.id;
  }

  /** Effective idle timeout: override > $ODELIC_IDLE_TIMEOUT > config > 60 s. 0 = stay connected. */
  idle(override = null) {
    for (const v of [override, process.env.ODELIC_IDLE_TIMEOUT, this.idleTimeout]) {
      const parsed = parseIdle(v);
      if (parsed !== null) return parsed;
    }
    return DEFAULT_IDLE_TIMEOUT;
  }

  // ------------------------------------------------------------ names
  nameOf(vaddr) {
    const hex = Buffer.from(vaddr).toString('hex');
    for (const [name, v] of Object.entries(this.lights)) if (v === hex) return name;
    return null;
  }

  /** light name / "all" / vaddr hex / Buffer -> 4-byte vaddr */
  resolve(target) {
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

  setName(name, target) {
    const v = this.resolve(target);
    if (v.equals(P.BROADCAST)) throw new InputError('cannot name the broadcast address');
    this.lights[name] = v.toString('hex');
  }

  removeName(name) {
    if (!Object.hasOwn(this.lights, name)) throw new InputError(`no light named ${JSON.stringify(name)}`);
    delete this.lights[name];
  }
}
