# odelic.js

ODELIC（オーデリック）の Bluetooth 照明を PC から操作するための**非公式** TypeScript / Node.js ライブラリです。Python 版 [odelic.py](https://github.com/rbstxt/odelic.py) を TypeScript に移植したもので、機能は同じです。型定義も同梱しています。

公式 Android アプリ（`jp.co.odelic.smt.remote10` v1.10.39）の通信方式を解析して作りました。対象はアプリが使っている Pairlink connected-mesh 系の機器です。クラウドは使わず、BLE でローカルに直接操作します。

- BLE 用の依存ライブラリは [@stoprocent/noble](https://github.com/stoprocent/noble) だけです。暗号処理（AES-128）は Node 標準の `crypto` を使っています。
- macOS で動作を確認しています。noble が対応する環境（Linux / Windows）でも動く想定です。
- 設定ファイル（`~/.config/odelic/config.json`）は Python 版と同じ形式で、共有できます。
- メーカー非公認のツールです。利用は自己責任でお願いします。

## セットアップ

Node.js 22 以上が必要です。

```sh
npm install odelic
# MCP サーバーを使う場合は、これらも入れてください
npm install @modelcontextprotocol/sdk zod
```

開発用（このリポジトリから）:

```sh
npm install
npm run typecheck   # src/ と test/ の型チェック
npm test            # .ts のテストをそのまま実行（Node 標準の型除去機能を使用）
npm run build       # src/ を dist/ にコンパイル（JS と .d.ts）。bin/ の CLI は dist/ を使います
```

### 必要な情報：アプリの ID

アプリのメニュー画面に `ID:12345678` のような表示があります。これは **HomeID とパスワード（末尾4文字）をつなげたもの**です。この例では HomeID が 1234、パスワードが `5678` になります。

```sh
odelic setup --id 12345678        # 設定ファイルに保存（権限 600）
# または毎回 --id / 環境変数 ODELIC_ID で指定
```

## CLI

```sh
odelic scan                                   # 近くのメッシュノードを探す（ログインしない）
odelic lights                                 # メッシュ内の照明一覧（vaddr / MAC / 製品コード）
odelic on                                     # 全点灯（前回の色・明るさに戻る）
odelic off                                    # 全消灯
odelic light --color 0 --brightness 100       # 暖色（電球色）で最大の明るさ
odelic light --color 100 --brightness 30      # 寒色（昼光色）で 30%
odelic night --level 0                        # 常夜灯（0〜2）
odelic status                                 # 全照明の点灯状態・色・明るさ
odelic name add リビング 00000000              # 照明に名前を付ける（vaddr は lights で確認）
odelic off リビング                            # 名前か vaddr で1台だけ操作
odelic group 1 on                             # グループ単位（グループ ID はアプリでの設定）
odelic scene save 1 / odelic scene play 1     # シーンの保存・呼び出し
odelic -v ...                                 # 送受信パケットを表示する
```

### 自動切断か常駐か

メッシュノードは**同時に 1 台のコントローラとしか接続できません**。スマホのアプリも使えるように、HTTP API と MCP サーバーは既定で 60 秒操作がなければ BLE 接続を切ります。スマホのアプリを使わないなら、つなぎっぱなしにできます。

```sh
odelic setup --keep-connected     # 常に接続したままにする
odelic setup --idle 300           # 300 秒操作がなければ切断
```

優先順位：コマンドのオプション（`--idle` / `--keep-connected`）→ 環境変数 `ODELIC_IDLE_TIMEOUT`（`0` で常駐）→ 設定ファイル → 既定値 60 秒

## ライブラリとして使う

```ts
import { OdelicMesh } from 'odelic';

const mesh = new OdelicMesh(process.env.ODELIC_ID ?? null);
await mesh.connect();
try {
  await mesh.setLight({ color: 0, brightness: 100 }); // 0 = 暖色 .. 100 = 寒色
  for (const d of await mesh.devices()) console.log(String(d));
  console.log((await mesh.status('00000000'))?.toJSON());
  await mesh.off();
} finally {
  await mesh.disconnect();
}
```

| メソッド | 内容 |
|---|---|
| `on(target)` / `off(target)` | 点灯・消灯。`target`（vaddr）を省略すると全照明が対象 |
| `setLight({color, brightness, target, x, y})` | 色と明るさの指定。生の値 x (0–20) / y (0–19, 0 が最も明るい) でも指定可 |
| `nightLight(level, target)` | 常夜灯（暖色の最も暗い 3 段階） |
| `setGroup(groupId, {color, brightness, on})` | グループ単位の操作 |
| `changeColor(target)` | 色プリセットの切り替え（対応機種のみ） |
| `saveScene(i)` / `playScene(i)` | シーンの保存・呼び出し |
| `devices()` | ping でメッシュ内の照明を列挙 |
| `status(target)` | 状態の問い合わせ（`LightState`: `on` / `color` / `brightness`） |
| `send(packet)` | 任意の type-3 パケットを暗号化して送信（`protocol` を参照） |
| `addListener(cb)` | 受信した全パケットを復号済みで受け取る |

名前の解決・自動接続と再接続・アイドル切断までまとめた上位クラス `Controller` もあります（CLI・HTTP・MCP の内部で使用）。

```ts
import { Controller, type LightStatus } from 'odelic';

const ctl = new Controller();               // ID は ODELIC_ID / 設定ファイルから
await ctl.setLight('リビング', 0, 100);      // 対象, 色, 明るさ
const states: LightStatus | LightStatus[] = await ctl.status('all');
await ctl.close();
```

タイムアウトやアイドル時間の単位は、Python 版や設定ファイルに合わせてすべて**秒**です。

## HTTP API

```sh
odelic serve                          # http://127.0.0.1:8765
odelic serve --keep-connected         # 起動時に接続し、つなぎっぱなしにする
odelic serve --host 0.0.0.0 --token s3cret   # localhost 以外で待ち受けるにはトークンが必須
```

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/health` | 接続状態 |
| GET | `/lights` | 照明一覧 |
| GET | `/lights/<target>` | 状態（`all` で全照明） |
| POST | `/lights/<target>/on` · `/off` | 点灯・消灯 |
| POST | `/lights/<target>/light` | `{"color": 0..100, "brightness": 1..100}` |
| POST | `/lights/<target>/night` | `{"level": 0..2}` |
| POST | `/groups/<id>/on` · `/off` · `/light` | グループ操作 |
| POST | `/scenes/<index>/play` · `/save` | シーン |

パラメータは JSON ボディでもクエリパラメータでも渡せます。トークンを設定した場合は `Authorization: Bearer <token>`（または `?token=`）が必要です。

```sh
curl -X POST localhost:8765/lights/リビング/light -d '{"color": 0, "brightness": 80}'
```

## MCP サーバー（AI アシスタント向け）

Claude などの AI から照明を操作できます。`@modelcontextprotocol/sdk` と `zod` が必要です。

```sh
claude mcp add odelic -e ODELIC_ID=12345678 -- npx -y -p odelic -p @modelcontextprotocol/sdk -p zod odelic-mcp
```

設定ファイルに書く場合（Claude Desktop など）:

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

このリポジトリから直接動かす場合は、一度 `npm run build` してから `"command": "node", "args": ["/path/to/odelic-js/bin/odelic-mcp.js"]` を指定してください。

ツール一覧：`list_lights` `light_status` `turn_on` `turn_off` `set_light` `night_light` `control_group` `play_scene` `save_scene` `name_light` `forget_light_name`

## 注意

- スマホのアプリが接続中だと `node is already in use by another controller` になります。アプリを閉じるか、スマホの Bluetooth を切ってから試してください。
- macOS では初回実行時に、ターミナル（または実行元のアプリ）への Bluetooth 許可を求められます。
- **新しい照明の登録**には未対応です。アプリはスマホから独自形式の電波を発信して登録していますが、macOS の標準 Bluetooth 機能ではその形式を発信できません。登録はアプリで行ってください。

## プロトコル概要

| 項目 | 内容 |
|---|---|
| GATT サービス | `9e5d1e47-5c13-43a0-8635-82adffc0386f`（書き込み用 `…ffc1…` / 通知用 `…ffc2…`） |
| 鍵 | HomeID（4B, little endian）とパスワード（4B）を 1 バイトずつ交互に並べた 8B に、`"LOGINKEY"` または `"EVENTKEY"` を連結した AES-128 鍵 |
| ログイン | `01 20` を送る → ノードが `02 20 + AES_L(homeid, session4)` を返す → `01 16 03 + AES_L(homeid, pwd, session4)` を返す → `02 16 00` が来れば成功（`08` は他の端末が接続中） → `01 0a <own vaddr>` で自分のアドレスが割り当てられる |
| データ | 平文 `03 <dst4> <ch> <payload>` を `06 <dst4> <ch> XOR(AES_E(pkcs7(payload)), session4)` に変換 |
| 照明命令 | `<own vaddr> C0 <index> <x> <y> 00 00 00 00`、ch=0x20（全体宛は 0x2A）。x=55,y=55 で点灯、50,50 で消灯 |

テストでは、元アプリのネイティブライブラリをエミュレータで動かして作ったテストベクタと照合しています（Python 版と同じもの。odelic.py の `tools/native_oracle.py` を参照）。

## リリース

GitHub でリリースを作ると、`.github/workflows/publish.yml` が npm へ公開します。npm の Trusted Publishing（OIDC）を使うので、トークンは不要です。

1. `package.json` と `src/version.ts` のバージョンを上げてプッシュ
2. GitHub で `v<バージョン>` タグのリリースを作成（例: `v0.2.1`）

## ライセンス

MIT License（[LICENSE](LICENSE)）
