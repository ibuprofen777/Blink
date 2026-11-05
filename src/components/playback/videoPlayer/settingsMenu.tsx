import {
	Box,
	MenuItem,
	MenuList,
	Popover,
	Slider,
	Switch,
	TextField,
	Typography,
} from "@mui/material";
import { toNumber } from "lodash";
import React, {
	type ChangeEventHandler,
	useCallback,
	useMemo,
	useTransition,
} from "react";
import { useShallow } from "zustand/shallow";
import { useApiInContext } from "@/utils/store/api";
import {
	changeAudioTrack,
	changeSubtitleTrack,
	usePlaybackStore,
} from "@/utils/store/playback";
import {
	loadDanmakuSettings,
	saveDanmakuSettings,
	type DanmakuSettings,
} from "@/utils/danmaku";

type VideoPlayerSettingsMenuProps = {
	settingsMenuRef: HTMLButtonElement | null;
	handleClose: () => void;
};

const VideoPlayerSettingsMenu = ({
	settingsMenuRef,
	handleClose,
}: VideoPlayerSettingsMenuProps) => {
	const settingsMenuOpen = useMemo(() => {
		return Boolean(settingsMenuRef);
	}, [settingsMenuRef]);

	const api = useApiInContext((state) => state.api);

	const {
		mediaSource,
		setIsBuffering,
		showStatsForNerds,
		toggleShowStatsForNerds,
	} = usePlaybackStore(
		useShallow((state) => ({
			mediaSource: state.mediaSource,
			setIsBuffering: state.setIsBuffering,
			showStatsForNerds: state.playerState.showStatsForNerds,
			toggleShowStatsForNerds: state.toggleShowStatsForNerds,
		})),
	);

	const [subtitleIsChanging, startSubtitleChange] = useTransition();
	const [danmaku, setDanmaku] = React.useState<DanmakuSettings>(() =>
		loadDanmakuSettings(),
	);

	const updateDanmaku = useCallback(
		(patch: Partial<DanmakuSettings>) => {
			setDanmaku((previous) => {
				const next = { ...previous, ...patch };
				saveDanmakuSettings(next);
				window.dispatchEvent(new CustomEvent("blink-danmaku-settings"));
				return next;
			});
		},
		[],
	);

	const toggleDanmaku = useCallback(() => {
		updateDanmaku({ enabled: !loadDanmakuSettings().enabled });
	}, [updateDanmaku]);

	const [audioTackIsChanging, startAudioTrackChange] = useTransition();
	const handleAudioTrackChange: ChangeEventHandler<
		HTMLInputElement | HTMLTextAreaElement
	> = (e) => {
		// setPlaying(false);
		startAudioTrackChange(() => {
			if (api && mediaSource.audio.allTracks) {
				changeAudioTrack(toNumber(e.target.value), api);
				handleClose();
				setIsBuffering(true);
			}
		});

		// setPlaying(true);
	};

	const handleSubtitleChange: ChangeEventHandler<
		HTMLInputElement | HTMLTextAreaElement
	> = useCallback(
		(e) => {
			startSubtitleChange(() => {
				if (mediaSource.subtitle.allTracks) {
					changeSubtitleTrack(
						toNumber(e.target.value),
						mediaSource.subtitle.allTracks,
					);
					handleClose();
				}
			});
		},
		[mediaSource.subtitle?.allTracks],
	);

	return (
		<Popover
			anchorEl={settingsMenuRef}
			open={settingsMenuOpen}
			onClose={handleClose}
			slotProps={{
				paper: {
					style: {
						maxHeight: "32em",
						display: "flex",
						flexDirection: "column",
						gap: "1em",
						width: "26em",
						padding: "1em",
						borderRadius: "12px",
						overflowY: "auto",
					},
					className: "glass",
				},
			}}
			anchorOrigin={{
				vertical: "bottom",
				horizontal: "right",
			}}
			transformOrigin={{
				vertical: "top",
				horizontal: "right",
			}}
		>
			<TextField
				select
				label="Audio"
				variant="outlined"
				value={mediaSource.audio?.track}
				onChange={handleAudioTrackChange}
				fullWidth
				disabled={audioTackIsChanging}
			>
				{mediaSource.audio?.allTracks?.map((sub) => (
					<MenuItem key={sub.Index} value={sub.Index}>
						{sub.DisplayTitle}
					</MenuItem>
				))}
			</TextField>
			<TextField
				select
				label="Subtitles"
				variant="outlined"
				value={mediaSource.subtitle?.track}
				onChange={handleSubtitleChange}
				fullWidth
				disabled={mediaSource.subtitle?.track === -2 || subtitleIsChanging}
			>
				<MenuItem key={-1} value={-1}>
					No Subtitle
				</MenuItem>
				{mediaSource.subtitle?.allTracks?.map((sub) => (
					<MenuItem key={sub.Index} value={sub.Index}>
						{sub.DisplayTitle}
					</MenuItem>
				))}
			</TextField>
			<MenuList disablePadding>
				<MenuItem onClick={toggleDanmaku}>
					<Typography
						sx={{
							flexGrow: 1,
						}}
					>
						Danmaku
					</Typography>
					<Switch checked={danmaku.enabled} />
				</MenuItem>
				<MenuItem onClick={toggleShowStatsForNerds}>
					<Typography
						sx={{
							flexGrow: 1,
						}}
					>
						Stats for Nerds
					</Typography>
					<Switch checked={showStatsForNerds} />
				</MenuItem>
			</MenuList>

			{danmaku.enabled && (
				<Box
					sx={{
						display: "flex",
						flexDirection: "column",
						gap: 0.5,
						padding: "0.75em",
						borderRadius: "8px",
						backgroundColor: "rgba(255,255,255,0.06)",
					}}
				>
					<DanmakuSlider
						label="Font Size"
						min={14}
						max={48}
						step={1}
						value={danmaku.fontSize}
						format={(value) => `${value}px`}
						onChange={(value) => updateDanmaku({ fontSize: value })}
					/>
					<DanmakuSlider
						label="Opacity"
						min={0.1}
						max={1}
						step={0.05}
						value={danmaku.opacity}
						format={(value) => `${Math.round(value * 100)}%`}
						onChange={(value) => updateDanmaku({ opacity: value })}
					/>
					<DanmakuSlider
						label="Display Area"
						min={0.3}
						max={1}
						step={0.05}
						value={danmaku.area}
						format={(value) => `${Math.round(value * 100)}%`}
						onChange={(value) => updateDanmaku({ area: value })}
					/>
					<DanmakuSlider
						label="Speed"
						min={0.5}
						max={2}
						step={0.1}
						value={danmaku.speed}
						format={(value) => `${value.toFixed(1)}x`}
						onChange={(value) => updateDanmaku({ speed: value })}
					/>
					<DanmakuSlider
						label="Max On Screen"
						min={0}
						max={100}
						step={5}
						value={danmaku.maxOnScreen}
						format={(value) => (value === 0 ? "Unlimited" : String(value))}
						onChange={(value) => updateDanmaku({ maxOnScreen: value })}
					/>
					<Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
						<Typography sx={{ flexGrow: 1, fontSize: "0.9em" }}>
							Outline
						</Typography>
						<Switch
							size="small"
							checked={danmaku.outline}
							onChange={(event) =>
								updateDanmaku({ outline: event.target.checked })
							}
						/>
					</Box>
					<Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
						<Typography sx={{ flexGrow: 1, fontSize: "0.9em" }}>
							Merge Duplicates
						</Typography>
						<Switch
							size="small"
							checked={danmaku.mergeDuplicates}
							onChange={(event) =>
								updateDanmaku({ mergeDuplicates: event.target.checked })
							}
						/>
					</Box>
					<TextField
						label="Block Words (semicolon separated)"
						variant="outlined"
						size="small"
						multiline
						minRows={2}
						value={danmaku.blockWords}
						onChange={(event) => updateDanmaku({ blockWords: event.target.value })}
						fullWidth
					/>
				</Box>
			)}
		</Popover>
	);
};

type DanmakuSliderProps = {
	label: string;
	min: number;
	max: number;
	step: number;
	value: number;
	format: (value: number) => string;
	onChange: (value: number) => void;
};

function DanmakuSlider({
	label,
	min,
	max,
	step,
	value,
	format,
	onChange,
}: DanmakuSliderProps) {
	return (
		<Box sx={{ padding: "0 0.5em" }}>
			<Box sx={{ display: "flex", justifyContent: "space-between" }}>
				<Typography sx={{ fontSize: "0.9em" }}>{label}</Typography>
				<Typography sx={{ fontSize: "0.9em" }} color="text.secondary">
					{format(value)}
				</Typography>
			</Box>
			<Slider
				size="small"
				min={min}
				max={max}
				step={step}
				value={value}
				onChange={(_event, newValue) =>
					onChange(Array.isArray(newValue) ? (newValue[0] as number) : (newValue as number))
				}
			/>
		</Box>
	);
}

export default VideoPlayerSettingsMenu;
