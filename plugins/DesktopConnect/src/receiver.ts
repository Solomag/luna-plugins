import { type LunaUnload, Tracer, unloadSet } from "@luna/core";
import { ipcRenderer, MediaItem, PlayState, redux } from "@luna/lib";

import type { PlayerCommand, PlayerState } from "./connect/ConnectReceiver";
import { playerEvent, startReceiver, stopReceiver } from "./receiver.native";

const { trace } = Tracer("[DesktopConnect.receiver]");

// Same as in receiver.native.ts
const receiverChannel = "desktopConnect.receiver";
// Loading a video can take over 5s
const loadTimeoutMs = 10000;

// Resolves undefined after the timeout
const withTimeout = <T>(promise: Promise<T>, timeoutMs: number) => {
	let timeout: number | undefined;
	const timedOut = new Promise<undefined>((resolve) => {
		timeout = window.setTimeout(resolve, timeoutMs);
	});
	return Promise.race([promise, timedOut]).finally(() => clearTimeout(timeout));
};
// Resolves with the next (matching) payload of the action, or undefined after a timeout
const nextAction = <T extends redux.ActionType>(
	actionType: T,
	timeoutMs: number,
	matches: (payload: redux.InterceptPayload<T>) => boolean = () => true,
) => {
	const waitUnloads = new Set<LunaUnload>();
	const action = new Promise<redux.InterceptPayload<T>>((resolve) => {
		redux.intercept(actionType, waitUnloads, (payload) => {
			if (matches(payload)) resolve(payload);
		});
	});
	return withTimeout(action, timeoutMs).finally(() => unloadSet(waitUnloads));
};
const currentElement = () => PlayState.playQueue.elements[PlayState.playQueue.currentIndex];

// The own TIDAL Connect receiver (receiver.native.ts) owns the phone's queue and session,
// TIDAL's player here plays what it says and reports back. Returns false when it could not start (no key)
export const startOwnReceiver = async (unloads: Set<LunaUnload>) => {
	const started = await startReceiver().catch(trace.err.withContext("start receiver"));
	if (started === undefined) return false;
	trace.log(`TIDAL Connect receiver on port ${started.port}`);
	unloads.add(() => {
		unloadSet(sessionUnloads);
		stopReceiver().catch(trace.err.withContext("stop receiver"));
	});

	// Commands come in bursts (load, seek, play) and loading is async, so run them one after another
	let commands: Promise<unknown> = Promise.resolve();
	let unloaded = false;
	unloads.add(() => (unloaded = true));
	ipcRenderer.on(unloads, receiverChannel, (command: PlayerCommand) => {
		commands = commands.then(() => (unloaded ? undefined : run(command))).catch(trace.err.withContext(`receiver ${command.type}`));
	});

	// Set while the phone's media is loaded but not started or paused: TIDAL reports STALLED then, which is paused for the phone
	let paused = false;
	// While the phone's media loads: TIDAL passes through idle and paused when the queue is replaced, the phone sees buffering
	let loading = false;
	// Set when the phone's media could not be loaded, so its seek and play do not apply to the previous track
	let loadFailed = false;
	// While the phone controls the player
	const sessionUnloads = new Set<LunaUnload>();

	const run = async (command: PlayerCommand) => {
		switch (command.type) {
			case "load":
				return load(command.mediaId, command.mediaType, command.autoplay);
			case "play":
				if (loadFailed) return;
				paused = false;
				return PlayState.play();
			case "pause":
				paused = true;
				return PlayState.pause();
			case "seek":
				if (!loadFailed) PlayState.seek(command.positionMs / 1000);
				return;
			case "stop":
				paused = true;
				return PlayState.pause();
			case "volume":
				return redux.actions["playbackControls/SET_VOLUME"]({ volume: Math.min(command.level * 100, 100) });
			case "mute":
				return redux.actions["playbackControls/SET_MUTE"](command.mute);
			case "release":
				return unloadSet(sessionUnloads);
			case "attach":
				return attach();
		}
	};

	const load = async (mediaId: string, mediaType: number, autoplay: boolean) => {
		const mediaItem = await withTimeout(MediaItem.fromId(mediaId, mediaType === 1 ? "video" : "track"), loadTimeoutMs).catch((err) => {
			trace.err.withContext("load media")(err);
			return undefined;
		});
		loadFailed = mediaItem === undefined;
		if (mediaItem === undefined) {
			PlayState.pause();
			playerEvent({ type: "error", message: `Media ${mediaId} not found` });
			return;
		}
		attach();
		paused = !autoplay;
		loading = true;
		const loaded = nextAction(
			"playbackControls/MEDIA_PRODUCT_TRANSITION",
			loadTimeoutMs,
			({ mediaProduct }) => mediaProduct.referenceId !== undefined && mediaProduct.referenceId === currentElement()?.uid,
		);
		// Only the phone's item in the queue, otherwise TIDAL moves on to its own next item when the track ends (without ENDED).
		// Repeat is the receiver's (its queue), the local one stays off
		redux.actions["playQueue/CLEAR_QUEUE"]();
		redux.actions["playQueue/SET_REPEAT_MODE"](redux.RepeatMode.Off);
		redux.actions["playQueue/ADD_NEXT"]({ context: { type: "UNKNOWN" }, mediaItemIds: [mediaItem.tidalItem?.id ?? mediaItem.id] });
		await loaded;
		loading = false;
		if (autoplay) PlayState.play();
		// Not started, tell the phone it is ready (TIDAL reported it while loading)
		else playerEvent({ type: "state", state: "PAUSED" });
	};

	// Follow the phone: report what the player does, and keep TIDAL from moving on by itself
	const attach = () => {
		if (sessionUnloads.size !== 0) return;
		const states: Partial<Record<redux.PlaybackState, PlayerState>> = {
			IDLE: "IDLE",
			NOT_PLAYING: "PAUSED",
			PLAYING: "PLAYING",
			STALLED: "BUFFERING",
		};
		redux.intercept("playbackControls/SET_PLAYBACK_STATE", sessionUnloads, (state) => {
			if (state === "PLAYING") paused = false;
			if (loading) return;
			const playerState = state === "STALLED" && paused ? "PAUSED" : states[state];
			if (playerState !== undefined) playerEvent({ type: "state", state: playerState });
		});
		redux.intercept("playbackControls/PLAY", sessionUnloads, () => {
			paused = false;
		});
		redux.intercept("playbackControls/PAUSE", sessionUnloads, () => {
			paused = true;
		});
		// Not every player signal has a time
		ipcRenderer.on(sessionUnloads, "client.playback.playersignal", ({ time }: { time?: number }) => {
			if (typeof time === "number") playerEvent({ type: "progress", positionMs: time * 1000 });
		});
		// TIDAL sends no player signal for videos, their progress comes from the video element (media events don't bubble)
		let playingVideo = false;
		redux.intercept("playbackControls/MEDIA_PRODUCT_TRANSITION", sessionUnloads, ({ mediaProduct }) => {
			playingVideo = mediaProduct.productType === "video";
		});
		const onVideoTime = ({ target }: Event) => {
			if (target instanceof HTMLVideoElement && playingVideo) playerEvent({ type: "progress", positionMs: target.currentTime * 1000 });
		};
		document.addEventListener("timeupdate", onVideoTime, true);
		sessionUnloads.add(() => document.removeEventListener("timeupdate", onVideoTime, true));
		// The receiver picks what comes next from the phone's queue
		redux.intercept("playbackControls/ENDED", sessionUnloads, ({ reason }) => {
			if (reason === "completed") playerEvent({ type: "ended" });
			return true;
		});
		redux.intercept("playbackControls/SKIP_NEXT", sessionUnloads, () => {
			playerEvent({ type: "next" });
			return true;
		});
		redux.intercept("playbackControls/SKIP_PREVIOUS", sessionUnloads, () => {
			playerEvent({ type: "previous" });
			return true;
		});
	};

	return true;
};
