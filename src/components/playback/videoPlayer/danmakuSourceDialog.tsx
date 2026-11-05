import {
	Box,
	CircularProgress,
	Dialog,
	DialogContent,
	IconButton,
	List,
	ListItemButton,
	ListItemText,
	TextField,
	Typography,
} from "@mui/material";
import React from "react";
import {
	pinDanmakuMatch,
	searchDanmakuAnimes,
	type DanmuApiMatch,
} from "@/utils/danmaku";

type DanmakuSourceDialogProps = {
	open: boolean;
	onClose: () => void;
	/** Item title used to prefill the search and pin the choice. */
	itemTitle: string;
	/** Called with the chosen anime after the user picks one. */
	onPick: (anime: DanmuApiMatch) => void;
};

/**
 * Danmaku source picker: search danmu_api by keyword, list the animes,
 * and pin the chosen one as the match for this item.
 *
 * Gamepad/keyboard navigable: arrow keys move the list, Enter picks,
 * Escape closes.
 */
const DanmakuSourceDialog = ({
	open,
	onClose,
	itemTitle,
	onPick,
}: DanmakuSourceDialogProps) => {
	const [keyword, setKeyword] = React.useState(itemTitle);
	const [results, setResults] = React.useState<DanmuApiMatch[]>([]);
	const [loading, setLoading] = React.useState(false);
	const [searched, setSearched] = React.useState(false);
	const [focusedIndex, setFocusedIndex] = React.useState(0);
	const listRef = React.useRef<HTMLUListElement | null>(null);

	const runSearch = React.useCallback(async (term: string) => {
		if (!term.trim()) return;
		setLoading(true);
		setSearched(true);
		try {
			const animes = await searchDanmakuAnimes(term);
			setResults(animes);
			setFocusedIndex(0);
		} finally {
			setLoading(false);
		}
	}, []);

	React.useEffect(() => {
		if (open && itemTitle && !searched) {
			setKeyword(itemTitle);
			runSearch(itemTitle);
		}
	}, [open, itemTitle, searched, runSearch]);

	React.useEffect(() => {
		if (!open) setSearched(false);
	}, [open]);

	const pick = React.useCallback(
		(anime: DanmuApiMatch) => {
			pinDanmakuMatch(
				{
					title: itemTitle,
					season: 0,
				},
				anime,
			);
			onPick(anime);
			onClose();
		},
		[itemTitle, onPick, onClose],
	);

	const handleKeyDown = React.useCallback(
		(event: React.KeyboardEvent) => {
			if (event.key === "ArrowDown") {
				event.preventDefault();
				setFocusedIndex((index) =>
					Math.min(index + 1, results.length - 1),
				);
			} else if (event.key === "ArrowUp") {
				event.preventDefault();
				setFocusedIndex((index) => Math.max(index - 1, 0));
			} else if (event.key === "Enter" && results[focusedIndex]) {
				event.preventDefault();
				pick(results[focusedIndex]);
			} else if (event.key === "Escape") {
				onClose();
			}
		},
		[results, focusedIndex, pick, onClose],
	);

	React.useEffect(() => {
		const node = listRef.current?.children[focusedIndex] as HTMLElement;
		node?.scrollIntoView({ block: "nearest" });
	}, [focusedIndex]);

	return (
		<Dialog
			open={open}
			onClose={onClose}
			maxWidth="sm"
			fullWidth
			slotProps={{
				paper: {
					sx: {
						borderRadius: "12px",
						backgroundColor: "rgba(20,20,24,0.95)",
					},
					onKeyDown: handleKeyDown,
				},
			}}
		>
			<DialogContent sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
				<Box
					sx={{
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
					}}
				>
					<Typography variant="h6">Danmaku Source</Typography>
					<IconButton size="small" onClick={onClose}>
						<span className="material-symbols-rounded">close</span>
					</IconButton>
				</Box>
				<Box sx={{ display: "flex", gap: 1 }}>
					<TextField
						size="small"
						fullWidth
						label="Search keyword"
						value={keyword}
						onChange={(event) => setKeyword(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.stopPropagation();
								runSearch(keyword);
							}
						}}
					/>
				</Box>
				{loading && (
					<Box sx={{ display: "flex", justifyContent: "center", padding: 2 }}>
						<CircularProgress size={28} />
					</Box>
				)}
				{!loading && results.length === 0 && searched && (
					<Typography color="text.secondary" sx={{ textAlign: "center", padding: 2 }}>
						No results. Try another keyword.
					</Typography>
				)}
				{!loading && results.length > 0 && (
					<List
						ref={listRef}
						dense
						sx={{
							maxHeight: "45vh",
							overflowY: "auto",
							borderRadius: "8px",
						}}
					>
						{results.map((anime, index) => (
							<ListItemButton
								key={anime.animeId}
								selected={index === focusedIndex}
								onMouseEnter={() => setFocusedIndex(index)}
								onClick={() => pick(anime)}
							>
								<ListItemText
									primary={anime.animeTitle}
									slotProps={{
										primary: {
											style: {
												fontSize: "0.95em",
												whiteSpace: "nowrap",
												overflow: "hidden",
												textOverflow: "ellipsis",
											},
										},
									}}
								/>
							</ListItemButton>
						))}
					</List>
				)}
				<Typography
					variant="caption"
					color="text.secondary"
					sx={{ textAlign: "center" }}
				>
					↑↓ navigate · Enter select · Esc close
				</Typography>
			</DialogContent>
		</Dialog>
	);
};

export default DanmakuSourceDialog;
