/**
 * dsh-session-delete —— 宿主半区。
 *
 * DSH 本身没有 `deleteSession` 这类 RPC（session 的持久化只有 create / open /
 * append / flush / list / stat，workspace 账本只有 attach / detach / archive /
 * pin 这些「移除引用」的能力），所以「删除会话」必须在这里自己拼三步：
 *
 *   1. 先把这个会话从活存储里摘下来 —— 活会话持有写入句柄与文件句柄，不摘就删盘
 *      会得到 EBUSY（Windows）或者让后续 append 写进一个已删除的 inode；
 *   2. 删掉它在磁盘上的全部产物 —— 会话日志目录（`~/.dsh/sessions/<项目键>/<id>/`）
 *      与投影缓存（`~/.dsh/storages/session_projcache/sessions/<id>.json`）；
 *   3. 把它从 workspace 账本里摘掉 —— 每个 workspace 的 `sessionIds` 槽位、
 *      全局归档集合与置顶集合，走 registry 的正式写路径（活的 registry 会自己
 *      落盘并广播快照，绕过它直接改 workspace.json 会被随后的写入覆盖）。
 *
 * 浏览器半区只负责菜单项与确认框，所有落盘动作都收敛在这一个 POST 路由里。
 *
 * @module dsh-session-delete
 */

import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** 宿主路由前缀；与网关的 `/api/*` 命名空间分开，避免和 RPC 抢路径。 */
const ROUTE_PREFIX = "/dsh-session-delete/api";
const DELETE_PATH = `${ROUTE_PREFIX}/delete`;
const HEALTH_PATH = `${ROUTE_PREFIX}/health`;
const BODY_LIMIT = 8 * 1024;
/** 会话 id 会直接成为目录名的一段，这里只放行不可能越界的安全字符集。 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const name = "session-delete";

/** DSH 主目录：桌面端统一为 `~/.dsh`，但允许 `DSH_HOME` 覆盖。 */
function resolveDshHome() {
	const fromEnv = process.env.DSH_HOME;
	return typeof fromEnv === "string" && fromEnv.trim() !== "" ? resolve(fromEnv) : join(homedir(), ".dsh");
}

function headerOf(request, header) {
	const value = request.headers?.[header];
	if (Array.isArray(value)) return value[0] ?? "";
	return typeof value === "string" ? value : "";
}

function writeJson(response, status, body) {
	const text = JSON.stringify(body);
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"content-length": String(Buffer.byteLength(text)),
	});
	response.end(text);
}

function denyCrossOrigin(response) {
	writeJson(response, 403, { ok: false, error: "forbidden" });
}

/**
 * 与 dsh-purge / task-board 同款的浏览器栅栏：拒绝跨站请求，带 Origin 时必须与
 * Host 同源。不额外要求回环来源，这样远程访问（隧道 / 反代）进来的浏览器也能用。
 */
function allowRequest(request, response) {
	const site = headerOf(request, "sec-fetch-site").toLowerCase();
	if (site === "cross-site") {
		denyCrossOrigin(response);
		return false;
	}
	const origin = headerOf(request, "origin").trim();
	if (origin === "null") {
		denyCrossOrigin(response);
		return false;
	}
	if (origin === "") return true;
	let originHost;
	try {
		originHost = new URL(origin).host.toLowerCase();
	} catch {
		denyCrossOrigin(response);
		return false;
	}
	const host = headerOf(request, "host").trim().toLowerCase();
	if (host === "" || originHost !== host) {
		denyCrossOrigin(response);
		return false;
	}
	return true;
}

async function readJsonBody(request) {
	const chunks = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > BODY_LIMIT) throw new Error("body-too-large");
		chunks.push(buffer);
	}
	const raw = Buffer.concat(chunks).toString("utf8").trim();
	return raw === "" ? {} : JSON.parse(raw);
}

/**
 * 收集一个会话在磁盘上的全部产物路径。
 *
 * 首选持久化后端的 `stat` + `locate`（它知道项目目录键与编码后的文件名），再用
 * `~/.dsh/sessions/*` 的目录扫描兜底 —— 后者能捞到「账本里已经没人引用、但目录
 * 还留着」的孤儿会话，那正是用户最想删掉的那种。
 *
 * @param ctx - 宿主上下文，用来取 sessionPersistence。
 * @param home - DSH 主目录。
 * @param sessionId - 目标会话 id。
 * @returns 去重后的绝对路径列表（会话目录 + 投影缓存文件）。
 */
async function collectArtifacts(ctx, home, sessionId) {
	const artifacts = new Set();
	const persistence = ctx.get("sessionPersistence");
	if (persistence !== undefined && typeof persistence.stat === "function" && typeof persistence.locate === "function") {
		try {
			const meta = await persistence.stat(sessionId);
			if (meta !== undefined) {
				const located = persistence.locate(meta);
				if (located !== undefined && typeof located.path === "string" && located.path !== "") artifacts.add(dirname(located.path));
			}
		} catch {
			/* 账本里没有这个会话：交给下面的目录扫描 */
		}
	}
	const sessionsRoot = join(home, "sessions");
	if (existsSync(sessionsRoot)) {
		let projectDirs = [];
		try {
			projectDirs = await readdir(sessionsRoot, { withFileTypes: true });
		} catch {
			projectDirs = [];
		}
		for (const projectDir of projectDirs) {
			if (!projectDir.isDirectory()) continue;
			const candidate = join(sessionsRoot, projectDir.name, sessionId);
			if (existsSync(candidate)) artifacts.add(candidate);
		}
	}
	const projection = join(home, "storages", "session_projcache", "sessions", `${sessionId}.json`);
	if (existsSync(projection)) artifacts.add(projection);
	return [...artifacts];
}

/**
 * 把会话从 workspace 账本里摘干净：每个 workspace 的槽位、归档集合、置顶集合。
 * 走 registry 的正式写路径，落盘与快照广播都由它负责。
 */
async function detachFromLedger(ctx, sessionId) {
	const registry = ctx.get("workspaceRegistry");
	if (registry === undefined) return { touched: [], failures: [{ step: "workspaceRegistry", error: "workspace registry service is absent" }] };
	const touched = [];
	const failures = [];
	let workspaces = [];
	try {
		workspaces = registry.list();
	} catch (error) {
		return { touched, failures: [{ step: "workspaceRegistry.list", error: String(error) }] };
	}
	for (const workspace of workspaces) {
		if (typeof workspace?.detachSession !== "function") continue;
		try {
			if (typeof workspace.sessionIds?.includes === "function" && workspace.sessionIds.includes(sessionId)) {
				await workspace.detachSession(sessionId);
				touched.push(`workspace:${workspace.id ?? workspace.path ?? "?"}`);
			}
		} catch (error) {
			failures.push({ step: `workspace.detachSession:${workspace.id ?? "?"}`, error: String(error) });
		}
	}
	if (typeof registry.unarchiveSession === "function") {
		try {
			await registry.unarchiveSession(sessionId);
			touched.push("unarchive");
		} catch (error) {
			failures.push({ step: "unarchiveSession", error: String(error) });
		}
	}
	if (typeof registry.unpinSession === "function") {
		try {
			await registry.unpinSession(sessionId);
			touched.push("unpin");
		} catch (error) {
			failures.push({ step: "unpinSession", error: String(error) });
		}
	}
	return { touched, failures };
}

/**
 * 把仍然挂在会话存储里的会话摘下来。
 *
 * 顺序是有原因的：
 *   1. `workspace/session-stop` 取消该会话里正在跑的回合（dsh-agent / dsh-jobs /
 *      dsh-schedule 都监听这个钩子），否则摘下来之后回合还会继续往已删除的路径写；
 *   2. `sessions.flush` 把缓冲里的事件冲到磁盘，避免丢掉最后几条消息；
 *   3. `entry.detach()` 把条目从 store 移除并派发 `session/disposed` —— 持久化后端
 *      会在这个事件里关掉文件句柄，之后 `rm` 才不会被 Windows 的共享锁挡住。
 *
 * @param ctx - 宿主上下文。
 * @param sessionId - 目标会话 id。
 * @returns 是否曾经是活会话，以及摘挂之后是否仍然活着。
 */
async function closeLiveSession(ctx, sessionId) {
	const sessions = ctx.get("sessions");
	if (sessions === undefined || typeof sessions.get !== "function") return { live: false, stillLive: false, steps: [] };
	const session = sessions.get(sessionId);
	if (session === undefined) return { live: false, stillLive: false, steps: [] };
	const steps = [];
	const registry = ctx.get("workspaceRegistry");
	try {
		if (registry !== undefined && typeof registry.stopSessionActivity === "function") await registry.stopSessionActivity(sessionId);
		else if (typeof ctx.parallel === "function") await ctx.parallel("workspace/session-stop", { sessionId });
		steps.push("stop");
	} catch (error) {
		steps.push(`stop-failed:${String(error)}`);
	}
	try {
		if (typeof sessions.flush === "function") await sessions.flush(session);
		steps.push("flush");
	} catch (error) {
		steps.push(`flush-failed:${String(error)}`);
	}
	let entry;
	try {
		entry = typeof sessions.liveEntryFor === "function" ? sessions.liveEntryFor(session) : undefined;
	} catch (error) {
		steps.push(`entry-failed:${String(error)}`);
	}
	if (entry !== undefined && typeof entry.detach === "function") {
		try {
			entry.detach();
			steps.push("detach");
		} catch (error) {
			steps.push(`detach-failed:${String(error)}`);
		}
	}
	/* 让 `session/disposed` 的监听者把句柄关掉再回去报状态。 */
	await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
	const stillLive = sessions.get(sessionId) !== undefined;
	return { live: true, stillLive, steps };
}

/**
 * 删除一个会话：先摘下活会话 → 删盘 → 记账本。
 *
 * @param ctx - 宿主上下文。
 * @param sessionId - 目标会话 id。
 * @returns 给浏览器半区的结构化结果；`ok` 为真表示会话已从所有可见面消失。
 */
async function deleteSession(ctx, sessionId) {
	const closed = await closeLiveSession(ctx, sessionId);
	if (closed.stillLive) {
		return {
			ok: false,
			status: 409,
			sessionId,
			error: "session-live",
			message: "这个会话仍被正在运行的任务占用，暂时没法从磁盘移除。等它跑完再删一次。",
			steps: closed.steps,
		};
	}

	const home = resolveDshHome();
	const artifacts = await collectArtifacts(ctx, home, sessionId);
	if (artifacts.length === 0) {
		/*
		 * 盘上没有产物：仍然尝试记账本（可能只是一条指向已消失目录的残留记录），
		 * 但要让调用方知道这不是一次真正的删除。
		 */
		const ledger = await detachFromLedger(ctx, sessionId);
		return {
			ok: ledger.failures.length === 0,
			status: ledger.failures.length === 0 ? 404 : 500,
			sessionId,
			error: ledger.failures.length === 0 ? "session-not-found" : "ledger-failed",
			message: ledger.failures.length === 0 ? "磁盘上找不到这个会话的产物（可能已经被删除）。" : "账本清理失败。",
			removed: [],
			ledger: ledger.touched,
			failures: ledger.failures,
		};
	}

	const removed = [];
	const failures = [];
	for (const path of artifacts) {
		try {
			await rm(path, { recursive: true, force: true });
			removed.push(path);
		} catch (error) {
			failures.push({ step: `rm:${path}`, error: String(error) });
		}
	}
	/* 摘下活会话之后仍有可能被收尾的写入重建目录：等一拍再清一次。 */
	await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
	for (const path of artifacts) {
		if (!existsSync(path)) continue;
		try {
			await rm(path, { recursive: true, force: true });
		} catch (error) {
			failures.push({ step: `rm-again:${path}`, error: String(error) });
		}
	}
	if (failures.length > 0) {
		/* 盘没删干净就不要再动账本：留着记录，用户才有机会重试。 */
		return {
			ok: false,
			status: 500,
			sessionId,
			error: "filesystem-failed",
			message: "会话文件删除失败（仍被占用？），账本未改动，可以重试。",
			removed,
			failures,
		};
	}

	const ledger = await detachFromLedger(ctx, sessionId);
	return {
		ok: true,
		status: 200,
		sessionId,
		error: undefined,
		removed,
		ledger: ledger.touched,
		failures: ledger.failures,
	};
}

export function apply(ctx) {
	ctx.inject(["webServer"], (host) => {
		host.effect(() => {
			const disposers = [];
			const track = (disposer) => {
				if (typeof disposer === "function") disposers.push(disposer);
				return disposer;
			};
			const route = (spec) => track(host.webServer.register({
				...spec,
				handler: async (request, response) => {
					if (!allowRequest(request, response)) return;
					return spec.handler(request, response);
				},
			}));

			route({
				kind: "exact",
				path: HEALTH_PATH,
				handler: (request, response) => {
					writeJson(response, 200, { ok: true, plugin: "dsh-session-delete", dshHome: resolveDshHome() });
				},
			});

			route({
				kind: "exact",
				path: DELETE_PATH,
				handler: async (request, response) => {
					if (request.method !== "POST") {
						writeJson(response, 405, { ok: false, error: "method-not-allowed" });
						return;
					}
					const contentType = headerOf(request, "content-type").toLowerCase();
					if (!contentType.startsWith("application/json")) {
						writeJson(response, 415, { ok: false, error: "json-required" });
						return;
					}
					let body;
					try {
						body = await readJsonBody(request);
					} catch (error) {
						writeJson(response, String(error) === "Error: body-too-large" ? 413 : 400, { ok: false, error: "invalid-body" });
						return;
					}
					const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
					if (!SESSION_ID_PATTERN.test(sessionId)) {
						writeJson(response, 400, { ok: false, error: "invalid-session-id" });
						return;
					}
					try {
						const result = await deleteSession(ctx, sessionId);
						writeJson(response, result.status ?? 200, result);
					} catch (error) {
						ctx.logger?.warn?.(`session-delete: deleting "${sessionId}" failed: ${String(error)}`);
						writeJson(response, 500, { ok: false, error: "internal", message: String(error) });
					}
				},
			});

			return () => {
				for (const dispose of disposers) {
					try {
						dispose();
					} catch (error) {
						ctx.logger?.warn?.(`session-delete: route dispose failed: ${String(error)}`);
					}
				}
			};
		}, "session-delete routes");
	});
}

export default { name, inject: [], apply };
