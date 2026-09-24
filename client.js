window.__ModuleLoader__.load({
	id: "@local/dsh-open-folder-fix",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const { Menu, Tooltip } = primitives;

		// The product-icon set was renamed in 0.1.7-rc.1: the name is now the
		// glyph plus its weight, and the pixel size is only a prop — "rendered
		// size remains a prop instead of part of the component name". The old
		// `…Outline14` spelling no longer exists.
		//
		// This is worth a fallback chain rather than a straight rename. The old
		// code destructured a missing export, got `undefined`, and handed it to
		// React.createElement — which throws inside the header slot, where the
		// render error boundary swallowed it and took the ENTIRE split button
		// down, chevron included. A missing icon must degrade to a missing
		// glyph, never to a missing button.
		const ChevronDown = primitives.IconChevronDownOutlineRegular
			?? primitives.IconChevronDownOutlineMedium
			?? primitives.IconChevronDownOutline
			?? primitives.IconChevronDownOutline14;

		//#region shared route constants (mirrors the host halves)
		/** Shipped application list route. */
		const SHIPPED_APPS_ROUTE = "/open-in-app/apps";
		/** Shipped per-application icon prefix. */
		const SHIPPED_ICON_PREFIX = "/open-in-app/icon";
		/** Shipped launch route for every application this fix does not own. */
		const SHIPPED_OPEN_ROUTE = "/open-in-app/open";
		/** This fix's launch route for the Windows file manager. */
		const FIXED_OPEN_ROUTE = "/open-folder-fix/open";
		/** The catalog id routed through the corrected Windows opener. */
		const EXPLORER_ID = "explorer";
		//#endregion

		//#region controller
		/** Resolve the browser's Host base with the connection carrier's null-origin fallback. */
		function hostBase() {
			const origin = globalThis.location?.origin;
			return origin !== undefined && origin !== "null" ? origin : "http://dsh.internal";
		}

		/**
		 * The application list arrives once per page: the host probes the
		 * installed catalog, and a reload re-reads it.
		 */
		let appsPromise;
		function loadApps() {
			appsPromise ??= (async () => {
				try {
					const response = await fetch(new URL(SHIPPED_APPS_ROUTE, hostBase()), { headers: { accept: "application/json" } });
					if (!response.ok) return [];
					const payload = await response.json();
					return Array.isArray(payload.apps) ? payload.apps.filter((id) => typeof id === "string") : [];
				} catch {
					return [];
				}
			})();
			return appsPromise;
		}

		/** The remembered application id, shared across sessions and browser restarts. */
		const CHOICE_KEY = "dsh.open-in-app.choice";
		function readChoice() {
			try {
				return globalThis.localStorage?.getItem(CHOICE_KEY) ?? "";
			} catch {
				return "";
			}
		}
		function writeChoice(id) {
			try {
				globalThis.localStorage?.setItem(CHOICE_KEY, id);
			} catch {
				// A storage-denied context keeps the choice for this page only.
			}
		}

		/**
		 * Launch one application on the workspace directory.
		 *
		 * The Windows file manager goes through this fix's host route, which
		 * uses `explorer.exe /e,<dir>`. Every other application keeps the
		 * shipped route untouched.
		 * @param appId - catalog id from the availability list.
		 * @param path - the session's absolute workspace directory.
		 * @returns after the host acknowledged the launch.
		 */
		async function launch(appId, path) {
			const route = appId === EXPLORER_ID ? FIXED_OPEN_ROUTE : SHIPPED_OPEN_ROUTE;
			const body = appId === EXPLORER_ID ? { path } : { app: appId, path };
			const response = await fetch(new URL(route, hostBase()), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!response.ok) throw new Error(`open failed: HTTP ${String(response.status)}`);
		}
		//#endregion

		//#region styles
		const css = [
			".dshOffSplit{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);height:28px;font-family:var(--dsw-font-family);border-radius:14px;align-items:stretch;display:inline-flex;overflow:hidden}",
			".dshOffMain,.dshOffChevron{color:var(--dsw-alias-label-primary);cursor:pointer;white-space:nowrap;background:0 0;border:0;align-items:center;gap:5px;font-size:11px;font-weight:400;line-height:16px;display:inline-flex}",
			".dshOffMain{padding:5px 6px 5px 7px}",
			".dshOffMain:hover:not(:disabled),.dshOffMain:focus-visible,.dshOffChevron:hover,.dshOffChevron:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}",
			".dshOffMain:disabled{color:var(--dsw-alias-label-dimmed);cursor:wait}",
			".dshOffMain[data-state=error]{color:var(--dsw-alias-state-error-primary);box-shadow:inset 0 0 0 1px var(--dsw-alias-state-error-primary)}",
			".dshOffChevron{border-left:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-secondary);padding:5px 6px 5px 4px}",
			".dshOffIcon{flex:none}",
			"img.dshOffIcon{object-fit:contain;user-select:none;display:block}",
		].join("");
		const CSS_TAG_ID = "@local/dsh-open-folder-fix/OpenFolderFix.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG_ID) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@local/dsh-open-folder-fix";
			tag.dataset.pluginCss = CSS_TAG_ID;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region component
		/**
		 * Catalog ids the browser can name, with one dictionary key per product.
		 * A host catalog extension without a matching key stays out of the menu
		 * instead of showing a raw id.
		 */
		const APP_LABEL_KEY = {
			explorer: "app.explorer",
			finder: "app.finder",
			filemanager: "app.filemanager",
			cursor: "app.cursor",
			vscode: "app.vscode",
			vscodeinsiders: "app.vscodeinsiders",
			windsurf: "app.windsurf",
			sublimetext: "app.sublimetext",
			androidstudio: "app.androidstudio",
			intellij: "app.intellij",
			pycharm: "app.pycharm",
			webstorm: "app.webstorm",
			goland: "app.goland",
			rider: "app.rider",
			rustrover: "app.rustrover",
			sublimemerge: "app.sublimemerge",
			github: "app.github",
			windowsterminal: "app.windowsterminal",
			gitbash: "app.gitbash",
			ghostty: "app.ghostty",
			kitty: "app.kitty",
			terminal: "app.terminal",
			gnometerminal: "app.gnometerminal",
			konsole: "app.konsole",
		};

		/** This plugin's locale dictionary namespace. */
		const NS = "open-folder-fix";

		/** Product names, identical in both dictionaries. */
		const PRODUCT_NAMES = {
			"app.cursor": "Cursor",
			"app.vscode": "VS Code",
			"app.vscodeinsiders": "VS Code Insiders",
			"app.windsurf": "Windsurf",
			"app.sublimetext": "Sublime Text",
			"app.androidstudio": "Android Studio",
			"app.intellij": "IntelliJ IDEA",
			"app.pycharm": "PyCharm",
			"app.webstorm": "WebStorm",
			"app.goland": "GoLand",
			"app.rider": "Rider",
			"app.rustrover": "RustRover",
			"app.sublimemerge": "Sublime Merge",
			"app.github": "GitHub Desktop",
			"app.windowsterminal": "Windows Terminal",
			"app.gitbash": "Git Bash",
			"app.ghostty": "Ghostty",
			"app.kitty": "kitty",
			"app.gnometerminal": "GNOME Terminal",
			"app.konsole": "Konsole",
		};

		/** Simplified Chinese dictionary (the key-set source of truth). */
		const zh = {
			"open.title": "在 {app} 中打开工作目录",
			"open.tooltip": "在本地打开",
			"open.error": "打开失败",
			"menu.toggle": "选择打开方式",
			...PRODUCT_NAMES,
			"app.explorer": "文件资源管理器",
			"app.finder": "访达",
			"app.filemanager": "文件管理器",
			"app.terminal": "终端",
		};

		/** English dictionary, key-identical to the Chinese source of truth. */
		const en = {
			"open.title": "Open workspace in {app}",
			"open.tooltip": "Open locally",
			"open.error": "Failed to open",
			"menu.toggle": "Choose an app to open in",
			...PRODUCT_NAMES,
			"app.explorer": "File Explorer",
			"app.finder": "Finder",
			"app.filemanager": "Files",
			"app.terminal": "Terminal",
		};

		/** Application ids whose icon already failed this page. */
		const failedIcons = new Set();

		/**
		 * One application's host-served icon, or a generic glyph when the host
		 * has none.
		 */
		function AppIcon({ id, size }) {
			const [failed, setFailed] = React.useState(failedIcons.has(id));
			if (failed) {
				return React.createElement("svg", {
					width: size,
					height: size,
					viewBox: "0 0 24 24",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 1.8,
					className: "dshOffIcon",
					"aria-hidden": true,
				}, React.createElement("rect", { x: 3, y: 3, width: 18, height: 18, rx: 5 }));
			}
			return React.createElement("img", {
				src: `${SHIPPED_ICON_PREFIX}/${id}`,
				width: size,
				height: size,
				className: "dshOffIcon",
				alt: "",
				"aria-hidden": true,
				draggable: false,
				onError: () => {
					failedIcons.add(id);
					setFailed(true);
				},
			});
		}

		/** Quick launches settle under this delay, so their busy dress never paints. */
		const BUSY_DRESS_DELAY_MS = 250;

		/**
		 * Session-header split button: the main button opens the session's
		 * workspace directory in the remembered application through the
		 * corrected Windows opener, and the chevron opens the application menu.
		 * @param props - session props from the slot plus the injected controller face and `t`.
		 */
		function OpenFolderFixAction(props) {
			const { sessionId, useSessions, t } = props;
			const cwd = useSessions((state) => state.byId[sessionId]?.cwd);
			const [available, setAvailable] = React.useState(null);
			const [choice, setChoice] = React.useState(readChoice);
			const [open, setOpen] = React.useState(false);
			const [phase, setPhase] = React.useState("idle");
			const inFlight = React.useRef(false);
			const busyTimer = React.useRef(undefined);
			const errorTimer = React.useRef(undefined);

			React.useEffect(() => {
				let live = true;
				loadApps().then((ids) => {
					if (live) setAvailable(ids);
				});
				return () => {
					live = false;
					clearTimeout(busyTimer.current);
					clearTimeout(errorTimer.current);
				};
			}, []);

			const apps = (available ?? [])
				.filter((id) => APP_LABEL_KEY[id] !== undefined)
				.map((id) => ({ id, labelKey: APP_LABEL_KEY[id] }));

			const currentEntry = apps.find((entry) => entry.id === choice) ?? apps[0];
			if (currentEntry === undefined || cwd === undefined || cwd === "") return null;
			const current = currentEntry.id;
			const currentLabel = t(currentEntry.labelKey);
			const title = phase === "error" ? t("open.error") : t("open.title", { app: currentLabel });

			const start = (appId) => {
				if (inFlight.current) return;
				inFlight.current = true;
				clearTimeout(errorTimer.current);
				clearTimeout(busyTimer.current);
				busyTimer.current = setTimeout(() => {
					setPhase("busy");
				}, BUSY_DRESS_DELAY_MS);
				launch(appId, cwd).then(() => {
					inFlight.current = false;
					clearTimeout(busyTimer.current);
					setPhase("idle");
				}, () => {
					inFlight.current = false;
					clearTimeout(busyTimer.current);
					setPhase("error");
					clearTimeout(errorTimer.current);
					errorTimer.current = setTimeout(() => {
						setPhase("idle");
					}, 2000);
				});
			};

			return React.createElement(Menu, {
				open,
				align: "end",
				dense: true,
				selection: "fill",
				onClose: () => {
					setOpen(false);
				},
				items: apps.map((entry) => ({
					id: entry.id,
					label: t(entry.labelKey),
					icon: React.createElement(AppIcon, { id: entry.id, size: 18 }),
				})),
				selectedId: current,
				onSelect: (id) => {
					setOpen(false);
					if (inFlight.current) return;
					setChoice(id);
					writeChoice(id);
					start(id);
				},
				anchor: React.createElement("div", { className: "dshOffSplit" },
					React.createElement(Tooltip, {
						label: phase === "error" ? t("open.error") : t("open.tooltip"),
						side: "bottom",
					}, React.createElement("button", {
						type: "button",
						className: "dshOffMain",
						"data-state": phase,
						disabled: phase === "busy",
						"aria-label": title,
						onClick: () => {
							start(current);
						},
					}, React.createElement(AppIcon, { id: current, size: 15 }))),
					React.createElement("button", {
						type: "button",
						className: "dshOffChevron",
						"aria-expanded": open,
						"aria-haspopup": "menu",
						title: t("menu.toggle"),
						"aria-label": t("menu.toggle"),
						onClick: () => {
							setOpen((value) => !value);
						},
					}, ChevronDown === undefined ? null : React.createElement(ChevronDown, { size: 11 }))),
			});
		}
		//#endregion

		//#region plugin
		/** Client services this plugin registers against. */
		const inject = ["slots", "locale"];

		/**
		 * Register the corrected Session-header action.
		 *
		 * The cell id is the shipped one, so any owner that addresses the
		 * "open in application" action by id reaches this component; the
		 * shipped browser half is disabled in the bundle patch, which keeps
		 * exactly one registrant for the cell.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "open-folder-fix: dictionaries");
			ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
				name: "conversation.session.header.utilities",
				id: "open-in-app",
				order: -10,
				locale: NS,
				inject: () => ({}),
			}, OpenFolderFixAction));
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
