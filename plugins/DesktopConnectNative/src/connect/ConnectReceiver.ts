import { createServer, type Server } from "https";
import { createServer as createTcpServer, type AddressInfo, type Server as TcpServer } from "net";
import { randomUUID } from "crypto";
import { WebSocketServer, type WebSocket } from "ws";

// The TIDAL Connect receiver: the protocol TIDAL's own tidal_connect_application speaks to the phone,
// as worked out by Brskt for Lunar's own implementation (https://github.com/Brskt/TidaLuna/tree/lunar-cef, src/connect).
// Written anew from it, the protocol is the same
// a TLS WebSocket with JSON messages. The phone only trusts TIDAL's CA, so the server needs TIDAL's desktop certificate and its key.
// Playback itself is the renderer's (TIDAL's player), the receiver tells it what to load and play and hears back what it does.

// Sent to the player (the renderer)
export type PlayerCommand =
	| { type: "load"; mediaId: string; mediaType: number; autoplay: boolean }
	| { type: "play" }
	| { type: "pause" }
	| { type: "seek"; positionMs: number }
	| { type: "stop" }
	| { type: "volume"; level: number }
	| { type: "mute"; mute: boolean }
	// The session ended or its last phone left, the player stops following the receiver
	| { type: "release" }
	// A phone resumed the session, the player follows the receiver again (without reloading the media)
	| { type: "attach" };

export type PlayerState = "IDLE" | "BUFFERING" | "PAUSED" | "PLAYING";
// Heard from the player
export type PlayerEvent =
	| { type: "state"; state: PlayerState }
	| { type: "progress"; positionMs: number }
	| { type: "ended" }
	| { type: "error"; message?: string }
	// The desktop user pressed next or previous
	| { type: "next" }
	| { type: "previous" };

type Json = Record<string, any>;

type OAuthParameters = { accessToken: string; refreshToken: string };
type ServerInfo = {
	serverUrl: string;
	authInfo?: {
		headerAuth?: string;
		oauthParameters?: OAuthParameters;
		oauthServerInfo?: {
			serverUrl: string;
			authInfo: { headerAuth?: string; oauthParameters?: OAuthParameters };
			formParameters?: { grant_type: string; scope: string };
		};
	};
};
type RepeatMode = "NONE" | "ONE" | "ALL";
type QueueInfo = { queueId: string; repeatMode: RepeatMode; shuffled: boolean; maxBeforeSize: number; maxAfterSize: number };
type MediaInfo = {
	itemId: string;
	mediaId: string;
	mediaType: number;
	metadata?: Json;
	policy?: Json;
	streamType?: string;
};

export type ReceiverOptions = {
	cert: string | Buffer;
	key: string | Buffer;
	// The phone connects to port 9000 whatever the mDNS record says, 0 picks a free port (tests)
	port: number;
	// Listens on these addresses only (setHosts follows network changes), on all of them when not given
	hosts?: string[];
	toPlayer: (command: PlayerCommand) => void;
	log?: (...args: unknown[]) => void;
	// Tests point the receiver at a local queue server
	isTrustedUrl?: (url: string) => boolean;
};

const pingIntervalMs = 15_000;
const pingTimeoutMs = 31_000;
const progressIntervalMs = 1_000;
const httpTimeoutMs = 30_000;

// The phone hands over its own tokens, they must only ever go to TIDAL's servers
export const isTidalUrl = (url: string) => {
	try {
		const { protocol, hostname } = new URL(url);
		if (protocol !== "https:") return false;
		return ["tidal.com", "tidalhifi.com"].some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
	} catch {
		return false;
	}
};

const repeatModeOf = (mode: unknown): RepeatMode => (mode === "ONE" || mode === "ALL" ? mode : "NONE");

export class ConnectReceiver {
	// Not listening itself, the TCP listeners hand it their connections
	private readonly server: Server;
	// By address, "" for all addresses
	private readonly listeners = new Map<string, TcpServer>();
	// Addresses it could not listen on, logged once
	private readonly failedHosts = new Set<string>();
	private readonly wss: WebSocketServer;
	private readonly sockets = new Map<WebSocket, { alive: number }>();
	private readonly pingTimer: NodeJS.Timeout;
	private readonly log: (...args: unknown[]) => void;
	private readonly isTrustedUrl: (url: string) => boolean;

	private session?: { id: string; members: Set<WebSocket>; suspended: boolean };

	// The queue the phone loaded
	private contentServer?: ServerInfo;
	private queueServer?: ServerInfo;
	private queueInfo?: QueueInfo;
	private items: Json[] = [];
	private index?: number;
	private media?: MediaInfo;

	// What the player reported last
	private playerState: PlayerState = "IDLE";
	private positionMs = 0;
	private lastProgressSent = 0;
	// Set at the end of the queue: TIDAL still reports the stopped track (paused), the phone must see the receiver idle
	private finished = false;

	// Commands and player events are handled one after another, a queue request must not let a later command overtake it
	private pending: Promise<unknown> = Promise.resolve();
	private serial(task: () => unknown, what: string) {
		const run = this.pending.then(task).catch((err) => this.log(what, "failed", err));
		this.pending = run;
		return run;
	}

	private constructor(private readonly options: ReceiverOptions) {
		this.log = options.log ?? (() => {});
		this.isTrustedUrl = options.isTrustedUrl ?? isTidalUrl;
		this.server = createServer({ cert: options.cert, key: options.key });
		// The phone's messages are small JSON, ws would accept 100 MiB
		this.wss = new WebSocketServer({ server: this.server, maxPayload: 1024 * 1024 });
		// ws forwards the server's errors (port in use) and would throw them without a listener
		this.wss.on("error", (err) => this.log("server error", err));
		this.wss.on("connection", (socket) => this.onConnection(socket));
		this.pingTimer = setInterval(() => this.pingAll(), pingIntervalMs);
	}

	// Without hosts it rejects when the port is taken, with hosts it starts on the ones it can listen on (maybe none)
	static async start(options: ReceiverOptions) {
		const receiver = new ConnectReceiver(options);
		if (options.hosts !== undefined) {
			await receiver.setHosts(options.hosts);
			return receiver;
		}
		await receiver.listen("").catch((err) => {
			clearInterval(receiver.pingTimer);
			throw err;
		});
		return receiver;
	}

	// Listens on the addresses the computer has now: new ones are added, gone ones closed
	setHosts(hosts: string[]) {
		// One change at a time, a second listen on the same address would fail
		const run = this.hostsChange.then(() => this.applyHosts(hosts));
		this.hostsChange = run;
		return run;
	}
	private hostsChange: Promise<void> = Promise.resolve();
	private stopped = false;
	private async applyHosts(hosts: string[]) {
		if (this.stopped) return;
		for (const [host, listener] of this.listeners) {
			if (hosts.includes(host)) continue;
			this.listeners.delete(host);
			listener.close();
			this.log("Stopped listening on", host);
		}
		for (const host of hosts) {
			if (this.stopped) return;
			if (this.listeners.has(host)) continue;
			await this.listen(host).then(
				() => {
					this.failedHosts.delete(host);
					this.log("Listening on", host, "port", this.port);
				},
				(err) => {
					if (this.failedHosts.has(host)) return;
					this.failedHosts.add(host);
					this.log("Cannot listen on", host, "port", this.options.port, err.code ?? err);
				},
			);
		}
	}

	get listening() {
		return this.listeners.size !== 0;
	}

	private listen(host: string) {
		const listener = createTcpServer((socket) => this.server.emit("connection", socket));
		return new Promise<void>((resolve, reject) => {
			listener.once("error", reject);
			listener.listen(this.options.port, host === "" ? undefined : host, () => {
				listener.off("error", reject);
				listener.on("error", (err) => this.log("listener error", err));
				this.listeners.set(host, listener);
				resolve();
			});
		});
	}

	get port() {
		const listener = this.listeners.values().next().value;
		return listener === undefined ? this.options.port : (listener.address() as AddressInfo).port;
	}

	async stop() {
		this.stopped = true;
		clearInterval(this.pingTimer);
		this.endSession(false);
		for (const socket of this.sockets.keys()) socket.terminate();
		this.wss.close();
		await this.hostsChange;
		const listeners = [...this.listeners.values()];
		this.listeners.clear();
		await Promise.all(listeners.map((listener) => new Promise<void>((resolve) => listener.close(() => resolve()))));
	}

	// #region Sockets
	private onConnection(socket: WebSocket) {
		this.sockets.set(socket, { alive: Date.now() });
		this.log("phone connected", this.sockets.size);
		socket.on("pong", () => {
			const state = this.sockets.get(socket);
			if (state) state.alive = Date.now();
		});
		socket.on("message", (data, isBinary) => {
			if (isBinary) return;
			let message: Json;
			try {
				message = JSON.parse(data.toString());
			} catch {
				return this.log("invalid message", data.toString());
			}
			this.serial(() => this.onMessage(socket, message), `command ${message?.command}`);
		});
		socket.on("close", () => this.onClose(socket));
		socket.on("error", (err) => this.log("socket error", err));
	}

	private pingAll() {
		const now = Date.now();
		for (const [socket, state] of this.sockets) {
			if (now - state.alive > pingTimeoutMs) socket.terminate();
			else socket.ping();
		}
	}

	private onClose(socket: WebSocket) {
		this.sockets.delete(socket);
		const session = this.session;
		if (session === undefined || !session.members.delete(socket)) return;
		// Kept for a resumeSession, the phone reconnects to it after a network change or when the app comes back
		if (session.members.size === 0 && !session.suspended) {
			session.suspended = true;
			this.log("session suspended");
			this.options.toPlayer({ type: "release" });
		}
	}

	private send(socket: WebSocket, message: Json) {
		if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
	}

	private toSession(message: Json) {
		for (const socket of this.session?.members ?? []) this.send(socket, message);
	}
	// #endregion

	// #region Commands
	private async onMessage(socket: WebSocket, message: Json) {
		const { command, requestId } = message;
		this.log("<-", command, requestId ?? "");
		switch (command) {
			case "startSession":
				return this.startSession(socket);
			case "resumeSession":
				return this.resumeSession(socket, message.sessionId);
			case "endSession":
				if (!this.session?.members.has(socket) || message.sessionId !== this.session.id)
					return this.send(socket, { command: "notifySessionError", requestedCommand: "endSession", error: "Invalid SessionId" });
				return this.endSession(message.stopCasting === true);
		}
		// Everything else is only for the session's phones
		if (!this.session?.members.has(socket)) return this.log("dropped", command, "(not in the session)");
		const result = await this.onSessionCommand(message);
		if (typeof requestId === "number") this.send(socket, { command: "notifyRequestResult", requestId, resultCode: result });
	}

	// Answers 0 when done, 1002 when there is no queue for it
	private async onSessionCommand(message: Json): Promise<number> {
		const toPlayer = this.options.toPlayer;
		switch (message.command) {
			case "play":
				this.finished = false;
				if (this.media !== undefined) toPlayer({ type: "play" });
				return 0;
			case "pause":
				if (this.media !== undefined) toPlayer({ type: "pause" });
				return 0;
			case "seek":
				if (this.media !== undefined && typeof message.position === "number") {
					this.positionMs = message.position;
					toPlayer({ type: "seek", positionMs: message.position });
				}
				return 0;
			case "stop":
				this.media = undefined;
				toPlayer({ type: "stop" });
				this.setPlayerState("IDLE");
				// TIDAL reports the stopped media paused afterwards
				this.finished = true;
				return 0;
			case "setVolume":
				if (typeof message.level === "number") toPlayer({ type: "volume", level: message.level });
				return 0;
			case "setMute":
				if (typeof message.mute === "boolean") toPlayer({ type: "mute", mute: message.mute });
				return 0;
			case "loadCloudQueue":
				await this.loadCloudQueue(message);
				return 0;
			case "loadMedia":
			case "loadMediaInfo":
				if (message.mediaInfo) this.setMedia(this.mediaInfoOf(message.mediaInfo), message.autoplay !== false, message.position);
				return 0;
			case "updateServerInfo":
				this.setServers(message);
				return 0;
		}
		// Queue commands
		if (this.queueInfo === undefined || this.items.length === 0) {
			this.log("no queue for", message.command);
			return 1002;
		}
		switch (message.command) {
			case "next":
				await this.step(1, false);
				return 0;
			case "previous":
				await this.step(-1, false);
				return 0;
			case "selectQueueItem": {
				const media = message.mediaInfo ? this.mediaInfoOf(message.mediaInfo) : undefined;
				if (media === undefined) return 0;
				const index = this.items.findIndex((item) => this.itemIdOf(item) === media.itemId);
				if (index !== -1) this.index = index;
				this.setMedia(media);
				await this.loadWindow(media.itemId);
				return 0;
			}
			case "refreshQueue":
				await this.loadWindow(this.currentItemId());
				this.toSession({ command: "notifyQueueItemsChanged", queueInfo: this.queueInfo, reason: "REFRESH_REQUESTED" });
				return 0;
			case "setRepeatMode": {
				const repeatMode = repeatModeOf(message.repeatMode);
				this.queueInfo.repeatMode = repeatMode;
				await this.postQueue("repeatmode", { repeatMode });
				this.toSession({ command: "notifyQueueItemsChanged", queueInfo: this.queueInfo, reason: "REPEAT_MODE_CHANGED" });
				return 0;
			}
			case "setShuffle": {
				const shuffle = message.shuffle === true;
				this.queueInfo.shuffled = shuffle;
				await this.postQueue("shuffle", { shuffle });
				// The server reorders the queue, the window around the current item changes
				await this.loadWindow(this.currentItemId());
				this.toSession({ command: "notifyQueueItemsChanged", queueInfo: this.queueInfo, reason: "SHUFFLE_CHANGED" });
				return 0;
			}
		}
		this.log("unknown command", message.command);
		return 0;
	}
	// #endregion

	// #region Session
	private startSession(socket: WebSocket) {
		// A new session replaces the one held, its other phones are told it is over
		const old = this.session;
		if (old !== undefined) {
			for (const member of old.members) if (member !== socket) this.send(member, { command: "notifySessionEnded", sessionId: old.id, suspended: false });
			if (!old.suspended) this.options.toPlayer({ type: "release" });
			this.clearQueue();
		}
		this.session = { id: randomUUID(), members: new Set([socket]), suspended: false };
		this.log("session started", this.session.id);
		this.send(socket, { command: "notifySessionStarted", sessionId: this.session.id, joined: false });
	}

	private resumeSession(socket: WebSocket, sessionId: unknown) {
		const session = this.session;
		if (session === undefined) return this.send(socket, { command: "notifySessionError", requestedCommand: "resumeSession", error: "No Session" });
		if (session.id !== sessionId)
			return this.send(socket, { command: "notifySessionError", requestedCommand: "resumeSession", error: "Invalid SessionId" });
		session.members.add(socket);
		this.send(socket, { command: "notifySessionResumed", sessionId: session.id });
		if (session.suspended) {
			session.suspended = false;
			if (this.media !== undefined) this.options.toPlayer({ type: "attach" });
		}
		// Bring the phone up to date
		if (this.queueInfo !== undefined) this.send(socket, { command: "notifyQueueChanged", queueInfo: this.queueInfo });
		if (this.media !== undefined) this.send(socket, this.mediaChanged(this.media));
		this.send(socket, this.playerStatus());
	}

	private endSession(stopCasting: boolean) {
		const session = this.session;
		if (session === undefined) return;
		this.toSession({ command: "notifySessionEnded", sessionId: session.id, suspended: false });
		this.session = undefined;
		this.log("session ended, stopCasting:", stopCasting);
		if (stopCasting && this.media !== undefined) this.options.toPlayer({ type: "stop" });
		if (!session.suspended) this.options.toPlayer({ type: "release" });
		this.clearQueue();
	}

	private clearQueue() {
		this.contentServer = this.queueServer = this.queueInfo = this.index = this.media = undefined;
		this.items = [];
		this.playerState = "IDLE";
		this.positionMs = 0;
	}
	// #endregion

	// #region Queue
	private setServers(message: Json) {
		if (message.contentServerInfo) this.contentServer = message.contentServerInfo;
		if (message.queueServerInfo) this.queueServer = message.queueServerInfo;
	}

	private async loadCloudQueue(message: Json) {
		this.setServers(message);
		const queueInfo = message.queueInfo;
		if (queueInfo) {
			this.queueInfo = {
				queueId: String(queueInfo.queueId ?? ""),
				repeatMode: repeatModeOf(queueInfo.repeatMode),
				shuffled: queueInfo.shuffled === true,
				maxBeforeSize: Number(queueInfo.maxBeforeSize ?? 10),
				maxAfterSize: Number(queueInfo.maxAfterSize ?? 10),
			};
		}
		const current = message.currentMediaInfo ? this.mediaInfoOf(message.currentMediaInfo) : undefined;
		// Start loading the media at once, the queue window only matters for what comes after it.
		// A phone that was paused sends autoplay false, and where it was in the track
		if (current !== undefined) this.setMedia(current, message.autoplay !== false, message.position);
		await this.loadWindow(current?.itemId, current?.mediaId);
		if (this.queueInfo !== undefined) this.toSession({ command: "notifyQueueChanged", queueInfo: this.queueInfo });
	}

	// The part of the cloud queue around an item
	private async loadWindow(itemId?: string, mediaId?: string) {
		if (this.queueInfo === undefined || this.queueServer === undefined) return;
		const { queueId, maxBeforeSize, maxAfterSize } = this.queueInfo;
		let url = `${this.queueServer.serverUrl}/${queueId}/window?beforesize=${maxBeforeSize}&aftersize=${maxAfterSize}&onlyactives=true`;
		if (itemId !== undefined) url += `&itemid=${encodeURIComponent(itemId)}`;
		let window: Json;
		try {
			window = await this.queueRequest("GET", url);
		} catch (err) {
			this.log("queue window failed", err);
			this.toSession({ command: "notifyQueueServerError", errorCode: (err as { status?: number }).status ?? 0, details: { description: String(err) } });
			return;
		}
		const items = window.items ?? window.mediaInfos;
		if (Array.isArray(items) && items.length !== 0) this.items = items;
		const currentId = window.itemId ?? itemId ?? this.media?.itemId;
		let index = this.items.findIndex((item) => this.itemIdOf(item) === currentId);
		const currentMediaId = mediaId ?? this.media?.mediaId;
		if (index === -1 && currentMediaId !== undefined) index = this.items.findIndex((item) => this.mediaIdOf(item) === currentMediaId);
		if (index !== -1) this.index = index;
		if (typeof window.repeatMode === "string") this.queueInfo.repeatMode = repeatModeOf(window.repeatMode);
		if (typeof window.shuffle === "boolean") this.queueInfo.shuffled = window.shuffle;
		this.log("queue window", this.items.length, "items, current", this.index);
	}

	// Moves through the queue: by the phone's or desktop's next/previous (repeat one is skipped) or when a track ended
	private async step(by: 1 | -1, ended: boolean) {
		if (this.index === undefined || this.queueInfo === undefined) return;
		const { repeatMode } = this.queueInfo;
		if (ended && repeatMode === "ONE") return this.playItem(this.index);
		let next = this.index + by;
		if (next < 0) next = repeatMode === "ALL" ? this.items.length - 1 : 0;
		if (next >= this.items.length) {
			if (repeatMode !== "ALL") {
				// The end of the queue
				if (ended) {
					this.setPlayerState("IDLE");
					this.finished = true;
				}
				return;
			}
			next = 0;
		}
		this.playItem(next);
		// Keep the window centred, the next items must be known before the track ends
		if (next >= this.items.length - 2 || next <= 1) await this.loadWindow(this.itemIdOf(this.items[next]));
	}

	private playItem(index: number) {
		const item = this.items[index];
		if (item === undefined) return;
		this.index = index;
		this.setMedia(this.mediaInfoOf(item));
	}

	private currentItemId() {
		return this.index !== undefined ? this.itemIdOf(this.items[this.index]) : this.media?.itemId;
	}

	// Queue items use snake case, media infos camel case
	private itemIdOf(item: Json | undefined): string | undefined {
		const id = item?.itemId ?? item?.item_id ?? item?.id;
		return id === undefined ? undefined : String(id);
	}
	private mediaIdOf(item: Json | undefined): string | undefined {
		const id = item?.mediaId ?? item?.media_id;
		return id === undefined ? undefined : String(id);
	}
	private mediaInfoOf(item: Json): MediaInfo {
		const display = item.display_info ?? item.displayInfo;
		// The queue server's items carry their length as display_info.duration_ms, the phone's media infos as metadata.duration
		const duration = display?.duration ?? display?.duration_ms ?? item.duration_ms;
		let metadata =
			item.metadata ??
			(display && {
				title: display.title,
				albumTitle: display.album_title ?? display.albumTitle,
				artists: display.artists,
				duration,
				images: display.images,
			});
		if (metadata !== undefined && metadata.duration === undefined && typeof duration === "number") metadata = { ...metadata, duration };
		const video = item.video === true || item.mediaType === 1;
		return {
			itemId: this.itemIdOf(item) ?? "",
			mediaId: this.mediaIdOf(item) ?? "",
			mediaType: video ? 1 : 0,
			metadata,
			policy: item.policy,
			streamType: item.streamType,
		};
	}
	// #endregion

	// #region Queue server
	private authHeader(server: ServerInfo) {
		const auth = server.authInfo;
		if (auth?.headerAuth) return auth.headerAuth;
		const params = auth?.oauthParameters ?? auth?.oauthServerInfo?.authInfo.oauthParameters;
		return params ? `Bearer ${params.accessToken}` : undefined;
	}

	private async queueRequest(method: "GET" | "POST", url: string, body?: Json, retried = false): Promise<Json> {
		const server = this.queueServer;
		if (server === undefined) throw new Error("No queue server");
		if (!this.isTrustedUrl(url)) throw new Error(`Untrusted queue server ${url}`);
		const headers: Record<string, string> = {};
		const auth = this.authHeader(server);
		if (auth) headers.Authorization = auth;
		if (body !== undefined) headers["Content-Type"] = "application/json";
		const res = await fetch(url, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(httpTimeoutMs),
		});
		if (res.status === 401 && !retried && (await this.refreshToken())) return this.queueRequest(method, url, body, true);
		if (!res.ok) throw Object.assign(new Error(`Queue server HTTP ${res.status}`), { status: res.status });
		const text = await res.text();
		return text ? JSON.parse(text) : {};
	}

	private async postQueue(path: string, body: Json) {
		if (this.queueServer === undefined) return;
		try {
			await this.queueRequest("POST", `${this.queueServer.serverUrl}/${path}`, body);
		} catch (err) {
			this.log(`queue ${path} failed`, err);
		}
	}

	// The phone's access token expires, the refresh token in the queue server info gets a new one
	private async refreshToken() {
		const auth = this.queueServer?.authInfo;
		const oauth = auth?.oauthServerInfo;
		const params = auth?.oauthParameters ?? oauth?.authInfo.oauthParameters;
		if (oauth === undefined || params === undefined || !this.isTrustedUrl(oauth.serverUrl)) return false;
		const form = new URLSearchParams({ refresh_token: params.refreshToken });
		if (oauth.formParameters) {
			form.set("grant_type", oauth.formParameters.grant_type);
			form.set("scope", oauth.formParameters.scope);
		}
		try {
			const res = await fetch(oauth.serverUrl, {
				method: "POST",
				headers: { ...(oauth.authInfo.headerAuth ? { Authorization: oauth.authInfo.headerAuth } : {}) },
				body: form,
				signal: AbortSignal.timeout(httpTimeoutMs),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const json = await res.json();
			if (typeof json.access_token !== "string") throw new Error("No access_token");
			params.accessToken = json.access_token;
			if (typeof json.refresh_token === "string") params.refreshToken = json.refresh_token;
			// headerAuth would still carry the old token
			if (auth?.headerAuth) delete auth.headerAuth;
			this.log("token refreshed");
			return true;
		} catch (err) {
			this.log("token refresh failed", err);
			return false;
		}
	}
	// #endregion

	// #region Player
	private setMedia(media: MediaInfo, autoplay = true, position?: unknown) {
		const positionMs = typeof position === "number" && Number.isFinite(position) && position > 0 ? position : 0;
		this.media = media;
		this.positionMs = positionMs;
		this.finished = false;
		this.log("media", media.mediaId, media.itemId);
		this.toSession(this.mediaChanged(media));
		this.setPlayerState("BUFFERING");
		this.options.toPlayer({ type: "load", mediaId: media.mediaId, mediaType: media.mediaType, autoplay });
		if (positionMs !== 0) this.options.toPlayer({ type: "seek", positionMs });
	}

	// TIDAL's phone app parses every field with a fixed type: no nulls
	private mediaChanged(media: MediaInfo) {
		return {
			command: "notifyMediaChanged",
			mediaInfo: {
				itemId: media.itemId,
				mediaId: media.mediaId,
				mediaType: media.mediaType,
				// An empty string fails the phone's check of the whole message (it then shows no duration and its seek bar sends 0),
				// no source and no stream type are left out
				...(media.streamType ? { streamType: media.streamType } : {}),
				customData: "{}",
				metadata: media.metadata ?? { title: "Unknown" },
				policy: media.policy ?? { canNext: true, canPrevious: true },
			},
		};
	}

	private playerStatus() {
		return { command: "notifyPlayerStatusChanged", playerState: this.playerState, progress: Math.round(this.positionMs) };
	}

	private setPlayerState(state: PlayerState) {
		if (state === this.playerState) return;
		this.playerState = state;
		this.lastProgressSent = Date.now();
		this.toSession(this.playerStatus());
	}

	// What the player did
	onPlayerEvent(event: PlayerEvent) {
		return this.serial(() => this.handlePlayerEvent(event), `player ${event.type}`);
	}
	private async handlePlayerEvent(event: PlayerEvent) {
		if (this.session === undefined || this.session.suspended) return;
		switch (event.type) {
			case "state":
				if (!this.finished) this.setPlayerState(event.state);
				return;
			case "progress": {
				if (!Number.isFinite(event.positionMs) || this.finished) return;
				this.positionMs = event.positionMs;
				const now = Date.now();
				if (now - this.lastProgressSent < progressIntervalMs) return;
				this.lastProgressSent = now;
				return this.toSession(this.playerStatus());
			}
			case "ended":
				if (this.index === undefined) {
					this.setPlayerState("IDLE");
					this.finished = true;
					return;
				}
				return this.step(1, true);
			case "error":
				this.toSession({ command: "notifyPlaybackError", statusCode: event.message ?? "error" });
				return this.setPlayerState("IDLE");
			case "next":
				return this.step(1, false);
			case "previous":
				return this.step(-1, false);
		}
	}
	// #endregion
}
