/**
 * High-level controller shared by the CLI, the HTTP API and the MCP server.
 *
 * - connects lazily, serialises operations and reconnects once if the link dropped
 * - disconnects after `idleTimeout` seconds without commands, so the phone app can use the mesh again
 *   (0 = keep the link open)
 * - accepts light names from the config file ("living"), "all", or a raw vaddr ("00000000")
 */
import { InputError, LoginError } from './errors.js';
import { log } from './log.js';
import * as P from './protocol.js';
import { OdelicMesh } from './client.js';
import { Config } from './config.js';

/** Integer from a number or numeric string (like Python's int()); throws InputError otherwise. */
export function toInt(v, what = 'value') {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new InputError(`${what} must be a number (got ${JSON.stringify(v)})`);
  return Math.trunc(n);
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const cmpBuf = (a, b) => Buffer.compare(a.vaddr, b.vaddr);

export class Controller {
  /**
   * @param {string|null} [appId] default: $ODELIC_ID / config file
   * @param {{node?: string|null, config?: Config, idleTimeout?: number|string|null, mesh?: OdelicMesh}} [opts]
   *        idleTimeout: seconds before an idle link is released; 0 = stay connected;
   *        null = $ODELIC_IDLE_TIMEOUT / config file / 60 s.
   */
  constructor(appId = null, { node = null, config = null, idleTimeout = null, mesh = null } = {}) {
    this.config = config ?? Config.load();
    const aid = this.config.appId(appId);
    if (!aid && !mesh) throw new InputError('no app ID: pass --id, set ODELIC_ID, or run `odelic setup --id <ID>`');
    this.mesh = mesh ?? new OdelicMesh(aid, { device: node ?? this.config.node });
    this.idleTimeout = this.config.idle(idleTimeout);
    this._queue = Promise.resolve();
    this._idle = null;
  }

  // ------------------------------------------------------------ connection handling
  /** Run `fn` after every previously queued operation (a simple mutex). */
  _locked(fn) {
    const run = this._queue.then(fn);
    this._queue = run.catch(() => {});
    return run;
  }

  _run(fn) {
    return this._locked(async () => {
      this._cancelIdle();
      try {
        for (let attempt = 0; ; attempt++) {
          if (!this.mesh.isConnected) await this.mesh.connect();
          try {
            return await fn(this.mesh);
          } catch (e) {
            // retry once when the BLE link dropped under us; input / login errors are final
            if (attempt || this.mesh.isConnected || e instanceof InputError || e instanceof LoginError) throw e;
            log.info(`link lost (${e.message}), reconnecting`);
            await this.mesh.disconnect();
          }
        }
      } finally {
        this._armIdle();
      }
    });
  }

  _cancelIdle() {
    if (this._idle) clearTimeout(this._idle);
    this._idle = null;
  }

  _armIdle() {
    if (!this.idleTimeout || !this.mesh.isConnected) return;
    this._idle = setTimeout(() => {
      this._locked(async () => {
        this._idle = null;
        if (this.mesh.isConnected) {
          log.info('idle, disconnecting');
          await this.mesh.disconnect();
        }
      }).catch((e) => log.warning(`idle disconnect failed: ${e.message}`));
    }, this.idleTimeout * 1000);
    this._idle.unref?.();
  }

  /** Connect now (otherwise the first command connects). */
  async connect() {
    await this._run(async () => {});
  }

  async close() {
    this._cancelIdle();
    await this._locked(() => this.mesh.disconnect());
  }

  get connected() {
    return this.mesh.isConnected;
  }

  get keepConnected() {
    return !this.idleTimeout;
  }

  info() {
    return { connected: this.connected, node: this.mesh.nodeName, mode: this.keepConnected ? 'keep' : 'idle', idle_timeout: this.idleTimeout };
  }

  // ------------------------------------------------------------ helpers
  _label(v) {
    return v.equals(P.BROADCAST) ? 'all' : (this.config.nameOf(v) ?? v.toString('hex'));
  }

  _done(action, v, extra = {}) {
    return { ok: true, action, target: this._label(v), ...extra };
  }

  // ------------------------------------------------------------ actions
  async on(target = 'all') {
    const v = this.config.resolve(target);
    await this._run((m) => m.on(v));
    return this._done('on', v);
  }

  async off(target = 'all') {
    const v = this.config.resolve(target);
    await this._run((m) => m.off(v));
    return this._done('off', v);
  }

  /** color 0 (warm) .. 100 (cool), brightness 1..100 % */
  async setLight(target = 'all', color = 50, brightness = 100) {
    const v = this.config.resolve(target);
    color = clamp(toInt(color, 'color'), 0, 100);
    brightness = clamp(toInt(brightness, 'brightness'), 1, 100);
    await this._run((m) => m.setLight({ color, brightness, target: v }));
    return this._done('light', v, { color, brightness });
  }

  async nightLight(target = 'all', level = 0) {
    const v = this.config.resolve(target);
    level = clamp(toInt(level, 'level'), 0, 2);
    await this._run((m) => m.nightLight(level, v));
    return this._done('night', v, { level });
  }

  /** action: "on", "off" or "light" (uses color / brightness) */
  async group(groupId, action = 'on', color = 50, brightness = 100) {
    const id = toInt(groupId, 'group id');
    if (action === 'light') {
      const c = clamp(toInt(color, 'color'), 0, 100);
      const b = clamp(toInt(brightness, 'brightness'), 1, 100);
      await this._run((m) => m.setGroup(id, { color: c, brightness: b }));
    } else if (action === 'on' || action === 'off') {
      await this._run((m) => m.setGroup(id, { on: action === 'on' }));
    } else {
      throw new InputError('action must be on, off or light');
    }
    return { ok: true, action: `group_${action}`, group: id };
  }

  async scene(index, save = false) {
    const i = toInt(index, 'scene index');
    await this._run((m) => (save ? m.saveScene(i) : m.playScene(i)));
    return { ok: true, action: save ? 'scene_save' : 'scene_play', index: i };
  }

  async changeColor(target) {
    const v = this.config.resolve(target);
    await this._run((m) => m.changeColor(v));
    return this._done('change_color', v);
  }

  /** Lights answering a mesh ping, plus named lights that did not answer (online: false). */
  async lights(timeout = 3) {
    const devs = await this._run((m) => m.devices(timeout));
    const out = [];
    const seen = new Set();
    for (const d of [...devs].sort(cmpBuf)) {
      const hex = d.vaddr.toString('hex');
      seen.add(hex);
      out.push({ name: this.config.nameOf(d.vaddr), vaddr: hex, online: true, mac: d.mac, product: d.product, version: d.version });
    }
    for (const [name, v] of Object.entries(this.config.lights)) {
      if (!seen.has(v)) out.push({ name, vaddr: v, online: false });
    }
    return out;
  }

  /** State of one light, or of every responding light for "all". */
  async status(target = 'all') {
    const v = this.config.resolve(target);
    if (v.equals(P.BROADCAST)) {
      const devs = await this._run((m) => m.devices());
      const out = [];
      for (const d of [...devs].sort(cmpBuf)) out.push(await this.status(d.vaddr));
      return out;
    }
    const st = await this._run((m) => m.status(v));
    if (st === null) return { name: this.config.nameOf(v), vaddr: v.toString('hex'), online: false };
    return { name: this.config.nameOf(v), online: true, ...st.toJSON() };
  }

  // ------------------------------------------------------------ names (no BLE needed)
  nameLight(name, target) {
    this.config.setName(name, target);
    this.config.save();
    return { ok: true, name, vaddr: this.config.lights[name] };
  }

  forgetName(name) {
    this.config.removeName(name);
    this.config.save();
    return { ok: true, removed: name };
  }
}
