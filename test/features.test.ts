/** Offline tests for status parsing, config/names, the controller, the HTTP API and the MCP tool list. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import * as P from '../src/protocol.ts';
import type { OdelicMesh, SetGroupOptions, SetLightOptions } from '../src/client.ts';
import { Config, parseIdle } from '../src/config.ts';
import { Controller } from '../src/controller.ts';
import type { ControllerInfo } from '../src/controller.ts';
import { InputError } from '../src/errors.ts';
import { dispatch, HttpError, makeHandler } from '../src/server.ts';
import type { HttpController } from '../src/server.ts';

const hex = (s: string): Buffer => Buffer.from(s, 'hex');

test('status replies', () => {
  // reply captured from a real light: warm (x=0), brightest (y=0)
  const st = P.parseStatus(hex('03020000002700000000710000000000000000'));
  assert.deepEqual(st?.toJSON(), { vaddr: '00000000', on: true, color: 0, brightness: 100, x: 0, y: 0 });
  const off = P.parseStatus(hex('0302000000270000000071323200'));
  assert.equal(off?.on, false);
  assert.equal(off?.brightness, 0);
  const on = P.parseStatus(hex('0302000000270000000071373700'));
  assert.equal(on?.on, true);
  assert.equal(on?.color, null);
  assert.equal(P.parseStatus(hex('0302000000ff0000')), null);
});

test('ping replies', () => {
  const d = P.parsePingResponse(hex('03020000' + '00ff' + '665544332211' + '0a000000' + '4c000102'));
  assert.ok(d);
  assert.equal(d.mac, '11:22:33:44:55:66');
  assert.equal(d.vaddr.toString('hex'), '0a000000');
  assert.equal(d.product, 76);
  assert.equal(d.version, '76.1.2');
});

test('config: names and save', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odelic-'));
  try {
    const file = path.join(dir, 'sub', 'config.json');
    const cfg = new Config({}, file);
    cfg.id = '12345678';
    cfg.setName('リビング', '00000000');
    cfg.save();
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const cfg2 = Config.load(file);
    assert.equal(cfg2.id, '12345678');
    assert.deepEqual(cfg2.resolve('リビング'), hex('00000000'));
    assert.deepEqual(cfg2.resolve('all'), P.BROADCAST);
    assert.deepEqual(cfg2.resolve('0a000000'), hex('0a000000'));
    assert.equal(cfg2.nameOf(hex('00000000')), 'リビング');
    assert.throws(() => cfg2.resolve('kitchen'), InputError);
    assert.throws(() => cfg2.setName('everything', 'all'), InputError);
    assert.throws(() => cfg2.removeName('constructor'), InputError);
    // the file format is shared with the Python package
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')),
      { id: '12345678', node: null, idle_timeout: null, lights: { 'リビング': '00000000' } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('idle timeout resolution', () => {
  assert.equal(parseIdle('never'), 0);
  assert.equal(parseIdle('30'), 30);
  assert.equal(parseIdle(null), null);
  assert.throws(() => parseIdle('soon'), InputError);
  assert.throws(() => parseIdle(-1), InputError);
  const old = process.env.ODELIC_IDLE_TIMEOUT;
  delete process.env.ODELIC_IDLE_TIMEOUT;
  try {
    const cfg = new Config({ idle_timeout: 0 });
    assert.equal(cfg.idle(), 0); //               config: keep connected
    assert.equal(cfg.idle('15'), 15); //          explicit override wins
    process.env.ODELIC_IDLE_TIMEOUT = '90';
    assert.equal(cfg.idle(), 90); //              env beats config
    assert.equal(new Config({}).idle(), 90);
    delete process.env.ODELIC_IDLE_TIMEOUT;
    assert.equal(new Config({}).idle(), 60); //   default
  } finally {
    delete process.env.ODELIC_IDLE_TIMEOUT;
    if (old !== undefined) process.env.ODELIC_IDLE_TIMEOUT = old;
  }
});

/** OdelicMesh stand-in recording what the controller would send. */
class FakeMesh {
  isConnected = false;
  nodeName = 'fake';
  calls: unknown[][] = [];
  connects = 0;
  failNext = false;

  async connect(): Promise<void> {
    this.connects++;
    this.isConnected = true;
  }

  async disconnect(): Promise<void> {
    this.isConnected = false;
  }

  private record(name: string, ...args: unknown[]): void {
    if (this.failNext) {
      this.failNext = false;
      this.isConnected = false;
      throw new Error('link lost');
    }
    this.calls.push([name, ...args]);
  }

  async on(v: Buffer) { this.record('on', v.toString('hex')); }
  async off(v: Buffer) { this.record('off', v.toString('hex')); }
  async setLight(o: SetLightOptions) { this.record('setLight', o.color, o.brightness, Buffer.from(o.target as Buffer).toString('hex')); }
  async nightLight(level: number, v: Buffer) { this.record('nightLight', level, v.toString('hex')); }
  async setGroup(id: number, o: SetGroupOptions) { this.record('setGroup', id, o); }
  async playScene(i: number) { this.record('playScene', i); }
  async saveScene(i: number) { this.record('saveScene', i); }
  async devices() { return [new P.Device({ vaddr: hex('00000000'), mac: 'AA', product: 76, version: '76.1.0' })]; }
  async status(v: Buffer) { return new P.LightState({ vaddr: v, on: true, x: 0, y: 0 }); }
}

test('controller: names, clamping, reconnect, idle disconnect', async () => {
  const cfg = new Config({ lights: { living: '00000000', hall: '01000000' } }, path.join(os.tmpdir(), 'unused.json'));
  const mesh = new FakeMesh();
  const ctl = new Controller(null, { config: cfg, mesh: mesh as unknown as OdelicMesh, idleTimeout: 0.05 });
  assert.deepEqual(await ctl.setLight('Living', '0', 500), { ok: true, action: 'light', target: 'living', color: 0, brightness: 100 });
  assert.deepEqual(mesh.calls.at(-1), ['setLight', 0, 100, '00000000']);
  assert.deepEqual(await ctl.off(), { ok: true, action: 'off', target: 'all' });
  await assert.rejects(ctl.on('kitchen'), InputError);
  await assert.rejects(ctl.setLight('all', 'warm'), InputError);
  await assert.rejects(ctl.group(1, 'blink'), InputError);

  mesh.failNext = true; // link drops during the command: reconnect once and retry
  await ctl.on('hall');
  assert.deepEqual(mesh.calls.at(-1), ['on', '01000000']);
  assert.equal(mesh.connects, 2);

  const lights = await ctl.lights(0);
  assert.deepEqual(lights.map((l) => [l.name, l.online]), [['living', true], ['hall', false]]);
  assert.deepEqual(await ctl.status('all'), [{ name: 'living', online: true, vaddr: '00000000', on: true, color: 0, brightness: 100, x: 0, y: 0 }]);

  await new Promise((r) => setTimeout(r, 120));
  assert.equal(mesh.isConnected, false, 'idle timeout releases the link');
  await ctl.close();
});

type Call = [string, ...unknown[]];

/** Records every controller call; any method name works. */
function fakeController(): { ctl: HttpController & Record<string, unknown>; calls: Call[] } {
  const calls: Call[] = [];
  const info = (): ControllerInfo => ({ connected: false, node: null, mode: 'idle', idle_timeout: 60 });
  const ctl = new Proxy({ info } as Record<string, unknown>, {
    get: (t, name) => (typeof name === 'string' && name in t ? t[name] : async (...args: unknown[]) => {
      calls.push([String(name), ...args]);
      return { ok: true, action: String(name), args };
    }),
  });
  return { ctl: ctl as HttpController & Record<string, unknown>, calls };
}

test('http dispatch', async () => {
  const { ctl, calls } = fakeController();
  await dispatch(ctl, 'POST', '/lights/%E3%83%AA%E3%83%93%E3%83%B3%E3%82%B0/light', { color: 0, brightness: 80 });
  assert.deepEqual(calls.at(-1), ['setLight', 'リビング', 0, 80]);
  await dispatch(ctl, 'POST', '/lights/all/off', {});
  assert.deepEqual(calls.at(-1), ['off', 'all']);
  await dispatch(ctl, 'POST', '/scenes/2/play', {});
  assert.deepEqual(calls.at(-1), ['scene', 2, false]);
  await assert.rejects(dispatch(ctl, 'GET', '/lights/all/on', {}), (e) => e instanceof HttpError && e.status === 405);
  await assert.rejects(dispatch(ctl, 'POST', '/nope', {}), (e) => e instanceof HttpError && e.status === 404);
  await assert.rejects(dispatch(ctl, 'POST', '/groups/x/on', {}), InputError);
});

test('http server with token', async () => {
  const { ctl, calls } = fakeController();
  const server = http.createServer(makeHandler(ctl, 's3cret'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const ok = await fetch(`${base}/lights/all/night`, {
      method: 'POST', headers: { Authorization: 'Bearer s3cret' }, body: '{"level": 1}',
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(calls[0], ['nightLight', 'all', 1]);
    const denied = await fetch(`${base}/lights/all/off`, { method: 'POST' });
    assert.equal(denied.status, 401);
    const viaQuery = await fetch(`${base}/health?token=s3cret`);
    assert.deepEqual([viaQuery.status, await viaQuery.json()],
      [200, { ok: true, connected: false, node: null, mode: 'idle', idle_timeout: 60 }]);
    const badJson = await fetch(`${base}/lights/all/off?token=s3cret`, { method: 'POST', body: '{' });
    assert.equal(badJson.status, 400);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('mcp tools are registered', async (t) => {
  let mcp: typeof import('../src/mcp.ts');
  let Client: typeof import('@modelcontextprotocol/sdk/client/index.js').Client;
  let InMemoryTransport: typeof import('@modelcontextprotocol/sdk/inMemory.js').InMemoryTransport;
  try {
    mcp = await import('../src/mcp.ts');
    ({ Client } = await import('@modelcontextprotocol/sdk/client/index.js'));
    ({ InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js'));
  } catch {
    t.skip('@modelcontextprotocol/sdk not installed');
    return;
  }
  const { ctl, calls } = fakeController();
  const server = mcp.createMcpServer(() => ctl as unknown as import('../src/mcp.ts').McpController);
  const client = new Client({ name: 'test', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const { tools } = await client.listTools();
    const names = new Set(tools.map((x) => x.name));
    for (const n of ['list_lights', 'light_status', 'turn_on', 'turn_off', 'set_light', 'night_light',
      'control_group', 'play_scene', 'save_scene', 'name_light', 'forget_light_name']) {
      assert.ok(names.has(n), n);
    }
    const res = await client.callTool({ name: 'set_light', arguments: { target: 'living', color: 0 } });
    assert.deepEqual(calls.at(-1), ['setLight', 'living', 0, 100]);
    const content = res.content as { type: string; text: string }[];
    assert.equal(JSON.parse(content[0].text).ok, true);
    assert.match(client.getInstructions() ?? '', /ODELIC/);
  } finally {
    await client.close();
    await server.close();
  }
});
