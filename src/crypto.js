/**
 * Pairlink connected-mesh crypto.
 *
 * Reverse-engineered from libnative-lib.so in the ODELIC app (jp.co.odelic.smt.remote10):
 *
 * - key material = HomeID (4B, little endian) and password (4 ASCII bytes) interleaved
 *                  -> h0 p0 h1 p1 h2 p2 h3 p3
 * - login key    = material + "LOGINKEY"   (AES-128)
 * - event key    = material + "EVENTKEY"   (AES-128)
 * - login        : node sends 02 20 <AES_LK(homeid | session4 | pad)>,
 *                  we answer 01 16 03 <AES_LK(homeid | pwd | session4 | pad)>
 * - data packets : 03 <dst4> <ch> <payload>  ->  06 <dst4> <ch> XOR4(AES_EK(pkcs7(payload)), session4)
 */
import { createCipheriv, createDecipheriv } from 'node:crypto';

import { InputError, LoginError } from './errors.js';

/** AES-128-ECB without padding; `data` must be a multiple of 16 bytes. */
export function aes128(key, data, { decrypt = false } = {}) {
  const c = (decrypt ? createDecipheriv : createCipheriv)('aes-128-ecb', key, null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(data), c.final()]);
}

export function pkcs7Pad(data) {
  const n = 16 - (data.length % 16);
  return Buffer.concat([data, Buffer.alloc(n, n)]);
}

export function pkcs7Unpad(data) {
  const n = data.length ? data[data.length - 1] : 0;
  if (n < 1 || n > 16 || n > data.length || !data.subarray(-n).every((b) => b === n)) {
    throw new InputError('bad padding');
  }
  return data.subarray(0, data.length - n);
}

/** Keys for one mesh (HomeID + password) and the per-connection session value. */
export class MeshCrypto {
  /**
   * @param {number} homeid
   * @param {string} password 4 ASCII characters
   */
  constructor(homeid, password) {
    if (!Number.isInteger(homeid) || homeid < 0 || homeid > 0xffffffff) {
      throw new InputError(`HomeID must be a 32-bit unsigned integer (got ${homeid})`);
    }
    if (typeof password !== 'string' || !/^[\x00-\x7f]{4}$/.test(password)) {
      throw new InputError('password must be 4 ASCII characters');
    }
    this.homeid = Buffer.alloc(4);
    this.homeid.writeUInt32LE(homeid);
    this.password = Buffer.from(password, 'ascii');
    const mat = Buffer.alloc(8);
    for (let i = 0; i < 4; i++) {
      mat[2 * i] = this.homeid[i];
      mat[2 * i + 1] = this.password[i];
    }
    this._loginKey = Buffer.concat([mat, Buffer.from('LOGINKEY')]);
    this._eventKey = Buffer.concat([mat, Buffer.from('EVENTKEY')]);
    /** @type {Buffer|null} */
    this.session = null;
  }

  /** `challenge` = the 16 encrypted bytes following `02 20`. Returns the login packet. */
  answerChallenge(challenge) {
    const plain = aes128(this._loginKey, Buffer.from(challenge).subarray(0, 16), { decrypt: true });
    if (!plain.subarray(0, 4).equals(this.homeid)) {
      throw new LoginError(`node belongs to another HomeID (${plain.readUInt32LE(0)})`);
    }
    this.session = Buffer.from(plain.subarray(4, 8));
    const body = aes128(this._loginKey, pkcs7Pad(Buffer.concat([this.homeid, this.password, this.session])));
    return Buffer.concat([Buffer.from([0x01, 0x16, 0x03]), body]);
  }

  _xor(data) {
    const k = this.session;
    return Buffer.from(data.map((b, i) => b ^ k[i % 4]));
  }

  /** `03 <dst4> <ch> <payload>`  ->  `06 <dst4> <ch> <cipher>` */
  encrypt(plain) {
    plain = Buffer.from(plain);
    if (this.session === null) throw new LoginError('not logged in');
    if (plain.length < 7 || plain[0] !== 0x03) throw new InputError('expected a data-event packet (type 3)');
    const cipher = aes128(this._eventKey, pkcs7Pad(plain.subarray(6)));
    return Buffer.concat([Buffer.from([0x06]), plain.subarray(1, 6), this._xor(cipher)]);
  }

  /** `06 <src/dst4> <ch> <cipher>`  ->  `03 <...> <payload>`; other packet types pass through. */
  decrypt(packet) {
    packet = Buffer.from(packet);
    if (!packet.length || packet[0] !== 0x06 || this.session === null) return packet;
    let body = this._xor(packet.subarray(6));
    body = body.subarray(0, body.length - (body.length % 16));
    const plain = pkcs7Unpad(aes128(this._eventKey, body, { decrypt: true }));
    return Buffer.concat([Buffer.from([0x03]), packet.subarray(1, 6), plain]);
  }
}
