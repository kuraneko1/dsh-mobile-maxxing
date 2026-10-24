# dsh-mobile-maxxing — `rdsh-pwa`

DSH（DeepSeek Harness）の Web UI をスマホで使い倒すための統合プラグインです。
PWA・通知・モバイルUX・CJK表示の修正・セッションIDのコピーを1パッケージにまとめています。
**素の DSH にそのまま入ります。** 他の `rdsh-*` プラグインも外部 npm パッケージも不要です。

> English: [Jump to the English section](#english)

![インストールカード](docs/install-card.png)

## インストール

```sh
cd ~/.dsh/profiles/web
dsh plugin add https://github.com/kuraneko1/dsh-mobile-maxxing/releases/download/v0.3.3/rdsh-pwa-0.3.3.tgz
# DSH を再起動（例: systemctl --user restart dsh-web.service）
```

`dsh plugin add` が依存と bundle の両方を更新します。手で書く場合はこうです。

```json
{
  "dependencies": {
    "rdsh-pwa": "https://github.com/kuraneko1/dsh-mobile-maxxing/releases/download/v0.3.3/rdsh-pwa-0.3.3.tgz"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "rdsh-pwa"]
    }
  }
}
```

```sh
npm install        # プロファイル内。pnpm でも可
```

開発中にこのチェックアウトを使う場合:

```sh
ln -sfn /path/to/dsh-mobile-maxxing/packages/rdsh-pwa ~/.dsh/profiles/web/node_modules/rdsh-pwa
```

**必要なのはこれだけです。** 追加のプラグインも、`web-push` などのライブラリも要りません。

## できること

| 機能 | 内容 |
| --- | --- |
| インストール可能な PWA | ホーム画面に追加、オフライン起動、更新のお知らせ |
| 通知 | アプリを見ている間はアプリ内バナー、それ以外は Web Push |
| 通知音 | 合成した5種類。音量も設定可。音声ファイルは同梱しません |
| スマホ幅のレイアウト | サイドバーがドロワーに、設定は1タップ、コードは折り返し |
| テーマ（ライト／ダーク） | 上流のトークンに追従。PC と別に「この端末だけ」の配色を選べる |
| CJK 表示の修正 | `**https://x**（メモ）` の太字とリンクが壊れない |
| セッションIDのコピー | セッションメニューに1行追加 |

## もっと詳しく

使い方・通知の仕組み・設定・既知の制限・クレジットは別ファイルにまとめています。

- **日本語**: [`docs/USAGE.ja.md`](docs/USAGE.ja.md)
- **English**: [`docs/USAGE.en.md`](docs/USAGE.en.md)

## 開発

```sh
npm test     # ブラウザ不要のテスト114件
```

ビルド工程はありません。`client.js` はブラウザにそのまま配信され、`index.js` は Node
標準モジュールだけで動きます。

---

# English

A single integrated plugin that makes the DSH (DeepSeek Harness) Web UI pleasant on a phone:
installable PWA, notifications, phone-width layout, a CJK rendering fix and a session-id copy
row. **It installs on a stock DSH** — no other `rdsh-*` plugin and no external npm package.

## Install

```sh
cd ~/.dsh/profiles/web
dsh plugin add https://github.com/kuraneko1/dsh-mobile-maxxing/releases/download/v0.3.3/rdsh-pwa-0.3.3.tgz
# then restart DSH (e.g. systemctl --user restart dsh-web.service)
```

`dsh plugin add` updates both the dependency and the bundle list. By hand:

```json
{
  "dependencies": {
    "rdsh-pwa": "https://github.com/kuraneko1/dsh-mobile-maxxing/releases/download/v0.3.3/rdsh-pwa-0.3.3.tgz"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "rdsh-pwa"]
    }
  }
}
```

```sh
npm install        # inside the profile; pnpm works too
```

To develop against this checkout:

```sh
ln -sfn /path/to/dsh-mobile-maxxing/packages/rdsh-pwa ~/.dsh/profiles/web/node_modules/rdsh-pwa
```

**That is all.** No companion plugin, no `web-push`, no build step.

## What it does

| Feature | Detail |
| --- | --- |
| Installable PWA | Add to home screen, offline launch, update notice |
| Notifications | In-app banner while the app is on screen, Web Push otherwise |
| Notification sounds | Five synthesised presets with a volume control; no audio files ship |
| Phone layout | Sidebar becomes a drawer, settings open in one tap, code wraps |
| Light / dark theme | Follows the host tokens; a per-device palette can differ from the PC |
| CJK rendering | `**https://x**（memo）` keeps its bold and its link |
| Session id copy | One row in the session row menu |

## More detail

- **English**: [`docs/USAGE.en.md`](docs/USAGE.en.md)
- **日本語**: [`docs/USAGE.ja.md`](docs/USAGE.ja.md)

## Development

```sh
npm test     # 114 tests, no browser required
```

There is no build step: `client.js` is served verbatim and `index.js` uses only Node
built-ins.

## License

MIT. See [LICENSE](LICENSE). Credits for the referenced implementations are in
[`docs/USAGE.en.md`](docs/USAGE.en.md#credits).
