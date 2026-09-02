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

// Remote-user view: when set, completion + rank stats are for another player fetched live from the API
// (same data model as the website), instead of the local player read from the local map cache.
interface ViewUser {
	id: number;
	alias: string;
	steamID?: string;
}
let viewUser: ViewUser | null = null; // null = the local player
let remoteDone: Set<string> | null = null; // completed leaderboard keys "mapID|gm|tt|tn|style" for viewUser
let userBusy = false; // a user lookup / PB fetch is in progress
let userGen = 0; // bumped on each lookup so a stale in-flight fetch (or reset) aborts

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
	// Count of ranked maps whose *best* group is G1..G6 (index 0 = G1 … 5 = G6). Exclusive: each map
	// lands in exactly one group (or none, if worse than G6). Filled during phase 2 (needs board totals).
	groups: number[];
}
const EMPTY_RANK: RankResult = {
	wr: 0, top10: 0, avgRank: 0, avgPct: null, pctPending: false,
	ranked: 0, noEntry: 0, errors: 0, targets: 0, elapsed: 0, sumRank: 0, sumPct: 0, pctCount: 0,
	groups: [0, 0, 0, 0, 0, 0]
};

// Ranking ladder, best → worst: WR (rank 1) → Top 10 (ranks 2–10) → G1 … G6 → No group. WR and Top 10 are
// their own tiers ABOVE the numeric groups: since every G1 threshold is ≥ 20, a rank ≤ 10 would otherwise
// always land in G1, so those maps are pulled out and marked WR / Top 10 instead (per-map and in the strip).
// A map's group (rank > 10) comes from your rank `r` on its board of size `N`: you qualify for group i if
// `r <= max(N * pct + 10, floor)`. The floor keeps small boards fair. Thresholds nest (G1 tightest), so the
// first that qualifies, scanning G1→G6, is your best group.
const GROUP_DEFS: { pct: number; floor: number }[] = [
	{ pct: 0.02, floor: 20 }, // G1 = max(top 2% + 10, top 20)
	{ pct: 0.04, floor: 35 }, // G2 = max(top 4% + 10, top 35)
	{ pct: 0.08, floor: 60 }, // G3 = max(top 8% + 10, top 60)
	{ pct: 0.16, floor: 100 }, // G4 = max(top 16% + 10, top 100)
	{ pct: 0.33, floor: 150 }, // G5 = max(top 33% + 10, top 150)
	{ pct: 0.66, floor: 225 } // G6 = max(top 66% + 10, top 225)
];
// WR = gold, Top 10 = teal (matching the tiles above); G1 → G6 a warm-to-cool gradient below them.
const RANK_WR_COLOR = '#f2c14e';
const RANK_T10_COLOR = '#6fe0d0';
const GROUP_COLORS = ['#d8c26a', '#e0a86f', '#8fd694', '#7fb0e0', '#9aa3af', '#6f7885'];
let rankResults: Record<string, RankResult> = {};
let rankBusy = false;
let rankGen = 0; // bumped on rescan; a running scan aborts if it no longer matches
// The background rank scan hammers the shared game HTTP client, which also serves map downloads — so while
// a scan is running, clicking a map's play/download button couldn't get an HTTP slot until the scan drained.
// A user action (launch/download a map) sets this timestamp; every rank-scan request holds off until then,
// freeing the HTTP client so the map launches/downloads immediately. Refreshed for the duration of a download.
let rankPausedUntil = 0; // ms epoch; while Date.now() < this, no new rank-scan web requests fire
// The rank body panel for the selection currently shown, so a running scan can render into it if it
// matches, and a background scan of other modes renders nowhere.
let curRankBody: Panel | null = null;
// Queue of (mode,style,filter) to scan — the current selection is pushed to the front, all gamemodes
// behind it, so everything fills in ASAP while prioritising what's on screen.
let rankQueue: { mode: Gamemode; style: Style | null; filter: RankFilter }[] = [];

// Per-map rank detail, keyed `mapID|gm|style`, filled as the rank scans run so the tier map list can show
// each map's placement without extra API calls. Cleared with the rank cache (rescan / viewed-user change).
interface PerMapRank {
	rank: number | null; // your placement on the board (null = you're not on the current board)
	time: number | null; // your run time, seconds
	total: number | null; // board size (from phase 2 — needed for the group)
	wrTime: number | null; // rank-1 time, seconds (from the same phase-2 call → WR diff, no extra request)
}
let perMapRank: Record<string, PerMapRank> = {};

// --- Persistent rank cache (see PANORAMA_NOTES §6i) -------------------------------------------------
// The expensive part of the page isn't the local map-cache scan (no HTTP, fast) — it's the web rank
// scan (1–2 API requests per completed map across every gamemode). So the *derived* rank numbers
// (`perMapRank`) are persisted to `$.persistentStorage` keyed by the *viewed* user's id, letting a
// re-open render the ladder / avg-rank / per-map cells instantly with zero network. The per-(mode,
// style,filter) `rankResults` aggregates are NOT stored — they're re-derived from `perMapRank` on load
// (`recomputeRankResult`), so `perMapRank` is the single source of truth. Only the local completion set
// (local map cache) and remote PBs (fetched on search) supply the target list, both already available.
const STATS_CACHE_VERSION = 1; // bump to invalidate old caches when the PerMapRank shape changes
const STATS_CACHE_PREFIX = 'stats.cache.'; // + viewed user id
interface StatsCache {
	v: number;
	ts: number; // ms epoch of the last FULL scan (drives the "Updated Xm ago" line)
	ranks: Record<string, PerMapRank>;
}
// Freshness of the currently-shown user's cache (0 = never fully scanned this view). Set by a full scan
// or by loading a cache; NOT bumped by the cheap incremental refresh or popup write-back (those only
// patch individual maps — the bulk of the ranks stays as old as the last full scan, so the label is honest).
let dataTimestamp = 0;
// A full scan (first-ever open for a user, or an explicit Rescan) is in progress — its drain sets the
// timestamp and persists. A cached re-open leaves this false, so its no-op queue drain persists nothing.
let scanIsFull = false;
// Set by rescan() so buildAll() forces a fresh full scan instead of loading the (now stale) cache.
let forceFullScan = false;
// PB times of the searched remote user, keyed `mapID|gm|style` (MAIN/1 only), captured while fetching
// their runs — lets the incremental refresh detect which of their maps changed (local users read this
// from the local map cache instead, no fetch). Reset on each new search.
let remotePbTimes: Record<string, number> = {};
// A PB whose time moved by more than this (seconds) is treated as changed by the incremental refresh.
// Generous so tiny float differences between the local-cache time and the API time don't requery the
// whole set every open (which would defeat the cache); genuine rank-moving improvements are far larger,
// and a full Rescan is the source of truth regardless.
const PB_EPS = 0.05;

// Leaderboard popup (opened by clicking a map name). Fetched on click and cached for the session so
// re-opening is instant. The completion count comes from the LOCAL map cache (no HTTP) and the rank scan
// only pulled `take=1` (WR) + your own rank — neither has the full board — so these are on-demand: one
// `take=10` call for the top 10, plus one `skip=cutoff&take=1` call per group cutoff (the last person in
// each group G1..G6). Cutoff RANKS are computed from the board size with the same thresholds as `bestGroup`,
// so only that one row per group is fetched. The board is player-independent, so it survives a viewed-user
// change; cleared only on rescan.
interface Top10Row {
	rank: number;
	time: number; // seconds
	userID: number;
	alias: string;
	steamID: string | null; // steamID64 → AvatarImage (Steam client provides the avatar, no web call)
	downloadURL: string | null; // the run's replay (.mrec) URL — captured for a future watch path (see showRunContextMenu; not usable in-game yet)
}
interface GroupCutoff {
	group: number; // 1..6
	rank: number; // the last (worst) rank still in this group, on this board
	row: Top10Row | null; // that person's run (null until fetched, or if the fetch failed)
	fetched: boolean;
}
interface MapLb {
	rows: Top10Row[]; // top 10
	total: number; // board size (totalCount)
	cutoffs: GroupCutoff[]; // one per non-empty group, worst-rank ascending
}
let mapLbCache: Record<string, MapLb> = {};
// The viewed user's own standing on a board (rank + PB time), for the "vs You" column and the "where you'd
// place" row in the cutoffs. Keyed `perMapKey|uid` (player-dependent, unlike mapLbCache), so switching users
// just uses a different key. Free from `perMapRank` when the rank scan has it; otherwise one `userIDs=` call.
// {rank:null,time:null} = you're not on that board. Cleared on rescan.
interface Standing {
	rank: number | null;
	time: number | null; // seconds
}
let yourStandingCache: Record<string, Standing> = {};
// Live refs to the cutoff rows currently shown, so each cutoff fetch fills its row in place (no re-render).
let lbCutoffRefs: { rank: number; panel: Panel }[] = [];

// Shared column widths so the top-10 rows and the cutoff rows line up (badge · rank · avatar · player · time · +WR · vs You).
const LB_W_BADGE = 56; // WR / T10 / G1..G6
const LB_W_RANK = 48;
const LB_W_AV = 40; // avatar (26) + its right margin (14)
const LB_W_TIME = 104;
const LB_W_DIFF = 88; // +WR diff
const LB_W_YOU = 88; // signed diff vs the viewed user's own time
// Base row layout — set at creation (flow/layout props aren't reliably settable via .style at runtime);
// fillLbRow only toggles backgroundColor (which is) for the "your row" highlight.
const LB_ROW_STYLE =
	'flow-children: right; width: 100%; padding: 6px 10px; margin-bottom: 3px; border-radius: 6px; background-color: #171b22;';

// Live refs to each shown tier-map row's rank-info cell, so a scan can fill it in place after the fact.
let tierRankRows: { key: string; panel: Panel }[] = [];
// Persistent tier rows + the map-list holder, so clicking a tier only restyles/refills — it never recreates
// the row under the cursor (which made its hover tooltip flash at the press point for one frame).
let tierBtns: { tier: number; row: Panel; label: Panel }[] = [];
let tierMapHolder: Panel | null = null;

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
	// Bumped on each top-10 popup open, so a slow in-flight fetch that resolves after the popup was closed
	// (or a different map was opened) is discarded instead of filling the wrong board.
	lbGen = 0;

	// The map currently shown in the leaderboard popup, so its Refresh button can re-fetch just that board.
	lbMapID: number | null = null;
	lbGm: Gamemode = ALL_MODES;
	lbStyle: Style = Style.NORMAL;
	lbMapName = '';

	constructor() {
		// The page may be pre-created (hidden) before the map cache is ready, in which case its
		// initial scan finds nothing. Re-scan when the page is actually shown if we have no maps yet.
		$.RegisterForUnhandledEvent('MainMenuPageShown', (page: string) => {
			if (page === 'Stats' && !scanCache && !scanning) {
				$.Msg('[Stats] MainMenuPageShown(Stats): no cache yet, kicking a scan');
				this.scan();
			}
		});
		// Leaving the page (incl. Esc, which closes the whole page) must collapse the popup, otherwise its
		// visibility would persist and it'd reappear over the page the next time Stats opens.
		$.RegisterForUnhandledEvent('MainMenuPageHidden', () => this.closeMapLeaderboard());
	}

	// Called from the page root's onload (fires once the page is actually shown, unlike the
	// PanelLoaded/onPanelLoad hook which runs too early and stalled the chunked scan).
	onLoad() {
		$.Msg(`[Stats] onLoad: scanCache=${scanCache ? scanCache.length + ' maps' : 'none'}, scanning=${scanning}`);
		this.updatePreloadLabel();
		if (scanCache) this.buildAll();
		else if (!scanning) this.scan();
	}

	rescan() {
		scanCache = null;
		mapLbCache = {}; // boards may have changed — drop the cached top-10s / cutoffs so they refetch
		yourStandingCache = {}; // and the cached "vs You" standings
		forceFullScan = true; // the whole point of Rescan: the accurate-but-expensive path, not the cache
		this.scan();
	}

	//#region preload toggle

	/** Whether the main menu should pre-warm this page on load (persisted, off by default). */
	preloadEnabled(): boolean {
		return !!$.persistentStorage.getItem<boolean>('stats.preloadEnabled');
	}

	togglePreload() {
		const next = !this.preloadEnabled();
		$.persistentStorage.setItem('stats.preloadEnabled', next);
		$.Msg(`[Stats] togglePreload: preload ${next ? 'ENABLED' : 'disabled'} (applies on next main-menu load)`);
		this.updatePreloadLabel();
	}

	updatePreloadLabel() {
		const on = this.preloadEnabled();
		const lbl = $<Label>('#StatsPreloadLabel');
		if (lbl) lbl.text = on ? 'Preload: On' : 'Preload: Off';
		const btn = $<Panel>('#StatsPreloadToggle');
		if (btn) {
			try {
				btn.style.backgroundColor = on ? '#1c2b30' : '#232a33';
			} catch {}
		}
	}

	//#endregion

	//#region view another player

	/** The leaderboard key used both for a remote user's completed runs and for map lookups. */
	doneKey(mapID: number, gm: Gamemode, tt: TrackType, tn: number, style: Style): string {
		return `${mapID}|${gm}|${tt}|${tn}|${style}`;
	}

	/** The user id whose stats are currently shown: the searched remote user, else the local player. */
	viewUid(): number {
		if (viewUser) return viewUser.id;
		try {
			return MomentumAPI.GetLocalUserData().id;
		} catch {
			return 0;
		}
	}

	/** Small status/indicator line next to the player search box. */
	setUserStatus(text: string, isError = false) {
		const el = $<Label>('#StatsUserStatus');
		if (!el) return;
		el.text = text;
		try {
			el.style.color = isError ? '#e0736f' : '#8a93a0';
		} catch {}
	}

	/** Reflect who's being viewed (local player vs a searched user) in the status line. */
	updateViewLabel() {
		if (viewUser) this.setUserStatus(`Viewing ${viewUser.alias} · ${remoteDone?.size ?? 0} PBs`);
		else this.setUserStatus('');
	}

	/** Button / Enter handler: look up whatever is typed in the search box. */
	searchUser() {
		const entry = $<TextEntry>('#StatsUserSearch');
		const q = (entry?.text ?? '').trim();
		if (!q) {
			this.resetUser(); // empty search = back to the local player
			return;
		}
		void this.doSearch(q);
	}

	/** Resolve the query to a user, fetch their PBs, then re-render everything for them. */
	async doSearch(q: string) {
		if (userBusy) return;
		userBusy = true;
		const gen = ++userGen; // supersede any older lookup still running
		$.Msg(`[Stats] searchUser: looking up "${q}"`);
		this.setUserStatus(`Finding "${q}"…`);
		try {
			const user = await this.resolveUser(q);
			if (gen !== userGen) return; // a newer search / reset happened
			if (!user) {
				this.setUserStatus(`No user matching "${q}".`, true);
				return;
			}
			this.setUserStatus(`Loading ${user.alias}'s runs…`);
			const done = await this.fetchUserDone(user.id, gen);
			if (gen !== userGen) return;
			viewUser = user;
			remoteDone = done;
			$.Msg(`[Stats] searchUser: ${user.alias} (id ${user.id}) → ${done.size} completed leaderboards`);
			this.applyUserChange();
		} catch (e) {
			if (gen === userGen) this.setUserStatus(`Lookup failed: ${String(e)}`, true);
			$.Msg(`[Stats] searchUser: failed — ${String(e)}`);
		} finally {
			if (gen === userGen) userBusy = false;
		}
	}

	/** Reset the view back to the local player (also used when the search box is cleared). */
	resetUser() {
		if (!viewUser && !userBusy) return; // already local
		userGen++; // abort any in-flight lookup
		userBusy = false;
		viewUser = null;
		remoteDone = null;
		const entry = $<TextEntry>('#StatsUserSearch');
		if (entry) entry.text = '';
		$.Msg('[Stats] resetUser: back to local player');
		this.applyUserChange();
	}

	/** Re-render completion + restart the (per-user) rank scans after the viewed user changes. */
	applyUserChange() {
		rankQueue = [];
		rankGen++; // supersede any in-flight rank scan
		selectedTier = null; // a different user's tier set / expansion no longer applies
		// Load the newly-viewed user's own persisted rank cache (loadCacheForView resets perMapRank /
		// rankResults / dataTimestamp for us). Each user keys its own entry, so switching users never
		// clobbers another's cached ranks.
		const hadCache = this.loadCacheForView();
		scanIsFull = !hadCache;
		this.updateViewLabel();
		this.renderContent(); // recomputes completion from the new user
		this.enqueueAllModes(); // refetch (no-ops cached-complete keys) for the new user
		if (hadCache) this.startIncrementalRefresh(); // catch their new/changed PBs cheaply
	}

	//#region persistent rank cache (§6i)

	statsCacheKey(uid: number): string {
		return `${STATS_CACHE_PREFIX}${uid}`;
	}

	/** Persist the current perMapRank + timestamp under the viewed user's key. Called when a full scan
	 *  finishes, when the incremental refresh patches maps, and when the popup fetches a board. */
	saveRankCache() {
		const uid = this.viewUid();
		if (!uid) return; // can't key it
		const payload: StatsCache = { v: STATS_CACHE_VERSION, ts: dataTimestamp, ranks: perMapRank };
		try {
			$.persistentStorage.setItem(this.statsCacheKey(uid), payload);
		} catch (e) {
			$.Msg(`[Stats] saveRankCache failed: ${String(e)}`);
		}
	}

	/** Read a user's persisted cache, or null (absent / wrong version / unreadable). */
	loadRankCache(uid: number): StatsCache | null {
		if (!uid) return null;
		let raw: StatsCache | null = null;
		try {
			raw = $.persistentStorage.getItem<StatsCache>(this.statsCacheKey(uid));
		} catch (e) {
			$.Msg(`[Stats] loadRankCache failed: ${String(e)}`);
			return null;
		}
		if (!raw || raw.v !== STATS_CACHE_VERSION || !raw.ranks) return null;
		return raw;
	}

	/** Load the currently-viewed user's cache into perMapRank + rankResults. Always resets the in-memory
	 *  rank state first (so a miss leaves it clean for a fresh scan). Returns true if a cache was loaded. */
	loadCacheForView(): boolean {
		perMapRank = {};
		rankResults = {};
		dataTimestamp = 0;
		const cached = this.loadRankCache(this.viewUid());
		if (!cached) return false;
		perMapRank = cached.ranks;
		dataTimestamp = cached.ts || 0;
		this.recomputeTrackedRankResults();
		$.Msg(`[Stats] loadCacheForView: ${Object.keys(perMapRank).length} cached maps, ts=${dataTimestamp}`);
		return true;
	}

	/** Rebuild the rankResults aggregates from perMapRank for every mode's default style (+ the current
	 *  selection's style) — the set enqueueAllModes scans — so a cached open shows numbers without network. */
	recomputeTrackedRankResults() {
		for (const gm of available) {
			const st = GamemodeDefaultUIStyle.get(gm) ?? Style.NORMAL;
			rankResults[this.rankKey(gm, st, 'ranked')] = this.recomputeRankResult(gm, st, 'ranked');
			rankResults[this.rankKey(gm, st, 'unranked')] = this.recomputeRankResult(gm, st, 'unranked');
		}
		if (selectedMode != null && selectedMode !== ALL_MODES) {
			const st = selectedStyle ?? GamemodeDefaultUIStyle.get(selectedMode) ?? Style.NORMAL;
			for (const f of ['ranked', 'unranked'] as RankFilter[]) {
				const k = this.rankKey(selectedMode, st, f);
				if (!rankResults[k]) rankResults[k] = this.recomputeRankResult(selectedMode, st, f);
			}
		}
	}

	/** Derive one (mode,style,filter) RankResult purely from perMapRank — the same aggregation the live
	 *  scan builds, so cached numbers match a fresh scan. A completed map absent from perMapRank counts as
	 *  an error (it never got a successful response); a ranked map still missing its board total leaves the
	 *  result pctPending (so enqueueRank re-scans it). */
	recomputeRankResult(mode: Gamemode, style: Style | null, filter: RankFilter): RankResult {
		const targets = this.gatherTargetsFor(mode, style, filter);
		let wr = 0, top10 = 0, ranked = 0, noEntry = 0, errors = 0, sumRank = 0, sumPct = 0, pctCount = 0;
		const groups = [0, 0, 0, 0, 0, 0];
		let pending = false;
		for (const t of targets) {
			const pm = perMapRank[this.perMapKey(t.mapID, t.gm, t.style)];
			if (!pm) {
				errors++; // completed but no cached response — a scan gap the incremental refresh fills
				continue;
			}
			if (pm.rank == null) {
				noEntry++;
				continue;
			}
			ranked++;
			sumRank += pm.rank;
			if (pm.rank === 1) wr++;
			if (pm.rank <= 10) top10++;
			if (pm.total != null && pm.total > 0) {
				sumPct += (pm.rank / pm.total) * 100;
				pctCount++;
				if (pm.rank > 10) {
					const g = this.bestGroup(pm.rank, pm.total);
					if (g >= 1) groups[g - 1]++;
				}
			} else {
				pending = true; // ranked but no total yet → phase-2 equivalent unfinished
			}
		}
		return {
			wr,
			top10,
			avgRank: ranked ? Math.round(sumRank / ranked) : 0,
			avgPct: pctCount ? sumPct / pctCount : null,
			pctPending: ranked > 0 && pending,
			ranked,
			noEntry,
			errors,
			targets: targets.length,
			elapsed: 0,
			sumRank,
			sumPct,
			pctCount,
			groups
		};
	}

	/** "just now" / "5m ago" / "3h ago" / "2d ago" for a ms-epoch timestamp. */
	agoText(ts: number): string {
		const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
		if (s < 45) return 'just now';
		const m = Math.floor(s / 60);
		if (m < 60) return `${m}m ago`;
		const h = Math.floor(m / 60);
		if (h < 24) return `${h}h ago`;
		return `${Math.floor(h / 24)}d ago`;
	}

	//#endregion

	//#region incremental refresh (§6i)

	/** The viewed user's current PB time on a map's (gm, MAIN, style) board, or null if unknown. Local: from
	 *  the local map cache (Pro/Teleport map to run-style 0, like isDone). Remote: from the PBs fetched on search. */
	currentPbTime(map: MapCacheAPI.MapData, gm: Gamemode, style: Style): number | null {
		if (viewUser) {
			const t = remotePbTimes[this.perMapKey(map.staticData.id, gm, style)];
			return t == null ? null : t;
		}
		const userData = map.userData;
		if (!userData) return null;
		const trackStyle = style === Style.PRO || style === Style.TELEPORT ? 0 : style;
		const tr = getUserMapDataTrack(userData, gm, TrackType.MAIN, 1, trackStyle);
		return tr?.completed ? (tr.time ?? null) : null;
	}

	/** Completed maps to re-check on an incremental refresh, deduped by perMapKey, across every mode's
	 *  default style plus the current selection's style (the set that has cached ranks). */
	gatherIncrementalTargets(): { map: MapCacheAPI.MapData; gm: Gamemode; style: Style; pbTime: number | null }[] {
		const maps = scanCache ?? [];
		const combos: [Gamemode, Style][] = [];
		for (const gm of available) combos.push([gm, GamemodeDefaultUIStyle.get(gm) ?? Style.NORMAL]);
		if (selectedMode != null && selectedMode !== ALL_MODES)
			combos.push([selectedMode, selectedStyle ?? GamemodeDefaultUIStyle.get(selectedMode) ?? Style.NORMAL]);

		const seen = new Set<string>();
		const out: { map: MapCacheAPI.MapData; gm: Gamemode; style: Style; pbTime: number | null }[] = [];
		for (const [gm, style] of combos) {
			for (const map of maps) {
				const { staticData } = map;
				if (staticData.status !== MapStatus.APPROVED) continue;
				const lb = getTrack(staticData, gm, TrackType.MAIN, 1, style);
				if (!lb || !lb.tier) continue;
				if (lb.type !== LeaderboardType.RANKED && lb.type !== LeaderboardType.UNRANKED) continue;
				if (!this.isDone(map, gm, style)) continue;
				const key = this.perMapKey(staticData.id, gm, style);
				if (seen.has(key)) continue;
				seen.add(key);
				out.push({ map, gm, style, pbTime: this.currentPbTime(map, gm, style) });
			}
		}
		return out;
	}

	/** Cheap auto-refresh on a cached open: re-query only the maps whose rank data is stale — newly
	 *  completed (absent from perMapRank), previously not-on-board, or whose PB time moved. Caveat: this
	 *  catches YOUR changes, not other players beating you on maps your PB didn't move — a full Rescan is
	 *  the truth (see §6i). Does NOT bump dataTimestamp: only the changed maps are fresh, the rest stays as
	 *  old as the last full scan. */
	async startIncrementalRefresh() {
		const gen = rankGen; // aborts if the user switches / a rescan happens
		const uid = this.viewUid();
		if (!uid || !scanCache) return;

		const targets = this.gatherIncrementalTargets();
		const changed = targets.filter((t) => {
			const pm = perMapRank[this.perMapKey(t.map.staticData.id, t.gm, t.style)];
			if (!pm) return true; // never scanned (new completion / prior error)
			if (pm.rank == null) return true; // was not on the board — recheck (board may have re-versioned)
			return t.pbTime != null && pm.time != null && Math.abs(t.pbTime - pm.time) > PB_EPS; // PB moved
		});
		if (!changed.length) {
			$.Msg('[Stats] incremental refresh: nothing changed');
			return;
		}
		$.Msg(`[Stats] incremental refresh: re-querying ${changed.length}/${targets.length} changed maps`);

		await this.pool(changed, 10, async (t) => {
			if (gen !== rankGen) return;
			const res = await this.fetchRank(t.map.staticData.id, t.gm, t.style, uid);
			if (gen !== rankGen || !res.ok) return; // superseded / failed — leave the cached value
			const key = this.perMapKey(t.map.staticData.id, t.gm, t.style);
			if (res.rank != null) {
				const { total, wrTime } = await this.fetchTotal(t.map.staticData.id, t.gm, t.style);
				if (gen !== rankGen) return;
				perMapRank[key] = { rank: res.rank, time: res.time, total: total > 0 ? total : null, wrTime };
			} else {
				perMapRank[key] = { rank: null, time: null, total: null, wrTime: null };
			}
			this.updateTierRankRow(key);
		});
		if (gen !== rankGen) return;

		this.recomputeTrackedRankResults();
		if (curRankBody && curRankBody.IsValid())
			this.renderRankResults(curRankBody, this.resultFor(selectedMode as Gamemode, selectedStyle, rankFilter));
		this.saveRankCache(); // keeps the existing (full-scan) timestamp — only the changed maps are fresh
	}

	//#endregion

	/** Resolve a search string (numeric id / SteamID64 / steam profile URL / alias) to a Momentum user. */
	async resolveUser(q: string): Promise<ViewUser | null> {
		q = q.trim();
		const urlMatch = q.match(/steamcommunity\.com\/profiles\/(\d+)/);
		if (urlMatch) q = urlMatch[1];

		let user: any = null;
		if (/^\d+$/.test(q)) {
			if (q.length >= 15) {
				// SteamID64 → Momentum user
				const j = await this.fetchJson(`${API}/v1/users?steamID=${q}&take=1`, 4);
				user = j?.data?.[0] ?? null;
			} else {
				// Momentum user id
				user = await this.fetchJson(`${API}/v1/users/${q}`, 4);
			}
		} else {
			// Alias search — prefer an exact (case-insensitive) alias match, else the first result.
			const j = await this.fetchJson(`${API}/v1/users?search=${encodeURIComponent(q)}&take=20`, 4);
			const c: any[] = j?.data ?? [];
			user = c.find((u) => (u.alias ?? '').toLowerCase() === q.toLowerCase()) ?? c[0] ?? null;
		}

		if (!user || user.id == null) return null;
		return { id: user.id, alias: user.alias ?? `User ${user.id}`, steamID: user.steamID };
	}

	/** Fetch every PB run for a user and build the set of completed leaderboard keys (paginated). Also
	 *  captures each main-track PB time into `remotePbTimes` so the incremental refresh can tell which of
	 *  the user's maps changed since their cache was written (local users read this from the local cache). */
	async fetchUserDone(uid: number, gen: number): Promise<Set<string>> {
		const done = new Set<string>();
		remotePbTimes = {}; // fresh for this user
		const take = 100;
		let skip = 0;
		for (let page = 0; page < 100; page++) {
			// max 100 pages = 10k PBs (safety ceiling)
			const j = await this.fetchJson(`${API}/v1/runs?userID=${uid}&isPB=true&take=${take}&skip=${skip}`);
			if (gen !== userGen) break; // superseded — stop fetching
			const data: any[] = j?.data ?? [];
			for (const r of data) {
				if (r?.mapID == null) continue;
				done.add(this.doneKey(r.mapID, r.gamemode, r.trackType, r.trackNum, r.style));
				// Main-track PB time, keyed like perMapRank (the rank data is main-track only).
				if (r.trackType === TrackType.MAIN && r.trackNum === 1 && r.time != null)
					remotePbTimes[this.perMapKey(r.mapID, r.gamemode, r.style)] = r.time;
			}
			if (gen === userGen) this.setUserStatus(`Loading runs… ${done.size}`);
			if (data.length < take) break; // last page
			skip += take;
		}
		return done;
	}

	//#endregion

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
		perMapRank = {}; // and the per-map rank detail
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

		// Load the viewed user's persisted rank cache (unless Rescan forced a fresh scan). When present it
		// populates perMapRank + re-derives the rankResults aggregates, so the ladder/tiers render instantly
		// from cache with no network; when absent this is a first-ever full scan.
		const hadCache = !forceFullScan && this.loadCacheForView();
		forceFullScan = false;
		if (!hadCache) dataTimestamp = 0; // a full scan (incl. a forced Rescan) re-stamps it on completion
		scanIsFull = !hadCache; // a full scan's drain sets the timestamp + persists; a cached open doesn't

		this.renderFilter();
		this.renderBar();
		this.renderContent(); // styles now render inside the right card (sub-left)
		this.updateViewLabel(); // restore the "Viewing <user>" indicator on re-open

		// Kick the background scan. On the cached path, cached keys are already complete so enqueueAllModes
		// no-ops them (see enqueueRank) — the cheap incremental refresh is what catches new completions /
		// improved PBs. On the uncached path, enqueueAllModes IS the full scan.
		this.enqueueAllModes();
		if (hadCache) this.startIncrementalRefresh();
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
		this.renderContent(); // rebuilds the right card, incl. this mode's style buttons in the sub-left
	}

	setStyle(st: Style) {
		selectedStyle = st;
		selectedTier = null; // tier set differs per style
		this.renderContent(); // the right card rebuilds; renderStyles re-highlights the active style
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
		// Only restyle the (persistent) tier rows and refill the map-list holder — never recreate the row
		// the cursor is on, which would make its "Show tier X maps" tooltip flash at the press point for a
		// frame before snapping back to the hover spot.
		this.refreshTierExpansion();
	}

	/** Update tier-row highlights and (re)build only the expanded map list, leaving the rows in place. */
	refreshTierExpansion() {
		for (const b of tierBtns) {
			if (b.row.IsValid()) this.styleTierRow(b.row, b.label, selectedTier === b.tier);
		}
		if (!tierMapHolder || !tierMapHolder.IsValid()) return;
		tierMapHolder.RemoveAndDeleteChildren();
		tierRankRows = [];
		if (curStat && (selectedTier == null || curStat.tiers.has(selectedTier))) {
			this.renderTierMaps(tierMapHolder, selectedTier);
		}
	}

	/** Toggle a tier row's active styling (bg + left accent + label colour) without recreating it. */
	styleTierRow(row: Panel, label: Panel, on: boolean) {
		try {
			row.style.backgroundColor = on ? '#1b2530' : '#00000000';
		} catch {}
		try {
			row.style.borderColor = on ? C_ACCENT : '#00000000'; // only border-left has width, so this tints it
		} catch {}
		try {
			label.style.color = on ? '#ffffff' : '#cdd5df';
		} catch {}
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

		for (const map of maps) {
			const { staticData } = map;
			if (staticData.status !== MapStatus.APPROVED) continue; // exclude beta/testing/submission maps

			const lb = getTrack(staticData, gm, TrackType.MAIN, 1, style);
			if (!lb || !lb.tier) continue; // no real tier (null or 0), or no board in this style

			const isRanked = lb.type === LeaderboardType.RANKED;
			const isUnranked = lb.type === LeaderboardType.UNRANKED;
			if (!isRanked && !isUnranked) continue; // exclude hidden / in-submission

			const done = this.isDone(map, gm, style);

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

	/** The selected mode's valid styles (Normal / Pro / Teleport / Sideways / …), rendered into the given
	 *  container (the right card's sub-left column). No-op when the mode has no choice of styles. */
	renderStyles(parent: Panel) {
		styleBtns = [];

		const styles = selectedMode == null || selectedMode === ALL_MODES
			? []
			: [...(GamemodeStyles.get(selectedMode) ?? [])];

		// Only meaningful when the mode actually has a choice of styles.
		if (styles.length <= 1) return;

		$.CreatePanel('Label', parent, '', {
			text: 'Style',
			style: 'font-size: 12px; font-weight: bold; color: #6f7885; margin-bottom: 6px;'
		});
		// Wrap onto multiple rows rather than scrolling sideways (the sub-left column is narrow).
		const bar = $.CreatePanel('Panel', parent, '', {
			style: 'flow-children: right-wrap; width: 100%; margin-bottom: 8px;'
		});

		for (const st of styles) {
			const btn = $.CreatePanel('Panel', bar, '', {
				style:
					'flow-children: right; padding: 5px 14px; margin-right: 6px; margin-bottom: 6px; border-radius: 6px; ' +
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

		// Group rankings + averages (live from the API, loaded in the background). The strip supplies its
		// own "Group rankings" header, so no separate section title here.
		const rankSec = $.CreatePanel('Panel', card, '', {
			style: `flow-children: down; width: 100%; margin-top: 14px; padding-top: 14px; border-top: 1px solid ${C_BORDER};`
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
		if (!item) {
			this.onScanQueueDrained();
			return;
		}
		rankBusy = true;
		try {
			await this.runRankScan(item.mode, item.style, item.filter);
		} finally {
			rankBusy = false;
		}
		if (rankQueue.length) await this.sleep(0.4); // brief breather between modes so we don't hammer the API
		this.processRankQueue(); // next in queue
	}

	/** Called when the rank-scan queue empties. If a full scan was in progress (first-ever open or Rescan),
	 *  stamp it fresh, persist the derived perMapRank, and re-render so the "Updated" line appears. A cached
	 *  open's queue drains here too, but with scanIsFull=false it's a no-op (nothing re-scanned or persisted). */
	onScanQueueDrained() {
		if (!scanIsFull) return;
		scanIsFull = false;
		dataTimestamp = Date.now();
		this.saveRankCache();
		$.Msg(`[Stats] full scan complete — persisted ${Object.keys(perMapRank).length} maps`);
		if (curRankBody && curRankBody.IsValid())
			this.renderRankResults(curRankBody, this.resultFor(selectedMode as Gamemode, selectedStyle, rankFilter));
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

	/** Hold off the background scan's web requests so a user-initiated map launch/download gets HTTP priority
	 *  (the scan and map downloads share the game's HTTP client). Extends any existing pause. */
	pauseRankScan(seconds: number) {
		rankPausedUntil = Math.max(rankPausedUntil, Date.now() + seconds * 1000);
	}

	/** Await until any active pause elapses (so no scan request competes with a user's map download). */
	async waitWhilePaused() {
		while (Date.now() < rankPausedUntil) {
			await this.sleep(Math.min((rankPausedUntil - Date.now()) / 1000, 0.5));
		}
	}

	/** GET + parse with retries and jittered backoff — the game/API throttles parallel bursts, so
	 *  drops are common; jitter stops concurrent retries from re-bursting in lockstep. */
	async fetchJson(url: string, tries = 20): Promise<any> {
		for (let i = 0; i < tries; i++) {
			await this.waitWhilePaused(); // yield HTTP to a user-initiated map launch/download
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
	): Promise<{ rank: number | null; time: number | null; ok: boolean }> {
		const url = `${API}/v1/maps/${mapID}/leaderboard?gamemode=${gm}&trackType=0&trackNum=1&style=${style}&userIDs=${uid}`;
		const j = await this.fetchJson(url);
		if (j == null) return { rank: null, time: null, ok: false }; // request failed after retries
		const entry = j.data && j.data[0] ? j.data[0] : null;
		return { rank: entry ? entry.rank : null, time: entry ? entry.time : null, ok: true };
	}

	/** Board size + the rank-1 time on one map's (gm, main, style) leaderboard. `take=1` already returns
	 *  the top entry, so the WR time comes free — no extra request beyond the percentile call. */
	async fetchTotal(mapID: number, gm: Gamemode, style: Style): Promise<{ total: number; wrTime: number | null }> {
		const url = `${API}/v1/maps/${mapID}/leaderboard?gamemode=${gm}&trackType=0&trackNum=1&style=${style}&take=1`;
		const j = await this.fetchJson(url);
		if (!j) return { total: 0, wrTime: null };
		const entry = j.data && j.data[0] ? j.data[0] : null;
		return { total: j.totalCount || 0, wrTime: entry ? entry.time : null };
	}

	/** Map one API leaderboard entry to a row. The response embeds `user` (alias + steamID64 + avatarURL) by
	 *  default — no `expand` (the API rejects it) and no per-player calls. */
	lbRowFromEntry(e: any): Top10Row {
		return {
			rank: e.rank,
			time: e.time,
			userID: e.userID,
			alias: e.user?.alias ?? `Player ${e.userID}`,
			steamID: e.user?.steamID ?? null,
			downloadURL: e.downloadURL ?? null
		};
	}

	/** Top 10 + board size of one map's (gm, MAIN, style) board. null = request failed (not cached, retryable). */
	async fetchBoardTop(mapID: number, gm: Gamemode, style: Style): Promise<{ rows: Top10Row[]; total: number } | null> {
		const url = `${API}/v1/maps/${mapID}/leaderboard?gamemode=${gm}&trackType=0&trackNum=1&style=${style}&take=10`;
		const j = await this.fetchJson(url);
		if (j == null || !Array.isArray(j.data)) return null;
		return { rows: j.data.map((e: any) => this.lbRowFromEntry(e)), total: j.totalCount || 0 };
	}

	/** The single run at an exact rank (`skip=rank-1&take=1`) — used to fetch one group's cutoff person. */
	async fetchRunAtRank(mapID: number, gm: Gamemode, style: Style, rank: number): Promise<Top10Row | null> {
		const url = `${API}/v1/maps/${mapID}/leaderboard?gamemode=${gm}&trackType=0&trackNum=1&style=${style}&skip=${rank - 1}&take=1`;
		const j = await this.fetchJson(url);
		if (j == null || !Array.isArray(j.data) || !j.data[0]) return null;
		return this.lbRowFromEntry(j.data[0]);
	}

	/** Ranks of the last person in each group G1..G6 for a board of `total`, matching `bestGroup`'s thresholds
	 *  (`rank ≤ max(total·pct + 10, floor)`). Groups sit below the Top 10; empty groups (small boards) are
	 *  skipped and every cutoff is capped at the board size. */
	computeGroupCutoffs(total: number): { group: number; rank: number }[] {
		const out: { group: number; rank: number }[] = [];
		let prev = 10; // ranks ≤ 10 are WR / Top 10, not a group
		for (let i = 0; i < GROUP_DEFS.length; i++) {
			const threshold = Math.floor(Math.max(total * GROUP_DEFS[i].pct + 10, GROUP_DEFS[i].floor));
			const cutoff = Math.min(threshold, total);
			if (cutoff > prev) {
				out.push({ group: i + 1, rank: cutoff });
				prev = cutoff;
			}
		}
		return out;
	}

	/** The viewed user's own standing (rank + PB time) on a board. Free from the rank scan's cache when
	 *  present; otherwise one `userIDs=` leaderboard call (cached per user). {null,null} = not on the board. */
	async getYourStanding(mapID: number, gm: Gamemode, style: Style, key: string, force = false): Promise<Standing> {
		// `force` (the popup's per-map Refresh) bypasses both caches so the standing is re-fetched fresh; the
		// tier-list's perMapRank isn't cleared (kept for that row), just skipped here.
		if (!force) {
			const pm = perMapRank[key];
			if (pm && pm.time != null) return { rank: pm.rank, time: pm.time };
		}
		const uid = this.viewUid();
		if (!uid) return { rank: null, time: null };
		const ck = `${key}|${uid}`;
		if (!force) {
			const cached = yourStandingCache[ck];
			if (cached !== undefined) return cached;
		}
		const res = await this.fetchRank(mapID, gm, style, uid);
		if (!res.ok) return { rank: null, time: null }; // request failed — don't cache, let it retry
		const standing: Standing = { rank: res.rank, time: res.time };
		yourStandingCache[ck] = standing;
		return standing;
	}

	/** Identity (id/alias/steamID) of whoever is being viewed — the searched user, else the local player —
	 *  used to render their own "where you'd place" row in the cutoffs. */
	getViewedUserIdentity(): { userID: number; alias: string; steamID: string | null } {
		if (viewUser) return { userID: viewUser.id, alias: viewUser.alias, steamID: viewUser.steamID ?? null };
		try {
			const u = MomentumAPI.GetLocalUserData();
			return { userID: u.id, alias: u.alias ?? 'You', steamID: u.steamID ?? null };
		} catch {
			return { userID: this.viewUid(), alias: 'You', steamID: null };
		}
	}

	/** Open the leaderboard popup for a map's (gm, style) board. Renders from the session cache when present
	 *  (0 calls); otherwise one `take=10` call for the top 10, then one `take=1` call per group cutoff. The
	 *  viewed user's own time (for "vs You") is resolved in parallel — free from the scan, or one extra call. */
	async openMapLeaderboard(mapID: number, gm: Gamemode, style: Style, mapName: string, force = false) {
		const popup = $('#StatsLbPopup');
		if (!popup) return;
		const gen = ++this.lbGen;

		// Remember which map is open so the popup's Refresh button can re-fetch just this board.
		this.lbMapID = mapID;
		this.lbGm = gm;
		this.lbStyle = style;
		this.lbMapName = mapName;

		try {
			popup.style.visibility = 'visible';
		} catch {}
		const title = $<Label>('#StatsLbTitle');
		if (title) title.text = mapName;
		const sub = $<Label>('#StatsLbSubtitle');
		if (sub) {
			const gmName = $.Localize(GamemodeInfo.get(gm)?.i18n ?? '') || `Mode ${gm}`;
			sub.text = `${gmName} · ${styleEnglishName(style)} · Top 10 + group cutoffs`;
		}
		this.renderMapImages(mapID); // left-column screenshot strip (from the local scan cache, no web call)
		const list = $('#StatsLbList');
		if (list) list.RemoveAndDeleteChildren();
		lbCutoffRefs = [];

		const key = this.perMapKey(mapID, gm, style);
		if (force) delete mapLbCache[key]; // Refresh: drop the cached board so it re-fetches
		let entry = mapLbCache[key];
		let standing: Standing;
		if (!entry) {
			this.setLbStatus(force ? 'Refreshing leaderboard…' : 'Loading leaderboard…');
			// Board top and your-own-standing run together, so "vs You" adds no wall-clock latency.
			const [res, yt] = await Promise.all([
				this.fetchBoardTop(mapID, gm, style),
				this.getYourStanding(mapID, gm, style, key, force)
			]);
			if (gen !== this.lbGen) return; // popup closed or another map opened while fetching
			if (res == null) {
				this.setLbStatus('Could not load the leaderboard — try again.');
				return;
			}
			const cutoffs: GroupCutoff[] = this.computeGroupCutoffs(res.total).map((c) => ({
				group: c.group,
				rank: c.rank,
				row: null,
				fetched: false
			}));
			// Tack on the very last place (worst rank on the board) as a final row after the groups — but only
			// when the board runs past the top 10 and that rank isn't already a group cutoff (small boards).
			// Sentinel group 0 = the "LAST" row (see cutoffBadge); it sorts to the end (rank = total).
			if (res.total > 10 && !cutoffs.some((c) => c.rank === res.total)) {
				cutoffs.push({ group: 0, rank: res.total, row: null, fetched: false });
			}
			entry = { rows: res.rows, total: res.total, cutoffs };
			mapLbCache[key] = entry;
			standing = yt;
		} else {
			standing = await this.getYourStanding(mapID, gm, style, key);
			if (gen !== this.lbGen) return;
		}

		if (!entry.rows.length) {
			this.setLbStatus('No times on this leaderboard yet.');
			return;
		}
		this.setLbStatus('');
		this.renderMapLb(entry, standing);
		// Popup → main cache: the board fetch already gave this map's rank / time / total / WR, so fold it
		// straight into perMapRank (and persist) — opening a map's popup or hitting Refresh updates the
		// stats cache for that map for free, no separate scan (§6i). Keyed identically (perMapKey).
		this.writeBackFromBoard(gm, style, key, entry, standing);
		this.fetchCutoffs(mapID, gm, style, key, gen, standing.time); // fill cutoff rows in place
	}

	/** Fold a freshly-fetched leaderboard board + the viewed user's standing back into the persistent rank
	 *  cache. Only writes when we actually have the user's placement (a null time may be a transient request
	 *  failure, not "unranked", so skip rather than clobber good data). Re-derives the affected aggregates. */
	writeBackFromBoard(gm: Gamemode, style: Style, key: string, entry: MapLb, standing: Standing) {
		if (standing.time == null || standing.rank == null) return;
		const next: PerMapRank = {
			rank: standing.rank,
			time: standing.time,
			total: entry.total > 0 ? entry.total : null,
			wrTime: entry.rows[0]?.time ?? null
		};
		const prev = perMapRank[key];
		if (prev && prev.rank === next.rank && prev.time === next.time && prev.total === next.total && prev.wrTime === next.wrTime)
			return; // unchanged — nothing to recompute or persist
		perMapRank[key] = next;
		this.updateTierRankRow(key); // reflect it in the tier list behind the popup, if shown
		// The map belongs to whichever of ranked/unranked its board is — recompute both so the ladder updates.
		rankResults[this.rankKey(gm, style, 'ranked')] = this.recomputeRankResult(gm, style, 'ranked');
		rankResults[this.rankKey(gm, style, 'unranked')] = this.recomputeRankResult(gm, style, 'unranked');
		if (curRankBody && curRankBody.IsValid())
			this.renderRankResults(curRankBody, this.resultFor(selectedMode as Gamemode, selectedStyle, rankFilter));
		this.saveRankCache(); // patch persists under the existing full-scan timestamp
	}

	/** Badge label + colour for a cutoff row. Sentinel group 0 is the board's absolute last place. */
	cutoffBadge(group: number): { badge: string; color: string } {
		return group === 0 ? { badge: 'LAST', color: '#c56b6b' } : { badge: `G${group}`, color: GROUP_COLORS[group - 1] };
	}

	/** Fetch each group's cutoff person (one `take=1` call each) and fill its row when it lands. */
	async fetchCutoffs(mapID: number, gm: Gamemode, style: Style, key: string, gen: number, yourTime: number | null) {
		const entry = mapLbCache[key];
		if (!entry) return;
		const wr = entry.rows[0]?.time ?? null;
		const meId = this.viewUid();
		await Promise.all(
			entry.cutoffs
				.filter((c) => !c.fetched)
				.map(async (c) => {
					const row = await this.fetchRunAtRank(mapID, gm, style, c.rank);
					if (gen !== this.lbGen) return; // popup changed under us
					c.row = row;
					c.fetched = true;
					const ref = lbCutoffRefs.find((r) => r.rank === c.rank);
					if (ref && ref.panel.IsValid()) {
						const b = this.cutoffBadge(c.group);
						this.fillLbRow(ref.panel, b.badge, b.color, c.rank, c.row, wr, meId, '—', yourTime);
					}
				})
		);
	}

	/** Find a scanned map's static data by id — used to pull its screenshots for the popup's image strip. */
	mapStaticById(mapID: number): MapCacheAPI.StaticData | null {
		for (const m of scanCache ?? []) if (m.staticData?.id === mapID) return m.staticData;
		return null;
	}

	/** Fill the popup's left column with the map's screenshots as a vertical strip. The image urls are the
	 *  map's CDN images (already in the local scan cache), applied via SetImage — no web request, the same
	 *  way the loading screen shows a map thumbnail. Collapsed (no reserved width) when the map has none. */
	renderMapImages(mapID: number) {
		const holder = $<Panel>('#StatsLbImages');
		if (!holder) return;
		holder.RemoveAndDeleteChildren();

		const images = this.mapStaticById(mapID)?.images ?? [];
		try {
			holder.style.visibility = images.length ? 'visible' : 'collapse';
		} catch {}
		if (!images.length) return;

		for (const img of images) {
			const url = img.medium || img.large || img.small || img.xl; // medium is plenty for a 240px strip
			if (!url) continue;
			const image = $.CreatePanel('Image', holder, '', {
				style:
					'width: 240px; height: 135px; margin-bottom: 10px; horizontal-align: center; ' +
					'border-radius: 8px; background-color: #171b22;'
			});
			(image as ImagePanel).SetImage(url); // CDN url straight to the panel (not whitelist-gated, unlike AsyncWebRequest)
		}
	}

	/** Re-fetch just the currently-open map's leaderboard (bypasses the session cache for that one board). */
	refreshCurrentMap() {
		if (this.lbMapID == null) return;
		void this.openMapLeaderboard(this.lbMapID, this.lbGm, this.lbStyle, this.lbMapName, true);
	}

	/** Right-click menu for a leaderboard run row. NOTE: watching an online replay in-game is NOT possible from
	 *  here — the game only downloads+plays online replays through the C++ `Leaderboards` panel
	 *  (`LeaderboardEntry_PlayReplay(index)`), which needs that panel already loaded with this exact
	 *  map/track/style; our web-API popup has no such panel, and `mom_tv_replay_watch` only takes a LOCAL file
	 *  path (no exposed API downloads an arbitrary run's .mrec). So we link out to the website + Steam profile. */
	showRunContextMenu(row: Top10Row) {
		const items: UiToolkitAPI.SimpleContextMenuItem[] = [];

		// Open the map (its leaderboards + downloadable replays) on the Momentum website in the Steam overlay —
		// the closest reachable "watch this run" from a custom panel.
		const frontend = GameInterfaceAPI.GetSettingString('mom_api_url_frontend');
		if (frontend && this.lbMapName) {
			items.push({
				label: 'View map on Momentum',
				icon: 'file://{images}/movie-open-outline.svg',
				style: 'icon-color-white',
				jsCallback: () => SteamOverlayAPI.OpenURL(`${frontend}/maps/${this.lbMapName}`)
			});
		}

		if (row.steamID) {
			items.push({
				label: $.Localize('#Action_ShowSteamProfile') || 'Show Steam Profile',
				icon: 'file://{images}/social/steam.svg',
				style: 'icon-color-steam-online',
				jsCallback: () => SteamOverlayAPI.OpenToProfileID(row.steamID as steamID)
			});
		}

		if (!items.length) return;
		UiToolkitAPI.ShowSimpleContextMenu('', 'ControlsLibSimpleContextMenu', items);
	}

	closeMapLeaderboard() {
		this.lbGen++; // discard any in-flight fetch
		this.lbMapID = null; // no map open — Refresh is a no-op until the next open
		const popup = $('#StatsLbPopup');
		if (!popup) return;
		try {
			popup.style.visibility = 'collapse';
		} catch {}
		$<Panel>('#StatsLbImages')?.RemoveAndDeleteChildren(); // drop the screenshot strip so it doesn't linger
	}

	/** Show a status/empty message in the popup (collapsed when blank so it takes no space). */
	setLbStatus(msg: string) {
		const s = $<Label>('#StatsLbStatus');
		if (!s) return;
		s.text = msg;
		try {
			s.style.visibility = msg ? 'visible' : 'collapse';
		} catch {}
	}

	/** Signed gap to the viewed user's own time: `−` = faster than you (ahead), `+` = slower (behind). */
	fmtVsYou(delta: number, decimals = 2): string {
		return (delta < 0 ? '−' : '+') + this.fmtDiff(Math.abs(delta), decimals);
	}

	/** Build the popup body: the top 10, then a "group cutoffs" section (last person in each group, with the
	 *  viewed user's own row slotted in where they place). `standing` = the viewed user's rank + PB time. */
	renderMapLb(entry: MapLb, standing: Standing) {
		const list = $('#StatsLbList');
		if (!list) return;
		list.RemoveAndDeleteChildren();
		lbCutoffRefs = [];

		const meId = this.viewUid();
		const yourTime = standing.time; // drives the "vs You" column
		const wr = entry.rows[0]?.time ?? null; // rank-1 time = the WR the diffs are measured against

		// Column header (widths match the rows below).
		const head = $.CreatePanel('Panel', list, '', {
			style: 'flow-children: right; width: 100%; padding: 2px 10px 8px 10px;'
		});
		const hcol = (text: string, w: number, align = 'right') =>
			$.CreatePanel('Label', head, '', {
				text,
				style: `width: ${w}px; font-size: 12px; color: #7d8794; text-align: ${align}; vertical-align: center;`
			});
		hcol('', LB_W_BADGE, 'center');
		hcol('#', LB_W_RANK, 'center');
		$.CreatePanel('Panel', head, '', { style: `width: ${LB_W_AV}px; height: 1px;` });
		$.CreatePanel('Label', head, '', {
			text: 'Player',
			style: 'width: fill-parent-flow(1); font-size: 12px; color: #7d8794; text-align: left; vertical-align: center;'
		});
		hcol('Time', LB_W_TIME);
		hcol('+ WR', LB_W_DIFF);
		hcol(viewUser ? 'vs Them' : 'vs You', LB_W_YOU);

		// Top 10: badge = WR (rank 1) / T10 (rank ≤ 10).
		for (const r of entry.rows) {
			const badge = r.rank === 1 ? 'WR' : 'T10';
			const badgeColor = r.rank === 1 ? RANK_WR_COLOR : RANK_T10_COLOR;
			const rp = $.CreatePanel('Panel', list, '', { style: LB_ROW_STYLE });
			this.fillLbRow(rp, badge, badgeColor, r.rank, r, wr, meId, '—', yourTime);
		}

		// Group cutoffs (last place per group), with the viewed user's OWN row slotted in at the rank they'd
		// place — but only when they're outside the top 10 (they already appear there) and actually on the board.
		const yr = standing.rank;
		const showYou = yr != null && standing.time != null && yr > 10 && !entry.cutoffs.some((c) => c.rank === yr);
		if (entry.cutoffs.length || showYou) {
			$.CreatePanel('Label', list, '', {
				text: `Group cutoffs · last place · where ${viewUser ? 'they' : 'you'} place`,
				style: `font-size: 12px; color: #7d8794; text-transform: uppercase; letter-spacing: 1px; margin: 12px 10px 6px 10px; padding-top: 10px; border-top: 1px solid ${C_BORDER};`
			});

			// Merge the group cutoffs with the "you" row and render in rank order.
			type Slot = { rank: number; cutoff?: GroupCutoff; you?: boolean };
			const slots: Slot[] = entry.cutoffs.map((c) => ({ rank: c.rank, cutoff: c }));
			if (showYou) slots.push({ rank: yr as number, you: true });
			slots.sort((a, b) => a.rank - b.rank);

			for (const s of slots) {
				const rp = $.CreatePanel('Panel', list, '', { style: LB_ROW_STYLE });
				if (s.you) {
					const rank = yr as number;
					const g = this.bestGroup(rank, entry.total); // the group the viewed user falls into
					const id = this.getViewedUserIdentity();
					const youRow: Top10Row = {
						rank,
						time: standing.time as number,
						userID: id.userID,
						alias: id.alias,
						steamID: id.steamID,
						downloadURL: null // standing fetch has no replay URL; Watch Replay is only on fetched board rows
					};
					this.fillLbRow(rp, g >= 1 ? `G${g}` : '—', g >= 1 ? GROUP_COLORS[g - 1] : '#6f7885', rank, youRow, wr, meId, '—', yourTime);
				} else {
					const c = s.cutoff as GroupCutoff;
					const b = this.cutoffBadge(c.group);
					this.fillLbRow(rp, b.badge, b.color, c.rank, c.row, wr, meId, c.fetched ? '—' : '…', yourTime);
					lbCutoffRefs.push({ rank: c.rank, panel: rp });
				}
			}
		}
	}

	/** (Re)build one leaderboard row's cells. `row` null → placeholder (`ph`: '…' pending, '—' failed).
	 *  `yourTime` = the viewed user's PB, for the signed "vs You" column (null → blank). */
	fillLbRow(
		rp: Panel,
		badge: string,
		badgeColor: string,
		rank: number,
		row: Top10Row | null,
		wr: number | null,
		meId: number,
		ph: string,
		yourTime: number | null
	) {
		if (!rp?.IsValid()) return;
		rp.RemoveAndDeleteChildren();
		const mine = row != null && row.userID === meId;
		try {
			rp.style.backgroundColor = mine ? '#1c2b30' : '#171b22'; // highlight the viewed player's row
		} catch {}

		// Right-click a filled row → context menu (Watch Replay / player profile), like the main-menu leaderboards.
		if (row) rp.SetPanelEvent('oncontextmenu', () => this.showRunContextMenu(row));
		else rp.ClearPanelEvent('oncontextmenu');

		$.CreatePanel('Label', rp, '', {
			text: badge,
			style: `width: ${LB_W_BADGE}px; font-size: 12px; font-weight: bold; color: ${badgeColor}; text-align: center; vertical-align: center;`
		});
		$.CreatePanel('Label', rp, '', {
			text: `#${rank}`,
			style: `width: ${LB_W_RANK}px; font-size: 14px; font-weight: bold; color: ${rank === 1 ? RANK_WR_COLOR : '#cdd5df'}; text-align: center; vertical-align: center;`
		});

		if (row?.steamID) {
			const av = $.CreatePanel('AvatarImage', rp, '', {
				style: 'width: 26px; height: 26px; border-radius: 4px; margin-right: 14px; vertical-align: center;'
			});
			try {
				av.steamid = row.steamID as steamID;
			} catch {}
		} else {
			$.CreatePanel('Panel', rp, '', {
				style: 'width: 26px; height: 26px; border-radius: 4px; margin-right: 14px; vertical-align: center; background-color: #232a33;'
			});
		}

		$.CreatePanel('Label', rp, '', {
			text: row ? row.alias : ph,
			style: `width: fill-parent-flow(1); font-size: 14px; color: ${mine ? '#ffffff' : row ? '#dfe5ec' : '#6f7885'}; vertical-align: center; text-overflow: ellipsis;`
		});
		$.CreatePanel('Label', rp, '', {
			text: row ? this.fmtTime(row.time, 3) : ph,
			style: `width: ${LB_W_TIME}px; font-size: 14px; color: ${row ? '#b8c0cc' : '#6f7885'}; text-align: right; vertical-align: center;`
		});
		const wrDiff = row == null ? '' : rank === 1 || wr == null ? '—' : `+${this.fmtDiff(Math.max(0, row.time - wr), 3)}`;
		$.CreatePanel('Label', rp, '', {
			text: wrDiff,
			style: `width: ${LB_W_DIFF}px; font-size: 13px; color: ${rank === 1 ? '#6f7885' : '#e0a86f'}; text-align: right; vertical-align: center;`
		});

		// vs You: signed gap to the viewed user's own time. Blank if you're not on the board; "—" on your
		// own row; otherwise −faster / +slower, coloured (they beat you = red, you beat them = green).
		let youText = '';
		let youColor = '#6f7885';
		if (row != null && yourTime != null) {
			if (mine) {
				youText = '—';
			} else {
				const delta = row.time - yourTime;
				youText = this.fmtVsYou(delta, 3);
				youColor = delta < 0 ? '#e0736f' : delta > 0 ? '#8fd694' : '#8a93a0';
			}
		}
		$.CreatePanel('Label', rp, '', {
			text: youText,
			style: `width: ${LB_W_YOU}px; font-size: 13px; color: ${youColor}; text-align: right; vertical-align: center;`
		});
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
			for (const map of maps) {
				const { staticData } = map;
				if (staticData.status !== MapStatus.APPROVED) continue;
				const lb = getTrack(staticData, gm, TrackType.MAIN, 1, st);
				if (!lb || !lb.tier) continue;
				const isRanked = lb.type === LeaderboardType.RANKED;
				const isUnranked = lb.type === LeaderboardType.UNRANKED;
				if (!isRanked && !isUnranked) continue;
				if (filter === 'ranked' && !isRanked) continue;
				if (filter === 'unranked' && !isUnranked) continue;
				if (!this.isDone(map, gm, st)) continue;
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
		const uid = this.viewUid(); // local player, or the searched remote user
		$.Msg(`[Stats] runRankScan: ${key} — ${targets.length} completed maps to query (uid ${uid})`);

		if (!uid || targets.length === 0) {
			rankResults[key] = { ...EMPTY_RANK, targets: targets.length, groups: [0, 0, 0, 0, 0, 0] };
			if (isCurrent()) note(targets.length === 0 ? 'No completed maps in this view.' : 'Could not read the user id.');
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
			if (gen === rankGen) {
				const pmKey = this.perMapKey(t.mapID, t.gm, t.style);
				if (!res.ok) {
					errors++;
				} else if (res.rank != null) {
					ranked.push({ ...t, rank: res.rank });
					perMapRank[pmKey] = { rank: res.rank, time: res.time, total: null, wrTime: null };
					this.updateTierRankRow(pmKey); // fill this map's row in the tier list, if it's shown
				} else {
					noEntry++;
					perMapRank[pmKey] = { rank: null, time: null, total: null, wrTime: null };
					this.updateTierRankRow(pmKey);
				}
			}
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
			pctCount: 0,
			groups: [0, 0, 0, 0, 0, 0] // filled in phase 2 (needs board totals)
		};
		$.Msg(
			`[Stats] runRankScan: ${key} phase 1 done — ranked ${ranked.length}/${targets.length}, ` +
				`WRs ${rankResults[key].wr}, top10 ${rankResults[key].top10}, noEntry ${noEntry}, errors ${errors}`
		);
		render();

		// Phase 2: leaderboard totals → Avg % + group rankings (both need each board's size).
		if (ranked.length > 0) {
			const pcts: number[] = [];
			const groups = [0, 0, 0, 0, 0, 0];
			await this.pool(ranked, 10, async (r) => {
				const { total, wrTime } = await this.fetchTotal(r.mapID, r.gm, r.style);
				if (gen !== rankGen) return;
				const pmKey = this.perMapKey(r.mapID, r.gm, r.style);
				const pm = perMapRank[pmKey];
				if (pm) {
					pm.total = total > 0 ? total : null;
					pm.wrTime = wrTime; // rank-1 time → per-map WR diff
				}
				if (total > 0) {
					pcts.push((r.rank / total) * 100);
					// WR (rank 1) and Top 10 are their own tiers above the groups — don't bucket them as G1.
					if (r.rank > 10) {
						const g = this.bestGroup(r.rank, total); // 1..6, or 0 if below G6
						if (g >= 1) groups[g - 1]++;
					}
				}
				this.updateTierRankRow(pmKey); // now has group + WR diff for this map's row
			});
			if (superseded()) return;
			const res = rankResults[key];
			res.sumPct = pcts.reduce((a, p) => a + p, 0);
			res.pctCount = pcts.length;
			res.avgPct = pcts.length ? res.sumPct / pcts.length : null;
			res.groups = groups;
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

	/** Best (lowest-numbered) group 1..6 a rank earns on a board of `total`, or 0 if worse than G6. */
	bestGroup(rank: number, total: number): number {
		for (let i = 0; i < GROUP_DEFS.length; i++) {
			const def = GROUP_DEFS[i];
			if (rank <= Math.max(total * def.pct + 10, def.floor)) return i + 1;
		}
		return 0;
	}

	/** Sum a set of cached per-filter results into one. Missing keys → still scanning (pctPending). */
	aggregateResults(keys: string[]): RankResult {
		const agg: RankResult = { ...EMPTY_RANK, pctPending: false, groups: [0, 0, 0, 0, 0, 0] };
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
			for (let i = 0; i < agg.groups.length; i++) agg.groups[i] += r.groups[i] ?? 0;
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

		// The group ladder (WR · Top 10 · G1…G6) is the headline; WRs/Top 10 counts live in its first cells.
		this.renderGroupStrip(body, r);

		// Average rank + average percentile in small boxes below the ladder.
		const avg = $.CreatePanel('Panel', body, '', {
			style: 'flow-children: right; width: 100%; margin-top: 8px;'
		});
		this.makeTile(avg, 'Avg rank', r.ranked ? `${r.avgRank}` : '—', '#e0a86f');
		this.makeTile(
			avg,
			'Avg %',
			r.pctPending ? '…' : r.avgPct != null ? `top ${r.avgPct.toFixed(1)}%` : '—',
			'#9aa3af'
		);

		if (r.ranked === 0 && r.errors > 0) {
			$.CreatePanel('Label', body, '', {
				text: 'All requests failed — the API may be unreachable from the game.',
				style: 'font-size: 11px; color: #e0a86f; margin-top: 6px; horizontal-align: center; text-align: center;'
			});
		}

		// Freshness of the cached ranks (from the last full scan). The incremental auto-refresh only patches
		// your changed maps, so others' ranks can drift stale between full scans — Rescan is the source of truth.
		if (dataTimestamp > 0) {
			$.CreatePanel('Label', body, '', {
				text: `Updated ${this.agoText(dataTimestamp)} · Rescan for a full refresh`,
				style: 'font-size: 11px; color: #6f7885; margin-top: 8px; horizontal-align: center; text-align: center;'
			});
		}
	}

	/**
	 * Group rankings strip — the exclusive ranking ladder, best → worst: WR · Top 10 · G1 … G6. Each ranked
	 * map lands in exactly one cell. WR (rank 1) and Top 10 (ranks 2–10) are pulled out above the numeric
	 * groups, so a Top-10 map is counted as Top 10, never G1. WR/Top 10 come from phase 1 (rank only); the
	 * G1…G6 counts need each board's size, so they read "…" until phase 2 finishes. Maps below G6 aren't
	 * counted (they're "No group"). The two WR/Top 10 cells mirror the tiles above but split exclusively.
	 */
	renderGroupStrip(body: Panel, r: RankResult) {
		if (r.ranked === 0) return; // no ranked maps → nothing to place

		$.CreatePanel('Label', body, '', {
			text: 'Group rankings',
			style: 'font-size: 12px; font-weight: bold; color: #cdd5df; margin-bottom: 6px;'
		});

		// Ladder cells: WR + Top 10 (known from phase 1) then G1…G6 (pending until phase 2).
		const cells: { label: string; count: number; color: string; pending: boolean; tip: string }[] = [
			{ label: 'WR', count: r.wr, color: RANK_WR_COLOR, pending: false, tip: 'World records — rank 1' },
			{
				label: 'T10',
				count: Math.max(0, r.top10 - r.wr),
				color: RANK_T10_COLOR,
				pending: false,
				tip: 'Top 10 — ranks 2–10 (WRs excluded)'
			}
		];
		for (let i = 0; i < GROUP_DEFS.length; i++) {
			const def = GROUP_DEFS[i];
			cells.push({
				label: `G${i + 1}`,
				count: r.groups[i],
				color: GROUP_COLORS[i],
				pending: r.pctPending,
				tip: `G${i + 1} · best of top ${Math.round(def.pct * 100)}% + 10 or top ${def.floor} (Top 10 excluded)`
			});
		}

		const strip = $.CreatePanel('Panel', body, '', { style: 'flow-children: right; width: 100%;' });
		cells.forEach((c, i) => {
			const cell = $.CreatePanel('Panel', strip, `StatsGroup${i}`, {
				style:
					'flow-children: down; width: fill-parent-flow(1); ' +
					(i < cells.length - 1 ? 'margin-right: 4px; ' : '') +
					'padding: 7px 1px; background-color: #10141a; border-radius: 6px;'
			});
			$.CreatePanel('Label', cell, '', {
				text: c.label,
				style: `font-size: 11px; font-weight: bold; color: ${c.color}; horizontal-align: center;`
			});
			$.CreatePanel('Label', cell, '', {
				text: c.pending ? '…' : `${c.count}`,
				style: 'font-size: 15px; font-weight: bold; color: #dfe5ec; horizontal-align: center; margin-top: 2px;'
			});
			cell.SetPanelEvent('onmouseover', () => UiToolkitAPI.ShowTextTooltip(cell.id, c.tip));
			cell.SetPanelEvent('onmouseout', () => UiToolkitAPI.HideTextTooltip());
		});

		// Explain the ladder's total: maps placed in a tier vs. those below G6 ("No group").
		if (!r.pctPending) {
			const placed = r.top10 + r.groups.reduce((a, g) => a + g, 0); // top10 (incl. WR) + G1…G6
			$.CreatePanel('Label', body, '', {
				text: `${placed} of ${r.ranked} ranked maps placed`,
				style: 'font-size: 11px; color: #6f7885; margin-top: 5px; horizontal-align: center;'
			});
		}
	}

	//#endregion

	/** Right card, split into two columns: sub-left = style selector + per-tier bars (narrow, scrolls);
	 *  sub-right = the map list, which now takes the full card height so it shows many more maps. */
	fillRight(card: Panel, s: ModeStat) {
		card.RemoveAndDeleteChildren();
		tierBtns = [];
		tierMapHolder = null;
		tierRankRows = [];

		const cols = $.CreatePanel('Panel', card, '', {
			style: 'flow-children: right; width: 100%; height: 100%;'
		});
		const subLeft = $.CreatePanel('Panel', cols, '', {
			style: 'flow-children: down; width: 330px; height: 100%; margin-right: 16px; overflow: squish scroll;'
		});
		const subRight = $.CreatePanel('Panel', cols, '', {
			style: 'flow-children: down; width: fill-parent-flow(1); height: 100%;'
		});

		// Sub-left: the mode's style selector (moved here from the page top), then the per-tier bars.
		this.renderStyles(subLeft);

		$.CreatePanel('Label', subLeft, '', {
			text: 'Completion by tier',
			style: 'font-size: 18px; font-weight: bold; color: #ffffff; margin-bottom: 4px;'
		});
		$.CreatePanel('Label', subLeft, '', {
			text: 'Click a tier to filter the maps',
			style: 'font-size: 12px; color: #8a93a0; margin-bottom: 12px;'
		});

		const tiers = [...s.tiers.keys()].sort((a, b) => a - b);
		if (tiers.length === 0) {
			$.CreatePanel('Label', subLeft, '', {
				text: 'No tiered maps for this filter.',
				style: 'font-size: 14px; color: #8a93a0;'
			});
			return;
		}

		for (const t of tiers) {
			const ts = s.tiers.get(t)!;
			const row = $.CreatePanel('Panel', subLeft, `StatsTierRow${t}`, {
				// Colours are toggled by styleTierRow so a click can restyle in place (no recreation).
				style:
					'flow-children: right; width: 100%; padding: 5px 8px; margin-bottom: 1px; border-radius: 6px; ' +
					'background-color: #00000000; border-left: 3px solid #00000000;'
			});
			row.SetPanelEvent('onactivate', () => this.selectTier(t));
			row.SetPanelEvent('onmouseover', () =>
				UiToolkitAPI.ShowTextTooltip(row.id, `Show tier ${t} maps`)
			);
			row.SetPanelEvent('onmouseout', () => UiToolkitAPI.HideTextTooltip());

			const tierLabel = $.CreatePanel('Label', row, '', {
				text: `Tier ${t}`,
				style: 'width: 52px; font-size: 14px; color: #cdd5df; vertical-align: center;'
			});
			const mid = $.CreatePanel('Panel', row, '', {
				style: 'flow-children: down; width: fill-parent-flow(1); margin: 0 10px; vertical-align: center;'
			});
			this.makeBar(mid, this.frac(ts.completed, ts.total), 10);
			$.CreatePanel('Label', row, '', {
				text: `${ts.completed}/${ts.total}  ·  ${this.pct(ts.completed, ts.total)}%`,
				style: 'width: 104px; font-size: 13px; color: #b8c0cc; text-align: right; vertical-align: center;'
			});

			tierBtns.push({ tier: t, row, label: tierLabel });
			this.styleTierRow(row, tierLabel, selectedTier === t);
		}

		// Sub-right: the map list fills the full column height (persistent holder — a tier click only
		// refills this + restyles the rows, so the hovered tier row is never recreated → no tooltip flicker).
		tierMapHolder = $.CreatePanel('Panel', subRight, 'StatsTierMapHolder', {
			style: 'flow-children: down; width: 100%; height: 100%;'
		});
		// Nothing selected → list every tier's maps; a tier selected → just that tier's.
		if (selectedTier == null || s.tiers.has(selectedTier)) {
			this.renderTierMaps(tierMapHolder, selectedTier);
		}
	}

	/** The box under the tier list: scrollable maps for the selected tier, or every tier when `tier` is
	 *  null (nothing selected). Each row has a play button + (async) rank detail. */
	renderTierMaps(parent: Panel, tier: number | null) {
		const isAll = selectedMode === ALL_MODES;
		const showTier = tier == null; // list spans tiers → show each map's tier
		const entries = this.mapsInTier(tier);
		const done = entries.filter((e) => e.done).length;

		const box = $.CreatePanel('Panel', parent, '', {
			style:
				'flow-children: down; width: 100%; height: 100%; padding: 12px; ' +
				`background-color: #10141a; border: 1px solid ${C_BORDER}; border-radius: 8px;`
		});

		const head = $.CreatePanel('Panel', box, '', {
			style: 'flow-children: right; width: 100%; margin-bottom: 8px;'
		});
		$.CreatePanel('Label', head, '', {
			text: tier == null ? 'All maps' : `Tier ${tier} maps`,
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
			// When the list spans tiers (nothing selected), tag each map with its tier.
			if (showTier) {
				$.CreatePanel('Label', row, '', {
					text: `T${e.tier}`,
					style: 'width: 30px; font-size: 12px; color: #7d8794; text-align: center; vertical-align: center; margin-right: 8px;'
				});
			}
			// Clicking the map name opens the top-10 popup for this (gm, style) board. Attached to the name
			// label (not the whole row) so it never conflicts with the play button's own click.
			const nameColor = e.done ? '#dfe5ec' : '#aeb6c2';
			const nameLabel = $.CreatePanel('Label', row, `StatsMapName${e.data.staticData.id}_${gm}`, {
				text: e.name,
				style: `width: fill-parent-flow(1); font-size: 14px; color: ${nameColor}; vertical-align: center; text-overflow: ellipsis;`
			});
			nameLabel.SetPanelEvent('onactivate', () => this.openMapLeaderboard(e.data.staticData.id, gm, e.style, e.name));
			nameLabel.SetPanelEvent('onmouseover', () => {
				try {
					nameLabel.style.color = C_ACCENT;
				} catch {}
				UiToolkitAPI.ShowTextTooltip(nameLabel.id, 'View top 10 times');
			});
			nameLabel.SetPanelEvent('onmouseout', () => {
				try {
					nameLabel.style.color = nameColor;
				} catch {}
				UiToolkitAPI.HideTextTooltip();
			});
			// In the "All" view, show which gamemode each map belongs to.
			if (isAll) {
				$.CreatePanel('Label', row, '', {
					text: $.Localize(GamemodeInfo.get(gm)?.i18n ?? '') || `Mode ${gm}`,
					style: 'width: 120px; font-size: 12px; color: #7d8794; text-align: right; vertical-align: center; margin-right: 10px;'
				});
			}

			// Per-map rank detail (group · placement · time · WR diff). Filled from cache now if the rank
			// scan already covered this map, otherwise left blank and filled in place when the scan lands —
			// this never blocks the tier list from showing. The fixed width reserves the columns so rows
			// don't shift when the data arrives.
			const rankInfo = $.CreatePanel('Panel', row, '', {
				style: 'flow-children: right; width: 310px; vertical-align: center; margin-right: 10px;'
			});
			const rankKey = this.perMapKey(e.data.staticData.id, gm, e.style);
			this.fillRankInfo(rankInfo, perMapRank[rankKey]);
			tierRankRows.push({ key: rankKey, panel: rankInfo });

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
				this.pauseRankScan(6); // free the HTTP client so the launch/download starts at once, not after the scan
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
				this.pauseRankScan(6); // keep HTTP free for the whole download; scan resumes ~6s after it ends
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

	/** Maps in a tier (one mode, or all modes in the "All" view) — or every tier when `tier` is null.
	 *  Sorted by tier, then incomplete first, then alphabetical. */
	mapsInTier(
		tier: number | null
	): { data: MapCacheAPI.MapData; name: string; done: boolean; mode: Gamemode; style: Style; tier: number }[] {
		const maps = scanCache ?? [];
		const isAll = selectedMode === ALL_MODES;
		const modes = isAll ? available : [selectedMode as Gamemode];
		const out: { data: MapCacheAPI.MapData; name: string; done: boolean; mode: Gamemode; style: Style; tier: number }[] =
			[];

		for (const gm of modes) {
			const style = isAll
				? (GamemodeDefaultUIStyle.get(gm) ?? Style.NORMAL)
				: (selectedStyle ?? GamemodeDefaultUIStyle.get(gm) ?? Style.NORMAL);

			for (const data of maps) {
				if (data.staticData.status !== MapStatus.APPROVED) continue; // exclude beta/testing/submission maps

				const lb = getTrack(data.staticData, gm, TrackType.MAIN, 1, style);
				if (!lb || !lb.tier) continue; // need a real tier
				if (tier != null && lb.tier !== tier) continue; // a specific tier was selected

				const isRanked = lb.type === LeaderboardType.RANKED;
				const isUnranked = lb.type === LeaderboardType.UNRANKED;
				if (!isRanked && !isUnranked) continue;
				if (rankFilter === 'ranked' && !isRanked) continue;
				if (rankFilter === 'unranked' && !isUnranked) continue;

				const done = this.isDone(data, gm, style);
				out.push({ data, name: data.staticData.name, done, mode: gm, style, tier: lb.tier });
			}
		}

		// Completed maps first, then (within each) low→high tier, then alphabetical. So the all-maps view
		// reads: all completed by tier, then all incomplete by tier.
		out.sort((a, b) =>
			a.done !== b.done ? (a.done ? -1 : 1) : a.tier !== b.tier ? a.tier - b.tier : a.name.localeCompare(b.name)
		);
		return out;
	}

	//#region per-map rank cell (tier map list)

	perMapKey(mapID: number, gm: Gamemode, style: Style): string {
		return `${mapID}|${gm}|${style}`;
	}

	/** Refill a shown tier-map row's rank cell after its per-map data updates (no-op if it isn't shown). */
	updateTierRankRow(key: string) {
		const ref = tierRankRows.find((r) => r.key === key);
		if (ref && ref.panel.IsValid()) this.fillRankInfo(ref.panel, perMapRank[key]);
	}

	/**
	 * Fill one tier-map row's rank cell: group · placement · time · WR diff. `d` undefined = not scanned
	 * yet (left blank, filled later by updateTierRankRow); rank null = scanned, but you're not on the
	 * current board. Group/WR-diff need phase 2, so they read "…" until the percentile pass lands.
	 */
	fillRankInfo(container: Panel, d?: PerMapRank) {
		if (!container?.IsValid()) return;
		container.RemoveAndDeleteChildren();
		if (!d) return; // not scanned yet — stays blank

		const W_G = 76;
		const W_R = 46;
		const W_T = 84;
		const W_D = 72;
		const col = (text: string, color: string, width: number) =>
			$.CreatePanel('Label', container, '', {
				text,
				style: `width: ${width}px; font-size: 13px; color: ${color}; text-align: right; vertical-align: center; margin-left: 8px;`
			});

		if (d.rank == null) {
			// The board query came back empty — e.g. the leaderboard was re-versioned since your PB.
			col('', '#6f7885', W_G);
			col('—', '#6f7885', W_R);
			col('not ranked', '#6f7885', W_T + W_D + 8);
			return;
		}

		// Classification. WR (rank 1) and Top 10 outrank the numeric groups — a Top-10 map is marked as
		// such, never G1. Those two need only the rank (shown at once); G#/No group waits on phase 2.
		if (d.rank === 1) {
			col('WR', RANK_WR_COLOR, W_G);
		} else if (d.rank <= 10) {
			col('TOP 10', RANK_T10_COLOR, W_G);
		} else if (d.total != null) {
			const g = this.bestGroup(d.rank, d.total);
			col(g >= 1 ? `G${g}` : 'No group', g >= 1 ? GROUP_COLORS[g - 1] : '#6f7885', W_G);
		} else {
			col('…', '#6f7885', W_G);
		}
		col(`#${d.rank}`, d.rank === 1 ? RANK_WR_COLOR : '#cdd5df', W_R); // placement
		col(d.time != null ? this.fmtTime(d.time) : '—', '#b8c0cc', W_T); // your time
		// Gap to the WR (from the phase-2 rank-1 time). Blank for the WR itself (the group cell says WR).
		if (d.rank === 1) {
			col('—', '#6f7885', W_D);
		} else if (d.wrTime != null && d.time != null) {
			col(`+${this.fmtDiff(Math.max(0, d.time - d.wrTime))}`, '#e0a86f', W_D);
		} else {
			col(d.total != null ? '—' : '…', '#6f7885', W_D);
		}
	}

	/** Seconds → `m:ss.SS` (or `ss.SS` under a minute). `decimals` fractional digits (popup passes 3). */
	fmtTime(t: number, decimals = 2): string {
		if (t == null || !isFinite(t)) return '—';
		const m = Math.floor(t / 60);
		const s = t - m * 60;
		const ss = s.toFixed(decimals).padStart(3 + decimals, '0'); // 2 int digits + '.' + decimals
		return m > 0 ? `${m}:${ss}` : ss;
	}

	/** A positive time delta, compact (`s.SS`, or `m:ss.SS` past a minute). `decimals` digits (popup passes 3). */
	fmtDiff(t: number, decimals = 2): string {
		if (t < 60) return t.toFixed(decimals);
		const m = Math.floor(t / 60);
		const s = t - m * 60;
		return `${m}:${s.toFixed(decimals).padStart(3 + decimals, '0')}`;
	}

	//#endregion

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
	 * Whether the viewed user (the local player, or a searched remote user) has completed a map's
	 * main track for this mode/style.
	 */
	isDone(map: MapCacheAPI.MapData, gm: Gamemode, style: Style): boolean {
		if (remoteDone) {
			// Remote user: completion comes from their API personal-bests, keyed by the *leaderboard*
			// style exactly as /v1/runs reports it — climb runs come back at Pro(8)/Teleport(9), normal
			// modes at 0 (or their real run style). So no Pro/Teleport→0 remap here (unlike local).
			return remoteDone.has(this.doneKey(map.staticData.id, gm, TrackType.MAIN, 1, style));
		}
		// Local player: read from the local map cache. The game records completion at the run style
		// (mom_style); Pro/Teleport are climb *leaderboard* classifications (not run styles) stored at
		// style 0. Every other style is a real run style under its own key — so a Normal run never
		// counts as Sideways/W-only/etc.
		const userData = map.userData;
		if (!userData) return false;
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
