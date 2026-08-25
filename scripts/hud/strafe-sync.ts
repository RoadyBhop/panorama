import { PanelHandler } from 'util/module-helpers';
import { Button } from 'common/buttons';
import { GamemodeCategory, GamemodeCategoryToGamemode } from 'common/web/enums/gamemode.enum';
import { CustomizerPropertyType, registerHUDCustomizerComponent } from 'common/hud-customizer';

/**
 * Strafe Offsets (a.k.a. sync trainer). Shows a history of your key↔mouse timing at each strafe
 * keyswitch: whether you pressed the new strafe key EARLY or LATE relative to when your mouse actually
 * changed turning direction. Each keyswitch is one bar, growing UP for late / DOWN for early from a
 * centre "perfect" line; magnitude is the offset in ticks.
 *
 * Reference concept: spicy/strafe-analyzer SyncTrainer — "displays a history of previous keyswitches
 * (shows if you pressed your keys late or early compared to your mouse direction)".
 */

const DEFAULT_HISTORY = 15;
const DEFAULT_MAX_OFFSET = 8; // ticks that map to the full up/down extent
const DEFAULT_PERFECT = 1; // |offset| ≤ this (ticks) counts as perfect
const PAIR_WINDOW_TICKS = 25; // max ticks between a key switch and its matching mouse-direction switch
const TURN_EPS = 0.5; // deg/frame of yaw movement below which we don't count a turn (ignores jitter)

const DEFAULT_LATE_COLOR = 'rgba(220, 116, 13, 1)' as color; // pressed key too late
const DEFAULT_EARLY_COLOR = 'rgba(24, 150, 211, 1)' as color; // pressed key too early
const DEFAULT_PERFECT_COLOR = 'rgba(21, 152, 86, 1)' as color; // on time
const DEFAULT_LINE_COLOR = 'rgba(255, 255, 255, 0.5)' as color; // centre + top/bottom lines

interface OffsetSample {
	offset: number; // ticks; >0 late, <0 early
	side: number; // +1 = switched to right strafe, -1 = left (for reference/future colouring)
}
interface SwitchEvent {
	tick: number; // integer tick index (round of GetCurrentTime / tick interval)
	dir: number; // +1 right, -1 left
}

@PanelHandler()
class StrafeOffset {
	readonly panels = {
		cp: $.GetContextPanel<MomHudStrafeSync>(),
		canvas: $<UICanvas>('#OffsetCanvas'),
		text: $<Label>('#OffsetText')
	};

	// Customizable
	historyLength = DEFAULT_HISTORY;
	maxOffset = DEFAULT_MAX_OFFSET;
	perfectThreshold = DEFAULT_PERFECT;
	lateColor: color = DEFAULT_LATE_COLOR;
	earlyColor: color = DEFAULT_EARLY_COLOR;
	perfectColor: color = DEFAULT_PERFECT_COLOR;
	lineColor: color = DEFAULT_LINE_COLOR;
	showText = true;

	// Detection state
	dbgFired = false; // one-shot debug: has onUpdate ever run
	dbgDrew = false; // one-shot debug: has draw ever had valid dims
	dbgErr = false; // one-shot debug: has onUpdate thrown
	history: OffsetSample[] = [];
	prevYaw: number | null = null;
	lastKeyDir = 0; // last non-zero strafe-key direction
	lastTurnDir = 0; // last mouse turning direction
	pendingKey: SwitchEvent | null = null; // a keyswitch waiting for its mouse switch
	pendingTurn: SwitchEvent | null = null; // a mouse switch waiting for its keyswitch

	constructor() {
		registerHUDCustomizerComponent($.GetContextPanel(), {
			name: $.Localize('#Customizer_Strafe_Offset_Name'),
			resizeX: true,
			resizeY: false, // fixed CSS height (like strafe-trainer); width is resizable
			gamemode: [
				...GamemodeCategoryToGamemode.get(GamemodeCategory.BHOP),
				...GamemodeCategoryToGamemode.get(GamemodeCategory.SURF),
				...GamemodeCategoryToGamemode.get(GamemodeCategory.CLIMB)
			],
			dynamicStyles: {
				historyLength: {
					name: $.Localize('#Customizer_Strafe_Offset_HistoryLength'),
					type: CustomizerPropertyType.NUMBER_ENTRY,
					callbackFunc: (_, value) => (this.historyLength = Math.max(2, Math.round(value ?? DEFAULT_HISTORY))),
					settingProps: { min: 1, max: 50, increment: 1 }
				},
				maxOffset: {
					name: $.Localize('#Customizer_Strafe_Offset_MaxOffset'),
					type: CustomizerPropertyType.NUMBER_ENTRY,
					callbackFunc: (_, value) => (this.maxOffset = Math.max(1, value ?? DEFAULT_MAX_OFFSET)),
					settingProps: { min: 1, max: 50, increment: 1 }
				},
				perfectThreshold: {
					name: $.Localize('#Customizer_Strafe_Offset_PerfectThreshold'),
					type: CustomizerPropertyType.NUMBER_ENTRY,
					callbackFunc: (_, value) => (this.perfectThreshold = Math.max(0, value ?? DEFAULT_PERFECT)),
					settingProps: { min: 0, max: 10, increment: 1 }
				},
				showText: {
					name: $.Localize('#Customizer_Strafe_Offset_ShowText'),
					type: CustomizerPropertyType.CHECKBOX,
					callbackFunc: (_, value) => {
						this.showText = value;
						if (this.panels.text) this.panels.text.visible = value;
					}
				},
				colors: {
					name: $.Localize('#Customizer_Colors'),
					type: CustomizerPropertyType.NONE,
					expandable: true,
					children: [
						{ styleID: 'lateColor' },
						{ styleID: 'earlyColor' },
						{ styleID: 'perfectColor' },
						{ styleID: 'lineColor' },
						{ styleID: 'backgroundColor' }
					]
				},
				lateColor: {
					name: $.Localize('#Customizer_Strafe_Offset_LateColor'),
					type: CustomizerPropertyType.COLOR_PICKER,
					callbackFunc: (_, value) => (this.lateColor = value as color)
				},
				earlyColor: {
					name: $.Localize('#Customizer_Strafe_Offset_EarlyColor'),
					type: CustomizerPropertyType.COLOR_PICKER,
					callbackFunc: (_, value) => (this.earlyColor = value as color)
				},
				perfectColor: {
					name: $.Localize('#Customizer_Strafe_Offset_PerfectColor'),
					type: CustomizerPropertyType.COLOR_PICKER,
					callbackFunc: (_, value) => (this.perfectColor = value as color)
				},
				lineColor: {
					name: $.Localize('#Customizer_Strafe_Offset_LineColor'),
					type: CustomizerPropertyType.COLOR_PICKER,
					callbackFunc: (_, value) => (this.lineColor = value as color)
				},
				backgroundColor: {
					name: $.Localize('#Customizer_BackgroundColor'),
					type: CustomizerPropertyType.COLOR_PICKER,
					targetPanel: '.strafeoffset__area',
					styleProperty: 'backgroundColor'
				}
			},
			postInit: () => {
				$.Msg(
					`[StrafeOffset] postInit: canvas=${!!this.panels.canvas} text=${!!this.panels.text} ` +
						`history=${this.historyLength}`
				);
				if (this.panels.text) this.panels.text.visible = this.showText;
				this.panels.canvas?.SetMaxDrawCommands(256); // bars + lines; plenty for any history length
				// MomHudStrafeSync doesn't dispatch HudProcessInput to us, so drive updates ourselves.
				this.loop();
			}
		});
	}

	/** Per-frame driver (self-scheduled since HudProcessInput isn't dispatched to this panel). */
	loop() {
		if (!this.panels.canvas?.IsValid()) return; // panel destroyed (map unload / reload) → stop looping
		try {
			this.onUpdate();
		} catch (e) {
			// not in a live gameplay state yet (APIs unavailable) — just keep looping
			if (!this.dbgErr) {
				this.dbgErr = true;
				$.Msg(`[StrafeOffset] onUpdate threw (will keep retrying): ${String(e)}`);
			}
		}
		$.Schedule(0, () => this.loop());
	}

	onUpdate() {
		if (!this.dbgFired) {
			this.dbgFired = true;
			$.Msg('[StrafeOffset] onUpdate is firing (self-scheduled loop)');
		}
		// Inputs are sampled per TICK, so we work in whole tick indices — snap the current game time to its
		// tick. (GetCurrentTime is continuous frame time, so timing switches in seconds gave meaningless
		// sub-tick decimals.)
		const interval = MomentumMovementAPI.GetTickInterval();
		const tick = interval > 0 ? Math.round(MomentumMovementAPI.GetCurrentTime() / interval) : 0;

		// --- strafe key direction (+1 right / -1 left / 0 none) ---
		const held = MomentumInputAPI.GetButtons();
		const buttons = held.physicalButtons | held.toggledButtons;
		const right = (buttons & Button.MOVERIGHT) !== 0;
		const left = (buttons & Button.MOVELEFT) !== 0;
		const keyDir = right === left ? 0 : right ? 1 : -1; // both or neither → 0 (transient)
		if (keyDir !== 0 && keyDir !== this.lastKeyDir) {
			this.onKeySwitch(tick, keyDir);
			this.lastKeyDir = keyDir;
		}

		// --- mouse turn direction, from view yaw change ---
		const yaw = MomentumPlayerAPI.GetAngles().y;
		if (this.prevYaw !== null) {
			const dYaw = this.normalizeAngle(yaw - this.prevYaw);
			if (Math.abs(dYaw) > TURN_EPS) {
				// Source yaw increases turning LEFT, so turning right ⇒ dYaw < 0. Map to right-positive.
				const turnDir = dYaw < 0 ? 1 : -1;
				if (turnDir !== this.lastTurnDir) {
					this.onTurnSwitch(tick, turnDir);
					this.lastTurnDir = turnDir;
				}
			}
		}
		this.prevYaw = yaw;

		this.draw();
	}

	/** A strafe keyswitch happened: pair it with a recent mouse switch (same direction), else hold it. */
	onKeySwitch(tick: number, dir: number) {
		if (this.pendingTurn && this.pendingTurn.dir === dir && Math.abs(tick - this.pendingTurn.tick) <= PAIR_WINDOW_TICKS) {
			this.record(tick - this.pendingTurn.tick, dir); // key later than mouse ⇒ +offset ⇒ late
			this.pendingTurn = null;
			this.pendingKey = null;
		} else {
			this.pendingKey = { tick, dir };
		}
	}

	/** A mouse turn-direction switch happened: pair it with a pending keyswitch, else hold it. */
	onTurnSwitch(tick: number, dir: number) {
		if (this.pendingKey && this.pendingKey.dir === dir && Math.abs(tick - this.pendingKey.tick) <= PAIR_WINDOW_TICKS) {
			this.record(this.pendingKey.tick - tick, dir); // key earlier than mouse ⇒ -offset ⇒ early
			this.pendingKey = null;
			this.pendingTurn = null;
		} else {
			this.pendingTurn = { tick, dir };
		}
	}

	/** Store one keyswitch offset (whole ticks) and update the readout. */
	record(offsetTicks: number, side: number) {
		this.history.push({ offset: offsetTicks, side });
		while (this.history.length > this.historyLength) this.history.shift();
		$.Msg(`[StrafeOffset] keyswitch recorded: ${offsetTicks}t (${offsetTicks > 0 ? 'late' : offsetTicks < 0 ? 'early' : 'perfect'})`);
		this.updateText(offsetTicks);
	}

	updateText(latest: number) {
		const el = this.panels.text;
		if (!el || !this.showText) return;
		const rounded = Math.round(latest);
		if (Math.abs(rounded) <= this.perfectThreshold) {
			el.text = 'Perfect';
			this.setColor(el, this.perfectColor);
		} else if (rounded > 0) {
			el.text = `Late ${rounded}t`;
			this.setColor(el, this.lateColor);
		} else {
			el.text = `Early ${-rounded}t`;
			this.setColor(el, this.earlyColor);
		}
	}

	colorFor(offset: number): color {
		if (Math.abs(offset) <= this.perfectThreshold) return this.perfectColor;
		return offset > 0 ? this.lateColor : this.earlyColor;
	}

	/** Draw the offset history: one bar per keyswitch, up = late / down = early from a centre line. */
	draw() {
		const canvas = this.panels.canvas;
		if (!canvas?.IsValid()) return;

		const W = canvas.actuallayoutwidth / canvas.actualuiscale_x;
		const H = canvas.actuallayoutheight / canvas.actualuiscale_y;
		if (!(W > 0) || !(H > 0)) return;

		if (!this.dbgDrew) {
			this.dbgDrew = true;
			$.Msg(`[StrafeOffset] first draw with valid canvas size: ${W.toFixed(0)}x${H.toFixed(0)}`);
		}

		canvas.Clear('#00000000');

		const n = this.historyLength;
		const slot = W / n;
		const barW = slot * 0.7; // gaps between discrete keyswitch bars
		const midY = H / 2;
		const half = H / 2;

		// Bars first, newest at the right edge.
		const len = this.history.length;
		for (let i = 0; i < len; i++) {
			const s = this.history[i];
			const slotIndex = n - len + i; // right-align
			const cx = (slotIndex + 0.5) * slot;
			const x0 = cx - barW / 2;
			const x1 = cx + barW / 2;

			const fr = Math.max(-1, Math.min(1, s.offset / this.maxOffset)); // signed, -1..1
			const yTip = midY - fr * half; // +offset (late) ⇒ up
			const col = this.colorFor(s.offset);

			// quad from the centre line to the tip
			canvas.DrawPoly(4, [x0, midY, x0, yTip, x1, yTip, x1, midY], col);
		}

		// Top / bottom bound lines + centre "perfect" line, drawn on top of the bars.
		const hline = (y: number) => canvas.DrawLinePoints(2, [0, y, W, y], 2, this.lineColor);
		hline(1); // top
		hline(H - 1); // bottom
		hline(midY); // centre = perfect
	}

	setColor(panel: GenericPanel, c: color) {
		try {
			panel.style.color = c;
		} catch {}
	}

	normalizeAngle(a: number): number {
		a %= 360;
		if (a > 180) a -= 360;
		else if (a < -180) a += 360;
		return a;
	}
}
