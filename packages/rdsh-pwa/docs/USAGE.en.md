# Usage (English)

Everything `rdsh-pwa` does, in detail. **For installation see the [README](../README.md#install).**

日本語: [USAGE.ja.md](USAGE.ja.md)

## What this package is

Four plugins that used to be separate, merged into one.

| Was | Now |
| --- | --- |
| `rdsh-pwa` | PWA: installable, offline launch, notification send/receive, notification sounds |
| `rdsh-mobile-ux` | Phone-width UX: drawer, settings, composer, code view, in-app banners |
| `rdsh-markdown-cjk` | Fixes broken autolinks around CJK text (host only) |
| `rdsh-session-id-copy` | Adds a session-id copy row to the session menu |

**Why not separate packages:** DSH maps one package to one browser module. Splitting them
would register one module per package and scatter the install, the settings and the
enablement. The parts are independent, so merging them costs nothing.

## What it does

| Feature | Detail |
| --- | --- |
| Installable PWA | Manifest, service worker, offline page, update banner |
| Notifications | In-app banner while the app is on screen, Web Push otherwise |
| Notification sounds | Five synthesised presets, volume, no audio files |
| Phone layout | Sidebar becomes a drawer, settings open in one tap, code wraps |
| CJK rendering | `**https://x**（memo）` keeps its bold and its link |
| Session id copy | One row in the session row menu |

## Screenshots

![Install card](install-card.png)

![App settings](settings.png)

![Safe area in standalone mode](standalone-safe-area.png)

### Theme (light / dark)

Every colour comes from the host's theme tokens (`--dsw-*`). The earlier version baked in
dark values, so on the light palette the selected session row, the popovers, the toast and
the settings buttons were barely readable. Both palettes are now honoured.

**Settings → Mobile → "Theme (this device only)"** picks a palette for this browser alone
(follow the shared setting / light / dark / match the device). The choice lives in
`localStorage` only: it never writes the DSH profile, so **changing it on a phone does not
reach the PC**. The shared theme stays in Settings → General → Appearance.

- If the upstream DOM contract (`body[data-ds-dark-theme]` / `html{color-scheme}`) has
  changed, the override is verified after it is applied and then **gives up, falling back to
  the shared theme** (the settings card says so).
- A registered palette (custom theme tokens) disables the override, since mixing the two
  token layers produces a page neither theme owns.
- The splash screen and task switcher colour come from the manifest's `themeColor`, which
  cannot be per-device; set `themeColor` / `backgroundColor` to `#fff` in the profile patch
  if you run light-only.
- One meta cannot switch the status bar between black and white glyphs, so the default is
  now `default` (dark text). A dark-only profile can set
  `appleStatusBarStyle: "black-translucent"`.

## Phone layout

On a phone, that is:

- a width of 767px or less, or
- a landscape phone: `(orientation: landscape)`, width up to 1023px, height up to
  500px, and a coarse (touch) primary pointer

The landscape clause exists because a phone held sideways reports 844x390 or
852x393, which used to fall into the desktop layout (no drawer button, no swipe).
A narrow desktop window is unaffected: a mouse reports `pointer: fine`.

The layout is the only thing width decides. **Hiding the app's own controls,
rewriting their labels, or replacing "+" with the file picker** asks what the
device is instead (`phone()`): a coarse primary pointer, or an installed app
(a coarse primary pointer, or a coarse pointer in a narrow window). Width alone
never counts, so a narrow desktop window keeps the stock UI.
A narrow desktop window keeps every control, the stock account menu and the
stock "+" command list.

What changes:

- The sidebar becomes an overlay drawer you open with the floating button
- Settings get a single column and a scrolling tab strip
- The code viewer always wraps and never scrolls sideways
- The composer stays above the keyboard
- Sending a message puts the keyboard away, so the reply is not covered. A send the app
  refuses keeps the draft and the keyboard. A desktop window keeps its focus.
- Session rows keep their actions hidden until the menu or a long press
- Right-panel tabs are finger-sized, and the tab strip scrolls sideways
- Dragging inside the terminal scrolls it (the bundled xterm has no touch support)

The long press opens the same menu as the `...` button. Swipe right on an open drawer to
close it; swipe left to open it.

## Notifications

### Which channel

| App state | How you are told |
| --- | --- |
| Visible (foreground) | In-app banner. No system notification |
| Background, another app, closed | Web Push system notification |
| Tap the notification | That session opens (banner "open" while in the app) |

The service worker decides: `clients.matchAll()` finds a window with
`visibilityState === "visible"` and hands the payload to the page. If the page does not
acknowledge within 400ms, the system notification is shown instead — a visible window that
never loaded this plugin must not swallow the message.

### Sounds

The banner plays a sound. **No audio files ship with the package**: each preset is
synthesised with Web Audio.

| Preset | Sound |
| --- | --- |
| `chime` | Two rising notes (turn finished) |
| `pop` | One short note (question) |
| `drop` | Three descending notes |
| `tick` | Short double tap |
| `none` | Silent |

Volume is 0–100% and both choices are stored in `localStorage`.

### Copy and behaviour

```yaml
- id: rdsh-pwa
  config:
    notifications:
      appName: "DSH"
      turnEndTitle: "{session}"
      turnEndBody: "{detail}"
      questionTitle: "{session}"
      questionBody: "{question}"
      onlyMobileTurns: true   # only turns sent from this phone
      subject: ""             # VAPID contact; "" means the app's own origin
```

With the `onlyMobileTurns: true` default a desktop send is never notified. To get
notifications on a desktop too, turn on **Settings → Mobile → "Notify me for turns
sent from this browser too"** in that browser. It does not write the host config:
it marks the browser's own sends as phone sends, so the choice is per browser
(`localStorage`). Set `onlyMobileTurns: false` in the profile to notify every
device instead.

Placeholders: `{app}` `{session}` everywhere; `{status}` `{detail}` `{reason}` for a
turn end; `{header}` `{question}` `{count}` for a question. An unknown placeholder stays
verbatim, so a typo is visible instead of silently dropped.

### How it works

Web Push is implemented directly on `node:crypto`; no push library is involved.

- **VAPID (RFC 8292)** — an ES256 JWT in the `Authorization` header, signed with
  `ieee-p1363` (`r||s`, not DER)
- **Encryption (RFC 8291 / 8188)** — ECDH → HKDF → AES-128-GCM, including the `aes128gcm`
  record framing

Keys and subscriptions live in `~/.dsh/rdsh-pwa/push.json` (mode `0600`). The VAPID `sub`
is resolved from `config.notifications.subject`, then the `https` origin of the newest
subscription, then `mailto:dsh@example.com` — Apple rejects `mailto:root@localhost` with
`403 BadJwtToken`.

Every stored endpoint is validated on subscribe: it must be `https` and must not resolve
to loopback, a private range or a link-local address. The host POSTs to whatever is stored,
so an unvalidated endpoint would be a way to park an internal URL in the store.

### Relation to the old plugin

This package does not share an API or a service worker with `dsh-notify-push`. Its routes
are `/api/rdsh-pwa/push/…`. If both are installed the service-worker registration would
collide, so this package redirects a `/push/sw.js` registration to its own `/sw.js` (the
wrap touches nothing else and is removed on dispose).

## Dependencies

**This package alone is enough.** No other `rdsh-*` plugin, no external npm package.

| Dependency | Required | Detail |
| --- | --- | --- |
| DSH itself (`@deepseek-ai/dsh-*`) | yes | Sidebar, settings, model picker, goal, todo, jobs. Upstream class names are CSS-module hashes, so this plugin attaches `data-rdsh-*` hooks from **structure** (`data-row-key` / `aria-label` / `role`) and its CSS only looks at the hooks. If upstream changes, the hooks are not attached and the stock layout stays (fail closed) |
| Notifications | bundled | Web Push implemented on `node:crypto`, so no `web-push` and no separate plugin |
| `react` / `react-dom/client` / `@deepseek-ai/dsh-client-ui-primitives` | provided by DSH | All shipped with DSH; nothing to install |

The browser half reads only its own globals (`__RDSH_PWA__`, `__RDSH_PWA_SETTINGS_SECTION__`,
`__RDSH_MOBILE_UX__`), each behind a `typeof` check.

## Verification

```sh
npm test             # 46 unit tests, no browser needed
```

`npm test` runs without DSH installed; two cases that need the installed DSH frontend
report a skip. Set `DSH_ORIG_BIN` (as the systemd unit does) and all 46 run.

The browser half is covered by three static checks in
`tests/client-integrity.test.mjs` (undeclared call targets, listener definitions, dead
`data-rdsh-*` attributes) and one smoke test in `tests/client-load.test.mjs` that evaluates
the module against a stub environment.

## How it fits together

- The host half serves `/manifest.webmanifest`, `/sw.js` and `/api/rdsh-pwa/push/…`, and
  adds the PWA metadata to the served index
- The browser half is loaded verbatim by the client module loader; it installs the layout,
  registers the service worker and renders the banners
- Nothing is patched on disk. The one exception is the CJK fix, which serves the frontend
  chunks through its own route with the fix applied

## Icons

`assets/` holds the maskable and regular icons plus the badge. The manifest points at
`/pwa/…`, which the host half serves from the package — the installed DSH is never touched.

## Known limits

- The layout depends on upstream CSS-module hashes existing. A rename only stops a rule
  from matching and leaves the stock layout (fail closed), but a renamed hook means the
  phone layout is simply absent until this package is updated
- Notifications need a secure context. Over plain HTTP on a LAN address the browser will
  not offer a subscription
- The service worker manages one scope. Another plugin registering a worker at `/` will
  fight over it
- The per-device theme is per **browser**, not per hardware device (another browser on the
  same phone is separate, and clearing site data returns it to "follow the shared theme")
- The offline page cannot read the stored theme (a service worker has no `localStorage`
  access), so it follows the OS light/dark preference

## The iOS 26 bottom strip (47px / 62px)

On iOS 26 the web view can be shorter than the screen: `screen.height - innerHeight` is
about 47px. The home indicator lives in that strip, outside the page, so the inner bottom
safe-area padding only makes the blank area larger.

The package detects this (`data-rdsh-native-gap`) and sets the inner bottom padding to 0
for the sidebar, the right panel and settings. This was previously done with a `/launch`
route that stripped the PWA tags for comparison; that route is gone — an unauthenticated
diagnostic page does not belong in a shipped package.

## Credits

The package is written by referencing the implementations below. **No code was copied**
(notifications are implemented from the RFCs, the UI attaches hooks from DSH's own
structure). **None of them is a dependency** — this package works on its own.

| Source | What was referenced |
| --- | --- |
| [`dsh-notify-push`](https://github.com/hikarioyama/Smart-DSH) (MIT, © hikarioyama) | The overall notification design: using the origin as the VAPID `sub`, firing on `session/event` `turn/end` and on `user-questions/request`, the re-entrancy guard and re-assert when selecting a session with `openSession`, the `postMessage` path for a notification tap |
| [`dsh-sound-notifications`](https://github.com/cwd514/dsh-sound-notifications) (MIT, © cwd514) | The idea of per-event sounds and of a foreground check like `onlyWhenHidden` |
| **[`rdsh-mobile-ui`](https://github.com/jimoto-no-llm/rustdsh)** (MIT; ported by lasder-ca; original by hikarioyama of [Smart-DSH](https://github.com/hikarioyama/Smart-DSH)) | The phone-width approach and the specific declarations that made it work: pinning the grid columns when collapsed (`centerCol: 2` / `rightbarCol: 3`), the 64px header inset that clears the drawer button, and sizing the chat from its column instead of pixel floors (`--dsh-chat-user-width` / `--dsh-chat-content-width` / `--dsh-composer-card-max-width` set to 100%). This package re-expresses all three against its own `data-rdsh-*` hooks so it works without that plugin |
| [`web-push`](https://github.com/web-push-libs/web-push) (MIT) | Confirming the reading of RFC 8291/8292 (implementation is our own) |
| DSH itself (`@deepseek-ai/dsh-*`) | The toast primitive (`primitives.Toast`) and the `uiWorkspace` / `sessions` / `agents` / `webServer` services |
