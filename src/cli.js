/** odelic command line.  `odelic setup --id <APP_ID>` once, then e.g. `odelic off`, `odelic light living --color 0`. */
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import { InputError, OdelicError } from './errors.js';
import { log, setLogLevel } from './log.js';
import { findNodes } from './client.js';
import { Config, configPath, parseIdle } from './config.js';
import { Controller } from './controller.js';
import { parseAppId } from './protocol.js';
import { VERSION } from './version.js';

const HELP = `usage: odelic [--id ID] [--node NODE] [-v] <command> [...]

Control ODELIC Bluetooth lights.

global options:
  --id ID            ID shown in the app (ID:xxxx); default: $ODELIC_ID or the config file
  --node NODE        BLE name/address of the node to connect through
  -v, --verbose      show BLE packets
  -h, --help         show this help
  --version          show the version

commands:
  setup [--id ID] [--node NODE] [--idle SECONDS | --keep-connected]
                     save the app ID (and optionally a node / connection mode) to the config file
  scan               list nearby mesh nodes (no login)
  lights             list lights in the mesh (alias: devices)
  on [TARGET]        turn on (previous colour/brightness)
  off [TARGET]       turn off
  light [TARGET] [--color 0..100] [--brightness 1..100]
                     turn on with colour (0 = warm 電球色 .. 100 = cool 昼光色) and brightness
  night [TARGET] [--level 0..2]
                     night light
  status [TARGET]    show on/off, colour and brightness
  group ID on|off|light [--color N] [--brightness N]
                     control a group (id as configured in the app)
  scene save|play INDEX
                     save or play a scene
  name add NAME VADDR | name rm NAME | name list
                     manage light names
  serve [--host H] [--port P] [--token T] [--idle SECONDS | --keep-connected]
                     run the HTTP API (token default: $ODELIC_HTTP_TOKEN)
  mcp                run the MCP server on stdio (needs @modelcontextprotocol/sdk and zod)

TARGET is a light name, a vaddr or "all" (default).`;

const OPTIONS = {
  id: { type: 'string' },
  node: { type: 'string' },
  verbose: { type: 'boolean', short: 'v' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
  idle: { type: 'string' },
  'keep-connected': { type: 'boolean' },
  color: { type: 'string' },
  brightness: { type: 'string' },
  level: { type: 'string' },
  host: { type: 'string' },
  port: { type: 'string' },
  token: { type: 'string' },
};

/** Which options each command accepts (besides the global ones). */
const COMMAND_OPTIONS = {
  setup: ['idle', 'keep-connected'],
  scan: [],
  lights: [],
  devices: [],
  on: [],
  off: [],
  light: ['color', 'brightness'],
  night: ['level'],
  status: [],
  group: ['color', 'brightness'],
  scene: [],
  name: [],
  serve: ['host', 'port', 'token', 'idle', 'keep-connected'],
  mcp: [],
};
const GLOBAL = ['id', 'node', 'verbose', 'help', 'version'];

function intArg(v, name, { min = -Infinity, max = Infinity, def } = {}) {
  if (v === undefined) return def;
  if (!/^-?\d+$/.test(v)) throw new InputError(`--${name}: invalid int value: '${v}'`);
  const n = Number(v);
  if (n < min || n > max) throw new InputError(`--${name}: must be between ${min} and ${max}`);
  return n;
}

function choice(v, name, choices) {
  if (!choices.includes(v)) throw new InputError(`${name}: expected one of ${choices.join(', ')} (got ${v === undefined ? 'nothing' : `'${v}'`})`);
  return v;
}

/** Parse argv into `{cmd, args, opts}`; throws InputError on bad usage. */
export function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    throw new InputError(e.message);
  }
  const { values: o, positionals } = parsed;
  if (o.help || o.version) return { cmd: o.help ? 'help' : 'version', args: [], opts: o };
  const [cmd, ...args] = positionals;
  if (!cmd) throw new InputError('missing command (see odelic --help)');
  if (!(cmd in COMMAND_OPTIONS)) throw new InputError(`unknown command '${cmd}' (see odelic --help)`);
  for (const k of Object.keys(o)) {
    if (!GLOBAL.includes(k) && !COMMAND_OPTIONS[cmd].includes(k)) throw new InputError(`${cmd}: unrecognized option --${k}`);
  }
  if (o.idle !== undefined && o['keep-connected']) throw new InputError('--idle and --keep-connected are mutually exclusive');
  if (o.idle !== undefined) parseIdle(o.idle); // validate early
  const maxArgs = { on: 1, off: 1, light: 1, night: 1, status: 1, group: 2, scene: 2, name: 3 }[cmd] ?? 0;
  if (args.length > maxArgs) throw new InputError(`${cmd}: unexpected argument '${args[maxArgs]}'`);
  return { cmd, args, opts: o };
}

function idleValue(o) {
  return o['keep-connected'] ? 0 : parseIdle(o.idle);
}

function show(obj) {
  console.log(typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
}

async function runBle(cmd, args, o, cfg) {
  if (cmd === 'scan') {
    const aid = cfg.appId(o.id);
    const homeid = aid ? parseAppId(aid).homeid : null;
    for (const n of await findNodes({ homeid })) {
      console.log(`${String(n.name).padEnd(20)} ${n.address}  HomeID=${n.homeid}  rssi=${n.rssi}`);
    }
    return;
  }

  if (cmd === 'serve') {
    const { serve } = await import('./server.js');
    const ctl = new Controller(o.id, { node: o.node, config: cfg, idleTimeout: idleValue(o) });
    const server = await serve(ctl, {
      host: o.host ?? '127.0.0.1',
      port: intArg(o.port, 'port', { min: 0, max: 65535, def: 8765 }),
      token: o.token ?? process.env.ODELIC_HTTP_TOKEN ?? null,
    });
    await new Promise((resolve) => {
      const stop = () => server.close(resolve);
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
    await ctl.close();
    return;
  }

  const target = args[0] ?? 'all';
  const ctl = new Controller(o.id, { node: o.node, config: cfg, idleTimeout: 0 });
  try {
    if (cmd === 'lights' || cmd === 'devices') {
      for (const d of await ctl.lights()) {
        if (d.online) console.log(`${(d.name ?? '-').padEnd(12)} vaddr=${d.vaddr} mac=${d.mac} product=${d.product} ver=${d.version}`);
        else console.log(`${d.name.padEnd(12)} vaddr=${d.vaddr} (offline)`);
      }
      return;
    }
    if (cmd === 'on') show(await ctl.on(target));
    else if (cmd === 'off') show(await ctl.off(target));
    else if (cmd === 'light') {
      show(await ctl.setLight(target, intArg(o.color, 'color', { def: 50 }), intArg(o.brightness, 'brightness', { def: 100 })));
    } else if (cmd === 'night') show(await ctl.nightLight(target, intArg(o.level, 'level', { min: 0, max: 2, def: 0 })));
    else if (cmd === 'status') show(await ctl.status(target));
    else if (cmd === 'group') {
      const id = intArg(args[0], 'group_id');
      if (id === undefined) throw new InputError('group: missing group id');
      show(await ctl.group(id, choice(args[1], 'group action', ['on', 'off', 'light']),
        intArg(o.color, 'color', { def: 50 }), intArg(o.brightness, 'brightness', { def: 100 })));
    } else if (cmd === 'scene') {
      const action = choice(args[0], 'scene action', ['save', 'play']);
      const index = intArg(args[1], 'index');
      if (index === undefined) throw new InputError('scene: missing index');
      show(await ctl.scene(index, action === 'save'));
    }
    await sleep(500); // let write-without-response packets drain before disconnecting
  } finally {
    await ctl.close();
  }
}

/** CLI entry point. Resolves to the process exit code. */
export async function main(argv = process.argv.slice(2)) {
  let cmd;
  let args;
  let o;
  try {
    ({ cmd, args, opts: o } = parseCli(argv));
  } catch (e) {
    console.error(`odelic: error: ${e.message}`);
    return 2;
  }
  if (cmd === 'help') {
    console.log(HELP);
    return 0;
  }
  if (cmd === 'version') {
    console.log(VERSION);
    return 0;
  }
  if (o.verbose) setLogLevel('debug');

  try {
    const cfg = Config.load();
    if (cmd === 'setup') {
      if (o.id) {
        parseAppId(o.id);
        cfg.id = o.id;
      }
      if (o.node) cfg.node = o.node;
      const idle = idleValue(o);
      if (idle !== null) cfg.idleTimeout = idle;
      cfg.save();
      const mode = cfg.idle();
      console.log(`saved to ${configPath()} (id: ${cfg.id ? 'set' : 'not set'}, connection: ${
        mode ? `disconnect after ${mode}s idle` : 'keep connected'})`);
    } else if (cmd === 'name') {
      const sub = choice(args[0], 'name command', ['add', 'rm', 'list']);
      if (sub === 'add') {
        if (args.length !== 3) throw new InputError('usage: odelic name add NAME VADDR');
        cfg.setName(args[1], args[2]);
        cfg.save();
      } else if (sub === 'rm') {
        if (args.length !== 2) throw new InputError('usage: odelic name rm NAME');
        cfg.removeName(args[1]);
        cfg.save();
      }
      for (const [name, v] of Object.entries(cfg.lights)) console.log(`${name.padEnd(12)} ${v}`);
    } else if (cmd === 'mcp') {
      let mcp;
      try {
        mcp = await import('./mcp.js');
      } catch (e) {
        if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
        throw new OdelicError(`${e.message} (install with: npm install @modelcontextprotocol/sdk zod)`);
      }
      await mcp.main();
      return null; // keep running until stdin closes
    } else {
      await runBle(cmd, args, o, cfg);
    }
    return 0;
  } catch (e) {
    if (o.verbose || !(e instanceof OdelicError)) log.debug(e.stack);
    console.error(`error: ${e.message}`);
    return 1;
  }
}
