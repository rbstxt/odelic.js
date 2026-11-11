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

import { InputError, LoginError } from './errors.ts';

/** AES-128-ECB without padding; `data` must be a multiple of 16 bytes. */
export function aes128(key: Uint8Array, data: Uint8Array, { decrypt = false }: { decrypt?: boolean } = {}): Buffer {
  const c = decrypt ? createDecipheriv('aes-128-ecb', key, null) : createCipheriv('aes-128-ecb', key, null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(data), c.final()]);
}

export function pkcs7Pad(data: Uint8Array): Buffer {
  const n = 16 - (data.length % 16);
  return Buffer.concat([data, Buffer.alloc(n, n)]);
}

export function pkcs7Unpad(data: Buffer): Buffer {
  const n = data.length ? data[data.length - 1] : 0;
  if (n < 1 || n > 16 || n > data.length || !data.subarray(-n).every((b) => b === n)) {
    throw new InputError('bad padding');
  }
  return data.subarray(0, data.length - n);
}

/** Keys for one mesh (HomeID + password) and the per-connection session value. */
export class MeshCrypto {
  readonly homeid: Buffer;
  readonly password: Buffer;
  /** Per-connection value from the login challenge; null until logged in. */
  session: Buffer | null = null;
  private readonly loginKey: Buffer;
  private readonly eventKey: Buffer;

  /** @param password 4 ASCII characters */
  constructor(homeid: number, password: string) {
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
    this.loginKey = Buffer.concat([mat, Buffer.from('LOGINKEY')]);
    this.eventKey = Buffer.concat([mat, Buffer.from('EVENTKEY')]);
  }

  /** `challenge` = the 16 encrypted bytes following `02 20`. Returns the login packet. */
  answerChallenge(challenge: Uint8Array): Buffer {
    const plain = aes128(this.loginKey, Buffer.from(challenge).subarray(0, 16), { decrypt: true });
    if (!plain.subarray(0, 4).equals(this.homeid)) {
      throw new LoginError(`node belongs to another HomeID (${plain.readUInt32LE(0)})`);
    }
    this.session = Buffer.from(plain.subarray(4, 8));
    const body = aes128(this.loginKey, pkcs7Pad(Buffer.concat([this.homeid, this.password, this.session])));
    return Buffer.concat([Buffer.from([0x01, 0x16, 0x03]), body]);
  }

  /**
   * Follow a login challenge we did not ask for.
   *
   * The node switches to the session value of every new challenge, even when that login is
   * later refused with status 08. On macOS all processes share one BLE link per peripheral,
   * so another program logging in through the same link silently invalidates our session
   * unless we switch too. Returns true if the session changed.
   */
  adoptChallenge(challenge: Uint8Array): boolean {
    const plain = aes128(this.loginKey, Buffer.from(challenge).subarray(0, 16), { decrypt: true });
    if (!plain.subarray(0, 4).equals(this.homeid)) return false;
    const next = Buffer.from(plain.subarray(4, 8));
    const changed = this.session === null || !next.equals(this.session);
    this.session = next;
    return changed;
  }

  private xor(data: Buffer, key: Buffer): Buffer {
    return Buffer.from(data.map((b, i) => b ^ key[i % 4]));
  }

  /** `03 <dst4> <ch> <payload>`  ->  `06 <dst4> <ch> <cipher>` */
  encrypt(packet: Uint8Array): Buffer {
    const plain = Buffer.from(packet);
    if (this.session === null) throw new LoginError('not logged in');
    if (plain.length < 7 || plain[0] !== 0x03) throw new InputError('expected a data-event packet (type 3)');
    const cipher = aes128(this.eventKey, pkcs7Pad(plain.subarray(6)));
    return Buffer.concat([Buffer.from([0x06]), plain.subarray(1, 6), this.xor(cipher, this.session)]);
  }

  /** `06 <src/dst4> <ch> <cipher>`  ->  `03 <...> <payload>`; other packet types pass through. */
  decrypt(data: Uint8Array): Buffer {
    const packet = Buffer.from(data);
    if (!packet.length || packet[0] !== 0x06 || this.session === null) return packet;
    let body = this.xor(packet.subarray(6), this.session);
    body = body.subarray(0, body.length - (body.length % 16));
    const plain = pkcs7Unpad(aes128(this.eventKey, body, { decrypt: true }));
    return Buffer.concat([Buffer.from([0x03]), packet.subarray(1, 6), plain]);
  }
}
