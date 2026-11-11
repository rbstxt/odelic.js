# odelic.js

An **unofficial** Node.js library for controlling ODELIC Bluetooth lights from a PC. This is the JavaScript port of the Python package [odelic.py](https://github.com/rbstxt/odelic.py), with the same features.

It was built by analyzing the communication protocol of the official Android app (`jp.co.odelic.smt.remote10` v1.10.39). It targets devices that use the Pairlink connected-mesh protocol. It does not use the cloud; it controls the lights directly and locally over BLE.

- The only BLE dependency is [@stoprocent/noble](https://github.com/stoprocent/noble). Encryption (AES-128) uses Node's built-in `crypto`.
- Tested on macOS. It should also work in any environment noble supports (Linux / Windows).
- The config file (`~/.config/odelic/config.json`) has the same format as the Python version and can be shared with it.
- This tool is not endorsed by the manufacturer. Use it at your own risk.

## Setup

Requires Node.js 20 or later.

```sh
npm install odelic
# To use the MCP server, also install these
npm install @modelcontextprotocol/sdk zod
```

For development (from this repository):

```sh
npm install
npm test
```

### Required information: the app ID

The app's menu screen shows something like `ID:12345678`. It is **the HomeID followed by the password (the last 4 characters)**. In this example the HomeID is 1234 and the password is `5678`.

```sh
odelic setup --id 12345678        # save it to the config file (permissions 600)
# or specify it each time with --id / the ODELIC_ID environment variable
```

## CLI

```sh
odelic scan                                   # find nearby mesh nodes (no login)
odelic lights                                 # list the lights in the mesh (vaddr / MAC / product code)
odelic on                                     # turn all on (restores the previous color and brightness)
odelic off                                    # turn all off
odelic light --color 0 --brightness 100       # warm (電球色) at full brightness
odelic light --color 100 --brightness 30      # cool (昼光色) at 30%
odelic night --level 0                        # night light (0-2)
odelic status                                 # on/off, color and brightness of every light
odelic name add リビング 00000000              # give a light a name (vaddr from `lights`)
odelic off リビング                            # control a single light by name or vaddr
odelic group 1 on                             # per group (the group ID is set in the app)
odelic scene save 1 / odelic scene play 1     # save and recall scenes
odelic -v ...                                 # show sent and received packets
```

### Auto-disconnect or stay connected

A mesh node **can connect to only one controller at a time**. To keep the phone app usable, the HTTP API and MCP server drop the BLE connection after 60 seconds of inactivity by default. If you don't use the phone app, you can keep the connection open.

```sh
odelic setup --keep-connected     # always stay connected
odelic setup --idle 300           # disconnect after 300 idle seconds
```

Priority: command option (`--idle` / `--keep-connected`) → environment variable `ODELIC_IDLE_TIMEOUT` (`0` keeps the connection) → config file → default 60 seconds.

## Using it as a library

```js
import { OdelicMesh } from 'odelic';

const mesh = new OdelicMesh(process.env.ODELIC_ID);
await mesh.connect();
try {
  await mesh.setLight({ color: 0, brightness: 100 }); // 0 = warm .. 100 = cool
  for (const d of await mesh.devices()) console.log(String(d));
  console.log((await mesh.status('00000000'))?.toJSON());
  await mesh.off();
} finally {
  await mesh.disconnect();
}
```

| Method | Description |
|---|---|
| `on(target)` / `off(target)` | Turn on / off. Omit `target` (vaddr) to target every light |
| `setLight({color, brightness, target, x, y})` | Set color and brightness. Raw values x (0–20) / y (0–19, 0 is brightest) also work |
| `nightLight(level, target)` | Night light (the 3 dimmest warm levels) |
| `setGroup(groupId, {color, brightness, on})` | Per-group control |
| `changeColor(target)` | Cycle color presets (supported models only) |
| `saveScene(i)` / `playScene(i)` | Save and recall scenes |
| `devices()` | List the lights in the mesh via ping |
| `status(target)` | Query state (`LightState`: `on` / `color` / `brightness`) |
| `send(packet)` | Encrypt and send any type-3 packet (see `protocol`) |
| `addListener(cb)` | Receive every incoming packet, decrypted |

`Controller` is a higher-level class that handles name resolution, auto connect/reconnect, and idle disconnect (used internally by the CLI, HTTP, and MCP).

```js
import { Controller } from 'odelic';

const ctl = new Controller();               // ID from ODELIC_ID / config file
await ctl.setLight('リビング', 0, 100);      // target, color, brightness
console.log(await ctl.status('all'));
await ctl.close();
```

Timeouts and the idle duration are all given in **seconds**, matching the Python version and the config file.

## HTTP API

```sh
odelic serve                          # http://127.0.0.1:8765
odelic serve --keep-connected         # connect at startup and keep the connection
odelic serve --host 0.0.0.0 --token s3cret   # a token is required to listen beyond localhost
```

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Connection status |
| GET | `/lights` | List lights |
| GET | `/lights/<target>` | State (`all` = every light) |
| POST | `/lights/<target>/on` · `/off` | Turn on / off |
| POST | `/lights/<target>/light` | `{"color": 0..100, "brightness": 1..100}` |
| POST | `/lights/<target>/night` | `{"level": 0..2}` |
| POST | `/groups/<id>/on` · `/off` · `/light` | Group control |
| POST | `/scenes/<index>/play` · `/save` | Scenes |

Parameters can be passed as a JSON body or as query parameters. When a token is set, use `Authorization: Bearer <token>` (or `?token=`).

```sh
curl -X POST localhost:8765/lights/リビング/light -d '{"color": 0, "brightness": 80}'
```

## MCP server (for AI assistants)

This lets Claude and other AI tools control the lights. It requires `@modelcontextprotocol/sdk` and `zod`.

```sh
claude mcp add odelic -e ODELIC_ID=12345678 -- npx -y -p odelic -p @modelcontextprotocol/sdk -p zod odelic-mcp
```

Configuration file example (Claude Desktop, etc.):

```json
{
  "mcpServers": {
    "odelic": {
      "command": "npx",
      "args": ["-y", "-p", "odelic", "-p", "@modelcontextprotocol/sdk", "-p", "zod", "odelic-mcp"],
      "env": { "ODELIC_ID": "12345678" }
    }
  }
}
```

To run it from a local checkout, use `"command": "node", "args": ["/path/to/odelic-js/bin/odelic-mcp.js"]`.

Tools: `list_lights` `light_status` `turn_on` `turn_off` `set_light` `night_light` `control_group` `play_scene` `save_scene` `name_light` `forget_light_name`

## Notes

- If the phone app is connected, you'll get `node is already in use by another controller`. Close the app or turn off Bluetooth on the phone and try again.
- On macOS, the first run asks for Bluetooth permission for the terminal (or whatever app runs it).
- **Registering new lights** is not supported. The app registers lights by having the phone broadcast a custom-format signal, and macOS's standard Bluetooth stack cannot broadcast that format. Register lights with the app.

## Protocol overview

| Item | Details |
|---|---|
| GATT service | `9e5d1e47-5c13-43a0-8635-82adffc0386f` (write `…ffc1…` / notify `…ffc2…`) |
| Key | An AES-128 key made of the 8 bytes formed by interleaving the HomeID (4B, little endian) and the password (4B) one byte at a time, followed by `"LOGINKEY"` or `"EVENTKEY"` |
| Login | Send `01 20` → node returns `02 20 + AES_L(homeid, session4)` → reply with `01 16 03 + AES_L(homeid, pwd, session4)` → `02 16 00` means success (`08` means another device is connected) → `01 0a <own vaddr>` assigns your address |
| Data | Plaintext `03 <dst4> <ch> <payload>` becomes `06 <dst4> <ch> XOR(AES_E(pkcs7(payload)), session4)` |
| Light command | `<own vaddr> C0 <index> <x> <y> 00 00 00 00`, ch=0x20 (0x2A when broadcasting to all). x=55,y=55 turns on, 50,50 turns off |

The tests use test vectors generated by running the original app's native library in an emulator (the same ones as the Python version; see `tools/native_oracle.py` in odelic.py).

## Releasing

Publishing a GitHub release runs `.github/workflows/publish.yml`, which publishes to npm via npm Trusted Publishing (OIDC) — no token needed.

1. Bump the version in `package.json` and `src/version.js`, then push
2. Create a GitHub release with the tag `v<version>` (e.g. `v0.2.1`)

## License

MIT License ([LICENSE](LICENSE))
