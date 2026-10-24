/**
 * rdsh-pwa — UI copy, in one place.
 *
 * The package used to ship Japanese literals in `client.js`, `sw.js` and
 * `notify/host.js` while the shell it decorates is served in `en`. This module
 * is the single source of those strings: the host half injects the table into
 * the page (`globalThis.__RDSH_PWA_COPY__`) and the service worker config, so
 * no UI copy lives in the code that renders it.
 *
 * `en` is complete and is the authoritative key list. `ja` carries every one
 * of those keys with the reference build's Japanese copy; a later key only has
 * to be assigned in both packs. Every lookup still falls back to `en` per key,
 * so a partially filled pack is safe.
 *
 * `PROBES` is different: those are *upstream* labels this plugin matches to
 * find controls, not text it renders. They stay bilingual on purpose so a
 * future `ja` shell keeps working. Do not translate them; add a locale.
 *
 * @module rdsh-pwa/copy
 */

/** Every string this package renders, keyed by namespace. */
export const COPY = {
	en: {
		// --- manifest -------------------------------------------------------
		"manifest.description": "Launch DeepSeek Harness as an app.",
		"manifest.screenshot.chat": "Chat",
		"manifest.screenshot.desktop": "Desktop view",

		// --- settings tabs --------------------------------------------------
		"tab.pwa": "App",
		"tab.mobile": "Mobile",
		"tab.input": "Input",

		// --- PWA section ----------------------------------------------------
		"pwa.install.promptable": "Install DSH as an app",
		"pwa.install.iosHint": "Add it to your Home Screen from Safari's Share menu",
		"pwa.install.button": "Install",
		"pwa.install.title": "Install as an app",
		"pwa.later": "Later",
		"pwa.update.available": "A new version is available",
		"pwa.update.reload": "Reload",
		"pwa.offline": "Offline — waiting to reconnect",
		"pwa.sw.activeUpdate": "Active (update pending)",
		"pwa.sw.active": "Active",
		"pwa.sw.unsupported": "Not supported in this browser",
		"pwa.sw.insecure": "Off (requires HTTPS or localhost)",
		"pwa.sw.shared": "Controlled by another service worker (cache off)",
		"pwa.sw.error": "Registration failed",
		"pwa.sw.pending": "Preparing",
		"pwa.install.state.standalone": "Installed (running as an app)",
		"pwa.install.state.installable": "Available",
		"pwa.install.state.ios": "Safari Share menu → Add to Home Screen",
		"pwa.install.state.insecure": "Open over HTTPS to install",
		"pwa.install.state.unsupported": "Not available in this browser",
		"pwa.install.accepted": "Installed.",
		"pwa.install.dismissed": "Cancelled.",
		"pwa.install.unavailable": "The install prompt is not available in this environment.",
		"pwa.check.noWorker": "No service worker is registered.",
		"pwa.check.available": "A new version is available.",
		"pwa.check.latest": "Up to date.",
		"pwa.check.failed": "Could not check (you may be offline).",
		"pwa.section.title": "App (PWA)",
		"pwa.section.desc": "Launches DSH in its own app window and keeps the screen available offline.",
		"pwa.row.displayMode": "Display mode",
		"pwa.row.displayMode.standalone": "App (standalone)",
		"pwa.row.displayMode.browser": "Browser",
		"pwa.row.install": "Install",
		"pwa.row.offline": "Offline launch",
		"pwa.row.build": "Build",
		"pwa.action.reloadUpdate": "Reload to update",
		"pwa.action.checking": "Checking…",
		"pwa.action.check": "Check for updates",
		"pwa.note.ios": "iPhone / iPad: choose Add to Home Screen from Safari's Share button to launch it as an app.",
		"pwa.note.insecure": "Offline launch and installation work only over HTTPS or localhost.",
		"pwa.note.swError": "Service worker registration failed: {error}",
		"pwa.note.bootError": "Boot error: {error}",

		// --- mobile settings -------------------------------------------------
		"mux.nav.scrollLeft": "Scroll settings tabs left",
		"mux.nav.scrollRight": "Scroll settings tabs right",
		"mux.stats.turn": "{count} turn",
		"mux.stats.turns": "{count} turns",
		"mux.stats.tokPerSec": "{speed} tok/s",
		"mux.stats.cacheHit": "Cache hit {percent}%",
		"mux.settingsRow": "Settings",
		"mux.fab.open": "Open session list",
		"mux.fab.openWithCount": "Open session list ({count} unread or waiting)",
		"mux.toast.noFileInput": "No file input is available for attachments",
		"mux.detail.todo": "Todo",
		"mux.detail.goal": "Goal",
		"mux.section.title": "Mobile UI",
		"mux.section.desc": "Adapts the layout and controls to phone width. Settings are stored in this browser.",
		"mux.section.desc.desktop": "The phone layout and its controls apply only on a phone or in the installed app. This desktop window keeps the stock layout.",
		"mux.section.plusNote": "+ opens image and file attachments only (commands start with /).",
		"mux.deviceTheme.title": "Theme (this device only)",
		"mux.deviceTheme.desc": "Pick a palette for this browser alone. The choice is saved here and does not affect your other devices.",
		"mux.deviceTheme.label": "Palette",
		"mux.deviceTheme.note": "The shared theme lives in Settings → General → Appearance. A choice here overrides it on this device only.",
		"mux.deviceTheme.custom": "A custom (registered) theme is active, so the per-device override is disabled.",
		"mux.deviceTheme.unsupported": "This DSH version could not apply a per-device palette, so the shared theme stays.",
		"mux.deviceTheme.follow": "Follow the shared theme",
		"mux.deviceTheme.light": "Light",
		"mux.deviceTheme.dark": "Dark",
		"mux.deviceTheme.system": "Match this device",
		"mux.row.layout": "Layout",
		"mux.row.layout.narrow": "Phone width (drawer)",
		"mux.row.layout.wide": "Desktop width",
		"mux.row.sessions": "Session list",
		"mux.row.sessions.open": "Open",
		"mux.row.sessions.closed": "Closed",
		"mux.row.notifications": "Notifications",
		"mux.row.build": "UI build",
		"mux.action.enable": "Enable notifications",
		"mux.action.reRegister": "Re-register notifications",
		"mux.action.test": "Test notification",
		"mux.action.disable": "Turn off notifications",
		"mux.message.enabled": "Notifications enabled.",
		"mux.message.testSent": "Test notification sent (via push).",
		"mux.message.disabled": "Notifications turned off.",
		"mux.note.blocked": "Notifications are blocked. Set Notifications to Allow in this site's browser settings.",
		"mux.sound.title": "Notification sound",
		"mux.sound.desc": "Plays while the app is open. The browser synthesises the sound, so no audio files are needed.",
		"mux.sound.preview": "Preview",
		"mux.sound.volume": "Volume",
		"mux.sound.none": "None",
		"mux.sound.chime": "Chime",
		"mux.sound.pop": "Pop",
		"mux.sound.drop": "Drop",
		"mux.sound.tick": "Tick",
		"mux.note.notifyScope": "Notifies on turn end and questions. Only the main agent is covered. By default, only turns sent from this phone are notified.",
		"mux.notify.deviceTurns": "Notify me for turns sent from this browser too",
		"mux.notify.deviceTurns.note": "Treats this browser's sends like phone sends, so a desktop turn is notified too. Saved for this browser only; the host's phone-only default is unchanged.",
		"mux.hidden.title": "Hidden controls",
		"mux.hidden.desc": "Hides controls that cannot work in a phone browser: a local editor or file manager, and the host's configuration file.",
		"mux.hidden.none": "(nothing right now)",
		"mux.hidden.disable": "Stop hiding (debug)",
		"mux.hidden.extra": "Extra labels to hide (one per line)",
		"mux.hidden.save": "Save and apply",
		"mux.bootError": "Boot error: {error}",
		"mux.input.title": "Input",
		"mux.input.desc": "Choose what Enter does in the message composer.",
		"mux.input.enterToSend": "Enter sends (off means a newline)",
		"mux.input.current.enterSends": "Currently: Enter sends, Shift+Enter adds a newline.",
		"mux.input.current.enterNewline": "Currently: Enter adds a newline. Send with the send button (Shift+Enter also adds a newline).",
		"mux.liveSpeed.title": "Output speed (estimated from stream deltas)",
		"mux.liveSpeed.aria": "Estimated speed {speed} tok/s",
		"mux.diag.height.title": "Screen height",
		"mux.diag.height.desc": "Useful when an installed app leaves a blank strip at the bottom.",
		"mux.diag.screenHeight": "screen.height",
		"mux.diag.innerHeight": "innerHeight",
		"mux.diag.clientHeight": "clientHeight",
		"mux.diag.visualViewport": "visualViewport",
		"mux.diag.visualValue": "{height} (offset {offset})",
		"mux.diag.gap": "Difference",
		"mux.diag.standalone": "standalone",
		"mux.diag.yes": "Yes",
		"mux.diag.no": "No",
		"mux.diag.safeArea": "Safe area",
		"mux.diag.safeValue": "Top {top} / bottom {bottom}",
		"mux.diag.nativeGap": "Native gap",
		"mux.diag.nativeGap.yes": "Present (inner bottom padding set to 0)",
		"mux.diag.nativeGap.no": "None",
		"mux.diag.height.note": "A difference around 47–62px is the iOS 26 native frame. The strip below is outside the page, so the inner bottom padding is set to 0 to minimise it.",
		"mux.diag.reMeasure": "Measure again",
		"mux.diag.scroll.title": "Scroll",
		"mux.diag.scroll.desc": "Scroll the outer page, then open this card to see which element moved last.",
		"mux.diag.scroll.clear": "Clear records",
		"mux.diag.scroll.refresh": "Refresh",
		"mux.diag.scroll.last": "Last scrolled element",
		"mux.diag.scroll.empty": "(Nothing recorded yet)",
		"mux.diag.scroll.lastItem": "{tag} {cls} — scrollTop {top} / {overflow}",
		"mux.diag.scroll.scrollable": "Currently scrollable elements",
		"mux.diag.scroll.scrollableItem": "{tag} {cls} — {top} / {height} ({overflow})",
		"mux.diag.noClass": "(no class)",

		// --- session frame palette ------------------------------------------
		"frame.menu": "Color frame",
		"frame.paletteAria": "Session frame color",
		"frame.paletteTitle": "Frame color",
		"frame.color.blue": "Blue",
		"frame.color.green": "Green",
		"frame.color.amber": "Amber",
		"frame.color.red": "Red",
		"frame.color.purple": "Purple",
		"frame.color.pink": "Pink",
		"frame.applied": "Frame color set to {color}",
		"frame.clear": "Remove frame",
		"frame.cleared": "Frame removed",

		// --- image crop ------------------------------------------------------
		"crop.aria": "Crop image",
		"crop.title": "Crop image",
		"crop.rotateLeft": "Rotate left 90°",
		"crop.rotateRight": "Rotate right 90°",
		"crop.close": "Close cropping",
		"crop.cancel": "Cancel",
		"crop.save": "Add to query",
		"crop.addFailed": "Could not add the image to the query",
		"crop.updated": "Updated the image in the query",
		"crop.added": "Cropped image added to the query",

		// --- notifications ---------------------------------------------------
		"notify.unsupported": "This browser does not support notifications",
		"notify.permissionMissing": "Notification permission was not granted",
		"notify.unavailable": "Push notifications are unavailable right now",
		"notify.subscribeFailed": "Could not save the subscription ({status})",
		"notify.unknownError": "Unknown error",
		"notify.rejected": "Push was rejected ({detail})",
		"notify.testTitle": "DSH test notification",
		"notify.testBody": "This banner is how it arrives while the app is open.",
		"notify.testLocalBody": "Notifications are on. Agent questions will arrive here.",
		"notify.noWorker": "No service worker is registered",
		"notify.open": "Open",
		"notify.permission.unsupported": "Not supported in this browser",
		"notify.permission.granted": "On (subscribed)",
		"notify.permission.allowed": "Allowed (not subscribed)",
		"notify.permission.blocked": "Blocked (allow notifications in browser settings)",
		"notify.permission.default": "Not allowed yet",
		"notify.hideListSaved": "Hide list saved.",
		"notify.turn.completed": "Work finished",
		"notify.turn.max-tokens": "Work finished (token limit)",
		"notify.turn.blocked": "Stopped (declined)",
		"notify.turn.error": "Stopped with an error",
		"notify.turn.aborted": "Stopped (interrupted)",
		"notify.turn.other": "Turn ended ({kind})",
		"notify.turn.detailCompleted": "The work finished.",
		"notify.turn.detailReason": "End reason: {kind}",
		"notify.questionHeader": "Confirm",
		"notify.questionMore": "(+{count} more)",
		"notify.previewQuestion": "Continue as is?",
		"notify.testPayloadBody": "Tap to open this session.",

		// --- composer / session menu ----------------------------------------
		"add.label": "Add image or file",
		"add.stock": "Add files or run commands",
		"sessionId.label": "Copy Session ID to clipboard",
		"sessionId.copied": "Session ID copied",
		"sessionId.manualPrompt": "Session ID (copy it manually)",

		// --- service worker --------------------------------------------------
		"sw.documentTitle": "Offline — DSH",
		"sw.offlineHeading": "You're offline",
		"sw.offlineBody1": "Could not reach the DSH server.",
		"sw.offlineBody2": "Check your network connection.",
		"sw.retry": "Retry",
		"sw.pushTitle": "DSH",
		"sw.pushBody": "You have a new notification",
		"sw.open": "Open",
	},

	/**
	 * Japanese pack: the reference build's copy, restored key for key.
	 * Every key of `COPY.en` is present; `copyFor("ja")` therefore never falls
	 * back to English. The English dictionary stays authoritative for the key
	 * list, so a new key is a visible test failure until both packs carry it.
	 */
	ja: {
		// --- manifest -------------------------------------------------------
		"manifest.description": "DeepSeek Harness をアプリのように起動します。",
		"manifest.screenshot.chat": "チャット画面",
		"manifest.screenshot.desktop": "デスクトップ表示",

		// --- settings tabs --------------------------------------------------
		"tab.pwa": "アプリ",
		"tab.mobile": "モバイル",
		"tab.input": "入力",

		// --- PWA section ----------------------------------------------------
		"pwa.install.promptable": "DSH をアプリとしてインストールできます",
		"pwa.install.iosHint": "Safari の共有 → 「ホーム画面に追加」でアプリにできます",
		"pwa.install.button": "インストール",
		"pwa.install.title": "アプリとしてインストール",
		"pwa.later": "あとで",
		"pwa.update.available": "新しいバージョンがあります",
		"pwa.update.reload": "再読み込み",
		"pwa.offline": "オフライン — 再接続を待っています",
		"pwa.sw.activeUpdate": "有効（更新待ち）",
		"pwa.sw.active": "有効",
		"pwa.sw.unsupported": "このブラウザは非対応",
		"pwa.sw.insecure": "無効（HTTPS または localhost で有効）",
		"pwa.sw.shared": "他のサービスワーカーが制御中（キャッシュ無効）",
		"pwa.sw.error": "登録に失敗",
		"pwa.sw.pending": "準備中",
		"pwa.install.state.standalone": "インストール済み（アプリとして起動中）",
		"pwa.install.state.installable": "インストールできます",
		"pwa.install.state.ios": "Safari の共有メニュー →「ホーム画面に追加」",
		"pwa.install.state.insecure": "HTTPS で開くとインストールできます",
		"pwa.install.state.unsupported": "このブラウザでは未対応",
		"pwa.install.accepted": "インストールしました。",
		"pwa.install.dismissed": "キャンセルしました。",
		"pwa.install.unavailable": "この環境ではプロンプトを出せません。",
		"pwa.check.noWorker": "サービスワーカーが未登録です。",
		"pwa.check.available": "新しいバージョンがあります。",
		"pwa.check.latest": "最新です。",
		"pwa.check.failed": "確認できませんでした（オフラインの可能性があります）。",
		"pwa.section.title": "アプリ（PWA）",
		"pwa.section.desc": "DSH を独立したアプリウィンドウで起動し、オフライン時も画面を表示できるようにします。",
		"pwa.row.displayMode": "表示モード",
		"pwa.row.displayMode.standalone": "アプリ（スタンドアロン）",
		"pwa.row.displayMode.browser": "ブラウザ",
		"pwa.row.install": "インストール",
		"pwa.row.offline": "オフライン起動",
		"pwa.row.build": "ビルド",
		"pwa.action.reloadUpdate": "再読み込みして更新",
		"pwa.action.checking": "確認中…",
		"pwa.action.check": "更新を確認",
		"pwa.note.ios": "iPhone / iPad: Safari の共有ボタンから「ホーム画面に追加」を選ぶと、アプリとして起動できます。",
		"pwa.note.insecure": "オフライン起動とインストールは HTTPS または localhost でのみ有効になります。",
		"pwa.note.swError": "サービスワーカーの登録に失敗しました: {error}",
		"pwa.note.bootError": "起動時にエラーが発生しました: {error}",

		// --- mobile settings -------------------------------------------------
		"mux.nav.scrollLeft": "設定タブを左へスクロール",
		"mux.nav.scrollRight": "設定タブを右へスクロール",
		"mux.stats.turn": "{count} turn",
		"mux.stats.turns": "{count} turns",
		"mux.stats.tokPerSec": "{speed} tok/s",
		"mux.stats.cacheHit": "Cache hit {percent}%",
		"mux.settingsRow": "Settings",
		"mux.fab.open": "セッション一覧を開く",
		"mux.fab.openWithCount": "セッション一覧を開く（未読・質問待ち {count}件）",
		"mux.toast.noFileInput": "添付できるファイル入力がありません",
		"mux.detail.todo": "Todo",
		"mux.detail.goal": "Goal",
		"mux.section.title": "モバイルUI",
		"mux.section.desc": "スマホ幅の表示と操作を整えます。設定はこのブラウザに保存されます。",
		"mux.section.desc.desktop": "スマホ用レイアウトとその操作はスマホまたはインストールしたアプリでのみ有効です。このデスクトップウィンドウは標準レイアウトのままです。",
		"mux.section.plusNote": "＋ は画像とファイルの添付だけを開きます（コマンドは / から）。",
		"mux.deviceTheme.title": "テーマ（この端末のみ）",
		"mux.deviceTheme.desc": "このブラウザだけで使う配色を選びます。選択はここに保存され、他の端末には影響しません。",
		"mux.deviceTheme.label": "配色",
		"mux.deviceTheme.note": "共有テーマは 設定 → 一般 → 外観 にあります。ここでの選択はこの端末だけ上書きします。",
		"mux.deviceTheme.custom": "カスタム（登録済み）テーマが有効なため、端末別の上書きは無効です。",
		"mux.deviceTheme.unsupported": "この DSH では端末別の配色を適用できなかったため、共有テーマのままです。",
		"mux.deviceTheme.follow": "共有テーマに合わせる",
		"mux.deviceTheme.light": "ライト",
		"mux.deviceTheme.dark": "ダーク",
		"mux.deviceTheme.system": "この端末に合わせる",
		"mux.row.layout": "レイアウト",
		"mux.row.layout.narrow": "スマホ幅（ドロワー表示）",
		"mux.row.layout.wide": "デスクトップ幅",
		"mux.row.sessions": "セッション一覧",
		"mux.row.sessions.open": "開いています",
		"mux.row.sessions.closed": "閉じています",
		"mux.row.notifications": "通知",
		"mux.row.build": "UIビルド",
		"mux.action.enable": "通知を有効にする",
		"mux.action.reRegister": "通知を再登録",
		"mux.action.test": "テスト通知",
		"mux.action.disable": "通知を解除",
		"mux.message.enabled": "通知を有効にしました。",
		"mux.message.testSent": "テスト通知を送りました（プッシュ経由）。",
		"mux.message.disabled": "通知を解除しました。",
		"mux.note.blocked": "通知がブロックされています。ブラウザのサイト設定 → 通知 を「許可」に変更してください。",
		"mux.sound.title": "通知音",
		"mux.sound.desc": "アプリを開いているときに鳴ります。音はブラウザが合成するので、音声ファイルは不要です。",
		"mux.sound.preview": "試聴",
		"mux.sound.volume": "音量",
		"mux.sound.none": "なし",
		"mux.sound.chime": "チャイム",
		"mux.sound.pop": "ポップ",
		"mux.sound.drop": "ドロップ",
		"mux.sound.tick": "タップ",
		"mux.note.notifyScope": "回答終了時と質問時に通知します。メインエージェントのみ、このスマホから送ったターンだけが対象です。",
		"mux.notify.deviceTurns": "このブラウザから送ったターンも通知する",
		"mux.notify.deviceTurns.note": "このブラウザの送信をスマホの送信と同じ扱いにし、デスクトップのターンも通知します。このブラウザだけの設定で、ホスト側のスマホ限定の既定は変わりません。",
		"mux.hidden.title": "非表示にした操作",
		"mux.hidden.desc": "スマホでは使えない操作（エディタ／ターミナルで開く、フィードバック、サインインなど）を隠しています。",
		"mux.hidden.none": "（現在は該当なし）",
		"mux.hidden.disable": "非表示をやめる（デバッグ用）",
		"mux.hidden.extra": "追加で非表示にするラベル（1行1件）",
		"mux.hidden.save": "保存して反映",
		"mux.bootError": "起動時エラー: {error}",
		"mux.input.title": "入力",
		"mux.input.desc": "メッセージ入力欄で Enter を押したときの動作を選びます。",
		"mux.input.enterToSend": "Enterで送信する（OFFなら改行）",
		"mux.input.current.enterSends": "現在: Enter で送信、Shift+Enter で改行。",
		"mux.input.current.enterNewline": "現在: Enter で改行。送信は送信ボタンから（Shift+Enter も改行）。",
		"mux.liveSpeed.title": "出力速度（ストリーム差分からの概算）",
		"mux.liveSpeed.aria": "推定速度 {speed} tok/s",
		"mux.diag.height.title": "画面の高さ",
		"mux.diag.height.desc": "ホーム画面のアプリで下に空白が出るときの確認用です。",
		"mux.diag.screenHeight": "screen.height",
		"mux.diag.innerHeight": "innerHeight",
		"mux.diag.clientHeight": "clientHeight",
		"mux.diag.visualViewport": "visualViewport",
		"mux.diag.visualValue": "{height}（offset {offset}）",
		"mux.diag.gap": "差分",
		"mux.diag.standalone": "standalone",
		"mux.diag.yes": "はい",
		"mux.diag.no": "いいえ",
		"mux.diag.safeArea": "セーフエリア",
		"mux.diag.safeValue": "上 {top} / 下 {bottom}",
		"mux.diag.nativeGap": "ネイティブ余白",
		"mux.diag.nativeGap.yes": "あり（内側の下余白を0に補正）",
		"mux.diag.nativeGap.no": "なし",
		"mux.diag.height.note": "差分が47〜62px前後なら iOS 26 のネイティブフレームです。下の帯はページの外なので、内側の下余白を0にして最小化しています。",
		"mux.diag.reMeasure": "再測定",
		"mux.diag.scroll.title": "スクロール",
		"mux.diag.scroll.desc": "外側をスクロールしてからここを開くと、最後に動いた要素が分かります。",
		"mux.diag.scroll.clear": "記録をクリア",
		"mux.diag.scroll.refresh": "更新",
		"mux.diag.scroll.last": "最後にスクロールした要素",
		"mux.diag.scroll.empty": "（まだ記録がありません）",
		"mux.diag.scroll.lastItem": "{tag} {cls} — scrollTop {top} / {overflow}",
		"mux.diag.scroll.scrollable": "いまスクロール可能な要素",
		"mux.diag.scroll.scrollableItem": "{tag} {cls} — {top} / {height} ({overflow})",
		"mux.diag.noClass": "(classなし)",

		// --- session frame palette ------------------------------------------
		"frame.menu": "色枠",
		"frame.paletteAria": "セッションの枠色",
		"frame.paletteTitle": "枠の色",
		"frame.color.blue": "ブルー",
		"frame.color.green": "グリーン",
		"frame.color.amber": "アンバー",
		"frame.color.red": "レッド",
		"frame.color.purple": "パープル",
		"frame.color.pink": "ピンク",
		"frame.applied": "枠の色を{color}にしました",
		"frame.clear": "枠を外す",
		"frame.cleared": "枠を外しました",

		// --- image crop ------------------------------------------------------
		"crop.aria": "画像をトリミング",
		"crop.title": "画像をトリミング",
		"crop.rotateLeft": "左に90度回転",
		"crop.rotateRight": "右に90度回転",
		"crop.close": "トリミングを閉じる",
		"crop.cancel": "キャンセル",
		"crop.save": "クエリに追加",
		"crop.addFailed": "クエリに画像を追加できませんでした",
		"crop.updated": "編集した画像をクエリに反映しました",
		"crop.added": "トリミングした画像をクエリに追加しました",

		// --- notifications ---------------------------------------------------
		"notify.unsupported": "このブラウザは通知に対応していません",
		"notify.permissionMissing": "通知の許可が得られませんでした",
		"notify.unavailable": "プッシュ通知を利用できません",
		"notify.subscribeFailed": "購読を保存できませんでした（{status}）",
		"notify.unknownError": "不明なエラー",
		"notify.rejected": "プッシュが拒否されました（{detail}）",
		"notify.testTitle": "DSH のテスト通知",
		"notify.testBody": "アプリを開いているときは、このバナーで届きます。",
		"notify.testLocalBody": "通知が有効です。エージェントが質問したときにここへ届きます。",
		"notify.noWorker": "サービスワーカーが未登録です",
		"notify.open": "開く",
		"notify.permission.unsupported": "このブラウザは非対応",
		"notify.permission.granted": "有効（購読済み）",
		"notify.permission.allowed": "許可済み（未購読）",
		"notify.permission.blocked": "ブロックされています（ブラウザ設定から許可）",
		"notify.permission.default": "未許可",
		"notify.hideListSaved": "非表示リストを保存しました。",
		"notify.turn.completed": "作業完了",
		"notify.turn.max-tokens": "作業完了 (トークン上限)",
		"notify.turn.blocked": "停止 (拒否されました)",
		"notify.turn.error": "エラーで停止",
		"notify.turn.aborted": "停止 (中断)",
		"notify.turn.other": "ターン終了 ({kind})",
		"notify.turn.detailCompleted": "作業が完了しました。",
		"notify.turn.detailReason": "終了理由: {kind}",
		"notify.questionHeader": "確認",
		"notify.questionMore": "（他 {count} 件）",
		"notify.previewQuestion": "このまま進めますか？",
		"notify.testPayloadBody": "タップするとこのセッションが開きます。",

		// --- composer / session menu ----------------------------------------
		"add.label": "画像やファイルを追加",
		"add.stock": "ファイルを追加またはコマンドを実行",
		"sessionId.label": "セッションIDをコピー",
		"sessionId.copied": "セッションIDをコピーしました",
		"sessionId.manualPrompt": "セッションID（手動でコピーしてください）",

		// --- service worker --------------------------------------------------
		"sw.documentTitle": "オフライン — DSH",
		"sw.offlineHeading": "オフラインです",
		"sw.offlineBody1": "DSH のサーバーに接続できませんでした。",
		"sw.offlineBody2": "Tailscale などのネットワーク接続を確認してください。",
		"sw.retry": "再試行",
		"sw.pushTitle": "DSH",
		"sw.pushBody": "新しい通知があります",
		"sw.open": "開く",
	},
};

/**
 * Upstream labels this plugin matches to find controls.
 *
 * These are never rendered: they are the vocabulary of the shell being
 * decorated. Keeping every known locale here is what makes the matching
 * language-independent — adding a language does not touch `client.js`.
 */
export const PROBES = {
	/** The account/menu button that opens Settings. */
	accountMenu: ["Account menu", "設定"],
	/** The Settings row inside that menu. */
	settingsMenu: ["Settings", "設定"],
	/** A session row's own "..." trigger. */
	actions: ["actions", "操作"],
	/** A button that stops the running turn (must not mark a phone send). */
	stop: ["stop", "停止"],
	/** The activity chip: "3 turns" / "3 steps". */
	turns: ["turns", "turn", "steps", "step", "ターン", "ステップ"],
	/** The usage chip: "Cache hit 40%". */
	cacheHit: ["cache hit", "キャッシュ"],
	/** The context chip: "40% context". */
	context: ["context", "コンテキスト"],
	/** Any aria-label that identifies the stats dock. */
	stats: ["tok", "turns", "context", "ターン", "コンテキスト"],
	/** A control that starts a new session (sidebar button, brand row, workspace "+"). */
	newSession: ["new session", "新建会话", "中新建会话"],
	/** Labels of a session that has no name yet. */
	untitled: ["new session", "new chat", "untitled", "新しいセッション", "新しいチャット", "無題", "未命名", "新会话"],
	/** The right panel's "make this pane fullscreen" control. */
	fullscreen: ["Enter fullscreen", "Fullscreen", "全屏"],
};

/** Keys the service worker needs, picked out of {@link COPY}. */
const SW_KEYS = [
	"sw.documentTitle",
	"sw.offlineHeading",
	"sw.offlineBody1",
	"sw.offlineBody2",
	"sw.retry",
	"sw.pushTitle",
	"sw.pushBody",
	"sw.open",
];

/**
 * One language's strings, falling back to English key by key.
 *
 * @param {string} [lang] - a language id such as `en` or `ja`.
 * @param {object} [table] - dictionary to read; defaults to {@link COPY}.
 * @returns {Record<string, string>} every key this package renders.
 */
export function copyFor(lang, table = COPY) {
	const base = { ...table.en };
	const extra = typeof lang === "string" && lang !== "en" && table[lang] !== undefined
		? table[lang]
		: {};
	for (const [key, value] of Object.entries(extra)) {
		if (typeof value === "string" && value !== "") base[key] = value;
	}
	return base;
}

/**
 * The subset the service worker renders, for `__RDSH_PWA_CONFIG__`.
 *
 * @param {string} [lang] - a language id.
 * @returns {Record<string, string>} offline/push copy.
 */
export function serviceWorkerCopy(lang) {
	const strings = copyFor(lang);
	return Object.fromEntries(SW_KEYS.map((key) => [key, strings[key]]));
}
