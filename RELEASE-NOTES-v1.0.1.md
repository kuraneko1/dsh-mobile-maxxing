# dsh-mobile-maxxing v1.0.1 リリースノート

公開日: 2026-11-03

v1.0.0 で整えた3コンポーネント構成（モバイル本体・Markdown 表・日本語化）は変えずに、**モバイルの「戻る」操作の統一**と **DSH 0.2.2 系への追従** を入れた修正リリースです。

## 主な変更

### モバイルの戻る操作（#126 / Issue #125）

Android の戻るキーと iOS の画面左端からの右スワイプを、同じ「1段戻る」操作として扱うようにしました。

- 開いているダイアログ・メニュー → ドロワー → 右パネル → 詳細画面 → ホーム、の順に閉じます。閉じる対象があるときに画面が飛ばないので、誤操作で会話が消えません。
- ホームで戻ると「終了しますか？」を表示し、「キャンセル」でホームに留まります。「はい」は終了を試み、ブラウザーが拒否した場合は手動で閉じる案内を出します（Web からは OS のタスクを終了できません）。
- セッションから戻るときは、同じワークスペースの空のセッションと未送信の下書きを引き継ぎます。ワークスペースと入力内容が失われません。
- 0.7 系で作られた Android 専用の戻る実装（#124）は、この実装と二重に履歴を制御してしまうため取り込みませんでした。

### DSH 0.2.2 系への追従（#129）

- DSH 0.2.2-alpha.2 以降は本体が日本語 UI を持っているため、その場合は `dsh-locale-ja` が自前の辞書を登録せず、本体の日本語に任せます。二重登録や表示の食い違いが起きません。
- peer 依存に `0.2.2-alpha.2` を追加し、この版で「互換性なし」としてプラグインが読み込まれなくなる問題を解消しました。

### ドキュメント（#121 / #122 / #123）

- 英語 README を別ファイル（`README.en.md`）へ分離しました。
- 導入・設定・障害対応の記述を充実させました。
- 実装の参考元の記載を修正しました。

## インストール

```bash
dsh plugin add https://github.com/kuraneko1/dsh-mobile-maxxing/releases/download/v1.0.1/dsh-mobile-maxxing-1.0.1.tgz
dsh plugin add https://github.com/kuraneko1/dsh-mobile-maxxing/releases/download/v1.0.1/dsh-md-rendering-0.1.3.tgz
dsh plugin add https://github.com/kuraneko1/dsh-mobile-maxxing/releases/download/v1.0.1/dsh-locale-ja-0.1.2.tgz
```

## コンポーネント構成

| コンポーネント | 版 |
| --- | --- |
| dsh-mobile-maxxing | 1.0.1（GitHub タグ: v1.0.1） |
| dsh-md-rendering | 0.1.3 |
| dsh-locale-ja | 0.1.2 |

## 既知の制限

- 戻る操作は **iPhone / iPad / Android の実機では未検証**です（自動テストは 26 件追加済み、すべて成功）。
- DSH `0.2.1-rc.4` / `0.2.1-rc.5` は peer 範囲に含めていません。これらの版では `dsh-locale-ja` が読み込まれず英語 UI になります。
- 通知（Issue #85 / #86）は継続課題です。Android 実機での Web Push 受信は未確認のままです。
- フロート新規生成と仮想ウィンドウは安定版の対象外です（#114 で一時停止中）。

## 検証

- 自動テスト: 本体 680 件（666 pass / 14 skip / 0 fail）、locale 41 件（41 pass）
- `node tools/build-client.mjs --check`: 65名前空間 / 2915キー、英語フォールバック 0
- `node tools/extract-upstream.mjs --check`: 上流スナップショットと一致
