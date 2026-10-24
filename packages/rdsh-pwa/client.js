window.__ModuleLoader__.load({
  id: "rdsh-pwa",
  factory(require) {
    // rdsh-pwa — browser half.
    //
    // One module carries three behaviours that used to be separate plugins:
    // the PWA shell, the phone-width layout, and the session-id copy row.
    // They ship together because the client module system maps one package to
    // one browser module: a package cannot register several.
    //
    // Each part below is the body of what was its own plugin, unchanged. The
    // parts are independent — each returns its own `{ inject, apply }`, and
    // `apply` at the bottom runs them in order.
    //
    // Nothing here depends on a build step: this file is loaded verbatim by
    // the client module loader.
    // ---------------------------------------------------------------------
    // UI copy
    //
    // The host half injects one dictionary (lib/copy.js) into the index and
    // into the service-worker config, so the strings this package renders have
    // a single source. A future Japanese pack fills COPY.ja: every lookup
    // falls back to English per key, so a partial pack is safe.
    // ---------------------------------------------------------------------
    const COPY = globalThis.__RDSH_PWA_COPY__ ?? { en: {}, ja: {} };
    /** Upstream label vocabularies (never rendered), for language-independent matching. */
    const PROBES = globalThis.__RDSH_PWA_PROBES__ ?? {};

    /** The document's language when this dictionary carries it, else `en`. */
    function currentLang() {
      const lang = String(document.documentElement.lang || "").toLowerCase().split("-")[0];
      return lang !== "" && COPY[lang] !== undefined ? lang : "en";
    }

    /**
     * One UI string, falling back to English and then to the key itself.
     *
     * @param {string} key - a key from lib/copy.js.
     * @param {object} [params] - values for `{name}` placeholders.
     * @returns {string}
     */
    function t(key, params) {
      const localized = COPY[currentLang()];
      const value = localized !== null && localized !== undefined
        && typeof localized[key] === "string" && localized[key] !== ""
        ? localized[key]
        : COPY.en?.[key];
      if (typeof value !== "string") return key;
      if (params === undefined || params === null) return value;
      return value.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
    }

    /** Probe labels, or the English fallbacks when the host sent no dictionary. */
    function probeValues(key, fallback) {
      if (Array.isArray(PROBES[key]) && PROBES[key].length > 0) return PROBES[key];
      if (fallback === undefined) return [];
      return Array.isArray(fallback) ? fallback : [fallback];
    }

    /**
     * A regex over one probe vocabulary, or null when nothing is known.
     *
     * @param {string} key - a PROBES entry.
     * @param {string} [flags] - regex flags.
     * @param {string|string[]} [fallback] - English labels when PROBES is absent.
     * @param {boolean} [exact] - anchor to a whole label instead of a substring.
     */
    function probeRegex(key, flags = "i", fallback, exact = false) {
      const values = probeValues(key, fallback);
      if (values.length === 0) return null;
      const source = values.join("|");
      return new RegExp(exact ? `^(?:${source})$` : source, flags);
    }

    const cssValue = (value) => String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');

    /** A CSS attribute selector for one probe vocabulary. */
    function ariaLabelSelector(tag, key, fallback) {
      return probeValues(key, fallback).map((value) => `${tag}[aria-label="${cssValue(value)}"]`).join(", ");
    }

    /** A CSS "aria-label contains" selector for one probe vocabulary. */
    function ariaContainsSelector(tag, key, fallback) {
      return probeValues(key, fallback).map((value) => `${tag}[aria-label*="${cssValue(value)}"]`).join(", ");
    }

    // ---------------------------------------------------------------------
    // rdsh-pwa — PWA shell: manifest, service worker, install prompt, notification transport.
    // ---------------------------------------------------------------------
    function pwaPart() {

    // rdsh-pwa — browser half.
    //
    // Makes the DSH Web GUI behave like an app: registers the app-shell service
    // worker (offline launch + static-asset caching), surfaces the install
    // prompt in the sidebar and in Settings, offers a reload when a new build
    // is waiting, reports the offline state, and insets the layout for notches
    // and home indicators when launched standalone.
    //
    // The host half (index.js) serves /manifest.webmanifest, /sw.js and the
    // icons, and adds viewport-fit=cover to the index. Nothing here depends on
    // a build step: this file is loaded verbatim by the client module loader.
    const React = require("react");
    const h = React.createElement;
    const useState = React.useState;
    const useEffect = React.useEffect;

    const SCOPE = new URL("./", document.baseURI);
    const SW_URL = new URL("sw.js", SCOPE).href;
    /** Script URL of the notification plugin's worker (see unifyWorker below). */
    const PUSH_WORKER_PATH = "/push/sw.js";
    const STYLE_ATTR = "data-rdsh-pwa-style";
    const ROOT_ATTR = "data-rdsh-pwa";
    const UPDATE_POLL_MS = 30 * 60 * 1000;
    const UPDATE_MIN_GAP_MS = 5 * 60 * 1000;
    // Phone layout, in one place for both halves of this file.
    //
    // Width alone called a landscape phone (852x393, 844x390) a desktop even
    // though upstream DSH still treats everything below 1024 as narrow, which
    // left the 768-1023 band hybrid: stock rail on the left, no drawer, no
    // swipe, no floating button. The second clause covers that orientation
    // without catching a narrow desktop window (a mouse reports
    // `pointer: fine`) or a landscape tablet (short side above 500px).
    const NARROW_QUERY = "(max-width: 767px), (orientation: landscape) and (max-width: 1023px) and (max-height: 500px) and (pointer: coarse)";
    const INSTALL_PROMPT_KEY = "rdsh-pwa:install-prompt-dismissed";
    const INSTALL_PROMPT_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;

    const STANDALONE_QUERY = "(display-mode: standalone)";
    const FULLSCREEN_QUERY = "(display-mode: fullscreen)";
    const MINIMAL_QUERY = "(display-mode: minimal-ui)";

    function isStandalone() {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
      if (window.matchMedia(STANDALONE_QUERY).matches) return true;
      if (window.matchMedia(FULLSCREEN_QUERY).matches) return true;
      if (window.matchMedia(MINIMAL_QUERY).matches) return true;
      return navigator.standalone === true;
    }

    function isIos() {
      const ua = navigator.userAgent || "";
      if (/iPad|iPhone|iPod/.test(ua)) return true;
      // iPadOS 13+ reports a desktop Mac UA; touch points give it away.
      return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
    }

    const CSS = `
html[data-rdsh-pwa="standalone"] #root {
  box-sizing: border-box;
  padding-top: env(safe-area-inset-top, 0px);
  padding-right: env(safe-area-inset-right, 0px);
  padding-bottom: env(safe-area-inset-bottom, 0px);
  padding-left: env(safe-area-inset-left, 0px);
}
html[data-rdsh-pwa="standalone"] { overscroll-behavior-y: none; }
html[data-rdsh-pwa="standalone"] body { overscroll-behavior-y: contain; }
html[data-rdsh-pwa="standalone"] .rdsh-pwa-toasts { top: calc(env(safe-area-inset-top, 0px) + 10px); }

/* Phones: keep the toast column clear of the 64px sidebar header, and hang the
   install card on the right so the logo (session list) stays tappable. */
@media ${NARROW_QUERY} {
  .rdsh-pwa-toasts { top: calc(env(safe-area-inset-top, 0px) + 8px); padding-top: 56px; }
  .rdsh-pwa-install { align-self: flex-end; max-width: min(330px, calc(100vw - 24px)); flex-wrap: wrap; row-gap: 8px; }
  .rdsh-pwa-install .rdsh-pwa-card-text { flex: 1 1 100%; }
  .rdsh-pwa-install-actions { display: flex; gap: 8px; margin-left: auto; align-items: center; }
}

.rdsh-pwa-toasts {
  position: fixed; top: 10px; left: 50%; transform: translateX(-50%);
  z-index: 960; display: flex; flex-direction: column; align-items: center;
  gap: 8px; width: min(420px, calc(100vw - 24px)); pointer-events: none;
}
.rdsh-pwa-pill {
  pointer-events: none; padding: 6px 14px; border-radius: 999px;
  background: var(--dsw-alias-bg-module-platform, #2a2a2e);
  color: var(--dsw-alias-label-secondary, #cfd3d6);
  border: .5px solid var(--dsw-alias-border-l3, rgba(255,255,255,.12));
  box-shadow: var(--dsw-elevation-prominent, 0 8px 24px rgba(0,0,0,.35));
  font-size: 12px; line-height: 18px; white-space: nowrap;
}
.rdsh-pwa-card {
  pointer-events: auto; display: flex; align-items: center; gap: 10px;
  width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 14px;
  background: var(--dsw-alias-bg-module-platform, #2a2a2e);
  color: var(--dsw-alias-label-primary, #f9fafb);
  border: .5px solid var(--dsw-alias-border-l3, rgba(255,255,255,.12));
  box-shadow: var(--dsw-elevation-prominent, 0 8px 24px rgba(0,0,0,.35));
  font-size: 13px; line-height: 1.5;
}
.rdsh-pwa-card-text { flex: 1; min-width: 0; }
.rdsh-pwa-card button {
  font: inherit; font-size: 13px; cursor: pointer; border-radius: 999px;
  padding: 5px 12px; border: 0;
  background: var(--dsw-alias-button-primary-fill, #4d6bfe);
  color: var(--dsw-alias-label-primary-foreground, #fff);
}
.rdsh-pwa-card button:hover { background: var(--dsw-alias-button-primary-hover, #5c78ff); }
.rdsh-pwa-card button.rdsh-pwa-quiet {
  background: transparent; color: var(--dsw-alias-label-secondary, #cfd3d6);
  padding: 5px 8px;
}
.rdsh-pwa-card button.rdsh-pwa-quiet:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08)); }

.rdsh-pwa-foot {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  height: 36px; min-width: 36px; padding: 0 10px; border: 0; border-radius: 999px;
  background: transparent; color: var(--dsw-alias-label-primary, #f9fafb);
  font: inherit; font-size: 13px; cursor: pointer; white-space: nowrap;
  -webkit-tap-highlight-color: transparent;
}
.rdsh-pwa-foot[data-wide="false"] { width: 36px; min-width: 36px; padding: 0; }
.rdsh-pwa-foot:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08)); }
.rdsh-pwa-foot svg { flex: none; }

.rdsh-pwa-section { display: flex; flex-direction: column; gap: 12px; color: var(--dsw-alias-label-primary, #f9fafb); }
.rdsh-pwa-cardbox {
  border: .5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l3, rgba(255,255,255,.12)));
  background: var(--dsw-alias-settings-card-fill, transparent);
  border-radius: 12px; padding: 12px 14px; display: flex; flex-direction: column; gap: 10px;
}
.rdsh-pwa-title { margin: 0; font-size: 16px; font-weight: 500; }
.rdsh-pwa-desc { margin: 0; font-size: 13px; line-height: 1.6; color: var(--dsw-alias-label-tertiary, #adb2b8); }
.rdsh-pwa-rows { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 14px; margin: 0; font-size: 13px; }
.rdsh-pwa-rows dt { color: var(--dsw-alias-label-secondary, #cfd3d6); }
.rdsh-pwa-rows dd { margin: 0; overflow-wrap: anywhere; }
.rdsh-pwa-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.rdsh-pwa-actions button {
  font: inherit; font-size: 13px; min-height: 34px; padding: 0 14px; border-radius: 9px; cursor: pointer;
  border: .5px solid var(--dsw-alias-border-l3, rgba(255,255,255,.16));
  background: transparent; color: var(--dsw-alias-label-primary, #f9fafb);
}
.rdsh-pwa-actions button:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08)); }
.rdsh-pwa-actions button.rdsh-pwa-primary {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill, #4d6bfe);
  color: var(--dsw-alias-label-primary-foreground, #fff);
}
.rdsh-pwa-actions button:disabled { opacity: .45; cursor: default; }
.rdsh-pwa-note { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-tertiary, #adb2b8); margin: 0; }
.rdsh-pwa-code { font-family: var(--dsh-font-family-code, monospace); font-size: 12px; }
`;

    // ---------------------------------------------------------------------
    // Store
    // ---------------------------------------------------------------------
    const state = {
      installable: false,
      standalone: isStandalone(),
      offline: typeof navigator.onLine === "boolean" ? !navigator.onLine : false,
      bootError: "",
      updateReady: false,
      updateDismissed: false,
      // pending | active | unsupported | insecure | error
      sw: "pending",
      swError: "",
      swScript: "",
      build: "",
      cache: "",
      ios: isIos(),
      narrow: typeof window.matchMedia === "function" ? window.matchMedia(NARROW_QUERY).matches : false,
      secure: typeof window.isSecureContext === "boolean" ? window.isSecureContext : false,
      installing: false,
      installDismissed: false,
    };
    const subscribers = new Set();
    // Small ring buffer for diagnostics (and for tests that drive the page).
    const transitions = [];
    function emit(patch, source) {
      Object.assign(state, patch);
      transitions.push({ at: Date.now(), patch, source: source ?? "" });
      if (transitions.length > 40) transitions.shift();
      for (const fn of subscribers) {
        try {
          fn();
        } catch {
          /* a broken subscriber must not stop the others */
        }
      }
    }
    function useStore() {
      const [, tick] = useState(0);
      useEffect(() => {
        const force = () => tick((n) => (n + 1) % 1000000);
        subscribers.add(force);
        return () => {
          subscribers.delete(force);
        };
      }, []);
      return state;
    }

    // ---------------------------------------------------------------------
    // Install prompt
    // ---------------------------------------------------------------------
    let installEvent = null;

    async function promptInstall() {
      if (installEvent === null) return "unavailable";
      const event = installEvent;
      installEvent = null;
      emit({ installable: false, installing: true });
      try {
        event.prompt();
        const choice = await event.userChoice;
        const outcome = choice && choice.outcome ? choice.outcome : "dismissed";
        // "accepted" installs the app but leaves this tab a tab: the standalone
        // state stays owned by the display-mode media query.
        if (outcome === "accepted") emit({ installable: false });
        return outcome;
      } catch {
        return "error";
      } finally {
        emit({ installing: false });
      }
    }

    // ---------------------------------------------------------------------
    // Service worker
    // ---------------------------------------------------------------------
    let registration = null;
    let updateRequested = false;
    let reloading = false;
    let lastUpdateCheck = 0;

    async function applyUpdate() {
      updateRequested = true;
      emit({ updateReady: false });
      try {
        const reg = registration ?? (await navigator.serviceWorker.getRegistration());
        if (reg !== null && reg !== undefined && reg.waiting !== null) {
          reg.waiting.postMessage({ type: "SKIP_WAITING" });
          // controllerchange reloads; keep a fallback for a worker that
          // already activated behind our back.
          setTimeout(() => {
            if (!reloading) location.reload();
          }, 1500);
          return;
        }
        location.reload();
      } catch {
        location.reload();
      }
    }

    async function checkForUpdate() {
      const now = Date.now();
      if (now - lastUpdateCheck < 3000) return;
      lastUpdateCheck = now;
      try {
        const reg = registration ?? (await navigator.serviceWorker.getRegistration());
        if (reg === null || reg === undefined) return;
        emit({}, "checked");
        await reg.update();
        const waiting = reg.waiting === null ? "" : reg.waiting.scriptURL;
        if (isOwnWorker(waiting) && navigator.serviceWorker.controller !== null) emit({ updateReady: true }, "check");
      } catch {
        /* offline or the server is restarting; the next poll retries */
      }
    }

    function watchRegistration(reg) {
      const note = () => {
        const waiting = reg.waiting === null ? "" : reg.waiting.scriptURL;
        if (isOwnWorker(waiting) && navigator.serviceWorker.controller !== null) emit({ updateReady: true }, "watch");
      };
      note();
      reg.addEventListener("updatefound", () => {
        const installing = reg.installing;
        if (installing === null) return;
        installing.addEventListener("statechange", () => {
          if (installing.state === "installed") note();
        });
      });
    }

    async function pingWorker() {
      try {
        const reg = registration ?? (await navigator.serviceWorker.getRegistration());
        const worker = reg === null || reg === undefined ? null : reg.active;
        if (worker === null) return;
        const channel = new MessageChannel();
        const reply = new Promise((resolve) => {
          const timer = setTimeout(() => resolve(null), 1200);
          channel.port1.onmessage = (event) => {
            clearTimeout(timer);
            resolve(event.data ?? null);
          };
        });
        worker.postMessage({ type: "PING" }, [channel.port2]);
        const data = await reply;
        if (data && typeof data === "object") emit({ build: String(data.build ?? ""), cache: String(data.cache ?? "") });
      } catch {
        /* the badge simply stays empty */
      }
    }

    /**
     * Whether a service worker script URL is this plugin's own worker.
     * @param {string|undefined} url
     * @returns {boolean}
     */
    function isOwnWorker(url) {
      if (typeof url !== "string" || url === "") return false;
      try {
        return new URL(url).pathname === new URL(SW_URL).pathname;
      } catch {
        return false;
      }
    }

    /**
     * Tolerate the notification plugin's null-subscription bug.
     *
     * `dsh-notify-push` reads `getSubscription()` and tests `!== undefined`, so
     * a browser returning null throws inside its controllerchange handler. The
     * redirection below hands it a registration whose `getSubscription()`
     * reports "no subscription" the way that code expects; every other member
     * passes through to the real object.
     *
     * @param {ServiceWorkerRegistration} registration
     * @returns {ServiceWorkerRegistration}
     */
    function tolerateNullSubscription(registration) {
      const manager = registration.pushManager;
      if (manager === undefined || manager === null) return registration;
      const pushManager = new Proxy(manager, {
        get(target, property) {
          if (property === "getSubscription") {
            return async () => (await target.getSubscription()) ?? undefined;
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return new Proxy(registration, {
        get(target, property) {
          if (property === "pushManager") return pushManager;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }

    /**
     * Redirect the notification plugin's worker registration to ours.
     *
     * A browser allows one controlling worker per scope, so `dsh-notify-push`
     * (registered at /push/sw.js with scope "/") and this plugin would keep
     * replacing each other on every controllerchange: the loser stays
     * "waiting", the offline cache never controls the page and the update
     * banner fires on a worker that is not an update. Our worker implements
     * that plugin's push/notificationclick contract, so pointing its
     * registration here keeps notifications working and leaves exactly one
     * worker in charge.
     *
     * The wrapper only rewrites that one script URL; every other registration
     * passes through untouched, and cleanup restores the original function.
     */
    function unifyWorker() {
      const prototype = Object.getPrototypeOf(navigator.serviceWorker);
      const nativeRegister = prototype.register;
      const patched = function register(url, options) {
        try {
          const resolved = new URL(String(url), document.baseURI);
          if (resolved.pathname.endsWith(PUSH_WORKER_PATH)) {
            return nativeRegister.call(this, SW_URL, { ...options, scope: SCOPE.pathname })
              .then(tolerateNullSubscription);
          }
        } catch {
          /* fall through to the untouched registration */
        }
        return nativeRegister.call(this, url, options);
      };
      prototype.register = patched;
      return () => {
        if (prototype.register === patched) prototype.register = nativeRegister;
      };
    }

    async function registerWorker() {
      if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
        emit({ sw: "unsupported" });
        return;
      }
      if (!state.secure) {
        emit({ sw: "insecure" });
        return;
      }
      try {
        const existing = await navigator.serviceWorker.getRegistration();
        if (existing !== null && existing !== undefined) {
          const worker = existing.active ?? existing.waiting ?? existing.installing;
          const script = worker === null ? "" : worker.scriptURL;
          if (!isOwnWorker(script) && script.endsWith(PUSH_WORKER_PATH)) {
            // Replace the notification worker with the unified one. Its push
            // subscription is recreated by that plugin on controllerchange.
            await existing.unregister();
          } else if (script !== "" && !isOwnWorker(script)) {
            // An unknown worker owns this scope: never fight it, just report.
            emit({ sw: "shared", swScript: script });
            return;
          }
        }
        registration = await navigator.serviceWorker.register(SW_URL, {
          scope: SCOPE.pathname,
          updateViaCache: "none",
        });
        emit({ sw: navigator.serviceWorker.controller !== null ? "active" : "pending" });
        watchRegistration(registration);
        navigateWhenControllerChanges();
        if (registration.active !== null) void pingWorker();
        navigator.serviceWorker.ready.then(() => {
          emit({ sw: "active" });
          void pingWorker();
        }).catch(() => {});
      } catch (error) {
        emit({ sw: "error", swError: String((error && error.message) || error) });
      }
    }

    function navigateWhenControllerChanges() {
      if (navigator.serviceWorker.controller !== null) {
        emit({ sw: "active" });
        void pingWorker();
        return;
      }
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (updateRequested) {
          if (!reloading) {
            reloading = true;
            location.reload();
          }
          return;
        }
        emit({ sw: "active" }, "controllerchange");
        void pingWorker();
      }, { once: false });
    }

    // ---------------------------------------------------------------------
    // Toasts (plain DOM: they must survive any React tree remount)
    // ---------------------------------------------------------------------
    let toastRoot = null;
    let renderedSignature = "";

    function installPromptSnoozed() {
      try {
        const until = Number(localStorage.getItem(INSTALL_PROMPT_KEY) || 0);
        return Number.isFinite(until) && until > Date.now();
      } catch {
        return false;
      }
    }

    function snoozeInstallPrompt() {
      try {
        localStorage.setItem(INSTALL_PROMPT_KEY, String(Date.now() + INSTALL_PROMPT_SNOOZE_MS));
      } catch {
        /* private mode: the prompt simply returns next launch */
      }
      emit({ installDismissed: true });
    }

    /**
     * Whether the conversation is still the empty "new session" view. The
     * install card only belongs there: on a live transcript it would cover the
     * header tabs.
     */
    function onWelcomeScreen() {
      const header = document.querySelector("header[data-window-drag]");
      return header !== null && /_headerBlank/.test(header.className);
    }

    /** The release banner: whether a compact install affordance belongs on screen. */
    function showInstallPrompt() {
      if (state.standalone || state.installDismissed) return false;
      if (!state.narrow) return false;
      if (!state.installable && !state.ios) return false;
      if (!onWelcomeScreen()) return false;
      return !installPromptSnoozed();
    }

    function renderToasts() {
      if (toastRoot === null) return;
      const install = showInstallPrompt();
      const signature = JSON.stringify([state.offline, state.updateReady && !state.updateDismissed, install]);
      if (signature === renderedSignature) return;
      renderedSignature = signature;
      toastRoot.replaceChildren();
      if (install) {
        const card = document.createElement("div");
        card.className = "rdsh-pwa-card rdsh-pwa-install";
        const text = document.createElement("span");
        text.className = "rdsh-pwa-card-text";
        text.textContent = state.installable
          ? t("pwa.install.promptable")
          : t("pwa.install.iosHint");
        const installButton = document.createElement("button");
        installButton.type = "button";
        installButton.textContent = t("pwa.install.button");
        installButton.addEventListener("click", () => void promptInstall());
        const dismiss = document.createElement("button");
        dismiss.type = "button";
        dismiss.className = "rdsh-pwa-quiet";
        dismiss.textContent = t("pwa.later");
        dismiss.addEventListener("click", snoozeInstallPrompt);
        const actions = document.createElement("div");
        actions.className = "rdsh-pwa-install-actions";
        if (state.installable) actions.append(installButton);
        actions.append(dismiss);
        card.append(text, actions);
        toastRoot.append(card);
      }
      if (state.updateReady && !state.updateDismissed) {
        const card = document.createElement("div");
        card.className = "rdsh-pwa-card";
        const text = document.createElement("span");
        text.className = "rdsh-pwa-card-text";
        text.textContent = t("pwa.update.available");
        const reload = document.createElement("button");
        reload.type = "button";
        reload.textContent = t("pwa.update.reload");
        reload.addEventListener("click", () => void applyUpdate());
        const dismiss = document.createElement("button");
        dismiss.type = "button";
        dismiss.className = "rdsh-pwa-quiet";
        dismiss.textContent = t("pwa.later");
        dismiss.addEventListener("click", () => emit({ updateDismissed: true }));
        card.append(text, reload, dismiss);
        toastRoot.append(card);
      }
      if (state.offline) {
        const pill = document.createElement("div");
        pill.className = "rdsh-pwa-pill";
        pill.textContent = t("pwa.offline");
        toastRoot.append(pill);
      }
    }

    // ---------------------------------------------------------------------
    // UI
    // ---------------------------------------------------------------------
    function InstallIcon({ size }) {
      return h(
        "svg",
        { width: size, height: size, viewBox: "0 0 24 24", fill: "none", "aria-hidden": "true" },
        h("path", {
          d: "M12 3v11m0 0 4-4m-4 4-4-4",
          stroke: "currentColor",
          strokeWidth: 1.7,
          strokeLinecap: "round",
          strokeLinejoin: "round",
        }),
        h("path", {
          d: "M4.5 16.5V18A2.5 2.5 0 0 0 7 20.5h10a2.5 2.5 0 0 0 2.5-2.5v-1.5",
          stroke: "currentColor",
          strokeWidth: 1.7,
          strokeLinecap: "round",
        }),
      );
    }

    function InstallFooterAction({ wide }) {
      const s = useStore();
      if (!s.installable) return null;
      return h(
        "button",
        {
          type: "button",
          className: "rdsh-pwa-foot",
          "data-wide": wide ? "true" : "false",
          title: t("pwa.install.title"),
          "aria-label": t("pwa.install.title"),
          onClick: () => void promptInstall(),
        },
        h(InstallIcon, { size: wide ? 16 : 18 }),
        wide ? h("span", null, t("pwa.install.button")) : null,
      );
    }

    function swLabel(s) {
      switch (s.sw) {
        case "active":
          return s.updateReady ? t("pwa.sw.activeUpdate") : t("pwa.sw.active");
        case "unsupported":
          return t("pwa.sw.unsupported");
        case "insecure":
          return t("pwa.sw.insecure");
        case "shared":
          return t("pwa.sw.shared");
        case "error":
          return t("pwa.sw.error");
        default:
          return t("pwa.sw.pending");
      }
    }

    function installLabel(s) {
      if (s.standalone) return t("pwa.install.state.standalone");
      if (s.installable) return t("pwa.install.state.installable");
      if (s.ios) return t("pwa.install.state.ios");
      if (!s.secure) return t("pwa.install.state.insecure");
      return t("pwa.install.state.unsupported");
    }

    function PwaSettingsSection() {
      const s = useStore();
      const [message, setMessage] = useState("");
      const [busy, setBusy] = useState(false);

      const install = async () => {
        const outcome = await promptInstall();
        setMessage(outcome === "accepted"
          ? t("pwa.install.accepted")
          : outcome === "dismissed" ? t("pwa.install.dismissed") : t("pwa.install.unavailable"));
      };
      const check = async () => {
        setBusy(true);
        setMessage("");
        try {
          const reg = registration ?? (await navigator.serviceWorker.getRegistration());
          if (reg === null || reg === undefined) {
            setMessage(t("pwa.check.noWorker"));
          } else {
            await reg.update();
            const waiting = reg.waiting !== null;
            emit({ updateReady: waiting && navigator.serviceWorker.controller !== null });
            setMessage(waiting ? t("pwa.check.available") : t("pwa.check.latest"));
          }
        } catch {
          setMessage(t("pwa.check.failed"));
        } finally {
          setBusy(false);
          void pingWorker();
        }
      };

      return h(
        "section",
        { className: "rdsh-pwa-section" },
        h(
          "div",
          { className: "rdsh-pwa-cardbox" },
          h("h3", { className: "rdsh-pwa-title" }, t("pwa.section.title")),
          h("p", { className: "rdsh-pwa-desc" }, t("pwa.section.desc")),
          h(
            "dl",
            { className: "rdsh-pwa-rows" },
            h("dt", null, t("pwa.row.displayMode")),
            h("dd", null, s.standalone ? t("pwa.row.displayMode.standalone") : t("pwa.row.displayMode.browser")),
            h("dt", null, t("pwa.row.install")),
            h("dd", null, installLabel(s)),
            h("dt", null, t("pwa.row.offline")),
            h("dd", null, swLabel(s)),
            s.build !== "" ? h("dt", null, t("pwa.row.build")) : null,
            s.build !== "" ? h("dd", { className: "rdsh-pwa-code" }, s.build) : null,
          ),
          h(
            "div",
            { className: "rdsh-pwa-actions" },
            s.installable ? h("button", { type: "button", className: "rdsh-pwa-primary", onClick: install, disabled: busy }, t("pwa.install.button")) : null,
            s.updateReady ? h("button", { type: "button", className: "rdsh-pwa-primary", onClick: () => void applyUpdate() }, t("pwa.action.reloadUpdate")) : null,
            h("button", { type: "button", onClick: check, disabled: busy }, busy ? t("pwa.action.checking") : t("pwa.action.check")),
          ),
          message !== "" ? h("p", { className: "rdsh-pwa-note" }, message) : null,
          s.ios && !s.standalone
            ? h("p", { className: "rdsh-pwa-note" }, t("pwa.note.ios"))
            : null,
          !s.secure ? h("p", { className: "rdsh-pwa-note" }, t("pwa.note.insecure")) : null,
          s.sw === "error" && s.swError !== "" ? h("p", { className: "rdsh-pwa-note" }, t("pwa.note.swError", { error: s.swError })) : null,
          s.bootError !== "" ? h("p", { className: "rdsh-pwa-note" }, t("pwa.note.bootError", { error: s.bootError })) : null,
        ),
      );
    }

    // The mobile settings tab merges this section instead of showing the
    // separate "アプリ" tab.
    globalThis.__RDSH_PWA_SETTINGS_SECTION__ = PwaSettingsSection;

    // ---------------------------------------------------------------------
    // Wiring
    // ---------------------------------------------------------------------
    let booted = false;

    function boot(ctx) {
      if (booted) return;
      booted = true;

      ctx.effect(() => {
        const style = document.createElement("style");
        style.setAttribute(STYLE_ATTR, "true");
        style.textContent = CSS;
        document.head.appendChild(style);

        toastRoot = document.createElement("div");
        toastRoot.className = "rdsh-pwa-toasts";
        toastRoot.setAttribute("role", "status");
        toastRoot.setAttribute("aria-live", "polite");
        document.body.appendChild(toastRoot);

        const applyMode = () => {
          const standalone = isStandalone();
          document.documentElement.setAttribute(ROOT_ATTR, standalone ? "standalone" : "browser");
          emit({ standalone });
          renderToasts();
        };
        applyMode();

        // Belt and braces: if the served index predates the host tap, the
        // viewport still has to allow drawing under the notch.
        const viewport = document.querySelector('meta[name="viewport"]');
        if (viewport !== null && !/viewport-fit\s*=\s*cover/i.test(viewport.content)) {
          viewport.content = `${viewport.content}, viewport-fit=cover`;
        }

        const modeQueries = [STANDALONE_QUERY, FULLSCREEN_QUERY, MINIMAL_QUERY].map((query) => window.matchMedia(query));
        for (const media of modeQueries) media.addEventListener("change", applyMode);
        const narrowMedia = window.matchMedia(NARROW_QUERY);
        const onNarrow = () => emit({ narrow: narrowMedia.matches });
        narrowMedia.addEventListener("change", onNarrow);

        const onOnline = () => {
          emit({ offline: false });
          renderToasts();
          void checkForUpdate();
        };
        const onOffline = () => {
          emit({ offline: true });
          renderToasts();
        };
        window.addEventListener("online", onOnline);
        window.addEventListener("offline", onOffline);

        const onBeforeInstall = (event) => {
          event.preventDefault();
          installEvent = event;
          emit({ installable: true });
        };
        const onInstalled = () => {
          installEvent = null;
          emit({ installable: false });
          renderToasts();
        };
        window.addEventListener("beforeinstallprompt", onBeforeInstall);
        window.addEventListener("appinstalled", onInstalled);

        const restoreRegister = unifyWorker();
        const unsubscribe = subscribeToStore(renderToasts);
        // Navigation swaps the welcome view for a transcript (and back); the
        // install card depends on which one is mounted.
        let toastTimer = 0;
        const viewObserver = new MutationObserver(() => {
          if (toastTimer !== 0) return;
          toastTimer = setTimeout(() => {
            toastTimer = 0;
            renderToasts();
          }, 300);
        });
        viewObserver.observe(document.body, { childList: true, subtree: true });
        renderToasts();
        // Diagnostics surface: the Settings section reads the same store, and
        // an end-to-end test can assert on it without scraping the DOM.
        globalThis.__RDSH_PWA__ = {
          get state() { return { ...state }; },
          get transitions() { return transitions.slice(); },
          applyUpdate,
          checkForUpdate,
          promptInstall,
        };
        void registerWorker();

        // Poll for a new deployment while the tab stays open, and refresh the
        // check when the user comes back to it.
        const timer = setInterval(() => {
          if (document.visibilityState === "visible") void checkForUpdate();
        }, UPDATE_POLL_MS);
        const onVisible = () => {
          if (document.visibilityState === "visible" && Date.now() - lastUpdateCheck > UPDATE_MIN_GAP_MS) void checkForUpdate();
        };
        document.addEventListener("visibilitychange", onVisible);
        window.addEventListener("focus", onVisible);

        return () => {
          style.remove();
          toastRoot.remove();
          toastRoot = null;
          renderedSignature = "";
          emit({ installDismissed: false });
          for (const media of modeQueries) media.removeEventListener("change", applyMode);
          narrowMedia.removeEventListener("change", onNarrow);
          window.removeEventListener("online", onOnline);
          window.removeEventListener("offline", onOffline);
          window.removeEventListener("beforeinstallprompt", onBeforeInstall);
          window.removeEventListener("appinstalled", onInstalled);
          window.removeEventListener("focus", onVisible);
          document.removeEventListener("visibilitychange", onVisible);
          clearInterval(timer);
          clearTimeout(toastTimer);
          viewObserver.disconnect();
          unsubscribe();
          restoreRegister();
          delete globalThis.__RDSH_PWA__;
          // A live reload disposes and re-applies the plugin: let the effect
          // mount again instead of leaving the shell torn down.
          booted = false;
        };
      }, "rdsh-pwa: app shell");
    }

    // Subscribers are a Set of no-arg callbacks; the hook and the toast
    // renderer share it.
    function subscribeToStore(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    }

    return {
      inject: ["slots"],
      apply(ctx) {
        try {
          boot(ctx);
        } catch (error) {
          // Surface a boot failure to Settings and to tests instead of leaving
          // only a console trace behind.
          console.error("[rdsh-pwa] boot failed", error);
          emit({ bootError: String((error && error.message) || error) });
        }
        ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
          name: "sidebar.footer.action",
          id: "pwa-install",
          order: 40,
        }, InstallFooterAction));
        ctx.slots.inject("settings.section", () => ctx.slots.register({
          name: "settings.section",
          id: "pwa",
          order: 80,
          label: () => t("tab.pwa"),
        }, PwaSettingsSection));
      },
    };
    }

    // ---------------------------------------------------------------------
    // rdsh-mobile-ux — phone-width UX: drawer, settings, composer, in-app banners.
    // ---------------------------------------------------------------------
    function mobilePart() {

    // rdsh-mobile-ux — browser half.
    //
    // Phone-width behaviour for the DSH Web UI. Upstream class names are CSS
    // module hashes that change between releases, so this plugin never styles
    // a hash directly: `decorate()` maps the live DOM onto stable
    // `data-rdsh-*` hooks using structure (slots, aria labels, row keys) and
    // the stylesheet only targets those hooks. A renamed upstream class stops
    // a hook from matching and leaves the stock layout in place (fail closed).
    //
    // What it does, in the order a phone user meets it:
    //   * the session rail becomes an overlay drawer with a slide animation and
    //     a tappable backdrop, so the chat is never squeezed
    //   * a floating three-dot button sits where the rail logo used to be while
    //     the drawer is closed, and taps on it open the drawer (the drawer's
    //     own DeepSeek HARNESS brand stays untouched)
    //   * opening a session closes the drawer and does not steal focus into the
    //     composer; starting a new session closes the drawer too
    //   * Settings stacks its navigation over the content instead of squeezing
    //     both into 390px
    //   * controls that cannot work inside an installed PWA (open in editor /
    //     terminal, feedback, sign in) are hidden through a readable list
    //   * running sessions animate their label instead of showing a spinner
    //   * the profile's hide list and notification setup live in Settings
    const React = require("react");
    const h = React.createElement;
    const useState = React.useState;
    const useEffect = React.useEffect;

    // Same predicate as the PWA part above: a landscape phone is a phone.
    // Both halves must agree or the shell and the layout disagree on width.
    const NARROW_QUERY = "(max-width: 767px), (orientation: landscape) and (max-width: 1023px) and (max-height: 500px) and (pointer: coarse)";
    // `phone()` asks what the device is, not how wide the window is. A desktop
    // window dragged to 683px still has a mouse, a keyboard and a local editor,
    // so hiding the app's own controls there is a regression (#17).
    const COARSE_QUERY = "(pointer: coarse)";
    const ANY_COARSE_QUERY = "(any-pointer: coarse)";
    const HIDE_OVERRIDE_KEY = "rdsh-mobile-ux:hide-disabled";
    const HIDE_EXTRA_KEY = "rdsh-mobile-ux:hide-extra";
    const NOTIFY_DEVICE_TURNS_KEY = "rdsh-mobile-ux:notify-device-turns";
    const CONFIG = globalThis.__RDSH_MOBILE_UX_CONFIG__ && typeof globalThis.__RDSH_MOBILE_UX_CONFIG__ === "object"
      ? globalThis.__RDSH_MOBILE_UX_CONFIG__
      : {};
    // The host default is "outline"; this fallback covers the case where the
    // config script never landed, and must match or the two disagree.
    const ANIMATION = ["aurora", "breathing", "outline", "none"].includes(CONFIG.runningAnimation)
      ? CONFIG.runningAnimation
      : "outline";
    /** Shown in Settings so a stale PWA bundle is easy to spot. */
    const BUILD = "2026-10-23.review-fixes";

    // Upstream labels are matched through PROBES (all known locales). The
    // English fallbacks keep decoration working if the host's probe script
    // never landed; the injected vocabularies cover every known locale.
    const STOP_PROBE = probeRegex("stop", "i", "stop");
    const ACTIONS_PROBE = probeRegex("actions", "i", "actions");
    const TURNS_PROBE = probeRegex("turns", "i", ["turns", "turn", "steps", "step"]);
    const CACHE_PROBE = probeRegex("cacheHit", "i", "cache hit");
    const CONTEXT_PROBE = probeRegex("context", "i", "context");

    /**
     * Controls that have no meaning on a phone.
     *
     * Fail open: only an action that is guaranteed to dead-end in a phone
     * browser belongs here. "Built-in plugins", "Show coding view" and
     * "Keyboard shortcuts" are useful on a narrow desktop window (and arguably
     * on a phone), so they stay (#17). Every label that is only matched by
     * style/class does not belong here either.
     */
    const HIDE_DEFAULT = [
      // The config file lives on the host; a phone browser cannot open it.
      "Open configuration file",
      "Open in Files",
      // Bundled editors and file managers are desktop affordances; on a phone
      // the tap only produces an error or a dead end.
      "Open in Text Editor",
      "Open in editor",
      "Open in Explorer",
      "Reveal in Finder",
    ];

    // ---------------------------------------------------------------------
    // Store
    // ---------------------------------------------------------------------
    /** Browser-local theme choice; also read while the store initialises. */
    const DEVICE_THEME_KEY = "rdsh-pwa:device-theme";
    const DEVICE_THEME_MODES = ["", "light", "dark", "system"];
    // The device-theme choices are rendered through the copy table so a future
    // Japanese pack can translate them without touching this file.
    const DEVICE_THEME_KEYS = {
      "": "mux.deviceTheme.follow",
      light: "mux.deviceTheme.light",
      dark: "mux.deviceTheme.dark",
      system: "mux.deviceTheme.system",
    };

    const state = {
      narrow: window.matchMedia(NARROW_QUERY).matches,
      // What kind of device this is (see `phone()`), kept in the store so the
      // settings UI can stop offering phone-only rows on a desktop.
      phone: phone(),
      drawerOpen: false,
      hidden: [],
      hideDisabled: false,
      notifications: { supported: false, permission: "default", subscribed: false, ready: false },
      notice: "",
      bootError: "",
      enterToSend: readEnterToSend(),
      notifyDeviceTurns: readNotifyDeviceTurns(),
      deviceTheme: readDeviceTheme(),
      deviceThemeNote: "",
    };
    const subscribers = new Set();
    function emit(patch) {
      Object.assign(state, patch);
      for (const fn of subscribers) {
        try {
          fn();
        } catch {
          /* one broken subscriber must not stop the rest */
        }
      }
    }
    function useStore() {
      const [, tick] = useState(0);
      useEffect(() => {
        const force = () => tick((n) => (n + 1) % 1000000);
        subscribers.add(force);
        return () => {
          subscribers.delete(force);
        };
      }, []);
      return state;
    }

    function narrow() {
      return window.matchMedia(NARROW_QUERY).matches;
    }

    /**
     * Is this a phone (or an installed app), as opposed to a narrow window on
     * a desktop?
     *
     * #17: width alone is not a phone signal. A 683px desktop window is still
     * driven by a mouse and a keyboard and still has local editors and file
     * managers, so the controls it can use must stay visible. This predicate
     * is the one for hiding, label rewriting and send-side behaviour; the
     * layout (drawer, columns) keeps using `narrow()`, which really is about
     * width.
     *
     * Standalone/fullscreen counts because an installed app has no browser
     * chrome to fall back on. `navigator.standalone` covers iOS, which does not
     * report `display-mode` for a home-screen app.
     */
    function phone() {
      if (typeof window.matchMedia !== "function") return false;
      if (window.matchMedia(COARSE_QUERY).matches) return true;
      // A phone with a mouse attached reports a fine primary pointer, and a
      // touchscreen laptop reports a coarse secondary one. Only the narrow
      // layout separates them, so the fallback asks both questions. Installed
      // desktop PWAs and a fullscreen desktop window stay desktops: they have
      // a keyboard and local editors, and hiding stock UI there is #17.
      return narrow() && window.matchMedia(ANY_COARSE_QUERY).matches;
    }

    /**
     * Is the primary pointer a finger?
     *
     * Enter handling keys off this rather than off `narrow()`: a desktop
     * window dragged narrow is still driven by a keyboard, and losing Enter
     * there (the stock composer sends on plain Enter) is a real regression.
     * A tablet in landscape is a phone for gestures but may have a keyboard
     * attached; `pointer` describes the primary input, which is what the
     * gesture came from.
     */
    function coarsePointer() {
      return typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
    }

    const ENTER_TO_SEND_KEY = "rdsh-mobile-ux:enter-to-send";

    function readEnterToSend() {
      try {
        return localStorage.getItem(ENTER_TO_SEND_KEY) === "1";
      } catch {
        return false;
      }
    }

    function writeEnterToSend(value) {
      try {
        if (value) localStorage.setItem(ENTER_TO_SEND_KEY, "1");
        else localStorage.removeItem(ENTER_TO_SEND_KEY);
      } catch {
        /* private mode: the choice lasts for this page */
      }
      emit({ enterToSend: value });
    }

    /**
     * Treat turns sent from this browser as phone turns (#15).
     *
     * The host defaults to `onlyMobileTurns: true`, and the client only marks a
     * session after a send from a phone. A desktop send is therefore never
     * notified. The setting writer for the host config is not available to a
     * browser module, so this is a per-browser opt-in: while it is on, this
     * browser announces its sends through the same mobile-send endpoint a phone
     * uses. The host config stays untouched, which also means the choice is
     * remembered per browser profile rather than per profile.
     */
    function readNotifyDeviceTurns() {
      try {
        return localStorage.getItem(NOTIFY_DEVICE_TURNS_KEY) === "1";
      } catch {
        return false;
      }
    }

    function writeNotifyDeviceTurns(value) {
      try {
        if (value) localStorage.setItem(NOTIFY_DEVICE_TURNS_KEY, "1");
        else localStorage.removeItem(NOTIFY_DEVICE_TURNS_KEY);
      } catch {
        /* private mode: the choice lasts for this page */
      }
      emit({ notifyDeviceTurns: value });
      scheduleDecorate();
    }

    /** The live value of the #15 opt-in (the store copy only drives the UI). */
    function notifyDeviceTurns() {
      return readNotifyDeviceTurns();
    }

    // ---------------------------------------------------------------------
    // Per-device theme
    // ---------------------------------------------------------------------
    // The app's theme is a profile setting (settings/document), so the phone's
    // picker writes the *shared* value and every connected browser follows —
    // that is issue #5. This override is browser-local: it never calls
    // `theme.setTheme()` and never touches settings, it only repaints the same
    // DOM the upstream presenter owns (body[data-ds-dark-theme] /
    // html{color-scheme} / meta[name=theme-color]). If that contract is gone,
    // the override gives up instead of leaving a half-painted page.
    function readDeviceTheme() {
      try {
        const value = localStorage.getItem(DEVICE_THEME_KEY);
        return typeof value === "string" && DEVICE_THEME_MODES.includes(value) ? value : "";
      } catch (error) {
        return "";
      }
    }

    /** What the DOM looked like before the first override, for a clean release. */
    let deviceThemeBaseline = null;
    /** Set when the override cannot work here; the shared theme then stands. */
    let deviceThemeBlocked = false;
    let deviceThemeSnapshot = null;
    let deviceThemeCheck = 0;
    let deviceThemeRetries = 0;

    function captureDeviceBaseline() {
      if (deviceThemeBaseline !== null) return;
      deviceThemeBaseline = {
        dark: document.body.hasAttribute("data-ds-dark-theme"),
        colorScheme: document.documentElement.style.colorScheme || "",
        source: document.documentElement.dataset.dsThemeSource ?? "",
        themeColor: document.querySelector('meta[name="theme-color"]')?.getAttribute("content") ?? "",
      };
    }

    function bodyCanvasColor() {
      try {
        return getComputedStyle(document.body).backgroundColor;
      } catch (error) {
        return "";
      }
    }

    /** The palette variable itself, so the check survives a transparent body
     *  (the macOS shell paints the canvas elsewhere). */
    function paletteSignature() {
      try {
        const value = getComputedStyle(document.body).getPropertyValue("--dsw-alias-bg-base");
        return typeof value === "string" ? value.trim() : "";
      } catch (error) {
        return "";
      }
    }

    /** Keep `meta[name=theme-color]` (the browser chrome) on the painted colour. */
    function paintThemeColor() {
      const color = bodyCanvasColor();
      if (typeof color !== "string" || color === "") return;
      const metas = document.querySelectorAll('meta[name="theme-color"]');
      const meta = metas.length === 0 ? null : metas[metas.length - 1];
      if (meta !== null) meta.setAttribute("content", color);
    }

    /** Undo every DOM write this override made. */
    function releaseDeviceTheme() {
      if (deviceThemeBaseline === null) return;
      const baseline = deviceThemeBaseline;
      deviceThemeBaseline = null;
      const html = document.documentElement;
      html.removeAttribute("data-rdsh-device-theme");
      // Assigning "" removes the declaration, in the DOM and in the stub.
      html.style.colorScheme = baseline.colorScheme;
      if (baseline.source === "") delete html.dataset.dsThemeSource;
      else html.dataset.dsThemeSource = baseline.source;
      document.body.toggleAttribute("data-ds-dark-theme", baseline.dark);
      const metas = document.querySelectorAll('meta[name="theme-color"]');
      const meta = metas.length === 0 ? null : metas[metas.length - 1];
      if (meta !== null && baseline.themeColor !== "") meta.setAttribute("content", baseline.themeColor);
    }

    function deviceThemeScheme(mode) {
      if (mode === "light" || mode === "dark") return mode;
      if (mode !== "system") return null;
      try {
        return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      } catch (error) {
        return null;
      }
    }

    /**
     * Paint the stored per-device choice over the shared theme.
     *
     * Called at boot, after every `theme/change` (one microtask later, so the
     * upstream presenter has already written) and when the UI changes the
     * value. The result is checked on the next frame: if the palette attribute
     * was reverted or the body colour did not move, the contract is not there
     * and the override is abandoned for good.
     */
    function applyDeviceTheme() {
      if (typeof document === "undefined" || document.body === null) return;
      if (deviceThemeBlocked) return;
      const mode = readDeviceTheme();
      const html = document.documentElement;
      if (mode === "") {
        releaseDeviceTheme();
        if (state.deviceThemeNote !== "") emit({ deviceThemeNote: "" });
        return;
      }
      // A registered palette supplies its own token layer, which this override
      // cannot replace: mixing the two produces a page no theme owns.
      const custom = deviceThemeSnapshot !== null && Object.keys(deviceThemeSnapshot?.active?.tokens ?? {}).length > 0;
      if (custom) {
        releaseDeviceTheme();
        if (state.deviceThemeNote !== "custom") emit({ deviceThemeNote: "custom" });
        return;
      }
      const scheme = deviceThemeScheme(mode);
      if (scheme === null) {
        releaseDeviceTheme();
        return;
      }
      captureDeviceBaseline();
      const dark = scheme === "dark";
      const before = document.body.hasAttribute("data-ds-dark-theme");
      const beforePalette = before === dark ? "" : paletteSignature();
      html.setAttribute("data-rdsh-device-theme", scheme);
      html.style.colorScheme = scheme;
      html.dataset.dsThemeSource = scheme;
      document.body.toggleAttribute("data-ds-dark-theme", dark);
      paintThemeColor();
      if (state.deviceThemeNote !== "") emit({ deviceThemeNote: "" });
      if (before === dark) return;
      deviceThemeCheck += 1;
      const token = deviceThemeCheck;
      const verify = () => {
        if (token !== deviceThemeCheck || deviceThemeBlocked) return;
        const lost = document.body.hasAttribute("data-ds-dark-theme") !== dark;
        const unchanged = beforePalette !== "" && paletteSignature() === beforePalette;
        if (!lost && !unchanged) {
          deviceThemeRetries = 0;
          return;
        }
        // A presenter that boots after this plugin writes the shared palette
        // once; one retry settles that without declaring the contract dead.
        if (deviceThemeRetries < 2) {
          deviceThemeRetries += 1;
          applyDeviceTheme();
          return;
        }
        deviceThemeBlocked = true;
        releaseDeviceTheme();
        emit({ deviceThemeNote: "unsupported" });
      };
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(verify);
      else setTimeout(verify, 32);
    }

    /** Store the choice and repaint. Never writes the shared preference. */
    function writeDeviceTheme(value) {
      const next = DEVICE_THEME_MODES.includes(value) ? value : "";
      try {
        if (next === "") localStorage.removeItem(DEVICE_THEME_KEY);
        else localStorage.setItem(DEVICE_THEME_KEY, next);
      } catch (error) {
        /* private mode: the choice lasts for this page */
      }
      // An explicit choice re-arms a blocked override: the user may have
      // updated DSH since, and silently ignoring the picker is worse than one
      // more failed attempt (the frame check re-blocks it immediately).
      deviceThemeBlocked = false;
      deviceThemeRetries = 0;
      deviceThemeCheck += 1;
      emit({ deviceTheme: next, deviceThemeNote: "" });
      applyDeviceTheme();
    }

    /**
     * Wire the override to the theme service.
     *
     * No service (desktop shell without ui-theme, the unit-test stub) means no
     * shared value to fall back from: leave the DOM alone entirely.
     */
    function attachDeviceTheme(ctx) {
      let service;
      try {
        service = typeof ctx.get === "function" ? ctx.get("theme") : undefined;
      } catch (error) {
        service = undefined;
      }
      if (service === undefined || service === null) return;
      ctx.effect(() => {
        try {
          const snapshot = service.getTheme();
          if (snapshot !== undefined && snapshot !== null) deviceThemeSnapshot = snapshot;
        } catch (error) {
          deviceThemeSnapshot = null;
        }
        applyDeviceTheme();
        if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => applyDeviceTheme());
        let media = null;
        try {
          media = window.matchMedia("(prefers-color-scheme: dark)");
        } catch (error) {
          media = null;
        }
        const onSystemScheme = () => applyDeviceTheme();
        media?.addEventListener?.("change", onSystemScheme);
        const offTheme = ctx.on("theme/change", (snapshot) => {
          if (snapshot !== undefined && snapshot !== null) deviceThemeSnapshot = snapshot;
          // The presenter applies synchronously inside its own listener; run
          // after every listener so the device choice is the one that stands.
          queueMicrotask(applyDeviceTheme);
        });
        return () => {
          media?.removeEventListener?.("change", onSystemScheme);
          if (typeof offTheme === "function") offTheme();
          releaseDeviceTheme();
        };
      }, "rdsh-mobile-ux: device theme");
    }

    /**
     * Some client bundles register a slash command with a plain string where
     * the runtime calls `description()` / `label()`. That single bad row makes
     * the whole command source throw, which is what breaks the composer's "+"
     * menu (and "/"). Coerce the descriptor fields the runtime invokes.
     */
    function normalizeCommandContribution(contribution) {
      if (contribution === null || typeof contribution !== "object") return contribution;
      const next = { ...contribution };
      for (const field of ["label", "description"]) {
        if (next[field] !== undefined && typeof next[field] !== "function") {
          const value = String(next[field]);
          next[field] = () => value;
        }
      }
      if (next.available !== undefined && typeof next.available !== "function") {
        const value = next.available;
        next.available = () => value;
      }
      return next;
    }

    function patchCommandUi(ctx) {
      ctx.inject(["commandUi"], (scope) => {
        const service = scope.get("commandUi");
        if (service === null || service === undefined) return;
        const registry = service.live && service.live.contributions;
        if (registry instanceof Map) {
          for (const [name, contribution] of [...registry]) registry.set(name, normalizeCommandContribution(contribution));
        }
        const originalRegister = service.register;
        service.register = function register(contribution) {
          return originalRegister.call(this, normalizeCommandContribution(contribution));
        };
        return () => {
          service.register = originalRegister;
        };
      });
    }

    /** Publish the measured safe-area insets so fixed layers can inset too. */
    function measureSafeArea() {
      const probe = document.createElement("div");
      probe.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px);padding-left:env(safe-area-inset-left,0px);padding-right:env(safe-area-inset-right,0px)";
      document.body.append(probe);
      const style = getComputedStyle(probe);
      const top = parseFloat(style.paddingTop) || 0;
      const bottom = parseFloat(style.paddingBottom) || 0;
      const left = parseFloat(style.paddingLeft) || 0;
      const right = parseFloat(style.paddingRight) || 0;
      probe.remove();
      const root = document.documentElement;
      // iOS 26 standalone: the native web view is ~status-bar-height shorter
      // than the screen (screen.height - innerHeight), so the unpainted strip is
      // below the web view. The home indicator is in that strip, not inside the
      // page; the inner bottom safe-area padding would only enlarge the blank.
      const viewport = window.visualViewport;
      const keyboardOpen = viewport !== null && viewport !== undefined && viewport.height < window.innerHeight - 100;
      const screenHeight = window.screen && Number.isFinite(window.screen.height) ? window.screen.height : 0;
      const nativeGap = window.navigator.standalone === true && !keyboardOpen && screenHeight > 0 && screenHeight - window.innerHeight > 8;
      root.toggleAttribute("data-rdsh-native-gap", nativeGap);
      for (const [name, value] of [["top", top], ["bottom", bottom], ["left", left], ["right", right]]) {
        if (value > 0) root.setAttribute(`data-rdsh-safe-${name}`, "");
        else root.removeAttribute(`data-rdsh-safe-${name}`);
      }
      root.style.setProperty("--rdsh-safe-top", `${top}px`);
      root.style.setProperty("--rdsh-safe-bottom", `${bottom}px`);
      root.style.setProperty("--rdsh-native-gap-px", `${nativeGap ? Math.max(0, Math.round(screenHeight - window.innerHeight)) : 0}px`);
    }

    function readHideExtra() {
      try {
        const value = JSON.parse(localStorage.getItem(HIDE_EXTRA_KEY) || "[]");
        return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim() !== "") : [];
      } catch {
        return [];
      }
    }

    function hideDisabled() {
      if (CONFIG.showHiddenControls === true) return true;
      try {
        return localStorage.getItem(HIDE_OVERRIDE_KEY) === "1";
      } catch {
        return false;
      }
    }

    // ---------------------------------------------------------------------
    // Decoration: live DOM → stable hooks
    // ---------------------------------------------------------------------
    function frame() {
      const root = document.getElementById("root");
      const slot = root && root.firstElementChild;
      return slot && slot.firstElementChild;
    }

    function classToken(element, pattern) {
      return element && element.classList ? [...element.classList].some((token) => pattern.test(token)) : false;
    }

    function labelOf(element) {
      const aria = element.getAttribute("aria-label");
      if (aria && aria.trim() !== "") return aria.trim();
      const item = element.querySelector('[class*="_itemLabel"]');
      const text = item ? item.textContent : element.textContent;
      return (text || "").trim().replace(/\s+/g, " ");
    }

    function hideLabels() {
      return [...HIDE_DEFAULT, ...(Array.isArray(CONFIG.hideLabels) ? CONFIG.hideLabels : []), ...readHideExtra()];
    }

    function shouldHide(label, labels) {
      const normalized = label.toLowerCase();
      return labels.some((entry) => {
        const target = entry.toLowerCase();
        return normalized === target || normalized.startsWith(`${target} `) || normalized.startsWith(`${target}:`);
      });
    }

    function applyHideList(disabled) {
      const labels = hideLabels();
      const hidden = new Set();
      // #17: hiding is a phone decision. A narrow desktop window keeps every
      // control it can use, and the settings card stays honest about it.
      const hideOnThisDevice = !disabled && phone();
      for (const element of document.querySelectorAll("button[aria-label], [role='menuitem']")) {
        const label = labelOf(element);
        if (label === "" || label.length > 48) continue;
        if (hideOnThisDevice && shouldHide(label, labels)) {
          element.setAttribute("data-rdsh-hidden", "");
          hidden.add(label);
        } else {
          element.removeAttribute("data-rdsh-hidden");
        }
      }
      const modal = document.querySelector('[data-shortcut-modal="settings"]');
      // The tab merge is the phone layout: `MobileSection` inlines the PWA and
      // Input sections there, so the separate tabs vanish with them (#15). It
      // asks the device as well as the width, because a narrow desktop window
      // inlines nothing and must keep all three tabs.
      if (modal !== null && narrow() && phone()) {
        for (const button of modal.querySelectorAll("nav button")) {
          const label = (button.textContent || "").trim();
          const merged = label === t("tab.pwa") || label === t("tab.input");
          const hideTab = merged || (hideOnThisDevice && shouldHide(label, labels));
          button.toggleAttribute("data-rdsh-settings-tab-hidden", hideTab);
          if (hideTab) hidden.add(label);
        }
      } else if (modal !== null) {
        for (const button of modal.querySelectorAll("[data-rdsh-settings-tab-hidden]")) {
          button.removeAttribute("data-rdsh-settings-tab-hidden");
        }
      }
      // PC-only settings rows and action buttons. Matched by their label, not
      // by an upstream class: the row container is found through structure,
      // and a bare action button ("Open configuration file") is hidden as the
      // button itself.
      if (modal !== null && hideOnThisDevice) {
        const rowHidden = new Set();
        for (const element of modal.querySelectorAll("*")) {
          if (element.children.length !== 0) continue;
          const text = (element.textContent || "").trim().replace(/\s+/g, " ");
          if (text === "" || text.length > 48 || !shouldHide(text, labels)) continue;
          let row = element;
          while (row !== null && row !== modal) {
            const cls = typeof row.className === "string" ? row.className : "";
            const isRow = /(^|_)(?:row|setting)(?:_|$)|dswsnd-row/.test(cls);
            const isButton = row.tagName === "BUTTON" || row.getAttribute("role") === "button";
            if (isRow || isButton) {
              row.setAttribute("data-rdsh-setting-hidden", "");
              rowHidden.add(row);
              hidden.add(text);
              break;
            }
            row = row.parentElement;
          }
        }
        for (const row of modal.querySelectorAll("[data-rdsh-setting-hidden]")) {
          if (!rowHidden.has(row)) row.removeAttribute("data-rdsh-setting-hidden");
        }
      } else if (modal !== null) {
        // Leaving the phone (or turning hiding off) must not leave a stale
        // attribute behind for the next pass to trip over.
        for (const row of modal.querySelectorAll("[data-rdsh-setting-hidden]")) row.removeAttribute("data-rdsh-setting-hidden");
      }
      // Two plugins can add a "copy this session's id" row. Keep one: prefer the
      // localised rdsh row (it reports success) and drop the stock duplicate.
      const menu = document.querySelector("[role='menu']");
      if (menu !== null && hideOnThisDevice) {
        const items = [...menu.querySelectorAll("[role='menuitem']")];
        const localised = items.find((item) => (item.textContent || "").includes(t("sessionId.label")));
        const stock = items.find((item) => /^Copy Session ID$/i.test(labelOf(item)));
        if (localised !== undefined && stock !== undefined) {
          stock.setAttribute("data-rdsh-hidden", "");
          hidden.add("Copy Session ID");
        }
      }
      const list = [...hidden].sort();
      if (list.join("|") !== state.hidden.join("|")) emit({ hidden: list });
    }

    function unringSessionTitle(title) {
      // The animated ring used to wrap the label in its own element; it no
      // longer does, so only the attribute it added is left to clear.
      title.removeAttribute("data-rdsh-ringed");
    }

    function ringSessionRow(row) {
      row.setAttribute("data-rdsh-ring-row", "");
    }

    function unringSessionRow(row) {
      row.removeAttribute("data-rdsh-ring-row");
      const title = row.querySelector("[data-rdsh-session-title]");
      if (title !== null) unringSessionTitle(title);
    }

    const SESSION_FRAME_KEY = "rdsh-mobile-ux:session-frames";
    const FRAME_COLORS = [
      { id: "blue", label: t("frame.color.blue"), value: "#7aaaff" },
      { id: "green", label: t("frame.color.green"), value: "#5bd6a5" },
      { id: "amber", label: t("frame.color.amber"), value: "#ffd166" },
      { id: "red", label: t("frame.color.red"), value: "#ff6b6b" },
      { id: "purple", label: t("frame.color.purple"), value: "#b48cff" },
      { id: "pink", label: t("frame.color.pink"), value: "#ff8fc7" },
    ];
    function readSessionFrames() {
      try {
        const value = JSON.parse(localStorage.getItem(SESSION_FRAME_KEY) || "{}");
        return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
      } catch {
        return {};
      }
    }
    let sessionFrames = readSessionFrames();
    function sessionFrameOf(row) {
      const key = row.getAttribute("data-row-key") || "";
      const id = key.startsWith("session:") ? key.slice("session:".length) : "";
      const value = id === "" ? undefined : sessionFrames[id];
      return typeof value === "string" && value !== "" ? value : null;
    }
    function applySessionFrame(row) {
      const color = sessionFrameOf(row);
      if (color === null) {
        row.removeAttribute("data-rdsh-session-frame");
        row.style.removeProperty("--rdsh-session-frame");
      } else {
        row.setAttribute("data-rdsh-session-frame", "");
        row.style.setProperty("--rdsh-session-frame", color);
      }
    }
    function saveSessionFrame(sessionId, color) {
      if (color === null) delete sessionFrames[sessionId];
      else sessionFrames[sessionId] = color;
      try { localStorage.setItem(SESSION_FRAME_KEY, JSON.stringify(sessionFrames)); } catch { /* private mode */ }
      scheduleDecorate();
    }

    function decorateSessionRows() {
      rowHooksActive = true;
      for (const row of document.querySelectorAll('[data-row-key^="session:"]')) {
        row.setAttribute("data-rdsh-session", "");
        const children = [...row.children];
        const status = children.find((child) => classToken(child, /_slot$/));
        const title = children.find((child) => classToken(child, /_title$/));
        if (status) {
          status.setAttribute("data-rdsh-status", "");
          // Idle rows keep an empty 16px status slot; on a phone that width
          // belongs to the title.
          if (status.children.length === 0 && (status.textContent || "").trim() === "") status.setAttribute("data-rdsh-status-empty", "");
          else status.removeAttribute("data-rdsh-status-empty");
        }
        if (title) title.setAttribute("data-rdsh-session-title", "");
        applySessionFrame(row);
        const running = row.querySelector('svg[data-state="ongoing"]') !== null;
        if (running) row.setAttribute("data-rdsh-running", "");
        else row.removeAttribute("data-rdsh-running");
        // Only a running session sweeps. An open but idle session is marked
        // with the static frame below, so "open" never looks like "working".
        const selected = row.getAttribute("aria-selected") === "true";
        if (ANIMATION === "outline" && running) ringSessionRow(row);
        else unringSessionRow(row);
        row.toggleAttribute("data-rdsh-open-row", selected);
        // The row actions carry the "..." menu plus archive/pin shortcuts. On a
        // phone only the menu earns its width; the shortcuts stay in the menu.
        const actions = children.find((child) => classToken(child, /_rowActions$/));
        if (actions) {
          for (const button of actions.querySelectorAll("button")) {
            if (/^Session actions/i.test(button.getAttribute("aria-label") || "")) button.removeAttribute("data-rdsh-row-minor");
            else button.setAttribute("data-rdsh-row-minor", "");
          }
        }
      }
    }

    /** Whether the last pass wrote session-row hooks (so a wide pass is cheap). */
    let rowHooksActive = false;

    const SESSION_ROW_HOOKS = [
      "data-rdsh-running",
      "data-rdsh-ring-row",
      "data-rdsh-open-row",
      "data-rdsh-session-frame",
      "data-rdsh-row-minor",
      "data-rdsh-row-menu",
      "data-rdsh-dragging",
    ];

    /**
     * Strip every session-row hook.
     *
     * Reached when the window widens (or a rotation leaves the phone layout):
     * the styling is inside the phone query, so the attributes are inert, but
     * leaving them behind means a later narrow pass starts from another
     * layout's leftovers, and `[data-rdsh-running]` on a desktop row is a lie
     * to anything that reads the DOM.
     */
    function clearSessionRowHooks() {
      rowHooksActive = false;
      for (const attribute of SESSION_ROW_HOOKS) {
        for (const element of document.querySelectorAll(`[${attribute}]`)) element.removeAttribute(attribute);
      }
      for (const element of document.querySelectorAll("[data-rdsh-session], [data-rdsh-status], [data-rdsh-session-title], [data-rdsh-ringed]")) {
        if (element.hasAttribute("data-rdsh-session")) element.removeAttribute("data-rdsh-session");
        if (element.hasAttribute("data-rdsh-status")) {
          element.removeAttribute("data-rdsh-status");
          element.removeAttribute("data-rdsh-status-empty");
        }
        if (element.hasAttribute("data-rdsh-session-title")) element.removeAttribute("data-rdsh-session-title");
        element.removeAttribute("data-rdsh-ringed");
      }
    }

    /**
     * Strip the other phone-only hooks whose styling lives in the phone query.
     *
     * The typing overlay is painted above React's text with the real glyphs
     * made transparent, so it has to go together with its attributes.
     */
    function clearPhoneHooks() {
      for (const attribute of ["data-rdsh-header-title", "data-rdsh-header-running", "data-rdsh-typing", "data-rdsh-rtab"]) {
        for (const element of document.querySelectorAll(`[${attribute}]`)) element.removeAttribute(attribute);
      }
      for (const layer of document.querySelectorAll("[data-rdsh-typing-layer]")) layer.remove();
      clearSessionRowHooks();
    }

    function decorateEditCards() {
      for (const element of document.querySelectorAll("[data-rdsh-edit-card]")) element.removeAttribute("data-rdsh-edit-card");
      for (const element of document.querySelectorAll("[data-rdsh-edit-header], [data-rdsh-edit-row]")) {
        element.removeAttribute("data-rdsh-edit-header");
        element.removeAttribute("data-rdsh-edit-row");
      }
      for (const element of document.querySelectorAll("span, div")) {
        if (element.children.length !== 0) continue;
        if (!/^Edited \d+ files?$/.test((element.textContent || "").trim())) continue;
        const card = element.closest('[class*="_card"]');
        if (card === null) continue;
        card.setAttribute("data-rdsh-edit-card", "");
        const header = card.querySelector("button");
        if (header !== null) header.setAttribute("data-rdsh-edit-header", "");
        for (const row of card.querySelectorAll("li > button, button")) {
          if (row !== header) row.setAttribute("data-rdsh-edit-row", "");
        }
        break;
      }
    }

    let rightPanelNode = null;
    let rightPanelWatch = null;
    let rightPanelIO = null;

    /**
     * Upstream's own wrapper for the right sidebar.
     *
     * Everything below searches inside this subtree only. Without a boundary
     * the collapse button of a hidden `SessionView` (the full-screen Plugins
     * and Automation-tasks routes keep one mounted at 0x0) walked up past its
     * own panel to the app frame, and the frame then looked like an open
     * panel: the header and the drawer button were hidden by CSS and there was
     * no way back on a phone.
     */
    const RIGHT_PANEL_ROOT = "[data-sidebar-right-panel]";

    /** The collapse button of a panel that is actually laid out. */
    function visibleCollapseButton() {
      for (const button of document.querySelectorAll('[aria-label="Collapse right sidebar"]')) {
        // Visibility is deliberately not part of this: the real panel keeps
        // its chrome mounted while closed (clipped to a zero-width column and
        // parked off-screen), and its rect stays non-zero. Only a panel that
        // never rendered is 0x0.
        const rect = button.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        if (button.closest(RIGHT_PANEL_ROOT) === null) continue;
        return button;
      }
      return null;
    }

    function syncRightPanelOpen() {
      const panel = rightPanelNode;
      let open = false;
      if (panel !== null && panel.isConnected) {
        // A panel inside a `[hidden]` subtree is upstream saying "another route
        // owns the screen"; its own box may still measure, so check the host.
        const host = panel.closest(RIGHT_PANEL_ROOT) ?? panel;
        open = host.closest("[hidden]") === null
          && getComputedStyle(panel).visibility !== "hidden"
          && panel.getBoundingClientRect().width > 0;
      }
      document.documentElement.toggleAttribute("data-rdsh-rightpanel-open", open);
    }

    function watchRightPanel(panel) {
      if (rightPanelNode !== panel) {
        rightPanelWatch?.disconnect();
        rightPanelIO?.disconnect();
        rightPanelNode = panel;
        rightPanelWatch = new MutationObserver(syncRightPanelOpen);
        rightPanelWatch.observe(panel, { attributes: true, attributeFilter: ["class", "style"] });
        rightPanelIO = new IntersectionObserver(syncRightPanelOpen, { threshold: 0.25 });
        rightPanelIO.observe(panel);
      }
      syncRightPanelOpen();
    }

    /**
     * Drop every right-panel hook.
     *
     * The panel node is replaced when the route or the pane changes, and the
     * old tag has to go with it: two tagged nodes at once apply the panel's
     * phone layout (max-width, overflow, padding) to the whole app.
     */
    function forgetRightPanel() {
      for (const node of document.querySelectorAll("[data-rdsh-rightpanel]")) node.removeAttribute("data-rdsh-rightpanel");
      rightPanelWatch?.disconnect();
      rightPanelIO?.disconnect();
      rightPanelWatch = null;
      rightPanelIO = null;
      rightPanelNode = null;
      document.documentElement.removeAttribute("data-rdsh-rightpanel-open");
    }

    /**
     * Tag the scroller that owns a code preview.
     *
     * The viewer scrolls in both axes by default; the lock in the stylesheet
     * keys off this attribute so a long line cannot be panned sideways.
     */
    function decorateCodePreview() {
      for (const pre of document.querySelectorAll("[data-rdsh-rightpanel] [data-textpreview-body] pre:not([data-rdsh-code-pre])")) {
        pre.setAttribute("data-rdsh-code-pre", "");
        let node = pre.parentElement;
        while (node !== null && node !== document.body) {
          const overflowX = getComputedStyle(node).overflowX;
          if (overflowX === "auto" || overflowX === "scroll") {
            node.setAttribute("data-rdsh-code-scroll", "");
            break;
          }
          node = node.parentElement;
        }
      }
    }

    function decorateRightPanel() {
      const collapse = visibleCollapseButton();
      if (collapse === null) {
        // No laid-out panel anywhere: close the state instead of keeping the
        // last one. A full-screen route (Plugins, Automation tasks) leaves the
        // chat's panel mounted but unrendered, and a stale "open" hides the
        // header and the drawer button.
        if (rightPanelNode !== null) forgetRightPanel();
        return;
      }
      const boundary = collapse.closest(RIGHT_PANEL_ROOT);
      // The panel is the nearest ancestor that already spans the phone (the
      // fullscreen layer), not a hash-named class that changes per release.
      let node = collapse.parentElement;
      while (node !== null && node !== boundary && node !== document.body) {
        const rect = node.getBoundingClientRect();
        if (rect.width >= window.innerWidth * 0.85 && rect.height >= window.innerHeight * 0.5) {
          // A rotation changes those thresholds, so the next pass can pick a
          // different node; exactly one may carry the hook.
          for (const stale of document.querySelectorAll("[data-rdsh-rightpanel]")) {
            if (stale !== node) stale.removeAttribute("data-rdsh-rightpanel");
          }
          node.setAttribute("data-rdsh-rightpanel", "");
          watchRightPanel(node);
          return;
        }
        node = node.parentElement;
      }
      if (rightPanelNode !== null) forgetRightPanel();
    }

    /**
     * Mark the right panel's tabs.
     *
     * dockkit draws them as `[role="tab"][data-dockkit-tab]`; the attribute is
     * the stable part (the class is hashed per release), and the stylesheet
     * needs its own hook to size and pan them on a phone. The tap compensation
     * lives in the pointer handlers below and keys off the same attribute.
     */
    function decorateRightPanelTabs() {
      if (!narrow()) return;
      for (const tab of document.querySelectorAll('[data-rdsh-rightpanel] [role="tab"][data-dockkit-tab]')) {
        tab.setAttribute("data-rdsh-rtab", "");
      }
    }

    /** The plugin context, kept so the session projection can be looked up. */
    let hostCtx = null;
    let sessionsApi;
    let sessionsApiResolved = false;

    /** `sessions` is an optional service: resolving it lazily means a late
     *  provider still works, and an absent one only costs the used/max text. */
    function sessionsService() {
      if (!sessionsApiResolved && hostCtx !== null) {
        try {
          const service = typeof hostCtx.get === "function" ? hostCtx.get("sessions") : undefined;
          if (service !== undefined && service !== null) {
            sessionsApi = service;
            sessionsApiResolved = true;
          }
        } catch (error) {
          // Not provided in this profile: keep showing the percentage alone.
        }
      }
      return sessionsApi;
    }

    /** Mirrors the upstream `formatTokens` so the dock and the panel agree. */
    function formatTokenCount(value) {
      const scaled = (candidate) => (candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10));
      if (value < 1e3) return String(Math.round(value));
      if (value < 1e6) return `${scaled(value / 1e3)}K`;
      return `${scaled(value / 1e6)}M`;
    }

    /**
     * "12.3K/1M" for the context meter, read from the Session projection.
     *
     * The panel that shows these figures is only mounted while it is open, so
     * the old code opened it with a real click, read the DOM after 80ms and
     * closed it again — which flashed the menu (and, through the
     * `*_panel` CSS, any other dialog) on every update. The projection carries
     * the same numbers without touching the DOM; when it is missing the dock
     * falls back to the percentage that the button's aria-label already has.
     */
    function contextUsageText() {
      const sessions = sessionsService();
      const sessionId = currentSessionId;
      if (sessions === null || sessions === undefined || sessionId === null) return "";
      try {
        const pressure = sessions.projectionValues(sessionId)?.contextPressure;
        if (pressure === null || typeof pressure !== "object") return "";
        const used = pressure.projectedTokens ?? pressure.pressureTokens;
        const window = pressure.contextWindow;
        if (typeof used !== "number" || typeof window !== "number" || !(window > 0)) return "";
        return `${formatTokenCount(used)}/${formatTokenCount(window)}`;
      } catch (error) {
        return "";
      }
    }

    let settingsArrows = null;
    let settingsTabResetPending = false;

    /** Reset the options scroller only after the new tab's section has been
     *  committed. Resetting on the click scrolls the old section first, which
     *  is the visible "flick" on iOS. */
    function observeSettingsOptions(modal) {
      const options = modal.querySelector('[class*="VOzbGW_options"]');
      if (options === null || options.hasAttribute("data-rdsh-options-observer")) return;
      options.setAttribute("data-rdsh-options-observer", "");
      const observer = new MutationObserver(() => {
        if (!settingsTabResetPending) return;
        settingsTabResetPending = false;
        if (options.scrollTop !== 0) options.scrollTop = 0;
      });
      observer.observe(options, { childList: true, subtree: true });
    }

    function settingsNavList() {
      const modal = document.querySelector('[data-shortcut-modal="settings"]');
      if (modal === null) return null;
      const nav = modal.querySelector("nav");
      const list = nav === null ? null : nav.querySelector('[class*="navList"]');
      return list === null || nav === null ? null : { modal, nav, list };
    }

    function positionSettingsArrows() {
      if (settingsArrows === null) return;
      const found = settingsNavList();
      if (found === null) {
        settingsArrows.left.hidden = true;
        settingsArrows.right.hidden = true;
        return;
      }
      const { list } = found;
      settingsArrows.list = list;
      const rect = list.getBoundingClientRect();
      const firstTab = list.querySelector("button");
      const tabRect = firstTab === null ? rect : firstTab.getBoundingClientRect();
      const top = `${Math.round(tabRect.top + (tabRect.height - 30) / 2)}px`;
      settingsArrows.left.style.left = `${Math.round(rect.left + 2)}px`;
      settingsArrows.left.style.top = top;
      settingsArrows.right.style.left = `${Math.round(rect.right - 32)}px`;
      settingsArrows.right.style.top = top;
      const max = Math.max(0, list.scrollWidth - list.clientWidth);
      const canLeft = list.scrollLeft > 2;
      const canRight = list.scrollLeft < max - 2;
      settingsArrows.left.hidden = !canLeft;
      settingsArrows.right.hidden = !canRight;
      list.toggleAttribute("data-rdsh-fade-left", canLeft);
      list.toggleAttribute("data-rdsh-fade-right", canRight);
    }

    function installSettingsNavArrows() {
      if (!narrow()) {
        if (settingsArrows !== null) {
          settingsArrows.left.hidden = true;
          settingsArrows.right.hidden = true;
        }
        return;
      }
      const found = settingsNavList();
      if (found === null) {
        if (settingsArrows !== null) {
          settingsArrows.left.hidden = true;
          settingsArrows.right.hidden = true;
        }
        return;
      }
      if (settingsArrows === null) {
        const make = (side) => {
          const button = document.createElement("button");
          button.type = "button";
          button.setAttribute("data-rdsh-settings-nav-arrow", side);
          button.setAttribute("aria-label", side === "left" ? t("mux.nav.scrollLeft") : t("mux.nav.scrollRight"));
          button.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${side === "left" ? "M10 3L5 8l5 5" : "M6 3l5 5-5 5"}"/></svg>`;
          button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            const list = settingsArrows === null ? null : settingsArrows.list;
            if (list === null) return;
            const amount = Math.max(140, list.clientWidth * 0.7);
            list.scrollBy({ left: side === "left" ? -amount : amount, behavior: "smooth" });
          });
          document.body.append(button);
          return button;
        };
        settingsArrows = { left: make("left"), right: make("right"), list: found.list, modal: found.modal };
      }
      const { list, modal } = found;
      if (settingsArrows.list !== list) {
        settingsArrows.list = list;
        settingsArrows.modal = modal;
      }
      if (!list.hasAttribute("data-rdsh-nav-scroll")) {
        list.setAttribute("data-rdsh-nav-scroll", "");
        list.addEventListener("scroll", positionSettingsArrows, { passive: true });
      }
      if (!list.hasAttribute("data-rdsh-nav-tabclick")) {
        list.setAttribute("data-rdsh-nav-tabclick", "");
        list.addEventListener("click", (event) => {
          if (event.target.closest("[data-rdsh-settings-nav-arrow]") !== null) return;
          if (event.target.closest("button") === null) return;
          settingsTabResetPending = true;
        }, true);
      }
      observeSettingsOptions(modal);
      positionSettingsArrows();
    }

    function decorateStatsDock() {
      // `contextUsedMax` below opens the context panel to read its figures and
      // closes it again. The probe only hides itself on a phone, so on a wide
      // screen the panel would flash open on every decorate pass.
      if (!narrow()) return;
      const dock = document.querySelector("[data-rdsh-composer-dock]");
      if (dock === null) return;
      const buttons = [...dock.querySelectorAll("button")].filter((button) => button.getAttribute("aria-label") !== null);
      const ariaOf = (button) => button.getAttribute("aria-label") || "";
      const activity = buttons.find((button) => TURNS_PROBE.test(ariaOf(button)));
      const usage = buttons.find((button) => CACHE_PROBE.test(ariaOf(button)));
      const context = buttons.find((button) => CONTEXT_PROBE.test(ariaOf(button)));

      const set = (button, text) => {
        if (button === undefined) return;
        if (text === "") button.removeAttribute("data-rdsh-stat-text");
        else if (button.getAttribute("data-rdsh-stat-text") !== text) button.setAttribute("data-rdsh-stat-text", text);
      };

      if (activity !== undefined) {
        const aria = ariaOf(activity);
        const numbers = aria.match(/\d[\d,.]*(?:\s*[KMB])?/gi) || [];
        const turns = numbers[0];
        const tok = numbers.length > 1 ? numbers[numbers.length - 1] : undefined;
        const turnsLabel = turns === undefined
          ? ""
          : t(turns === "1" ? "mux.stats.turn" : "mux.stats.turns", { count: turns });
        set(activity, tok === undefined || turnsLabel === ""
          ? turnsLabel
          : `${turnsLabel} · ${t("mux.stats.tokPerSec", { speed: tok })}`);
      }
      if (usage !== undefined) {
        const percents = [...ariaOf(usage).matchAll(/(\d+)%/g)];
        const hit = percents.length > 0 ? percents[percents.length - 1][1] : undefined;
        set(usage, hit === undefined ? "" : t("mux.stats.cacheHit", { percent: hit }));
      }
      if (context !== undefined) {
        const percent = ariaOf(context).match(/(\d+)%/);
        const usedMax = percent === null ? "" : contextUsageText();
        set(context, percent === null ? "" : `${percent[1]}%${usedMax === "" ? "" : ` · ${usedMax}`}`);
      }
    }

    function decorateModelSearch() {
      if (!narrow()) return;
      const menu = document.querySelector('[class*="_7KE1Ra_menu"]');
      if (menu === null) return;
      const input = menu.querySelector("input");
      if (input === null) return;
      if (!input.hasAttribute("data-rdsh-model-search")) {
        input.setAttribute("data-rdsh-model-search", "");
        const row = input.closest('[class*="_7KE1Ra_searchRow"]') ?? input.parentElement;
        if (row !== null) {
          row.setAttribute("data-rdsh-model-search-row", "");
          // The picker focuses this field by itself when it opens the model
          // pane. Disabled inputs ignore .focus(), so opening the picker no
          // longer pulls focus (or the keyboard) into the search.
          row.addEventListener("pointerdown", () => {
            input.disabled = false;
            requestAnimationFrame(() => input.focus({ preventScroll: true }));
          }, true);
        }
      }
      if (!input.disabled) input.disabled = true;
      if (document.activeElement === input) input.blur();
    }

    function decorateTodoPanel() {
      if (!narrow()) return;
      const panel = document.querySelector('[data-testid="todo-panel"]');
      if (panel === null) return;
      for (const item of panel.querySelectorAll("li")) {
        const content = item.querySelector('[class*="_content"]');
        if (content === null) continue;
        const text = (content.textContent || "").trim();
        if (text === "") continue;
        item.setAttribute("data-rdsh-todo-item", "");
        item.setAttribute("data-rdsh-todo-text", text);
        const status = item.querySelector('[role="img"][aria-label]');
        if (status !== null) item.setAttribute("data-rdsh-todo-status", status.getAttribute("aria-label") || "");
        // No `role="button"` here: the row already contains the real checkbox
        // button, and nesting an interactive role inside another one is
        // invalid. `tabindex` keeps the text reachable from the keyboard (the
        // keydown handler below opens the popover), which is what the role was
        // buying.
        item.setAttribute("tabindex", "0");
        item.setAttribute("title", text);
      }
    }

    function decorateGoalBar() {
      if (!narrow()) return;
      const bar = document.querySelector("[data-goal-bar]");
      if (bar === null) return;
      const objective = bar.querySelector('[class*="_objective"]');
      if (objective !== null) {
        const text = (objective.textContent || "").trim();
        if (text !== "") {
          objective.setAttribute("data-rdsh-goal-objective", "");
          objective.setAttribute("data-rdsh-goal-text", text);
          objective.setAttribute("role", "button");
          objective.setAttribute("tabindex", "0");
          objective.setAttribute("title", text);
        }
      }
      const actions = bar.querySelector('[class*="_actions"]');
      if (actions !== null) actions.setAttribute("data-rdsh-goal-actions", "");
      if (bar.querySelector('[class*="_editBar"]') !== null) bar.setAttribute("data-rdsh-goal-editing", "");
      else bar.removeAttribute("data-rdsh-goal-editing");
    }

    /** Labels a session shows before it has been named (all known locales). */
    const UNTITLED = probeRegex("untitled", "i", ["new session", "new chat", "untitled"], true);
    /** Last title seen per target, so only the first naming animates. */
    const titleSeen = new Map();
    /** How many passes each target has played; a session is named twice. */
    const titlePasses = new Map();
    /** Passes allowed per session: the initial label, then the model's name. */
    const TITLE_PASSES = 2;
    /** When each target was last seen working, to recognise a generated name. */
    const titleWorkingAt = new Map();
    /** How long after a turn a generated name still counts as "just named". */
    const NAME_GRACE_MS = 45000;

    function untitled(text) {
      const value = (text || "").trim();
      return value === "" || UNTITLED.test(value);
    }

    /** Per-character delay while typing; punctuation and spaces pause longer. */
    const TYPE_MS = 44;
    const TYPE_PAUSE_MS = 130;
    /** Erasing is quicker than typing, the way a held backspace reads. */
    const ERASE_MS = 26;
    /** Beat between "empty" and the next name, so the erase is visible. */
    const RETYPE_GAP_MS = 240;

    /**
     * Write a session name over the real one, character by character.
     *
     * React owns the text node, so the real text is made transparent and a
     * positioned copy is animated on top: re-rendering mid-animation cannot
     * leave a half-written title behind, the accessible name never changes,
     * and the layer is removed when the last character lands.
     *
     * A session is named twice — an initial label, then the name the model
     * settles on — so the second pass erases the first one before typing, the
     * way a person would clear the line and start again.
     *
     * @param {Element} element - the title element React renders into.
     * @param {string} next - the name to end on.
     * @param {string} [previous] - the name to erase first.
     */
    /** The text React owns, ignoring the layer this module paints over it. */
    function sessionTitleText(element) {
      let out = "";
      for (const node of element.childNodes) {
        if (node.nodeType === 3) out += node.nodeValue || "";
        else if (node.nodeType === 1 && !node.hasAttribute("data-rdsh-typing-layer")) out += node.textContent || "";
      }
      return out.trim();
    }

    function animateSessionTitle(element, next, previous) {
      if (element.hasAttribute("data-rdsh-typing")) return null;
      element.setAttribute("data-rdsh-typing", "");
      const layer = document.createElement("span");
      layer.setAttribute("data-rdsh-typing-layer", "");
      layer.setAttribute("aria-hidden", "true");
      const caret = document.createElement("span");
      caret.setAttribute("data-rdsh-typing-caret", "");
      let timer = 0;
      let shown = "";
      const stop = () => {
        clearTimeout(timer);
        element.removeAttribute("data-rdsh-typing");
        layer.remove();
      };
      const paint = (value) => {
        shown = value;
        layer.textContent = value;
        layer.append(caret);
      };
      const typeNext = () => {
        let index = 0;
        const step = () => {
          index += 1;
          paint(next.slice(0, index));
          if (index >= next.length) {
            timer = setTimeout(stop, 1100);
            return;
          }
          const char = next[index - 1] || "";
          timer = setTimeout(step, /[。、．，,.!?！？・:;：；\s]/.test(char) ? TYPE_PAUSE_MS : TYPE_MS);
        };
        step();
      };
      const eraseThenType = () => {
        let index = previous.length;
        const step = () => {
          index -= 1;
          paint(previous.slice(0, Math.max(0, index)));
          if (index > 0) {
            timer = setTimeout(step, ERASE_MS);
            return;
          }
          timer = setTimeout(typeNext, RETYPE_GAP_MS);
        };
        step();
      };
      element.append(layer);
      if (typeof previous === "string" && previous !== "") eraseThenType();
      else typeNext();
      // What is on screen right now, so a name that arrives mid-animation can
      // erase it instead of appearing under the running one. `reattach` exists
      // because React writes the title with `textContent`, which drops the
      // layer: without it the real text shows for a frame and the animation
      // starts over from the full previous name.
      return {
        visible: () => shown,
        cancel: stop,
        reattach: () => {
          if (layer.isConnected) return;
          element.append(layer);
          layer.textContent = shown;
          layer.append(caret);
        },
      };
    }

    /** MutationObserver + the elements it watches, so titles retype promptly. */
    let titleTextWatch = null;
    let titleTextTargets = [];
    /** The running animation per target, so a newer name can replace it. */
    const titleAnimations = new Map();

    /**
     * Observe the title elements themselves.
     *
     * The main observer watches childList and a few attributes only: adding
     * characterData there would fire on every streamed transcript token. The
     * generated name arrives as a text change, so it needs its own tiny
     * observer, re-targeted whenever the decorated set changes.
     */
    function watchTitleText(elements) {
      const unchanged = elements.length === titleTextTargets.length
        && elements.every((element, index) => element === titleTextTargets[index]);
      if (unchanged) return;
      if (titleTextWatch === null) titleTextWatch = new MutationObserver(() => scheduleDecorate());
      titleTextWatch.disconnect();
      for (const element of elements) titleTextWatch.observe(element, { childList: true, characterData: true, subtree: true });
      titleTextTargets = elements;
    }

    /**
     * Mark the header title while the session it names is working.
     *
     * The sidebar row already animates, but on a phone the sidebar is usually
     * closed, so the header is the only place that can say "this session is
     * running". The running set comes from the session store: the DOM only
     * carries the id.
     */
    function decorateHeaderTitle() {
      if (!narrow()) return;
      const crumb = document.querySelector('[data-rdsh-crumbs] [class*="_crumbCurrent"]');
      if (crumb === null) return;
      crumb.setAttribute("data-rdsh-header-title", "");
      const host = document.querySelector("[data-conversation-session]");
      const id = host === null ? "" : (host.getAttribute("data-conversation-session") || "");
      const running = id !== "" && globalThis.__RDSH_MOBILE_UX_RUNNING__ instanceof Set
        && globalThis.__RDSH_MOBILE_UX_RUNNING__.has(id);
      crumb.toggleAttribute("data-rdsh-header-running", running);
    }

    function decorateSessionTitleTyping() {
      if (!narrow()) return;
      const running = globalThis.__RDSH_MOBILE_UX_RUNNING__ instanceof Set
        ? globalThis.__RDSH_MOBILE_UX_RUNNING__
        : new Set();
      const targets = [];
      const crumb = document.querySelector('[data-rdsh-crumbs] [class*="_crumbCurrent"]');
      const header = document.querySelector("[data-conversation-session]");
      const headerId = header === null ? "" : (header.getAttribute("data-conversation-session") || "");
      if (crumb !== null && headerId !== "") targets.push({ key: `head:${headerId}`, id: headerId, element: crumb, running: running.has(headerId) });
      for (const title of document.querySelectorAll("[data-rdsh-session-title]")) {
        const row = title.closest('[data-row-key^="session:"]');
        if (row === null) continue;
        const key = row.getAttribute("data-row-key") || "";
        const id = key.startsWith("session:") ? key.slice("session:".length) : key;
        targets.push({ key: `row:${key}`, id, element: title, running: row.hasAttribute("data-rdsh-running") });
      }
      watchTitleText(targets.map((entry) => entry.element));
      const now = Date.now();
      for (const { key, id, element, running: working } of targets) {
        if (element.hasAttribute("data-rdsh-typing")) {
          const active = titleAnimations.get(key);
          if (active === undefined) element.removeAttribute("data-rdsh-typing");
          else if (element.querySelector("[data-rdsh-typing-layer]") === null) active.reattach();
        }
        if (working) titleWorkingAt.set(key, now);
        // Read React's text, not the layer, so a name landing mid-animation is
        // still seen as a change: the label the model replaces arrives while the
        // fallback is usually still being typed.
        const text = sessionTitleText(element);
        const previous = titleSeen.get(key);
        if (text !== "") titleSeen.set(key, text);
        else if (previous === undefined) titleSeen.set(key, "");
        if (text === "") continue;
        // First sight is the baseline: a page reload must not retype history.
        if (previous === undefined || previous === text) continue;
        const passes = titlePasses.get(key) ?? 0;
        if (passes >= TITLE_PASSES) continue;
        // An unnamed session shows the working directory or its raw id in the
        // header, so "untitled" alone misses the case this animation is for.
        // A name is generated while the session works (or right after), and a
        // manual rename later does not qualify.
        const generated = working
          || untitled(previous)
          || previous === id
          || now - (titleWorkingAt.get(key) ?? 0) < NAME_GRACE_MS;
        // The first pass is the initial label. The second is the name the model
        // settles on, which arrives on its own schedule, so it is allowed
        // without the running window and erases the label first.
        if (passes === 0 && !generated) continue;
        titlePasses.set(key, passes + 1);
        // Why the running animation is cancelled rather than awaited: waiting
        // would reveal the new name the moment the layer is removed, and only
        // then start erasing it — a pop followed by a pointless animation.
        const active = titleAnimations.get(key);
        const eraseFrom = active === undefined ? (passes === 0 ? "" : previous) : active.visible();
        active?.cancel();
        const controller = animateSessionTitle(element, text, eraseFrom);
        if (controller === null) titleAnimations.delete(key);
        else titleAnimations.set(key, controller);
      }
    }

    /** Upward travel that counts as "flick the banner away". */
    const TOAST_SWIPE_PX = 32;

    /**
     * Let a notice be swiped up, the way an iOS banner is dismissed.
     *
     * The component owns its own lifetime and renders through a portal, so the
     * gesture only moves the element out of sight; its timer retires it as
     * usual. Nothing here touches React's tree.
     */
    function decorateToasts() {
      if (!narrow()) return;
      for (const toast of document.querySelectorAll('body > [role="alert"]')) {
        if (toast.hasAttribute("data-rdsh-toast")) continue;
        toast.setAttribute("data-rdsh-toast", "");
        let startX = 0;
        let startY = 0;
        let offset = 0;
        let tracking = false;
        const release = () => {
          tracking = false;
          offset = 0;
          toast.style.removeProperty("transform");
          toast.style.removeProperty("opacity");
        };
        toast.addEventListener("pointerdown", (event) => {
          if (event.pointerType === "mouse") return;
          tracking = true;
          startX = event.clientX;
          startY = event.clientY;
          offset = 0;
        });
        toast.addEventListener("pointermove", (event) => {
          if (!tracking) return;
          const dy = event.clientY - startY;
          const dx = Math.abs(event.clientX - startX);
          // Upwards only, and only while the gesture is clearly vertical.
          if (dy > 0 || Math.abs(dy) < dx) {
            offset = 0;
            return;
          }
          offset = dy;
          toast.style.transform = `translate(-50%, ${Math.round(dy)}px)`;
          toast.style.opacity = String(Math.max(0.15, 1 + dy / 140));
        });
        const finish = () => {
          if (!tracking) return;
          if (offset <= -TOAST_SWIPE_PX) {
            toast.setAttribute("data-rdsh-toast-dismissed", "");
            tracking = false;
            return;
          }
          release();
        };
        toast.addEventListener("pointerup", finish);
        toast.addEventListener("pointercancel", finish);
      }
    }

    function decorateQuestionCards() {
      for (const card of document.querySelectorAll('[class*="_card"]')) {
        if (card.querySelector('[class*="_options"], [class*="_strip"]') === null) continue;
        card.setAttribute("data-rdsh-question-card", "");
        const frame = card.closest('[class*="_frame"]');
        if (frame !== null) frame.setAttribute("data-rdsh-question-frame", "");
      }
    }

    /**
     * Make sure the viewport is edge-to-edge, without taking anything away.
     *
     * This used to replace the tag with a fixed string, which dropped the
     * host's `interactive-widget=resizes-content` (so the composer stopped
     * riding above the keyboard) and banned pinch zoom, which is a WCAG 1.4.4
     * problem. Now the tag is read, missing parts are added, and nothing is
     * removed or overridden.
     */
    function enforceNoZoomViewport() {
      let meta = document.querySelector('meta[name="viewport"]');
      if (meta === null) {
        meta = document.createElement("meta");
        meta.setAttribute("name", "viewport");
        document.head.append(meta);
      }
      const current = meta.getAttribute("content") ?? "";
      // Parse the comma-separated directives; a key we do not set is left as
      // the host wrote it.
      const parts = current.split(",").map((part) => part.trim()).filter((part) => part !== "");
      const has = (key) => parts.some((part) => part.split("=")[0].trim().toLowerCase() === key);
      const wanted = [];
      if (!has("width")) wanted.push("width=device-width");
      if (!has("initial-scale")) wanted.push("initial-scale=1");
      if (!has("viewport-fit")) wanted.push("viewport-fit=cover");
      if (wanted.length === 0) return;
      const next = [...parts, ...wanted].join(", ");
      if (next !== current) meta.setAttribute("content", next);
    }

    const ACTIVITY_ICONS = {
      shell: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.7" y="2.7" width="12.6" height="10.6" rx="2"/><path d="M4.4 6.2l2.3 1.8-2.3 1.8"/><path d="M8.4 10.2h3.3"/></svg>',
      subagent: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="4.6" r="2.1"/><path d="M3.6 13.4c0-2.6 2-4.4 4.4-4.4s4.4 1.8 4.4 4.4"/><path d="M11.6 3.2a2.2 2.2 0 0 1 0 3.9"/></svg>',
    };

    /** Header shell/subagent chips become icon-only live indicators. */
    function decorateHeaderActivityChips() {
      if (!narrow()) return;
      const buttons = [...document.querySelectorAll("header button[aria-label]")]
        .filter((button) => /subagents?|background jobs?|shell command/i.test(button.getAttribute("aria-label") || ""));
      if (buttons.length === 0) return;
      const runningSubagents = Number(document.documentElement.getAttribute("data-rdsh-running-subagents") || "0") || 0;
      const sourceSpinner = [...document.querySelectorAll("header [class*='_spinner_']")]
        .find((spinner) => !spinner.hasAttribute("data-rdsh-activity-generated")) ?? null;
      for (const button of buttons) {
        const label = button.getAttribute("aria-label") || "";
        const kind = /subagent/i.test(label) ? "subagent" : "shell";
        button.setAttribute("data-rdsh-activity-chip", kind);
        const ownNative = [...button.querySelectorAll("svg[class*='_spinner_']")]
          .find((spinner) => !spinner.hasAttribute("data-rdsh-activity-generated")) ?? null;
        const active = kind === "subagent" ? runningSubagents > 0 : ownNative !== null;
        let spinner = button.querySelector("[data-rdsh-activity-spinner]");
        if (!active) {
          if (spinner !== null && spinner.hasAttribute("data-rdsh-activity-generated")) spinner.remove();
          spinner = null;
        }
        if (active && spinner === null) {
          if (ownNative !== null) {
            spinner = ownNative;
          } else if (sourceSpinner !== null && !button.contains(sourceSpinner)) {
            spinner = sourceSpinner.cloneNode(true);
            spinner.classList.remove("QsffPG_triggerDot");
            spinner.setAttribute("data-rdsh-activity-generated", "");
          } else {
            spinner = document.createElement("span");
            spinner.className = "rdsh-activity-ring";
            spinner.setAttribute("data-rdsh-activity-generated", "");
          }
          spinner.setAttribute("data-rdsh-activity-spinner", "");
          button.prepend(spinner);
        }
        if (button.querySelector("[data-rdsh-activity-icon]") === null) {
          const icon = document.createElement("span");
          icon.setAttribute("data-rdsh-activity-icon", "");
          icon.setAttribute("aria-hidden", "true");
          icon.innerHTML = ACTIVITY_ICONS[kind];
          button.append(icon);
        }
      }
      // The first chip can be decorated before the other chip has rendered its
      // native spinner. Upgrade our fallback once the native one exists.
      const native = document.querySelector("header svg[class*='_spinner_']:not([data-rdsh-activity-generated])");
      if (native !== null) {
        for (const fallback of document.querySelectorAll("header [data-rdsh-activity-spinner].rdsh-activity-ring")) {
          const replacement = native.cloneNode(true);
          replacement.classList.remove("QsffPG_triggerDot");
          replacement.setAttribute("data-rdsh-activity-spinner", "");
          replacement.setAttribute("data-rdsh-activity-generated", "");
          fallback.replaceWith(replacement);
        }
      }
    }

    /** Add a Settings row to the sidebar panel list, matching Plugins. */
    function openSettingsViaAccountMenu() {
      const trigger = document.querySelector(ariaLabelSelector("button", "accountMenu", "Account menu"));
      if (trigger === null) return;
      settingsPendingUntil = Date.now() + 2000;
      trigger.click();
      setTimeout(maybeOpenSettings, 30);
      setTimeout(maybeOpenSettings, 120);
      setTimeout(maybeOpenSettings, 300);
    }

    function decorateSidebarSettingsRow() {
      // #17: the replacement row belongs to the phone drawer. In a narrow
      // desktop window the stock account row is still reachable, and swapping
      // it there only loses the stock menu.
      if (!phone()) {
        // A resize out of the phone layout must undo the swap, or the tagged
        // account row stays hidden by the phone stylesheet (its rule is inside
        // the width query) and Settings becomes unreachable.
        for (const tagged of document.querySelectorAll("[data-rdsh-more-row]")) tagged.removeAttribute("data-rdsh-more-row");
        for (const injected of document.querySelectorAll("[data-rdsh-settings-row]")) injected.remove();
        return;
      }
      const nav = document.querySelector("nav.hHd-Xa_panelList");
      if (nav === null) return;
      // The account "More" row is not used on the phone.
      const account = document.querySelector(ariaLabelSelector("button", "accountMenu", "Account menu"))
        ?? [...document.querySelectorAll("button")].find((button) => button.innerText.trim() === "More");
      if (account !== null) {
        const moreRow = account.closest('[class*="yHnPSG_anchor"]') ?? account.parentElement;
        moreRow?.setAttribute("data-rdsh-more-row", "");
      }
      const auto = nav.querySelector('button[aria-label="Automation tasks"]');
      let row = nav.querySelector("[data-rdsh-settings-row]");
      if (row === null) {
        row = document.createElement("button");
        row.type = "button";
        row.className = "hHd-Xa_panelRow";
        row.setAttribute("aria-label", t("mux.settingsRow"));
        row.setAttribute("data-rdsh-settings-row", "");
        row.innerHTML = `<span class="hHd-Xa_panelGlyph" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="2.1"/><path d="M6.9 1.9h2.2l.35 1.5 1.28.74 1.45-.5 1.1 1.9-1.05 1.1.1 1.48 1.05 1.1-1.1 1.9-1.45-.5-1.28.74-.35 1.5H6.9l-.35-1.5-1.28-.74-1.45.5-1.1-1.9 1.05-1.1-.1-1.48-1.05-1.1 1.1-1.9 1.45.5 1.28-.74z"/></svg></span><span class="hHd-Xa_panelTitle hHd-Xa_wide">${t("mux.settingsRow")}</span>`;
        row.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          openSettingsViaAccountMenu();
        });
      }
      const anchor = auto ?? nav.querySelector('button[aria-label="Plugins"]');
      // Two exclusive branches. Written as one `if` with a trailing `else if`,
      // the second branch also ran when the row was already directly after the
      // anchor but not last, so `after()` and `append()` moved the row on every
      // pass: the mutation woke this very observer and the row oscillated once
      // per frame. Only the branch that applies may move it.
      if (anchor !== null) {
        if (anchor.nextElementSibling !== row) anchor.after(row);
      } else if (nav.lastElementChild !== row) {
        nav.append(row);
      }
    }

    const ADD_LABEL = t("add.label");
    const ADD_STOCK_LABEL = t("add.stock");
    const ADD_SELECTOR = `[data-rdsh-add], [aria-label="${ADD_LABEL}"], [aria-label="${ADD_STOCK_LABEL}"]`;

    function addButton() {
      // Structure first: the composer's only listbox trigger is the "+" button.
      // Labels are localised, so they are only the fallback.
      const composer = document.querySelector("[data-composer-input]");
      const card = composer === null ? null : composer.closest('[class*="_card"]');
      const structural = card === null ? null : card.querySelector('button[aria-haspopup="listbox"]');
      return structural || document.querySelector(ADD_SELECTOR);
    }

    function addButtonOf(target) {
      if (target === null || target === undefined || target.closest === undefined) return null;
      const button = target.closest("button");
      return button !== null && button === addButton() ? button : null;
    }

    function decorateComposer() {
      for (const model of document.querySelectorAll('button[aria-label^="Select model"]')) {
        model.setAttribute("data-rdsh-model-button", "");
      }
      const add = addButton();
      if (add === null) {
        document.documentElement.removeAttribute("data-rdsh-has-dock");
        return;
      }
      add.setAttribute("data-rdsh-add", "");
      // #17: the short "attach only" label and the picker hijack below are a
      // phone affordance. A narrow desktop window keeps the stock label and
      // the stock command list behind "+".
      if (phone()) {
        if (add.getAttribute("aria-label") !== ADD_LABEL) add.setAttribute("aria-label", ADD_LABEL);
      } else if (add.getAttribute("aria-label") === ADD_LABEL) {
        add.setAttribute("aria-label", ADD_STOCK_LABEL);
      }
      const card = add.closest('[class*="_card"]');
      if (card === null || card.parentElement === null) {
        document.documentElement.removeAttribute("data-rdsh-has-dock");
        return;
      }
      card.parentElement.setAttribute("data-rdsh-composer-root", "");
      // The stats dock (turns / tok/s / cache hit / context %) is essential.
      // On a phone it moves out of the layout so the composer can sit as low
      // as possible, and fills the safe-area strip below the card instead of
      // leaving a blank band there.
      let hasDock = false;
      for (const sibling of card.parentElement.children) {
        if (sibling === card) continue;
        const stats = sibling.querySelector(ariaContainsSelector("button", "stats", ["tok", "turns", "context"]));
        if (stats !== null) {
          sibling.setAttribute("data-rdsh-composer-dock", "");
          hasDock = true;
        } else {
          sibling.removeAttribute("data-rdsh-composer-dock");
        }
      }
      document.documentElement.toggleAttribute("data-rdsh-has-dock", hasDock);
    }

    function markScrollers() {
      if (!narrow()) return;
      for (const element of document.querySelectorAll("[data-rdsh-frame] div")) {
        if (element.hasAttribute("data-rdsh-scroll")) continue;
        if (element.scrollHeight <= element.clientHeight + 4) continue;
        const overflow = getComputedStyle(element).overflowY;
        if (overflow !== "auto" && overflow !== "scroll") continue;
        element.setAttribute("data-rdsh-scroll", "");
      }
    }

    let lastSlowAt = 0;

    function decorateFast() {
      const root = frame();
      if (root !== null) {
        root.setAttribute("data-rdsh-frame", "");
        // The app switches these columns to auto-placement while its sidebar is
        // open. Our drawer takes that column out of flow, so auto-placement
        // shifts everything one column left: the chat lands on the 0px column
        // and the empty right column fills the screen. Pin them instead.
        for (const child of root.children) {
          const cls = typeof child.className === "string" ? child.className : "";
          if (cls.includes("_centerCol")) child.setAttribute("data-rdsh-center-col", "");
          else if (cls.includes("_rightbarCol")) child.setAttribute("data-rdsh-rightbar-col", "");
        }
        const sidebar = document.querySelector('[data-slot="sidebar"]');
        if (sidebar && sidebar.parentElement) sidebar.parentElement.setAttribute("data-rdsh-sidebar", "");
        const open = !root.hasAttribute("data-sidebar-collapsed");
        if (open !== state.drawerOpen) emit({ drawerOpen: open });
        document.documentElement.setAttribute("data-rdsh-drawer", open ? "open" : "closed");
      }
      const header = document.querySelector("header[data-window-drag]");
      if (header !== null) header.setAttribute("data-rdsh-header", "");
      // Decorate the image lightbox on the same mutation that creates it. The
      // slow pass is throttled (900ms), which can leave a freshly opened
      // lightbox without the crop/safe-area hooks.
      decorateLightbox();
      decorateRightPanel();
      decorateRightPanelTabs();
      decorateCodePreview();
      decorateQuestionCards();
      decorateTodoPanel();
      decorateGoalBar();
      decorateHeaderTitle();
      decorateSessionTitleTyping();
      decorateToasts();
      decorateModelSearch();
      installSettingsNavArrows();
      decorateStatsDock();
      enforceNoZoomViewport();
      const crumbs = document.querySelector('nav[aria-label="Session hierarchy"]');
      if (crumbs !== null) crumbs.setAttribute("data-rdsh-crumbs", "");
      for (const slot of document.querySelectorAll('[data-slot="main.conversation"], [data-slot="conversation"]')) {
        slot.setAttribute("data-rdsh-conversation", "");
      }
      // Session-row hooks are phone-only (their styling lives inside the phone
      // query). Leaving them on a wide layout would also leave the attributes
      // behind for the next narrow pass to mistake for its own.
      if (narrow()) decorateSessionRows();
      else if (rowHooksActive) clearSessionRowHooks();
      decorateComposer();
      decorateHeaderActivityChips();
      decorateSidebarSettingsRow();
      // The right panel keeps its chrome mounted even while closed (it is
      // clipped by a zero-width column), so presence of its buttons says
      // nothing. The dock strip is the real signal: it sits on-screen only
      // while the panel is open.
      const hideListDisabled = hideDisabled();
      // #17: the attribute that hides upstream settings rows follows the
      // device, not the window width. Its CSS therefore lives outside the
      // phone media block (see the stylesheet).
      const onPhone = phone();
      if (onPhone !== state.phone) emit({ phone: onPhone });
      document.documentElement.toggleAttribute("data-rdsh-hide-settings", !hideListDisabled && onPhone);
      applyHideList(hideListDisabled);
      maybeOpenSettings();
    }

    /**
     * Work that is too expensive for every mutation (style reads over the whole
     * transcript): keep it to about once a second.
     */
    function decorateTranscript() {
      const scroller = document.querySelector('[class*="scrollBody"]');
      if (scroller === null) return;
      for (const node of scroller.querySelectorAll('[class*="_scroll"], [class*="_column"]')) {
        // A node this plugin already tagged stays tagged: the tag is what sets
        // the 16px gutters, so the "24px or more" heuristic below can never
        // hold again. Re-checking it dropped the column on every re-mount
        // (session switch, panel change) and the width reverted to 100%.
        const tagged = node.hasAttribute("data-rdsh-transcript");
        if (!tagged) {
          const style = getComputedStyle(node);
          const left = parseFloat(style.paddingLeft) || 0;
          const right = parseFloat(style.paddingRight) || 0;
          if (!(left >= 24 && right >= 24 && node.getBoundingClientRect().width >= scroller.clientWidth * 0.8)) continue;
          node.setAttribute("data-rdsh-transcript", "");
        }
        const column = node.querySelector('[class*="_column"]');
        if (column !== null) column.setAttribute("data-rdsh-transcript-column", "");
        return;
      }
    }

    function decorateUserBubbles() {
      for (const item of document.querySelectorAll('[data-chat-flow-kind="user"]')) {
        const stack = item.querySelector('[class*="userStack"]');
        if (stack !== null) stack.setAttribute("data-rdsh-user-stack", "");
        const bubble = item.querySelector('[class*="_bubble"]');
        if (bubble !== null) bubble.setAttribute("data-rdsh-user-bubble", "");
      }
    }

    function decorateSlow() {
      decorateEditCards();
      decorateRightPanel();
      decorateTranscript();
      decorateUserBubbles();
      markScrollers();
    }

    function decorate() {
      decorateFast();
      const now = Date.now();
      if (now - lastSlowAt > 900) {
        lastSlowAt = now;
        decorateSlow();
      }
    }

    let scheduled = false;
    function scheduleDecorate() {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        try {
          decorate();
        } catch (error) {
          console.error("[rdsh-mobile-ux] decorate failed", error);
        }
      });
    }

    // ---------------------------------------------------------------------
    // Drawer: floating button, backdrop, animation
    // ---------------------------------------------------------------------
    let fab = null;
    let backdrop = null;

    function toggleDrawer() {
      const button = document.querySelector('[aria-label="Open sidebar"], [aria-label="Collapse sidebar"]');
      if (button !== null) button.click();
    }

    function closeDrawer() {
      const frameElement = frame();
      if (frameElement !== null && !frameElement.hasAttribute("data-sidebar-collapsed")) {
        const collapse = document.querySelector('[aria-label="Collapse sidebar"]');
        if (collapse !== null) collapse.click();
      }
    }

    let currentSessionId = null;

    /**
     * Tell the push host that the next turn belongs to this device.
     *
     * A phone send is marked automatically. On a desktop that is the #15
     * opt-in: without it the host's `onlyMobileTurns` default means a PC send
     * is never notified, and a narrow window silently changing that would be
     * the same width-based behaviour #17 removes.
     */
    function markMobileSession() {
      if (currentSessionId === null) return;
      if (!phone() && !notifyDeviceTurns()) return;
      void fetch(`${PUSH_API}/mobile-send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: currentSessionId }),
        keepalive: true,
      }).catch(() => {});
    }

    let notificationTotal = 0;

    function applyNotificationCount(count) {
      notificationTotal = Math.max(0, Math.floor(Number(count) || 0));
      if (fab === null) return;
      const badge = fab.querySelector(".rdsh-mux-fab-badge");
      if (badge !== null) {
        badge.textContent = notificationTotal === 0 ? "" : notificationTotal > 99 ? "99+" : String(notificationTotal);
        badge.toggleAttribute("data-visible", notificationTotal > 0);
      }
      fab.setAttribute("aria-label", notificationTotal > 0
        ? t("mux.fab.openWithCount", { count: notificationTotal })
        : t("mux.fab.open"));
    }

    function countSessionStatuses(statuses, mainIds) {
      if (statuses === null || statuses === undefined || typeof statuses.entries !== "function") return 0;
      let count = 0;
      for (const [sessionId, status] of statuses.entries()) {
        if (mainIds !== null && !mainIds.has(sessionId)) continue;
        const kind = status?.pendingInteraction?.kind;
        const waiting = kind === "question" || kind === "approval" || kind === "plan-review";
        if (status?.completionUnread === true || waiting) count += 1;
      }
      return count;
    }

    function NotificationWatcher(props) {
      const useSessionStatus = props.useSessionStatus;
      const useSessions = props.useSessions;
      const hasHook = typeof useSessionStatus === "function";
      const hasSessions = typeof useSessions === "function";
      const statuses = hasHook ? useSessionStatus((value) => value) : null;
      const sessions = hasSessions ? useSessions((value) => value) : null;
      useEffect(() => {
        const byId = sessions !== null && sessions !== undefined ? sessions.byId : null;
        const mainIds = byId !== null && byId !== undefined && typeof byId === "object"
          ? new Set(Object.entries(byId).filter(([, row]) => row !== null && row !== undefined && row.origin !== "subagent").map(([id]) => id))
          : null;
        const total = countSessionStatuses(statuses, null);
        const main = countSessionStatuses(statuses, mainIds);
        applyNotificationCount(main);
        // How many subagent sessions are actually running right now. The header
        // subagent chip also exists for finished subagents, so its icon must
        // not spin unless this is above zero.
        let runningSubagents = 0;
        const runningIds = new Set();
        if (byId !== null && byId !== undefined && typeof byId === "object" && statuses !== null && statuses !== undefined && typeof statuses.get === "function") {
          for (const [id, row] of Object.entries(byId)) {
            if (row === null || row === undefined || statuses.get(id)?.running !== true) continue;
            runningIds.add(id);
            if (row.origin === "subagent") runningSubagents += 1;
          }
        }
        globalThis.__RDSH_MOBILE_UX_RUNNING__ = runningIds;
        document.documentElement.setAttribute("data-rdsh-running-subagents", String(runningSubagents));
        document.documentElement.toggleAttribute("data-rdsh-badge-hook", hasHook);
        document.documentElement.toggleAttribute("data-rdsh-sessions-hook", hasSessions);
        globalThis.__RDSH_MOBILE_UX_BADGE__ = { total, main, subagents: Math.max(0, total - main), runningSubagents, mainIds: mainIds === null ? null : [...mainIds] };
        scheduleDecorate();
      }, [statuses, sessions, hasHook, hasSessions]);
      return null;
    }

    function installDrawer() {
      fab = document.createElement("button");
      fab.type = "button";
      fab.className = "rdsh-mux-fab";
      fab.setAttribute("aria-label", t("mux.fab.open"));
      fab.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 6.5h16M4 12h16M4 17.5h16"/></svg><span class="rdsh-mux-fab-badge" aria-hidden="true"></span>';
      fab.addEventListener("click", toggleDrawer);

      backdrop = document.createElement("div");
      backdrop.className = "rdsh-mux-backdrop";
      backdrop.setAttribute("aria-hidden", "true");
      backdrop.addEventListener("click", closeDrawer);

      document.body.append(backdrop, fab);
    }

    let toastTimer = 0;

    function mobileToast(text) {
      let toast = document.querySelector(".rdsh-mux-toast");
      if (toast === null) {
        toast = document.createElement("div");
        toast.className = "rdsh-mux-toast";
        toast.setAttribute("role", "status");
        document.body.append(toast);
      }
      toast.textContent = text;
      toast.setAttribute("data-show", "");
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toast.remove(), 2800);
    }

    function pickFiles(kind) {
      const add = addButton();
      const card = add === null ? null : add.closest('[class*="_card"]');
      const input = (card === null ? null : card.querySelector('input[type="file"]'))
        || document.querySelector('input[type="file"]');
      if (input === null || input.disabled) {
        mobileToast(t("mux.toast.noFileInput"));
        return;
      }
      // iOS reads accept when the picker opens, so set it for this one gesture
      // and put the input back afterwards.
      const previous = input.getAttribute("accept");
      input.setAttribute("accept", kind === "image" ? "image/*" : "");
      let restored = false;
      const restore = () => {
        if (restored) return;
        restored = true;
        window.removeEventListener("focus", restore);
        if (previous === null) input.removeAttribute("accept");
        else input.setAttribute("accept", previous);
      };
      input.addEventListener("change", restore, { once: true });
      // The picker returns focus when it closes, including on cancel.
      window.addEventListener("focus", restore);
      setTimeout(restore, 60000);
      input.value = "";
      input.click();
    }

    /** The composer focuses the editor on mousedown; that opens the keyboard. */
    function onMouseDownCapture(event) {
      // Paired with the "+" hijack below: on a desktop the stock mousedown must
      // reach the composer's own menu (#17).
      if (!phone()) return;
      if (addButtonOf(event.target) === null) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }

    // ---------------------------------------------------------------------
    // Session rows: tap opens, long press drags
    // ---------------------------------------------------------------------
    let tapCandidate = null;
    /** The right panel tab under the finger, for the same replay as a row. */
    let tabCandidate = null;
    let tabReplayTimer = 0;
    /** The row whose long press opened its menu, so the release click is eaten. */
    let menuOpenedUntil = 0;
    /** Long-press: held still this long and it opens the row menu. */
    const LONG_PRESS_MS = 480;
    /** Movement past this many pixels turns the gesture into a drag instead. */
    const LONG_PRESS_SLOP_PX = 12;

    /**
     * The row's own "..." trigger.
     *
     * Structure first: upstream class names are hashed, but the actions
     * container is the only one holding buttons inside a session row.
     */
    function sessionMenuButton(row) {
      const scoped = row.querySelector('[class*="_rowActions"] button');
      if (scoped !== null) return scoped;
      return [...row.querySelectorAll("button")].find((button) => ACTIONS_PROBE.test(button.getAttribute("aria-label") || "")) ?? null;
    }

    function cancelLongPress() {
      if (longPressTimer !== 0) {
        clearTimeout(longPressTimer);
        longPressTimer = 0;
      }
    }

    function fireLongPress() {
      const candidate = tapCandidate;
      longPressTimer = 0;
      if (candidate === null || candidate.cancelled || candidate.fired) return;
      const button = sessionMenuButton(candidate.row);
      if (button === null) return;
      candidate.fired = true;
      candidate.cancelled = true;
      // A row that is neither selected nor hovered hides its actions, so the
      // trigger measures 0x0 and the menu portal opens at the top-left corner.
      // Reveal it for the click and keep it measurable while React positions
      // the portal; the app's own menu-open class takes over from there.
      // A long press must not leave the system's own affordances behind: iOS can
      // have started a selection and its callout before the timer fired.
      try {
        globalThis.getSelection?.()?.removeAllRanges();
      } catch { /* selection API unavailable */ }
      candidate.row.setAttribute("data-rdsh-row-menu", "");
      setTimeout(() => candidate.row.removeAttribute("data-rdsh-row-menu"), 1500);
      // Open the menu first: the arm window below also swallows clicks, and
      // arming it before this click would eat the very click that opens it.
      button.click();
      // The release still synthesises a click on the row, which would open the
      // session on top of the menu. Generous because a held finger can stay
      // down, and one-shot so the next real tap is unaffected.
      menuOpenedUntil = Date.now() + 4000;
    }

    let longPressTimer = 0;

    /** A row click that lands on a control inside the row is that control's. */
    function controlInsideRow(target) {
      const control = target.closest && target.closest("button, [role='button'], [role='menuitem'], input, textarea");
      return control !== null && control !== undefined && control.closest('[data-row-key^="session:"]') !== null;
    }

    function onPointerDown(event) {
      if (!narrow()) return;
      // xterm keeps its real input in a visually hidden textarea. Focusing it
      // from the tap/pointerdown gesture is what asks iOS for the keyboard.
      const terminal = event.target.closest && event.target.closest(".xterm, [class*='xterm']");
      if (terminal !== null) {
        const input = terminal.querySelector("textarea.xterm-helper-textarea, textarea");
        if (input !== null) input.focus({ preventScroll: true });
      }
      const send = event.target.closest && event.target.closest('[data-rdsh-composer-root] [class*="primary"]');
      if (send !== null && send !== undefined && send.disabled !== true && !STOP_PROBE.test(send.getAttribute("aria-label") || "")) {
        markMobileSession();
      }
      // Right panel tabs: same native-drag problem as the session rows below.
      // Upstream starts a tab drag after 4px, so a finger that moves slightly
      // never produces the click that switches tabs.
      const tab = event.target.closest && event.target.closest("[data-rdsh-rtab]");
      if (tab !== null && tab !== undefined && event.pointerType !== "mouse") {
        clearTimeout(tabReplayTimer);
        tabCandidate = { tab, at: Date.now(), x: event.clientX, y: event.clientY, fired: false };
      }
      const row = event.target.closest && event.target.closest('[data-row-key^="session:"]');
      if (row === null || row === undefined) return;
      if (event.pointerType === "mouse") return;
      if (controlInsideRow(event.target)) return;
      tapCandidate = { row, at: Date.now(), x: event.clientX, y: event.clientY, cancelled: false, fired: false };
      // A held finger opens the menu; a moving one reorders, which is the
      // gesture the app already owns.
      cancelLongPress();
      longPressTimer = setTimeout(fireLongPress, LONG_PRESS_MS);
    }

    /** Movement cancels the long press and leaves the drag to the app. */
    function onPointerMove(event) {
      const candidate = tapCandidate;
      if (candidate === null || longPressTimer === 0) return;
      if (Math.abs(event.clientX - candidate.x) + Math.abs(event.clientY - candidate.y) > LONG_PRESS_SLOP_PX) cancelLongPress();
    }

    function onPointerUp(event) {
      cancelLongPress();
      const tabTap = tabCandidate;
      if (tabTap !== null) {
        const moved = Math.abs(event.clientX - tabTap.x) + Math.abs(event.clientY - tabTap.y) > 14;
        if (moved || Date.now() - tabTap.at > 600) {
          tabCandidate = null;
        } else {
          // One replay, only if the app did not deliver the click itself: a
          // pointerdown that became a tab drag leaves the active tab unchanged
          // and the tap would otherwise do nothing at all.
          clearTimeout(tabReplayTimer);
          tabReplayTimer = window.setTimeout(() => {
            if (tabCandidate === tabTap) tabCandidate = null;
            if (tabTap.fired || !tabTap.tab.isConnected) return;
            tabTap.fired = true;
            tabTap.tab.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
          }, 250);
        }
      }
      const candidate = tapCandidate;
      if (candidate === null) return;
      tapCandidate = null;
      const moved = Math.abs(event.clientX - candidate.x) + Math.abs(event.clientY - candidate.y) > 14;
      if (candidate.cancelled || moved || Date.now() - candidate.at > 500) return;
      // Chrome can spend a touch on a native drag attempt and never synthesise
      // the click. If no click landed shortly after the finger lifted, replay
      // exactly one on the row so a short tap always opens the session.
      setTimeout(() => {
        if (candidate.fired) return;
        candidate.row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      }, 260);
    }

    function onDragStartCapture(event) {
      cancelLongPress();
      if (tapCandidate !== null) tapCandidate.cancelled = true;
      const row = event.target.closest && event.target.closest('[data-row-key^="session:"]');
      if (row !== null && row !== undefined) row.setAttribute("data-rdsh-dragging", "");
    }

    function onDragEndCapture(event) {
      const row = event.target.closest && event.target.closest('[data-row-key^="session:"]');
      if (row !== null && row !== undefined) row.removeAttribute("data-rdsh-dragging");
    }

    /** Mobile long-press must only reorder; the app's dblclick rename is off. */
    function onSessionTitleDoubleClick(event) {
      if (!narrow()) return;
      if (event.target.closest === undefined || event.target.closest("[data-rdsh-session-title]") === null) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }

    /** Suppress the iOS text callout/context menu on the session title. */
    function onSessionContextMenu(event) {
      if (!narrow()) return;
      if (event.target.closest === undefined) return;
      if (event.target.closest("[data-rdsh-session-title], [data-rdsh-session]") === null) return;
      event.preventDefault();
    }

    /**
     * Nearest horizontally scrolled ancestor, or null.
     *
     * A rightward swipe that starts on content already scrolled to the right
     * belongs to that content, not to the sheet's close gesture.
     */
    function scrolledLeftAncestor(target) {
      let node = target;
      while (node !== null && node !== undefined && node !== document.body) {
        if (node.nodeType === 1) {
          const style = getComputedStyle(node);
          if ((style.overflowX === "auto" || style.overflowX === "scroll") && node.scrollLeft > 1) return node;
        }
        node = node.parentElement;
      }
      return null;
    }

    // Edge swipe from the left opens the session drawer; from the right it
    // pulls the preview/right sidebar (the app's own "Open right sidebar").
    // While the preview is open the left-to-right gesture closes it instead.
    let edgeSwipe = null;
    function onEdgeSwipeStart(event) {
      if (!narrow() || event.touches.length !== 1) return;
      if (document.querySelector("[data-rdsh-lightbox], [data-rdsh-crop-overlay], [data-shortcut-modal=settings]") !== null) return;
      const touch = event.touches[0];
      const target = event.target;
      const fromRight = touch.clientX >= window.innerWidth - 36;
      const drawerOpen = document.documentElement.getAttribute("data-rdsh-drawer") === "open";
      const panelOpen = document.documentElement.hasAttribute("data-rdsh-rightpanel-open");
      // While the preview is open, a rightward swipe anywhere on it goes back
      // to the chat, the way a pushed iOS screen does. This is checked before
      // the edge rules below, which would otherwise return first. The left
      // 36px stays the drawer's: a swipe from there is the open-the-session-
      // list gesture, and letting the preview eat it made the drawer
      // unreachable whenever the preview happened to be open.
      if (panelOpen && !drawerOpen && touch.clientX > 36) {
        if (target instanceof Element) {
          if (scrolledLeftAncestor(target) !== null) return;
          if (target.closest("input, textarea, [contenteditable=true], .xterm, [class*='xterm']") !== null) return;
        }
        edgeSwipe = { x: touch.clientX, y: touch.clientY, fromRight: false, closesPanel: true };
        return;
      }
      if (fromRight) {
        // The drawer owns the screen while it is open: a swipe inside it must
        // not pull the preview over the session list.
        if (drawerOpen) return;
      } else {
        // ...and the left edge only opens the session list when nothing else
        // has the screen.
        if (drawerOpen) return;
        if (touch.clientX > 36) return;
      }
      if (target instanceof Element && target.closest("button, a, input, textarea, [role=button], [contenteditable=true]") !== null) return;
      edgeSwipe = { x: touch.clientX, y: touch.clientY, fromRight };
    }
    function onEdgeSwipeMove(event) {
      if (edgeSwipe === null || event.touches.length !== 1) return;
      // A rotation can end the phone layout in the middle of a gesture; the
      // stored start point then belongs to a layout that no longer exists.
      if (!narrow()) {
        edgeSwipe = null;
        return;
      }
      const touch = event.touches[0];
      const dx = touch.clientX - edgeSwipe.x;
      const dy = touch.clientY - edgeSwipe.y;
      if (edgeSwipe.closesPanel === true) {
        if (dx < 64 || Math.abs(dy) > Math.abs(dx)) return;
        edgeSwipe = null;
        if (event.cancelable) event.preventDefault();
        visibleCollapseButton()?.click();
        return;
      }
      if (edgeSwipe.fromRight) {
        if (dx > -64 || Math.abs(dy) > Math.abs(dx)) return;
        edgeSwipe = null;
        if (event.cancelable) event.preventDefault();
        document.querySelector('[aria-label="Open right sidebar"]')?.click();
        return;
      }
      if (dx < 64 || Math.abs(dy) > Math.abs(dx)) return;
      edgeSwipe = null;
      if (event.cancelable) event.preventDefault();
      toggleDrawer();
    }
    /**
     * Drop the in-flight gestures.
     *
     * A rotation (or the keyboard opening) can swallow the `touchend` that
     * would have cleared these, and a stale start point turns the next
     * touchmove into a jump-sized swipe: the drawer opens or the preview
     * closes without a gesture. Also called when the phone layout turns off,
     * so coordinates from the old layout cannot fire in the new one.
     */
    function resetGestures() {
      edgeSwipe = null;
      touchStart = null;
      terminalDrag = null;
      tapCandidate = null;
      tabCandidate = null;
      clearTimeout(tabReplayTimer);
      cancelLongPress();
    }
    function onEdgeSwipeEnd() {
      edgeSwipe = null;
      endTerminalDrag();
    }

    // ---------------------------------------------------------------------
    // Input: Enter inserts a newline unless the user opts into sending
    // ---------------------------------------------------------------------
    function composerEditor(target) {
      if (target === null || target === undefined || target.closest === undefined) return null;
      return target.closest('[contenteditable="true"], textarea');
    }

    /** A popup that owns Enter (slash commands, workspace picker, menus). */
    function openPopup() {
      for (const element of document.querySelectorAll('[role="listbox"], [role="menu"]')) {
        const rect = element.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return element;
      }
      return null;
    }

    /**
     * Insert one soft line break through the editor's own beforeinput path.
     * A synthetic Shift+Enter works on Chrome but not on iOS: the software
     * keyboard reports keyCode 229, so the app's keymap treats the synthetic
     * chord as an active composition and swallows it. `insertLineBreak` is
     * handled by Lexical as plain JS, independent of key trust or keyCode.
     */
    function insertLineBreak(editor) {
      if (editor.tagName === "TEXTAREA") {
        const start = editor.selectionStart ?? editor.value.length;
        const end = editor.selectionEnd ?? start;
        editor.setRangeText("\n", start, end, "end");
        editor.dispatchEvent(new Event("input", { bubbles: true }));
        return;
      }
      try {
        editor.dispatchEvent(new InputEvent("beforeinput", {
          inputType: "insertLineBreak",
          bubbles: true,
          cancelable: true,
        }));
      } catch {
        const event = new Event("beforeinput", { bubbles: true, cancelable: true });
        event.inputType = "insertLineBreak";
        editor.dispatchEvent(event);
      }
      // Do not insert a native <br> here as a "fallback": Lexical applies
      // beforeinput on the next update, so a synchronous execCommand inserts a
      // second break and desynchronises the editor state.
    }

    function onKeyDownCapture(event) {
      // `narrow()` would be wrong here: a narrow desktop window still has a
      // keyboard, and the stock composer sends on plain Enter. Only a finger
      // primary pointer gets the phone default (Enter = newline).
      const finger = coarsePointer();
      if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
      // Desktop stays out of the key path entirely unless the #15 opt-in is on.
      // When it is, the stock composer still owns the send; this only marks the
      // session so the host notifies this device.
      if (!finger && !notifyDeviceTurns()) return;
      const editor = composerEditor(event.target);
      if (editor === null) return;
      // Only the message composer. A rename field or another contenteditable
      // keeps its own Enter behaviour (commit, newline, …).
      if (editor.closest("[data-composer-input]") === null) return;
      // The app marks the root while an IME composition owns Return; that
      // Return belongs to the IME (confirm the conversion), not to us.
      if (editor.closest("[data-composer-composing]") !== null) return;
      // A selected command chip owns Enter (remove or expand it).
      if (editor.querySelector("[data-selected]") !== null) return;
      // While a menu is open, Enter selects its highlighted row.
      if (openPopup() !== null) return;
      if (!finger) {
        markMobileSession();
        return;
      }
      if (state.enterToSend) {
        markMobileSession();
        closeKeyboardAfterSend();
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      insertLineBreak(editor);
    }

    // ---------------------------------------------------------------------
    // Overscroll: no document rubber-band at the ends of a scroll container
    // ---------------------------------------------------------------------
    let touchStart = null;

    // ---------------------------------------------------------------------
    // Terminal: a finger drag becomes a wheel event
    //
    // The xterm.js that DSH 0.2.x bundles (6.0.0) has no touch path at all:
    // `.xterm-viewport` is empty, the screen lives in `.xterm-scrollable-element`
    // and a VS Code `SmoothScrollableElement` owns the scroll position in JS.
    // Its only input is `wheel` (xtermjs/xterm.js#5489; the fix, #5563, is
    // 6.1.0). So a touch drag has to be translated into wheel events rather
    // than into CSS: there is no DOM scroller to unlock.
    //
    // The constants come from `StandardWheelEvent` + the Scrollable it feeds:
    // a pixel-mode wheel delta is divided by 40 and then multiplied by 50, so
    // 0.8 wheel-pixels per finger-pixel keeps the text under the finger.
    // ---------------------------------------------------------------------
    const XTERM_SCROLLER = ".xterm-scrollable-element";
    /** Movement before a drag is read as a scroll rather than a tap. */
    const TERMINAL_SLOP_PX = 4;
    const TERMINAL_WHEEL_PER_PX = 0.8;
    /** One event is at most this many pixels, so a jump cannot fling the view. */
    const TERMINAL_WHEEL_MAX_PX = 32;
    let terminalDrag = null;

    /** The scrolling node of the terminal under `target`, or null. */
    function xtermScroller(target) {
      if (target === null || target === undefined || target.closest === undefined) return null;
      const terminal = target.closest(".xterm");
      if (terminal === null) return null;
      return terminal.querySelector(XTERM_SCROLLER) ?? terminal.querySelector(".xterm-screen") ?? terminal;
    }

    function startTerminalDrag(event) {
      if (CONFIG.terminalTouchScroll === false || event.touches.length !== 1) {
        terminalDrag = null;
        return;
      }
      const scroller = xtermScroller(event.target);
      if (scroller === null) {
        terminalDrag = null;
        return;
      }
      const touch = event.touches[0];
      terminalDrag = { scroller, x: touch.clientX, y: touch.clientY, vertical: false, cancelled: false };
    }

    /**
     * Feed one finger movement to the terminal.
     *
     * Returns true when this gesture belongs to the terminal, so the caller
     * leaves the event alone: the bridge has already done the preventDefault
     * the overscroll guard would otherwise do for the wrong reason.
     */
    function moveTerminalDrag(event) {
      const drag = terminalDrag;
      if (drag === null || drag.cancelled || event.touches.length !== 1) return false;
      const touch = event.touches[0];
      const dy = touch.clientY - drag.y;
      const dx = touch.clientX - drag.x;
      if (!drag.vertical) {
        if (Math.abs(dy) < TERMINAL_SLOP_PX) return true;
        // A sideways drag is a gesture for something else (the preview's
        // back-swipe used to claim it); stop tracking instead of scrolling.
        if (Math.abs(dy) <= Math.abs(dx)) {
          drag.cancelled = true;
          return false;
        }
        drag.vertical = true;
      }
      drag.y = touch.clientY;
      if (event.cancelable) event.preventDefault();
      const pixels = Math.max(-TERMINAL_WHEEL_MAX_PX, Math.min(TERMINAL_WHEEL_MAX_PX, dy));
      // A plain Event, not a WheelEvent: Chrome and Safari put `wheelDeltaY` on
      // real WheelEvents, and xterm prefers that (120-based) value, which would
      // make the speed browser-dependent. Without it, the pixel branch applies.
      const wheel = new Event("wheel", { bubbles: true, cancelable: true });
      wheel.deltaY = -pixels * TERMINAL_WHEEL_PER_PX;
      wheel.deltaX = 0;
      wheel.deltaMode = 0; /* DOM_DELTA_PIXEL */
      wheel.clientX = touch.clientX;
      wheel.clientY = touch.clientY;
      wheel.pageX = touch.clientX;
      wheel.pageY = touch.clientY;
      drag.scroller.dispatchEvent(wheel);
      return true;
    }

    function endTerminalDrag() {
      terminalDrag = null;
    }

    function scrollableAncestor(target) {
      let node = target;
      while (node !== null && node !== undefined && node !== document.body) {
        if (node.nodeType === 1) {
          const style = getComputedStyle(node);
          if ((style.overflowY === "auto" || style.overflowY === "scroll") && node.scrollHeight > node.clientHeight + 2) return node;
        }
        node = node.parentElement;
      }
      return null;
    }

    function onTouchStart(event) {
      startTerminalDrag(event);
      if (event.touches.length !== 1) {
        touchStart = null;
        return;
      }
      touchStart = { y: event.touches[0].clientY, x: event.touches[0].clientX };
    }

    function onTouchMove(event) {
      if (moveTerminalDrag(event)) return;
      if (touchStart === null || event.touches.length !== 1) return;
      const touch = event.touches[0];
      const dy = touch.clientY - touchStart.y;
      const dx = touch.clientX - touchStart.x;
      touchStart = { y: touch.clientY, x: touch.clientX };
      if (Math.abs(dy) <= Math.abs(dx)) return;
      const target = event.target;
      // `.xterm` scrolls through JS, so `scrollableAncestor` never sees it and
      // the guard below would cancel every vertical drag in the terminal. The
      // bridge above owns those.
      if (target !== null && target.closest !== undefined && target.closest("textarea, input, .xterm")) return;
      const scroller = scrollableAncestor(target);
      if (scroller === null) {
        if (event.cancelable) event.preventDefault();
        return;
      }
      const atTop = scroller.scrollTop <= 0;
      const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
      if ((dy > 0 && atTop) || (dy < 0 && atBottom)) {
        if (event.cancelable) event.preventDefault();
      }
    }

    // ---------------------------------------------------------------------
    // Click routing: session open, title popover, one-tap settings
    // ---------------------------------------------------------------------
    let settingsPendingUntil = 0;

    function maybeOpenSettings() {
      if (settingsPendingUntil === 0) return;
      if (Date.now() > settingsPendingUntil) {
        settingsPendingUntil = 0;
        return;
      }
      const menu = document.querySelector("[role='menu']");
      if (menu === null) return;
      const settingsProbe = probeRegex("settingsMenu", "", ["Settings"], true) ?? /^Settings$/;
      const item = [...menu.querySelectorAll("[role='menuitem']")].find((entry) => settingsProbe.test(labelOf(entry)));
      if (item === undefined) return;
      settingsPendingUntil = 0;
      item.click();
    }

    function closeDetailPopover() {
      document.querySelector(".rdsh-mux-detail")?.remove();
    }

    function showDetailPopover(anchor, title, text, meta) {
      closeDetailPopover();
      if (text === null || text === undefined || text === "") return;
      const pop = document.createElement("div");
      pop.className = "rdsh-mux-detail";
      pop.setAttribute("role", "dialog");
      pop.setAttribute("aria-label", title);
      const head = document.createElement("div");
      head.className = "rdsh-mux-detail-head";
      const name = document.createElement("span");
      name.className = "rdsh-mux-detail-title";
      name.textContent = title;
      head.append(name);
      if (meta !== null && meta !== undefined && meta !== "") {
        const badge = document.createElement("span");
        badge.className = "rdsh-mux-detail-meta";
        badge.textContent = meta;
        head.append(badge);
      }
      const body = document.createElement("div");
      body.className = "rdsh-mux-detail-body";
      body.textContent = text;
      pop.append(head, body);
      document.body.append(pop);
      const rect = anchor.getBoundingClientRect();
      const width = Math.min(360, window.innerWidth - 24);
      pop.style.width = `${width}px`;
      const height = pop.getBoundingClientRect().height;
      let top = rect.top - height - 8;
      if (top < 12) top = Math.min(window.innerHeight - height - 12, rect.bottom + 8);
      pop.style.top = `${Math.round(Math.max(12, top))}px`;
      pop.style.left = `${Math.round(Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)))}px`;
      const dismiss = (event) => {
        if (!pop.contains(event.target)) closeDetailPopover();
      };
      // `once` retires the listener on the first tap, so opening the popover
      // repeatedly cannot stack handlers on document.
      setTimeout(() => document.addEventListener("pointerdown", dismiss, { once: true }), 0);
    }

    function showTitlePopover(crumbs) {
      document.querySelector(".rdsh-mux-titlepop")?.remove();
      const text = (crumbs.textContent || "").trim();
      if (text === "") return;
      const popover = document.createElement("div");
      popover.className = "rdsh-mux-titlepop";
      popover.setAttribute("role", "status");
      popover.textContent = text;
      const rect = crumbs.getBoundingClientRect();
      const header = document.querySelector("header[data-window-drag]");
      const belowHeader = header === null ? rect.bottom : header.getBoundingClientRect().bottom;
      popover.style.top = `${Math.round(Math.max(rect.bottom + 8, belowHeader + 4))}px`;
      const width = Math.min(320, window.innerWidth - 24);
      popover.style.width = `${width}px`;
      popover.style.left = `${Math.round(Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)))}px`;
      document.body.append(popover);
      const dismiss = () => popover.remove();
      setTimeout(dismiss, 2600);
      document.addEventListener("pointerdown", dismiss, { once: true });
    }

    /**
     * Whether the click landed on a button that starts a new session.
     *
     * The app labels all three of them with the same wording: "New session" for
     * the sidebar button and the brand row, "New session in <name>" for a
     * workspace's "+". The vocabulary lives in the probe table, like every
     * other upstream label this package matches.
     */
    let newSessionPattern = null;

    function isNewSessionButton(target) {
      const button = target.closest("button[aria-label]");
      if (button === null) return false;
      if (newSessionPattern === null) newSessionPattern = probeRegex("newSession", "i", "new session") ?? /new session/i;
      return newSessionPattern.test(button.getAttribute("aria-label") || "");
    }

    function onClickCapture(event) {
      const target = event.target;
      if (target === null || target.closest === undefined) return;

      // The app delivered the tab click itself; the replay must stay cancelled.
      if (tabCandidate !== null && target.closest("[data-rdsh-rtab]") === tabCandidate.tab) tabCandidate.fired = true;

      // xterm's helper textarea is the actual input; a click gesture focusing it
      // asks iOS to show the keyboard.
      if (narrow()) {
        const terminal = target.closest(".xterm, [class*='xterm']");
        if (terminal !== null) {
          const input = terminal.querySelector("textarea.xterm-helper-textarea, textarea");
          if (input !== null) input.focus({ preventScroll: true });
        }
      }
      // Fallback for keyboard activation of the send/queue button, and the
      // #15 opt-in that treats this browser's turns as phone turns.
      if (phone() || notifyDeviceTurns()) {
        const primary = target.closest && target.closest('[data-rdsh-composer-root] [class*="primary"]');
        if (primary !== null && primary !== undefined && primary.disabled !== true && !STOP_PROBE.test(primary.getAttribute("aria-label") || "")) {
          markMobileSession();
          closeKeyboardAfterSend();
        }
      }
      // Phone "+": open the OS file/photo picker directly. Commands live in "/".
      // #17: on a desktop-width-only window the stock menu stays intact.
      if (addButtonOf(target) !== null && phone()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        pickFiles("file");
        return;
      }
      // Todo rows and the goal objective are truncated in the dock; tapping
      // opens a read-only popover with the full text.
      const todoItem = target.closest("[data-rdsh-todo-item]");
      if (todoItem !== null && narrow()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        showDetailPopover(todoItem, t("mux.detail.todo"), todoItem.getAttribute("data-rdsh-todo-text"), todoItem.getAttribute("data-rdsh-todo-status"));
        return;
      }
      const goalObjective = target.closest("[data-rdsh-goal-objective]");
      if (goalObjective !== null && narrow()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const goalBar = goalObjective.closest("[data-goal-bar]");
        const goalLabel = goalBar === null ? null : goalBar.querySelector('[class*="_label"]');
        showDetailPopover(goalObjective, t("mux.detail.goal"), goalObjective.getAttribute("data-rdsh-goal-text"), goalLabel === null ? null : goalLabel.textContent.trim());
        return;
      }
      // Right sidebar: its class does not change on open/close, so re-read the
      // computed visibility after the click has settled.
      if (rightPanelNode !== null) {
        // The slide transition can outlive the click; re-read after it settles.
        setTimeout(syncRightPanelOpen, 60);
        setTimeout(syncRightPanelOpen, 350);
        setTimeout(syncRightPanelOpen, 900);
      }

      // "New session" (the sidebar's own button, its brand row, and a
      // workspace's "+") opens a blank session behind the drawer, so the drawer
      // closes just as it does for a tapped session row. Match by label, not
      // by hashed class; a session row never carries one of these buttons.
      if (narrow() && isNewSessionButton(target)) {
        setTimeout(closeDrawer, 0);
        return;
      }

      const row = target.closest('[data-row-key^="session:"]');
      if (row !== null && narrow()) {
        // Only the release click is a target: the click this module sends to
        // the row's own "..." trigger starts inside its actions, and eating that
        // one left every long press after the first without a menu.
        if (Date.now() < menuOpenedUntil && target.closest('[class*="_rowActions"]') === null) {
          menuOpenedUntil = 0;
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        if (controlInsideRow(target)) return;
        if (tapCandidate !== null) tapCandidate.fired = true;
        // Close after the row's own handler has opened the session.
        setTimeout(closeDrawer, 0);
        return;
      }

      if (target.closest('[data-shortcut-modal="settings"]') !== null) return;

      const crumbs = target.closest("[data-rdsh-crumbs]");
      if (crumbs !== null && narrow()) {
        showTitlePopover(crumbs);
        return;
      }

    }

    // ---------------------------------------------------------------------
    // Focus: opening a session must not steal the composer
    // ---------------------------------------------------------------------
    let allowFocusElement = null;
    let allowFocusUntil = 0;

    function textBoxOf(element) {
      if (!(element instanceof Element)) return null;
      const field = element.closest('input, textarea, [contenteditable="true"]');
      if (field === null) return null;
      if (field.tagName === "INPUT") {
        const type = (field.getAttribute("type") || "text").toLowerCase();
        if (["button", "submit", "reset", "checkbox", "radio", "range", "file", "color", "image", "hidden"].includes(type)) return null;
      }
      if (field.disabled === true || field.readOnly === true) return null;
      return field;
    }

    function onFocusPointer(event) {
      if (!narrow()) return;
      const field = textBoxOf(event.target);
      allowFocusElement = field;
      allowFocusUntil = field === null ? 0 : Date.now() + 1500;
    }

    function onModelFocusOut(event) {
      if (!narrow()) return;
      const target = event.target;
      if (target === null || target === undefined || target.closest === undefined) return;
      const root = target.closest('[class*="_7KE1Ra_root"]');
      const menu = document.querySelector('[class*="_7KE1Ra_menu"]');
      if (menu === null) return;
      if (root === null && !menu.contains(target)) return;
      const related = event.relatedTarget;
      if (related !== null && related !== undefined) {
        const inside = root?.contains(related) === true || menu.contains(related);
        if (!inside) return;
      }
      event.stopPropagation();
    }

    function onFocusInGuard(event) {
      if (!narrow()) return;
      const field = textBoxOf(event.target);
      if (field === null) return;
      // Popovers (the model picker's search, dialogs, etc.) focus their own
      // inputs programmatically. Blurring those closes the popover because the
      // menu's onBlur sees no related focus target.
      if (field.closest('[role="menu"], [role="dialog"], [role="listbox"], [class*="_7KE1Ra_menu"], .xterm, [class*="xterm"]') !== null) return;
      if (field === allowFocusElement && Date.now() <= allowFocusUntil) return;
      // Deferred: Safari/the app re-focuses synchronously from its onFocus
      // handler, so an immediate blur() recurses until the stack overflows.
      setTimeout(() => {
        if (document.activeElement === field) field.blur();
      }, 0);
    }

    // ---------------------------------------------------------------------
    // Keyboard: a sent message puts it away
    // ---------------------------------------------------------------------
    /** How long after a send the draft may take to leave the composer. */
    const SEND_SETTLE_MS = 2000;
    const SEND_POLL_MS = 50;
    let sendSettleTimer = 0;

    /**
     * Put the soft keyboard away once the app has taken the draft.
     *
     * The stock composer keeps focus after a send so a desktop user can go on
     * typing, and it holds focus through the toolbar press itself (the send
     * button's mousedown refocuses the editor). On a phone that leaves the
     * keyboard over the reply the user is waiting to read. Call this from the
     * gesture that sends; it runs before the app's own handler, so the draft is
     * still in the editor and the wait below is for the app to clear it.
     *
     * A send the app refuses (an upload still running, a failed submit that
     * restores the draft) leaves the text in place and the keyboard open, so
     * the user can fix it. Only a phone is affected: a desktop window keeps
     * its focus, narrow or not.
     */
    function closeKeyboardAfterSend() {
      if (!phone()) return;
      const deadline = Date.now() + SEND_SETTLE_MS;
      clearTimeout(sendSettleTimer);
      const settle = () => {
        sendSettleTimer = 0;
        const editor = document.querySelector("[data-composer-input]");
        if (editor === null) return;
        if ((editor.textContent || "").trim() !== "") {
          if (Date.now() < deadline) sendSettleTimer = setTimeout(settle, SEND_POLL_MS);
          return;
        }
        // Only the composer's own keyboard: a field the user has moved on to
        // (a rename, the model search) keeps its focus.
        if (document.activeElement === editor) editor.blur();
      };
      // After this click finishes, so the app's submit has already run.
      sendSettleTimer = setTimeout(settle, 0);
    }

    function onKeyDown(event) {
      if (event.key === "Escape") {
        document.querySelector(".rdsh-mux-titlepop")?.remove();
        closeDetailPopover();
        return;
      }
      if (!narrow() || (event.key !== "Enter" && event.key !== " ")) return;
      const target = event.target;
      if (target === null || target === undefined || target.closest === undefined) return;
      const todoItem = target.closest("[data-rdsh-todo-item]");
      if (todoItem !== null) {
        event.preventDefault();
        showDetailPopover(todoItem, t("mux.detail.todo"), todoItem.getAttribute("data-rdsh-todo-text"), todoItem.getAttribute("data-rdsh-todo-status"));
        return;
      }
      const goalObjective = target.closest("[data-rdsh-goal-objective]");
      if (goalObjective !== null) {
        event.preventDefault();
        const goalBar = goalObjective.closest("[data-goal-bar]");
        const goalLabel = goalBar === null ? null : goalBar.querySelector('[class*="_label"]');
        showDetailPopover(goalObjective, t("mux.detail.goal"), goalObjective.getAttribute("data-rdsh-goal-text"), goalLabel === null ? null : goalLabel.textContent.trim());
      }
    }

    // ---------------------------------------------------------------------
    // Session color frame: a "3-dot menu" item plus a small palette
    // ---------------------------------------------------------------------
    function frameIcon() {
      return h("svg", {
        width: 16, height: 16, viewBox: "0 0 16 16", fill: "none",
        stroke: "currentColor", strokeWidth: 1, "aria-hidden": "true",
      },
        h("rect", { x: 2.5, y: 2.5, width: 11, height: 11, rx: 2.5 }),
        h("rect", { x: 5.5, y: 5.5, width: 5, height: 5, rx: 1.2 }),
        h("circle", { cx: 12.5, cy: 3.5, r: 1.2, fill: "currentColor", stroke: "none" }));
    }

    function closeFramePalette() {
      document.querySelector(".rdsh-frame-pop")?.remove();
      document.querySelector(".rdsh-frame-backdrop")?.remove();
    }

    function showFramePalette(sessionId, anchor) {
      closeFramePalette();
      const pop = document.createElement("div");
      pop.className = "rdsh-frame-pop";
      pop.setAttribute("role", "dialog");
      pop.setAttribute("aria-label", t("frame.paletteAria"));
      const current = sessionFrames[sessionId];
      const title = document.createElement("div");
      title.className = "rdsh-frame-pop-title";
      title.textContent = t("frame.paletteTitle");
      const swatches = document.createElement("div");
      swatches.className = "rdsh-frame-swatches";
      for (const color of FRAME_COLORS) {
        const swatch = document.createElement("button");
        swatch.type = "button";
        swatch.className = "rdsh-frame-swatch";
        swatch.style.background = color.value;
        swatch.setAttribute("aria-label", color.label);
        swatch.setAttribute("data-current", String(current === color.value));
        swatch.addEventListener("click", () => {
          saveSessionFrame(sessionId, color.value);
          closeFramePalette();
          mobileToast(t("frame.applied", { color: color.label }));
        });
        swatches.append(swatch);
      }
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "rdsh-frame-clear";
      clear.textContent = t("frame.clear");
      clear.addEventListener("click", () => {
        saveSessionFrame(sessionId, null);
        closeFramePalette();
        mobileToast(t("frame.cleared"));
      });
      pop.append(title, swatches, clear);
      document.body.append(pop);
      const rect = pop.getBoundingClientRect();
      const width = rect.width;
      const height = rect.height;
      const anchorRect = anchor instanceof Element ? anchor.getBoundingClientRect() : (anchor ?? null);
      const left = anchorRect === null ? 16 : Math.max(8, Math.min(anchorRect.right - width, window.innerWidth - width - 8));
      const top = anchorRect === null ? window.innerHeight - height - 24 : Math.max(8, Math.min(anchorRect.bottom + 8, window.innerHeight - height - 24));
      pop.style.left = `${Math.round(left)}px`;
      pop.style.top = `${Math.round(top)}px`;
      const backdrop = document.createElement("div");
      backdrop.className = "rdsh-frame-backdrop";
      backdrop.setAttribute("aria-hidden", "true");
      backdrop.addEventListener("click", closeFramePalette);
      document.body.append(backdrop);
    }

    function ColorFrameMenuItem(props) {
      const sessionId = props.sessionId;
      const menuState = typeof props.useMenuOpenState === "function" ? props.useMenuOpenState() : null;
      const setMenuOpen = Array.isArray(menuState) ? menuState[1] : null;
      if (typeof sessionId !== "string") return null;
      return h("button", {
        type: "button",
        role: "menuitem",
        className: "rdsh-frame-menu-item",
        onClick: (event) => {
          event.preventDefault();
          event.stopPropagation();
          const anchorRect = event.currentTarget.getBoundingClientRect();
          if (typeof setMenuOpen === "function") setMenuOpen(false);
          setTimeout(() => showFramePalette(sessionId, anchorRect), 0);
        },
      }, h("span", { className: "rdsh-frame-menu-icon", "aria-hidden": "true" }, frameIcon()), h("span", null, t("frame.menu")));
    }

    // ---------------------------------------------------------------------
    // Image lightbox: safe-area close, swipe-down dismiss, simple crop
    // ---------------------------------------------------------------------
    const CROP_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 2v14a1 1 0 0 0 1 1h14"/><path d="M2 7h14a1 1 0 0 1 1 1v14"/></svg>';

    function lightboxDialog() {
      // Do not key this off the dialog's localized aria-label: with the UI in
      // Japanese ("元の画像のプレビュー") the crop/safe-area hooks never attached.
      for (const dialog of document.querySelectorAll('div[role="dialog"]')) {
        if (dialog.hasAttribute("data-rdsh-crop-overlay")) continue;
        if (dialog.hasAttribute("data-shortcut-modal")) continue;
        if (dialog.querySelector('[class*="_stage_"]') !== null && dialog.querySelector("img") !== null) return dialog;
      }
      for (const dialog of document.querySelectorAll('div[role="dialog"]')) {
        if (dialog.hasAttribute("data-rdsh-crop-overlay")) continue;
        if (dialog.hasAttribute("data-shortcut-modal")) continue;
        if (dialog.querySelector("img") !== null && dialog.querySelector('button[class*="_close_"]') !== null) return dialog;
      }
      return null;
    }

    function attachLightboxSwipe(dialog) {
      if (dialog.hasAttribute("data-rdsh-swipe")) return;
      dialog.setAttribute("data-rdsh-swipe", "");
      const stage = dialog.querySelector('[class*="_stage_"]');
      const close = dialog.querySelector('[class*="_close_"]');
      if (stage === null || close === null) return;
      let start = null;
      const reset = () => {
        start = null;
        stage.style.transition = "transform .18s ease, opacity .18s ease";
        stage.style.transform = "";
        stage.style.opacity = "";
        setTimeout(() => { stage.style.transition = ""; }, 200);
      };
      dialog.addEventListener("touchstart", (event) => {
        if (dialog.querySelector("[data-rdsh-crop-overlay]") !== null) return;
        if (event.touches.length !== 1) return;
        if (event.target.closest("button") !== null) return;
        const touch = event.touches[0];
        start = { x: touch.clientX, y: touch.clientY, dy: 0 };
        stage.style.transition = "none";
      }, { passive: true });
      dialog.addEventListener("touchmove", (event) => {
        if (start === null || event.touches.length !== 1) return;
        const touch = event.touches[0];
        const dx = touch.clientX - start.x;
        const dy = touch.clientY - start.y;
        if (dy <= 0 || Math.abs(dy) <= Math.abs(dx)) {
          return;
        }
        event.preventDefault();
        start.dy = dy;
        stage.style.transform = `translateY(${Math.round(dy)}px)`;
        stage.style.opacity = String(Math.max(0.25, 1 - dy / 500));
      }, { passive: false });
      dialog.addEventListener("touchend", () => {
        if (start === null) return;
        const dy = start.dy;
        if (dy > 90) {
          start = null;
          close.click();
          stage.style.transform = "";
          stage.style.opacity = "";
          stage.style.transition = "";
        } else {
          reset();
        }
      }, { passive: true });
      dialog.addEventListener("touchcancel", reset, { passive: true });
    }

    const imageEditRecords = new Map();

    /** Locate the composer thumbnail that owns this lightbox image. */
    function composerImageFor(src) {
      const root = document.querySelector('[data-rdsh-composer-root]');
      if (root === null || typeof src !== "string" || src === "") return null;
      for (const img of root.querySelectorAll("img")) {
        if ((img.currentSrc || img.src) !== src) continue;
        const item = img.closest('[class*="_imageItem"]');
        return { src, img, item, remove: item?.querySelector('button[aria-label^="Remove image"]') ?? null };
      }
      return null;
    }

    function readAsDataUrl(blob) {
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
        reader.onerror = () => resolve("");
        reader.readAsDataURL(blob);
      });
    }

    async function srcToDataUrl(src) {
      const response = await fetch(src);
      return readAsDataUrl(await response.blob());
    }

    function attachFileToComposer(file) {
      const input = document.querySelector('[data-rdsh-composer-root] input[type="file"]')
        ?? document.querySelector('input[type="file"]');
      if (input === null) return false;
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }

    function openCrop(dialog) {
      if (document.querySelector("[data-rdsh-crop-overlay]") !== null) return;
      const source = dialog.querySelector("img");
      if (source === null) return;
      const src = source.currentSrc || source.src;
      const composer = composerImageFor(src);
      let record = imageEditRecords.get(src) ?? null;
      if (record === null && composer !== null) {
        record = { originalSrc: src, originalData: null, currentSrc: src, rotation: 0, cropNorm: null };
        imageEditRecords.set(src, record);
      }
      const editSrc = record?.originalData ?? record?.originalSrc ?? src;
      const initialRotation = record?.rotation ?? 0;
      const initialCrop = record?.cropNorm ?? null;
      const overlay = document.createElement("div");
      overlay.className = "rdsh-crop-overlay";
      overlay.setAttribute("data-rdsh-crop-overlay", "");
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-label", t("crop.aria"));
      overlay.innerHTML = `
        <div class="rdsh-crop-head">
          <strong>${t("crop.title")}</strong>
          <div class="rdsh-crop-head-actions">
            <button type="button" class="rdsh-crop-rotate" data-rotate="-90" aria-label="${t("crop.rotateLeft")}"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg></button>
            <button type="button" class="rdsh-crop-rotate" data-rotate="90" aria-label="${t("crop.rotateRight")}"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg></button>
            <button type="button" class="rdsh-crop-close" aria-label="${t("crop.close")}">×</button>
          </div>
        </div>
        <div class="rdsh-crop-stage"><div class="rdsh-crop-wrap"><img class="rdsh-crop-image" alt="" draggable="false"><div class="rdsh-crop-box"><span class="rdsh-crop-handle" data-corner="nw"></span><span class="rdsh-crop-handle" data-corner="ne"></span><span class="rdsh-crop-handle" data-corner="sw"></span><span class="rdsh-crop-handle" data-corner="se"></span></div></div></div>
        <div class="rdsh-crop-actions"><button type="button" class="rdsh-crop-cancel">${t("crop.cancel")}</button><button type="button" class="rdsh-crop-save">${t("crop.save")}</button></div>`;
      const image = overlay.querySelector(".rdsh-crop-image");
      const wrap = overlay.querySelector(".rdsh-crop-wrap");
      const stage = overlay.querySelector(".rdsh-crop-stage");
      const box = overlay.querySelector(".rdsh-crop-box");
      const save = overlay.querySelector(".rdsh-crop-save");
      const close = () => closeCrop();
      overlay.querySelector(".rdsh-crop-close").addEventListener("click", () => closeCrop());
      overlay.querySelector(".rdsh-crop-cancel").addEventListener("click", () => closeCrop());
      const state = { x: 0, y: 0, w: 0, h: 0 };
      let cropNorm = initialCrop === null ? null : { ...initialCrop };
      let move = null;
      let rotation = 0;
      let rotatedUrl = null;
      let baseReady = false;
      let initialRotationApplied = false;
      const base = new Image();
      base.onload = () => { baseReady = true; maybeApplyInitialRotation(); };
      base.onerror = () => { baseReady = false; };
      base.src = editSrc;
      const render = () => {
        box.style.left = `${state.x}px`;
        box.style.top = `${state.y}px`;
        box.style.width = `${state.w}px`;
        box.style.height = `${state.h}px`;
      };
      const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
      const syncNorm = () => {
        const iw = image.clientWidth;
        const ih = image.clientHeight;
        if (iw === 0 || ih === 0 || state.w <= 0 || state.h <= 0) return;
        cropNorm = { x: state.x / iw, y: state.y / ih, w: state.w / iw, h: state.h / ih };
      };
      const fit = () => {
        const iw = image.naturalWidth;
        const ih = image.naturalHeight;
        const sw = stage.clientWidth;
        const sh = stage.clientHeight;
        if (iw === 0 || ih === 0 || sw === 0 || sh === 0) return;
        const availW = Math.max(1, sw - 24);
        const availH = Math.max(1, sh - 24);
        const scale = Math.min(availW / iw, availH / ih);
        const width = Math.max(1, Math.round(iw * scale));
        const height = Math.max(1, Math.round(ih * scale));
        wrap.style.width = `${width}px`;
        wrap.style.height = `${height}px`;
        image.style.width = `${width}px`;
        image.style.height = `${height}px`;
        if (cropNorm === null) {
          // Start with the full image: the four handles sit on its corners.
          state.x = 0; state.y = 0;
          state.w = width; state.h = height;
          cropNorm = { x: 0, y: 0, w: 1, h: 1 };
        } else {
          const x = clamp(cropNorm.x * width, 0, Math.max(0, width - 1));
          const y = clamp(cropNorm.y * height, 0, Math.max(0, height - 1));
          state.x = x;
          state.y = y;
          state.w = clamp(cropNorm.w * width, 1, width - x);
          state.h = clamp(cropNorm.h * height, 1, height - y);
        }
        render();
      };
      const onResize = () => fit();
      window.addEventListener("resize", onResize);
      image.addEventListener("load", () => {
        fit();
        maybeApplyInitialRotation();
      });
      image.src = editSrc;
      if (image.complete) fit();
      requestAnimationFrame(fit);

      const applyRotation = (delta, rotateCrop = true) => {
        if (!baseReady || base.naturalWidth === 0) return;
        // Rotate the crop rectangle with the image so the same content stays
        // selected. Normalized coordinates are orientation-independent.
        const norm = cropNorm ?? { x: 0, y: 0, w: 1, h: 1 };
        const step = ((delta % 360) + 360) % 360;
        if (rotateCrop && step === 90) {
          cropNorm = { x: 1 - (norm.y + norm.h), y: norm.x, w: norm.h, h: norm.w };
        } else if (rotateCrop && step === 270) {
          cropNorm = { x: norm.y, y: 1 - (norm.x + norm.w), w: norm.h, h: norm.w };
        }
        rotation = (rotation + delta + 360) % 360;
        const canvas = document.createElement("canvas");
        const sideways = rotation % 180 !== 0;
        canvas.width = sideways ? base.naturalHeight : base.naturalWidth;
        canvas.height = sideways ? base.naturalWidth : base.naturalHeight;
        const context = canvas.getContext("2d");
        context.translate(canvas.width / 2, canvas.height / 2);
        context.rotate(rotation * Math.PI / 180);
        context.drawImage(base, -base.naturalWidth / 2, -base.naturalHeight / 2);
        canvas.toBlob((blob) => {
          if (blob === null) return;
          if (rotatedUrl !== null) URL.revokeObjectURL(rotatedUrl);
          rotatedUrl = URL.createObjectURL(blob);
          image.src = rotatedUrl;
          if (image.complete) fit();
          requestAnimationFrame(fit);
        }, "image/png");
      };
      const maybeApplyInitialRotation = () => {
        if (initialRotationApplied || !baseReady || initialRotation === 0) return;
        initialRotationApplied = true;
        applyRotation(initialRotation, false);
      };
      for (const button of overlay.querySelectorAll("[data-rotate]")) {
        button.addEventListener("click", (event) => {
          event.preventDefault();
          applyRotation(Number(button.getAttribute("data-rotate")));
        });
      }
      const closeCrop = () => {
        window.removeEventListener("resize", onResize);
        if (rotatedUrl !== null) URL.revokeObjectURL(rotatedUrl);
        overlay.remove();
      };
      const onMove = (event) => {
        if (move === null) return;
        const dx = event.clientX - move.sx;
        const dy = event.clientY - move.sy;
        if (move.kind === "move") {
          state.x = clamp(move.x + dx, 0, image.clientWidth - state.w);
          state.y = clamp(move.y + dy, 0, image.clientHeight - state.h);
        } else {
          let left = move.x;
          let top = move.y;
          let right = move.x + move.w;
          let bottom = move.y + move.h;
          if (move.corner.includes("e")) right = clamp(right + dx, left + 48, image.clientWidth);
          if (move.corner.includes("s")) bottom = clamp(bottom + dy, top + 48, image.clientHeight);
          if (move.corner.includes("w")) left = clamp(left + dx, 0, right - 48);
          if (move.corner.includes("n")) top = clamp(top + dy, 0, bottom - 48);
          state.x = left; state.y = top; state.w = right - left; state.h = bottom - top;
        }
        render();
        syncNorm();
      };
      box.addEventListener("pointerdown", (event) => {
        if (event.target.closest(".rdsh-crop-handle") !== null) return;
        event.preventDefault();
        move = { kind: "move", sx: event.clientX, sy: event.clientY, x: state.x, y: state.y, w: state.w, h: state.h };
        box.setPointerCapture(event.pointerId);
      });
      for (const handle of box.querySelectorAll(".rdsh-crop-handle")) {
        handle.addEventListener("pointerdown", (event) => {
          event.preventDefault();
          event.stopPropagation();
          move = { kind: "resize", corner: handle.getAttribute("data-corner"), sx: event.clientX, sy: event.clientY, x: state.x, y: state.y, w: state.w, h: state.h };
          handle.setPointerCapture(event.pointerId);
        });
      }
      box.addEventListener("pointermove", onMove);
      box.addEventListener("pointerup", () => { move = null; });
      box.addEventListener("pointercancel", () => { move = null; });
      save.addEventListener("click", async () => {
        if (state.w <= 0 || state.h <= 0) return;
        const scaleX = image.naturalWidth / image.clientWidth;
        const scaleY = image.naturalHeight / image.clientHeight;
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(state.w * scaleX));
        canvas.height = Math.max(1, Math.round(state.h * scaleY));
        const context = canvas.getContext("2d");
        context.drawImage(image, state.x * scaleX, state.y * scaleY, state.w * scaleX, state.h * scaleY, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
        if (blob === null) return;
        syncNorm();
        if (record !== null) {
          record.rotation = rotation;
          record.cropNorm = cropNorm === null ? null : { ...cropNorm };
        }
        const file = new File([blob], `crop-${Date.now()}.png`, { type: "image/png" });
        const closePreview = () => {
          dialog.querySelector('button[class*="_close_"]')?.click();
        };
        try {
          if (record !== null) {
            if (record.originalData === null) {
              try {
                record.originalData = await srcToDataUrl(record.originalSrc);
              } catch {
                record.originalData = record.originalSrc;
              }
            }
            const oldSrc = record.currentSrc;
            const current = composerImageFor(oldSrc);
            current?.remove?.click();
            if (!attachFileToComposer(file)) {
              mobileToast(t("crop.addFailed"));
              return;
            }
            const name = file.name;
            let tries = 0;
            const timer = setInterval(() => {
              const root = document.querySelector('[data-rdsh-composer-root]');
              const remove = root === null ? null : [...root.querySelectorAll("button")]
                .find((button) => button.getAttribute("aria-label") === `Remove image ${name}`);
              const img = remove?.closest('[class*="_imageItem"]')?.querySelector("img") ?? null;
              if (img !== null) {
                clearInterval(timer);
                const newSrc = img.currentSrc || img.src;
                imageEditRecords.delete(oldSrc);
                record.currentSrc = newSrc;
                imageEditRecords.set(newSrc, record);
              } else if (++tries > 50) {
                clearInterval(timer);
              }
            }, 100);
            mobileToast(t("crop.updated"));
          } else {
            if (!attachFileToComposer(file)) {
              mobileToast(t("crop.addFailed"));
              return;
            }
            mobileToast(t("crop.added"));
          }
          close();
          closePreview();
        } catch {
          mobileToast(t("crop.addFailed"));
        }
      });
      document.body.append(overlay);
    }

    function decorateLightbox() {
      // The crop button and the full-bleed styling are phone affordances: a
      // desktop viewer keeps its own chrome and its own close button.
      if (!narrow()) return;
      const dialog = lightboxDialog();
      if (dialog === null) return;
      if (!dialog.hasAttribute("data-rdsh-lightbox")) dialog.setAttribute("data-rdsh-lightbox", "");
      if (dialog.querySelector("[data-rdsh-crop-button]") === null) {
        const button = document.createElement("button");
        button.type = "button";
        button.setAttribute("data-rdsh-crop-button", "");
        button.setAttribute("aria-label", t("crop.aria"));
        button.innerHTML = CROP_ICON;
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          openCrop(dialog);
        });
        dialog.append(button);
      }
      attachLightboxSwipe(dialog);
    }

    // ---------------------------------------------------------------------
    // Notifications (Web Push in the installed app)
    // ---------------------------------------------------------------------
    function urlBase64ToUint8Array(base64) {
      const padding = "=".repeat((4 - (base64.length % 4)) % 4);
      const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
      const raw = atob(normalized);
      const bytes = new Uint8Array(raw.length);
      for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
      return bytes;
    }

    async function notificationStatus() {
      if (typeof Notification === "undefined" || !("serviceWorker" in navigator)) {
        return { supported: false, permission: "unsupported", subscribed: false, ready: false };
      }
      let subscribed = false;
      try {
        const registration = await navigator.serviceWorker.getRegistration();
        const subscription = registration === null || registration === undefined ? null : await registration.pushManager.getSubscription();
        subscribed = subscription !== null && subscription !== undefined;
      } catch {
        subscribed = false;
      }
      return {
        supported: true,
        permission: Notification.permission,
        subscribed,
        ready: navigator.serviceWorker.controller !== null,
      };
    }

    async function refreshNotificationStatus() {
      emit({ notifications: await notificationStatus() });
    }

    async function enableNotifications() {
      if (typeof Notification === "undefined") throw new Error(t("notify.unsupported"));
      const permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error(t("notify.permissionMissing"));
      const registration = await navigator.serviceWorker.ready;
      const response = await fetch(`${PUSH_API}/vapid`, { cache: "no-store" });
      if (!response.ok) throw new Error(t("notify.unavailable"));
      const { publicKey } = await response.json();
      const existing = await registration.pushManager.getSubscription();
      const subscription = existing === null
        ? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) })
        : existing;
      const saved = await fetch(`${PUSH_API}/subscribe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // `origin` becomes the VAPID contact for pushes: Apple rejects
        // mailto:root@localhost with 403 BadJwtToken, but accepts the app's own
        // https origin.
        body: JSON.stringify({ subscription: subscription.toJSON(), label: navigator.userAgent, origin: location.origin }),
      });
      if (!saved.ok) throw new Error(t("notify.subscribeFailed", { status: saved.status }));
      await refreshNotificationStatus();
    }

    async function disableNotifications() {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = registration === null || registration === undefined ? null : await registration.pushManager.getSubscription();
      if (subscription !== null) {
        try {
          await fetch(`${PUSH_API}/unsubscribe`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ endpoint: subscription.endpoint }),
          });
        } catch {
          /* the browser-side unsubscribe below still removes the endpoint */
        }
        await subscription.unsubscribe();
      }
      await refreshNotificationStatus();
    }

    async function sendTestNotification() {
      // A local showNotification always succeeds, so it proves nothing about
      // the push path. Ask the host to push for real, and fall back to the
      // local notification only when the host has no such route.
      let pushed = null;
      try {
        const response = await fetch(`${PUSH_API}/test`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          // Carrying the id makes the test banner tappable: it opens the same
          // session a real notification would.
          body: JSON.stringify({ sessionId: currentSessionId ?? "" }),
        });
        if (response.status !== 404 && response.status !== 405) {
          pushed = await response.json();
        }
      } catch {
        pushed = null;
      }
      if (pushed !== null) {
        const result = Array.isArray(pushed.results) ? pushed.results[0] : null;
        if (pushed.ok === true) return;
        const detail = result === null || result === undefined
          ? String(pushed.error ?? t("notify.unknownError"))
          : `${result.status || "-"} ${result.error ?? ""}`.trim();
        throw new Error(t("notify.rejected", { detail }));
      }
      // No host route: still prove the two local paths, which is what the
      // user will actually see.
      const shown = notifyUser({
        title: t("notify.testTitle"),
        body: t("notify.testBody"),
        sessionId: currentSessionId ?? "",
        kind: "test",
      });
      if (!shown) {
        const registration = await navigator.serviceWorker.getRegistration();
        if (registration === null || registration === undefined) throw new Error(t("notify.noWorker"));
        await registration.showNotification(t("notify.testTitle"), {
          body: t("notify.testLocalBody"),
          icon: "pwa/icon-192.png",
          badge: "pwa/badge-96.png",
          tag: "rdsh-mobile-ux:test",
        });
      }
    }

    // ---------------------------------------------------------------------
    // Notifications: in-app banner, sound, session deep link
    // ---------------------------------------------------------------------

    /**
     * Where the browser half keeps the notification routes.
     *
     * They are this package's own (`/api/rdsh-pwa/push/…`): the notification
     * plugin this package replaces (`dsh-notify-push`) is credited in
     * README.md for the overall design, but nothing here calls its API.
     */
    // Relative to the page so a deployment under a proxy prefix (/dsh/…) keeps
    // working; every caller does fetch(`${PUSH_API}/…`).
    const PUSH_API = "api/rdsh-pwa/push";

    /** Preset notification sounds, synthesised — no audio files to ship. */
    const SOUND_PRESETS = {
      none: { label: t("mux.sound.none"), notes: [[0, 0, 0]] },
      // A short two-note rise: the "something finished" shape.
      chime: { label: t("mux.sound.chime"), notes: [[880, 0.09, 0.5], [1320, 0.16, 0.16]] },
      // One soft blip, for questions that should not startle.
      pop: { label: t("mux.sound.pop"), notes: [[660, 0.05, 0.35]] },
      // Three descending notes: distinct without being loud.
      drop: { label: t("mux.sound.drop"), notes: [[1175, 0.07, 0.34], [880, 0.07, 0.1], [660, 0.12, 0.1]] },
      // A quiet double tap for "still working".
      tick: { label: t("mux.sound.tick"), notes: [[1500, 0.03, 0.42], [1500, 0.03, 0.1]] },
    };

    const SOUND_KEY = "rdsh-mobile-ux:notify-sound";
    const VOLUME_KEY = "rdsh-mobile-ux:notify-volume";

    /** Read the chosen sound preset, falling back to the default. */
    function readSoundPreset() {
      try {
        const value = localStorage.getItem(SOUND_KEY);
        if (typeof value === "string" && value in SOUND_PRESETS) return value;
      } catch {
        /* private mode */
      }
      return typeof CONFIG.notificationSound === "string" && CONFIG.notificationSound in SOUND_PRESETS
        ? CONFIG.notificationSound
        : "chime";
    }

    /** Read the chosen volume (0–1). */
    function readSoundVolume() {
      try {
        const stored = localStorage.getItem(VOLUME_KEY);
        // Number(null) is 0, so an unset key must be checked before coercing:
        // otherwise "never saved" reads as "muted".
        if (stored !== null) {
          const raw = Number(stored);
          if (Number.isFinite(raw) && raw >= 0 && raw <= 1) return raw;
        }
      } catch {
        /* private mode */
      }
      return 0.5;
    }

    let audioContext = null;

    /** Lazily create the audio context; returns null when unavailable. */
    function soundContext() {
      if (audioContext !== null && audioContext.state !== "closed") return audioContext;
      const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
      if (typeof Ctor !== "function") return null;
      try {
        audioContext = new Ctor();
      } catch {
        return null;
      }
      return audioContext;
    }

    /**
     * Play a notification sound.
     *
     * Each preset is a list of `[frequency, duration, delay]` notes rendered
     * with a short attack and exponential release, so it reads as a chime
     * rather than a click. Nothing is fetched: the whole sound is generated.
     *
     * @param {string} [preset] - one of {@link SOUND_PRESETS}; defaults to the
     *   stored choice.
     * @param {number} [volume] - 0–1; defaults to the stored level.
     * @returns {boolean} whether a sound was scheduled.
     */
    function playNoticeSound(preset = readSoundPreset(), volume = readSoundVolume()) {
      if (preset === "none" || volume <= 0) return false;
      const spec = SOUND_PRESETS[preset];
      if (spec === undefined) return false;
      const context = soundContext();
      if (context === null) return false;
      // iOS suspends the context until a gesture; a resumed one is a no-op.
      if (context.state === "suspended") void context.resume().catch(() => {});
      const start = context.currentTime + 0.01;
      for (const [frequency, duration, delay] of spec.notes) {
        const at = start + delay;
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(frequency, at);
        // A short ramp in avoids the click a hard start produces.
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume * 0.35), at + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(at);
        oscillator.stop(at + duration + 0.02);
      }
      return true;
    }

    /** Whether the page is on screen right now. */
    function pageVisible() {
      return typeof document !== "undefined" && document.visibilityState === "visible";
    }

    let noticeRoot = null;
    let noticeHost = null;

    /**
     * Show one in-app notification banner.
     *
     * This is the front-of-house path: when the app is on screen the user is
     * already looking at it, so a system notification would only stack on top
     * of the thing that caused it. The banner is the same `Toast` primitive the
     * app uses for its own messages, so it inherits the look, the placement and
     * the swipe-to-dismiss decoration this plugin already installs.
     *
     * @param {object} options
     * @param {string} options.title - headline, usually the session name.
     * @param {string} [options.body] - one line of detail.
     * @param {string} [options.sessionId] - session the banner is about.
     * @param {string} [options.kind] - turn-end | question | test | notice.
     * @returns {boolean} whether the banner was shown.
     */
    function showInAppNotice({ title, body = "", sessionId = "", kind = "notice" }) {
      if (!pageVisible()) return false;
      let primitives;
      let createRoot;
      try {
        primitives = require("@deepseek-ai/dsh-client-ui-primitives");
        ({ createRoot } = require("react-dom/client"));
      } catch {
        // Without the primitives (an older shell) there is nothing to render.
        return false;
      }
      if (typeof primitives?.Toast !== "function") return false;
      if (noticeHost === null) {
        noticeHost = document.createElement("div");
        noticeHost.setAttribute("data-rdsh-notice-host", "");
        document.body.append(noticeHost);
      }
      if (noticeRoot === null) noticeRoot = createRoot(noticeHost);
      const openSession = () => {
        if (sessionId !== "") requestSession(sessionId);
        // A banner that was acted on should not linger.
        noticeRoot?.render(null);
      };
      noticeRoot.render(h(
        primitives.Toast,
        {
          // The session name is the headline; the detail is what happened.
          text: body === "" ? title : `${title} — ${body}`,
          holdMs: kind === "question" ? 6000 : 4200,
          actions: sessionId === ""
            ? undefined
            : [{ label: t("notify.open"), prefix: " ", onClick: openSession }],
          // The component owns its lifetime; this clears the tree afterwards.
          onDone: () => {
            noticeRoot?.render(null);
          },
        },
      ));
      return true;
    }

    /**
     * Deliver one notification through the right channel.
     *
     * On screen → in-app banner (plus the sound). Otherwise the service worker
     * has already turned it into a system notification, so this only runs the
     * sound when the page is allowed to make one.
     *
     * @param {object} notice - `{ title, body, sessionId, kind }`.
     */
    function notifyUser(notice) {
      // A banner only appears while the page is on screen, so the sound rides
      // with it; a backgrounded page lets the service worker make its own noise.
      if (!pageVisible()) return false;
      playNoticeSound(notice.kind === "question" ? "pop" : readSoundPreset());
      return showInAppNotice(notice);
    }

    // --- Session selection -------------------------------------------------

    /** How long a selected session is re-asserted after a notification tap. */
    const SESSION_CONFIRM_MS = 15000;
    /** Set while this module is opening a session, to stop re-entrancy. */
    let selectingSession = false;
    /** The session a notification asked for, until the DOM shows it. */
    let wantedSession = "";
    let wantedUntil = 0;
    let sessionOpener = null;

    /**
     * Ask for one session to be opened.
     *
     * The SPA has no URL routing for sessions, so the only way in is
     * `uiWorkspace.openSession`. Opening during boot loses a race against the
     * SPA restoring its own last session, so the request is re-asserted until
     * the chat actually shows that session.
     *
     * @param {string} sessionId - session to select.
     */
    function requestSession(sessionId) {
      if (typeof sessionId !== "string" || sessionId === "") return;
      if (sessionId === currentSessionId) return;
      wantedSession = sessionId;
      wantedUntil = Date.now() + SESSION_CONFIRM_MS;
      sessionOpener?.();
    }

    /** The session the chat is currently showing, read from the DOM. */
    function shownSessionId() {
      try {
        return document.querySelector("[data-conversation-session]")?.getAttribute("data-conversation-session") ?? "";
      } catch {
        return "";
      }
    }

    /**
     * Bind session selection to the client services.
     *
     * @param {object} scope - injected context carrying `uiWorkspace`.
     */
    function attachSessionOpener(scope) {
      const uiWorkspace = scope.get("uiWorkspace");
      if (uiWorkspace === undefined) return;
      const sessions = typeof scope.get === "function" ? scope.get("sessions") : undefined;
      // A session the catalog does not know cannot be opened; when there is no
      // catalog, trying is still safe because retain() rejects unknown ids.
      const known = (id) => {
        if (sessions === undefined) return true;
        try {
          return sessions?.list?.getSnapshot()?.byId?.[id] !== undefined;
        } catch {
          return true;
        }
      };
      /**
       * Select once, guarded.
       *
       * `openSession` retains the session, which publishes a new list snapshot,
       * which can call back in synchronously. Without the guard that nests
       * until the stack overflows and nothing is ever opened.
       */
      sessionOpener = () => {
        if (selectingSession) return;
        if (wantedSession === "") return;
        const id = wantedSession;
        if (!known(id)) {
          wantedSession = "";
          return;
        }
        selectingSession = true;
        try {
          uiWorkspace.openSession(id);
        } catch {
          // The workspace is not ready yet; the timer keeps retrying.
          selectingSession = false;
          return;
        }
        selectingSession = false;
      };
      // Boot restores its own session after ours, so keep asserting until the
      // chat shows the one that was asked for, then stop.
      const timer = setInterval(() => {
        if (wantedSession === "") return;
        if (shownSessionId() === wantedSession) {
          wantedSession = "";
          return;
        }
        if (Date.now() > wantedUntil) {
          wantedSession = "";
          return;
        }
        sessionOpener?.();
      }, 500);
      scope.effect?.(() => () => clearInterval(timer));
    }

    /** Read `?session=` once, then drop it from the address bar. */
    function sessionFromUrl() {
      try {
        const url = new URL(location.href);
        const id = url.searchParams.get("session");
        if (id === null || id === "") return "";
        url.searchParams.delete("session");
        history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
        return id;
      } catch {
        return "";
      }
    }

    /**
     * Route a service-worker message to the right handler.
     *
     * Two shapes arrive here: a notification the worker declined to show
     * because a window was visible, and a click on a system notification.
     *
     * @param {MessageEvent} event - message from the worker.
     */
    function onWorkerMessage(event) {
      const data = event?.data;
      if (data === null || typeof data !== "object") return;
      if (data.type === "rdsh-pwa:notify") {
        const shown = notifyUser({
          title: typeof data.title === "string" ? data.title : "DSH",
          body: typeof data.body === "string" ? data.body : "",
          sessionId: typeof data.sessionId === "string" ? data.sessionId : "",
          kind: typeof data.kind === "string" ? data.kind : "notice",
        });
        // The worker shows a system banner unless we take the notification, so
        // acknowledge only when a banner was actually rendered.
        if (shown) event?.ports?.[0]?.postMessage("shown");
        return;
      }
      if (data.type === "rdsh-pwa:open-session" || data.type === "dsh-notify-push:open-session") {
        // The second name is the previous plugin's; still honoured so a banner
        // already on screen keeps working after this package takes over.
        requestSession(typeof data.sessionId === "string" ? data.sessionId : "");
      }
    }

    // ---------------------------------------------------------------------
    // UI: Settings section
    // ---------------------------------------------------------------------
    function PermissionLabel(status) {
      if (!status.supported) return t("notify.permission.unsupported");
      if (status.permission === "granted") return status.subscribed ? t("notify.permission.granted") : t("notify.permission.allowed");
      if (status.permission === "denied") return t("notify.permission.blocked");
      return t("notify.permission.default");
    }

    function MobileSection() {
      const s = useStore();
      // #15: the phone-only rows and the "hidden controls" card are decided by
      // the device, not the window width, so a desktop never reads "this is
      // what we hide from you" about controls that are all visible.
      const onPhone = s.phone === true;
      const [message, setMessage] = useState("");
      const [busy, setBusy] = useState(false);
      const [disabled, setDisabled] = useState(hideDisabled());
      const [extra, setExtra] = useState(readHideExtra().join("\n"));
      const [sound, setSound] = useState(readSoundPreset);
      const [volume, setVolume] = useState(readSoundVolume);

      useEffect(() => {
        void refreshNotificationStatus();
      }, []);

      const run = async (action, success) => {
        setBusy(true);
        setMessage("");
        try {
          await action();
          setMessage(success);
        } catch (error) {
          setMessage(String((error && error.message) || error));
        } finally {
          setBusy(false);
          scheduleDecorate();
        }
      };

      const saveExtra = () => {
        const labels = extra.split("\n").map((line) => line.trim()).filter((line) => line !== "");
        try {
          localStorage.setItem(HIDE_EXTRA_KEY, JSON.stringify(labels));
        } catch {
          /* private mode: the list only lives for this page */
        }
        scheduleDecorate();
        setMessage(t("notify.hideListSaved"));
      };

      const toggleDisabled = (value) => {
        setDisabled(value);
        try {
          if (value) localStorage.setItem(HIDE_OVERRIDE_KEY, "1");
          else localStorage.removeItem(HIDE_OVERRIDE_KEY);
        } catch {
          /* ignore */
        }
        scheduleDecorate();
      };

      return h(
        "section",
        { className: "rdsh-mux-section" },
        h(
          "div",
          { className: "rdsh-mux-card" },
          h("h3", { className: "rdsh-mux-title" }, t("mux.deviceTheme.title")),
          h("p", { className: "rdsh-mux-desc" }, t("mux.deviceTheme.desc")),
          h(
            "label",
            { className: "rdsh-mux-slider" },
            h("span", null, t("mux.deviceTheme.label")),
            h(
              "select",
              {
                className: "rdsh-mux-select",
                value: s.deviceTheme,
                onChange: (event) => writeDeviceTheme(event.target.value),
              },
              Object.entries(DEVICE_THEME_KEYS).map(([id, key]) => h("option", { key: id, value: id }, t(key))),
            ),
          ),
          h("p", { className: "rdsh-mux-note" }, t("mux.deviceTheme.note")),
          s.deviceThemeNote === "custom"
            ? h("p", { className: "rdsh-mux-note" }, t("mux.deviceTheme.custom"))
            : null,
          s.deviceThemeNote === "unsupported"
            ? h("p", { className: "rdsh-mux-note" }, t("mux.deviceTheme.unsupported"))
            : null,
        ),
        h(
          "div",
          { className: "rdsh-mux-card" },
          h("h3", { className: "rdsh-mux-title" }, t("mux.section.title")),
          // #15: on a desktop this card must not describe a layout it is not
          // running, and the layout row is a phone/window fact. The
          // notification controls below stay: they are useful everywhere.
          h("p", { className: "rdsh-mux-desc" }, onPhone ? t("mux.section.desc") : t("mux.section.desc.desktop")),
          onPhone ? h("p", { className: "rdsh-mux-note" }, t("mux.section.plusNote")) : null,
          h(
            "dl",
            { className: "rdsh-mux-rows" },
            onPhone
              ? h(
                React.Fragment,
                null,
                h("dt", null, t("mux.row.layout")),
                h("dd", null, s.narrow ? t("mux.row.layout.narrow") : t("mux.row.layout.wide")),
              )
              : null,
            h("dt", null, t("mux.row.sessions")),
            h("dd", null, s.drawerOpen ? t("mux.row.sessions.open") : t("mux.row.sessions.closed")),
            h("dt", null, t("mux.row.notifications")),
            h("dd", null, PermissionLabel(s.notifications)),
            h("dt", null, t("mux.row.build")),
            h("dd", null, BUILD),
          ),
          h(
            "div",
            { className: "rdsh-mux-actions" },
            h("button", {
              type: "button",
              className: "rdsh-mux-primary",
              disabled: busy || !s.notifications.supported,
              onClick: () => run(enableNotifications, t("mux.message.enabled")),
            }, s.notifications.permission === "granted" ? t("mux.action.reRegister") : t("mux.action.enable")),
            h("button", {
              type: "button",
              disabled: busy || s.notifications.permission !== "granted",
              onClick: () => run(sendTestNotification, t("mux.message.testSent")),
            }, t("mux.action.test")),
            s.notifications.permission === "granted"
              ? h("button", {
                type: "button",
                disabled: busy,
                onClick: () => run(disableNotifications, t("mux.message.disabled")),
              }, t("mux.action.disable"))
              : null,
          ),
          s.notifications.permission === "denied"
            ? h("p", { className: "rdsh-mux-note" }, t("mux.note.blocked"))
            : null,
          h("h4", { className: "rdsh-mux-subtitle" }, t("mux.sound.title")),
          h("p", { className: "rdsh-mux-desc" }, t("mux.sound.desc")),
          h(
            "div",
            { className: "rdsh-mux-sound-row" },
            h(
              "select",
              {
                className: "rdsh-mux-select",
                value: sound,
                onChange: (event) => {
                  const next = event.target.value;
                  setSound(next);
                  try {
                    localStorage.setItem(SOUND_KEY, next);
                  } catch {
                    /* private mode */
                  }
                  // Preview immediately: picking a sound you cannot hear is
                  // guesswork.
                  playNoticeSound(next, volume);
                },
              },
              Object.entries(SOUND_PRESETS).map(([id, preset]) => h("option", { key: id, value: id }, preset.label)),
            ),
            h("button", {
              type: "button",
              className: "rdsh-mux-secondary",
              onClick: () => playNoticeSound(sound, volume),
            }, t("mux.sound.preview")),
          ),
          h(
            "label",
            { className: "rdsh-mux-slider" },
            h("span", null, t("mux.sound.volume")),
            h("input", {
              type: "range",
              min: "0",
              max: "100",
              step: "5",
              value: String(Math.round(volume * 100)),
              onChange: (event) => {
                const next = Number(event.target.value) / 100;
                setVolume(next);
                try {
                  localStorage.setItem(VOLUME_KEY, String(next));
                } catch {
                  /* private mode */
                }
              },
              onPointerUp: () => playNoticeSound(sound, volume),
            }),
            h("span", { className: "rdsh-mux-slider-value" }, `${Math.round(volume * 100)}%`),
          ),
          // #15: the host defaults to `onlyMobileTurns: true`, so a desktop
          // send is never notified unless this browser opts in.
          h(
            "label",
            { className: "rdsh-mux-check" },
            h("input", {
              type: "checkbox",
              checked: s.notifyDeviceTurns === true,
              onChange: (event) => writeNotifyDeviceTurns(event.target.checked),
            }),
            t("mux.notify.deviceTurns"),
          ),
          h("p", { className: "rdsh-mux-note" }, t("mux.notify.deviceTurns.note")),
          h("p", { className: "rdsh-mux-note" }, t("mux.note.notifyScope")),
          message !== "" ? h("p", { className: "rdsh-mux-note" }, message) : null,
        ),
        onPhone
          ? h(
            "div",
            { className: "rdsh-mux-card" },
            h("h3", { className: "rdsh-mux-title" }, t("mux.hidden.title")),
            h("p", { className: "rdsh-mux-desc" }, t("mux.hidden.desc")),
            h(
              "div",
              { className: "rdsh-mux-chips" },
              s.hidden.length === 0
                ? h("span", { className: "rdsh-mux-chip" }, t("mux.hidden.none"))
                : s.hidden.map((label) => h("span", { className: "rdsh-mux-chip", key: label }, label)),
            ),
            h(
              "label",
              { className: "rdsh-mux-check" },
              h("input", { type: "checkbox", checked: disabled, onChange: (event) => toggleDisabled(event.target.checked) }),
              t("mux.hidden.disable"),
            ),
            h("div", null,
              h("div", { className: "rdsh-mux-label" }, t("mux.hidden.extra")),
              h("textarea", {
                value: extra,
                rows: 3,
                spellCheck: false,
                onChange: (event) => setExtra(event.target.value),
                className: "rdsh-mux-textarea",
              }),
            ),
            h("div", { className: "rdsh-mux-actions" },
              h("button", { type: "button", onClick: saveExtra }, t("mux.hidden.save")),
            ),
          )
          : null,
        // #15: the PWA and Input sections are registered as their own tabs.
        // Inlining them into "Mobile" as well duplicated every heading on a
        // desktop, where none of the three tabs are merged. Both halves of the
        // merge must agree: `applyHideList` hides those tabs under the same
        // `narrow() && phone()` condition.
        s.narrow && onPhone ? h(InputSection) : null,
        s.narrow && onPhone && typeof globalThis.__RDSH_PWA_SETTINGS_SECTION__ === "function"
          ? h(globalThis.__RDSH_PWA_SETTINGS_SECTION__)
          : null,
        s.bootError !== "" ? h("p", { className: "rdsh-mux-note" }, t("mux.bootError", { error: s.bootError })) : null,
      );
    }

    function InputSection() {
      const s = useStore();
      return h(
        "section",
        { className: "rdsh-mux-section" },
        h(
          "div",
          { className: "rdsh-mux-card" },
          h("h3", { className: "rdsh-mux-title" }, t("mux.input.title")),
          h("p", { className: "rdsh-mux-desc" }, t("mux.input.desc")),
          h(
            "label",
            { className: "rdsh-mux-check" },
            h("input", {
              type: "checkbox",
              checked: s.enterToSend,
              onChange: (event) => writeEnterToSend(event.target.checked),
            }),
            t("mux.input.enterToSend"),
          ),
          h("p", { className: "rdsh-mux-note" }, s.enterToSend
            ? t("mux.input.current.enterSends")
            : t("mux.input.current.enterNewline")),
        ),
      );
    }

    function LiveSpeed({ sessionId }) {
      // Re-render on media changes (boot emits `narrow`), so the label appears
      // and disappears with the layout instead of polling on a desktop.
      const store = useStore();
      const phone = store.narrow;
      const [speed, setSpeed] = useState(null);
      useEffect(() => {
        currentSessionId = typeof sessionId === "string" && sessionId !== "" ? sessionId : null;
        return () => {
          if (currentSessionId === sessionId) currentSessionId = null;
        };
      }, [sessionId]);
      useEffect(() => {
        if (!sessionId || !phone) {
          setSpeed(null);
          return undefined;
        }
        let active = true;
        const update = async () => {
          try {
            const response = await fetch(`/api/rdsh-mobile-ux/live-speed?sessionId=${encodeURIComponent(sessionId)}`, { cache: "no-store" });
            if (!response.ok) {
              if (active) setSpeed(null);
              return;
            }
            const data = await response.json();
            if (active) setSpeed(Number.isFinite(data?.tps) && data.tps > 0 ? Math.round(data.tps) : null);
          } catch {
            if (active) setSpeed(null);
          }
        };
        void update();
        const timer = window.setInterval(() => void update(), 500);
        return () => {
          active = false;
          window.clearInterval(timer);
        };
      }, [sessionId, phone]);
      if (!phone || speed === null) return null;
      return h("span", {
        className: "rdsh-mux-live-speed",
        title: t("mux.liveSpeed.title"),
        "aria-label": t("mux.liveSpeed.aria", { speed }),
      }, `≈ ${speed} tok/s`);
    }

    // ---------------------------------------------------------------------
    // Styles
    // ---------------------------------------------------------------------
    const CSS = `
.rdsh-mux-live-speed { color: var(--dsw-alias-label-secondary, #a1a1aa); font-size: 11px; white-space: nowrap; }
.rdsh-mux-fab {
  position: fixed; left: 8px; top: calc(env(safe-area-inset-top, 0px) + 8px);
  width: 40px; height: 40px; border: 0; border-radius: 12px; z-index: 40;
  display: none; align-items: center; justify-content: center;
  color: var(--dsw-alias-label-primary, #f9fafb);
  background: var(--dsw-alias-bg-module-platform, #26262a);
  box-shadow: var(--dsw-shadow-lv2, 0 4px 12px rgba(0,0,0,.08));
  -webkit-tap-highlight-color: transparent; cursor: pointer;
}
.rdsh-mux-fab:active { transform: scale(.96); }
.rdsh-mux-fab-badge {
  position: absolute; top: -5px; right: -5px;
  min-width: 18px; height: 18px; padding: 0 4px;
  border-radius: 9px; box-sizing: border-box;
  background: var(--dsw-alias-state-error-primary, #ef4444);
  color: var(--dsw-alias-toast-label, #fff);
  font: 700 10px/14px -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif;
  text-align: center; white-space: nowrap;
  border: 2px solid var(--dsw-alias-bg-base, #151517);
  box-shadow: var(--dsw-shadow-lv1, 0 2px 4px rgba(0,0,0,.05));
  display: none; pointer-events: none;
}
.rdsh-mux-fab-badge[data-visible] { display: block; }
/* Phones only. A colour frame is a phone affordance (it stands in for the
   sidebar's activity dot while the drawer is closed); on a wide screen the
   stock sidebar already shows the session's state. */
@media ${NARROW_QUERY} {
  [data-rdsh-session-frame] {
    box-shadow: inset 0 0 0 2px var(--rdsh-session-frame) !important;
  }
}
.rdsh-frame-menu-item {
  width: 100%; display: flex; align-items: center; gap: 10px;
  padding: 8px 12px; border: 0; border-radius: 8px;
  background: transparent; color: var(--dsw-alias-label-primary, #f9fafb);
  font: inherit; font-size: 13px; text-align: left; cursor: pointer;
}
.rdsh-frame-menu-item:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08)); }
.rdsh-frame-menu-icon { display: grid; place-items: center; width: 16px; height: 16px; opacity: .9; }
.rdsh-frame-backdrop { position: fixed; inset: 0; z-index: 900; background: transparent; }
.rdsh-frame-pop {
  position: fixed; z-index: 901; width: 252px; box-sizing: border-box;
  padding: 12px; border-radius: 14px;
  background: var(--dsw-alias-bg-layer-2, #2c2c2e); color: var(--dsw-alias-label-primary, #f9fafb);
  border: .5px solid var(--dsw-alias-border-l3, rgba(0,0,0,.12));
  box-shadow: var(--dsw-elevation-prominent, 0 14px 40px rgba(0,0,0,.3));
}
.rdsh-frame-pop-title { font-size: 12px; color: var(--dsw-alias-label-secondary, #cfd3d6); margin-bottom: 10px; }
.rdsh-frame-swatches { display: flex; flex-wrap: wrap; gap: 8px; }
.rdsh-frame-swatch {
  width: 30px; height: 30px; border-radius: 999px !important;
  border: 2px solid transparent; padding: 0; cursor: pointer;
}
.rdsh-frame-swatch[data-current="true"] { border-color: var(--dsw-alias-label-primary, #f9fafb); box-shadow: 0 0 0 2px var(--dsw-alias-bg-layer-2, #2c2c2e), 0 0 0 3px var(--dsw-alias-label-primary, #f9fafb); }
.rdsh-frame-clear {
  width: 100%; margin-top: 12px; padding: 8px 10px;
  border: .5px solid var(--dsw-alias-border-l3, rgba(255,255,255,.16)); border-radius: 8px;
  background: transparent; color: var(--dsw-alias-label-primary, #f9fafb);
  font: inherit; font-size: 12px; cursor: pointer;
}

.rdsh-mux-backdrop {
  position: fixed; inset: 0; z-index: 45; display: none;
  /* A light dim so the drawer reads as the active surface. No fade: the
     dimming is a state change, and fading it looked like a second sheet
     sliding in behind the drawer. */
  background: var(--dsw-alias-bg-mask-1, rgba(0,0,0,.24)); opacity: 0; pointer-events: none;
}

.rdsh-mux-detail {
  position: fixed; z-index: 990; box-sizing: border-box;
  padding: 10px 12px 12px; border-radius: 12px;
  background: var(--dsw-alias-bg-layer-2, #2c2c2e) !important;
  color: var(--dsw-alias-label-primary, #f9fafb);
  border: .5px solid var(--dsw-alias-border-l3, rgba(0,0,0,.12));
  box-shadow: var(--dsw-elevation-prominent, 0 10px 30px rgba(0,0,0,.3));
  font-size: 13px; line-height: 1.55; overflow-wrap: anywhere;
  max-height: min(50dvh, 380px); overflow-y: auto;
  animation: rdsh-mux-pop .14s ease-out;
}
.rdsh-mux-detail-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.rdsh-mux-detail-title {
  font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
  color: var(--dsw-alias-label-tertiary, #a1a1aa);
}
.rdsh-mux-detail-meta {
  font-size: 11px; color: var(--dsw-alias-label-tertiary, #a1a1aa);
  border: .5px solid var(--dsw-alias-border-l3, rgba(255,255,255,.16));
  border-radius: 999px; padding: 1px 6px;
}
.rdsh-mux-detail-body { white-space: pre-wrap; }

.rdsh-mux-titlepop {
  position: fixed; z-index: 980; box-sizing: border-box;
  padding: 10px 12px; border-radius: 12px;
  background: var(--dsw-alias-bg-layer-2, #2c2c2e) !important;
  color: var(--dsw-alias-label-primary, #f9fafb);
  border: .5px solid var(--dsw-alias-border-l3, rgba(0,0,0,.12));
  box-shadow: var(--dsw-elevation-prominent, 0 10px 30px rgba(0,0,0,.3));
  font-size: 13px; line-height: 1.5; overflow-wrap: anywhere;
  animation: rdsh-mux-pop .14s ease-out;
}
@keyframes rdsh-mux-pop { from { opacity: 0; transform: translateY(-4px) } to { opacity: 1; transform: none } }

/* Image lightbox: keep the close/crop controls below the camera housing,
   shrink the image into the remaining safe area, and darken the backdrop.
   The viewer is a desktop surface too, so these stay on the phone. */
@media ${NARROW_QUERY} {
  [data-rdsh-lightbox] { background: rgba(0,0,0,.96) !important; }
  [data-rdsh-lightbox] [class*="_mask_"] { background: rgba(0,0,0,.96) !important; }
  [data-rdsh-lightbox] [class*="_close_"] {
    z-index: 5;
    top: calc(env(safe-area-inset-top, 0px) + 12px) !important;
    right: 16px !important;
    width: 40px !important; height: 40px !important;
    border-radius: 50% !important;
    background: rgba(44,44,46,.95) !important;
  }
  [data-rdsh-lightbox] [class*="_image_"] {
    max-height: calc(100dvh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 104px) !important;
    max-width: calc(100vw - 24px) !important;
  }
  [data-rdsh-crop-button] {
    position: absolute; z-index: 5; top: calc(env(safe-area-inset-top, 0px) + 12px); left: 16px;
    width: 40px; height: 40px; border: 0; border-radius: 50%;
    background: rgba(44,44,46,.95); color: #f9fafb;
    display: grid; place-items: center; z-index: 2; padding: 0;
  }
}
.rdsh-crop-overlay {
  position: fixed; inset: 0; z-index: 1200;
  display: flex; flex-direction: column;
  background: #000; color: #f9fafb;
  padding-top: env(safe-area-inset-top, 0px);
  padding-bottom: env(safe-area-inset-bottom, 0px);
}
.rdsh-crop-head {
  position: relative; z-index: 3;
  flex: 0 0 auto; height: 52px; padding: 0 12px 0 16px;
  display: flex; align-items: center; justify-content: space-between;
  font-size: 15px;
}
.rdsh-crop-close {
  width: 40px; height: 40px; border: 0; border-radius: 50%;
  background: rgba(44,44,46,.95); color: #f9fafb; font-size: 22px; line-height: 1;
}
.rdsh-crop-head-actions { display: flex; align-items: center; gap: 4px; }
.rdsh-crop-rotate {
  width: 40px; height: 40px; border: 0; border-radius: 50%;
  background: rgba(44,44,46,.95); color: #f9fafb;
  display: grid; place-items: center; padding: 0;
}
.rdsh-crop-stage {
  flex: 1 1 auto; min-height: 0; display: flex;
  align-items: center; justify-content: center; padding: 12px;
}
.rdsh-crop-wrap { position: relative; line-height: 0; max-width: 100%; max-height: 100%; }
.rdsh-crop-image {
  display: block; max-width: 100%; max-height: 100%;
  user-select: none; -webkit-user-select: none; -webkit-user-drag: none;
}
.rdsh-crop-box {
  position: absolute; box-sizing: border-box;
  border: 1.5px solid #fff; cursor: move; touch-action: none;
  box-shadow: 0 0 0 9999px rgba(0,0,0,.55);
}
.rdsh-crop-box::before {
  content: ""; position: absolute; inset: 0; pointer-events: none;
  background-image:
    linear-gradient(to right, transparent calc(33.33% - .5px), rgba(255,255,255,.35) calc(33.33% - .5px), rgba(255,255,255,.35) calc(33.33% + .5px), transparent calc(33.33% + .5px), transparent calc(66.66% - .5px), rgba(255,255,255,.35) calc(66.66% - .5px), rgba(255,255,255,.35) calc(66.66% + .5px), transparent calc(66.66% + .5px)),
    linear-gradient(to bottom, transparent calc(33.33% - .5px), rgba(255,255,255,.35) calc(33.33% - .5px), rgba(255,255,255,.35) calc(33.33% + .5px), transparent calc(33.33% + .5px), transparent calc(66.66% - .5px), rgba(255,255,255,.35) calc(66.66% - .5px), rgba(255,255,255,.35) calc(66.66% + .5px), transparent calc(66.66% + .5px));
}
.rdsh-crop-handle {
  position: absolute; width: 24px; height: 24px; box-sizing: border-box;
  border: 2px solid #fff; border-radius: 50%;
  background: rgba(0,0,0,.35); touch-action: none;
}
.rdsh-crop-handle[data-corner="nw"] { left: -12px; top: -12px; cursor: nwse-resize; }
.rdsh-crop-handle[data-corner="ne"] { right: -12px; top: -12px; cursor: nesw-resize; }
.rdsh-crop-handle[data-corner="sw"] { left: -12px; bottom: -12px; cursor: nesw-resize; }
.rdsh-crop-handle[data-corner="se"] { right: -12px; bottom: -12px; cursor: nwse-resize; }
.rdsh-crop-actions {
  position: relative; z-index: 3;
  flex: 0 0 auto; display: flex; gap: 10px; padding: 12px 16px;
}
.rdsh-crop-actions button {
  flex: 1 1 0; height: 46px; border: 0; border-radius: 12px;
  font: inherit; font-size: 15px; font-weight: 600;
}
.rdsh-crop-cancel { background: #2c2c2e; color: #f9fafb; }
.rdsh-crop-save { background: #f9fafb; color: #151517; }

.rdsh-mux-toast {
  position: fixed; z-index: 960; left: 50%;
  bottom: calc(max(env(safe-area-inset-bottom, 0px), var(--rdsh-safe-bottom, 0px)) + 104px);
  max-width: calc(100vw - 48px); box-sizing: border-box;
  padding: 9px 14px; border-radius: 999px;
  background: var(--dsw-alias-toast-bg, #353638); color: var(--dsw-alias-toast-label, #f9fafb);
  border: .5px solid var(--dsw-alias-border-l3, rgba(255,255,255,.16));
  font-size: 13px; line-height: 1.4; text-align: center; pointer-events: none;
  opacity: 0; transform: translateX(-50%) translateY(6px);
  transition: opacity .16s ease, transform .16s ease;
}
.rdsh-mux-toast[data-show] { opacity: 1; transform: translateX(-50%); }

.rdsh-mux-section { display: flex; flex-direction: column; gap: 12px; color: var(--dsw-alias-label-primary, #f9fafb); }
.rdsh-mux-card {
  border: .5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l3, rgba(255,255,255,.12)));
  background: var(--dsw-alias-settings-card-fill, transparent);
  border-radius: 12px; padding: 12px 14px;
  display: flex; flex-direction: column; gap: 10px;
}
.rdsh-mux-title { margin: 0; font-size: 16px; font-weight: 500; }
.rdsh-mux-desc { margin: 0; font-size: 13px; line-height: 1.6; color: var(--dsw-alias-label-tertiary, #adb2b8); }
.rdsh-mux-rows { display: grid; grid-template-columns: max-content minmax(0,1fr); gap: 6px 14px; margin: 0; font-size: 13px; }
.rdsh-mux-rows dt { color: var(--dsw-alias-label-secondary, #cfd3d6); }
.rdsh-mux-rows dd { margin: 0; overflow-wrap: anywhere; }
.rdsh-mux-secondary {
  flex: 0 0 auto; padding: 8px 12px; border-radius: 9px;
  font: inherit; font-size: 13px; cursor: pointer;
  color: var(--dsw-alias-label-primary, #f9fafb);
  background: var(--dsw-alias-bg-layer-2, #26262a);
  border: .5px solid var(--dsw-alias-border-l3, rgba(255,255,255,.16));
}
.rdsh-mux-slider {
  display: flex; align-items: center; gap: 10px; margin: 0 0 8px;
  font-size: 13px; color: var(--dsw-alias-label-secondary, #cfd3d6);
}
.rdsh-mux-slider input[type="range"] { flex: 1 1 auto; min-width: 0; accent-color: var(--dsw-alias-link, #4d6bfe); }
.rdsh-mux-slider-value {
  flex: 0 0 auto; min-width: 42px; text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-primary, #f9fafb);
}
.rdsh-mux-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.rdsh-mux-actions button, .rdsh-mux-card > button {
  font: inherit; font-size: 13px; min-height: 34px; padding: 0 14px; border-radius: 9px; cursor: pointer;
  border: .5px solid var(--dsw-alias-border-l3, rgba(255,255,255,.16));
  background: transparent; color: var(--dsw-alias-label-primary, #f9fafb);
}
.rdsh-mux-actions button:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08)); }
.rdsh-mux-subtitle {
  margin: 16px 0 6px; font-size: 13px; font-weight: 600;
  color: var(--dsw-alias-label-primary, #f9fafb);
}
.rdsh-mux-sound-row { display: flex; align-items: center; gap: 8px; margin: 8px 0 10px; }
.rdsh-mux-select {
  flex: 1 1 auto; min-width: 0; box-sizing: border-box;
  padding: 8px 10px; border-radius: 9px; font: inherit; font-size: 13px;
  color: var(--dsw-alias-label-primary, #f9fafb);
  background: var(--dsw-alias-bg-layer-2, #26262a);
  border: .5px solid var(--dsw-alias-border-l3, rgba(255,255,255,.16));
  -webkit-appearance: none; appearance: none;
}
.rdsh-mux-actions button.rdsh-mux-primary {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill, #f9fafb);
  color: var(--dsw-alias-label-primary-foreground, #151517);
}
.rdsh-mux-actions button:disabled { opacity: .45; cursor: default; }
.rdsh-mux-note { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-tertiary, #adb2b8); }
.rdsh-mux-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.rdsh-mux-chip { font-size: 12px; padding: 3px 9px; border-radius: 999px; background: var(--dsw-alias-bg-module-platform, #353638); color: var(--dsw-alias-label-secondary, #cfd3d6); }
.rdsh-mux-check { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.rdsh-mux-label { font-size: 12px; font-weight: 600; margin-bottom: 4px; color: var(--dsw-alias-label-secondary, #cfd3d6); }
.rdsh-mux-textarea {
  box-sizing: border-box; width: 100%; font: inherit; font-size: 13px; padding: 6px 8px;
  border-radius: 8px; resize: vertical;
  background: var(--dsw-alias-bg-module-platform, #353638);
  color: var(--dsw-alias-label-primary, #f9fafb);
  border: .5px solid var(--dsw-alias-border-l3, rgba(255,255,255,.16));
}

/* Everything from here to the safe-area block below dresses upstream DOM the
   phone view rearranges: the running-session animation, the open row's fill,
   the header sheen, toasts and the typing effect. None of it has a meaning on
   a desktop sidebar, so it is inside the phone query rather than wrapped
   around it. The body is not re-indented: this is a scope change, and keeping
   the lines untouched keeps the review to the two braces. */
@media ${NARROW_QUERY} {
/* Running session: animate the label itself, never the whole row. */
html:not([data-rdsh-anim="none"]) [data-rdsh-running] [data-rdsh-status] { display: none !important; }
[data-rdsh-running] [data-rdsh-session-title] {
  position: relative; border-radius: 8px; isolation: isolate;
}
[data-rdsh-running] [data-rdsh-session-title]::before {
  content: ""; position: absolute; inset: -3px -6px; z-index: -1; border-radius: 8px;
  background: linear-gradient(100deg,
    transparent 10%,
    color-mix(in srgb, var(--dsw-alias-link, #7aaaff) 45%, transparent) 42%,
    color-mix(in srgb, var(--dsw-alias-label-deep-diving, #a78bfa) 40%, transparent) 58%,
    transparent 90%);
  background-size: 220% 100%;
  animation: rdsh-mux-aurora 3.6s ease-in-out infinite;
  filter: blur(4px); opacity: .95;
}
[data-rdsh-running] [data-rdsh-session-title]::after {
  content: ""; position: absolute; left: -7px; top: 4px; bottom: 4px; width: 2px; border-radius: 2px;
  background: linear-gradient(180deg, var(--dsw-alias-link, #7aaaff), var(--dsw-alias-label-deep-diving, #a78bfa));
  box-shadow: 0 0 8px rgba(122,170,255,.7);
  animation: rdsh-mux-pulse 2.4s ease-in-out infinite;
}
@keyframes rdsh-mux-aurora {
  0% { background-position: 120% 0; opacity: .35 }
  50% { background-position: -20% 0; opacity: .9 }
  100% { background-position: -120% 0; opacity: .35 }
}
@keyframes rdsh-mux-pulse { 0%,100% { opacity: .45 } 50% { opacity: 1 } }
/* Variant: a quiet breathing label with a left activity bar. */
html[data-rdsh-anim="breathing"] [data-rdsh-running] [data-rdsh-session-title]::before {
  background: none; filter: none; opacity: 0;
}
html[data-rdsh-anim="breathing"] [data-rdsh-running] [data-rdsh-session-title] {
  animation: rdsh-mux-breathe 5.6s ease-in-out infinite;
}
@keyframes rdsh-mux-breathe {
  0%, 100% { color: var(--dsw-alias-label-primary, #f9fafb); text-shadow: none }
  50% { color: var(--dsw-alias-label-secondary, #cfd3d6); text-shadow: 0 0 10px rgba(122,170,255,.35) }
}

/* Variant B of mockups/animation-outline.html. The animated layer is a
   normal transform rotation, not an @property angle inside a conic-gradient.
   Safari/iOS reliably animates transforms; custom-property interpolation in
   background images is the part that stayed static. */
html[data-rdsh-anim="outline"] [data-rdsh-running] [data-rdsh-session-title]::before,
html[data-rdsh-anim="outline"] [data-rdsh-running] [data-rdsh-session-title]::after { display: none !important; }
html[data-rdsh-anim="outline"] [data-rdsh-ring-row] {
  --rdsh-ring-fill: var(--dsw-specific-sidebar-nav-item-hover, #f1f3f5);
  position: relative !important;
  isolation: isolate;
  overflow: hidden;
  border: 0 !important;
  border-radius: 12px !important;
  box-sizing: border-box;
  background: var(--rdsh-ring-fill) !important;
}
html[data-rdsh-anim="outline"] [data-rdsh-ring-row]::before {
  content: "";
  position: absolute;
  left: 50%; top: 50%;
  width: 170%; aspect-ratio: 1;
  z-index: 0;
  background: conic-gradient(
    from 0deg,
    transparent 0deg,
    transparent 215deg,
    color-mix(in srgb, var(--dsw-alias-link, #7aaaff) 14%, transparent) 235deg,
    color-mix(in srgb, var(--dsw-alias-link, #7aaaff) 68%, transparent) 268deg,
    var(--dsw-alias-link, #7aaaff) 292deg,
    color-mix(in srgb, var(--dsw-alias-link, #7aaaff) 30%, transparent) 315deg,
    transparent 336deg,
    transparent 360deg
  );
  transform: translate(-50%, -50%) rotate(0deg);
  animation: rdsh-ring-rotate 2.8s linear infinite;
  pointer-events: none;
}
html[data-rdsh-anim="outline"] [data-rdsh-ring-row]::after {
  content: "";
  position: absolute;
  inset: 2px;
  z-index: 0;
  border-radius: 10px;
  background: var(--rdsh-ring-fill);
  pointer-events: none;
}
html[data-rdsh-anim="outline"] [data-rdsh-ring-row] > * {
  position: relative;
  z-index: 1;
}
/* Yellow only while a running session is also the open one. */
html[data-rdsh-anim="outline"] [data-rdsh-ring-row][aria-selected="true"] {
  --rdsh-ring-fill: var(--dsw-specific-sidebar-nav-item-active, #ebeef2);
}
html[data-rdsh-anim="outline"] [data-rdsh-ring-row][aria-selected="true"]::before {
  background: conic-gradient(
    from 0deg,
    transparent 0deg,
    transparent 215deg,
    color-mix(in srgb, var(--dsw-alias-state-warn-primary, #ffd166) 14%, transparent) 235deg,
    color-mix(in srgb, var(--dsw-alias-state-warn-primary, #ffd166) 68%, transparent) 268deg,
    color-mix(in srgb, var(--dsw-alias-state-warn-primary, #ffd166) 45%, var(--dsw-alias-label-primary, #f9fafb)) 292deg,
    color-mix(in srgb, var(--dsw-alias-state-warn-primary, #ffd166) 30%, transparent) 315deg,
    transparent 336deg,
    transparent 360deg
  );
}
html[data-rdsh-anim="outline"] [data-rdsh-ring-row]:hover:not([aria-selected="true"]) {
  --rdsh-ring-fill: var(--dsw-specific-sidebar-nav-item-hover, #f1f3f5);
}
html[data-rdsh-anim="outline"] [data-rdsh-ring-row]:not([data-rdsh-session-frame]) {
  box-shadow: none !important;
}
/* An idle session that is merely open: a plain frame and a slightly lighter
   fill, with no sweep, so "open" and "working" stay distinguishable. */
html[data-rdsh-anim="outline"] [data-rdsh-open-row]:not([data-rdsh-ring-row]) {
  background: var(--dsw-specific-sidebar-nav-item-active, #ebeef2) !important;
  box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l4, rgba(0,0,0,.16)) !important;
  border-radius: 12px !important;
}
html[data-rdsh-anim="outline"] [data-rdsh-open-row]:not([data-rdsh-ring-row]):hover {
  background: var(--dsw-specific-sidebar-nav-item-hover, #f1f3f5) !important;
}
/* A row with a user-chosen colour frame keeps that frame: only the fill moves. */
html[data-rdsh-anim="outline"] [data-rdsh-open-row][data-rdsh-session-frame]:not([data-rdsh-ring-row]) {
  box-shadow: inset 0 0 0 2px var(--rdsh-session-frame) !important;
}

/* The open session's title carries its running state: a light, slow sweep
   through the glyphs so a phone (where the sidebar is closed) still shows
   activity. The gradient is 3x the text and the position stays inside 0-100%,
   which is exactly the range that keeps it covering the element: a wider
   travel slides the highlight off the text and leaves the title invisible. */
@supports ((-webkit-background-clip: text) or (background-clip: text)) {
  [data-rdsh-header-title][data-rdsh-header-running] {
    background-image: linear-gradient(100deg,
      var(--dsw-alias-label-primary, #f9fafb) 0%,
      var(--dsw-alias-label-primary, #f9fafb) 38%,
      color-mix(in srgb, var(--dsw-alias-link, #7aaaff) 30%, var(--dsw-alias-label-primary, #f9fafb)) 47%,
      var(--dsw-alias-label-primary, #f9fafb) 50%,
      color-mix(in srgb, var(--dsw-alias-link, #7aaaff) 30%, var(--dsw-alias-label-primary, #f9fafb)) 53%,
      var(--dsw-alias-label-primary, #f9fafb) 62%,
      var(--dsw-alias-label-primary, #f9fafb) 100%);
    background-size: 300% 100%;
    background-repeat: no-repeat;
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    animation: rdsh-header-sheen 5.2s ease-in-out infinite;
  }
}
@keyframes rdsh-header-sheen {
  0% { background-position: 100% 0 }
  38% { background-position: 0% 0 }
  100% { background-position: 0% 0 }
}
@media (prefers-reduced-motion: reduce) {
  [data-rdsh-header-title][data-rdsh-header-running] {
    animation: none !important;
    background-image: none;
    -webkit-text-fill-color: currentColor;
  }
}

/* Notices: swipe up to dismiss. The component keeps pointer-events off so an
   announcement cannot intercept clicks; re-enable them only on our hook, which
   only exists while the gesture is available. */
[data-rdsh-toast] { pointer-events: auto; touch-action: none; }
[data-rdsh-toast][data-rdsh-toast-dismissed] {
  transform: translate(-50%, -170%) !important;
  opacity: 0 !important;
  pointer-events: none !important;
  transition: transform .24s cubic-bezier(.4, 0, 1, 1), opacity .24s linear !important;
}

/* A generated session name: animated over the (transparent) real text. */
[data-rdsh-typing] {
  position: relative;
  color: transparent !important;
  -webkit-text-fill-color: transparent !important;
  /* The running sheen paints the glyphs with a background, so an invisible
     fill is not enough: without this the real (new) text stays on screen and
     the erase reads as a caret moving over a name that never goes away. */
  background-image: none !important;
  -webkit-background-clip: border-box !important;
  background-clip: border-box !important;
}
[data-rdsh-typing-layer] {
  position: absolute;
  inset: 0;
  box-sizing: border-box;
  padding: inherit;
  color: var(--dsw-alias-label-primary, #f9fafb);
  -webkit-text-fill-color: currentColor;
  white-space: nowrap;
  overflow: hidden;
  pointer-events: none;
}
[data-rdsh-typing-caret] {
  display: inline-block;
  width: 2px;
  height: 1em;
  margin-left: 1px;
  vertical-align: -0.14em;
  background: currentColor;
  animation: rdsh-typing-blink .8s steps(1, end) infinite;
}
@keyframes rdsh-typing-blink { 0%, 49% { opacity: 1 } 50%, 100% { opacity: 0 } }
@media (prefers-reduced-motion: reduce) {
  [data-rdsh-typing-caret] { animation: none !important; }
}
@keyframes rdsh-ring-rotate {
  to { transform: translate(-50%, -50%) rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  html[data-rdsh-anim="outline"] [data-rdsh-ring-row]::before { animation: none !important; }
}
html[data-rdsh-anim="none"] [data-rdsh-running] [data-rdsh-session-title]::before,
html[data-rdsh-anim="none"] [data-rdsh-running] [data-rdsh-session-title]::after { display: none; }

@media (prefers-reduced-motion: reduce) {
  [data-rdsh-running] [data-rdsh-session-title]::before { animation: none; opacity: .4 }
  [data-rdsh-running] [data-rdsh-session-title]::after { animation: none }
  html[data-rdsh-anim="breathing"] [data-rdsh-running] [data-rdsh-session-title] { animation: none; color: var(--dsw-alias-label-primary, #f9fafb) }
}
}

/* Safe-area insets measured at runtime: apply them even when the browser's
   display-mode query does not report standalone (iOS home-screen apps). */
html[data-rdsh-safe-top] #root { box-sizing: border-box; padding-top: env(safe-area-inset-top, 0px); }
html[data-rdsh-safe-bottom] #root { box-sizing: border-box; padding-bottom: env(safe-area-inset-bottom, 0px); }
/* iOS 26 standalone native gap: the home indicator is in the unpainted strip
   below the web view, so an inner bottom safe-area pad only widens the blank. */
html[data-rdsh-native-gap][data-rdsh-safe-bottom] #root { padding-bottom: 0 !important; }

/* Controls the hide list matched. The attribute these selectors key off is
   only written while the phone predicate holds (see applyHideList), so the
   rule can live outside the width query: a landscape phone and a
   coarse-pointer tablet are phones at any width. On a narrow desktop window
   the attribute is absent, so nothing here applies (#17). The merged-tab
   attribute is different: it follows the phone *layout*, so its rule stays
   inside the width query below. */
html[data-rdsh-hide-settings] [data-rdsh-hidden],
html[data-rdsh-hide-settings] [data-rdsh-setting-hidden] { display: none !important; }

@media ${NARROW_QUERY} {
  /* The mockup proved 100% is the layout viewport (844) while the native web
     view is 797 on iOS 26; the body could pan 47px. 100dvh is the web view
     height, and the grid makes the app fill exactly that one row. */
  html, body {
    height: 100dvh !important;
    min-height: 100dvh !important;
    overflow: hidden !important;
    overscroll-behavior: none !important;
  }
  body { display: grid !important; grid-template-rows: 100dvh !important; }
  #root { height: 100% !important; min-height: 0 !important; box-sizing: border-box !important; }
  [data-rdsh-scroll] { overscroll-behavior-y: contain; }

  /* One slide for both sheets, so opening and closing read the same whether
     the session list or the preview moves. 300ms / standard easing is the
     app's own "slow" token, which the panel already used. */
  html {
    --rdsh-slide-ms: 300ms;
    --rdsh-slide-ease: cubic-bezier(.4, 0, .2, 1);
  }
  /* The preview's slide lives on its dock host. The trailing visibility step
     is the app's own: it keeps the element painted until the slide-out ends,
     and is dropped while open so it appears at once. */
  [data-dockkit-host] {
    transition: transform var(--rdsh-slide-ms) var(--rdsh-slide-ease), visibility 0s linear var(--rdsh-slide-ms) !important;
  }
  [data-sidebar-right-open] [data-dockkit-host] {
    transition: transform var(--rdsh-slide-ms) var(--rdsh-slide-ease) !important;
  }

  /* The drawer floats above the chat; the grid never gives it a column. */
  [data-rdsh-frame] { grid-template-columns: 0 minmax(0, 1fr) 0 !important; }
  /* Pin both columns in every state. The app switches between explicit
     placement and auto-placement as the sidebar opens and closes, and auto
     placement shifts everything one column left once our drawer leaves the
     flow: the chat lands on the 0px column and the empty right column fills
     the screen. Pinning only the open state left the closed state broken. */
  [data-rdsh-frame] [data-rdsh-center-col] { grid-column: 2 !important; }
  [data-rdsh-frame] [data-rdsh-rightbar-col] { grid-column: 3 !important; }
  [data-rdsh-frame][data-rightbar-fullscreen] { grid-template-columns: 0 minmax(0, 1fr) 0 !important; }
  [data-rdsh-sidebar] {
    position: fixed !important; inset: 0 auto 0 0 !important;
    box-sizing: border-box;
    padding-top: env(safe-area-inset-top, 0px);
    padding-bottom: env(safe-area-inset-bottom, 0px);
    width: 280px !important; max-width: 86vw; height: 100dvh !important; min-height: 100dvh;
    z-index: 50; overflow: hidden;
    transform: translateX(-104%);
    transition: transform var(--rdsh-slide-ms) var(--rdsh-slide-ease), box-shadow var(--rdsh-slide-ms) var(--rdsh-slide-ease);
    will-change: transform; background: var(--dsw-alias-bg-base, #1b1b1d);
  }
  /* The drop shadow lifts the drawer off the chat. It was removed once as the
     suspected "dark thing sliding in from the left"; the real cause was the
     chat column collapsing to 0px, which let an empty 390px column cover the
     screen. With that fixed the shadow is safe, and the dimmed backdrop keeps
     it from being the only separation. */
  html[data-rdsh-drawer="open"] [data-rdsh-sidebar] {
    transform: translateX(0);
    box-shadow: var(--dsw-elevation-prominent, 24px 0 56px rgba(0,0,0,.35));
  }
  html[data-rdsh-drawer="open"] .rdsh-mux-backdrop { display: block; opacity: 1; pointer-events: auto; }
  .rdsh-mux-fab { display: flex; }
  html[data-rdsh-drawer="open"] .rdsh-mux-fab { display: none; }


  /* The account row in the sidebar footer is replaced by the settings row
     inside the panel list, so the original row is hidden. */
  [data-rdsh-more-row] { display: none !important; }

  /* The phone layout merges the App and Input tabs into Mobile (the section
     inlines them). This attribute is only written under the same
     narrow-and-phone condition, so a narrow desktop window keeps all three
     tabs. */
  [data-rdsh-settings-tab-hidden] { display: none !important; }

  [data-rdsh-settings-nav-arrow] {
    position: fixed; z-index: 1006; width: 30px; height: 30px;
    display: grid; place-items: center; padding: 0;
    border: .5px solid var(--dsw-alias-border-l3, rgba(0,0,0,.12)); border-radius: 50%;
    background: var(--dsw-alias-button-floating-fill, #fff); color: var(--dsw-alias-label-primary, #f9fafb);
    box-shadow: var(--dsw-shadow-lv2, 0 2px 8px rgba(0,0,0,.08));
    -webkit-tap-highlight-color: transparent;
  }
  [data-rdsh-settings-nav-arrow][hidden] { display: none !important; }
  [data-rdsh-settings-nav-arrow]:hover { background: var(--dsw-alias-button-floating-hover, #f1f3f5); }
  [data-rdsh-settings-nav-arrow]:active { transform: scale(.94); }
  [data-rdsh-settings-nav-arrow] svg { width: 16px; height: 16px; }
  /* The stats dock (turns / tok/s / cache hit / context %) stays visible, but
     moves out of the composer's layout. The card can then sit in the safe-area
     strip instead of leaving a blank band below it, and the stats fill that
     strip. */
  html[data-rdsh-has-dock][data-rdsh-safe-bottom] #root { padding-bottom: 0 !important; }
  html[data-rdsh-has-dock] [data-rdsh-composer-root] {
    position: relative;
    padding-bottom: 31px !important; /* 27px dock + 4px */
  }
  [data-rdsh-composer-dock] {
    position: absolute !important;
    left: 16px; right: 16px; bottom: 4px;
    height: 27px; box-sizing: border-box;
    padding: 0 !important;
    align-items: center;
    z-index: 8;
    background: var(--dsw-alias-bg-base, #151517);
  }
  [data-rdsh-composer-dock] button {
    font-size: 11px !important;
    padding: 1px 2px !important;
    gap: 3px !important;
  }
  /* The app label includes steps / total tokens; show only the four requested
     values, with no ellipsis. */
  [data-rdsh-stat-text] > span { display: none !important; }
  [data-rdsh-stat-text]::after {
    content: attr(data-rdsh-stat-text);
    white-space: nowrap;
    font: inherit;
    color: inherit;
  }
  /* Three pills plus their icons stay on one row, centered inside the same
     16px gutters as the composer and transcript. */
  [data-rdsh-composer-dock] { gap: 2px !important; justify-content: center !important; }
  [data-rdsh-transcript] {
    padding-left: 16px !important;
    padding-right: 16px !important;
  }
  /* Keep the reasoning effort (Max etc.) visible; only the model name shrinks. */
  [data-rdsh-model-button] [class*="triggerLabel"] {
    flex: 1 1 auto !important;
    min-width: 0 !important;
  }
  [data-rdsh-model-button] [class*="triggerEffort"] {
    flex: 0 0 auto !important;
    width: auto !important;
    max-width: none !important;
    min-width: auto !important;
    display: block !important;
    visibility: visible !important;
    opacity: 1 !important;
  }
  [data-chat-flow-kind="turn-tail"] [class*="_header"] {
    padding-top: 6px !important;
    padding-bottom: 6px !important;
  }
  [data-chat-flow-kind="turn-tail"] [class*="_row"] {
    padding-top: 4px !important;
    padding-bottom: 4px !important;
  }
  /* The app caps a user bubble at 70.2% of the row. A little more room and
     padding makes the query bubble easier to read without touching replies. */
  [data-rdsh-user-stack] { max-width: 78% !important; }
  @media (max-width: 380px) {
    [data-rdsh-composer-dock] { gap: 0 !important; }
    [data-rdsh-composer-dock] button { font-size: 10px !important; padding: 1px 2px !important; }
  }
  /* Overlay UI belongs on top of the drawer's own chrome, not across it. */
  html[data-rdsh-drawer="open"] .rdsh-pwa-install,
  html[data-rdsh-drawer="open"] .rdsh-pwa-card { display: none; }
  /* The right sidebar menu owns the screen; the floating hamburger would sit
     on top of it (and keep its hover state). */
  html[data-rdsh-rightpanel-open] .rdsh-mux-fab { display: none !important; }

  /* Sessions: give the label the room the row actions used to take. */
  [data-rdsh-session] { padding-inline: 6px !important; }
  [data-rdsh-session] [data-rdsh-session-title] { margin-right: 4px !important; }
  [data-rdsh-row-minor] { display: none !important; }
  [data-rdsh-status-empty] { display: none; }
  /* The chat column sizes its content from fixed pixel floors upstream
     (680px and friends), so on a 390px phone the transcript is wider than the
     column and gets clipped. Size it from the column instead. These custom
     properties are the app's own knobs for exactly that. */
  [data-rdsh-conversation] {
    --dsh-chat-user-width: 100% !important;
    --dsh-chat-content-width: 100% !important;
    --dsh-composer-card-max-width: 100% !important;
  }
  [data-rdsh-conversation] > * {
    width: 100% !important;
    min-width: 0 !important;
    max-width: 100% !important;
    overflow-x: clip;
  }

  /* Clear the floating drawer button.
     It sits at x:8 with a 40px width, so the title needs a 64px left inset;
     without it the crumb starts at 20px and runs under the button. This inset
     used to come from rdsh-mobile-ui, so a profile without that plugin drew
     the session name straight through the button. */
  [data-rdsh-header] { padding-left: 64px !important; }
  [data-rdsh-header] [class*="_titleCluster"] { min-width: 0; flex: 1 1 auto; }
  /* Pin the activity chips to the right edge of the header. Without this the
     actions block sits directly after the title, so a short session name drags
     both chips left with it. */
  [data-rdsh-header] [class*="_headerActions"] { margin-left: auto !important; }
  [data-rdsh-header] [class*="_crumbs"] { min-width: 48px; overflow: hidden; text-overflow: ellipsis; }
  [data-rdsh-session] [class*="_rowActions"] { display: flex; }
  /* Keep the row's own menu-open class in the exception list: without it the
     trigger is hidden while the portal measures it. */
  [data-rdsh-session]:not([aria-selected="true"]):not(:focus-within):not([class*="_menuOpen"]):not([data-rdsh-row-menu]) [class*="_rowActions"] { display: none; }

  /* Composer input dock (Todo, Goal, other pre-composer panels): 16px gutters. */
  [data-testid="todo-panel"],
  [class*="nLMEza_dock"],
  [data-slot="conversation.input.dock"] > * {
    width: calc(100% - 32px) !important;
    max-width: calc(100% - 32px) !important;
    margin-left: auto !important;
    margin-right: auto !important;
  }
  [class*="nLMEza_bar"] { max-width: 100% !important; }

  [data-rdsh-session][data-rdsh-row-menu] [class*="_rowActions"] { display: flex !important; }

  /* The long press belongs to the row menu, not to the system: no text
     selection and no iOS callout ("Copy", "Look Up", …) while holding a row.
     The app sets user-select on the row itself, but not on its children, and
     never disables the callout. */
  [data-rdsh-session],
  [data-rdsh-session] * {
    -webkit-user-select: none !important;
    user-select: none !important;
    -webkit-touch-callout: none !important;
  }

  /* Todo rows / goal objective open a full-text popover on tap. */
  [data-rdsh-todo-item],
  [data-rdsh-goal-objective] { cursor: pointer; }
  [data-rdsh-todo-item]:active,
  [data-rdsh-goal-objective]:active { opacity: .72; }

  /* Goal edit mode: stack save/cancel so the inline editor gets the width. */
  [data-rdsh-goal-editing] { align-items: stretch !important; }
  [data-rdsh-goal-editing] [data-rdsh-goal-actions] {
    flex-direction: column !important;
    align-items: center !important;
    justify-content: center !important;
    gap: 2px !important;
  }
  [data-rdsh-goal-editing] [data-rdsh-goal-actions] > * { flex: none !important; }

  /* Shell/subagent header chips: icon + the same live spinner ring, no text. */
  [data-rdsh-activity-chip] {
    position: relative !important;
    width: 30px !important; height: 30px !important; min-width: 30px !important;
    padding: 0 !important; border-radius: 50% !important;
    display: grid !important; place-items: center !important;
    gap: 0 !important;
    color: var(--dsw-alias-label-secondary, #9ca3af);
    -webkit-tap-highlight-color: transparent;
  }
  [data-rdsh-activity-chip]:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06)); }
  [data-rdsh-activity-chip] > span:not([data-rdsh-activity-icon]):not([data-rdsh-activity-spinner]) { display: none !important; }
  [data-rdsh-activity-chip] > svg:not([data-rdsh-activity-spinner]) { display: none !important; }
  [data-rdsh-activity-chip] [data-rdsh-activity-spinner] {
    position: absolute !important; inset: 3px !important;
    width: 24px !important; height: 24px !important;
    margin: auto !important; pointer-events: none;
  }
  [data-rdsh-activity-chip] [data-rdsh-activity-spinner] svg { width: 100% !important; height: 100% !important; }
  [data-rdsh-activity-chip] [data-rdsh-activity-icon] {
    position: relative; z-index: 1; width: 13px; height: 13px;
    display: grid; place-items: center;
  }
  [data-rdsh-activity-chip] [data-rdsh-activity-icon] svg { width: 13px; height: 13px; }
  .rdsh-activity-ring {
    display: block; border: 1.6px solid var(--dsw-alias-border-l3, rgba(0,0,0,.12));
    border-top-color: var(--dsw-alias-state-success-primary, #22c55e);
    border-radius: 50%;
    animation: rdsh-activity-spin 1s linear infinite;
  }
  @keyframes rdsh-activity-spin { to { transform: rotate(360deg); } }

  /* Settings: full screen, stacked navigation, nothing narrowed. */
  /* Close lives on the top row with the Settings title, as a round button. */
  [data-shortcut-modal="settings"] [class*="VOzbGW_close"] {
    position: fixed !important;
    top: calc(env(safe-area-inset-top, 0px) + 12px) !important;
    right: 12px !important;
    width: 36px !important; height: 36px !important;
    padding: 0 !important;
    display: grid !important; place-items: center !important;
    border: .5px solid var(--dsw-alias-border-l3, rgba(0,0,0,.12)) !important;
    border-radius: 50% !important;
    background: var(--dsw-alias-button-floating-fill, #fff) !important;
    color: var(--dsw-alias-label-primary) !important;
    box-shadow: var(--dsw-shadow-lv2, 0 2px 8px rgba(0,0,0,.08));
    z-index: 1007 !important;
  }
  [data-shortcut-modal="settings"] [class*="VOzbGW_close"]:hover { background: var(--dsw-alias-button-floating-hover, #f1f3f5) !important; }
  [data-shortcut-modal="settings"] [class*="VOzbGW_close"] svg { width: 18px !important; height: 18px !important; }

  /* Tab names fade toward a scrollable edge, so the floating arrows never
     sit on top of a hard-cut label. The flags are set by positionSettingsArrows. */
  [data-shortcut-modal="settings"] [class*="VOzbGW_navList"][data-rdsh-fade-left] {
    -webkit-mask-image: linear-gradient(to right, transparent 0, #000 64px);
    mask-image: linear-gradient(to right, transparent 0, #000 64px);
  }
  [data-shortcut-modal="settings"] [class*="VOzbGW_navList"][data-rdsh-fade-right] {
    -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 72px), transparent 100%);
    mask-image: linear-gradient(to right, #000 calc(100% - 72px), transparent 100%);
  }
  [data-shortcut-modal="settings"] [class*="VOzbGW_navList"][data-rdsh-fade-left][data-rdsh-fade-right] {
    -webkit-mask-image: linear-gradient(to right, transparent 0, #000 64px, #000 calc(100% - 72px), transparent 100%);
    mask-image: linear-gradient(to right, transparent 0, #000 64px, #000 calc(100% - 72px), transparent 100%);
  }

  /* The settings panel is fully opaque on a phone; the blurred mask was the
     source of the iOS flash on each tab repaint. */
  [data-shortcut-modal="settings"] [class*="VOzbGW_mask"] {
    -webkit-backdrop-filter: none !important;
    backdrop-filter: none !important;
  }
  [data-shortcut-modal="settings"],
  [data-shortcut-modal="settings"] [class*="VOzbGW_options"] {
    -webkit-transform: translateZ(0);
    transform: translateZ(0);
    -webkit-backface-visibility: hidden;
    backface-visibility: hidden;
  }

  [data-shortcut-modal="settings"] {
    position: absolute !important;
    inset: 0 !important;
    width: 100% !important;
    max-width: none !important;
    height: 100% !important;
    max-height: none !important;
    border-radius: 0 !important;
    box-sizing: border-box !important;
    flex-direction: column;
    padding-top: env(safe-area-inset-top, 0px);
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }
  [data-shortcut-modal="settings"] > nav {
    width: 100%; padding: 16px 12px 0; gap: 8px;
    border-bottom: .5px solid var(--dsw-alias-border-l2, rgba(255,255,255,.12));
  }
  [data-shortcut-modal="settings"] > nav > div:last-child {
    flex-direction: row; overflow-x: auto; overflow-y: hidden; gap: 6px;
    margin-top: 10px; padding-bottom: 10px;
    scrollbar-width: none;
    border-top: .5px solid var(--dsw-alias-border-l2, rgba(255,255,255,.12));
  }
  [data-shortcut-modal="settings"] > nav > div:last-child::-webkit-scrollbar { display: none; }
  [data-shortcut-modal="settings"] > nav > div:last-child button { flex: none; }
  [data-shortcut-modal="settings"] > nav + div { min-height: 0; }
  /* The close is fixed to the title row now; the old header row only held
     "Open configuration file" (a desktop action). Collapse it so the content
     begins directly at the tab strip. Tied to the hide list: with "stop
     hiding" the header (and that action) comes back, which is also how the
     debug switch can be checked. A narrow desktop window has no
     data-rdsh-hide-settings, so it keeps the stock header (#17). */
  html[data-rdsh-hide-settings] [data-shortcut-modal="settings"] > nav + div > div:first-child {
    height: 0 !important; min-height: 0 !important; padding: 0 !important;
    overflow: visible;
  }
  html[data-rdsh-hide-settings] [data-shortcut-modal="settings"] > nav + div > div:first-child [class*="VOzbGW_actions"] { display: none !important; }
  [data-shortcut-modal="settings"] > nav + div > div:last-child { padding: 0 12px 16px; }

  /* Settings: theme tiles side by side, never crushed. */
  [data-shortcut-modal="settings"] [class*="_8HJdBW_group"] { align-items: stretch !important; }
  [data-shortcut-modal="settings"] [class*="_8HJdBW_cubeRow"] {
    flex-direction: row !important; flex-wrap: nowrap !important;
    height: auto !important; align-items: stretch !important; gap: 8px !important;
  }
  [data-shortcut-modal="settings"] [class*="_8HJdBW_cubeRow"] > * {
    flex: 1 1 0 !important; width: auto !important; min-width: 0 !important;
    height: auto !important; min-height: 88px !important;
    padding: 12px 6px !important; box-sizing: border-box !important;
  }
  [data-shortcut-modal="settings"] [class*="_8HJdBW_cubeRow"] > * > * { max-width: 100%; }

  /* Rows matched by the hide list are hidden by
     html[data-rdsh-hide-settings] [data-rdsh-setting-hidden] above. There is
     deliberately no blanket rule over upstream row classes: it hid whole
     groups regardless of their label, which is what #17 reported. */

  /* Settings: no accidental horizontal scrolling in tab panels. */
  [data-shortcut-modal="settings"] [class*="VOzbGW_options"] {
    overflow-x: hidden !important;
    scrollbar-gutter: stable;
  }
  [data-shortcut-modal="settings"] [class*="rtSEdW_section"],
  [data-shortcut-modal="settings"] [class*="rtSEdW_group"],
  [data-shortcut-modal="settings"] [class*="rtSEdW_cards"],
  [data-shortcut-modal="settings"] [class*="rtSEdW_card"],
  [data-shortcut-modal="settings"] [class*="rtSEdW_cardFoot"] {
    min-width: 0 !important; max-width: 100% !important; box-sizing: border-box !important;
  }
  [data-shortcut-modal="settings"] [class*="rtSEdW_cardFoot"] { flex-wrap: wrap !important; overflow: hidden; }
  [data-shortcut-modal="settings"] [class*="rtSEdW_iconButton"] { overflow: hidden; }

  /* Settings > Models: shrink provider names, never collide with actions. */
  [data-shortcut-modal="settings"] [class*="zGbnIq_rowCard"] { min-width: 0 !important; max-width: 100% !important; box-sizing: border-box !important; }
  [data-shortcut-modal="settings"] [class*="zGbnIq_rowHead"] { min-width: 0 !important; gap: 8px !important; }
  [data-shortcut-modal="settings"] [class*="zGbnIq_rowIdentity"] { min-width: 0 !important; overflow: hidden; }
  [data-shortcut-modal="settings"] [class*="zGbnIq_rowName"] { min-width: 0 !important; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  [data-shortcut-modal="settings"] [class*="zGbnIq_rowActions"] { flex-shrink: 0; gap: 6px; }
  [data-shortcut-modal="settings"] [class*="zGbnIq_rowActions"] button { padding-left: 10px !important; padding-right: 10px !important; }

  /* Model picker: value never runs into the chevron. */
  [class*="_7KE1Ra_menu"] { max-width: calc(100vw - 24px) !important; box-sizing: border-box !important; }
  [class*="_7KE1Ra_cell"] { min-width: 0 !important; gap: 8px !important; }
  [class*="_7KE1Ra_cell"] > span:last-of-type { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  [data-rdsh-model-search]:disabled { opacity: 1 !important; cursor: text; }

  /* Agent question / plan review card: it lives in the composer seat, which
     already carries the 16px gutter, so it just fills that box. It used to be
     pinned to 349px — a copy of the transcript's old fixed column — which left
     it narrower than the composer on every phone and off-centre on tablets. */
  [data-rdsh-question-frame] {
    padding-left: 16px !important; padding-right: 16px !important;
    padding-bottom: 10px !important;
  }
  [data-rdsh-question-frame] > [data-rdsh-question-card] {
    width: 100% !important; max-width: 100% !important;
    /* The card's own 10px bottom padding doubled the footer's. */
    padding-bottom: 0 !important;
  }
  /* Direct children only. [class*="_header"] also matches _headerActions,
     [class*="_footer"] matches _footerActions and [class*="_option"] matches
     _optionCopy / _optionLine / _optionLabel, so plain descendant selectors
     stacked the same padding four levels deep and inflated the card (one
     option row 66px → 114px). */
  [data-rdsh-question-card] > [class*="_header"] { padding: 12px 12px 0 16px !important; }
  [data-rdsh-question-card] > [class*="_strip"] { padding: 10px 12px !important; }
  [data-rdsh-question-card] > [class*="_summary"] { padding: 12px 16px !important; }
  [data-rdsh-question-card] > [class*="_footer"] { padding: 8px 10px 10px !important; }
  [data-rdsh-question-card] [class*="_options"] { padding: 4px 8px !important; }
  [data-rdsh-question-card] [class*="_options"] > button[class*="_option"],
  [data-rdsh-question-card] [class*="_options"] > [class*="_customRow"] { padding: 8px !important; }
  [data-rdsh-question-card] [class*="_customBlock"] { margin-left: 8px !important; margin-right: 8px !important; }
  /* The answer field takes its height from a hidden mirror, so both layers
     must share the font size (16px here stops iOS from zooming on focus). */
  [data-rdsh-question-card] [class*="_field"] > * { font-size: 16px !important; }
  /* The card clips its overflow, so a long unbroken token used to be cut. */
  [data-rdsh-question-card] [class*="_optionLabel"],
  [data-rdsh-question-card] [class*="_title"],
  [data-rdsh-question-card] [class*="_description"] { overflow-wrap: anywhere; }

  /* iOS zooms any focused field below 16px; this is a PWA and needs no zoom. */
  html, body { touch-action: manipulation; }
  input, textarea, [contenteditable="true"] {
    font-size: 16px !important;
    touch-action: manipulation;
  }
  /* The bundled xterm 6.0 has no touch path and scrolls only on wheel events,
     so the JS bridge owns the gesture. Keep the browser from claiming the drag
     as a pan/zoom before the touchmove handler sees it. (This alone cannot
     make the terminal scroll: there is no scrollable node behind it.) */
  .xterm, .xterm .xterm-screen, .xterm .xterm-scrollable-element { touch-action: none; }

  /* Edit summary: tighter rows. */
  [data-rdsh-edit-header] { height: 44px !important; min-height: 44px !important; padding: 4px 10px !important; }
  [data-rdsh-edit-row] { height: 26px !important; padding-top: 2px !important; padding-bottom: 2px !important; }

  /* Right panel: never wider than the phone, wide tables scroll inside it. */
  [data-rdsh-rightpanel] {
    max-width: 100vw !important; overflow-x: hidden;
    box-sizing: border-box;
    padding-top: 0 !important;
    padding-bottom: calc(env(safe-area-inset-bottom, 0px) + var(--rdsh-native-gap-px, 0px)) !important;
  }
  /* The preview's close control is drawn as a panel glyph, which reads as
     "collapse this pane" rather than "leave the preview". Swap it for an X,
     the same glyph the tab close buttons already use. */
  [data-rdsh-rightpanel] [aria-label="Collapse right sidebar"] svg,
  [aria-label="Collapse right sidebar"] svg { display: none !important; }
  [aria-label="Collapse right sidebar"]::before {
    content: ""; width: 16px; height: 16px; display: block;
    background: currentColor;
    -webkit-mask: var(--rdsh-close-mask) center / contain no-repeat;
    mask: var(--rdsh-close-mask) center / contain no-repeat;
  }
  html { --rdsh-close-mask: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><path d='M3.6 3.6 12.4 12.4M12.4 3.6 3.6 12.4' stroke='black' stroke-width='1.7' stroke-linecap='round'/></svg>"); }

  /* The preview sheet covers the app header; keeping the mobile header in flow
     left a dead band above the full-screen preview. */
  html[data-rdsh-rightpanel-open] header[data-rdsh-header] { display: none !important; }
  [data-rdsh-rightpanel] table { display: block; overflow-x: auto; max-width: 100%; }
  [data-rdsh-rightpanel] pre { max-width: 100%; }

  /* Right panel tabs (dockkit's file/preview strip).
     Upstream builds them for a mouse: 28px tall, with touch-action:none (which
     makes the strip unscrollable by finger, so tabs past the right edge are
     unreachable), and a drag threshold of 4px on every pointerdown, which
     turns an ordinary tap into a tab drag. Give the row a finger-sized height,
     let a tap stay a tap, and let the strip pan sideways. Drag-and-drop of tabs
     is therefore mouse-only; nothing in this layout needs it. */
  [data-rdsh-rightpanel] [data-dockkit-tab] {
    height: 44px !important;
    min-width: 88px !important;
    max-width: 58vw !important;
    touch-action: manipulation !important;
  }
  [data-rdsh-rightpanel] [data-dockkit-strip] { min-height: 52px; }
  [data-rdsh-rightpanel] [data-dockkit-strip-tabs] {
    touch-action: pan-x !important;
    scroll-behavior: auto !important;
    -webkit-overflow-scrolling: touch;
  }
  /* The close button is hover-only upstream; a phone has no hover, so it took
     the top-right of the tap target without ever being visible. Show it on the
     selected tab only, and keep it out of the tab's own tap area. */
  [data-rdsh-rightpanel] [data-dockkit-tab-close] { display: none !important; }
  [data-rdsh-rightpanel] [data-dockkit-tab][aria-selected="true"] [data-dockkit-tab-close] {
    display: flex !important;
    opacity: 1 !important;
    pointer-events: auto !important;
  }
  /* Selected tab needs to read as selected without the hover colour shift. */
  [data-rdsh-rtab][aria-selected="true"] {
    box-shadow: inset 0 -2px 0 var(--dsw-alias-brand-primary-new-color, #4d6bfe);
  }

  /* Code files: wrap every line, including a single long token (URLs,
     minified lines). Wrapping only at spaces left those overflowing, which
     turned the viewer into a free two-axis scroller.
     The lines are their own boxes: .line carries
     "white-space: var(--dsl-code-block-line-white-space, pre)", so styling
     pre alone left them unwrapped (and the horizontal lock clipped them). */
  /* Do NOT style the code element: the newline text nodes between the .line
     spans live there, and giving them pre-wrap painted an empty row between
     every line (19px -> 38px). The lines carry their own content. */
  [data-rdsh-rightpanel] [data-textpreview-body] pre,
  [data-rdsh-rightpanel] [data-textpreview-body] pre .line {
    white-space: pre-wrap !important;
    overflow-wrap: anywhere !important;
    word-break: break-word !important;
  }
  /* ...and the code scroller itself keeps no sideways travel. */
  [data-rdsh-code-scroll] { overflow-x: hidden !important; }
  /* Wrapping is forced above, so the viewer's own toggle no longer changes
     anything. Hide it rather than leave a control that does nothing. */
  [data-rdsh-rightpanel] [data-textpreview-tool="wrap"] { display: none !important; }

  /* The native strip already contains the home indicator. */
  html[data-rdsh-native-gap] [data-rdsh-sidebar],
  html[data-rdsh-native-gap] [data-rdsh-rightpanel],
  html[data-rdsh-native-gap] [data-shortcut-modal="settings"] { padding-bottom: 0 !important; }
}
`;

    // ---------------------------------------------------------------------
    // Wiring
    // ---------------------------------------------------------------------
    let booted = false;

    function boot(ctx) {
      if (booted) return;
      booted = true;
      hostCtx = ctx;

      ctx.effect(() => {
        const style = document.createElement("style");
        style.setAttribute("data-rdsh-mux-style", "");
        style.textContent = CSS;
        document.head.append(style);

        installDrawer();
        document.documentElement.setAttribute("data-rdsh-anim", ANIMATION);

        const observer = new MutationObserver(scheduleDecorate);
        // `data-sidebar-collapsed` / `data-rightbar-collapsed` are upstream's
        // own open/close signals on the app frame. They change without a
        // resize when the user toggles a sidebar, so without them the drawer
        // and right-panel state only caught up on the next unrelated mutation.
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-label", "aria-selected", "data-state", "draggable", "data-sidebar-collapsed", "data-rightbar-collapsed"] });

        document.addEventListener("pointerdown", onPointerDown, true);
        document.addEventListener("pointermove", onPointerMove, true);
        document.addEventListener("focusout", onModelFocusOut, true);
        document.addEventListener("pointerup", onPointerUp, true);
        document.addEventListener("mousedown", onMouseDownCapture, true);
        document.addEventListener("click", onClickCapture, true);
        // Window capture runs before the app's document-level key adapter. That
        // adapter treats a keyCode 229 Return as IME input and consumes it, so a
        // listener on document never gets the chance to insert a newline.
        window.addEventListener("keydown", onKeyDownCapture, true);
        // Notifications: the worker hands a payload here when a window is on
        // screen, and reports a tap the same way. `?session=` covers the cold
        // start, where no worker message can arrive before the page renders.
        navigator.serviceWorker?.addEventListener("message", onWorkerMessage);
        const bootSession = sessionFromUrl();
        if (bootSession !== "") requestSession(bootSession);
        document.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
        document.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
        measureSafeArea();
        // A rotation changes both the query and the geometry, and iOS reports
        // the new safe-area insets a frame or two after the event. Re-measure,
        // forget the gestures that were in flight, and decorate twice: once
        // now (so the drawer/button state follows the new width) and once
        // after the transition has settled.
        let rotationTimer = 0;
        const onResize = () => {
          // Do not close the attach sheet here: opening it blurs the composer,
          // and the resulting keyboard-close resize would remove it instantly.
          resetGestures();
          measureSafeArea();
          scheduleDecorate();
          clearTimeout(rotationTimer);
          rotationTimer = window.setTimeout(() => {
            measureSafeArea();
            scheduleDecorate();
          }, 350);
        };
        window.addEventListener("resize", onResize);
        window.addEventListener("orientationchange", onResize);
        // The visual viewport reports the keyboard and the rotation's own
        // resize; without it an iPhone keyboard can leave the layout sized for
        // the covered viewport.
        window.visualViewport?.addEventListener("resize", onResize);
        patchCommandUi(ctx);
        document.addEventListener("dragstart", onDragStartCapture, true);
        document.addEventListener("dragend", onDragEndCapture, true);
        document.addEventListener("dblclick", onSessionTitleDoubleClick, true);
        document.addEventListener("contextmenu", onSessionContextMenu, true);
        document.addEventListener("touchstart", onEdgeSwipeStart, true);
        document.addEventListener("touchmove", onEdgeSwipeMove, { capture: true, passive: false });
        document.addEventListener("touchend", onEdgeSwipeEnd, true);
        document.addEventListener("touchcancel", onEdgeSwipeEnd, true);
        document.addEventListener("keydown", onKeyDown);
        document.addEventListener("pointerdown", onFocusPointer, true);
        document.addEventListener("focusin", onFocusInGuard, true);
        if (narrow()) {
          const initial = textBoxOf(document.activeElement);
          if (initial !== null) setTimeout(() => { if (document.activeElement === initial) initial.blur(); }, 0);
        }
        const media = window.matchMedia(NARROW_QUERY);
        const onMedia = () => {
          emit({ narrow: media.matches, phone: phone() });
          if (!media.matches) clearPhoneHooks();
          scheduleDecorate();
        };
        media.addEventListener("change", onMedia);
        // #17: the device predicate can change without a width change (a
        // tablet switching to a keyboard, a window entering fullscreen), and
        // the settings UI has to follow it.
        const coarseMedia = window.matchMedia(COARSE_QUERY);
        const onPointerKind = () => {
          emit({ phone: phone() });
          scheduleDecorate();
        };
        coarseMedia.addEventListener("change", onPointerKind);
        const anyCoarseMedia = window.matchMedia(ANY_COARSE_QUERY);
        anyCoarseMedia.addEventListener("change", onPointerKind);

        scheduleDecorate();
        void refreshNotificationStatus();

        globalThis.__RDSH_MOBILE_UX__ = {
          get state() { return { ...state }; },
          get badgeCount() { return notificationTotal; },
          applyNotificationCount,
          readDeviceTheme,
          writeDeviceTheme,
          applyDeviceTheme,
          build: BUILD,
          autoSettings: true,
          decorate: scheduleDecorate,
          // Diagnostics used by the unit tests: the device predicate is the
          // #17 fix, so it must be observable without a browser.
          phone,
          closeDrawer,
          openDrawer: toggleDrawer,
          enableNotifications,
          sendTestNotification,
        };

        return () => {
          observer.disconnect();
          document.removeEventListener("pointerdown", onPointerDown, true);
          document.removeEventListener("pointerup", onPointerUp, true);
          document.removeEventListener("mousedown", onMouseDownCapture, true);
          document.removeEventListener("click", onClickCapture, true);
          window.removeEventListener("keydown", onKeyDownCapture, true);
          document.removeEventListener("touchstart", onTouchStart, true);
          document.removeEventListener("touchmove", onTouchMove, true);
          window.removeEventListener("resize", onResize);
          window.removeEventListener("orientationchange", onResize);
          window.visualViewport?.removeEventListener("resize", onResize);
          clearTimeout(rotationTimer);
          clearTimeout(sendSettleTimer);
          document.removeEventListener("dragstart", onDragStartCapture, true);
          document.removeEventListener("dragend", onDragEndCapture, true);
          document.removeEventListener("dblclick", onSessionTitleDoubleClick, true);
          document.removeEventListener("contextmenu", onSessionContextMenu, true);
          document.removeEventListener("touchstart", onEdgeSwipeStart, true);
          document.removeEventListener("touchmove", onEdgeSwipeMove, true);
          document.removeEventListener("touchend", onEdgeSwipeEnd, true);
          document.removeEventListener("touchcancel", onEdgeSwipeEnd, true);
          document.removeEventListener("keydown", onKeyDown);
          document.removeEventListener("pointerdown", onFocusPointer, true);
          document.removeEventListener("focusin", onFocusInGuard, true);
          // Added at boot alongside the rest; without these two a re-mount
          // leaves the previous closure listening on every pointer move.
          document.removeEventListener("pointermove", onPointerMove, true);
          document.removeEventListener("focusout", onModelFocusOut, true);
          media.removeEventListener("change", onMedia);
          coarseMedia.removeEventListener("change", onPointerKind);
          displayMedia.removeEventListener("change", onPointerKind);
          style.remove();
          rightPanelWatch?.disconnect();
          rightPanelIO?.disconnect();
          rightPanelWatch = null;
          rightPanelIO = null;
          rightPanelNode = null;
          settingsArrows?.left.remove();
          settingsArrows?.right.remove();
          settingsArrows = null;
          document.documentElement.removeAttribute("data-rdsh-rightpanel-open");
          document.documentElement.removeAttribute("data-rdsh-anim");
          fab?.remove();
          backdrop?.remove();
          fab = null;
          backdrop = null;
          delete globalThis.__RDSH_MOBILE_UX__;
          navigator.serviceWorker?.removeEventListener("message", onWorkerMessage);
          booted = false;
        };
      }, "rdsh-mobile-ux: phone layout");
    }

    return {
      inject: ["slots"],
      apply(ctx) {
        // Session selection needs the workspace service, which arrives on its
        // own schedule; without it a notification tap can only raise a banner.
        ctx.inject(["uiWorkspace"], (scope) => attachSessionOpener(scope));
        try {
          attachDeviceTheme(ctx);
        } catch (error) {
          console.error("[rdsh-mobile-ux] device theme failed", error);
        }
        try {
          boot(ctx);
        } catch (error) {
          console.error("[rdsh-mobile-ux] boot failed", error);
          emit({ bootError: String((error && error.message) || error) });
        }
        ctx.slots.inject("sidebar.workspaces.session.menu.item", () => ctx.slots.register({
          name: "sidebar.workspaces.session.menu.item",
          id: "rdsh-color-frame",
          order: 150,
        }, ColorFrameMenuItem));
        ctx.slots.inject("shell.overlay", () => ctx.slots.register({
          name: "shell.overlay",
          id: "rdsh-mobile-ux-notifications",
          order: 92,
        }, NotificationWatcher));
        ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
          name: "conversation.composer.dock",
          id: "rdsh-mobile-ux-live-speed",
          order: 2,
          inject: (sessionId) => ({ sessionId }),
        }, LiveSpeed));
        ctx.slots.inject("settings.section", () => ctx.slots.register({
          name: "settings.section",
          id: "mobile-ux",
          order: 81,
          label: () => t("tab.mobile"),
        }, MobileSection));
        ctx.slots.inject("settings.section", () => ctx.slots.register({
          name: "settings.section",
          id: "mobile-ux-input",
          order: 82,
          label: () => t("tab.input"),
        }, InputSection));
      },
    };
    }

    // ---------------------------------------------------------------------
    // rdsh-session-id-copy — copy a session id from its row menu.
    // ---------------------------------------------------------------------
    function sessionIdCopyPart() {

    const React = require("react");
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    const h = React.createElement;

    const SLOT = "sidebar.workspaces.session.menu.item";
    const ENTRY_ID = "rdsh-session-id-copy";
    // After the shipped rows (pin 100 / rename 200 / fork 300 / archive 400).
    const ORDER = 500;
    const LABEL = t("sessionId.label");
    const COPIED = t("sessionId.copied");
    const MANUAL_PROMPT = t("sessionId.manualPrompt");
    const TOAST_HOST_ID = "rdsh-session-id-copy-toast";
    const TOAST_ROOT_KEY = "__rdshSessionIdCopyToastRoot";


    // クリップボード: `navigator.clipboard` は secure context でしか生えない
    // (127.0.0.1 は secure、Tailscale の http://100.x.y.z は非 secure)。
    // 無い・拒否された場合は選択+execCommand に落ちる。
    async function copyText(text) {
      const clipboard =
        typeof navigator === "object" && navigator !== null ? navigator.clipboard : undefined;
      if (clipboard && typeof clipboard.writeText === "function") {
        try {
          await clipboard.writeText(text);
          return true;
        } catch (error) {
          // 権限拒否・非フォーカスなど。下のフォールバックへ。
        }
      }
      let area;
      try {
        area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.top = "0";
        area.style.left = "0";
        area.style.width = "1px";
        area.style.height = "1px";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.focus();
        area.select();
        area.setSelectionRange(0, text.length);
        return typeof document.execCommand === "function" && document.execCommand("copy") === true;
      } catch (error) {
        return false;
      } finally {
        area?.remove();
      }
    }

    // Toast は body portal。host を 1 つだけ作り、多重表示は最後の 1 件に畳む。
    // root は window に置く: ライブ更新でこのモジュールが読み直されても、
    // 同じ DOM ノードに 2 つ目の root を作らないため。
    function notify(text) {
      try {
        const { createRoot } = require("react-dom/client");
        let host = document.getElementById(TOAST_HOST_ID);
        if (host === null) {
          host = document.createElement("div");
          host.id = TOAST_HOST_ID;
          document.body.appendChild(host);
        }
        const root = (window[TOAST_ROOT_KEY] = window[TOAST_ROOT_KEY] ?? createRoot(host));
        root.render(
          h(primitives.Toast, {
            text,
            tone: "success",
            onDone: () => {
              root.render(null);
            },
          }),
        );
      } catch (error) {
        // 通知が出せなくてもコピー自体は成立している。
      }
    }

    /** One "..." menu row: copy this Session's ID, then close the menu. */
    function CopySessionIdMenuItem({ sessionId, useMenuOpenState }) {
      const [, setMenuOpen] = useMenuOpenState();
      const id = String(sessionId ?? "");
      return h(primitives.MenuItemButton, {
        // Icon seat of the shipped rows; the default 16px one-pixel outline,
        // like pin / rename / fork beside it.
        icon: h(primitives.IconCopyOutlineRegular, { key: "icon" }),
        onSelect: () => {
          setMenuOpen(false);
          void copyText(id).then((copied) => {
            if (copied) {
              notify(COPIED);
              return;
            }
            // 自動コピーが両方とも塞がれている環境では、選択済みの ID を見せる。
            if (typeof window === "object" && window !== null && typeof window.prompt === "function") {
              window.prompt(MANUAL_PROMPT, id);
            }
          });
        },
        children: LABEL,
      });
    }

    return {
      inject: ["slots"],
      apply(ctx) {
        // Wait for ui-workspace's declaration before contributing to it.
        ctx.slots.inject(SLOT, () =>
          ctx.slots.register({ name: SLOT, id: ENTRY_ID, order: ORDER, label: LABEL }, CopySessionIdMenuItem),
        );
      },
    };
    }

    // ---------------------------------------------------------------------
    // Wiring
    // ---------------------------------------------------------------------
    return {
      inject: ["slots"],
      apply(ctx) {
        // Order matters only for the one that touches the session menu: the id
        // copy row registers into its own slot, so any order works. Keep the
        // list readable.
        const parts = [pwaPart(), mobilePart(), sessionIdCopyPart()];
        for (const part of parts) {
          if (part !== null && typeof part === "object" && typeof part.apply === "function") part.apply(ctx);
        }
      },
    };
  },
});
