/**
 * Danmaku (bullet comments) support for Blink.
 *
 * Downloads the Bilibili XML written by the Jellyfin.Plugin.Danmu plugin and
 * renders it on a dedicated canvas layered above the video. The subtitle
 * pipeline (JASSUB for ASS, libpgs for PGS, text tracks for srt/vtt) is left
 * completely untouched — the danmaku canvas is independent of it.
 *
 * The endpoint is exposed anonymously by the plugin: /api/danmu/<id>/raw
 */

const COMMENT_RE = /<d\s+([^>]*)>([\s\S]*?)<\/d>/gi;
const P_RE = /p\s*=\s*["']([^"']*)["']/i;
const NUMERIC_ENTITY_RE = /&#(x?)([0-9a-fA-F]+);/g;

export type DanmakuMode = "scroll" | "top" | "bottom";

export interface DanmakuComment {
	time: number;
	mode: DanmakuMode;
	text: string;
	color: string; // "#rrggbb"
	fontScale: number; // relative to the configured base size
}

export interface DanmakuSettings {
	enabled: boolean;
	fontSize: number;
	opacity: number; // 0.1 - 1
	area: number; // 0.3 - 1, fraction of the player height
	speed: number; // scroll speed multiplier
}

export const DEFAULT_DANMAKU_SETTINGS: DanmakuSettings = {
	enabled: true,
	fontSize: 25,
	opacity: 0.9,
	area: 0.7,
	speed: 1.0,
};

const DANMAKU_SETTINGS_KEY = "blink-danmaku-settings";

export function loadDanmakuSettings(): DanmakuSettings {
	try {
		const raw = localStorage.getItem(DANMAKU_SETTINGS_KEY);
		if (!raw) return { ...DEFAULT_DANMAKU_SETTINGS };
		return { ...DEFAULT_DANMAKU_SETTINGS, ...JSON.parse(raw) };
	} catch {
		return { ...DEFAULT_DANMAKU_SETTINGS };
	}
}

export function saveDanmakuSettings(settings: DanmakuSettings): void {
	localStorage.setItem(DANMAKU_SETTINGS_KEY, JSON.stringify(settings));
}

export async function fetchDanmakuXml(
	baseUrl: string,
	itemId: string,
	apiKey?: string,
): Promise<string | null> {
	if (!baseUrl || !itemId) return null;
	const base = baseUrl.replace(/\/+$/, "");
	const separator = base.includes("?") ? "&" : "?";
	const url = `${base}/api/danmu/${encodeURIComponent(itemId)}/raw${apiKey ? `${separator}api_key=${apiKey}` : ""}`;
	try {
		const response = await fetch(url);
		if (!response.ok) return null;
		const text = await response.text();
		return text.trim() ? text : null;
	} catch {
		return null;
	}
}

function decodeNumericEntities(input: string): string {
	return input.replace(NUMERIC_ENTITY_RE, (_match, hexMarker, digits) => {
		const code = parseInt(digits, hexMarker ? 16 : 10);
		return Number.isFinite(code) ? String.fromCodePoint(code) : _match;
	});
}

function decodeText(raw: string): string {
	return decodeNumericEntities(raw)
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&")
		.trim();
}

/** Parse the plugin's Bilibili XML. Advanced comments (mode 7/8) are skipped. */
export function parseDanmakuXml(xml: string): DanmakuComment[] {
	const comments: DanmakuComment[] = [];
	COMMENT_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = COMMENT_RE.exec(xml)) !== null) {
		const p = P_RE.exec(match[1] ?? "");
		if (!p) continue;
		const parts = p[1].split(",");
		if (parts.length < 4) continue;
		const seconds = Number.parseFloat(parts[0]);
		const modeNumber = Number.parseInt(parts[1], 10);
		const size = Number.parseFloat(parts[2]);
		const colorNumber = Number.parseInt(parts[3], 10);
		if (!Number.isFinite(seconds) || !Number.isFinite(modeNumber)) continue;

		const mode: DanmakuMode | null =
			modeNumber === 1 || modeNumber === 6
				? "scroll"
				: modeNumber === 4
					? "bottom"
					: modeNumber === 5
						? "top"
						: null;
		if (!mode) continue;

		const text = decodeText(match[2] ?? "");
		if (!text) continue;

		comments.push({
			time: Math.max(0, seconds),
			mode,
			text,
			color: `#${(colorNumber & 0xffffff).toString(16).padStart(6, "0")}`,
			fontScale: Number.isFinite(size)
				? Math.min(Math.max(size / 25, 0.5), 2)
				: 1,
		});
	}
	comments.sort((a, b) => a.time - b.time);
	return comments;
}

const LANE_SPACING = 1.4;
const FIXED_DURATION = 4.0;
const SCROLL_DURATION = 8.0;
const LANE_GAP = 8;
const MAX_SPAWN_PER_TICK = 24;

interface ActiveComment {
	comment: DanmakuComment;
	lane: number;
	spawnSeconds: number;
	x: number;
	y: number;
	measured: TextMetrics;
}

/**
 * Canvas-based danmaku renderer bound to a <video> element.
 *
 * Owns its own canvas (inserted after the video in the DOM) and a
 * requestAnimationFrame loop that follows video.currentTime, so pause/seek
 * and playback rate are handled for free.
 */
export class DanmakuRenderer {
	private video: HTMLVideoElement;
	private canvas: HTMLCanvasElement;
	private ctx: CanvasRenderingContext2D;
	private comments: DanmakuComment[] = [];
	private cursor = 0;
	private active: ActiveComment[] = [];
	private settings: DanmakuSettings;
	private rafId = 0;
	private lastVideoTime = -1;
	private scrollLanes: { at: number; width: number; pxPerSec: number }[] = [];
	private topLaneFreeAt: number[] = [];
	private bottomLaneFreeAt: number[] = [];
	private resizeObserver: ResizeObserver;
	private disposed = false;
	/** Live output size of the video element in CSS pixels. */
	private width = 0;
	private height = 0;

	constructor(video: HTMLVideoElement, settings?: Partial<DanmakuSettings>) {
		this.video = video;
		this.settings = { ...DEFAULT_DANMAKU_SETTINGS, ...settings };

		this.canvas = document.createElement("canvas");
		this.canvas.className = "danmaku-canvas";
		Object.assign(this.canvas.style, {
			position: "fixed",
			pointerEvents: "none",
			zIndex: "1",
		} satisfies Partial<CSSStyleDeclaration>);

		const parent = video.parentElement;
		if (!parent) throw new Error("danmaku: video element has no parent");
		// After the video so it stacks above it, before the controls so it
		// stays below the overlay chrome.
		parent.insertBefore(this.canvas, video.nextSibling);

		const ctx = this.canvas.getContext("2d");
		if (!ctx) throw new Error("danmaku: 2d context unavailable");
		this.ctx = ctx;

		this.resizeObserver = new ResizeObserver(() => this.syncSize());
		this.resizeObserver.observe(video);
		this.syncSize();
		this.start();
	}

	setComments(comments: DanmakuComment[]): void {
		this.comments = comments;
		this.reset();
	}

	setSettings(settings: Partial<DanmakuSettings>): void {
		this.settings = { ...this.settings, ...settings };
		this.reset();
	}

	/** Remove comments that are no longer on screen and rewind the cursor. */
	private reset(): void {
		this.active = [];
		this.scrollLanes = [];
		this.topLaneFreeAt = [];
		this.bottomLaneFreeAt = [];
		this.cursor = this.cursorAfter(this.currentVideoTime());
	}

	private currentVideoTime(): number {
		return Number.isFinite(this.video.currentTime) ? this.video.currentTime : 0;
	}

	private cursorAfter(seconds: number): number {
		let low = 0;
		let high = this.comments.length;
		while (low < high) {
			const mid = (low + high) >> 1;
			if (this.comments[mid].time < seconds) low = mid + 1;
			else high = mid;
		}
		return low;
	}

	private syncSize(): void {
		if (this.disposed) return;
		const rect = this.video.getBoundingClientRect();
		this.width = rect.width;
		this.height = rect.height;
		Object.assign(this.canvas.style, {
			left: `${rect.left}px`,
			top: `${rect.top}px`,
			width: `${rect.width}px`,
			height: `${rect.height}px`,
		} satisfies Partial<CSSStyleDeclaration>);
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
		this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
		this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	}

	private start(): void {
		if (this.disposed || this.rafId) return;
		const loop = () => {
			if (this.disposed) return;
			this.frame();
			this.rafId = requestAnimationFrame(loop);
		};
		this.rafId = requestAnimationFrame(loop);
	}

	private frame(): void {
		const videoTime = this.currentVideoTime();
		const jumped = Math.abs(videoTime - this.lastVideoTime) > 1.0;
		if (jumped) this.reset();
		this.lastVideoTime = videoTime;

		this.ctx.clearRect(0, 0, this.width, this.height);
		if (!this.settings.enabled || this.comments.length === 0) return;

		if (this.video.paused) return;

		const areaHeight = this.height * Math.min(1, Math.max(0.1, this.settings.area));
		const fontSize = this.settings.fontSize;
		const laneHeight = fontSize * LANE_SPACING;
		const laneCount = Math.max(1, Math.floor(areaHeight / laneHeight));
		const topPadding = fontSize * 0.4;

		// Spawn comments whose time has arrived.
		let spawned = 0;
		while (
			this.cursor < this.comments.length &&
			this.comments[this.cursor].time <= videoTime
		) {
			if (spawned < MAX_SPAWN_PER_TICK) {
				this.spawn(this.comments[this.cursor], videoTime, laneCount, laneHeight, topPadding);
				spawned += 1;
			}
			this.cursor += 1;
		}

		// Expire finished comments.
		this.active = this.active.filter((entry) => {
			const lifetime =
				entry.comment.mode === "scroll"
					? SCROLL_DURATION / Math.max(0.1, this.settings.speed) + 0.5
					: FIXED_DURATION + 0.5;
			return videoTime - entry.spawnSeconds <= lifetime;
		});

		// Draw.
		this.ctx.textBaseline = "top";
		for (const entry of this.active) {
			this.drawEntry(entry, videoTime);
		}
	}

	private drawEntry(entry: ActiveComment, videoTime: number): void {
		const fontSize = this.settings.fontSize * entry.comment.fontScale;
		const elapsed = videoTime - entry.spawnSeconds;
		this.ctx.font = `500 ${fontSize}px "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif`;
		this.ctx.globalAlpha = this.settings.opacity;

		if (entry.comment.mode === "scroll") {
			const duration = SCROLL_DURATION / Math.max(0.1, this.settings.speed);
			const progress = elapsed / duration;
			const x = this.width - progress * (this.width + entry.measured.width);
			this.ctx.fillStyle = entry.comment.color;
			this.ctx.shadowColor = "rgba(0,0,0,0.8)";
			this.ctx.shadowBlur = 2;
			this.ctx.fillText(entry.comment.text, x, entry.y);
			this.ctx.shadowBlur = 0;
		} else {
			this.ctx.fillStyle = entry.comment.color;
			this.ctx.shadowColor = "rgba(0,0,0,0.8)";
			this.ctx.shadowBlur = 2;
			this.ctx.fillText(entry.comment.text, entry.x, entry.y);
			this.ctx.shadowBlur = 0;
		}
		this.ctx.globalAlpha = 1;
	}

	private spawn(
		comment: DanmakuComment,
		videoTime: number,
		laneCount: number,
		laneHeight: number,
		topPadding: number,
	): void {
		const fontSize = this.settings.fontSize * comment.fontScale;
		this.ctx.font = `500 ${fontSize}px "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif`;
		const measured = this.ctx.measureText(comment.text);

		let lane: number | null = null;
		if (comment.mode === "scroll") {
			const pxPerSec = (this.width + measured.width) / (SCROLL_DURATION / Math.max(0.1, this.settings.speed));
			for (let i = 0; i < laneCount; i += 1) {
				const previous = this.scrollLanes[i];
				if (!previous) {
					lane = i;
					break;
				}
				const elapsed = videoTime - previous.at;
				if (elapsed >= 0 && previous.pxPerSec * elapsed > previous.width + LANE_GAP) {
					lane = i;
					break;
				}
			}
			if (lane === null) return;
			this.scrollLanes[lane] = { at: videoTime, width: measured.width, pxPerSec };
		} else {
			const free = comment.mode === "top" ? this.topLaneFreeAt : this.bottomLaneFreeAt;
			for (let i = 0; i < laneCount; i += 1) {
				if (videoTime >= (free[i] ?? 0)) {
					lane = i;
					break;
				}
			}
			if (lane === null) return;
			free[lane] = videoTime + FIXED_DURATION + 0.5;
		}

		const y =
			comment.mode === "bottom"
				? this.height - topPadding - (lane + 1) * laneHeight
				: topPadding + lane * laneHeight;

		this.active.push({
			comment,
			lane,
			spawnSeconds: videoTime,
			x:
				comment.mode === "scroll"
					? this.width
					: (this.width - measured.width) / 2,
			y,
			measured,
		});
	}

	dispose(): void {
		this.disposed = true;
		if (this.rafId) {
			cancelAnimationFrame(this.rafId);
			this.rafId = 0;
		}
		this.resizeObserver.disconnect();
		this.canvas.remove();
	}
}
