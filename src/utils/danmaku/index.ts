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
	/** Max comments allowed on screen at once. 0 = unlimited. */
	maxOnScreen: number;
	/** Draw a visible outline behind glyphs for legibility on bright scenes. */
	outline: boolean;
	/** Merge consecutive identical comments (e.g. "hhh x 3") into one. */
	mergeDuplicates: boolean;
	/** Hide comments matching these keywords (semicolon-separated). */
	blockWords: string;
}

export const DEFAULT_DANMAKU_SETTINGS: DanmakuSettings = {
	enabled: true,
	fontSize: 25,
	opacity: 0.9,
	area: 0.7,
	speed: 1.0,
	maxOnScreen: 0,
	outline: true,
	mergeDuplicates: false,
	blockWords: "",
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

// ---------------------------------------------------------------------------
// danmu_api (弹弹play-compatible online source)
//
// Flow: POST /api/v2/match with the item title → GET /api/v2/bangumi/{animeId}
// for the episode list → GET /api/v2/comment/{episodeId}?format=xml.
// Matches are cached by "title|season" so subsequent plays are instant.
// ---------------------------------------------------------------------------

const DANMU_API_BASE_DEFAULT = "http://192.168.1.11:9321";
const MATCH_CACHE_KEY = "blink-danmaku-match-cache";
const MATCH_CACHE_MAX = 64;

interface DanmuApiEpisode {
	episodeId: number;
	episodeTitle: string;
}

export interface DanmuApiMatch {
	animeId: number;
	animeTitle: string;
}

export interface DanmakuQuery {
	/** Jellyfin item title, e.g. "风骚律师" */
	title: string;
	/** Season number, 0 for movies / specials */
	season: number;
	/** Episode number, undefined for movies */
	episode?: number;
}

function danmuApiBase(): string {
	try {
		return (
			localStorage.getItem("blink-danmaku-api-base") ||
			DANMU_API_BASE_DEFAULT
		);
	} catch {
		return DANMU_API_BASE_DEFAULT;
	}
}

export function setDanmuApiBase(base: string): void {
	localStorage.setItem("blink-danmaku-api-base", base.replace(/\/+$/, ""));
}

interface MatchCacheEntry {
	animeId: number;
	animeTitle: string;
}

function loadMatchCache(): Record<string, MatchCacheEntry> {
	try {
		return JSON.parse(localStorage.getItem(MATCH_CACHE_KEY) || "{}");
	} catch {
		return {};
	}
}

function saveMatchCache(cache: Record<string, MatchCacheEntry>): void {
	const entries = Object.entries(cache);
	if (entries.length <= MATCH_CACHE_MAX) {
		localStorage.setItem(MATCH_CACHE_KEY, JSON.stringify(cache));
		return;
	}
	// Drop the oldest half; the cache has no timestamps, and re-matching is
	// cheap, so a rough trim is fine.
	const trimmed = Object.fromEntries(entries.slice(-MATCH_CACHE_MAX / 2));
	localStorage.setItem(MATCH_CACHE_KEY, JSON.stringify(trimmed));
}

export function matchCacheKey(query: DanmakuQuery): string {
	return `${query.title}|${query.season}`;
}

/** Resolve a title+season to a danmu_api anime. Cached across sessions. */
export async function resolveAnime(
	query: DanmakuQuery,
): Promise<MatchCacheEntry | null> {
	const cache = loadMatchCache();
	const key = matchCacheKey(query);
	const hit = cache[key];
	if (hit) return hit;

	const base = danmuApiBase();
	const matchResponse = await fetch(`${base}/api/v2/match`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			fileName:
				query.season > 0 ? `${query.title} S${pad(query.season)}` : query.title,
		}),
	});
	if (!matchResponse.ok) return null;
	const matchData = await matchResponse.json();
	const matches: DanmuApiMatch[] = matchData.matches ?? [];
	if (matches.length === 0) return null;

	// Prefer a title that actually contains the season name; the match
	// endpoint answers for the closest title, but the season list endpoint
	// is authoritative for episode counts.
	let chosen = matches[0];
	for (const candidate of matches) {
		if (
			`${candidate.animeTitle}`.includes(
				`第${chineseSeason(query.season)}季`,
			)
		) {
			chosen = candidate;
			break;
		}
	}

	cache[key] = { animeId: chosen.animeId, animeTitle: chosen.animeTitle };
	saveMatchCache(cache);
	return cache[key];
}

function pad(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

function chineseSeason(n: number): string {
	const digits = "零一二三四五六七八九";
	if (n <= 9) return digits[n] ?? String(n);
	if (n === 10) return "十";
	if (n < 20) return `十${digits[n - 10]}`;
	return String(n);
}

/** All episodes of the resolved anime, ordered as the source lists them. */
export async function fetchEpisodeList(
	animeId: number,
): Promise<DanmuApiEpisode[]> {
	const base = danmuApiBase();
	const response = await fetch(`${base}/api/v2/bangumi/${animeId}`);
	if (!response.ok) return [];
	const data = await response.json();
	const bangumi = data.bangumi ?? data;
	return (bangumi.episodes ?? []) as DanmuApiEpisode[];
}

function extractEpisodeNumber(title: string): number | null {
	const patterns = [
		/第\s*(\d+)\s*集/,
		/第\s*(\d+)\s*话/,
		/\bEP?\.?\s*(\d+)\b/i,
		/^\s*(\d{1,4})\s*$/,
	];
	for (const pattern of patterns) {
		const match = pattern.exec(title);
		if (match) return Number.parseInt(match[1], 10);
	}
	return null;
}

/**
 * Full online fetch: match → episode list → comment XML.
 * Returns null when anything in the chain fails; callers fall back silently.
 */
export async function fetchDanmakuOnline(
	query: DanmakuQuery,
): Promise<string | null> {
	try {
		const anime = await resolveAnime(query);
		if (!anime) return null;

		let episodes = await fetchEpisodeList(anime.animeId);
		if (episodes.length === 0) return null;

		// Movies (no episode number): use the only episode.
		if (query.episode == null) {
			if (episodes.length !== 1) return null;
			return fetchCommentXml(episodes[0].episodeId);
		}

		// Episodes: match by parsed number first, then by position when every
		// title is numbered sequentially (e.g. bilibili's bare "1", "2", ...).
		let target = episodes.find(
			(episode) => extractEpisodeNumber(episode.episodeTitle) === query.episode,
		);
		if (!target) {
			const positional = episodes.map((episode) =>
				extractEpisodeNumber(episode.episodeTitle),
			);
			const startsAtOne = positional.every(
				(value, index) => value === index + 1,
			);
			if (
				startsAtOne &&
				query.episode >= 1 &&
				query.episode <= episodes.length
			) {
				target = episodes[query.episode - 1];
			}
		}
		if (!target) return null;

		return await fetchCommentXml(target.episodeId);
	} catch {
		return null;
	}
}

async function fetchCommentXml(episodeId: number): Promise<string | null> {
	const base = danmuApiBase();
	const response = await fetch(
		`${base}/api/v2/comment/${episodeId}?format=xml`,
	);
	if (!response.ok) return null;
	const text = await response.text();
	return text.trim() ? text : null;
}

// ---------------------------------------------------------------------------
// Manual source selection: search + pick anime + pick episode
// ---------------------------------------------------------------------------

/** Search danmu_api for animes matching a keyword. */
export async function searchDanmakuAnimes(
	keyword: string,
): Promise<DanmuApiMatch[]> {
	if (!keyword.trim()) return [];
	const base = danmuApiBase();
	const response = await fetch(
		`${base}/api/v2/search/anime?keyword=${encodeURIComponent(keyword)}`,
	);
	if (!response.ok) return [];
	const data = await response.json();
	const animes = (data.animes ?? []) as (DanmuApiMatch & {
		typeDescription?: string;
	})[];
	return animes.map((anime) => ({
		animeId: anime.animeId,
		animeTitle: anime.animeTitle,
	}));
}

/**
 * Pin a manual choice: stores it in the match cache under the current
 * item's key so automatic resolution returns it next time.
 */
export function pinDanmakuMatch(
	query: DanmakuQuery,
	anime: DanmuApiMatch,
): void {
	const cache = loadMatchCache();
	cache[matchCacheKey(query)] = {
		animeId: anime.animeId,
		animeTitle: anime.animeTitle,
	};
	saveMatchCache(cache);
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
export function parseDanmakuXml(
	xml: string,
	options?: { mergeDuplicates?: boolean },
): DanmakuComment[] {
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
	return options?.mergeDuplicates
		? mergeDuplicateComments(comments)
		: comments;
}

/**
 * Collapse runs of the same text within a 5-second window into a single
 * comment with a "x N" suffix. Runs are counted per mode so a top comment
 * does not absorb a scroll one.
 */
export function mergeDuplicateComments(
	comments: DanmakuComment[],
): DanmakuComment[] {
	const merged: DanmakuComment[] = [];
	let index = 0;
	while (index < comments.length) {
		const current = comments[index];
		let count = 1;
		let look = index + 1;
		while (
			look < comments.length &&
			comments[look].text === current.text &&
			comments[look].mode === current.mode &&
			comments[look].time - comments[look - 1].time <= 5
		) {
			count += 1;
			look += 1;
		}
		if (count > 1) {
			merged.push({
				...current,
				text: `${current.text} x ${count}`,
			});
		} else {
			merged.push(current);
		}
		index = look;
	}
	return merged;
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
		const blockList = this.settings.blockWords
			.split(/[;；\n]/)
			.map((word) => word.trim())
			.filter(Boolean);
		const maxOnScreen =
			this.settings.maxOnScreen > 0 ? this.settings.maxOnScreen : Number.POSITIVE_INFINITY;
		let spawned = 0;
		while (
			this.cursor < this.comments.length &&
			this.comments[this.cursor].time <= videoTime
		) {
			const candidate = this.comments[this.cursor];
			const blocked =
				blockList.length > 0 && blockList.some((word) => candidate.text.includes(word));
			const saturated = this.active.length >= maxOnScreen;
			if (!blocked && !saturated && spawned < MAX_SPAWN_PER_TICK) {
				this.spawn(candidate, videoTime, laneCount, laneHeight, topPadding);
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

		let x = entry.x;
		if (entry.comment.mode === "scroll") {
			const duration = SCROLL_DURATION / Math.max(0.1, this.settings.speed);
			const progress = elapsed / duration;
			x = this.width - progress * (this.width + entry.measured.width);
		}

		if (this.settings.outline) {
			// Stroke first, then fill on top: a crisp outline that survives
			// bright scenes, cheaper than blurred shadows in CanvasKit-style
			// rasterizers.
			this.ctx.lineWidth = Math.max(2, fontSize / 12);
			this.ctx.strokeStyle = "rgba(0,0,0,0.85)";
			this.ctx.lineJoin = "round";
			this.ctx.strokeText(entry.comment.text, x, entry.y);
		} else {
			this.ctx.shadowColor = "rgba(0,0,0,0.8)";
			this.ctx.shadowBlur = 2;
		}

		this.ctx.fillStyle = entry.comment.color;
		this.ctx.fillText(entry.comment.text, x, entry.y);
		this.ctx.shadowBlur = 0;
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
