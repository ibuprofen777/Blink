/**
 * Gamepad support for Blink.
 *
 * Two layers, JMP-style:
 *
 * 1. UI navigation — when a menu/dialog/popover is open, the pad
 *    synthesizes keyboard events (arrows/Enter/Escape/Tab) and MUI focus
 *    navigation just works.
 * 2. Player shortcuts — when no overlay is open, buttons map to playback
 *    actions directly.
 *
 * Polls the Gamepad API in a single rAF loop; no-ops without a pad.
 *
 * Layout (Xbox-style, with PlayStation names in parens):
 *   A (Cross)          play/pause · Enter in menus
 *   B (Circle)         exit player · Escape in menus
 *   X (Square)         toggle danmaku
 *   Y (Triangle)       settings menu · Tab in menus
 *   LB/RB              previous / next episode
 *   LT/RT              seek -30s / +30s (repeat while held)
 *   D-pad / left stick arrows (menus) · seek ±10s · volume ±10% (player)
 *   Left stick         seek scrub in player, list scroll in menus
 *   Back (Share)       stats for nerds
 *   Start (Options)    settings menu
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
/** D-pad repeat interval while held, for menu scrolling. */
const UI_NAV_REPEAT_MS = 160;

/**
 * Whether a MUI overlay is open: any dialog/popover/menu currently visible.
 * MUI renders these into a portal at document.body.
 */
function uiOverlayOpen(): boolean {
	const overlays = document.querySelectorAll<HTMLElement>(
		'.MuiDialog-root, .MuiPopover-root, .MuiMenu-root, [role="dialog"]',
	);
	return Array.from(overlays).some(
		(node) =>
			node.offsetParent !== null ||
			getComputedStyle(node).display !== "none",
	);
}

/** Dispatch a synthetic KeyboardEvent the way real presses reach MUI. */
function syntheticKey(key: string, keyCode: number): void {
	const event = new KeyboardEvent("keydown", {
		key,
		keyCode,
		which: keyCode,
		bubbles: true,
		cancelable: true,
	});
	const target =
		document.activeElement instanceof HTMLElement &&
		document.activeElement.tagName !== "BODY"
			? document.activeElement
			: (document.querySelector('[role="dialog"] [tabindex]') ??
				document.querySelector('[role="dialog"]'));
	(target ?? document.body).dispatchEvent(event);
}

interface DirectionState {
	active: boolean;
	key: string;
	keyCode: number;
	/** D-pad button index this direction maps to (for justPressed). */
	buttonIndex: number;
}

export class GamepadController {
	private rafId = 0;
	private disposed = false;
	private previousButtons: boolean[] = [];
	/** Buttons held across frames for repeat behavior. */
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

		if (uiOverlayOpen()) {
			this.navigateUi(pad, justPressed);
			this.previousButtons = pressed;
			return;
		}

		this.navigatePlayer(pad, justPressed);
		this.previousButtons = pressed;
	}

	// -- Layer 1: menu/dialog navigation ---------------------------------

	private navigateUi(
		pad: Gamepad,
		justPressed: (index: number) => boolean,
	): void {
		const now = performance.now();

		const directions: DirectionState[] = [
			{ active: Boolean(pad.buttons[12]?.pressed), key: "ArrowUp", keyCode: 38, buttonIndex: 12 },
			{ active: Boolean(pad.buttons[13]?.pressed), key: "ArrowDown", keyCode: 40, buttonIndex: 13 },
			{ active: Boolean(pad.buttons[14]?.pressed), key: "ArrowLeft", keyCode: 37, buttonIndex: 14 },
			{ active: Boolean(pad.buttons[15]?.pressed), key: "ArrowRight", keyCode: 39, buttonIndex: 15 },
		];
		// Left stick mirrors the D-pad.
		const stickY = pad.axes[1] ?? 0;
		const stickX = pad.axes[0] ?? 0;
		if (stickY < -AXIS_DEADZONE) directions[0].active = true;
		if (stickY > AXIS_DEADZONE) directions[1].active = true;
		if (stickX < -AXIS_DEADZONE) directions[2].active = true;
		if (stickX > AXIS_DEADZONE) directions[3].active = true;

		for (const direction of directions) {
			const holdKey = `ui-${direction.key}`;
			if (direction.active) {
				const first = justPressed(direction.buttonIndex);
				const since = this.heldSince[holdKey];
				if (first || since === undefined || now - since > UI_NAV_REPEAT_MS) {
					this.heldSince[holdKey] = now;
					syntheticKey(direction.key, direction.keyCode);
				}
			} else {
				delete this.heldSince[holdKey];
			}
		}

		// A = Enter, B = Escape, Y = Tab.
		if (justPressed(STANDARD.pause)) syntheticKey("Enter", 13);
		if (justPressed(STANDARD.exit)) syntheticKey("Escape", 27);
		if (justPressed(STANDARD.subtitles)) syntheticKey("Tab", 9);
	}

	// -- Layer 2: player shortcuts ----------------------------------------

	private navigatePlayer(
		pad: Gamepad,
		justPressed: (index: number) => boolean,
	): void {
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
		// Y / Start: settings menu
		if (justPressed(STANDARD.subtitles) || justPressed(STANDARD.start)) {
			window.dispatchEvent(new CustomEvent("blink-gamepad-settings"));
		}
		// Back: stats for nerds
		if (justPressed(STANDARD.back)) {
			store.toggleShowStatsForNerds();
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
		if (
			Math.abs(stickX) > AXIS_DEADZONE &&
			now - this.lastStickSeek > STICK_SEEK_INTERVAL_MS
		) {
			this.lastStickSeek = now;
			const magnitude = Math.abs(stickX);
			const seconds = magnitude > 0.85 ? 30 : 10;
			seekTo(currentTime + Math.sign(stickX) * seconds);
		}
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
