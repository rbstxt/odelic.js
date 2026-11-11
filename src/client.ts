/** BLE client for ODELIC lights (@stoprocent/noble). */
import { setTimeout as sleep } from 'node:timers/promises';
import type { Characteristic, Noble, Peripheral } from '@stoprocent/noble';

import { ConnectionError, InputError, LoginError } from './errors.ts';
import { log } from './log.ts';
import * as P from './protocol.ts';
import { MeshCrypto } from './crypto.ts';

export const UUID_SERVICE = '9e5d1e475c1343a0863582adffc0386f';
export const UUID_WRITE = '9e5d1e475c1343a0863582adffc1386f';
export const UUID_NOTIFY = '9e5d1e475c1343a0863582adffc2386f';

/** Called with every received (decrypted) packet. */
export type PacketListener = (packet: Buffer) => void;

/**
 * A noble `Peripheral`, typed structurally so that odelic's public types do not pull in noble's
 * declarations (which fail to type-check without `skipLibCheck`).
 */
export interface BlePeripheral {
  readonly id: string;
  readonly address: string;
  readonly rssi: number;
  readonly advertisement: { localName?: string; manufacturerData?: Buffer };
}

/** A mesh node found by {@link findNodes}. */
export interface MeshNode {
  peripheral: BlePeripheral;
  name: string | null;
  address: string;
  homeid: number;
  rssi: number;
}

let noblePromise: Promise<Noble> | null = null;

/** The noble instance, loaded on first use so that importing odelic never touches Bluetooth. */
function getNoble(): Promise<Noble> {
  noblePromise ??= import('@stoprocent/noble').then((m) => m.default);
  return noblePromise;
}

async function poweredOn(noble: Noble, timeout = 10): Promise<void> {
  try {
    await noble.waitForPoweredOnAsync(timeout * 1000);
  } catch (e) {
    throw new ConnectionError(`Bluetooth is not available (state: ${noble.state}); ` +
      'turn Bluetooth on and allow this terminal to use it', { cause: e });
  }
}

function withTimeout<T>(promise: Promise<T>, seconds: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ConnectionError(message)), seconds * 1000);
  });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[-:]/g, '');

/**
 * Scan for mesh nodes, sorted by signal strength (strongest first).
 * @param opts.homeid only nodes of this mesh
 * @param opts.timeout scan duration in seconds
 */
export async function findNodes({ homeid = null, timeout = 8 }: { homeid?: number | null; timeout?: number } = {}): Promise<MeshNode[]> {
  const noble = await getNoble();
  await poweredOn(noble);
  const found = new Map<string, MeshNode>();
  const onDiscover = (p: Peripheral) => {
    const hid = P.advHomeid(p.advertisement?.manufacturerData);
    if (hid === null || (homeid !== null && hid !== homeid)) return;
    found.set(p.id, {
      peripheral: p,
      name: p.advertisement?.localName || null,
      address: p.address && p.address !== 'unknown' ? p.address : p.id,
      homeid: hid,
      rssi: p.rssi,
    });
  };
  noble.on('discover', onDiscover);
  try {
    await noble.startScanningAsync([], true);
    await sleep(timeout * 1000);
  } finally {
    noble.removeListener('discover', onDiscover);
    await noble.stopScanningAsync().catch(() => {});
  }
  return [...found.values()].sort((a, b) => b.rssi - a.rssi);
}

/** Tiny async FIFO used while logging in. */
class Inbox<T> {
  private items: T[] = [];
  private waiters: ((v: T) => void)[] = [];

  push(v: T): void {
    const w = this.waiters.shift();
    if (w) w(v);
    else this.items.push(v);
  }

  next(): Promise<T> {
    if (this.items.length) return Promise.resolve(this.items.shift() as T);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

export interface OdelicMeshOptions {
  /** HomeID (instead of `appId`) */
  homeid?: number;
  /** 4-character password (instead of `appId`) */
  password?: string;
  /** noble Peripheral, or a node name / address / id; default = strongest node of the mesh */
  device?: BlePeripheral | string | null;
  /** scan duration in seconds when looking for a node */
  scanTimeout?: number;
}

export interface SetLightOptions {
  /** 0 = warm (電球色) .. 100 = cool (昼光色); default 50 */
  color?: number | null;
  /** 1..100 % (default 100) */
  brightness?: number;
  /** default: every light */
  target?: P.VaddrLike;
  /** raw colour 0..20 (overrides `color`) */
  x?: number | null;
  /** raw brightness 0..19, 0 = brightest (overrides `brightness`) */
  y?: number | null;
}

export interface SetGroupOptions extends Omit<SetLightOptions, 'target'> {
  /** true / false = plain on / off (ignores colour and brightness) */
  on?: boolean | null;
}

/**
 * One logged-in connection to an ODELIC mesh.
 *
 * ```ts
 * const mesh = new OdelicMesh('12345678');
 * await mesh.connect();
 * await mesh.setLight({ color: 0, brightness: 100 });   // warm, full
 * await mesh.off();
 * await mesh.disconnect();
 * ```
 */
export class OdelicMesh {
  readonly homeid: number;
  readonly crypto: MeshCrypto;
  device: BlePeripheral | string | null;
  scanTimeout: number;
  /** our vaddr in the mesh (assigned at login) */
  own: Buffer | null = null;
  nodeName: string | null = null;
  private peripheral: Peripheral | null = null;
  private writeChar: Characteristic | null = null;
  private notifyChar: Characteristic | null = null;
  private inbox: Inbox<Buffer> | null = null;
  private seg: Buffer[] = [];
  private segSeq = 0;
  private readonly listeners = new Set<PacketListener>();

  /** @param appId ID shown in the app, e.g. "12345678" (or pass `homeid` + `password`) */
  constructor(appId: string | null = null, { homeid, password, device = null, scanTimeout = 8 }: OdelicMeshOptions = {}) {
    if (appId !== null && appId !== undefined) ({ homeid, password } = P.parseAppId(appId));
    if (homeid === undefined || password === undefined) {
      throw new InputError("give appId (e.g. '12345678') or homeid + password");
    }
    this.homeid = homeid;
    this.crypto = new MeshCrypto(homeid, password);
    this.device = device;
    this.scanTimeout = scanTimeout;
  }

  // ------------------------------------------------------------ connection
  private async resolveDevice(): Promise<Peripheral> {
    if (this.device !== null && typeof this.device !== 'string') return this.device as Peripheral;
    let nodes = await findNodes({ homeid: this.homeid, timeout: this.scanTimeout });
    if (typeof this.device === 'string') {
      const want = norm(this.device);
      nodes = nodes.filter((n) => [n.name, n.address, n.peripheral.id].some((v) => v && norm(v) === want));
    }
    if (!nodes.length) throw new ConnectionError(`no mesh node with HomeID ${this.homeid} found`);
    log.info(`using node ${nodes[0].name} (${nodes[0].address}) rssi ${nodes[0].rssi}`);
    return nodes[0].peripheral as Peripheral;
  }

  /** Scan (unless a peripheral was given), connect and log in. `timeout` in seconds. */
  async connect(timeout = 10): Promise<void> {
    const p = await this.resolveDevice();
    await poweredOn(await getNoble());
    this.nodeName = p.advertisement?.localName || p.id;
    this.own = null;
    this.inbox = new Inbox();
    this.peripheral = p;
    p.on('disconnect', this.onDisconnect);
    try {
      await withTimeout(p.connectAsync(), timeout, `could not connect to ${this.nodeName}`);
      const { characteristics } = await withTimeout(
        p.discoverSomeServicesAndCharacteristicsAsync([UUID_SERVICE], [UUID_WRITE, UUID_NOTIFY]),
        timeout, 'GATT discovery timed out');
      this.writeChar = characteristics.find((c) => norm(c.uuid) === UUID_WRITE) ?? null;
      this.notifyChar = characteristics.find((c) => norm(c.uuid) === UUID_NOTIFY) ?? null;
      if (!this.writeChar || !this.notifyChar) throw new ConnectionError(`${this.nodeName} is not an ODELIC mesh node`);
      this.notifyChar.on('data', this.onNotify);
      await this.notifyChar.subscribeAsync();
      await this.write(Buffer.from([0x01, 0x20])); // ask for the login challenge
      await withTimeout(this.login(this.inbox), timeout, 'login timed out');
    } catch (e) {
      await this.disconnect();
      throw e;
    } finally {
      this.inbox = null;
    }
  }

  get isConnected(): boolean {
    return this.peripheral !== null && this.peripheral.state === 'connected' && this.own !== null;
  }

  private readonly onDisconnect = (): void => {
    log.info('node disconnected');
    this.own = null;
  };

  async disconnect(): Promise<void> {
    const p = this.peripheral;
    if (!p) return;
    this.peripheral = null;
    this.own = null;
    p.removeListener('disconnect', this.onDisconnect);
    this.notifyChar?.removeListener('data', this.onNotify);
    this.writeChar = this.notifyChar = null;
    try {
      await withTimeout(p.disconnectAsync(), 5, 'disconnect timed out');
    } catch (e) {
      log.debug(`disconnect: ${(e as Error).message}`);
    }
  }

  private async login(inbox: Inbox<Buffer>): Promise<void> {
    for (;;) {
      const p = await inbox.next();
      if (p[0] === 0x02 && p[1] === 0x20 && p.length >= 18) {
        await this.write(this.crypto.answerChallenge(p.subarray(2, 18)));
      } else if (p[0] === 0x02 && p[1] === 0x16) {
        if (p.length >= 3 && p[2] === 0x08) {
          throw new LoginError('node is already in use by another controller ' +
            '(close the ODELIC app / turn off phone Bluetooth and retry)');
        }
        if (p.length < 3 || p[2] !== 0) throw new LoginError(`login rejected (status ${p.subarray(2).toString('hex')})`);
      } else if (p[0] === 0x01 && p[1] === 0x0a && p.length >= 6) {
        this.own = Buffer.from(p.subarray(2, 6));
      }
      if (this.own !== null) return;
    }
  }

  // ------------------------------------------------------------ transport
  private async write(data: Buffer): Promise<void> {
    if (!this.writeChar) throw new ConnectionError('not connected');
    log.debug(`-> ${data.toString('hex')}`);
    await this.writeChar.writeAsync(data, true); // write without response
  }

  private readonly onNotify = (raw: Buffer): void => {
    let data: Buffer = Buffer.from(raw);
    log.debug(`<- ${data.toString('hex')}`);
    if (data.length >= 3 && data[0] === 4 && data[1] === 4) { // segmented PDU
      const seq = data[2] & 0x0f;
      const total = data[2] >> 4;
      if (seq !== this.segSeq + 1) {
        this.seg = [];
        this.segSeq = 0;
        return;
      }
      this.seg.push(data.subarray(3));
      this.segSeq = seq;
      if (seq !== total) return;
      data = Buffer.concat(this.seg);
      this.seg = [];
      this.segSeq = 0;
    }
    try {
      data = this.crypto.decrypt(data);
    } catch {
      log.debug(`undecryptable packet ${data.toString('hex')}`);
      return;
    }
    this.inbox?.push(data);
    for (const cb of [...this.listeners]) {
      try {
        cb(data);
      } catch (e) {
        log.error('listener failed:', e);
      }
    }
  };

  private requireOwn(): Buffer {
    if (this.own === null) throw new LoginError('not connected');
    return this.own;
  }

  /** Encrypt and send a type-3 data-event packet (see protocol.ts). */
  async send(packet: Uint8Array): Promise<void> {
    this.requireOwn();
    const enc = this.crypto.encrypt(packet);
    const mtu = Math.max(20, (this.peripheral?.mtu ?? 23) - 3);
    if (enc.length <= mtu) return this.write(enc);
    const chunk = mtu - 3;
    const total = Math.ceil(enc.length / chunk);
    for (let i = 0; i < total; i++) {
      await this.write(Buffer.concat([Buffer.from([0x01, 0x21, (total << 4) | (i + 1)]),
        enc.subarray(i * chunk, (i + 1) * chunk)]));
      await sleep(15);
    }
  }

  /** Receive every (decrypted) packet. Returns an unsubscribe function. */
  addListener(callback: PacketListener): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  removeListener(callback: PacketListener): void {
    this.listeners.delete(callback);
  }

  // ------------------------------------------------------------ actions
  /** Turn on (restores the previous colour/brightness). */
  async on(target: P.VaddrLike = P.BROADCAST): Promise<void> {
    await this.send(P.light(this.requireOwn(), P.vaddr(target), ...P.XY_ON));
  }

  async off(target: P.VaddrLike = P.BROADCAST): Promise<void> {
    await this.send(P.light(this.requireOwn(), P.vaddr(target), ...P.XY_OFF));
  }

  /** Turn on with a colour and brightness (or raw x / y). */
  async setLight({ color = null, brightness = 100, target = P.BROADCAST, x = null, y = null }: SetLightOptions = {}): Promise<void> {
    x ??= P.colorToX(color ?? 50);
    y ??= P.brightnessToY(brightness);
    await this.send(P.light(this.requireOwn(), P.vaddr(target), x, y));
  }

  /** Dim warm night light, level 0..2 (what the app does for plain lights). */
  async nightLight(level = 0, target: P.VaddrLike = P.BROADCAST): Promise<void> {
    await this.send(P.light(this.requireOwn(), P.vaddr(target), 0, 17 + Math.max(0, Math.min(2, level))));
  }

  /** Same as setLight but for a group id (as configured in the app). */
  async setGroup(groupId: number, { color = null, brightness = 100, x = null, y = null, on = null }: SetGroupOptions = {}): Promise<void> {
    if (on !== null) [x, y] = on ? P.XY_ON : P.XY_OFF;
    x ??= P.colorToX(color ?? 50);
    y ??= P.brightnessToY(brightness);
    await this.send(P.groupLight(this.requireOwn(), groupId, x, y));
  }

  /** Cycle the colour preset of one light (light_change_color). */
  async changeColor(target: P.VaddrLike): Promise<void> {
    await this.send(P.changeColor(this.requireOwn(), P.vaddr(target)));
  }

  async saveScene(index: number): Promise<void> {
    await this.send(P.scene(this.requireOwn(), index, true));
  }

  async playScene(index: number): Promise<void> {
    await this.send(P.scene(this.requireOwn(), index, false));
  }

  /** Ping the whole mesh and return the responding lights (`timeout` in seconds). */
  async devices(timeout = 3): Promise<P.Device[]> {
    const found = new Map<string, P.Device>();
    const off = this.addListener((p) => {
      const d = P.parsePingResponse(p);
      if (d) found.set(d.vaddr.toString('hex'), d);
    });
    try {
      await this.send(P.pingAll(this.requireOwn()));
      await sleep(timeout * 1000);
    } finally {
      off();
    }
    return [...found.values()];
  }

  /** Ask one light for its state. Resolves to null on timeout (`timeout` in seconds). */
  async status(target: P.VaddrLike, timeout = 3): Promise<P.LightState | null> {
    const dst = P.vaddr(target);
    let off = () => {};
    let timer: NodeJS.Timeout | undefined;
    const reply = new Promise<P.LightState | null>((resolve) => {
      off = this.addListener((p) => {
        const st = P.parseStatus(p);
        if (st && st.vaddr.equals(dst)) resolve(st);
      });
      timer = setTimeout(() => resolve(null), timeout * 1000);
    });
    try {
      await this.send(P.statusRequest(this.requireOwn(), dst));
      return await reply;
    } finally {
      clearTimeout(timer);
      off();
    }
  }
}
