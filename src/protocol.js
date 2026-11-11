/**
 * Packet builders/parsers for ODELIC lights on the Pairlink mesh.
 *
 * Mirrors jp.co.odelic.smt.remote03.act.module.ControllerAct in "central" (Tiger) mode:
 *     03 <dst vaddr 4B> <channel> <own vaddr 4B> <msg id> <args...>
 */
import { InputError } from './errors.js';

export const BROADCAST = Buffer.from([0xff, 0xff, 0xff, 0xff]);

// channels
export const CH_TO_LIGHT = 0x20;
export const CH_TO_LIGHT_BROADCAST = 0x2a;
export const CH_PING = 0xfe;
export const CH_PING_RESPONSE = 0xff;

// message ids (MeshProfile.DATAEVENT_MSGID_*)
export const MSG_LIGHT = 0xc0; //         SM_BRIGHT_LIGHT
export const MSG_LIGHT_GROUP = 0xc1; //   SM_BRIGHT_LIGHT_GROUP
export const MSG_CHANGE_COLOR = 0xe2; //  SM_CHANGE_COLOR (cycle colour preset)
export const MSG_SCENE_SAVE = 0x40; //    SM_SCENE_IN
export const MSG_SCENE_PLAY = 0x42; //    SM_SCENE_PLAY
export const MSG_STATUS = 0x70; //        SM_STATUS
export const MSG_STATUS_RESPONSES = [0x71, 0x35]; // STATUS_MAIN / STATE_RESPONSE_FD

// special (x, y) pairs
export const XY_ON = [55, 55];
export const XY_OFF = [50, 50];

export const X_MAX = 20; // colour: 0 = warm (電球色) ... 20 = cool (昼光色)
export const Y_MAX = 19; // brightness: 0 = brightest ... 19 = dimmest

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** 0 (warmest) .. 100 (coolest) -> x 0..20 */
export function colorToX(color) {
  return clamp(Math.round((color * X_MAX) / 100), 0, X_MAX);
}

/** 1..100 % -> y 19..0 (same rule as the app: (100 - b) / 5, clamped) */
export function brightnessToY(brightness) {
  return clamp(Math.floor((100 - brightness) / 5), 0, Y_MAX);
}

/** 4-byte vaddr from a Buffer/Uint8Array, a number (little endian) or a hex string ("00000000", "00:00:00:00"). */
export function vaddr(v) {
  let b;
  if (v instanceof Uint8Array) {
    b = Buffer.from(v);
  } else if (typeof v === 'number') {
    if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new InputError(`vaddr out of range: ${v}`);
    b = Buffer.alloc(4);
    b.writeUInt32LE(v);
  } else {
    const s = String(v).replace(/:/g, '');
    if (!/^[0-9a-fA-F]*$/.test(s) || s.length % 2) throw new InputError(`invalid vaddr: ${v}`);
    b = Buffer.from(s, 'hex');
  }
  if (b.length !== 4) throw new InputError('vaddr must be 4 bytes');
  return b;
}

/** Concatenate Buffers and byte arrays; like Python's bytes(), array values must be integers 0..255. */
function bytes(...parts) {
  return Buffer.concat(parts.map((p) => {
    if (Buffer.isBuffer(p)) return p;
    for (const v of p) {
      if (!Number.isInteger(v) || v < 0 || v > 255) throw new InputError(`byte value out of range: ${v}`);
    }
    return Buffer.from(p);
  }));
}

export function dataEvent(dst, channel, payload) {
  return bytes([0x03], dst, [channel], payload);
}

/** ControllerAct.setlight: on/off/colour/brightness for one light or all (broadcast). */
export function light(own, dst, x, y, index = 0) {
  const ch = dst.equals(BROADCAST) ? CH_TO_LIGHT_BROADCAST : CH_TO_LIGHT;
  return dataEvent(dst, ch, bytes(own, [MSG_LIGHT, index, x, y, 0, 0, 0, 0]));
}

/** ControllerAct.sendgroup_new */
export function groupLight(own, groupId, x, y) {
  return dataEvent(BROADCAST, CH_TO_LIGHT, bytes(own, [MSG_LIGHT_GROUP, x, y, 0, 0, 0, 0, 0, 0, groupId]));
}

export function changeColor(own, dst) {
  return dataEvent(dst, CH_TO_LIGHT, bytes(own, [MSG_CHANGE_COLOR]));
}

export function scene(own, index, save, dst = BROADCAST) {
  const msg = save ? MSG_SCENE_SAVE : MSG_SCENE_PLAY;
  return dataEvent(dst, CH_TO_LIGHT, bytes(own, [msg, 0, 0, 0, 0, 0, 0, index]));
}

export function statusRequest(own, dst) {
  return dataEvent(dst, CH_TO_LIGHT, bytes(own, [MSG_STATUS]));
}

export function pingAll(own) {
  return dataEvent(BROADCAST, CH_PING, own);
}

export class Device {
  constructor({ vaddr, mac, product, version }) {
    this.vaddr = vaddr;
    this.mac = mac;
    this.product = product;
    this.version = version;
  }

  toString() {
    return `vaddr=${this.vaddr.toString('hex')} mac=${this.mac} product=${this.product} ver=${this.version}`;
  }
}

/** MeshCommon.GetPingResponse; `p` is a decrypted type-3 packet with channel 0xFF. */
export function parsePingResponse(p) {
  if (p.length < 20 || p[0] !== 0x03 || p[5] !== CH_PING_RESPONSE) return null;
  const mac = [...p.subarray(6, 12)].reverse().map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(':');
  const product = p[16] | (p[17] << 8);
  return new Device({ vaddr: Buffer.from(p.subarray(12, 16)), mac, product, version: `${product}.${p[18]}.${p[19]}` });
}

export class LightState {
  constructor({ vaddr, on, x, y }) {
    this.vaddr = vaddr;
    this.on = on;
    this.x = x;
    this.y = y;
  }

  /** 0 = warm .. 100 = cool, null if unknown (light reports a plain "on"). */
  get color() {
    return !this.on || this.x > X_MAX ? null : this.x * 5;
  }

  /** 1..100 %, 0 when off, null if unknown. */
  get brightness() {
    if (!this.on) return 0;
    return this.y > Y_MAX ? null : 100 - this.y * 5;
  }

  toJSON() {
    return { vaddr: this.vaddr.toString('hex'), on: this.on, color: this.color, brightness: this.brightness, x: this.x, y: this.y };
  }
}

/** Status reply (MeshBlePresenter.syncState): `03 <dst4> <ch> <src4> 71 <x> <y> ...` */
export function parseStatus(p) {
  if (p.length < 13 || p[0] !== 0x03 || !MSG_STATUS_RESPONSES.includes(p[10])) return null;
  const x = p[11];
  const y = p[12];
  return new LightState({ vaddr: Buffer.from(p.subarray(6, 10)), on: !(x === XY_OFF[0] && y === XY_OFF[1]), x, y });
}

/** The app shows "ID:<HomeID><4-char password>", e.g. "ID:12345678" -> { homeid: 1234, password: "5678" }. */
export function parseAppId(appId) {
  let s = String(appId).trim();
  if (s.toUpperCase().startsWith('ID:')) s = s.slice(3);
  if (s.length < 5) throw new InputError(`ID looks too short: ${JSON.stringify(String(appId))}`);
  const head = s.slice(0, -4);
  if (!/^\d+$/.test(head)) throw new InputError(`ID must start with the numeric HomeID: ${JSON.stringify(String(appId))}`);
  return { homeid: Number(head), password: s.slice(-4) };
}

/**
 * HomeID advertised by a mesh node (manufacturer id 0xFFFF, c0/c1 ff 01|02 <homeid LE>).
 * `manufacturerData` is the raw AD field as noble reports it, i.e. starting with the 2-byte company id.
 */
export function advHomeid(manufacturerData) {
  const m = manufacturerData;
  if (!m || m.length < 9 || m[0] !== 0xff || m[1] !== 0xff) return null;
  const v = m.subarray(2);
  if ((v[0] === 0xc0 || v[0] === 0xc1) && v[1] === 0xff && (v[2] === 1 || v[2] === 2)) return v.readUInt32LE(3);
  return null;
}
