import { PanelHandler } from 'util/module-helpers';
import * as Enum from 'util/enum';
import { Gamemode } from 'common/web/enums/gamemode.enum';
import { TrackType } from 'common/web/enums/track-type.enum';
import { Style } from 'common/web/enums/style.enum';
import { LeaderboardType } from 'common/web/enums/leaderboard-type.enum';
import { MapStatus, MapStatuses } from 'common/web/enums/map-status.enum';
import { GamemodeDefaultUIStyle } from 'common/web/maps/gamemode-styles.map';
import { GamemodeInfo } from 'common/gamemode';
import { getTrack, getUserMapDataTrack } from 'common/leaderboard';
import { handlePlayMap, getTier, getAuthorNames } from 'common/maps';
import { LobbyMemberStateChange } from 'common/online';
import type { MemberData } from 'common/online';

// The three bottom-bar filter categories (multi-select checkboxes).
type Category = 'ranked' | 'unranked' | 'beta';
type SortKey = 'name' | 'downloaded' | 'completed' | 'players' | 'tier' | 'author' | 'date' | 'dateAdded';

// One list row: a map resolved for the currently-selected gamemode.
interface Row {
	data: MapCacheAPI.MapData;
	name: string;
	downloaded: boolean;
	completed: boolean;
	tier: number;
	author: string;
	date: string; // authored creation date (info.creationDate)
	dateAdded: string; // added to Momentum (createdAt / submission date)
	category: Category;
}

const C_DL = '#8fca6a'; // "installed" checkmark colour (soft green)
const C_DONE = '#e6c15a'; // "completed" checkmark colour (gold)

// The game exposes no "list all maps" API to JS, so — like the Stats page — we brute-force the
// local map cache by id. Kept module-level so re-opening the page is instant; Refresh re-scans.
const MAX_ID = 6000; // submission ids are sparse; scan the full range so newest maps aren't missed
const CHUNK = 300; // ids per frame

let scanCache: MapCacheAPI.MapData[] | null = null;
let scanning = false;
let scanRetries = 0;

// UI state persists across page re-opens.
let available: Gamemode[] = [];
let selectedMode: Gamemode | null = null;
let selectedMapId: number | null = null;
const filters: Record<Category, boolean> = { ranked: true, unranked: false, beta: false };
let sortKey: SortKey = 'dateAdded'; // default view: newest maps first
let sortAsc = false;

// Best-effort "players in the map lobby" — the C++ lobby API only surfaces member data for the
// lobby WE are in, so this counts members of the current lobby by the map they're on. 0 otherwise.
const memberMaps: Record<string, string> = {}; // steamID -> current map_name

// Column layout — shared between the header and every row so they line up.
const COLS: { key: SortKey; label: string; width: string; align: 'left' | 'right' }[] = [
	{ key: 'name', label: 'Map', width: 'width: fill-parent-flow(1);', align: 'left' },
	{ key: 'downloaded', label: 'Downloaded', width: 'width: 116px;', align: 'left' },
	{ key: 'completed', label: 'Completed', width: 'width: 104px;', align: 'left' },
	{ key: 'players', label: 'Players', width: 'width: 78px;', align: 'right' },
	{ key: 'tier', label: 'Tier', width: 'width: 64px;', align: 'right' },
	{ key: 'author', label: 'Authors', width: 'width: 300px;', align: 'left' },
	{ key: 'date', label: 'Date Created', width: 'width: 128px;', align: 'left' },
	{ key: 'dateAdded', label: 'Date Added', width: 'width: 128px;', align: 'left' }
];

@PanelHandler()
class CssMapSelectorHandler {
	// Live references to each row's Players label so lobby updates can refresh them in place.
	rowPlayerLabels: { name: string; label: Label }[] = [];
	tabBtns: { key: Gamemode; panel: Panel }[] = [];
	filterBtns: { key: Category; panel: Panel }[] = [];
	rowDownloadedLabels: { id: number; label: Label }[] = []; // Downloaded cells, for live install updates
	connectingMapId: number | null = null; // map we last pressed Connect on (for download feedback)
	dlSize = 0; // total bytes of the in-flight download (from MapDownload_Size)

	constructor() {
		// Re-scan when the page is shown if the cache is empty (e.g. opened before the cache was ready).
		$.RegisterForUnhandledEvent('MainMenuPageShown', (page: string) => {
			if (page === 'CssMapSelector' && !scanCache && !scanning) this.scan();
		});

		// Track current-lobby occupancy for the Players column (best-effort — see memberMaps note).
		$.RegisterForUnhandledEvent('PanoramaComponent_SteamLobby_OnMemberDataUpdated', (data) =>
			this.onLobbyMemberData(data)
		);
		$.RegisterForUnhandledEvent('PanoramaComponent_SteamLobby_OnMemberStateChanged', (sid, change) =>
			this.onLobbyMemberState(sid, change)
		);
		$.RegisterForUnhandledEvent('PanoramaComponent_SteamLobby_OnLobbyStateChanged', (state) => {
			if (state === LobbyMemberStateChange.LEAVE) {
				for (const k of Object.keys(memberMaps)) delete memberMaps[k];
				this.updatePlayerCounts();
			}
		});

		// Connect on a not-yet-downloaded map queues a download; surface its progress in the status line
		// (otherwise Connect looks like it does nothing — the custom list has no per-row download UI).
		$.RegisterForUnhandledEvent('MapDownload_Size', (id, size) => {
			if (id === this.connectingMapId) this.dlSize = Number(size) || 0;
		});
		$.RegisterForUnhandledEvent('MapDownload_Progress', (id, _chunk, offset) => {
			if (id !== this.connectingMapId || !this.dlSize) return;
			const pct = Math.min(100, Math.round((Number(offset) / this.dlSize) * 100));
			this.setStatus(`${this.nameFor(id)}: downloading… ${pct}%`);
		});
		$.RegisterForUnhandledEvent('MapDownload_End', (id, error) => {
			if (id !== this.connectingMapId) return;
			this.dlSize = 0;
			if (!error) {
				// Mark installed in the cached snapshot and flip the row's Downloaded cell in place.
				const m = (scanCache ?? []).find((mm) => mm.staticData.id === id);
				if (m) m.mapFileExists = true;
				const ref = this.rowDownloadedLabels.find((r) => r.id === id);
				if (ref?.label.IsValid()) {
					ref.label.text = '✓';
					try {
						ref.label.style.color = C_DL;
					} catch {}
				}
			}
			this.setStatus(
				error
					? `${this.nameFor(id)}: download failed.`
					: `${this.nameFor(id)}: downloaded — press Connect to play.`
			);
		});
		// Fires after a play attempt: true = the map started (menu will close), false = downloading/failed.
		$.RegisterForUnhandledEvent('MapSelector_TryPlayMap_Outcome', (wasSuccessful) => {
			$.Msg(`[CssMaps] TryPlayMap outcome: ${wasSuccessful} (connecting id ${this.connectingMapId})`);
		});
	}

	/** Fires once the page is actually shown (the root panel's onload). */
	onLoad() {
		if (scanCache) this.buildAll();
		else if (!scanning) this.scan();
	}

	//#region map-cache scan

	/** Chunked id scan of the local map cache, mirroring the Stats page approach. */
	scan() {
		if (scanning) return;
		scanning = true;
		this.setStatus('Scanning map cache…');

		const maps: MapCacheAPI.MapData[] = [];
		let id = 1;

		const step = () => {
			let processed = 0;
			while (id <= MAX_ID && processed < CHUNK) {
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

			this.setStatus(`Scanning map cache… ${maps.length} maps`);

			if (id <= MAX_ID) {
				$.Schedule(0, step);
				return;
			}

			scanning = false;
			scanCache = maps.length > 0 ? maps : null;
			if (maps.length > 0) {
				scanRetries = 0;
			} else if (scanRetries < 6) {
				// Cache probably isn't ready yet — retry a few times.
				scanRetries++;
				$.Schedule(5, () => {
					if (!scanCache && !scanning) this.scan();
				});
			}
			this.buildAll();
		};

		step();
	}

	/** After a scan (or re-open): decide available gamemodes, pick one, then draw everything. */
	buildAll() {
		const maps = scanCache ?? [];
		available = Enum.fastValuesNumeric(Gamemode).filter((gm) => maps.some((m) => this.buildRow(m, gm, true)));

		if (selectedMode == null || !available.includes(selectedMode)) {
			let meta: Gamemode | null = null;
			try {
				meta = GameModeAPI.GetMetaGameMode();
			} catch {
				meta = null;
			}
			selectedMode = meta != null && available.includes(meta) ? meta : (available[0] ?? null);
		}

		this.renderTabs();
		this.renderHead();
		this.renderFilters();
		this.renderList();
	}

	//#endregion
	//#region row building

	/**
	 * Resolve a cached map to a list row for a gamemode, or null if it doesn't belong here.
	 * `ignoreFilter` (used for the tab availability check) keeps a row regardless of the
	 * ranked/unranked/beta checkboxes.
	 */
	buildRow(map: MapCacheAPI.MapData, gm: Gamemode, ignoreFilter = false): Row | null {
		const sd = map.staticData;
		const status = sd.status;
		const isBeta = MapStatuses.IN_SUBMISSION.includes(status);
		const isApproved = status === MapStatus.APPROVED;
		if (!isApproved && !isBeta) return null; // disabled / rejected

		const style = GamemodeDefaultUIStyle.get(gm) ?? Style.NORMAL;
		const board = getTrack(sd, gm, TrackType.MAIN, 1, style);
		const tier = getTier(sd, gm, TrackType.MAIN, 1);

		let category: Category;
		if (isApproved) {
			if (!board) return null; // not playable in this mode
			if (board.type === LeaderboardType.RANKED) category = 'ranked';
			else if (board.type === LeaderboardType.UNRANKED) category = 'unranked';
			else return null; // hidden / in-submission board — skip
		} else {
			// Beta map: only list it if it has a tier for this mode — a proxy for a leaderboard having
			// been created for that gamemode/track (submitted maps without one aren't playable here yet).
			if (!tier) return null;
			category = 'beta';
		}

		if (!ignoreFilter && !filters[category]) return null;

		// Local completion (same model as the Stats page): climb's Pro/Teleport are leaderboard
		// classifications, but runs are recorded at run-style 0, so map those back before the lookup.
		const trackStyle = style === Style.PRO || style === Style.TELEPORT ? 0 : style;
		const completed = getUserMapDataTrack(map.userData, gm, TrackType.MAIN, 1, trackStyle)?.completed ?? false;

		return {
			data: map,
			name: sd.name,
			downloaded: map.mapFileExists,
			completed,
			tier: tier ?? board?.tier ?? 0,
			author: getAuthorNames(sd) || '—',
			// info.creationDate = the map's authored creation date.
			date: this.fmtDate(sd.info?.creationDate),
			// "Date Added" = when the map went live: released date (info.approvedDate) for approved
			// (ranked/unranked) maps, else when it entered beta (createdAt).
			dateAdded: this.fmtDate(isApproved ? (sd.info?.approvedDate ?? sd.createdAt) : sd.createdAt),
			category
		};
	}

	/** Build, filter, and sort the rows for the current gamemode + filters. */
	computeRows(): Row[] {
		const maps = scanCache ?? [];
		if (selectedMode == null) return [];
		const rows: Row[] = [];
		for (const m of maps) {
			const r = this.buildRow(m, selectedMode);
			if (r) rows.push(r);
		}

		const dir = sortAsc ? 1 : -1;
		rows.sort((a, b) => {
			switch (sortKey) {
				case 'downloaded':
					return dir * (Number(b.downloaded) - Number(a.downloaded) || a.name.localeCompare(b.name));
				case 'completed':
					return dir * (Number(b.completed) - Number(a.completed) || a.name.localeCompare(b.name));
				case 'players':
					return dir * (this.countForMap(a.name) - this.countForMap(b.name) || a.name.localeCompare(b.name));
				case 'tier':
					return dir * (a.tier - b.tier || a.name.localeCompare(b.name));
				case 'author':
					return dir * (a.author.localeCompare(b.author) || a.name.localeCompare(b.name));
				case 'date':
					return dir * (a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
				case 'dateAdded':
					return dir * (a.dateAdded.localeCompare(b.dateAdded) || a.name.localeCompare(b.name));
				default:
					return dir * a.name.localeCompare(b.name);
			}
		});
		return rows;
	}

	//#endregion
	//#region rendering

	renderTabs() {
		const bar = $<Panel>('#CssMapsTabs');
		if (!bar) return;
		bar.RemoveAndDeleteChildren();
		this.tabBtns = [];

		for (const gm of available) {
			const info = GamemodeInfo.get(gm);
			const tab = $.CreatePanel('Panel', bar, '', { class: 'cssmaps__tab' });
			tab.SetPanelEvent('onactivate', () => this.selectMode(gm));
			$.CreatePanel('Image', tab, '', {
				class: 'cssmaps__tab-icon',
				src: `file://{images}/gamemodes/${info?.icon ?? 'null'}.svg`,
				textureheight: 24
			});
			$.CreatePanel('Label', tab, '', {
				class: 'cssmaps__tab-label',
				text: $.Localize(info?.i18n ?? '') || `Mode ${gm}`
			});
			this.tabBtns.push({ key: gm, panel: tab });
		}
		this.highlightTabs();
	}

	highlightTabs() {
		for (const t of this.tabBtns) {
			if (t.panel.IsValid()) t.panel.SetHasClass('cssmaps__tab--active', t.key === selectedMode);
		}
	}

	renderHead() {
		const head = $<Panel>('#CssMapsHead');
		if (!head) return;
		head.RemoveAndDeleteChildren();

		for (const col of COLS) {
			const cell = $.CreatePanel('Panel', head, '', { class: 'cssmaps__head-cell', style: col.width });
			cell.SetPanelEvent('onactivate', () => this.setSort(col.key));
			$.CreatePanel('Label', cell, '', { class: 'cssmaps__head-text', text: col.label });
			if (sortKey === col.key) {
				$.CreatePanel('Label', cell, '', { class: 'cssmaps__head-arrow', text: sortAsc ? '▲' : '▼' });
			}
		}
	}

	renderFilters() {
		const bar = $<Panel>('#CssMapsFilters');
		if (!bar) return;
		bar.RemoveAndDeleteChildren();
		this.filterBtns = [];

		const opts: [Category, string][] = [
			['ranked', 'Ranked'],
			['unranked', 'Unranked'],
			['beta', 'Beta']
		];
		for (const [cat, label] of opts) {
			const item = $.CreatePanel('Panel', bar, '', { class: 'cssmaps__check' });
			item.SetPanelEvent('onactivate', () => this.toggleFilter(cat));
			const box = $.CreatePanel('Panel', item, '', { class: 'cssmaps__check-box' });
			$.CreatePanel('Label', box, '', { class: 'cssmaps__check-tick', text: '✓' });
			$.CreatePanel('Label', item, '', { class: 'cssmaps__check-label', text: label });
			this.filterBtns.push({ key: cat, panel: item });
		}
		this.highlightFilters();
	}

	highlightFilters() {
		for (const f of this.filterBtns) {
			if (f.panel.IsValid()) f.panel.SetHasClass('cssmaps__check--on', filters[f.key]);
		}
	}

	renderList() {
		const list = $<Panel>('#CssMapsList');
		if (!list) return;
		list.RemoveAndDeleteChildren();
		this.rowPlayerLabels = [];
		this.rowDownloadedLabels = [];

		const rows = this.computeRows();

		const count = $<Label>('#CssMapsCount');
		if (count) count.text = `${rows.length} map${rows.length === 1 ? '' : 's'}`;

		const status = $<Label>('#CssMapsStatus');
		if (status) {
			if (scanning) {
				status.visible = true;
				status.text = 'Scanning map cache…';
			} else if (rows.length === 0) {
				status.visible = true;
				status.text = available.length === 0
					? 'No maps found in the cache. Make sure you are online, then press Refresh.'
					: 'No maps match the current filters.';
			} else {
				status.visible = false;
			}
		}

		// If the previously-selected map isn't in this list any more, drop the selection.
		if (selectedMapId != null && !rows.some((r) => r.data.staticData.id === selectedMapId)) {
			selectedMapId = null;
		}
		this.updateConnectButton();

		rows.forEach((row, i) => this.makeRow(list, row, i));
	}

	makeRow(list: Panel, row: Row, index: number) {
		const id = row.data.staticData.id;
		const rowPanel = $.CreatePanel('Panel', list, `CssMapRow${id}`, {
			class: 'cssmaps__row' + (index % 2 === 1 ? ' cssmaps__row--odd' : '')
		});
		if (id === selectedMapId) rowPanel.AddClass('cssmaps__row--selected');
		rowPanel.SetPanelEvent('onactivate', () => this.selectMap(id));
		rowPanel.SetPanelEvent('ondblclick', () => {
			this.selectMap(id);
			this.connect();
		});

		const cellText = (parent: Panel, text: string, col: (typeof COLS)[number], extraClass = '') => {
			const cell = $.CreatePanel('Panel', parent, '', { class: 'cssmaps__cell', style: col.width });
			const lbl = $.CreatePanel('Label', cell, '', {
				class: 'cssmaps__cell-text' + (extraClass ? ' ' + extraClass : ''),
				text,
				style: col.align === 'right' ? 'text-align: right;' : ''
			});
			return lbl;
		};

		cellText(rowPanel, row.name, COLS[0], row.category === 'beta' ? 'cssmaps__cell-text--beta' : '');
		const dlLabel = cellText(rowPanel, row.downloaded ? '✓' : '', COLS[1]);
		if (row.downloaded) {
			try {
				dlLabel.style.color = C_DL;
			} catch {}
		}
		const doneLabel = cellText(rowPanel, row.completed ? '✓' : '', COLS[2]);
		if (row.completed) {
			try {
				doneLabel.style.color = C_DONE;
			} catch {}
		}
		const playersLbl = cellText(rowPanel, `${this.countForMap(row.name)}`, COLS[3]);
		cellText(rowPanel, row.tier ? `${row.tier}` : '—', COLS[4]);
		cellText(rowPanel, row.author, COLS[5]);
		cellText(rowPanel, row.date, COLS[6]);
		cellText(rowPanel, row.dateAdded, COLS[7]);

		this.rowPlayerLabels.push({ name: row.name, label: playersLbl });
		this.rowDownloadedLabels.push({ id, label: dlLabel });
	}

	//#endregion
	//#region interaction

	selectMode(gm: Gamemode) {
		if (gm === selectedMode) return;
		selectedMode = gm;
		selectedMapId = null;
		this.highlightTabs();
		this.renderList();
	}

	toggleFilter(cat: Category) {
		filters[cat] = !filters[cat];
		this.highlightFilters();
		this.renderList();
	}

	setSort(key: SortKey) {
		if (sortKey === key) sortAsc = !sortAsc;
		else {
			sortKey = key;
			sortAsc = true;
		}
		this.renderHead();
		this.renderList();
	}

	selectMap(id: number) {
		if (selectedMapId === id) return;
		const prev = selectedMapId;
		selectedMapId = id;
		if (prev != null) $<Panel>(`#CssMapRow${prev}`)?.RemoveClass('cssmaps__row--selected');
		$<Panel>(`#CssMapRow${id}`)?.AddClass('cssmaps__row--selected');
		this.updateConnectButton();
	}

	updateConnectButton() {
		const btn = $<Button>('#CssMapsConnect');
		if (btn) btn.enabled = selectedMapId != null;
	}

	/** Connect = download or launch the selected map. */
	connect() {
		if (selectedMapId == null) return;
		const map = (scanCache ?? []).find((m) => m.staticData.id === selectedMapId);
		if (!map) return;
		const name = map.staticData.name;
		this.connectingMapId = map.staticData.id;
		this.dlSize = 0;
		// Downloaded maps launch immediately (loads are fast) — no status message; a "Launching…" line
		// would only linger, still showing the next time the menu is reopened. Only downloads, which take
		// time and have no other feedback in this list, get a status line.
		if (!map.mapFileExists) {
			this.setStatus(`${name}: starting download… (Connect again once done)`);
		}
		$.Msg(`[CssMaps] connect: ${name} (id ${map.staticData.id}) fileExists=${map.mapFileExists} gm=${selectedMode}`);
		// selectedMode drives which gamemode the map launches in (null = no override).
		handlePlayMap(map, selectedMode);
	}

	/** Map name for an id, from the scan cache (for download-status messages). */
	nameFor(id: number): string {
		return (scanCache ?? []).find((m) => m.staticData.id === id)?.staticData.name ?? `map ${id}`;
	}

	/** Refresh button — force a fresh cache scan. */
	refresh() {
		scanCache = null;
		selectedMapId = null;
		scanRetries = 0; // give a manual refresh the full retry budget
		this.scan();
	}

	/** Close (title-bar X) — return to the CS:S menu. Cross-context, so via a global event. */
	close() {
		$.DispatchEvent('MainMenu_ClosePage');
	}

	//#endregion
	//#region lobby occupancy (Players column)

	onLobbyMemberData(data: MemberData) {
		if (!data) return;
		for (const [sid, member] of Object.entries(data)) {
			const name = member.map_name;
			if (name) memberMaps[sid] = name;
			else delete memberMaps[sid];
		}
		this.updatePlayerCounts();
	}

	onLobbyMemberState(sid: steamID, change: LobbyMemberStateChange) {
		if (change === LobbyMemberStateChange.LEAVE) {
			delete memberMaps[sid];
			this.updatePlayerCounts();
		}
	}

	countForMap(name: string): number {
		let n = 0;
		for (const map of Object.values(memberMaps)) if (map === name) n++;
		return n;
	}

	/** Refresh the Players cells in place without rebuilding the list. */
	updatePlayerCounts() {
		for (const { name, label } of this.rowPlayerLabels) {
			if (label.IsValid()) label.text = `${this.countForMap(name)}`;
		}
	}

	//#endregion

	setStatus(text: string) {
		const status = $<Label>('#CssMapsStatus');
		if (status) {
			status.visible = true;
			status.text = text;
		}
	}

	/** ISO date string -> YYYY-MM-DD (or em dash if unparseable). */
	fmtDate(date: string): string {
		if (!date) return '—';
		const d = new Date(date);
		if (Number.isNaN(d.getTime())) return '—';
		const m = `${d.getMonth() + 1}`.padStart(2, '0');
		const day = `${d.getDate()}`.padStart(2, '0');
		return `${d.getFullYear()}-${m}-${day}`;
	}
}
