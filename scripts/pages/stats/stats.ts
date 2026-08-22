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

const MAX_ID = 3000; // hard ceiling for the id scan
const MISS_STOP = 600; // stop after this many consecutive empty ids (only once we've found some)
const CHUNK = 200; // ids scanned per frame

// Palette
const C_ACCENT = '#6fe0d0';
const C_TRACK = '#39414d';
const C_CARD = '#171b22';
const C_BORDER = '#2a2f38';

const LEFT_CARD_STYLE =
	`flow-children: down; width: 340px; height: 100%; margin-right: 16px; background-color: ${C_CARD}; ` +
	`border: 1px solid ${C_BORDER}; border-radius: 10px; padding: 20px;`;
const RIGHT_CARD_STYLE =
	`flow-children: down; width: fill-parent-flow(1); height: 100%; background-color: ${C_CARD}; ` +
	`border: 1px solid ${C_BORDER}; border-radius: 10px; padding: 20px;`;

@PanelHandler()
class StatsHandler {
	// Called from the page root's onload (fires once the page is actually shown, unlike the
	// PanelLoaded/onPanelLoad hook which runs too early and stalled the chunked scan).
	onLoad() {
		if (scanCache) this.buildAll();
		else this.scan();
	}

	rescan() {
		scanCache = null;
		this.scan();
	}

	/** Chunked id scan of the local map cache. */
	scan() {
		const status = $<Label>('#StatsStatus');
		if (status) status.visible = true; // shown while scanning / empty; hidden once content renders
		$<Panel>('#StatsGamemodeBar')?.RemoveAndDeleteChildren();
		$<Panel>('#StatsContent')?.RemoveAndDeleteChildren();
		$<Panel>('#StatsFilter')?.RemoveAndDeleteChildren();
		leftCard = null; // cards were just deleted; force recreation on next render
		rightCard = null;

		const maps: MapCacheAPI.MapData[] = [];
		let id = 1;
		let misses = 0;

		const keepGoing = () => id <= MAX_ID && !(maps.length > 0 && misses >= MISS_STOP);

		const step = () => {
			let processed = 0;
			while (keepGoing() && processed < CHUNK) {
				let data: MapCacheAPI.MapData | null = null;
				try {
					data = MapCacheAPI.GetMapData(id);
				} catch {
					data = null;
				}

				if (data?.staticData?.leaderboards?.length) {
					maps.push(data);
					misses = 0;
				} else {
					misses++;
				}

				id++;
				processed++;
			}

			if (status) status.text = `Scanning map cache… ${maps.length} maps found`;

			if (keepGoing()) {
				$.Schedule(0, step);
			} else {
				scanCache = maps;
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
	}

	setRank(f: RankFilter) {
		rankFilter = f;
		selectedTier = null; // tier set differs per filter
		this.highlightFilter(); // restyle only, no rebuild
		this.renderContent();
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
	}

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
