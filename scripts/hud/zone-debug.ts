import { PanelHandler } from 'util/module-helpers';
import * as Timer from 'common/timer';
import type { BonusTrack, MainTrack, MapZones, Region, TrackZones } from 'common/web/types/models/models';
import { readPlayerState } from 'common/player-state';
import { pointInRegion } from 'common/zone-geometry';

/**
 * Zone Debug (research harness)
 * =============================
 * A pure-Panorama HUD element (NO C++ type), placed in `hud.xml` via a <Frame> exactly like the Segment
 * Timer. It's a scratchpad for the two open questions in PANORAMA_NOTES.md §6h:
 *
 *   1. Can we RENDER the timer zones (start / stage / checkpoint / end / cancel) ourselves, so they stay
 *      visible during savestate practice (when the C++ in-world drawing switches off)?
 *   2. Can we DETECT collisions with those zones from JS (i.e. know which zone the player is standing in)?
 *
 * What this proves / tries (see the $.Msg report it prints on every map / zone-defs change):
 *   - Zone GEOMETRY is fully readable: `MomentumTimerAPI.GetActiveZoneDefs()` gives every Region's polygon
 *     (`points: [x,y][]`), `bottom` and `height`. We dump it and draw a 2D TOP-DOWN MINIMAP of every region
 *     on a <UICanvas> — colour-coded like the `mom_zonetype_*_color` convars. This overlay is OURS, so it
 *     stays up during practice regardless of the timer. (It is a schematic map, not a real 3D in-world
 *     projection — there's no world->screen API, see below.)
 *   - C++ zone collision IS surfaced while a run is ACTIVE via `OnObservedTimerStateChange` +
 *     `GetObservedTimerStatus()` (state / majorNum / minorNum). We log every transition so you can watch the
 *     game detect zone entries live — and confirm in-game whether they keep firing under savestate practice.
 *   - Self-computed collision (point-in-polygon + z-range) needs the player's WORLD POSITION, which is NOT
 *     exposed to Panorama (verified against the base game's stubs too). So `discoverPositionSource()` probes a
 *     battery of plausible-but-undocumented getter names at runtime; if ANY returns an [x,y,z] the collision
 *     path + a player dot on the minimap light up automatically. Until then it reports "no position source".
 *
 * Console control (there's no way to register a real concommand from JS): toggle `mom_zone_experimental_appearance`
 * in the console. 0 => hide overlay, 1 => show overlay + re-dump. (That convar also flips the C++ experimental
 * zone appearance, which is handy for the rendering experiment.) Everything else auto-logs, no setup needed.
 *
 * Direct console experiments to try alongside this (pure convars, no code): sweep the draw styles, e.g.
 *   mom_zonetype_stage_draw_style 0..3 ; mom_zonetype_checkpoint_draw_style 0..3 ; mom_zonetype_end_draw_style 0..3
 * to see if any value forces the native zones to always-draw during practice. And `mom_zoning_enable 1` opens the
 * editor, which is the one KNOWN way to see every region during practice (via the C++ ZoneMenu panel).
 */

// Verbose per-frame logging of collision / position results. Leave false; the on-change logs are enough.
const VERBOSE = false;

// Console toggle for the overlay. Toggling it in-game re-runs the dump + probe. Wrapped in try/catch since a
// missing/server convar would otherwise throw (or crash on exit per the RegisterConVarChangeListener warning).
const CONTROL_CONVAR = 'mom_zone_experimental_appearance';

const CANVAS_MARGIN = 10; // px padding around the minimap
const MAX_DRAW_COMMANDS = 4096;

/** How we classify a region for colouring / labelling (mirrors zoning.ts RegionRenderMode, kept local so we
 * don't import the zoning PAGE module and double-register its @PanelHandler). */
enum ZoneKind {
	START,
	MAJOR, // stage start / major checkpoint
	MINOR, // minor checkpoint
	END,
	CANCEL,
	ALLOW_BHOP,
	OVERBOUNCE
}

const KIND_COLOR: Record<ZoneKind, string> = {
	[ZoneKind.START]: 'rgba(0, 255, 0, 0.9)',
	[ZoneKind.MAJOR]: 'rgba(120, 120, 255, 0.9)',
	[ZoneKind.MINOR]: 'rgba(255, 150, 0, 0.9)',
	[ZoneKind.END]: 'rgba(255, 0, 0, 0.9)',
	[ZoneKind.CANCEL]: 'rgba(255, 100, 255, 0.9)',
	[ZoneKind.ALLOW_BHOP]: 'rgba(100, 0, 255, 0.9)',
	[ZoneKind.OVERBOUNCE]: 'rgba(150, 90, 255, 0.9)'
};

const KIND_NAME: Record<ZoneKind, string> = {
	[ZoneKind.START]: 'Start',
	[ZoneKind.MAJOR]: 'Stage',
	[ZoneKind.MINOR]: 'Checkpoint',
	[ZoneKind.END]: 'End',
	[ZoneKind.CANCEL]: 'Cancel',
	[ZoneKind.ALLOW_BHOP]: 'AllowBhop',
	[ZoneKind.OVERBOUNCE]: 'Overbounce'
};

interface FlatRegion {
	region: Region;
	kind: ZoneKind;
	label: string; // e.g. "Main S2 CP1"
	/** Timer majorNum this region belongs to (MAIN track only) so the minimap can highlight the active stage
	 * from GetObservedTimerStatus().majorNum. undefined for bonus tracks + global regions. */
	major?: number;
}

interface Bounds {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

/** A discovered world-position getter: `[x, y, z]` or null if unavailable this frame. */
type PositionFn = () => number[] | null;

@PanelHandler()
class ZoneDebugHandler {
	private readonly panels = {
		root: $<Panel>('#ZoneDebug')!,
		canvas: $<UICanvas>('#ZoneDebugCanvas')!,
		status: $<Panel>('#ZoneDebug')! // dialog vars live on the root
	};

	private zones: MapZones | null = null;
	private flat: FlatRegion[] = [];
	private bounds: Bounds | null = null;

	private overlayOn = false;
	private loadedForMap: string | null = null;

	// Position discovery: name of the source we found (for the report) + the getter itself (null = none).
	private posFn: PositionFn | null = null;
	private posSourceName = '';
	private posProbed = false;

	// Change-detection state for the on-transition logs.
	private lastTimerKey = '';
	private lastZoneKey = '';

	// Live timer status (updated each frame), used to highlight the active stage on the minimap.
	private curMajor = 1;
	private curState: Timer.TimerState = Timer.TimerState.DISABLED;

	// Handle for the convar listener so a stale handler (post-reload) can unregister itself.
	private convarListenerId: uuid | null = null;

	constructor() {
		$.RegisterForUnhandledEvent('LevelInitPostEntity', () => this.onLevelInit());
		$.RegisterForUnhandledEvent('OnZoneDefsSet', (defs) => this.onZonesChanged('OnZoneDefsSet', defs));
		$.RegisterForUnhandledEvent('ActiveZoneDefsChanged', () => this.onZonesChanged('ActiveZoneDefsChanged'));

		try {
			this.convarListenerId = $.RegisterConVarChangeListener(CONTROL_CONVAR, (v: string) => this.onControlConvar(v));
		} catch (e) {
			$.Warning(`[ZoneDebug] could not listen to ${CONTROL_CONVAR}: ${String(e)}`);
		}

		this.setStatus('Zone Debug ready. Toggle ' + CONTROL_CONVAR + ' 1 in console to show the map.');
		this.refreshZones('ctor');
		this.update();
	}

	//#region lifecycle / control

	private onLevelInit(): void {
		this.loadedForMap = null;
		this.posProbed = false;
		this.posFn = null;
		this.posSourceName = '';
		this.lastTimerKey = '';
		this.lastZoneKey = '';
		// Zone defs / map name aren't always ready this exact frame; retry shortly.
		this.refreshZones('LevelInitPostEntity');
		$.Schedule(1.0, () => this.refreshZones('post-init +1s'));
	}

	private onZonesChanged(source: string, defs?: MapZones): void {
		this.zones = defs ?? MomentumTimerAPI.GetActiveZoneDefs() ?? null;
		this.rebuild(source);
	}

	private onControlConvar(value: string): void {
		// A panorama_reload / HUD rebuild constructs a fresh handler + panels + convar listener but does NOT
		// auto-remove the previous handler's listener, whose captured #ZoneDebug is now deleted ("Underlying
		// object is deleted!"). Detect that stale case, unregister ourselves, and bail so only the live handler acts.
		if (!this.panels.root?.IsValid()) {
			if (this.convarListenerId != null) {
				try {
					$.UnregisterConVarChangeListener(this.convarListenerId);
				} catch {
					/* ignore */
				}
				this.convarListenerId = null;
			}
			return;
		}

		const on = value !== '0' && value !== '' && value !== 'false';
		this.overlayOn = on;
		this.panels.root.SetHasClass('zonedebug--open', on);
		$.Msg(`[ZoneDebug] ${CONTROL_CONVAR}="${value}" -> overlay ${on ? 'ON' : 'OFF'}`);
		if (on) {
			this.refreshZones('convar');
			this.report();
		}
	}

	private refreshZones(source: string): void {
		let defs: MapZones | null = null;
		try {
			defs = MomentumTimerAPI.GetActiveZoneDefs() ?? null;
		} catch (e) {
			$.Warning(`[ZoneDebug] GetActiveZoneDefs threw: ${String(e)}`);
		}
		this.zones = defs;
		this.rebuild(source);

		// One capability report per map, as soon as we actually have zones.
		const mapName = MapCacheAPI.GetMapName();
		if (this.flat.length > 0 && mapName && this.loadedForMap !== mapName) {
			this.loadedForMap = mapName;
			this.report();
		}
	}

	//#endregion
	//#region zone flattening + bounds

	private rebuild(source: string): void {
		this.flat = [];
		this.bounds = null;

		if (this.zones?.tracks) {
			if (this.zones.tracks.main) this.flattenTrack(this.zones.tracks.main, 'Main', true);
			for (const [i, bonus] of this.zones.tracks.bonuses?.entries() ?? []) {
				this.flattenTrack(bonus, `Bonus${i + 1}`, false);
			}
		}
		for (const r of this.zones?.globalRegions?.allowBhop ?? [])
			this.flat.push({ region: r, kind: ZoneKind.ALLOW_BHOP, label: 'Global AllowBhop' });
		for (const r of this.zones?.globalRegions?.cancel ?? [])
			this.flat.push({ region: r, kind: ZoneKind.CANCEL, label: 'Global Cancel' });
		for (const r of this.zones?.globalRegions?.overbounce ?? [])
			this.flat.push({ region: r, kind: ZoneKind.OVERBOUNCE, label: 'Global Overbounce' });

		this.bounds = this.computeBounds(this.flat);

		if (VERBOSE) $.Msg(`[ZoneDebug] rebuild(${source}): ${this.flat.length} regions`);
	}

	private flattenTrack(track: MainTrack | BonusTrack, tag: string, isMain: boolean): void {
		const zones: TrackZones | undefined = track.zones;
		if (!zones) return; // defrag bonus shares main's zones and has none of its own

		for (const [si, segment] of zones.segments?.entries() ?? []) {
			const major = isMain ? si + 1 : undefined; // timer majorNum for this segment
			for (const [ci, checkpoint] of segment.checkpoints?.entries() ?? []) {
				const kind = ci === 0 ? (si === 0 ? ZoneKind.START : ZoneKind.MAJOR) : ZoneKind.MINOR;
				const label = `${tag} S${si + 1} ${ci === 0 ? (si === 0 ? 'Start' : 'StageStart') : 'CP' + ci}`;
				for (const region of checkpoint.regions ?? []) this.flat.push({ region, kind, label, major });
			}
			for (const [zi, cancel] of segment.cancel?.entries() ?? []) {
				for (const region of cancel.regions ?? [])
					this.flat.push({ region, kind: ZoneKind.CANCEL, label: `${tag} S${si + 1} Cancel${zi + 1}`, major });
			}
		}
		// The end zone is reached at majorNum = segmentsCount + 1.
		const endMajor = isMain ? (zones.segments?.length ?? 0) + 1 : undefined;
		for (const region of zones.end?.regions ?? [])
			this.flat.push({ region, kind: ZoneKind.END, label: `${tag} End`, major: endMajor });
	}

	private computeBounds(flat: FlatRegion[]): Bounds | null {
		let minX = Infinity,
			minY = Infinity,
			maxX = -Infinity,
			maxY = -Infinity;
		for (const { region } of flat) {
			for (const p of region.points ?? []) {
				if (p[0] < minX) minX = p[0];
				if (p[0] > maxX) maxX = p[0];
				if (p[1] < minY) minY = p[1];
				if (p[1] > maxY) maxY = p[1];
			}
		}
		return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
	}

	//#endregion
	//#region reporting / probes

	/** One-shot capability + geometry report to the console. */
	private report(): void {
		$.Msg('========== [ZoneDebug] report ==========');
		$.Msg(`[ZoneDebug] map="${MapCacheAPI.GetMapName()}"  regions=${this.flat.length}`);

		if (!this.zones) {
			$.Msg('[ZoneDebug] GetActiveZoneDefs() returned nothing (no zones loaded / not on a map yet).');
		} else {
			$.Msg(
				`[ZoneDebug] formatVersion=${this.zones.formatVersion} maxVelocity=${this.zones.maxVelocity ?? '-'} ` +
					`main=${this.zones.tracks?.main ? 'yes' : 'no'} bonuses=${this.zones.tracks?.bonuses?.length ?? 0}`
			);
			for (const { region, kind, label } of this.flat) {
				const c = this.centroid(region);
				$.Msg(
					`[ZoneDebug]   ${label} [${KIND_NAME[kind]}] pts=${region.points?.length ?? 0} ` +
						`bottom=${fmt(region.bottom)} height=${fmt(region.height)} ` +
						`centroid=(${fmt(c[0])}, ${fmt(c[1])})`
				);
			}
			if (this.bounds) {
				const b = this.bounds;
				$.Msg(
					`[ZoneDebug] world XY bounds: x[${fmt(b.minX)}..${fmt(b.maxX)}] y[${fmt(b.minY)}..${fmt(b.maxY)}]`
				);
			}
		}

		this.probeLegacyZonesApi();
		this.ensurePositionProbe(true);
		this.probeTimer();
		$.Msg('========================================');
	}

	/** The old ZonesAPI (marked "Old API (I think)") — CONFIRMED removed: `typeof ZonesAPI` is 'undefined' at
	 * runtime (in-game it threw ReferenceError). So there's no live "current zone index" getter; the only
	 * per-zone signal is the timer's majorNum/minorNum during an active run (see checkTimerTransition). */
	private probeLegacyZonesApi(): void {
		// `typeof` on an undeclared global is safe (returns 'undefined', never throws), unlike touching it.
		if (typeof ZonesAPI === 'undefined') {
			$.Msg('[ZoneDebug] ZonesAPI: not defined (legacy API removed — no live zone-index getter exists).');
			return;
		}
		const tryCall = (name: string, fn: () => unknown) => {
			try {
				$.Msg(`[ZoneDebug] ZonesAPI.${name} -> ${JSON.stringify(fn())}`);
			} catch (e) {
				$.Msg(`[ZoneDebug] ZonesAPI.${name} threw: ${String(e)}`);
			}
		};
		tryCall('GetZoneCount()', () => (ZonesAPI as any).GetZoneCount?.());
		tryCall('GetCurrentZone()', () => (ZonesAPI as any).GetCurrentZone?.());
		tryCall('GetZoneSpeed(1,false)', () => (ZonesAPI as any).GetZoneSpeed?.(1, false));
	}

	/** Establish a player world-position source for self-collision + the player dot. First tries an undocumented
	 * direct getter (none exist in this build); otherwise falls back to the show-pos global bridge (the C++
	 * Pos/Ang HUD via cl_showpos - see common/player-state.ts). */
	private ensurePositionProbe(logReport: boolean): void {
		if (this.posProbed) {
			if (logReport) $.Msg(`[ZoneDebug] position source: ${this.posSourceName}`);
			return;
		}
		this.posProbed = true;

		const candidates: { obj: unknown; objName: string; methods: string[] }[] = [
			{
				obj: MomentumPlayerAPI,
				objName: 'MomentumPlayerAPI',
				methods: [
					'GetPosition',
					'GetOrigin',
					'GetAbsOrigin',
					'GetLocalOrigin',
					'GetLastPos',
					'GetCenter',
					'GetEyePosition',
					'GetFeetPosition',
					'GetViewOffset'
				]
			},
			{
				obj: MomentumMovementAPI,
				objName: 'MomentumMovementAPI',
				methods: ['GetPosition', 'GetOrigin', 'GetLastPos', 'GetPlayerPos']
			}
		];

		for (const { obj, objName, methods } of candidates) {
			for (const m of methods) {
				try {
					const fn = (obj as any)?.[m];
					if (typeof fn !== 'function') continue;
					const triple = asTriple(fn.call(obj));
					if (triple) {
						this.posFn = () => asTriple((obj as any)[m].call(obj));
						this.posSourceName = `${objName}.${m}()`;
						if (logReport) $.Msg(`[ZoneDebug] FOUND position source: ${this.posSourceName} = ${JSON.stringify(triple)}`);
						return;
					}
				} catch {
					// method doesn't exist or needs args — keep probing
				}
			}
		}

		// No direct getter (expected). Fall back to the show-pos global bridge: show-pos.ts forces cl_showpos 1
		// and publishes the parsed Pos/Ang each frame. Returns null until that data flows (Pos/Ang HUD must be
		// enabled in the customizer AND cl_showpos on), which the collision/dot code already null-guards.
		this.posFn = () => readPlayerState()?.pos ?? null;
		this.posSourceName = 'show-pos bridge (cl_showpos → global) — enable the Pos/Ang HUD in the customizer';
		if (logReport) $.Msg(`[ZoneDebug] position source: ${this.posSourceName}`);
	}

	private probeTimer(): void {
		try {
			const s = MomentumTimerAPI.GetObservedTimerStatus();
			$.Msg(
				`[ZoneDebug] timer: state=${Timer.TimerState[s.state]} major=${s.majorNum} minor=${s.minorNum} ` +
					`segments=${s.segmentsCount} cps=${s.segmentCheckpointsCount}`
			);
		} catch (e) {
			$.Msg(`[ZoneDebug] GetObservedTimerStatus threw: ${String(e)}`);
		}
	}

	//#endregion
	//#region per-frame loop

	private update(): void {
		if (!this.panels.root?.IsValid()) return;

		let s: Timer.TimerStatus | null = null;
		try {
			s = MomentumTimerAPI.GetObservedTimerStatus();
		} catch {
			/* off-map / not observing */
		}
		if (s) {
			this.curMajor = s.majorNum;
			this.curState = s.state;
			this.checkTimerTransition(s);
		}

		if (this.posFn) this.logZoneOccupancy();

		if (this.overlayOn) this.draw();

		$.Schedule(0, () => this.update());
	}

	/** Log whenever the C++ timer's zone position changes (this IS the game's own collision detection: majorNum
	 * increments as you enter each stage's start zone during an active run; it's frozen at 1 in DISABLED/practice). */
	private checkTimerTransition(s: Timer.TimerStatus): void {
		const key = `${s.state}/${s.majorNum}/${s.minorNum}`;
		if (key !== this.lastTimerKey) {
			this.lastTimerKey = key;
			$.Msg(`[ZoneDebug] timer transition -> state=${Timer.TimerState[s.state]} major=${s.majorNum} minor=${s.minorNum}`);
			this.setStatus(`Stage ${s.majorNum} · ${Timer.TimerState[s.state]}`);
		}
	}

	/** Self-computed collision (only runs if a position source was discovered). */
	private logZoneOccupancy(): void {
		const pos = this.posFn!();
		if (!pos) return;
		const inside = this.flat.filter((f) => pointInRegion(pos, f.region));
		const key = inside.map((f) => f.label).join(',');
		if (VERBOSE) $.Msg(`[ZoneDebug] pos=(${fmt(pos[0])},${fmt(pos[1])},${fmt(pos[2])}) inside=[${key}]`);
		if (key !== this.lastZoneKey) {
			this.lastZoneKey = key;
			$.Msg(`[ZoneDebug] zone occupancy -> [${key || 'none'}] at (${fmt(pos[0])},${fmt(pos[1])},${fmt(pos[2])})`);
			this.setStatus(`In zone: ${key || 'none'}`);
		}
	}

	//#endregion
	//#region 2D minimap drawing

	private draw(): void {
		const canvas = this.panels.canvas;
		if (!canvas?.IsValid()) return;

		const W = canvas.actuallayoutwidth / canvas.actualuiscale_x;
		const H = canvas.actuallayoutheight / canvas.actualuiscale_y;
		if (!W || !H) return;

		canvas.SetMaxDrawCommands(MAX_DRAW_COMMANDS);
		canvas.Clear('#00000000');

		if (!this.bounds || this.flat.length === 0) return;

		const b = this.bounds;
		const spanX = Math.max(b.maxX - b.minX, 1);
		const spanY = Math.max(b.maxY - b.minY, 1);
		const scale = Math.min((W - 2 * CANVAS_MARGIN) / spanX, (H - 2 * CANVAS_MARGIN) / spanY);
		// world (x,y) -> screen. Invert Y so world +Y (north) points up on screen.
		const sx = (x: number) => CANVAS_MARGIN + (x - b.minX) * scale;
		const sy = (y: number) => H - (CANVAS_MARGIN + (y - b.minY) * scale);

		// Highlight the active stage (the one collision signal we have): majorNum during an active run.
		const runActive = this.curState === Timer.TimerState.RUNNING || this.curState === Timer.TimerState.PRIMED;

		for (const { region, kind, major } of this.flat) {
			const pts = region.points ?? [];
			if (pts.length < 2) continue;
			const coords: number[] = [];
			for (const p of pts) coords.push(sx(p[0]), sy(p[1]));
			// close the loop back to the first point
			coords.push(sx(pts[0][0]), sy(pts[0][1]));
			const active = runActive && major != null && major === this.curMajor;
			canvas.DrawLinePoints(pts.length + 1, coords, active ? 5 : 2, active ? 'rgba(255,255,0,1)' : KIND_COLOR[kind]);
		}

		// Player marker (only when a position source exists).
		if (this.posFn) {
			const pos = this.posFn();
			if (pos) canvas.DrawFilledCircle(sx(pos[0]), sy(pos[1]), 4, 'rgba(255,255,255,1)');
		}
	}

	//#endregion

	private centroid(region: Region): [number, number] {
		const pts = region.points ?? [];
		if (pts.length === 0) return [0, 0];
		let x = 0,
			y = 0;
		for (const p of pts) {
			x += p[0];
			y += p[1];
		}
		return [x / pts.length, y / pts.length];
	}

	private setStatus(text: string): void {
		if (!this.panels.status?.IsValid()) return;
		this.panels.status.SetDialogVariable('zd_status', text);
		this.panels.status.SetDialogVariable('zd_title', 'ZONE DEBUG');
	}
}

//#region free helpers

/** Format a number for logs (short, handles undefined). */
function fmt(n: number | undefined): string {
	return n == null || Number.isNaN(n) ? '-' : n.toFixed(1);
}

/** Coerce an unknown value into an [x,y,z] number triple, or null. Accepts arrays and {x,y,z} objects. */
function asTriple(v: unknown): number[] | null {
	if (Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every((n) => typeof n === 'number' && Number.isFinite(n))) {
		return [v[0], v[1], v[2]];
	}
	if (v && typeof v === 'object') {
		const o = v as Record<string, unknown>;
		const x = o.x ?? o[0],
			y = o.y ?? o[1],
			z = o.z ?? o[2];
		if ([x, y, z].every((n) => typeof n === 'number' && Number.isFinite(n as number))) {
			return [x as number, y as number, z as number];
		}
	}
	return null;
}

//#endregion
