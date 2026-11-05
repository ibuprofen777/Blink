/**
 * Gamepad support for the Blink video player.
 *
 * Polls the Gamepad API and translates inputs to the same playback actions
 * the keyboard handler uses (via the playback store). Runs as a single
 * rAF loop mounted alongside the player; no-ops when no gamepad connects.
 *
 * Layout (Xbox-style, with PlayStation names in parens):
 *   A (Cross)          play/pause
 *   B (Circle)         exit player
 *   X (Square)         toggle danmaku
 *   Y (Triangle)       cycle subtitle track (menu button on controls)
 *   LB/RB              previous / next episode
 *   LT/RT              seek -30s / +30s (analog edge; repeat while held)
 *   D-pad Left/Right   seek -10s / +10s
 *   D-pad Up/Down      volume +10% / -10%
 *   Back (Share)       stats for nerds
 *   Start (Options)    settings menu
 *   Left stick         seek scrub (direction + magnitude), deadzone 0.5
 */

import { usePlaybackStore } from "@/utils/store/playback";
import {
	loadDanmakuSettings,
	saveDanmakuSettings,
} from "@/utils/danmaku";

interface GamepadMapping {
	pause: number; // A / Cross
	exit: number; // B / Circle
	danmaku: number; // X / Square
	subtitles: number; // Y / Triangle
	lb: number;
	rb: number;
	back: number; // Back / Share
	start: number; // Start / Options
}

/** Standard mapping (W3C "standard" gamepad) covers Xbox + most PS pads. */
const STANDARD: GamepadMapping = {
	pause: 0,
	exit: 1,
	danmaku: 2,
	subtitles: 3,
	lb: 4,
	rb: 5,
	back: 8,
	start: 9,
};

const AXIS_DEADZONE = 0.5;
const STICK_SEEK_INTERVAL_MS = 250;
const TRIGGER_SEEK_SECONDS = 30;
const TRIGGER_REPEAT_MS = 350;

export class GamepadController {
	private rafId = 0;
	private disposed = false;
	private previousButtons: boolean[] = [];
	/** Buttons held across frames for repeat behavior (seek triggers). */
	private heldSince: Record<string, number> = {};
	private lastStickSeek = 0;

	start(): void {
		if (this.disposed || this.rafId) return;
		const loop = () => {
			if (this.disposed) return;
			this.poll();
			this.rafId = requestAnimationFrame(loop);
		};
		this.rafId = requestAnimationFrame(loop);
	}

	dispose(): void {
		this.disposed = true;
		if (this.rafId) {
			cancelAnimationFrame(this.rafId);
			this.rafId = 0;
		}
	}

	private poll(): void {
		const gamepads = navigator.getGamepads?.() ?? [];
		// Prefer the first connected standard-mapped pad.
		const pad = Array.from(gamepads).find(
			(candidate): candidate is Gamepad =>
				Boolean(candidate) && (candidate as Gamepad).mapping === "standard",
		);
		if (!pad) {
			this.previousButtons = [];
			return;
		}

		const pressed = pad.buttons.map((button) => button.pressed);
		const justPressed = (index: number): boolean =>
			Boolean(pressed[index]) && !this.previousButtons[index];

		const store = usePlaybackStore.getState();
		const player = document.querySelector("video");
		const currentTime = player?.currentTime ?? 0;
		const seekTo = (time: number) => {
			if (player) player.currentTime = Math.max(0, time);
		};

		// A: play/pause
		if (justPressed(STANDARD.pause)) {
			store.toggleIsPlaying();
		}
		// B: exit player
		if (justPressed(STANDARD.exit)) {
			window.dispatchEvent(new CustomEvent("blink-gamepad-exit"));
		}
		// X: toggle danmaku
		if (justPressed(STANDARD.danmaku)) {
			const next = !loadDanmakuSettings().enabled;
			saveDanmakuSettings({ ...loadDanmakuSettings(), enabled: next });
			window.dispatchEvent(new CustomEvent("blink-danmaku-settings"));
		}
		// Y: open settings menu (subtitle switching lives there)
		if (justPressed(STANDARD.subtitles)) {
			window.dispatchEvent(new CustomEvent("blink-gamepad-settings"));
		}
		// Back: stats for nerds
		if (justPressed(STANDARD.back)) {
			store.toggleShowStatsForNerds();
		}
		// Start: settings menu as well (mirrors Y)
		if (justPressed(STANDARD.start)) {
			window.dispatchEvent(new CustomEvent("blink-gamepad-settings"));
		}
		// LB/RB: previous/next episode
		if (justPressed(STANDARD.lb)) {
			window.dispatchEvent(new CustomEvent("blink-gamepad-prev"));
		}
		if (justPressed(STANDARD.rb)) {
			window.dispatchEvent(new CustomEvent("blink-gamepad-next"));
		}

		// D-pad left/right: seek ±10s
		if (justPressed(14)) seekTo(currentTime - 10);
		if (justPressed(15)) seekTo(currentTime + 10);

		// D-pad up/down: volume ±10%
		if (justPressed(12)) {
			store.increaseVolumeByStep(0.1);
		}
		if (justPressed(13)) {
			store.decreaseVolumeByStep(0.1);
		}

		// Triggers: seek ±30s with repeat-while-held
		this.handleTriggerRepeat("rt", pad.buttons[7]?.value ?? 0, () =>
			seekTo(currentTime + TRIGGER_SEEK_SECONDS),
		);
		this.handleTriggerRepeat("lt", pad.buttons[6]?.value ?? 0, () =>
			seekTo(currentTime - TRIGGER_SEEK_SECONDS),
		);

		// Left stick X: continuous scrub
		const stickX = pad.axes[0] ?? 0;
		const now = performance.now();
		if (Math.abs(stickX) > AXIS_DEADZONE && now - this.lastStickSeek > STICK_SEEK_INTERVAL_MS) {
			this.lastStickSeek = now;
			const magnitude = Math.abs(stickX);
			const seconds = magnitude > 0.85 ? 30 : 10;
			seekTo(currentTime + Math.sign(stickX) * seconds);
		}

		this.previousButtons = pressed;
	}

	private handleTriggerRepeat(
		key: string,
		value: number,
		action: () => void,
	): void {
		const active = value > 0.5;
		const now = performance.now();
		if (active && !this.heldSince[key]) {
			this.heldSince[key] = now;
			action();
		} else if (active && now - this.heldSince[key] > TRIGGER_REPEAT_MS) {
			this.heldSince[key] = now;
			action();
		} else if (!active) {
			delete this.heldSince[key];
		}
	}
}
