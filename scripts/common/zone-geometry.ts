import type { Region } from 'common/web/types/models/models';

/**
 * Zone geometry helpers (shared by zone-debug + segment-timer).
 * Side-effect-free, safe to import from any panel context.
 */

// createRegion() defaults `bottom` to this sentinel (COORD_MAX) before a floor is picked; treat a bottom at or
// above it as "no vertical bound" so the z-range test doesn't reject everything on a half-built zone.
export const COORD_MAX = 65536;

/**
 * Is the world point `pos` ([x, y, z]) inside `region`? 2D ray-casting point-in-polygon on the XY footprint
 * (`region.points`), plus a Z-range check against `bottom` / `bottom + height`. Uses the player origin, so it
 * fires a hair later than the engine's bbox-based zone trigger - fine for a practice split/overlay.
 */
export function pointInRegion(pos: number[], region: Region): boolean {
	const [x, y, z] = pos;
	const bottom = region.bottom;
	const height = region.height;
	if (bottom != null && height != null && bottom < COORD_MAX) {
		if (z < bottom || z > bottom + height) return false;
	}
	const pts = region.points ?? [];
	let inside = false;
	for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
		const xi = pts[i][0],
			yi = pts[i][1],
			xj = pts[j][0],
			yj = pts[j][1];
		const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
		if (intersect) inside = !inside;
	}
	return inside;
}
