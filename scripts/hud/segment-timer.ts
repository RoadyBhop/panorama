import { PanelHandler } from 'util/module-helpers';
import * as Timer from 'common/timer';
import { CustomizerPropertyType, registerHUDCustomizerComponent, getTextShadowFast } from 'common/hud-customizer';

/**
 * Segment Timer
 * =============
 * A pure-Panorama HUD element (NO new C++ panel type). Placed in `hud.xml` via a <Frame> and registered
 * with the JS HUD customizer like any other component - proof that HUD elements don't require engine work.
 *
 * `mom_savestate_create` / `+mom_savestate_load` drop you into practice mode and wipe the real run timer.
 * This keeps an INDEPENDENT "spliced" virtual run time that survives savestate practice: it only accumulates
 * real gameplay progress. Creating a savestate snapshots the current time; loading a savestate rewinds to
 * that snapshot, so failed retries are discarded and successful segments stitch together into your run pace.
 *
 * It sits at 0 while you're in the start zone and begins when the run starts (you leave the start zone).
 *
 * Input - bind the mouse buttons to the real savestate commands (raw MOUSE4/MOUSE5 aren't readable from JS;
 * `MomentumInputAPI.GetButtons()` only reports bound game actions). NOTE the `+` on load: "goto" is a
 * +/- hold command (settings/input.xml `#Keybind_Savestate_Goto` = `+mom_savestate_load`); the bare name may
 * fire no teleport. Holding it freezes you at the saveloc and releasing resumes - the timer freezes for the
 * duration of the hold and starts on release.
 *   bind "mouse5" "mom_savestate_create"
 *   bind "mouse4" "+mom_savestate_load"
 *
 * We never read the mouse - the engine runs those commands and fires `OnSaveStateUpdate(count, current,
 * usingMenu)`, which is all we listen to. `current` is 0-indexed; `usingMenu` is true only on teleport/load
 * (incl. via console command), false on create / menu-close. `+mom_savestate_load` fires it on BOTH press
 * and release (see the paired freeze/resume in onSaveStateLoad).
 *
 * Clock is `MomentumMovementAPI.GetCurrentTime()` (continuous game seconds), driven by a self-scheduled loop
 * because a plain panel doesn't receive `HudProcessInput`.
 */

// Logs savestate events + persistent-storage save/load to the console. Set false unless debugging.
const DEBUG = true;

// How many recent jumps to keep in the jump log window.
const JUMP_LOG_SIZE = 6;

// While held at a saveloc the player's movetype is NONE (frozen in place - velocity is stored but not
// applied, which is why the speedometer shows the exit speed). Any other movetype means they're playing
// again, so that's what un-freezes the timer. MoveType.NONE = 0 (MomentumMovementAPI.MoveType).
const MOVETYPE_NONE = 0;

/** Format seconds as M:SS.hh for the jump log lines. */
function formatSegTime(secs: number): string {
	const m = Math.floor(secs / 60);
	const s = secs % 60;
	return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

/** Minimal pausable stopwatch. value = base + (now - origin) while running, else base. */
class Stopwatch {
	private base = 0;
	private origin = 0;
	private running = false;

	constructor(private readonly clock: () => number) {
		this.origin = clock();
	}

	value(): number {
		return this.running ? this.base + (this.clock() - this.origin) : this.base;
	}

	/** Jump to a value, preserving the running/paused state. */
	setValue(v: number): void {
		this.base = v;
		this.origin = this.clock();
	}

	start(): void {
		if (!this.running) {
			this.origin = this.clock();
			this.running = true;
		}
	}

	pause(): void {
		if (this.running) {
			this.base += this.clock() - this.origin;
			this.running = false;
		}
	}

	/** Reset to 0, frozen (used in the start zone). */
	resetPaused(): void {
		this.base = 0;
		this.running = false;
	}

	/** Reset to 0 and run (used when a run starts). */
	resetRunning(): void {
		this.base = 0;
		this.origin = this.clock();
		this.running = true;
	}
}

@PanelHandler()
class SegmentTimerHandler {
	readonly panels = {
		root: $<Panel>('#SegmentTimer')!,
		segment: $<Label>('#SegmentTimerSegment')!,
		slot: $<Label>('#SegmentTimerSlot')!,
		log: $<Label>('#SegmentTimerLog')!
	};

	private readonly segment = new Stopwatch(() => this.now()); // spliced virtual run time
	private splicedJumps = 0; // spliced jump count - rewinds with savestates like the segment timer

	// slot index -> { spliced time, spliced jump count } captured when that savestate was created.
	// Positional: the event only exposes count/current, not stable ids.
	private creation = new Map<number, { time: number; jumps: number }>();
	private saveStateCount = 0;
	private loadedForMap: string | null = null; // map name we've loaded `creation` from storage for

	private segFrozen = false; // timer parked because the player's movetype is NONE (held at a saveloc)
	private loadTarget: { time: number; jumps: number } | null = null; // slot snapshot to park the timer at

	// Recent jumps: the spliced jump count + segment time captured at each of the last JUMP_LOG_SIZE jumps.
	private jumpLog: { count: number; time: number }[] = [];

	constructor() {
		this.segment.resetPaused();
		this.ensureLoaded(); // restores this map's saved slots if the map name is already available

		$.RegisterForUnhandledEvent('LevelInitPostEntity', () => this.reset());

		$.RegisterForUnhandledEvent('OnObservedTimerStateChange', () => this.onTimerState());

		// OnJumpStarted is a global unhandled event (see strafe-trainer.ts) - fires on every player jump.
		$.RegisterForUnhandledEvent('OnJumpStarted', () => this.onJump());

		$.RegisterForUnhandledEvent('OnSaveStateUpdate', (count, current, usingMenu) =>
			this.onSaveStateUpdate(count, current, usingMenu)
		);

		registerHUDCustomizerComponent(this.panels.root, {
			name: 'Segment Timer',
			resizeX: false,
			resizeY: false,
			dynamicStyles: {
				fontSize: {
					name: 'Font Size',
					type: CustomizerPropertyType.NUMBER_ENTRY,
					targetPanel: '.segmenttimer__segment',
					styleProperty: 'fontSize',
					valueFn: (value) => `${value}px`,
					settingProps: { min: 1, max: 200 }
				},
				fontColor: {
					name: 'Font Color',
					type: CustomizerPropertyType.COLOR_PICKER,
					targetPanel: '.segmenttimer__segment',
					styleProperty: 'color',
					callbackFunc: (panel, value) =>
						(panel.style.textShadowFast = getTextShadowFast(value as rgbaColor, 0.9))
				},
				showSlot: {
					name: 'Show Savestate Slot',
					type: CustomizerPropertyType.CHECKBOX,
					targetPanel: '.segmenttimer__slot',
					styleProperty: 'visibility',
					valueFn: (value) => (value ? 'visible' : 'collapse')
				}
			}
		});

		this.updateSlotLabel(0, 0);
		this.updateLog();
		this.update();
	}

	private now(): number {
		return MomentumMovementAPI.GetCurrentTime();
	}

	private onTimerState(): void {
		const { state, majorNum, minorNum } = MomentumTimerAPI.GetObservedTimerStatus();

		if (state === Timer.TimerState.PRIMED) {
			// In the start zone, armed but not started: sit frozen at 0.
			this.segFrozen = false;
			this.segment.resetPaused();
			this.splicedJumps = 0;
			this.clearLog();
		} else if (state === Timer.TimerState.RUNNING && majorNum === 1 && minorNum === 1) {
			// Run just started (left the start zone): begin from 0.
			this.segFrozen = false;
			this.segment.resetRunning();
			this.splicedJumps = 0;
			this.clearLog();
		}
		// Other states (RUNNING mid-run, FINISHED, DISABLED/practice) are left alone so the timer keeps
		// running through savestate practice.
	}

	private reset(): void {
		// New level: forget the in-memory creation map and mark it as needing a reload. The map name may
		// not be ready this exact frame, so ensureLoaded() reloads here if it can, else lazily on the first
		// savestate event (savestates persist per-map in their own .msav, so on re-entering a map its
		// savestates come back - we restore the spliced time + jump count each was created at).
		if (DEBUG) $.Msg(`[SegmentTimer] reset() mapName="${MapCacheAPI.GetMapName()}"`);
		this.creation = new Map();
		this.loadedForMap = null;
		this.ensureLoaded();
		this.saveStateCount = 0;
		this.segFrozen = false;
		this.loadTarget = null;
		this.segment.resetPaused();
		this.splicedJumps = 0;
		this.updateSlotLabel(0, 0);
		this.clearLog();
	}

	private storageKeyFor(mapName: string): string {
		return `segment-timer.creation.${mapName}`;
	}

	/** Load `creation` from storage the first time the map name becomes available for this level. */
	private ensureLoaded(): void {
		const mapName = MapCacheAPI.GetMapName();
		if (!mapName || this.loadedForMap === mapName) {
			if (DEBUG) $.Msg(`[SegmentTimer] ensureLoaded skip (mapName="${mapName}", loadedFor="${this.loadedForMap}")`);
			return;
		}
		this.loadCreation(mapName);
		this.loadedForMap = mapName;
	}

	/** Persist the slot -> creation-snapshot map for the current map. */
	private saveCreation(): void {
		const mapName = MapCacheAPI.GetMapName();
		if (!mapName) {
			if (DEBUG) $.Msg('[SegmentTimer] saveCreation SKIPPED - no map name');
			return;
		}
		const key = this.storageKeyFor(mapName);
		const data = [...this.creation.entries()];
		$.persistentStorage.setItem(key, data);
		if (DEBUG) $.Msg(`[SegmentTimer] saveCreation key=${key} data=${JSON.stringify(data)}`);
	}

	/** Load the slot -> creation-snapshot map saved for `mapName` (empty if none). */
	private loadCreation(mapName: string): void {
		const key = this.storageKeyFor(mapName);
		const stored = $.persistentStorage.getItem<[number, { time: number; jumps: number } | number][]>(key);
		if (DEBUG) $.Msg(`[SegmentTimer] loadCreation key=${key} stored=${JSON.stringify(stored)}`);
		// Back-compat: an earlier format stored just the time as a number.
		this.creation = new Map(
			(stored ?? []).map(([slot, v]) => [slot, typeof v === 'number' ? { time: v, jumps: 0 } : v])
		);
	}

	private onJump(): void {
		this.splicedJumps++;
		// Newest on the bottom: append, and drop the oldest off the top when over capacity.
		this.jumpLog.push({ count: this.splicedJumps, time: this.segment.value() });
		if (this.jumpLog.length > JUMP_LOG_SIZE) this.jumpLog.shift();
		this.updateLog();
	}

	private clearLog(): void {
		this.jumpLog = [];
		this.updateLog();
	}

	private updateLog(): void {
		this.panels.root.SetDialogVariable(
			'jump_log',
			this.jumpLog.map((e) => `${e.count}  ${formatSegTime(e.time)}`).join('\n')
		);
	}

	private onSaveStateUpdate(count: number, current: number, usingMenu: boolean): void {
		// The map name is reliably available by the time savestates load, so this is our safety net for
		// restoring `creation` if reset()/ctor ran before the name was ready.
		this.ensureLoaded();

		if (DEBUG) {
			$.Msg(
				`[SegmentTimer] OnSaveStateUpdate count=${count} current=${current} usingMenu=${usingMenu} ` +
					`(prevCount=${this.saveStateCount}, seg=${this.segment.value().toFixed(2)}, creationSize=${this.creation.size})`
			);
		}

		let changed = false;
		if (count === 0) {
			// NEVER persist an empty map here. count=0 fires for THREE indistinguishable reasons: the user
			// clearing all savestates, level SHUTDOWN (prevCount>0), and a transient at level init
			// (prevCount 0). Saving [] on shutdown was the wipe bug. So we never save; we only clear the
			// in-memory map when we actually had savestates (real clear-all / shutdown) so a later recreate
			// stores fresh - the init transient leaves the freshly restored `creation` alone. Stale storage
			// (after a genuine clear-all) is harmless and gets overwritten by the next create/delete save.
			this.segFrozen = false;
			if (this.saveStateCount > 0) this.creation.clear();
		} else if (count === this.saveStateCount + 1) {
			// One savestate appeared at `current`. If we already have a stored snapshot for this slot
			// (restored from storage), it's the disk-load re-announcing an existing savestate - keep the
			// stored value. Otherwise it's a fresh create (mouse5) - snapshot the spliced time + jumps now.
			if (!this.creation.has(current)) {
				this.creation.set(current, { time: this.segment.value(), jumps: this.splicedJumps });
				changed = true;
			}
		} else if (count > this.saveStateCount) {
			// Bulk jump (e.g. multiple savestates loaded from disk on map start). Adopt the count, store
			// nothing - the snapshots were already restored from storage.
		} else if (count < this.saveStateCount) {
			// One or more removed. Drop now-out-of-range slots (positional-only info).
			for (const k of [...this.creation.keys()]) if (k >= count) this.creation.delete(k);
			changed = true;
		} else if (usingMenu) {
			// Same count + usingMenu => teleported to (loaded) savestate `current` (mouse4).
			this.onSaveStateLoad(current);
		}

		this.saveStateCount = count;
		if (changed) this.saveCreation();
		this.updateSlotLabel(count === 0 ? 0 : current + 1, count);
	}

	private onSaveStateLoad(current: number): void {
		// Only RECORD which slot's snapshot the timer should park at. The freeze/resume itself is driven by
		// the live player movetype in update() - NOT by these events: a single +mom_savestate_load hold fires
		// this TWICE (press + release) with different movetype and inconsistent order, so deciding freeze
		// here was the "sometimes freezes, sometimes not" bug.
		const created = this.creation.get(current);
		this.loadTarget = { time: created?.time ?? 0, jumps: created?.jumps ?? 0 };
		// If already parked (e.g. switching savestates while held), snap the display to the new slot now.
		if (this.segFrozen) {
			this.segment.setValue(this.loadTarget.time);
			this.splicedJumps = this.loadTarget.jumps;
			this.segment.pause();
		}
		if (DEBUG) {
			$.Msg(
				`[SegmentTimer] load slot ${current} -> ${JSON.stringify(created ?? 'NONE')} move=${MomentumMovementAPI.GetMoveType()}`
			);
		}
	}

	private updateSlotLabel(current: number, count: number): void {
		this.panels.root.SetDialogVariable('ss_label', count > 0 ? `SS ${current}/${count}` : '');
	}

	private update(): void {
		if (!this.panels.root?.IsValid()) return;

		// Freeze/resume tracks the LIVE player movetype: NONE = parked at a saveloc (held via
		// +mom_savestate_load, or previewing in the savestate menu), anything else = playing. Driving it off
		// movetype here (not off the savestate events) makes it independent of how many events a hold fires
		// and their order - both were unreliable and caused the "sometimes freezes, sometimes not" bug.
		// Gated on loadTarget so an unrelated NONE (e.g. at spawn) before any savestate can't freeze us.
		const parked = MomentumMovementAPI.GetMoveType() === MOVETYPE_NONE;
		if (parked && !this.segFrozen && this.loadTarget) {
			this.segment.setValue(this.loadTarget.time);
			this.splicedJumps = this.loadTarget.jumps;
			this.segment.pause();
			this.segFrozen = true;
			if (DEBUG) $.Msg('[SegmentTimer] freeze (movetype NONE)');
		} else if (!parked && this.segFrozen) {
			this.segment.start();
			this.segFrozen = false;
			if (DEBUG) $.Msg(`[SegmentTimer] resume (move=${MomentumMovementAPI.GetMoveType()})`);
		}

		this.panels.root.SetDialogVariableFloat('segtime', this.segment.value());
		$.Schedule(0, () => this.update());
	}
}
