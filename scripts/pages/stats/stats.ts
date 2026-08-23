import { PanelHandler } from 'util/module-helpers';
import * as Enum from 'util/enum';
import { Gamemode } from 'common/web/enums/gamemode.enum';
import { TrackType } from 'common/web/enums/track-type.enum';
import { Style, styleEnglishName } from 'common/web/enums/style.enum';
import { LeaderboardType } from 'common/web/enums/leaderboard-type.enum';
import { MapStatus } from 'common/web/enums/map-status.enum';
import { GamemodeDefaultUIStyle, GamemodeStyles } from 'common/web/maps/gamemode-styles.map';
import { GamemodeInfo } from 'common/gamemode';
import { getTrack, getUserMapDataTrack } from 'common/leaderboard';
import { handlePlayMap } from 'common/maps';

type RankFilter = 'ranked' | 'unranked' | 'both';

// Sentinel selectedMode value for the aggregate "All gamemodes" view.
const ALL_MODES = -1 as Gamemode;

interface TierStat {
	total: number;
	completed: number;
}
interface ModeStat {
	style: Style;
	// Totals for the active rank filter.
	total: number;
	completed: number;
	tiers: Map<number, TierStat>;
	// Absolute split (ignores the active filter) for the ranked/unranked readout.
	rankedTotal: number;
	rankedDone: number;
	unrankedTotal: number;
	unrankedDone: number;
}

// The game exposes no "list all maps" API to non-C++ code, so we brute-force the
// cache by map id. Result is kept module-level so re-opening the page is instant;
// the Rescan button forces a fresh scan (e.g. after completing maps this session).
let scanCache: MapCacheAPI.MapData[] | null = null;
let scanning = false; // a chunked map scan is in progress (guards against double-scans)
let scanRetries = 0; // bounded retries when a scan finds nothing (map cache not ready yet)

// UI state persists across page re-opens too.
let rankFilter: RankFilter = 'ranked';
let selectedMode: Gamemode | null = null;
let selectedStyle: Style | null = null; // which style's completion is shown for the selected mode
let available: Gamemode[] = [];
let selectedTier: number | null = null; // which tier's map list is expanded

// Cached so the tier map-list can re-render without recomputing everything.
// The cards persist across re-renders (only their contents are refilled) to avoid the solid card
// boxes flashing over the transparent/blurred in-game background on every gamemode/style change.
let curStat: ModeStat | null = null;
let leftCard: Panel | null = null;
let rightCard: Panel | null = null;

// Bar buttons are built once and only restyled (not rebuilt) on selection changes, to avoid flicker.
let filterBtns: { key: RankFilter; panel: Panel; label: Panel }[] = [];
let modeBtns: { key: Gamemode; panel: Panel; label: Panel }[] = [];
let styleBtns: { key: Style; panel: Panel; label: Panel }[] = [];

// Live leaderboard-rank stats (WRs / top 10s / avg rank / avg %). The local cache has no rank,
// so these are fetched on demand from the API (one request per completed map). Cached per selection.
const API = 'https://api.momentum-mod.org';
interface RankResult {
	wr: number;
	top10: number;
	avgRank: number;
	avgPct: number | null;
	pctPending: boolean; // phase 2 (percentile) still running
	ranked: number; // maps we found a rank on
	noEntry: number; // valid response but you're not on that board (e.g. map re-versioned)
	errors: number; // request/parse failed (network / rate-limit)
	targets: number; // completed maps we queried
	elapsed: number; // seconds
	// Raw sums so the "All" view can aggregate per-mode results exactly (no re-querying).
	sumRank: number;
	sumPct: number;
	pctCount: number;
}
const EMPTY_RANK: RankResult = {
	wr: 0, top10: 0, avgRank: 0, avgPct: null, pctPending: false,
	ranked: 0, noEntry: 0, errors: 0, targets: 0, elapsed: 0, sumRank: 0, sumPct: 0, pctCount: 0
};
let rankResults: Record<string, RankResult> = {};
let rankBusy = false;
let rankGen = 0; // bumped on rescan; a running scan aborts if it no longer matches
// The rank body panel for the selection currently shown, so a running scan can render into it if it
// matches, and a background scan of other modes renders nowhere.
let curRankBody: Panel | null = null;
// Queue of (mode,style,filter) to scan — the current selection is pushed to the front, all gamemodes
// behind it, so everything fills in ASAP while prioritising what's on screen.
let rankQueue: { mode: Gamemode; style: Style | null; filter: RankFilter }[] = [];

// Map ids are submission ids: sparse and growing (newest approved maps sit at high ids with big
// gaps of unapproved ids before them). We scan the FULL range so recently-approved maps aren't
// missed — an early "stop after N misses" cutoff dropped exactly those newest maps.
const MAX_ID = 6000; // hard ceiling for the id scan (submission ids; leaves years of headroom)
const CHUNK = 300; // ids scanned per frame

// Palette
const C_ACCENT = '#6fe0d0';
const C_TRACK = '#39414d';
const C_CARD = '#171b22';
const C_BORDER = '#2a2f38';

const LEFT_CARD_STYLE =
	`flow-children: down; width: 340px; height: 100%; margin-right: 16px; background-color: ${C_CARD}; ` +
	`border: 1px solid ${C_BORDER}; border-radius: 10px; padding: 20px; overflow: squish scroll;`;
const RIGHT_CARD_STYLE =
	`flow-children: down; width: fill-parent-flow(1); height: 100%; background-color: ${C_CARD}; ` +
	`border: 1px solid ${C_BORDER}; border-radius: 10px; padding: 20px;`;

@PanelHandler()
class StatsHandler {
	constructor() {
		// The page may be pre-created (hidden) before the map cache is ready, in which case its
		// initial scan finds nothing. Re-scan when the page is actually shown if we have no maps yet.
		$.RegisterForUnhandledEvent('MainMenuPageShown', (page: string) => {
			if (page === 'Stats' && !scanCache && !scanning) {
				$.Msg('[Stats] MainMenuPageShown(Stats): no cache yet, kicking a scan');
				this.scan();
			}
		});
	}

	// Called from the page root's onload (fires once the page is actually shown, unlike the
	// PanelLoaded/onPanelLoad hook which runs too early and stalled the chunked scan).
	onLoad() {
		$.Msg(`[Stats] onLoad: scanCache=${scanCache ? scanCache.length + ' maps' : 'none'}, scanning=${scanning}`);
		if (scanCache) this.buildAll();
		else if (!scanning) this.scan();
	}

	rescan() {
		scanCache = null;
		this.scan();
	}

	/** Chunked id scan of the local map cache. */
	scan() {
		if (scanning) return; // already scanning
		$.Msg(`[Stats] scan: starting map-cache scan (id 1..${MAX_ID}, retry ${scanRetries})`);
		scanning = true;
		const status = $<Label>('#StatsStatus');
		if (status) status.visible = true; // shown while scanning / empty; hidden once content renders
		$<Panel>('#StatsGamemodeBar')?.RemoveAndDeleteChildren();
		$<Panel>('#StatsContent')?.RemoveAndDeleteChildren();
		$<Panel>('#StatsFilter')?.RemoveAndDeleteChildren();
		leftCard = null; // cards were just deleted; force recreation on next render
		rightCard = null;
		rankResults = {}; // completions may have changed; drop cached rank stats
		rankQueue = []; // drop any pending scans
		rankGen++; // supersede any in-flight rank scan

		const maps: MapCacheAPI.MapData[] = [];
		let id = 1;

		const keepGoing = () => id <= MAX_ID;

		const step = () => {
			let processed = 0;
			while (keepGoing() && processed < CHUNK) {
				let data: MapCacheAPI.MapData | null = null;
				try {
					data = MapCacheAPI.GetMapData(id);
				} catch {
					data = null;
				}

				if (data?.staticData?.leaderboards?.length) maps.push(data);

				id++;
				processed++;
			}

			if (status) status.text = `Scanning map cache… ${maps.length} maps found`;

			if (keepGoing()) {
				$.Schedule(0, step);
			} else {
				scanning = false;
				// Don't cache an empty result (e.g. cache not ready during a hidden pre-warm) — that
				// leaves scanCache set so a later "page shown" wouldn't re-scan.
				scanCache = maps.length > 0 ? maps : null;
				if (maps.length > 0) {
					$.Msg(`[Stats] scan: done — ${maps.length} maps found`);
					scanRetries = 0;
				} else if (scanRetries < 6) {
					// Map cache probably isn't ready yet — retry a few times so the pre-warm still lands.
					scanRetries++;
					$.Msg(`[Stats] scan: 0 maps (cache not ready?) — retry ${scanRetries}/6 in 5s`);
					$.Schedule(5, () => {
						if (!scanCache && !scanning) this.scan();
					});
				} else {
					$.Msg('[Stats] scan: 0 maps after 6 retries — giving up until Rescan');
				}
				this.buildAll();
			}
		};

		step();
	}

	/** After a scan (or on re-open), decide which gamemodes have maps, pick one, and draw everything. */
	buildAll() {
		const maps = scanCache ?? [];

		// A gamemode is "available" if it has at least one ranked/unranked tiered main track in any of its styles.
		available = Enum.fastValuesNumeric(Gamemode).filter((gm) => this.modeHasMaps(maps, gm));

		if (selectedMode == null || (selectedMode !== ALL_MODES && !available.includes(selectedMode))) {
			// First load defaults to the current in-game gamemode, else the first available.
			let meta: Gamemode | null = null;
			try {
				meta = GameModeAPI.GetMetaGameMode();
			} catch {
				meta = null;
			}
			selectedMode = meta != null && available.includes(meta) ? meta : (available[0] ?? null);
		}

		if (selectedMode != null && selectedMode !== ALL_MODES) this.ensureStyle(selectedMode);

		this.renderFilter();
		this.renderBar();
		this.renderStyleBar();
		this.renderContent();

		// Crunch through every gamemode's ranks in the background (current selection first).
		this.enqueueAllModes();
	}

	setRank(f: RankFilter) {
		rankFilter = f;
		selectedTier = null; // tier set differs per filter
		this.highlightFilter(); // restyle only, no rebuild
		this.renderContent();
		this.enqueueAllModes(); // the new filter may need unranked scans (ranked already cached); no dup
	}

	selectMode(gm: Gamemode) {
		selectedMode = gm;
		// Switching modes always snaps back to that mode's default style (don't carry a shared style across).
		if (gm !== ALL_MODES) selectedStyle = GamemodeDefaultUIStyle.get(gm) ?? Style.NORMAL;
		selectedTier = null; // tier set differs per gamemode
		this.highlightBar(); // gamemode bar: restyle only
		this.renderStyleBar(); // style bar content changes per mode, so it does rebuild
		this.renderContent();
	}

	setStyle(st: Style) {
		selectedStyle = st;
		selectedTier = null; // tier set differs per style
		this.highlightStyle(); // restyle only, no rebuild
		this.renderContent();
	}

	/** Ensure selectedStyle is valid for the given mode, defaulting to its UI style. */
	ensureStyle(gm: Gamemode) {
		const valid = GamemodeStyles.get(gm);
		if (selectedStyle == null || !valid?.has(selectedStyle)) {
			selectedStyle = GamemodeDefaultUIStyle.get(gm) ?? Style.NORMAL;
		}
	}

	/** True if any map has a ranked/unranked tiered main track for this mode in any of its styles. */
	modeHasMaps(maps: MapCacheAPI.MapData[], gm: Gamemode): boolean {
		const styles = GamemodeStyles.get(gm);
		if (!styles) return false;
		for (const { staticData } of maps) {
			if (staticData.status !== MapStatus.APPROVED) continue; // exclude beta/testing/submission maps
			for (const st of styles) {
				const lb = getTrack(staticData, gm, TrackType.MAIN, 1, st);
				if (
					lb &&
					lb.tier &&
					(lb.type === LeaderboardType.RANKED || lb.type === LeaderboardType.UNRANKED)
				)
					return true;
			}
		}
		return false;
	}

	/** Toggle a tier's expanded map list. */
	selectTier(t: number) {
		selectedTier = selectedTier === t ? null : t;
		if (rightCard && curStat) this.fillRight(rightCard, curStat);
	}

	/** Per-gamemode / per-style main-track completion for a rank filter. Skips untiered / hidden / in-submission. */
	computeMode(maps: MapCacheAPI.MapData[], gm: Gamemode, filter: RankFilter, style: Style): ModeStat {
		const s: ModeStat = {
			style,
			total: 0,
			completed: 0,
			tiers: new Map(),
			rankedTotal: 0,
			rankedDone: 0,
			unrankedTotal: 0,
			unrankedDone: 0
		};

		for (const { staticData, userData } of maps) {
			if (staticData.status !== MapStatus.APPROVED) continue; // exclude beta/testing/submission maps

			const lb = getTrack(staticData, gm, TrackType.MAIN, 1, style);
			if (!lb || !lb.tier) continue; // no real tier (null or 0), or no board in this style

			const isRanked = lb.type === LeaderboardType.RANKED;
			const isUnranked = lb.type === LeaderboardType.UNRANKED;
			if (!isRanked && !isUnranked) continue; // exclude hidden / in-submission

			const done = this.isDone(userData, gm, style);

			if (isRanked) {
				s.rankedTotal++;
				if (done) s.rankedDone++;
			} else {
				s.unrankedTotal++;
				if (done) s.unrankedDone++;
			}

			const inFilter =
				filter === 'both' || (filter === 'ranked' && isRanked) || (filter === 'unranked' && isUnranked);
			if (!inFilter) continue;

			s.total++;
			if (done) s.completed++;

			let tier = s.tiers.get(lb.tier);
			if (!tier) {
				tier = { total: 0, completed: 0 };
				s.tiers.set(lb.tier, tier);
			}
			tier.total++;
			if (done) tier.completed++;
		}

		return s;
	}

	/** Aggregate of every available gamemode (each at its own default style) for the "All" view. */
	computeAll(maps: MapCacheAPI.MapData[], filter: RankFilter): ModeStat {
		const agg: ModeStat = {
			style: Style.NORMAL,
			total: 0,
			completed: 0,
			tiers: new Map(),
			rankedTotal: 0,
			rankedDone: 0,
			unrankedTotal: 0,
			unrankedDone: 0
		};

		for (const gm of available) {
			const style = GamemodeDefaultUIStyle.get(gm) ?? Style.NORMAL;
			const s = this.computeMode(maps, gm, filter, style);

			agg.total += s.total;
			agg.completed += s.completed;
			agg.rankedTotal += s.rankedTotal;
			agg.rankedDone += s.rankedDone;
			agg.unrankedTotal += s.unrankedTotal;
			agg.unrankedDone += s.unrankedDone;

			for (const [tier, ts] of s.tiers) {
				let a = agg.tiers.get(tier);
				if (!a) {
					a = { total: 0, completed: 0 };
					agg.tiers.set(tier, a);
				}
				a.total += ts.total;
				a.completed += ts.completed;
			}
		}

		return agg;
	}

	//#region rendering

	/** Restyle a bar button for active/inactive without recreating it (avoids flicker). */
	applyBtn(panel: Panel, label: Panel, active: boolean, activeBg: string, inactiveBg: string, activeText: string, inactiveText: string) {
		try {
			panel.style.backgroundColor = active ? activeBg : inactiveBg;
		} catch {}
		try {
			panel.style.borderColor = active ? C_ACCENT : C_BORDER;
		} catch {}
		try {
			label.style.color = active ? activeText : inactiveText;
		} catch {}
	}

	renderFilter() {
		const bar = $<Panel>('#StatsFilter');
		if (!bar) return;
		bar.RemoveAndDeleteChildren();
		filterBtns = [];

		const opts: [RankFilter, string][] = [
			['ranked', 'Ranked'],
			['unranked', 'Unranked'],
			['both', 'Both']
		];

		for (const [key, label] of opts) {
			const btn = $.CreatePanel('Panel', bar, '', {
				style:
					'flow-children: right; padding: 7px 16px; margin-left: 6px; border-radius: 6px; ' +
					`background-color: #1a1f27; border: 1px solid ${C_BORDER};`
			});
			btn.SetPanelEvent('onactivate', () => this.setRank(key));
			const lbl = $.CreatePanel('Label', btn, '', { text: label, style: 'font-size: 14px; color: #aeb6c2;' });
			filterBtns.push({ key, panel: btn, label: lbl });
		}
		this.highlightFilter();
	}

	highlightFilter() {
		for (const b of filterBtns) {
			if (b.panel.IsValid())
				this.applyBtn(b.panel, b.label, rankFilter === b.key, '#1c2b30', '#1a1f27', C_ACCENT, '#aeb6c2');
		}
	}

	renderBar() {
		const bar = $<Panel>('#StatsGamemodeBar');
		if (!bar) return;
		bar.RemoveAndDeleteChildren();
		modeBtns = [];

		const btnStyle =
			'flow-children: down; width: 104px; padding: 12px 6px; margin-right: 8px; border-radius: 8px; ' +
			`background-color: #141922; border: 1px solid ${C_BORDER};`;
		const iconStyle = 'width: 30px; height: 30px; horizontal-align: center; margin-bottom: 7px;';
		const lblStyle = 'font-size: 12px; color: #9aa3af; horizontal-align: center; text-align: center;';

		// Aggregate "All gamemodes" button, pinned to the far left.
		if (available.length > 0) {
			const btn = $.CreatePanel('Panel', bar, '', { style: btnStyle });
			btn.SetPanelEvent('onactivate', () => this.selectMode(ALL_MODES));
			$.CreatePanel('Image', btn, '', {
				src: 'file://{images}/stats.svg',
				textureheight: 32,
				style: iconStyle
			});
			const lbl = $.CreatePanel('Label', btn, '', { text: 'All', style: lblStyle });
			modeBtns.push({ key: ALL_MODES, panel: btn, label: lbl });
		}

		for (const gm of available) {
			const info = GamemodeInfo.get(gm);
			const btn = $.CreatePanel('Panel', bar, '', { style: btnStyle });
			btn.SetPanelEvent('onactivate', () => this.selectMode(gm));
			$.CreatePanel('Image', btn, '', {
				src: `file://{images}/gamemodes/${info?.icon ?? 'null'}.svg`,
				textureheight: 32,
				style: iconStyle
			});
			const lbl = $.CreatePanel('Label', btn, '', {
				text: $.Localize(info?.i18n ?? '') || `Mode ${gm}`,
				style: lblStyle
			});
			modeBtns.push({ key: gm, panel: btn, label: lbl });
		}
		this.highlightBar();
	}

	highlightBar() {
		for (const b of modeBtns) {
			if (b.panel.IsValid())
				this.applyBtn(b.panel, b.label, b.key === selectedMode, '#1c2732', '#141922', '#ffffff', '#9aa3af');
		}
	}

	/** Small bar of the selected mode's valid styles (Normal / Pro / Teleport / Sideways / …). */
	renderStyleBar() {
		const bar = $<Panel>('#StatsStyleBar');
		if (!bar) return;
		bar.RemoveAndDeleteChildren();
		styleBtns = [];

		const styles = selectedMode == null || selectedMode === ALL_MODES
			? []
			: [...(GamemodeStyles.get(selectedMode) ?? [])];

		// Only meaningful when the mode actually has a choice of styles; otherwise hide the bar entirely.
		bar.visible = styles.length > 1;
		if (!bar.visible) return;

		$.CreatePanel('Label', bar, '', {
			text: 'Style',
			style: 'font-size: 12px; color: #6f7885; vertical-align: center; margin-right: 10px;'
		});

		for (const st of styles) {
			const btn = $.CreatePanel('Panel', bar, '', {
				style:
					'flow-children: right; padding: 5px 14px; margin-right: 6px; border-radius: 6px; ' +
					`background-color: #141922; border: 1px solid ${C_BORDER};`
			});
			btn.SetPanelEvent('onactivate', () => this.setStyle(st));
			const lbl = $.CreatePanel('Label', btn, '', {
				text: styleEnglishName(st),
				style: 'font-size: 13px; color: #aeb6c2;'
			});
			styleBtns.push({ key: st, panel: btn, label: lbl });
		}
		this.highlightStyle();
	}

	highlightStyle() {
		for (const b of styleBtns) {
			if (b.panel.IsValid())
				this.applyBtn(b.panel, b.label, b.key === selectedStyle, '#1c2b30', '#141922', C_ACCENT, '#aeb6c2');
		}
	}

	renderContent() {
		const status = $<Label>('#StatsStatus');
		const content = $<Panel>('#StatsContent');
		if (!content) return;

		if (selectedMode == null) {
			content.RemoveAndDeleteChildren();
			leftCard = null;
			rightCard = null;
			if (status) {
				status.visible = true;
				status.text = 'No maps found in the cache. Make sure you are online, then press Rescan.';
			}
			return;
		}

		// The headline gamemode/track/% figures now live in the left card, so hide the status line.
		if (status) status.visible = false;

		const maps = scanCache ?? [];
		const gm = selectedMode;

		let s: ModeStat;
		let name: string;
		if (gm === ALL_MODES) {
			s = this.computeAll(maps, rankFilter);
			name = 'All Gamemodes';
		} else {
			const style = selectedStyle ?? GamemodeDefaultUIStyle.get(gm) ?? Style.NORMAL;
			s = this.computeMode(maps, gm, rankFilter, style);
			name = $.Localize(GamemodeInfo.get(gm)?.i18n ?? '') || `Gamemode ${gm}`;
		}

		curStat = s;

		// Reuse the persistent card boxes; only their contents are refilled (avoids flashing the
		// solid boxes over the transparent blurred background on each gamemode/style change).
		if (!leftCard || !leftCard.IsValid()) {
			leftCard = $.CreatePanel('Panel', content, 'StatsLeftCard', { style: LEFT_CARD_STYLE });
		}
		if (!rightCard || !rightCard.IsValid()) {
			rightCard = $.CreatePanel('Panel', content, 'StatsRightCard', { style: RIGHT_CARD_STYLE });
		}

		this.fillLeft(leftCard, gm, name, s);
		this.fillRight(rightCard, s);
	}

	/** Left column: headline number, completion ring, and stat tiles. */
	fillLeft(card: Panel, gm: Gamemode, name: string, s: ModeStat) {
		card.RemoveAndDeleteChildren();

		const subtitle =
			gm === ALL_MODES
				? 'all gamemodes · general statistics'
				: `${styleEnglishName(s.style)} · general statistics`;

		$.CreatePanel('Label', card, '', {
			text: name,
			style: 'font-size: 20px; font-weight: bold; color: #ffffff; margin-bottom: 4px;'
		});
		$.CreatePanel('Label', card, '', {
			text: subtitle,
			style: 'font-size: 12px; color: #8a93a0; margin-bottom: 14px;'
		});

		this.renderRing(card, this.frac(s.completed, s.total), `${this.pct(s.completed, s.total)}%`);

		// Stacked completion bar
		this.makeBar(card, this.frac(s.completed, s.total), 12);
		$.CreatePanel('Label', card, '', {
			text: `${s.completed} of ${s.total} completed`,
			style: 'font-size: 13px; color: #b8c0cc; margin-top: 6px; horizontal-align: center;'
		});

		// Stat tiles
		const tiles = $.CreatePanel('Panel', card, '', {
			style: 'flow-children: right; width: 100%; margin-top: 16px;'
		});
		this.makeTile(tiles, 'Completed', `${s.completed}`, C_ACCENT);
		this.makeTile(tiles, 'Remaining', `${s.total - s.completed}`, '#e0a86f');
		this.makeTile(tiles, 'Tiers', `${s.tiers.size}`, '#9aa3af');

		// Ranked / unranked split (absolute, regardless of active filter)
		const split = $.CreatePanel('Panel', card, '', {
			style: 'flow-children: right; width: 100%; margin-top: 14px;'
		});
		this.makeTile(
			split,
			'Ranked',
			`${s.rankedDone}/${s.rankedTotal}`,
			rankFilter === 'unranked' ? '#6b7280' : C_ACCENT
		);
		this.makeTile(
			split,
			'Unranked',
			`${s.unrankedDone}/${s.unrankedTotal}`,
			rankFilter === 'ranked' ? '#6b7280' : '#e0a86f'
		);

		// Live leaderboard-rank stats (fetched from the API on demand).
		const rankSec = $.CreatePanel('Panel', card, '', {
			style: `flow-children: down; width: 100%; margin-top: 16px; padding-top: 14px; border-top: 1px solid ${C_BORDER};`
		});
		$.CreatePanel('Label', rankSec, '', {
			text: 'Leaderboard ranks',
			style: 'font-size: 13px; font-weight: bold; color: #cdd5df; margin-bottom: 2px;'
		});
		$.CreatePanel('Label', rankSec, '', {
			text: 'Live from the API · loads in the background',
			style: 'font-size: 11px; color: #6f7885; margin-bottom: 10px;'
		});
		const rankBody = $.CreatePanel('Panel', rankSec, '', { style: 'flow-children: down; width: 100%;' });
		curRankBody = rankBody;
		this.renderRankResults(rankBody, this.resultFor(selectedMode as Gamemode, selectedStyle, rankFilter));

		this.autoLoadCurrent(); // prioritise this selection in the scan queue
	}

	/** Prioritise the currently-shown selection. "All" and "both" are derived, never scanned directly. */
	autoLoadCurrent() {
		if (selectedMode == null) return;
		if (selectedMode === ALL_MODES) {
			this.enqueueAllModes(); // queue every mode so the aggregate can fill in
			return;
		}
		this.enqueueForView(selectedMode, selectedStyle, rankFilter, true);
	}

	/** Queue every individual gamemode (current selection first) so all cards + the "All" aggregate fill in. */
	enqueueAllModes() {
		// On-screen selection first (its active filter), so the visible card fills before anything else.
		if (selectedMode != null && selectedMode !== ALL_MODES) {
			this.enqueueForView(selectedMode, selectedStyle, rankFilter, true);
		}
		// Warm BOTH ranked AND unranked for every mode in the background, so switching the filter (or the
		// hidden main-menu pre-warm) already has both sets cached. Previously only the active filter
		// (default 'ranked') was queued here, so unranked wasn't preloaded until the user switched to it.
		for (const gm of available) {
			this.enqueueForView(gm, GamemodeDefaultUIStyle.get(gm) ?? Style.NORMAL, 'both');
		}
		const queued = rankQueue.length;
		$.Msg(
			`[Stats] enqueueAllModes: ${available.length} modes → both ranked+unranked queued ` +
				`(${queued} scans pending, filter='${rankFilter}', selectedMode=${selectedMode})`
		);
	}

	/** Expand a view filter into the concrete scans it needs. 'both' = ranked + unranked, which are
	 *  DISJOINT map sets, so each map is scanned once and 'both' is derived (never re-queried). */
	enqueueForView(mode: Gamemode, style: Style | null, filter: RankFilter, front = false) {
		const filters: RankFilter[] = filter === 'both' ? ['ranked', 'unranked'] : [filter];
		for (const f of filters) this.enqueueRank(mode, style, f, front);
	}

	/** Add a (mode,style,filter) scan to the queue (front to prioritise) and kick the worker. */
	enqueueRank(mode: Gamemode, style: Style | null, filter: RankFilter, front = false) {
		const key = this.rankKey(mode, style, filter);
		const r = rankResults[key];
		if (r && !r.pctPending) return; // already fully scanned
		rankQueue = rankQueue.filter((q) => this.rankKey(q.mode, q.style, q.filter) !== key); // dedupe
		if (front) rankQueue.unshift({ mode, style, filter });
		else rankQueue.push({ mode, style, filter });
		this.processRankQueue();
	}

	async processRankQueue() {
		if (rankBusy) return; // one scan at a time (this + set is atomic — no await between)
		const item = rankQueue.shift();
		if (!item) return;
		rankBusy = true;
		try {
			await this.runRankScan(item.mode, item.style, item.filter);
		} finally {
			rankBusy = false;
		}
		if (rankQueue.length) await this.sleep(0.4); // brief breather between modes so we don't hammer the API
		this.processRankQueue(); // next in queue
	}

	//#region live rank stats

	/** Promise-wrapped GET. */
	webGet(url: string): Promise<string> {
		return new Promise((resolve, reject) => {
			$.AsyncWebRequest(url, {
				type: 'GET',
				complete: (d) => (d.statusText === 'success' ? resolve(d.responseText) : reject(d.statusText))
			});
		});
	}

	sleep(sec: number): Promise<void> {
		return new Promise((res) => $.Schedule(sec, () => res()));
	}

	/** GET + parse with retries and jittered backoff — the game/API throttles parallel bursts, so
	 *  drops are common; jitter stops concurrent retries from re-bursting in lockstep. */
	async fetchJson(url: string, tries = 20): Promise<any> {
		for (let i = 0; i < tries; i++) {
			try {
				return this.parseLeadingJson(await this.webGet(url));
			} catch {
				if (i < tries - 1) await this.sleep(0.3 * (i + 1) + Math.random() * 0.4);
			}
		}
		$.Msg(`StatsHandler: fetchJson failed after ${tries} attempts: ${url}`);
		return null; // all attempts failed
	}

	/** Parse the leading top-level JSON value, ignoring trailing bytes — AsyncWebRequest appends a
	 *  stray char (a NUL terminator) after the body, which trips a plain JSON.parse. */
	parseLeadingJson(txt: string): any {
		let depth = 0;
		let inStr = false;
		let esc = false;
		let end = -1;
		for (let i = 0; i < txt.length; i++) {
			const c = txt[i];
			if (inStr) {
				if (esc) esc = false;
				else if (c === '\\') esc = true;
				else if (c === '"') inStr = false;
			} else if (c === '"') inStr = true;
			else if (c === '{' || c === '[') depth++;
			else if (c === '}' || c === ']') {
				depth--;
				if (depth === 0) {
					end = i;
					break;
				}
			}
		}
		return JSON.parse(end >= 0 ? txt.slice(0, end + 1) : txt);
	}

	/** The local user's rank on one map's (gm, main, style) leaderboard, or null if they aren't on it. */
	async fetchRank(
		mapID: number,
		gm: Gamemode,
		style: Style,
		uid: number
	): Promise<{ rank: number | null; ok: boolean }> {
		const url = `${API}/v1/maps/${mapID}/leaderboard?gamemode=${gm}&trackType=0&trackNum=1&style=${style}&userIDs=${uid}`;
		const j = await this.fetchJson(url);
		if (j == null) return { rank: null, ok: false }; // request failed after retries
		return { rank: j.data && j.data[0] ? j.data[0].rank : null, ok: true };
	}

	/** Total ranked entries on one map's (gm, main, style) leaderboard (for percentile). */
	async fetchTotal(mapID: number, gm: Gamemode, style: Style): Promise<number> {
		const url = `${API}/v1/maps/${mapID}/leaderboard?gamemode=${gm}&trackType=0&trackNum=1&style=${style}&take=1`;
		const j = await this.fetchJson(url);
		return j ? j.totalCount || 0 : 0;
	}

	rankKey(mode: Gamemode, style: Style | null, filter: RankFilter): string {
		return `${mode}|${style}|${filter}`;
	}

	/** Completed maps to query ranks for a specific mode/style/filter. */
	gatherTargetsFor(
		mode: Gamemode,
		style: Style | null,
		filter: RankFilter
	): { mapID: number; gm: Gamemode; style: Style }[] {
		const maps = scanCache ?? [];
		const out: { mapID: number; gm: Gamemode; style: Style }[] = [];
		const add = (gm: Gamemode, st: Style) => {
			for (const { staticData, userData } of maps) {
				if (staticData.status !== MapStatus.APPROVED) continue;
				const lb = getTrack(staticData, gm, TrackType.MAIN, 1, st);
				if (!lb || !lb.tier) continue;
				const isRanked = lb.type === LeaderboardType.RANKED;
				const isUnranked = lb.type === LeaderboardType.UNRANKED;
				if (!isRanked && !isUnranked) continue;
				if (filter === 'ranked' && !isRanked) continue;
				if (filter === 'unranked' && !isUnranked) continue;
				if (!this.isDone(userData, gm, st)) continue;
				out.push({ mapID: staticData.id, gm, style: st });
			}
		};
		if (mode === ALL_MODES) {
			for (const gm of available) add(gm, GamemodeDefaultUIStyle.get(gm) ?? Style.NORMAL);
		} else {
			add(mode, style ?? GamemodeDefaultUIStyle.get(mode) ?? Style.NORMAL);
		}
		return out;
	}

	/** Run async workers over items with a concurrency limit. */
	async pool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
		let i = 0;
		const run = async () => {
			while (i < items.length) await worker(items[i++]);
		};
		const runners = [];
		for (let k = 0; k < Math.min(limit, items.length); k++) runners.push(run());
		await Promise.all(runners);
	}

	/** Scan ranks (then percentile) for one mode/style/filter, caching the result and rendering it
	 *  into the live panel only if this scan matches what's currently on screen. */
	async runRankScan(mode: Gamemode, style: Style | null, filter: RankFilter) {
		const gen = rankGen;
		const key = this.rankKey(mode, style, filter);
		if (rankResults[key] && !rankResults[key].pctPending) return; // already done (duplicate enqueue)

		// Renders/progress only apply when this scan is for whatever selection is currently displayed.
		const isCurrent = () =>
			curRankBody != null &&
			curRankBody.IsValid() &&
			this.rankKey(selectedMode as Gamemode, selectedStyle, rankFilter) === key;
		const note = (txt: string) => {
			if (!isCurrent()) return;
			curRankBody!.RemoveAndDeleteChildren();
			$.CreatePanel('Label', curRankBody!, '', { text: txt, style: 'font-size: 12px; color: #8a93a0;' });
		};
		// After this scan updates a cached result, refresh the on-screen panel for whatever's currently
		// shown — the current view derives from these per-(mode,style,filter) results (both/All included).
		const render = () => {
			if (!curRankBody || !curRankBody.IsValid()) return;
			this.renderRankResults(curRankBody, this.resultFor(selectedMode as Gamemode, selectedStyle, rankFilter));
		};
		const superseded = () => {
			if (gen === rankGen) return false;
			delete rankResults[key];
			return true;
		};

		const targets = this.gatherTargetsFor(mode, style, filter);
		$.Msg(`[Stats] runRankScan: ${key} — ${targets.length} completed maps to query`);
		let uid = 0;
		try {
			uid = MomentumAPI.GetLocalUserData().id;
		} catch {
			uid = 0;
		}

		if (!uid || targets.length === 0) {
			rankResults[key] = { ...EMPTY_RANK, targets: targets.length };
			if (isCurrent()) note(targets.length === 0 ? 'No completed maps in this view.' : 'Could not read local user.');
			render();
			return;
		}

		let done = 0;
		let noEntry = 0;
		let errors = 0;
		const ranked: { mapID: number; gm: Gamemode; style: Style; rank: number }[] = [];
		const t0 = Date.now();

		// Phase 1: ranks → WRs / Top 10 / Avg rank.
		if (isCurrent()) note(`Scanning ranks… 0/${targets.length}`);
		await this.pool(targets, 10, async (t) => {
			const res = await this.fetchRank(t.mapID, t.gm, t.style, uid);
			if (!res.ok) errors++;
			else if (res.rank != null) ranked.push({ ...t, rank: res.rank });
			else noEntry++;
			done++;
			if (isCurrent() && (done % 5 === 0 || done === targets.length))
				note(`Scanning ranks… ${done}/${targets.length}`);
		});

		if (superseded()) return;

		const sumRank = ranked.reduce((a, r) => a + r.rank, 0);
		rankResults[key] = {
			wr: ranked.filter((r) => r.rank === 1).length,
			top10: ranked.filter((r) => r.rank <= 10).length,
			avgRank: ranked.length ? Math.round(sumRank / ranked.length) : 0,
			avgPct: null,
			pctPending: ranked.length > 0,
			ranked: ranked.length,
			noEntry, errors,
			targets: targets.length,
			elapsed: (Date.now() - t0) / 1000,
			sumRank,
			sumPct: 0,
			pctCount: 0
		};
		$.Msg(
			`[Stats] runRankScan: ${key} phase 1 done — ranked ${ranked.length}/${targets.length}, ` +
				`WRs ${rankResults[key].wr}, top10 ${rankResults[key].top10}, noEntry ${noEntry}, errors ${errors}`
		);
		render();

		// Phase 2: leaderboard totals → Avg %.
		if (ranked.length > 0) {
			const pcts: number[] = [];
			await this.pool(ranked, 10, async (r) => {
				const total = await this.fetchTotal(r.mapID, r.gm, r.style);
				if (total > 0) pcts.push((r.rank / total) * 100);
			});
			if (superseded()) return;
			const res = rankResults[key];
			res.sumPct = pcts.reduce((a, p) => a + p, 0);
			res.pctCount = pcts.length;
			res.avgPct = pcts.length ? res.sumPct / pcts.length : null;
			res.pctPending = false;
			res.elapsed = (Date.now() - t0) / 1000;
			render();
		}
	}

	/** The rank result for a view, derived from the cached per-(mode,style,filter) scans:
	 *  'both' = ranked + unranked (disjoint sets), 'All' = every gamemode. Nothing is re-queried. */
	resultFor(mode: Gamemode, style: Style | null, filter: RankFilter): RankResult {
		const modes: [Gamemode, Style | null][] =
			mode === ALL_MODES
				? available.map((gm) => [gm, GamemodeDefaultUIStyle.get(gm) ?? Style.NORMAL])
				: [[mode, style]];
		const filters: RankFilter[] = filter === 'both' ? ['ranked', 'unranked'] : [filter];
		const keys: string[] = [];
		for (const [gm, st] of modes) for (const f of filters) keys.push(this.rankKey(gm, st, f));
		return this.aggregateResults(keys);
	}

	/** Sum a set of cached per-filter results into one. Missing keys → still scanning (pctPending). */
	aggregateResults(keys: string[]): RankResult {
		const agg: RankResult = { ...EMPTY_RANK, pctPending: false };
		for (const key of keys) {
			const r = rankResults[key];
			if (!r) {
				agg.pctPending = true; // not scanned yet
				continue;
			}
			agg.wr += r.wr;
			agg.top10 += r.top10;
			agg.ranked += r.ranked;
			agg.noEntry += r.noEntry;
			agg.errors += r.errors;
			agg.targets += r.targets;
			agg.sumRank += r.sumRank;
			agg.sumPct += r.sumPct;
			agg.pctCount += r.pctCount;
			if (r.pctPending) agg.pctPending = true;
		}
		agg.avgRank = agg.ranked ? Math.round(agg.sumRank / agg.ranked) : 0;
		agg.avgPct = agg.pctCount ? agg.sumPct / agg.pctCount : null;
		return agg;
	}

	renderRankResults(body: Panel, r: RankResult) {
		body.RemoveAndDeleteChildren();

		// Nothing counted yet: either still queued/scanning, or genuinely no completed maps.
		if (r.targets === 0) {
			$.CreatePanel('Label', body, '', {
				text: r.pctPending ? 'Waiting to scan…' : 'No completed maps in this view.',
				style: 'font-size: 12px; color: #8a93a0;'
			});
			return;
		}

		const row1 = $.CreatePanel('Panel', body, '', { style: 'flow-children: right; width: 100%;' });
		this.makeTile(row1, 'WRs', `${r.wr}`, '#f2c14e');
		this.makeTile(row1, 'Top 10', `${r.top10}`, C_ACCENT);

		const row2 = $.CreatePanel('Panel', body, '', {
			style: 'flow-children: right; width: 100%; margin-top: 8px;'
		});
		this.makeTile(row2, 'Avg rank', r.ranked ? `${r.avgRank}` : '—', '#e0a86f');
		this.makeTile(
			row2,
			'Avg %',
			r.pctPending ? '…' : r.avgPct != null ? `top ${r.avgPct.toFixed(1)}%` : '—',
			'#9aa3af'
		);

		$.CreatePanel('Label', body, '', {
			text: r.pctPending
				? `stats from ${r.ranked} of ${r.targets} maps · computing %…`
				: `stats from ${r.ranked} of ${r.targets} completed maps · ${r.elapsed.toFixed(1)}s`,
			style: 'font-size: 11px; color: #6f7885; margin-top: 8px; horizontal-align: center;'
		});
		// Break down the maps that produced no rank so the gap is explained, not mysterious.
		const gap: string[] = [];
		if (r.noEntry > 0) gap.push(`${r.noEntry} not on the current board`);
		if (r.errors > 0) gap.push(`${r.errors} request${r.errors === 1 ? '' : 's'} failed`);
		if (gap.length) {
			$.CreatePanel('Label', body, '', {
				text: gap.join(' · '),
				style: `font-size: 11px; color: ${r.errors > 0 ? '#e0a86f' : '#6f7885'}; margin-top: 3px; horizontal-align: center; text-align: center;`
			});
		}
		if (r.ranked === 0 && r.errors > 0) {
			$.CreatePanel('Label', body, '', {
				text: 'All requests failed — the API may be unreachable from the game.',
				style: 'font-size: 11px; color: #e0a86f; margin-top: 4px; horizontal-align: center; text-align: center;'
			});
		}
	}

	//#endregion

	/** Right column: per-tier breakdown (clickable) + expandable scrollable map list. */
	fillRight(card: Panel, s: ModeStat) {
		card.RemoveAndDeleteChildren();

		$.CreatePanel('Label', card, '', {
			text: 'Completion by tier',
			style: 'font-size: 20px; font-weight: bold; color: #ffffff; margin-bottom: 4px;'
		});
		$.CreatePanel('Label', card, '', {
			text: 'Click a tier to list its maps',
			style: 'font-size: 12px; color: #8a93a0; margin-bottom: 14px;'
		});

		const tiers = [...s.tiers.keys()].sort((a, b) => a - b);
		if (tiers.length === 0) {
			$.CreatePanel('Label', card, '', {
				text: 'No tiered maps for this filter.',
				style: 'font-size: 14px; color: #8a93a0;'
			});
			return;
		}

		for (const t of tiers) {
			const ts = s.tiers.get(t)!;
			const on = selectedTier === t;
			const row = $.CreatePanel('Panel', card, `StatsTierRow${t}`, {
				style:
					'flow-children: right; width: 100%; padding: 6px 8px; margin-bottom: 6px; border-radius: 6px; ' +
					`background-color: ${on ? '#1b2530' : '#00000000'}; ` +
					`border-left: 3px solid ${on ? C_ACCENT : '#00000000'};`
			});
			row.SetPanelEvent('onactivate', () => this.selectTier(t));
			row.SetPanelEvent('onmouseover', () =>
				UiToolkitAPI.ShowTextTooltip(row.id, `Show tier ${t} maps`)
			);
			row.SetPanelEvent('onmouseout', () => UiToolkitAPI.HideTextTooltip());

			$.CreatePanel('Label', row, '', {
				text: `Tier ${t}`,
				style: `width: 60px; font-size: 15px; color: ${on ? '#ffffff' : '#cdd5df'}; vertical-align: center;`
			});
			const mid = $.CreatePanel('Panel', row, '', {
				style: 'flow-children: down; width: fill-parent-flow(1); margin: 0 14px; vertical-align: center;'
			});
			this.makeBar(mid, this.frac(ts.completed, ts.total), 10);
			$.CreatePanel('Label', row, '', {
				text: `${ts.completed}/${ts.total}  ·  ${this.pct(ts.completed, ts.total)}%`,
				style: 'width: 120px; font-size: 14px; color: #b8c0cc; text-align: right; vertical-align: center;'
			});
		}

		if (selectedTier != null && s.tiers.has(selectedTier)) {
			this.renderTierMaps(card, selectedTier);
		}
	}

	/** The pop-up box under the tier list: scrollable maps for the selected tier, each with a play button. */
	renderTierMaps(card: Panel, tier: number) {
		const isAll = selectedMode === ALL_MODES;
		const entries = this.mapsInTier(tier);
		const done = entries.filter((e) => e.done).length;

		const box = $.CreatePanel('Panel', card, '', {
			style:
				'flow-children: down; width: 100%; height: fill-parent-flow(1); margin-top: 12px; padding: 12px; ' +
				`background-color: #10141a; border: 1px solid ${C_BORDER}; border-radius: 8px;`
		});

		const head = $.CreatePanel('Panel', box, '', {
			style: 'flow-children: right; width: 100%; margin-bottom: 8px;'
		});
		$.CreatePanel('Label', head, '', {
			text: `Tier ${tier} maps`,
			style: 'font-size: 16px; font-weight: bold; color: #ffffff; vertical-align: center;'
		});
		$.CreatePanel('Panel', head, '', { class: 'w-fill' });
		$.CreatePanel('Label', head, '', {
			text: `${done}/${entries.length} completed`,
			style: `font-size: 13px; color: ${C_ACCENT}; vertical-align: center;`
		});

		const list = $.CreatePanel('Panel', box, '', {
			style: 'flow-children: down; width: 100%; height: fill-parent-flow(1); overflow: squish scroll;'
		});

		for (const e of entries) {
			const row = $.CreatePanel('Panel', list, '', {
				style:
					'flow-children: right; width: 100%; padding: 7px 10px; margin-bottom: 4px; ' +
					'border-radius: 6px; background-color: #171b22;'
			});

			const gm = e.mode;
			$.CreatePanel('Panel', row, '', {
				style:
					`width: 10px; height: 10px; border-radius: 5px; margin-right: 10px; vertical-align: center; ` +
					`background-color: ${e.done ? '#5bd6a0' : '#4a5462'};`
			});
			$.CreatePanel('Label', row, '', {
				text: e.name,
				style: `width: fill-parent-flow(1); font-size: 14px; color: ${e.done ? '#dfe5ec' : '#aeb6c2'}; vertical-align: center; text-overflow: ellipsis;`
			});
			// In the "All" view, show which gamemode each map belongs to.
			if (isAll) {
				$.CreatePanel('Label', row, '', {
					text: $.Localize(GamemodeInfo.get(gm)?.i18n ?? '') || `Mode ${gm}`,
					style: 'width: 120px; font-size: 12px; color: #7d8794; text-align: right; vertical-align: center; margin-right: 10px;'
				});
			}

			const mapID = e.data.staticData.id;
			const play = $.CreatePanel('Panel', row, `StatsPlay${mapID}_${gm}`, {
				style:
					'width: 34px; height: 28px; border-radius: 6px; vertical-align: center; border: 1px solid #3a4656;'
			});
			const icon = $.CreatePanel('Image', play, '', {
				style: 'width: 16px; height: 16px; horizontal-align: center; vertical-align: center;'
			});
			play.SetPanelEvent('onmouseout', () => UiToolkitAPI.HideTextTooltip());
			// Same click handler for both states: handlePlayMap launches when the file exists,
			// otherwise it starts the download (possibly via a confirm popup) — then we poll to flip.
			play.SetPanelEvent('onactivate', () => {
				handlePlayMap(e.data, gm);
				if (!e.data.mapFileExists) this.pollDownload(mapID, play, icon, e, gm);
			});
			this.applyActionState(play, icon, e.data.mapFileExists);

			// If this map is already downloading (e.g. tier re-opened mid-download), re-attach the poller.
			try {
				if (!e.data.mapFileExists && MapCacheAPI.MapQueuedForDownload(mapID))
					this.pollDownload(mapID, play, icon, e, gm);
			} catch {}
		}
	}

	/** Style a map row's action button as Play (downloaded) or Download (not yet). */
	applyActionState(play: Panel, icon: Panel, downloaded: boolean) {
		try {
			play.style.backgroundColor = downloaded ? '#1d3b30' : '#22303f';
		} catch {}
		(icon as ImagePanel).SetImage(`file://{images}/${downloaded ? 'play' : 'download'}.svg`);
		play.ClearPanelEvent('onmouseover');
		play.SetPanelEvent('onmouseover', () =>
			UiToolkitAPI.ShowTextTooltip(
				play.id,
				$.Localize(downloaded ? '#Action_StartMap' : '#Action_DownloadMap')
			)
		);
	}

	/** Poll a map's cache entry after a download starts; flip its button to Play once the file lands. */
	pollDownload(mapID: number, play: Panel, icon: Panel, e: { data: MapCacheAPI.MapData }, gm: Gamemode) {
		if (!play.IsValid() || play.GetAttributeInt('polling', 0) === 1) return;
		play.SetAttributeInt('polling', 1);

		let ticks = 0;
		let missed = 0; // consecutive ticks where the map is not queued
		let sawQueued = false;

		const stop = () => {
			if (play.IsValid()) play.SetAttributeInt('polling', 0);
		};

		const tick = () => {
			if (!play.IsValid()) return; // button (or page) gone; drop the poll silently

			let exists = false;
			try {
				exists = !!MapCacheAPI.GetMapData(mapID)?.mapFileExists;
			} catch {}

			if (exists) {
				e.data.mapFileExists = true; // update the shared scan-cache entry
				this.applyActionState(play, icon, true);
				stop();
				return;
			}

			let queued = false;
			try {
				queued = MapCacheAPI.MapQueuedForDownload(mapID);
			} catch {}
			if (queued) {
				sawQueued = true;
				missed = 0;
			} else {
				missed++;
			}

			ticks++;
			// Give up if: never started (popup dismissed), stopped being queued without completing, or a hard cap.
			if (ticks > 600 || (sawQueued && missed > 5) || (!sawQueued && missed > 30)) {
				stop();
				return;
			}

			$.Schedule(1, tick);
		};

		$.Schedule(1, tick);
	}

	/** Maps in the selected tier (one mode, or all modes in the "All" view), incomplete first then alphabetical. */
	mapsInTier(tier: number): { data: MapCacheAPI.MapData; name: string; done: boolean; mode: Gamemode }[] {
		const maps = scanCache ?? [];
		const isAll = selectedMode === ALL_MODES;
		const modes = isAll ? available : [selectedMode as Gamemode];
		const out: { data: MapCacheAPI.MapData; name: string; done: boolean; mode: Gamemode }[] = [];

		for (const gm of modes) {
			const style = isAll
				? (GamemodeDefaultUIStyle.get(gm) ?? Style.NORMAL)
				: (selectedStyle ?? GamemodeDefaultUIStyle.get(gm) ?? Style.NORMAL);

			for (const data of maps) {
				if (data.staticData.status !== MapStatus.APPROVED) continue; // exclude beta/testing/submission maps

				const lb = getTrack(data.staticData, gm, TrackType.MAIN, 1, style);
				if (!lb || lb.tier !== tier) continue;

				const isRanked = lb.type === LeaderboardType.RANKED;
				const isUnranked = lb.type === LeaderboardType.UNRANKED;
				if (!isRanked && !isUnranked) continue;
				if (rankFilter === 'ranked' && !isRanked) continue;
				if (rankFilter === 'unranked' && !isUnranked) continue;

				const done = this.isDone(data.userData, gm, style);
				out.push({ data, name: data.staticData.name, done, mode: gm });
			}
		}

		out.sort((a, b) => (a.done !== b.done ? (a.done ? 1 : -1) : a.name.localeCompare(b.name)));
		return out;
	}

	/** Segmented circular gauge (donut) drawn from rotated tick panels. */
	renderRing(parent: Panel, frac: number, centerText: string) {
		const D = 172;
		const N = 44;
		const active = Math.round(frac * N);

		const ring = $.CreatePanel('Panel', parent, '', {
			style: `width: ${D}px; height: ${D}px; horizontal-align: center; margin-bottom: 16px;`
		});

		for (let i = 0; i < N; i++) {
			const angle = i * (360 / N);
			const tick = $.CreatePanel('Panel', ring, '', {
				style: `width: ${D}px; height: ${D}px; transform-origin: 50% 50%; transform: rotateZ(${angle}deg);`
			});
			$.CreatePanel('Panel', tick, '', {
				style:
					`width: 5px; height: 18px; horizontal-align: center; vertical-align: top; margin-top: 3px; ` +
					`border-radius: 3px; background-color: ${i < active ? C_ACCENT : C_TRACK};`
			});
		}

		// Donut hole with the headline number (created last => drawn on top).
		const hole = $.CreatePanel('Panel', ring, '', {
			style:
				'width: 120px; height: 120px; horizontal-align: center; vertical-align: center; ' +
				'border-radius: 60px; background-color: #10141a;'
		});
		// Inner wrapper is centered both ways inside the (non-flowing) hole; it stacks the two labels.
		const inner = $.CreatePanel('Panel', hole, '', {
			style: 'flow-children: down; width: 100%; horizontal-align: center; vertical-align: center;'
		});
		$.CreatePanel('Label', inner, '', {
			text: centerText,
			style: `font-size: 34px; font-weight: bold; color: ${C_ACCENT}; horizontal-align: center;`
		});
		$.CreatePanel('Label', inner, '', {
			text: 'COMPLETE',
			style: 'font-size: 10px; letter-spacing: 2px; color: #7d8794; horizontal-align: center;'
		});
	}

	makeBar(parent: Panel, frac: number, h: number) {
		const track = $.CreatePanel('Panel', parent, '', {
			style: `width: 100%; height: ${h}px; border-radius: ${h / 2}px; background-color: ${C_TRACK};`
		});
		$.CreatePanel('Panel', track, '', {
			style: `width: ${Math.round(frac * 100)}%; height: 100%; border-radius: ${h / 2}px; background-color: ${C_ACCENT};`
		});
	}

	makeTile(parent: Panel, label: string, value: string, color: string) {
		const tile = $.CreatePanel('Panel', parent, '', {
			style:
				'flow-children: down; width: fill-parent-flow(1); margin-right: 8px; padding: 10px; ' +
				`background-color: #10141a; border-radius: 8px;`
		});
		$.CreatePanel('Label', tile, '', {
			text: value,
			style: `font-size: 20px; font-weight: bold; color: ${color}; horizontal-align: center;`
		});
		$.CreatePanel('Label', tile, '', {
			text: label,
			style: 'font-size: 11px; color: #8a93a0; horizontal-align: center; margin-top: 2px;'
		});
	}

	//#endregion

	/**
	 * Whether the user has completed a map's main track for this mode.
	 * The game records completion at style 0 (map-selector/map-entry read it there for every mode,
	 * climb included), so we check style 0 first, then the selected style as a fallback.
	 */
	isDone(userData: MapCacheAPI.UserData | undefined, gm: Gamemode, style: Style): boolean {
		if (!userData) return false;
		// Completion is keyed by the run style (mom_style). Pro/Teleport are climb *leaderboard*
		// classifications, not run styles, so those runs are stored at style 0. Every other style is a
		// real run style stored under its own key — so a Normal run never counts as Sideways/W-only/etc.
		const trackStyle = style === Style.PRO || style === Style.TELEPORT ? 0 : style;
		return !!getUserMapDataTrack(userData, gm, TrackType.MAIN, 1, trackStyle)?.completed;
	}

	frac(completed: number, total: number): number {
		return total > 0 ? completed / total : 0;
	}

	pct(completed: number, total: number): number {
		return total > 0 ? Math.round((1000 * completed) / total) / 10 : 0;
	}
}
