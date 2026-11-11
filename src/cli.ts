/** odelic command line.  `odelic setup --id <APP_ID>` once, then e.g. `odelic off`, `odelic light living --color 0`. */
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import { InputError, OdelicError } from './errors.ts';
import { log, setLogLevel } from './log.ts';
import { findNodes } from './client.ts';
import { Config, configPath, parseIdle } from './config.ts';
import { Controller } from './controller.ts';
import { parseAppId } from './protocol.ts';
import { VERSION } from './version.ts';

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
} as const;

type OptionName = keyof typeof OPTIONS;
export type CliOptions = {
  [K in OptionName]?: (typeof OPTIONS)[K]['type'] extends 'boolean' ? boolean : string;
};

/** Which options each command accepts (besides the global ones). */
const COMMAND_OPTIONS: Record<string, readonly OptionName[]> = {
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
const GLOBAL: readonly OptionName[] = ['id', 'node', 'verbose', 'help', 'version'];
const MAX_ARGS: Record<string, number> = { on: 1, off: 1, light: 1, night: 1, status: 1, group: 2, scene: 2, name: 3 };

function intArg(v: string | undefined, name: string, { min = -Infinity, max = Infinity } = {}): number | undefined {
  if (v === undefined) return undefined;
  if (!/^-?\d+$/.test(v)) throw new InputError(`--${name}: invalid int value: '${v}'`);
  const n = Number(v);
  if (n < min || n > max) throw new InputError(`--${name}: must be between ${min} and ${max}`);
  return n;
}

function choice<T extends string>(v: string | undefined, name: string, choices: readonly T[]): T {
  if (!choices.includes(v as T)) {
    throw new InputError(`${name}: expected one of ${choices.join(', ')} (got ${v === undefined ? 'nothing' : `'${v}'`})`);
  }
  return v as T;
}

export interface ParsedCli {
  cmd: string;
  args: string[];
  opts: CliOptions;
}

/** Parse argv; throws InputError on bad usage. */
export function parseCli(argv: string[]): ParsedCli {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    throw new InputError((e as Error).message);
  }
  const o = parsed.values as CliOptions;
  if (o.help || o.version) return { cmd: o.help ? 'help' : 'version', args: [], opts: o };
  const [cmd, ...args] = parsed.positionals;
  if (!cmd) throw new InputError('missing command (see odelic --help)');
  if (!Object.hasOwn(COMMAND_OPTIONS, cmd)) throw new InputError(`unknown command '${cmd}' (see odelic --help)`);
  for (const k of Object.keys(o) as OptionName[]) {
    if (!GLOBAL.includes(k) && !COMMAND_OPTIONS[cmd].includes(k)) throw new InputError(`${cmd}: unrecognized option --${k}`);
  }
  if (o.idle !== undefined && o['keep-connected']) throw new InputError('--idle and --keep-connected are mutually exclusive');
  if (o.idle !== undefined) parseIdle(o.idle); // validate early
  const maxArgs = MAX_ARGS[cmd] ?? 0;
  if (args.length > maxArgs) throw new InputError(`${cmd}: unexpected argument '${args[maxArgs]}'`);
  return { cmd, args, opts: o };
}

function idleValue(o: CliOptions): number | null {
  return o['keep-connected'] ? 0 : parseIdle(o.idle);
}

function show(obj: unknown): void {
  console.log(typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
}

async function runBle(cmd: string, args: string[], o: CliOptions, cfg: Config): Promise<void> {
  if (cmd === 'scan') {
    const aid = cfg.appId(o.id);
    const homeid = aid ? parseAppId(aid).homeid : null;
    for (const n of await findNodes({ homeid })) {
      console.log(`${String(n.name).padEnd(20)} ${n.address}  HomeID=${n.homeid}  rssi=${n.rssi}`);
    }
    return;
  }

  if (cmd === 'serve') {
    const { serve } = await import('./server.ts');
    const ctl = new Controller(o.id, { node: o.node, config: cfg, idleTimeout: idleValue(o) });
    const server = await serve(ctl, {
      host: o.host ?? '127.0.0.1',
      port: intArg(o.port, 'port', { min: 0, max: 65535 }) ?? 8765,
      token: o.token ?? process.env.ODELIC_HTTP_TOKEN ?? null,
    });
    await new Promise<void>((resolve) => {
      const stop = () => server.close(() => resolve());
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
    await ctl.close();
    return;
  }

  const target = args[0] ?? 'all';
  const color = () => intArg(o.color, 'color') ?? 50;
  const brightness = () => intArg(o.brightness, 'brightness') ?? 100;
  const ctl = new Controller(o.id, { node: o.node, config: cfg, idleTimeout: 0 });
  try {
    if (cmd === 'lights' || cmd === 'devices') {
      for (const d of await ctl.lights()) {
        if (d.online) console.log(`${(d.name ?? '-').padEnd(12)} vaddr=${d.vaddr} mac=${d.mac} product=${d.product} ver=${d.version}`);
        else console.log(`${String(d.name).padEnd(12)} vaddr=${d.vaddr} (offline)`);
      }
      return;
    }
    if (cmd === 'on') show(await ctl.on(target));
    else if (cmd === 'off') show(await ctl.off(target));
    else if (cmd === 'light') show(await ctl.setLight(target, color(), brightness()));
    else if (cmd === 'night') show(await ctl.nightLight(target, intArg(o.level, 'level', { min: 0, max: 2 }) ?? 0));
    else if (cmd === 'status') show(await ctl.status(target));
    else if (cmd === 'group') {
      const id = intArg(args[0], 'group_id');
      if (id === undefined) throw new InputError('group: missing group id');
      show(await ctl.group(id, choice(args[1], 'group action', ['on', 'off', 'light'] as const), color(), brightness()));
    } else if (cmd === 'scene') {
      const action = choice(args[0], 'scene action', ['save', 'play'] as const);
      const index = intArg(args[1], 'index');
      if (index === undefined) throw new InputError('scene: missing index');
      show(await ctl.scene(index, action === 'save'));
    }
    await sleep(500); // let write-without-response packets drain before disconnecting
  } finally {
    await ctl.close();
  }
}

/** CLI entry point. Resolves to the process exit code, or null for long-running commands (`mcp`). */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number | null> {
  let parsed: ParsedCli;
  try {
    parsed = parseCli(argv);
  } catch (e) {
    console.error(`odelic: error: ${(e as Error).message}`);
    return 2;
  }
  const { cmd, args, opts: o } = parsed;
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
      const sub = choice(args[0], 'name command', ['add', 'rm', 'list'] as const);
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
      let mcp: typeof import('./mcp.ts');
      try {
        mcp = await import('./mcp.ts');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') throw e;
        throw new OdelicError(`${(e as Error).message} (install with: npm install @modelcontextprotocol/sdk zod)`);
      }
      await mcp.main();
      return null; // keep running until stdin closes
    } else {
      await runBle(cmd, args, o, cfg);
    }
    return 0;
  } catch (e) {
    const err = e as Error;
    if (o.verbose || !(err instanceof OdelicError)) log.debug(err.stack);
    console.error(`error: ${err.message}`);
    return 1;
  }
}
