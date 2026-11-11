/**
 * Offline tests.
 *
 * The mesh vectors below were produced by the original native library from the official app
 * (run under an emulator, see tools/native_oracle.py in odelic.py) for a made-up mesh:
 * HomeID 1234 / password "5678". They are the same vectors as the Python package uses.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as P from '../src/protocol.ts';
import { aes128, MeshCrypto, pkcs7Pad, pkcs7Unpad } from '../src/crypto.ts';
import { InputError, LoginError } from '../src/errors.ts';

const hex = (s: string): Buffer => Buffer.from(s, 'hex');
const OWN = hex('02000000');
const CHALLENGE = '10d9e9ae24df368efd29dce10311fcd5';

test('AES-128 FIPS-197 vector', () => {
  const key = hex('000102030405060708090a0b0c0d0e0f');
  const pt = hex('00112233445566778899aabbccddeeff');
  const ct = hex('69c4e0d86a7b0430d8cdb78070b4c55a');
  assert.deepEqual(aes128(key, pt), ct);
  assert.deepEqual(aes128(key, ct, { decrypt: true }), pt);
});

test('pkcs7', () => {
  assert.deepEqual(pkcs7Pad(hex('01')), hex('01' + '0f'.repeat(15)));
  assert.deepEqual(pkcs7Pad(Buffer.alloc(16)).length, 32);
  assert.deepEqual(pkcs7Unpad(hex('01' + '0f'.repeat(15))), hex('01'));
  assert.throws(() => pkcs7Unpad(hex('0102')), InputError);
  assert.throws(() => pkcs7Unpad(Buffer.alloc(0)), InputError);
});

test('login answers match the native library', () => {
  const m = new MeshCrypto(1234, '5678');
  const cases = {
    '10d9e9ae24df368efd29dce10311fcd5': '0116033f7fc1c4a4c20ab25e3214b34fc94325',
    '4cfd0d8ba5c948bab1cd0b120171ffdd': '011603aa1dba22c58d8894f691dd26c2d6fe99',
  };
  for (const [ch, ans] of Object.entries(cases)) {
    assert.equal(m.answerChallenge(hex(ch)).toString('hex'), ans);
  }
});

test('challenge from another mesh is rejected', () => {
  assert.throws(() => new MeshCrypto(1111, '9999').answerChallenge(hex(CHALLENGE)), LoginError);
});

test('adoptChallenge follows a foreign login on the shared link', () => {
  const m = new MeshCrypto(1234, '5678');
  m.answerChallenge(hex(CHALLENGE));
  const before = Buffer.from(m.session!);
  // a second challenge for the same mesh carries a new session: adopt it without answering
  const changed = m.adoptChallenge(hex('4cfd0d8ba5c948bab1cd0b120171ffdd'));
  assert.equal(changed, true);
  assert.ok(!m.session!.equals(before));
  // adopting the same challenge again changes nothing
  assert.equal(m.adoptChallenge(hex('4cfd0d8ba5c948bab1cd0b120171ffdd')), false);
  // a challenge from another mesh is ignored (all-zero decrypts to a wrong HomeID)
  assert.equal(m.adoptChallenge(hex('00'.repeat(16))), false);
});

test('light packets match the native library and round-trip', () => {
  const m = new MeshCrypto(1234, '5678');
  assert.throws(() => m.encrypt(P.light(OWN, P.BROADCAST, ...P.XY_OFF)), LoginError);
  m.answerChallenge(hex(CHALLENGE));
  const cases: [readonly [number, number], string][] = [
    [P.XY_OFF, '06ffffffff2a5f2cc7de934ec8bfa57cd54edc21093a'],
    [[0, 0], '06ffffffff2af540faabb918376c638574d9dcc467f9'], // warm, brightest
  ];
  for (const [xy, expected] of cases) {
    const plain = P.light(OWN, P.BROADCAST, ...xy);
    const enc = m.encrypt(plain);
    assert.equal(enc.toString('hex'), expected);
    assert.deepEqual(m.decrypt(enc), plain);
  }
  // other packet types pass through untouched
  assert.deepEqual(m.decrypt(hex('021600')), hex('021600'));
});

test('bad credentials are rejected early', () => {
  assert.throws(() => new MeshCrypto(1234, '567'), InputError);
  assert.throws(() => new MeshCrypto(1234, 'ぱすわ'), InputError);
  assert.throws(() => new MeshCrypto(2 ** 32, '5678'), InputError);
});

test('helpers', () => {
  assert.deepEqual(P.parseAppId('ID:12345678'), { homeid: 1234, password: '5678' });
  assert.deepEqual(P.parseAppId(' 12345678 '), { homeid: 1234, password: '5678' });
  assert.throws(() => P.parseAppId('1234'), InputError);
  assert.throws(() => P.parseAppId('ab5678'), InputError);
  assert.equal(P.brightnessToY(100), 0);
  assert.equal(P.brightnessToY(1), 19);
  assert.equal(P.colorToX(0), 0);
  assert.equal(P.colorToX(100), 20);
  assert.deepEqual(P.vaddr('00:00:00:0a'), hex('0000000a'));
  assert.deepEqual(P.vaddr(10), hex('0a000000'));
  assert.throws(() => P.vaddr('xyz'), InputError);
  assert.throws(() => P.groupLight(OWN, 256, 0, 0), InputError);
});

test('advertised HomeID (noble manufacturerData includes the company id)', () => {
  assert.equal(P.advHomeid(hex('ffffc0ff01d2040000')), 1234);
  assert.equal(P.advHomeid(hex('ffffc1ff02d2040000aa')), 1234);
  assert.equal(P.advHomeid(hex('4c00c0ff01d2040000')), null);
  assert.equal(P.advHomeid(undefined), null);
});
