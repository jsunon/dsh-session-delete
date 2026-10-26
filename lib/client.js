/**
 * dsh-session-delete —— 浏览器半区。
 *
 * 往 `sidebar.workspaces.session.menu.item`（会话行「…」菜单的列表槽）插一行
 * 「删除会话」，再往 `shell.overlay` 挂一个确认对话框。确认后调用宿主路由
 * `POST /dsh-session-delete/api/delete`，落盘动作全部在宿主半区完成。
 *
 * 为什么对话框必须另挂 `shell.overlay`：菜单项会随菜单一起卸载（点一下就关），
 * 在菜单项里开对话框会在同一帧被连根拔掉。
 */
window.__ModuleLoader__.load({
	id: "dsh-session-delete",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var React = require("react");
		var primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		var h = React.createElement;
		var Fragment = React.Fragment;

		/** 语言命名空间；slot 注册时带同一个 NS 才能拿到翻译好的 t。 */
		var NS = "dsh-session-delete";
		var ENDPOINT = "/dsh-session-delete/api/delete";

		var zh = {
			"menu.deleteSession": "删除会话",
			"dialog.title": "永久删除会话",
			"dialog.desc": "「{title}」的会话日志、投影缓存与工作区记录都会被删除，不可恢复。",
			"dialog.untitled": "未命名会话",
			"dialog.detail": "确认后立刻从磁盘移除，无法撤销。归档（Ctrl + Shift + A）只是隐藏，仍可恢复。",
			"cancel": "取消",
			"dialog.confirm": "永久删除",
			"dialog.pending": "正在删除…",
			"dialog.live": "该会话仍在打开状态，先切换到其他会话（或刷新页面）再删一次。",
			"dialog.failed": "删除失败：{message}",
			"dialog.close": "关闭",
		};

		var en = {
			"menu.deleteSession": "Delete session",
			"dialog.title": "Delete session permanently",
			"dialog.desc": "The log, projection cache and workspace entries of “{title}” will be removed. This cannot be undone.",
			"dialog.untitled": "Untitled session",
			"dialog.detail": "The files are removed from disk immediately and cannot be restored. Archive (Ctrl + Shift + A) only hides a session.",
			"cancel": "Cancel",
			"dialog.confirm": "Delete permanently",
			"dialog.pending": "Deleting…",
			"dialog.live": "This session is still open. Switch to another session (or reload the page), then delete it again.",
			"dialog.failed": "Delete failed: {message}",
			"dialog.close": "Close",
		};

		/* ── 待确认请求：模块级小 store，菜单项写入，shell.overlay 里的对话框消费 ── */
		var pending = null;
		var listeners = new Set();
		function emit() {
			for (var listener of Array.from(listeners)) {
				try {
					listener();
				} catch (error) {
					console.warn("[dsh-session-delete] pending listener failed:", error);
				}
			}
		}
		function setPending(next) {
			pending = next;
			emit();
		}
		function subscribe(listener) {
			listeners.add(listener);
			return function unsubscribe() {
				listeners.delete(listener);
			};
		}
		function getPending() {
			return pending;
		}
		function usePending() {
			return React.useSyncExternalStore(subscribe, getPending, getPending);
		}

		/** 宿主回执 → 一句给人看的话。 */
		function messageOf(payload, fallback) {
			if (payload && typeof payload.message === "string" && payload.message !== "") return payload.message;
			if (payload && typeof payload.error === "string" && payload.error !== "") return payload.error;
			return fallback;
		}

		/** 会话「…」菜单里的一行：点一下只登记请求，真正的对话框在 shell.overlay。 */
		function DeleteSessionMenuItem(props) {
			var setMenuOpen = typeof props.useMenuOpenState === "function" ? props.useMenuOpenState()[1] : undefined;
			return h(
				primitives.MenuItemButton,
				{
					icon: h(primitives.IconTrashOutlineRegular, { size: 14 }),
					onSelect: function onSelect() {
						if (typeof setMenuOpen === "function") setMenuOpen(false);
						setPending({
							sessionId: props.sessionId,
							displayTitle: typeof props.displayTitle === "string" ? props.displayTitle : "",
						});
					},
				},
				props.t("menu.deleteSession"),
			);
		}

		/** shell.overlay 入口：没有待办请求时什么都不渲染。 */
		function DeleteSessionDialog(props) {
			var request = usePending();
			if (request === null) return null;
			return h(DeleteSessionConfirmForm, {
				key: request.sessionId,
				request: request,
				t: props.t,
				runtime: props.runtime,
			});
		}

		/** 单个请求的对话框：进行中状态与错误都随它一起销毁。 */
		function DeleteSessionConfirmForm(props) {
			var request = props.request;
			var t = props.t;
			var runtime = props.runtime;
			var busyState = React.useState(false);
			var busy = busyState[0];
			var setBusy = busyState[1];
			var errorState = React.useState(null);
			var error = errorState[0];
			var setError = errorState[1];

			var close = React.useCallback(
				function close() {
					if (busy) return;
					setPending(null);
				},
				[busy],
			);

			var confirm = React.useCallback(
				function confirm() {
					setBusy(true);
					setError(null);
					fetch(ENDPOINT, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ sessionId: request.sessionId }),
					})
						.then(function onResponse(response) {
							return response
								.json()
								.catch(function onParseFailure() {
									return {};
								})
								.then(function onBody(payload) {
									return { response: response, payload: payload };
								});
						})
						.then(function onResult(result) {
							var payload = result.payload || {};
							if (!result.response.ok || payload.ok !== true) {
								if (payload.error === "session-live") throw new Error(t("dialog.live"));
								throw new Error(t("dialog.failed", { message: messageOf(payload, "HTTP " + String(result.response.status)) }));
							}
							setBusy(false);
							setPending(null);
							// 列表来自宿主目录快照：删完刷新一次，行才会消失。
							try {
								var sessions = runtime.sessions;
								if (sessions && typeof sessions.refresh === "function") sessions.refresh().catch(function onRefreshFailure() {});
							} catch (refreshError) {
								console.warn("[dsh-session-delete] sessions refresh failed:", refreshError);
							}
						})
						.catch(function onFailure(reason) {
							setBusy(false);
							setError(reason instanceof Error ? reason.message : String(reason));
						});
				},
				[request.sessionId, t, runtime],
			);

			var footer = h(
				Fragment,
				null,
				h(
					primitives.Button,
					{ variant: "outline", disabled: busy, onClick: close },
					t("cancel"),
				),
				h(
					primitives.Button,
					{ variant: "outline", tone: "danger", disabled: busy, onClick: confirm },
					t("dialog.confirm"),
				),
			);

			var title = request.displayTitle !== "" ? request.displayTitle : t("dialog.untitled");

			return h(
				primitives.Modal,
				{
					open: true,
					onClose: close,
					closeLabel: t("dialog.close"),
					title: t("dialog.title"),
					description: t("dialog.desc", { title: title }),
					footer: footer,
				},
				h(
					"div",
					{ style: { display: "flex", flexDirection: "column", gap: "8px" } },
					h("div", { style: { opacity: 0.75 } }, t("dialog.detail")),
					busy
						? h("div", { role: "status", style: { opacity: 0.75 } }, t("dialog.pending"))
						: null,
					error !== null
						? h("div", { role: "alert", style: { color: "var(--dsw-alias-label-danger, #d9534f)" } }, error)
						: null,
				),
			);
		}

		function apply(ctx) {
			ctx.effect(function registerLocale() {
				return ctx.locale.register(NS, { zh: zh, en: en });
			}, "session-delete locale");

			var t = ctx.locale.bind(NS);
			var runtime = { sessions: undefined };
			ctx.effect(function readSessionsService() {
				return ctx.inject(["sessions"], function onSessions(sessions) {
					runtime.sessions = sessions;
					return function releaseSessions() {
						runtime.sessions = undefined;
					};
				});
			}, "session-delete sessions service");

			ctx.slots.inject("sidebar.workspaces.session.menu.item", function registerMenuItem() {
				return ctx.slots.register(
					{
						name: "sidebar.workspaces.session.menu.item",
						id: "session-delete",
						order: 500,
						locale: NS,
						inject: function injected() {
							return { t: t };
						},
					},
					DeleteSessionMenuItem,
				);
			});

			ctx.slots.inject("shell.overlay", function registerDialog() {
				return ctx.slots.register(
					{
						name: "shell.overlay",
						id: "session-delete-dialog",
						order: 65,
						locale: NS,
						inject: function injected() {
							return { t: t, runtime: runtime };
						},
					},
					DeleteSessionDialog,
				);
			});
		}

		exports.apply = apply;
		exports.inject = ["slots", "locale"];
		exports.name = "session-delete";
		return module.exports;
	},
});
