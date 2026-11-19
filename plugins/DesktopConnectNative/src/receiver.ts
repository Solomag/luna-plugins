import { type LunaUnload, Tracer, unloadSet } from "@luna/core";
import { ipcRenderer, MediaItem, PlayState, redux } from "@luna/lib";

import type { PlayerCommand, PlayerState } from "./connect/ConnectReceiver";
import { playerEvent, startReceiver, stopReceiver } from "./receiver.native";

const { trace } = Tracer("[DesktopConnectNative]");

// TIDAL's desktop server key (base64 of the PEM), set at build time from the TIDAL_SERVER_KEY_PEM environment variable (esbuild.config.ts), empty without it
declare const __TIDAL_SERVER_KEY_BASE64__: string;

// Same as in receiver.native.ts
const receiverChannel = "desktopConnectNative.receiver";
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
	const started = await startReceiver(__TIDAL_SERVER_KEY_BASE64__).catch(trace.err.withContext("start receiver"));
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
	// The phone's media in TIDAL's queue, a load of the same media (repeat one) starts it again instead of reloading it
	let loaded: { mediaId: string; uid: string } | undefined;
	// TIDAL ignores a seek on a video it has not started yet (it loads it again on play and starts from the beginning),
	// and sometimes does the same for a track loaded right after a video, so the phone's seek is applied again once it plays
	let unstarted = false;
	let phoneSeek: number | undefined;
	// TIDAL ignores a pause until it really started playing, so a pause sent while it starts is applied again once it plays
	let pauseWhenPlaying = false;
	// Set while the media playing is a video (TIDAL also has other video elements, animated covers)
	let playingVideo = false;
	// While the phone controls the player
	const sessionUnloads = new Set<LunaUnload>();

	const run = async (command: PlayerCommand) => {
		switch (command.type) {
			case "load":
				return load(command.mediaId, command.mediaType, command.autoplay);
			case "play":
				return play();
			case "pause":
			case "stop":
				return pause();
			case "seek":
				return seek(command.positionMs / 1000);
			case "volume":
				return redux.actions["playbackControls/SET_VOLUME"]({ volume: Math.min(Math.max(command.level, 0) * 100, 100) });
			case "mute":
				return redux.actions["playbackControls/SET_MUTE"](command.mute);
			case "release":
				pauseWhenPlaying = false;
				return unloadSet(sessionUnloads);
			case "attach":
				return attach();
		}
	};

	const play = () => {
		if (loadFailed) return;
		paused = false;
		pauseWhenPlaying = false;
		// TIDAL's desired state, it may not be playing yet
		if (!PlayState.playing) PlayState.play();
	};
	// A starting video may start more than once (TIDAL reports PLAYING, then loads it again), so the pause holds
	// until a play (also on the desktop) or for as long as a load may take
	let pauseTimeout: number | undefined;
	const pause = () => {
		paused = true;
		pauseWhenPlaying = true;
		clearTimeout(pauseTimeout);
		pauseTimeout = window.setTimeout(() => (pauseWhenPlaying = false), loadTimeoutMs);
		PlayState.pause();
	};
	const seek = (time: number) => {
		if (loadFailed) return;
		if (unstarted) phoneSeek = time;
		PlayState.seek(time);
	};

	const load = async (mediaId: string, mediaType: number, autoplay: boolean) => {
		stopPendingSeek?.();
		// Repeat one or the phone selecting the item playing: replacing the queue with the same item may keep TIDAL's old position
		if (!loadFailed && loaded?.mediaId === mediaId && currentElement()?.uid === loaded.uid) {
			attach();
			PlayState.seek(0);
			if (autoplay) play();
			else pause();
			return;
		}
		const mediaItem = await withTimeout(MediaItem.fromId(mediaId, mediaType === 1 ? "video" : "track"), loadTimeoutMs).catch((err) => {
			trace.err.withContext("load media")(err);
			return undefined;
		});
		loadFailed = mediaItem === undefined;
		loaded = undefined;
		if (mediaItem === undefined) {
			PlayState.pause();
			playerEvent({ type: "error", message: `Media ${mediaId} not found` });
			return;
		}
		attach();
		paused = !autoplay;
		unstarted = true;
		phoneSeek = undefined;
		loading = true;
		const transition = nextAction(
			"playbackControls/MEDIA_PRODUCT_TRANSITION",
			loadTimeoutMs,
			({ mediaProduct }) => mediaProduct.referenceId !== undefined && mediaProduct.referenceId === currentElement()?.uid,
		);
		// Only the phone's item in the queue, otherwise TIDAL moves on to its own next item when the track ends (without ENDED).
		// Repeat is the receiver's (its queue), the local one stays off
		redux.actions["playQueue/CLEAR_QUEUE"]();
		redux.actions["playQueue/SET_REPEAT_MODE"](redux.RepeatMode.Off);
		redux.actions["playQueue/ADD_NEXT"]({ context: { type: "UNKNOWN" }, mediaItemIds: [mediaItem.tidalItem?.id ?? mediaItem.id] });
		// A slow switch still counts as loaded, the phone's commands after it must not wait forever
		await transition;
		loading = false;
		const uid = currentElement()?.uid;
		if (uid !== undefined) loaded = { mediaId, uid };
		if (autoplay) play();
		// Not started, tell the phone it is ready (TIDAL reported it while loading)
		else playerEvent({ type: "state", state: "PAUSED" });
	};

	// Only one seek waits, a newer one or a new load replaces it
	let stopPendingSeek: (() => void) | undefined;
	const seekWhenPlaying = (time: number) => {
		stopPendingSeek?.();
		const waitUnloads = new Set<LunaUnload>();
		if (playingVideo) {
			// TIDAL reports PLAYING before the video element starts and then starts it from the beginning, so seek once the element plays
			const onPlaying = ({ target }: Event) => {
				if (!(target instanceof HTMLVideoElement) || !playingVideo) return;
				stop();
				PlayState.seek(time);
			};
			// Media events don't bubble, capture them on the document
			document.addEventListener("playing", onPlaying, true);
			waitUnloads.add(() => document.removeEventListener("playing", onPlaying, true));
		} else {
			// A track TIDAL loads again on play starts from the beginning, seek again if its first position is not the phone's
			ipcRenderer.on(waitUnloads, "client.playback.playersignal", ({ time: position }: { time?: number }) => {
				if (typeof position !== "number") return;
				stop();
				if (Math.abs(position - time) > 2) PlayState.seek(time);
			});
		}
		const timeout = window.setTimeout(() => stop(), loadTimeoutMs);
		const stop = () => {
			clearTimeout(timeout);
			unloadSet(waitUnloads);
			sessionUnloads.delete(stop);
			if (stopPendingSeek === stop) stopPendingSeek = undefined;
		};
		stopPendingSeek = stop;
		sessionUnloads.add(stop);
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
			if (state === "PLAYING" && pauseWhenPlaying && !loading) {
				// TIDAL ignored the phone's pause while starting
				PlayState.pause();
				return;
			}
			if (state === "PLAYING") {
				paused = false;
				if (unstarted && !loading) {
					const time = phoneSeek;
					unstarted = false;
					phoneSeek = undefined;
					if (time !== undefined) seekWhenPlaying(time);
				}
			}
			if (loading) return;
			const playerState = state === "STALLED" && paused ? "PAUSED" : states[state];
			if (playerState !== undefined) playerEvent({ type: "state", state: playerState });
		});
		// A play from anywhere (also on the desktop) is newer than the phone's pause
		redux.intercept("playbackControls/PLAY", sessionUnloads, () => {
			paused = false;
			pauseWhenPlaying = false;
		});
		redux.intercept("playbackControls/PAUSE", sessionUnloads, () => {
			paused = true;
		});
		// Not every player signal has a time
		ipcRenderer.on(sessionUnloads, "client.playback.playersignal", ({ time }: { time?: number }) => {
			// Not the start TIDAL loads it at before the phone's seek is applied
			if (typeof time === "number" && stopPendingSeek === undefined) playerEvent({ type: "progress", positionMs: time * 1000 });
		});
		// TIDAL sends no player signal for videos, their progress comes from the video element (media events don't bubble)
		redux.intercept("playbackControls/MEDIA_PRODUCT_TRANSITION", sessionUnloads, ({ mediaProduct }) => {
			playingVideo = mediaProduct.productType === "video";
		});
		const onVideoTime = ({ target }: Event) => {
			if (!(target instanceof HTMLVideoElement) || !playingVideo || unstarted || stopPendingSeek !== undefined) return;
			playerEvent({ type: "progress", positionMs: target.currentTime * 1000 });
		};
		document.addEventListener("timeupdate", onVideoTime, true);
		sessionUnloads.add(() => document.removeEventListener("timeupdate", onVideoTime, true));
		// The video element starts again after TIDAL reported PLAYING, the phone's pause must still hold
		const onVideoPlaying = ({ target }: Event) => {
			if (target instanceof HTMLVideoElement && playingVideo && pauseWhenPlaying && !loading) PlayState.pause();
		};
		document.addEventListener("playing", onVideoPlaying, true);
		sessionUnloads.add(() => document.removeEventListener("playing", onVideoPlaying, true));
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
