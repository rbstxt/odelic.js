/**
 * High-level controller shared by the CLI, the HTTP API and the MCP server.
 *
 * - connects lazily, serialises operations and reconnects once if the link dropped
 * - disconnects after `idleTimeout` seconds without commands, so the phone app can use the mesh again
 *   (0 = keep the link open)
 * - accepts light names from the config file ("living"), "all", or a raw vaddr ("00000000")
 */
import { InputError, LoginError } from './errors.ts';
import { log } from './log.ts';
import * as P from './protocol.ts';
import { OdelicMesh } from './client.ts';
import { Config } from './config.ts';

/** Where a command goes: a light name from the config, "all", or a vaddr. */
export type Target = P.VaddrLike;

export interface ActionResult {
  ok: true;
  action: string;
  target?: string;
  color?: number;
  brightness?: number;
  level?: number;
  group?: number;
  index?: number;
}

export interface LightInfo {
  name: string | null;
  vaddr: string;
  online: boolean;
  mac?: string;
  product?: number;
  version?: string;
}

export type LightStatus =
  | ({ name: string | null; online: true } & P.LightStateJSON)
  | { name: string | null; vaddr: string; online: false };

export interface ControllerInfo {
  connected: boolean;
  node: string | null;
  mode: 'keep' | 'idle';
  idle_timeout: number;
}

export interface ControllerOptions {
  /** BLE name / address of the node to connect through (default: config, else strongest node) */
  node?: string | null;
  config?: Config | null;
  /** seconds before an idle link is released; 0 = stay connected; null = $ODELIC_IDLE_TIMEOUT / config / 60 s */
  idleTimeout?: number | string | null;
  /** use this mesh connection instead of creating one (mainly for tests) */
  mesh?: OdelicMesh | null;
}

/** Integer from a number or numeric string (like Python's int()); throws InputError otherwise. */
export function toInt(v: unknown, what = 'value'): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new InputError(`${what} must be a number (got ${JSON.stringify(v)})`);
  return Math.trunc(n);
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const byVaddr = (a: P.Device, b: P.Device) => Buffer.compare(a.vaddr, b.vaddr);

export class Controller {
  readonly config: Config;
  readonly mesh: OdelicMesh;
  /** seconds; 0 = keep the link open */
  readonly idleTimeout: number;
  private queue: Promise<unknown> = Promise.resolve();
  private idle: NodeJS.Timeout | null = null;

  /** @param appId default: $ODELIC_ID / config file */
  constructor(appId: string | null = null, { node = null, config = null, idleTimeout = null, mesh = null }: ControllerOptions = {}) {
    this.config = config ?? Config.load();
    const aid = this.config.appId(appId);
    if (!aid && !mesh) throw new InputError('no app ID: pass --id, set ODELIC_ID, or run `odelic setup --id <ID>`');
    this.mesh = mesh ?? new OdelicMesh(aid, { device: node ?? this.config.node });
    this.idleTimeout = this.config.idle(idleTimeout);
  }

  // ------------------------------------------------------------ connection handling
  /** Run `fn` after every previously queued operation (a simple mutex). */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  private run<T>(fn: (mesh: OdelicMesh) => Promise<T>): Promise<T> {
    return this.locked(async () => {
      this.cancelIdle();
      try {
        for (let attempt = 0; ; attempt++) {
          if (!this.mesh.isConnected) await this.mesh.connect();
          try {
            return await fn(this.mesh);
          } catch (e) {
            // retry once when the BLE link dropped under us; input / login errors are final
            if (attempt || this.mesh.isConnected || e instanceof InputError || e instanceof LoginError) throw e;
            log.info(`link lost (${(e as Error).message}), reconnecting`);
            await this.mesh.disconnect();
          }
        }
      } finally {
        this.armIdle();
      }
    });
  }

  private cancelIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
  }

  private armIdle(): void {
    if (!this.idleTimeout || !this.mesh.isConnected) return;
    this.idle = setTimeout(() => {
      this.locked(async () => {
        this.idle = null;
        if (this.mesh.isConnected) {
          log.info('idle, disconnecting');
          await this.mesh.disconnect();
        }
      }).catch((e: Error) => log.warning(`idle disconnect failed: ${e.message}`));
    }, this.idleTimeout * 1000);
    this.idle.unref();
  }

  /** Connect now (otherwise the first command connects). */
  async connect(): Promise<void> {
    await this.run(async () => {});
  }

  async close(): Promise<void> {
    this.cancelIdle();
    await this.locked(() => this.mesh.disconnect());
  }

  get connected(): boolean {
    return this.mesh.isConnected;
  }

  get keepConnected(): boolean {
    return !this.idleTimeout;
  }

  info(): ControllerInfo {
    return { connected: this.connected, node: this.mesh.nodeName, mode: this.keepConnected ? 'keep' : 'idle', idle_timeout: this.idleTimeout };
  }

  // ------------------------------------------------------------ helpers
  private label(v: Buffer): string {
    return v.equals(P.BROADCAST) ? 'all' : (this.config.nameOf(v) ?? v.toString('hex'));
  }

  private done(action: string, v: Buffer, extra: Partial<ActionResult> = {}): ActionResult {
    return { ok: true, action, target: this.label(v), ...extra };
  }

  // ------------------------------------------------------------ actions
  async on(target: Target = 'all'): Promise<ActionResult> {
    const v = this.config.resolve(target);
    await this.run((m) => m.on(v));
    return this.done('on', v);
  }

  async off(target: Target = 'all'): Promise<ActionResult> {
    const v = this.config.resolve(target);
    await this.run((m) => m.off(v));
    return this.done('off', v);
  }

  /** color 0 (warm) .. 100 (cool), brightness 1..100 % */
  async setLight(target: Target = 'all', color: number | string = 50, brightness: number | string = 100): Promise<ActionResult> {
    const v = this.config.resolve(target);
    const c = clamp(toInt(color, 'color'), 0, 100);
    const b = clamp(toInt(brightness, 'brightness'), 1, 100);
    await this.run((m) => m.setLight({ color: c, brightness: b, target: v }));
    return this.done('light', v, { color: c, brightness: b });
  }

  async nightLight(target: Target = 'all', level: number | string = 0): Promise<ActionResult> {
    const v = this.config.resolve(target);
    const l = clamp(toInt(level, 'level'), 0, 2);
    await this.run((m) => m.nightLight(l, v));
    return this.done('night', v, { level: l });
  }

  /** action: "on", "off" or "light" (uses color / brightness) */
  async group(groupId: number | string, action = 'on', color: number | string = 50, brightness: number | string = 100): Promise<ActionResult> {
    const id = toInt(groupId, 'group id');
    if (action === 'light') {
      const c = clamp(toInt(color, 'color'), 0, 100);
      const b = clamp(toInt(brightness, 'brightness'), 1, 100);
      await this.run((m) => m.setGroup(id, { color: c, brightness: b }));
    } else if (action === 'on' || action === 'off') {
      await this.run((m) => m.setGroup(id, { on: action === 'on' }));
    } else {
      throw new InputError('action must be on, off or light');
    }
    return { ok: true, action: `group_${action}`, group: id };
  }

  async scene(index: number | string, save = false): Promise<ActionResult> {
    const i = toInt(index, 'scene index');
    await this.run((m) => (save ? m.saveScene(i) : m.playScene(i)));
    return { ok: true, action: save ? 'scene_save' : 'scene_play', index: i };
  }

  async changeColor(target: Target): Promise<ActionResult> {
    const v = this.config.resolve(target);
    await this.run((m) => m.changeColor(v));
    return this.done('change_color', v);
  }

  /** Lights answering a mesh ping, plus named lights that did not answer (online: false). */
  async lights(timeout = 3): Promise<LightInfo[]> {
    const devs = await this.run((m) => m.devices(timeout));
    const out: LightInfo[] = [];
    const seen = new Set<string>();
    for (const d of [...devs].sort(byVaddr)) {
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
  async status(target: Target = 'all'): Promise<LightStatus | LightStatus[]> {
    const v = this.config.resolve(target);
    if (v.equals(P.BROADCAST)) {
      const devs = await this.run((m) => m.devices());
      const out: LightStatus[] = [];
      for (const d of [...devs].sort(byVaddr)) out.push(await this.statusOf(d.vaddr));
      return out;
    }
    return this.statusOf(v);
  }

  private async statusOf(v: Buffer): Promise<LightStatus> {
    const st = await this.run((m) => m.status(v));
    if (st === null) return { name: this.config.nameOf(v), vaddr: v.toString('hex'), online: false };
    return { name: this.config.nameOf(v), online: true, ...st.toJSON() };
  }

  // ------------------------------------------------------------ names (no BLE needed)
  nameLight(name: string, target: Target): { ok: true; name: string; vaddr: string } {
    this.config.setName(name, target);
    this.config.save();
    return { ok: true, name, vaddr: this.config.lights[name] };
  }

  forgetName(name: string): { ok: true; removed: string } {
    this.config.removeName(name);
    this.config.save();
    return { ok: true, removed: name };
  }
}
