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
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { Controller } from './controller.ts';
import { VERSION } from './version.ts';

export const INSTRUCTIONS = `Controls ODELIC Bluetooth ceiling/room lights in the user's home.
Targets: a light name (see list_lights), or "all" for every light.
Colour is 0 = warm/電球色 (orange) ... 100 = cool/昼光色 (bluish white); brightness is 1..100 %.
Commands are fire-and-forget; use light_status to confirm the result if needed.`;

/** The part of Controller the MCP tools use. */
export type McpController = Pick<Controller,
  'lights' | 'status' | 'on' | 'off' | 'setLight' | 'nightLight' | 'group' | 'scene' | 'nameLight' | 'forgetName'>;

const READ_ONLY: ToolAnnotations = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
const ACTION: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

const target = z.string().default('all').describe('light name, vaddr, or "all"');
const color = z.number().int().min(0).max(100).default(50).describe('0 = warm/電球色 .. 50 = neutral .. 100 = cool/昼光色');
const brightness = z.number().int().min(1).max(100).default(100).describe('1..100 (%)');
const byte = z.number().int().min(0).max(255);

const result = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

/**
 * Build the MCP server.
 * @param getController called lazily on the first tool call
 */
export function createMcpServer(getController: () => McpController = lazyController()): McpServer {
  const server = new McpServer({ name: 'odelic', version: VERSION }, { instructions: INSTRUCTIONS });
  const ctl = () => getController();

  function tool<S extends z.ZodRawShape>(name: string, description: string, annotations: ToolAnnotations, inputSchema: S,
    fn: (args: z.infer<z.ZodObject<S>>) => unknown): void {
    const handler = async (args: z.infer<z.ZodObject<S>>): Promise<CallToolResult> => {
      try {
        return result(await fn(args));
      } catch (e) {
        const err = e as Error;
        return { ...result({ ok: false, error: `${err.name}: ${err.message}` }), isError: true };
      }
    };
    // the SDK's registerTool generics do not narrow well through this helper
    (server.registerTool as (n: string, c: object, h: typeof handler) => unknown)(name, { description, annotations, inputSchema }, handler);
  }

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
    ACTION, { group_id: byte, action: z.enum(['on', 'off', 'light']).default('on'), color, brightness },
    (a) => ctl().group(a.group_id, a.action, a.color, a.brightness));
  tool('play_scene', 'Recall a scene saved in the lights (index as in the app).',
    ACTION, { index: byte }, (a) => ctl().scene(a.index, false));
  tool('save_scene', 'Store the current state of all lights as scene `index` (overwrites that scene).',
    DESTRUCTIVE, { index: byte }, (a) => ctl().scene(a.index, true));
  tool('name_light', 'Give a light (vaddr from list_lights) a friendly name such as "living" or "リビング".',
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, { name: z.string().min(1), vaddr: z.string() },
    (a) => ctl().nameLight(a.name, a.vaddr));
  tool('forget_light_name', 'Remove a light name from the config.',
    DESTRUCTIVE, { name: z.string() }, (a) => ctl().forgetName(a.name));
  return server;
}

function lazyController(): () => Controller {
  let c: Controller | null = null;
  // idle timeout from $ODELIC_IDLE_TIMEOUT / config (0 = stay connected)
  return () => (c ??= new Controller());
}

/** Run the MCP server on stdio (logs go to stderr). */
export async function main(): Promise<void> {
  const server = createMcpServer(lazyController());
  await server.connect(new StdioServerTransport());
}
