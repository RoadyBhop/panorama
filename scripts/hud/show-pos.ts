import { PanelHandler } from 'util/module-helpers';
import { CustomizerPropertyType, registerHUDCustomizerComponent } from 'common/hud-customizer';
import { getTextShadowFast } from 'common/hud-customizer';
import { parseShowPosVec, publishPlayerState } from 'common/player-state';

// This C++ HudShowPos panel is the ONLY source of player world position in Panorama (there's no position API).
// It writes the live origin/angles into its labels' dialog variables each frame, but ONLY when cl_showpos is on
// (ships at 0). We force it on, parse the resolved label text (`.text` returns the substituted value), and
// publish it to the cross-context global so zone-debug / segment-timer can do real zone collision - including
// during savestate practice, since cl_showpos updates regardless of timer state. See PANORAMA_NOTES §6h/§6l.
@PanelHandler()
class HudShowPosHandler {
	private readonly cp = $.GetContextPanel();

	constructor() {
		// Same convar-gate trick as the strafe-sync panel (§6c): make C++ actually populate origin/angle.
		// Survives panorama_reload (ctor re-runs). Set once at HUD load.
		GameInterfaceAPI.ConsoleCommand('cl_showpos 1');

		registerHUDCustomizerComponent(this.cp, {
			name: $.Localize('#Customizer_Show_Pos_Name'),
			resizeX: true,
			resizeY: false,
			dynamicStyles: {
				fontStyling: {
					name: $.Localize('#Customizer_FontStyling'),
					type: CustomizerPropertyType.NONE,
					expandable: true,
					children: [{ styleID: 'font' }, { styleID: 'fontSize' }, { styleID: 'fontColor' }]
				},
				font: {
					name: $.Localize('#Customizer_Font'),
					type: CustomizerPropertyType.FONT_PICKER,
					targetPanel: '.showpos-entry__label',
					styleProperty: 'fontFamily',
					valueFn: (value) => `"${value}"`
				},
				fontSize: {
					name: $.Localize('#Customizer_FontSize'),
					type: CustomizerPropertyType.NUMBER_ENTRY,
					targetPanel: '.showpos-entry__label',
					styleProperty: 'fontSize',
					valueFn: (value) => `${value}px`
				},
				fontColor: {
					name: $.Localize('#Customizer_FontColor'),
					type: CustomizerPropertyType.COLOR_PICKER,
					targetPanel: '.showpos-entry__label',
					styleProperty: 'color',
					callbackFunc: (panel, value) =>
						(panel.style.textShadowFast = getTextShadowFast(value as rgbaColor, 0.9))
				},
				backgroundColor: {
					name: $.Localize('#Customizer_BackgroundColor'),
					type: CustomizerPropertyType.COLOR_PICKER,
					targetPanel: '.showpos-entry',
					styleProperty: 'backgroundColor'
				},
				alignText: {
					name: $.Localize('#Customizer_AlignText'),
					type: CustomizerPropertyType.DROPDOWN,
					options: [
						{ label: 'Left', value: 'left' },
						{ label: 'Center', value: 'center' },
						{ label: 'Right', value: 'right' }
					],
					targetPanel: ['.showpos-entry', '.showpos-entry__label'],
					styleProperty: 'horizontalAlign'
				}
			}
		});

		this.publishLoop();
	}

	/**
	 * Read the two position/angle labels and publish the parsed values to the cross-context global each frame.
	 * A plain HUD panel doesn't get HudProcessInput, so drive this with a self-scheduled loop. The labels only
	 * hold real numbers once the panel is populated (cl_showpos on + the Pos/Ang component enabled in the
	 * customizer); until then parseShowPosVec returns null and we publish nothing.
	 */
	private publishLoop(): void {
		if (!this.cp?.IsValid()) return;

		const labels = this.cp.FindChildrenWithClassTraverse<Label>('showpos-entry__label');
		if (labels.length >= 2) {
			const pos = parseShowPosVec(labels[0].text); // "Pos: x y z"
			const ang = parseShowPosVec(labels[1].text); // "Ang: pitch yaw roll"
			if (pos) publishPlayerState({ pos, ang: ang ?? [0, 0, 0], time: MomentumMovementAPI.GetCurrentTime() });
		}

		$.Schedule(0, () => this.publishLoop());
	}
}
