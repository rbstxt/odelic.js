/** BLE client for ODELIC lights (@stoprocent/noble). */
import { setTimeout as sleep } from 'node:timers/promises';

import { ConnectionError, InputError, LoginError } from './errors.js';
import { log } from './log.js';
import * as P from './protocol.js';
import { MeshCrypto } from './crypto.js';

export const UUID_SERVICE = '9e5d1e475c1343a0863582adffc0386f';
export const UUID_WRITE = '9e5d1e475c1343a0863582adffc1386f';
export const UUID_NOTIFY = '9e5d1e475c1343a0863582adffc2386f';

let noblePromise = null;

/** The noble instance, loaded on first use so that importing odelic never touches Bluetooth. */
export function getNoble() {
  noblePromise ??= import('@stoprocent/noble').then((m) => m.default ?? m);
  return noblePromise;
}

async function poweredOn(noble, timeout = 10) {
  try {
    await noble.waitForPoweredOnAsync(timeout * 1000);
  } catch (e) {
    throw new ConnectionError(`Bluetooth is not available (state: ${noble.state}); ` +
      'turn Bluetooth on and allow this terminal to use it', { cause: e });
  }
}

function withTimeout(promise, seconds, message) {
  let timer;
  const t = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ConnectionError(message)), seconds * 1000);
  });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/[-:]/g, '');

/**
 * Scan for mesh nodes.
 * @param {{homeid?: number|null, timeout?: number}} [opts] timeout in seconds
 * @returns {Promise<Array<{peripheral: any, name: string|null, address: string, homeid: number, rssi: number}>>}
 *          sorted by signal strength (strongest first)
 */
export async function findNodes({ homeid = null, timeout = 8 } = {}) {
  const noble = await getNoble();
  await poweredOn(noble);
  const found = new Map();
  const onDiscover = (p) => {
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
class Inbox {
  constructor() {
    this.items = [];
    this.waiters = [];
  }

  push(v) {
    const w = this.waiters.shift();
    if (w) w(v);
    else this.items.push(v);
  }

  next() {
    if (this.items.length) return Promise.resolve(this.items.shift());
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

/**
 * One logged-in connection to an ODELIC mesh.
 *
 *     const mesh = new OdelicMesh('12345678');
 *     await mesh.connect();
 *     await mesh.setLight({ color: 0, brightness: 100 });   // warm, full
 *     await mesh.off();
 *     await mesh.disconnect();
 */
export class OdelicMesh {
  /**
   * @param {string|null} appId ID shown in the app, e.g. "12345678" (or pass homeid + password)
   * @param {{homeid?: number, password?: string, device?: any, scanTimeout?: number}} [opts]
   *        device: noble Peripheral, or a node name / address / id; default = strongest node of the mesh
   */
  constructor(appId = null, { homeid, password, device = null, scanTimeout = 8 } = {}) {
    if (appId !== null && appId !== undefined) ({ homeid, password } = P.parseAppId(appId));
    if (homeid === undefined || homeid === null || password === undefined || password === null) {
      throw new InputError("give appId (e.g. '12345678') or homeid + password");
    }
    this.homeid = homeid;
    this.crypto = new MeshCrypto(homeid, password);
    this.device = device;
    this.scanTimeout = scanTimeout;
    /** our vaddr in the mesh (assigned at login) */
    this.own = null;
    this.nodeName = null;
    this._peripheral = null;
    this._write = null;
    this._notify = null;
    this._inbox = null;
    this._seg = [];
    this._segSeq = 0;
    this._listeners = new Set();
    this._onNotify = this._onNotify.bind(this);
    this._onDisconnect = this._onDisconnect.bind(this);
  }

  // ------------------------------------------------------------ connection
  async _resolveDevice() {
    if (this.device !== null && typeof this.device !== 'string') return this.device;
    let nodes = await findNodes({ homeid: this.homeid, timeout: this.scanTimeout });
    if (typeof this.device === 'string') {
      const want = norm(this.device);
      nodes = nodes.filter((n) => [n.name, n.address, n.peripheral.id].some((v) => v && norm(v) === want));
    }
    if (!nodes.length) throw new ConnectionError(`no mesh node with HomeID ${this.homeid} found`);
    log.info(`using node ${nodes[0].name} (${nodes[0].address}) rssi ${nodes[0].rssi}`);
    return nodes[0].peripheral;
  }

  /** Scan (unless a peripheral was given), connect and log in. `timeout` in seconds. */
  async connect(timeout = 10) {
    const p = await this._resolveDevice();
    await poweredOn(await getNoble());
    this.nodeName = p.advertisement?.localName || p.id;
    this.own = null;
    this._inbox = new Inbox();
    this._peripheral = p;
    p.on('disconnect', this._onDisconnect);
    try {
      await withTimeout(p.connectAsync(), timeout, `could not connect to ${this.nodeName}`);
      const { characteristics } = await withTimeout(
        p.discoverSomeServicesAndCharacteristicsAsync([UUID_SERVICE], [UUID_WRITE, UUID_NOTIFY]),
        timeout, 'GATT discovery timed out');
      this._write = characteristics.find((c) => norm(c.uuid) === UUID_WRITE);
      this._notify = characteristics.find((c) => norm(c.uuid) === UUID_NOTIFY);
      if (!this._write || !this._notify) throw new ConnectionError(`${this.nodeName} is not an ODELIC mesh node`);
      this._notify.on('data', this._onNotify);
      await this._notify.subscribeAsync();
      await this._send(Buffer.from([0x01, 0x20])); // ask for the login challenge
      await withTimeout(this._login(), timeout, 'login timed out');
    } catch (e) {
      await this.disconnect();
      throw e;
    } finally {
      this._inbox = null;
    }
  }

  get isConnected() {
    return this._peripheral !== null && this._peripheral.state === 'connected' && this.own !== null;
  }

  _onDisconnect() {
    log.info('node disconnected');
    this.own = null;
  }

  async disconnect() {
    const p = this._peripheral;
    if (!p) return;
    this._peripheral = null;
    this.own = null;
    p.removeListener('disconnect', this._onDisconnect);
    if (this._notify) this._notify.removeListener('data', this._onNotify);
    this._write = this._notify = null;
    try {
      await withTimeout(p.disconnectAsync(), 5, 'disconnect timed out');
    } catch (e) {
      log.debug(`disconnect: ${e.message}`);
    }
  }

  async _login() {
    const inbox = this._inbox;
    for (;;) {
      const p = await inbox.next();
      if (p[0] === 0x02 && p[1] === 0x20 && p.length >= 18) {
        await this._send(this.crypto.answerChallenge(p.subarray(2, 18)));
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
  async _send(data) {
    if (!this._write) throw new ConnectionError('not connected');
    log.debug(`-> ${data.toString('hex')}`);
    await this._write.writeAsync(data, true); // write without response
  }

  _onNotify(data) {
    data = Buffer.from(data);
    log.debug(`<- ${data.toString('hex')}`);
    if (data.length >= 3 && data[0] === 4 && data[1] === 4) { // segmented PDU
      const seq = data[2] & 0x0f;
      const total = data[2] >> 4;
      if (seq !== this._segSeq + 1) {
        this._seg = [];
        this._segSeq = 0;
        return;
      }
      this._seg.push(data.subarray(3));
      this._segSeq = seq;
      if (seq !== total) return;
      data = Buffer.concat(this._seg);
      this._seg = [];
      this._segSeq = 0;
    }
    try {
      data = this.crypto.decrypt(data);
    } catch {
      log.debug(`undecryptable packet ${data.toString('hex')}`);
      return;
    }
    this._inbox?.push(data);
    for (const cb of [...this._listeners]) {
      try {
        cb(data);
      } catch (e) {
        log.error('listener failed:', e);
      }
    }
  }

  /** Encrypt and send a type-3 data-event packet (see protocol.js). */
  async send(packet) {
    if (this.own === null) throw new LoginError('not connected');
    const enc = this.crypto.encrypt(packet);
    const mtu = Math.max(20, (this._peripheral?.mtu ?? 23) - 3);
    if (enc.length <= mtu) return this._send(enc);
    const chunk = mtu - 3;
    const total = Math.ceil(enc.length / chunk);
    for (let i = 0; i < total; i++) {
      await this._send(Buffer.concat([Buffer.from([0x01, 0x21, (total << 4) | (i + 1)]),
        enc.subarray(i * chunk, (i + 1) * chunk)]));
      await sleep(15);
    }
  }

  /** `callback(packet: Buffer)` for every received (decrypted) packet. Returns an unsubscribe function. */
  addListener(callback) {
    this._listeners.add(callback);
    return () => this._listeners.delete(callback);
  }

  removeListener(callback) {
    this._listeners.delete(callback);
  }

  // ------------------------------------------------------------ actions
  /** Turn on (restores the previous colour/brightness). */
  async on(target = P.BROADCAST) {
    await this.send(P.light(this.own, P.vaddr(target), ...P.XY_ON));
  }

  async off(target = P.BROADCAST) {
    await this.send(P.light(this.own, P.vaddr(target), ...P.XY_OFF));
  }

  /**
   * color: 0 = warm (電球色) .. 100 = cool (昼光色); brightness: 1..100 %.
   * Or pass raw x (0..20) / y (0..19, 0 = brightest).
   */
  async setLight({ color = null, brightness = 100, target = P.BROADCAST, x = null, y = null } = {}) {
    x ??= P.colorToX(color ?? 50);
    y ??= P.brightnessToY(brightness);
    await this.send(P.light(this.own, P.vaddr(target), x, y));
  }

  /** Dim warm night light, level 0..2 (what the app does for plain lights). */
  async nightLight(level = 0, target = P.BROADCAST) {
    await this.send(P.light(this.own, P.vaddr(target), 0, 17 + Math.max(0, Math.min(2, level))));
  }

  /** Same as setLight but for a group id (as configured in the app). on: true/false for on/off. */
  async setGroup(groupId, { color = null, brightness = 100, x = null, y = null, on = null } = {}) {
    if (on !== null) [x, y] = on ? P.XY_ON : P.XY_OFF;
    x ??= P.colorToX(color ?? 50);
    y ??= P.brightnessToY(brightness);
    await this.send(P.groupLight(this.own, groupId, x, y));
  }

  /** Cycle the colour preset of one light (light_change_color). */
  async changeColor(target) {
    await this.send(P.changeColor(this.own, P.vaddr(target)));
  }

  async saveScene(index) {
    await this.send(P.scene(this.own, index, true));
  }

  async playScene(index) {
    await this.send(P.scene(this.own, index, false));
  }

  /** Ping the whole mesh and return the responding lights (`timeout` in seconds). */
  async devices(timeout = 3) {
    const found = new Map();
    const off = this.addListener((p) => {
      const d = P.parsePingResponse(p);
      if (d) found.set(d.vaddr.toString('hex'), d);
    });
    try {
      await this.send(P.pingAll(this.own));
      await sleep(timeout * 1000);
    } finally {
      off();
    }
    return [...found.values()];
  }

  /** Ask one light (vaddr) for its state. Resolves to a LightState, or null on timeout. */
  async status(target, timeout = 3) {
    const dst = P.vaddr(target);
    let off;
    let timer;
    const reply = new Promise((resolve) => {
      off = this.addListener((p) => {
        const st = P.parseStatus(p);
        if (st && st.vaddr.equals(dst)) resolve(st);
      });
      timer = setTimeout(() => resolve(null), timeout * 1000);
    });
    try {
      await this.send(P.statusRequest(this.own, dst));
      return await reply;
    } finally {
      clearTimeout(timer);
      off();
    }
  }
}
