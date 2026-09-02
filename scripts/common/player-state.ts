/**
 * Player world-state bridge (position + angles)
 * ==============================================
 * Momentum exposes NO player world-position API to Panorama (verified against the base game). The ONLY source
 * is the C++ `HudShowPos` panel (Panorama's `cl_showpos`): when `cl_showpos` is on it writes the live origin /
 * angles into its labels' dialog variables each frame, and a Label's `.text` getter returns the SUBSTITUTED
 * value (confirmed in-game - it reads back e.g. "Pos: -14592.00 -14080.00 14957.40").
 *
 * `show-pos.ts` (the only JS context with access to those labels) parses them and calls publishPlayerState()
 * every frame; other HUD frames (zone-debug, segment-timer) read it with readPlayerState(). The hand-off is the
 * cross-context global object (`UiToolkitAPI.GetGlobalObject()`), the same shared object the HUD customizer uses
 * to expose its handler across contexts - so a value written in one panel's JS context is visible in all others.
 *
 * This module is intentionally side-effect-free (no @PanelHandler, nothing runs on import) so it's safe to
 * import from multiple panel contexts. See PANORAMA_NOTES.md §6h/§6l.
 */

export interface MomPlayerState {
	/** World position [x, y, z] in units. */
	pos: number[];
	/** View angles [pitch, yaw, roll] in degrees. */
	ang: number[];
	/** MomentumMovementAPI.GetCurrentTime() when captured (seconds) - lets readers detect staleness. */
	time: number;
}

const GLOBAL_KEY = 'momPlayerState';

/** Publish the latest player state to the cross-context global (called by show-pos.ts each frame). */
export function publishPlayerState(state: MomPlayerState): void {
	(UiToolkitAPI.GetGlobalObject() as Record<string, unknown>)[GLOBAL_KEY] = state;
}

/** Read the latest published player state, or null if none has been published yet. */
export function readPlayerState(): MomPlayerState | null {
	const s = (UiToolkitAPI.GetGlobalObject() as Record<string, unknown>)[GLOBAL_KEY] as MomPlayerState | undefined;
	return s && Array.isArray(s.pos) && s.pos.length >= 3 ? s : null;
}

/** Parse a cl_showpos label ("Pos: 12.3 -45.6 78.9" / "Ang: 0.0 -90.0 0.0") into [a, b, c], or null. */
export function parseShowPosVec(text: string): number[] | null {
	const m = text?.match(/-?\d+(?:\.\d+)?/g);
	if (!m || m.length < 3) return null;
	const v = m.slice(-3).map(Number);
	return v.some((n) => Number.isNaN(n)) ? null : v;
}
