# v1.0.9 — DSH 0.2.2-rc.4 対応・描画軽量化・全コンポーネント横断バグ修正

公開日: 2026-11-18

`v1.0.8` 以降の表示・読み込み・通信の軽量化（#144）に加え、DSH `0.2.2-rc.4` への対応、ならびに全パッケージ（`dsh-mobile-maxxing` / `dsh-md-rendering` / `dsh-locale-ja` / `scripts/` / `tools/`）の横断監査で発見した不具合をまとめて修正したリリースです。

---

## 主な変更・潰したバグ一覧

### 1. 表示・読み込み・通信の軽量化（#144）

- **画面外ターンの描画スキップ（`content-visibility: auto`）**: 完了済みの会話ターン（`user` / `turn-process` / `assistant-step`）を実寸計測後にスキップ対象化し、長いセッション（12往復・CPU 4倍低速エミュレーション環境）でのストリーミング Long Task 合計を `11.7秒 → 4.2秒`、最長フレームを `1117ms → 300ms`、スクロール時のスタイル再計算を `2.1秒 → 0.24秒` に削減しました（詳細は [`packages/dsh-mobile-maxxing/docs/PERFORMANCE.ja.md`](packages/dsh-mobile-maxxing/docs/PERFORMANCE.ja.md)）。
- **描画パスの間引き・強制レイアウト削減**:
  - Markdown 本文（段落・リスト・表セル等）のみのストリーミング更新時はドキュメント全体の装飾パスをスキップ。
  - `markScrollers`・`measureSafeArea`・`fitVisualViewport`・44px タップ判定のキャッシュ化と DOM 書き込みの差分限定。
  - 要素追加のたびに全体再評価を起こしていた `html:has(...)` セレクタを属性ベースへ置換し、省アニメーション・ファイル検索 CSS を必要なときだけ別シート適用するよう分離。
- **Service Worker の応答高速化**: ナビゲーション時の Navigation Preload 有効化と、`waitUntil` を使ったバックグラウンドでのシェル・静的アセットキャッシュ書き込みに対応。

### 2. DSH `0.2.2+`（`0.2.2-rc.1` 〜 `0.2.2-rc.4`）互換性の修正

- **アプリシェル自身の `role="dialog"` 誤判定による 4 機能の同時破綻を修正**:
  1. **Android Back 操作の無反応（無限ループ）**: `mobileBack` が常に開いているアプリシェルに `Escape` を送り続けてホーム復帰や終了確認へ進めなくなる問題を解消。
  2. **勝手なキーボード起動を防ぐフォーカス保護（`onFocusInGuard`）の無効化**: `modalOwnedField()` 内の `dialog.closest('[role="dialog"]')` 自己一致バグを修正（親要素から探索）。
  3. **ヘッダー等ボタンの 44px タップ領域拡張（#135）**: `TAP_TARGET_EXCLUDE` がアプリシェルに一致して `data-rdsh-hit44` が全く付かなかった問題を修正。
  4. **Plugins / Automation 画面の見出しインセット**: `decorateRouteHeading` が全 `<h1>` をシェル内として除外していた問題を修正し、FAB との重なりを解消。
- **サイドバー「More」誤非表示による全ナビ消滅を修正（#92 / #147）**: `decorateSidebarSettingsRow` の `"More"` フォールバック探索に `!nav.contains(candidate)` ガードを追加し、`0.2.2-rc.3` / `rc.4` の `nav` 内パネルリスト用 More 行を誤って隠さないよう修正。
- **`dsh-locale-ja` `0.1.4` の互換・翻訳修正**:
  - `peerDependencies` に **`0.2.2-rc.4`** を追加（`0.2.1-rc.2 / 0.2.1-rc.3 / 0.2.2-alpha.2 / 0.2.2-rc.1 / 0.2.2-rc.3 / 0.2.2-rc.4` に対応）。
  - 65 辞書の登録完了**後**に `addLanguage("ja")` を呼ぶ順序へ修正し、0 辞書状態での不要な通知再発火と `dispose` 時の英語フォールバック経由を防止。
  - `conversation` 名前空間で英語のまま残っていた `"row.inspect": "Inspect"` を `"調査"` に翻訳（全 65 名前空間 / 2915 キー・英語 fallback 0）。
  - パッケージ `exports` に `./package.json` 等を追加。

### 3. フロントエンド（`client.js`）で潰したバグ

- **画面外ターン描画スキップ（`data-rdsh-cv`）の境界バグ 4 件を修正**:
  - CSS 変数による文字サイズ変更や「作業の詳細」「完了ターンの折りたたみ」切替時に高さキャッシュ（`resetRenderSkip`）が再計測されずスクロールが跳ぶ不具合。
  - DOM 内に `user` ターンが存在しないとき（`lastUser === -1`）に進行中・ストリーミング中の最新ターンまでスキップ対象になる不具合。
  - `SessionView` が非表示（`[hidden]`）の間に `ResizeObserver` で全画面外ターンが `480px` フォールバック高さで汚染される不具合。
  - 完了済みターンを後から展開した際に内部スクローラへ `data-rdsh-scroll` が付与されない不具合。
- **モデルメニュー閉鎖時の Workspace Picker 誤爆を修正（#55）**: モデルメニュー探索のフォールバックが新規セッション画面の Workspace Picker を誤捕捉し、検索 `<input>` を `disabled` 化＆強制 `blur` していた不具合を修正。
- **`onFocusInGuard` による正規フォーカス強制解除 4 経路を修正**: 外部キーボードの `Tab` 移動、ファイル検索のクリア（`✕`）ボタン（#83）、Workspace Picker 検索欄の初期フォーカス、モデル検索欄の初回タップが直後に `blur` される問題を修正。
- **ビューポート・ツールチップ・状態同期バグを修正**:
  - `decorateFast` 内で `fitVisualViewportPass` が古い `data-rdsh-drawer` を読む順序バグ、`#76` キーボード復帰パスでの `unsettleFit()` 漏れ、プラグイン `dispose` 後の `fitFrame` rAF リークを修正。
  - サイドバートグルが DOM から除去・スライド退避した際に `html[data-rdsh-toggle-hint]` が残留し、画面全体の全ツールチップが表示されなくなる不具合を修正。
  - `clearPhoneHooks()` に `clearSessionLimit()` と `data-rdsh-session-overflow` 掃除を追加し、HMR やアプリ内更新後に「さらに表示（Show more sessions）」が無反応になる不具合を修正。
- **操作・ナビゲーション・テーマ・多言語 UI の不具合を修正**:
  - 左端スワイプ領域（`x <= 28px`）の無条件 `preventDefault()` により、戻るボタン左半分や画像切り抜きボタン等のタップが効かなかった不具合を修正（#74）。
  - `attachSessionOpener` がユーザーの手動画面遷移を上書きして元セッションへ引き戻す問題、および累計 10 回試行後に `attempts` 枯渇で通知タップ遷移が永久停止する不具合を修正。
  - 省アニメーション設定で OS の「視覚効果を減らす」有効時に「標準」が効かない競合・詳細度不足で「オフ」時に右パネルやトーストアニメーションが残る問題を修正し、設定 UI に「OS設定に合わせる（未設定）」選択肢を追加（#144）。
  - キュー長押しメニューが英語 `aria-label` 固定で日本語環境では全項目 `disabled` になる問題、ターミナル仮想 `Ctrl` キーが `Shift`（`Ctrl+^` / `Ctrl+_`）併用時や仮想キーボード入力で早期解除される問題、`decorateEditCards()` の 1 枚目 `break`、タブレット横分割時の質問カード `100vw` 見切れを修正。
  - 2 回目以降の起動で SW 更新通知バナーが検知されない不具合、ローカル表示言語切替時にカラー名・通知音プリセット・`Settings` 行・トースト文言に既定日本語が残り続ける不具合、その他 `ensureFilesSearch`・`openCrop` 二重保存・`enableNotifications` 無限待機・`dispose` 残留を修正。
  - リバースプロキシのサブパス配下（`/dsh/` 等）で先頭 `/` ハードコードだった 6 箇所の API・ルート呼び出し（更新確認・LiveSpeed・ファイル読み込み・ダウンロード等）を相対パス解決へ統一。

### 4. Service Worker・ホスト・Web Push・Markdown 表・配布ツールで潰したバグ

- **Service Worker（`sw.js`）**:
  - 初回導入直後・SW 更新直後にエントリ JS/CSS がキャッシュされずオフライン起動で白画面になる不具合（シェル更新時のアセット先行補完とオフライン HTML フォールバック）を修正。
  - 非 HTML 別タブ遷移（画像・API 等）による `SHELL_URL` キャッシュ破壊と、低速回線時の `/?token=` / `/connect?token=` 認証ハンドオフ阻害を修正。
  - 期限切れキャッシュのバックグラウンド再検証における `event.waitUntil` 漏れ、Navigation Preload タイムアウト時の未処理 Promise、SSE（`/plugins/events`）誤キャッシュ、`notificationclick` での不要な `client.navigate("./")` リロードと未制御ウィンドウへの例外を修正。
- **ホスト側（`index.js`・`lib/mobile-ux.js`・`notify/host.js`）**:
  - `resolveDshCli()` と `dshVersion()` で `process.argv[1]` のシンボリックリンク解決（`realpathSync`）を行い、グローバル npm 導入（`npm i -g @deepseek-ai/dsh`）や systemd 環境でのアプリ内更新 `ENOENT` とバージョン空表示を修正（#145）。
  - `?local=1` リクエストで `checkedRelease` が消去され更新実行が `409` 失敗する問題、タイムアウト終了時のエラー分類漏れ、`packages/dsh-mobile-maxxing` 単体配置時の `package.json` 解決失敗を修正。
  - `/api/rdsh-mobile-ux/download` でダウンロード途中切断時に `fs.ReadStream` が閉じられずファイルディスクリプタ（FD）がリークする問題（`stream.pipeline` 化）と認証ガード統一を修正。
  - `PushStore` の空 JSON（`{}`）起動クラッシュと同時起動時 VAPID 鍵競合、RFC 8188 単一レコード 4096B 上限チェックとサロゲートペア（絵文字）分断回避を修正。
- **Markdown 表（`dsh-md-rendering` `0.1.4`）**:
  - `div > table` にのみ書いていた文字サイズ（`.85rem`）・フォント・行高を `th` / `td` に直接適用し、上流スタイルに負けて死文化していた問題を修正。
  - 単体導入時（`dsh-mobile-maxxing` なし）に詳細度不足で `.md-table-wide` の下余白が消えなかった不具合と `exports` メタデータを修正。
- **配布・翻訳パイプライン（`scripts/`・`tools/`）**:
  - `install-mobile-bundle.mjs` の Windows `dsh.cmd` 非対応・空環境変数・末尾 `/` バグを修正し、既定タグ・バージョンを `v1.0.9` / `0.1.4` へ更新。
  - `pack-all.mjs` が README 内の `dsh-md-rendering` リリースタグ URL も更新するよう修正。
  - `merge-batches.mjs` の URL エンコード名前空間ファイル名解決と重複警告、`extract-upstream.mjs` の引数なし `.join()`・廃止英語辞書ファイル削除・`ForOfStatement` スコープ、`locale-data.mjs` の `{0}` / `_` 始まりプレースホルダ検証を修正。

---

## マージした PR と対応・関連 Issue

### リリース PR

- **PR #155**（`@kuraneko1`）: 上記 `v1.0.9` の描画軽量化・DSH `0.2.2-rc.4` 対応・全パッケージ横断バグ修正・配布物更新

### `main` にマージされた直近 PR と関連 Issue（`v1.0.0`〜`v1.0.9` 系）

| PR | 著者（GitHub） | 内容・関連 Issue |
| --- | --- | --- |
| PR #154 | `@kuraneko1` | v1.0.8 公開準備（ユーザー明示 GO） |
| PR #153 | `@kuraneko1` | Android の広い開始範囲でもドック内の閉じる操作を維持（#74） |
| PR #152 | `@kuraneko1` | 既存 Issue 整理：フロート撤去と Android 開始範囲・モバイル軽量化（#74 / #111 / #112 / #144） |
| PR #151 | `@kuraneko1` | `0.2.2-rc.3` 互換・共有スクロール対応・次版準備（#146 / #147 / #148 / #149 / #150 統合） |
| PR #150 | `@FlowingSPDG` | `fix(notify)`: `/plan` 終了時に削除された `agents.roots()` を呼んで失敗する問題を修正（#149） |
| PR #146 | `@AliceSaikawa` | `fix(mobile)`: DSH `0.2.2-rc.3` で崩れたスマホ表示 2 件（サイドメニューの Settings 行・新規セッション画面の options 配置）（#147） |
| PR #143 | `@AliceSaikawa` | `fix(mobile)`: iOS Safari サイドメニューの不具合 3 件（キーボード閉じ・日本語「新規セッション」・短リストでの実行中行描画） |
| PR #142 | `@sahenjp` | `fix(install)`: バンドルインストーラーの既定タグ固定と本体タグ固定 |
| PR #140 | `@kuraneko1` | `perf(mobile)`: 実測 P0 4 点（`decorate` 間引き・safe-area・スワイプ・LiveSpeed） |
| PR #139 | `@kuraneko1` | `fix(mobile)`: iOS 端スワイプで履歴が戻る退行を修正 |
| PR #138 | `@kuraneko1` | `0.2.2` 対応・戻る操作・モバイル修正・長押し DL・簡体字中国語 README 統合（#126 / #127 / #128 / #129・#125 / #131〜#135 / #145 関連） |
| PR #129 | `@AliceSaikawa` | `feat(locale-ja)`: DSH `0.2.2-alpha.2` の受け入れと上流日本語同梱時の無登録譲歩 |
| PR #126 | `@RNA4219` | モバイルの戻る操作をホームへの遷移と終了確認に統一（#125） |

- **本リリースで直接関連・再解消された主な Issue**: #144（軽量化・省アニメーション改善）、#145（npm グローバル symlink 環境での更新 / バージョン表示）、#147・#92（`0.2.2-rc.3`/`rc.4` での Settings / More 表示）、#135（ヘッダーボタン 44px タップ領域）、#83（ファイル検索クリア後のフォーカス）、#76（キーボード復帰時の viewport 状態復元）、#74（左端スワイプとボタンタップの両立）、#55（モデル／Workspace 検索フォーカス）。
- **直近シリーズで対応済みの関連 Issue**: #149（`exit_plan_mode` 失敗）、#148（過去セッション一覧のスクロール）、#131〜#134（オフライン復帰・sidebarRight 例外・終了確認重なり・設定 Esc 閉じ）、#125（モバイル Back 統一）、#111 / #112（フロート整理と仮想画面撤去）、#106 / #98 / #88 / #86 / #85（通知精度・前面抑止・テスト通知）、#103 / #100 / #99 / #97 / #87 / #84 / #82 / #81 / #80 / #79 / #78 / #77。

---

## 貢献者（GitHub）

このリリースおよび基盤となる実装・バグ報告に協力いただいた皆さんに感謝します。

- **コード・PR 貢献**
  - [@kuraneko1](https://github.com/kuraneko1)（`_ryu15_` 名義のコミットを含む）
  - [@AliceSaikawa](https://github.com/AliceSaikawa)
  - [@FlowingSPDG](https://github.com/FlowingSPDG)
  - [@sahenjp](https://github.com/sahenjp)
  - [@RNA4219](https://github.com/RNA4219)
  - [@yebisu0529-ship-it](https://github.com/yebisu0529-ship-it)
  - [@LYB926](https://github.com/LYB926)
  - [@PyGuy2](https://github.com/PyGuy2)
- **Issue 報告・実機検証・改善提案**
  - [@neutron42-jp](https://github.com/neutron42-jp)
  - [@tjm8874](https://github.com/tjm8874)
  - [@henaxxx](https://github.com/henaxxx)
  - [@onemunanoyo](https://github.com/onemunanoyo)

---

## 配布物・インストール

| パッケージ | 版 | 内容 |
| --- | --- | --- |
| `dsh-mobile-maxxing` | 1.0.9 | PWA・通知・モバイル UX・描画軽量化・横断バグ修正 |
| `dsh-md-rendering` | 0.1.4 | モバイル向け Markdown 表表示（セル文字サイズ・単体モード詳細度修正） |
| `dsh-locale-ja` | 0.1.4 | `0.2.2-rc.4` 互換追加・登録順修正・65名前空間 / 2915キー / 英語 fallback 0 |

### 3 コンポーネント一括導入

```sh
curl -fsSL https://raw.githubusercontent.com/kuraneko1/dsh-mobile-maxxing/main/scripts/install-mobile-bundle.mjs | node --input-type=module
```

別プロファイルへ導入する場合は `DSH_PROFILE=<name>` を指定してください。導入後は DSH を再起動し、ブラウザ / PWA を再読み込みしてください。添付成果物の整合性は同梱の `SHA256SUMS` で確認できます。

---

## 検証と残る制限

- **自動テスト・ロケール検証**:
  - `npm test`: **864 件中 849 成功 / 0 失敗 / 15 スキップ**（スキップ 15 件は未接続 Chrome CDP 用 12 件・`DSH_COMPAT_URLS` 未指定 1 件・リンクチャンク連携用 2 件）
  - `npm run test:locale`: **43 / 43 成功（0 失敗）**
  - `npm run check:locale` / `npm run check:locale:generated`: **65 名前空間 / 2915 キー / 2915 翻訳 / 英語 fallback 0**
- **稼働確認**: ローカル開発環境（`:8445` / DSH **`0.2.2-rc.4`**）でのサービス起動と `dsh-mobile-maxxing` 配信を確認済み。
- **残る制限**:
  - **#136**: 上流 `open-in-app` の `/open-in-app/icon/*` 404 は上流側仕様のため未解消。
  - **#70 / #74 / #144**: iPhone / iPad / Android の全実機・OS Back 競合（Nothing OS / Android 16 / Brave 等）・実機バッテリー / CPU 体感・実 Push 配送は自動テスト（headless Chrome エミュレーションを含む）のみでは代替できないため継続確認対象です。
