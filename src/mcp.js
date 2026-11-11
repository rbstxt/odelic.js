/**
 * MCP server exposing ODELIC lights to AI assistants (stdio).
 *
 *     npm install odelic @modelcontextprotocol/sdk zod
 *     odelic-mcp       # reads the ID from ODELIC_ID or the config file (`odelic setup --id ...`)
 *
 * The BLE link is opened on the first command. By default it is released after 60 s without
 * commands so the official phone app can still connect; set ODELIC_IDLE_TIMEOUT (seconds, 0 = stay
 * connected) or `odelic setup --keep-connected` to change that.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { Controller } from './controller.js';
import { VERSION } from './version.js';

export const INSTRUCTIONS = `Controls ODELIC Bluetooth ceiling/room lights in the user's home.
Targets: a light name (see list_lights), or "all" for every light.
Colour is 0 = warm/電球色 (orange) ... 100 = cool/昼光色 (bluish white); brightness is 1..100 %.
Commands are fire-and-forget; use light_status to confirm the result if needed.`;

const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
const ACTION = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

const target = z.string().default('all').describe('light name, vaddr, or "all"');
const color = z.number().int().min(0).max(100).default(50).describe('0 = warm/電球色 .. 50 = neutral .. 100 = cool/昼光色');
const brightness = z.number().int().min(1).max(100).default(100).describe('1..100 (%)');

const result = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

/**
 * Build the MCP server.
 * @param {() => Controller} getController called lazily on the first tool call
 */
export function createMcpServer(getController = lazyController()) {
  const server = new McpServer({ name: 'odelic', version: VERSION }, { instructions: INSTRUCTIONS });
  const ctl = () => getController();
  const tool = (name, description, annotations, inputSchema, fn) =>
    server.registerTool(name, { description, annotations, inputSchema }, async (args) => {
      try {
        return result(await fn(args));
      } catch (e) {
        return { ...result({ ok: false, error: `${e.name}: ${e.message}` }), isError: true };
      }
    });

  tool('list_lights', 'List the lights in the mesh (name, vaddr, online, product). Takes a few seconds.',
    READ_ONLY, {}, () => ctl().lights());
  tool('light_status', 'Current state of a light: on/off, colour (0 warm..100 cool) and brightness (%).',
    READ_ONLY, { target }, async (a) => {
      const res = await ctl().status(a.target);
      return Array.isArray(res) ? { lights: res } : res;
    });
  tool('turn_on', 'Turn a light (or "all") on with its previous colour and brightness.',
    ACTION, { target }, (a) => ctl().on(a.target));
  tool('turn_off', 'Turn a light (or "all") off.', ACTION, { target }, (a) => ctl().off(a.target));
  tool('set_light', 'Turn on with a given colour and brightness.',
    ACTION, { target, color, brightness }, (a) => ctl().setLight(a.target, a.color, a.brightness));
  tool('night_light', 'Very dim warm night light. level 0..2.',
    ACTION, { target, level: z.number().int().min(0).max(2).default(0) }, (a) => ctl().nightLight(a.target, a.level));
  tool('control_group', 'Control a group configured in the ODELIC app. action: "on", "off" or "light" (uses color/brightness).',
    ACTION, { group_id: z.number().int().min(0).max(255), action: z.enum(['on', 'off', 'light']).default('on'), color, brightness },
    (a) => ctl().group(a.group_id, a.action, a.color, a.brightness));
  tool('play_scene', 'Recall a scene saved in the lights (index as in the app).',
    ACTION, { index: z.number().int().min(0).max(255) }, (a) => ctl().scene(a.index, false));
  tool('save_scene', 'Store the current state of all lights as scene `index` (overwrites that scene).',
    DESTRUCTIVE, { index: z.number().int().min(0).max(255) }, (a) => ctl().scene(a.index, true));
  tool('name_light', 'Give a light (vaddr from list_lights) a friendly name such as "living" or "リビング".',
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, { name: z.string().min(1), vaddr: z.string() },
    (a) => ctl().nameLight(a.name, a.vaddr));
  tool('forget_light_name', 'Remove a light name from the config.',
    DESTRUCTIVE, { name: z.string() }, (a) => ctl().forgetName(a.name));
  return server;
}

function lazyController() {
  let c = null;
  // idle timeout from $ODELIC_IDLE_TIMEOUT / config (0 = stay connected)
  return () => (c ??= new Controller());
}

/** Run the MCP server on stdio (logs go to stderr). */
export async function main() {
  const getController = lazyController();
  const server = createMcpServer(getController);
  await server.connect(new StdioServerTransport());
}
