# Momentum Panorama — Custom HUD & Menu Notes

Reference for working on this custom Panorama override. Written to bootstrap a fresh, context‑free
session: it covers the folder layout, the important in‑game + web APIs, the HUD customizer system,
`UICanvas` drawing, every custom feature built here, and the gotchas that cost real debugging time.

> This is a **local client‑side override** of the game's Panorama files. It's overwritten by game
> updates and there's no addon/distribution system for HUD mods — it's for personal use.

---

## 0. Environment & workflow

- **Override root:** `steamapps/common/Momentum Mod Playtest/momentum/custom/panoDev/panorama/`
  (`custom/panoDev/` mounts over `momentum/`, so files here shadow the base game's). It contains only
  `panorama/` — **not** `cfg/`, `resource/`, etc. Those live in the base game and are edited in place.
- **Reload after edits:** `panorama_reload` (or F7) reloads `.ts` / `.xml` / `.scss` live.
- **Needs a full game restart:** `cfg/hud/*.kv3` defaults, `resource/*.txt` localization, and
  `domain_whitelist.kv3` (read only at startup — `panorama_reload` does NOT re‑read it).
- **No Node here.** Can't run `tsc`/`eslint`/`prettier`. The game has a built‑in **transpile‑only**
  TS compiler (no type checking, no build step) — so keep types clean by hand, but transpile errors
  are what actually break things. Scripts MUST be `<include type="module" ...>` (plain include →
  "Cannot use import statement outside a module").
- **tsconfig:** `strict: true` but `strictNullChecks: false`. So `catch (e)` gives `e: unknown` — do
  NOT interpolate it raw into a template literal; use `String(e)`.

### File layout for one feature
- **Layout:** `layout/**/<name>.xml` — panels; root has `<styles>` (include `main.scss`) + `<scripts>`.
- **Script:** `scripts/**/<name>.ts` — `@PanelHandler()` class; `$.GetContextPanel()` = the panel.
- **Style:** `styles/**/<name>.scss` — must be `@use`'d from an `_index.scss` that `main.scss` pulls in
  (e.g. `styles/hud/_index.scss` has `@use 'strafe-sync';`). `@use '../config' as *;` exposes tokens
  like `$white`, `$font-header`, `$font-monospace`.
- **Localization:** `momentum/resource/momentum_english.txt` — `"Key" "Value"` pairs; reference in
  code/XML as `#Key` (via `$.Localize('#Key')` or `text="#Key"`). Missing keys fall back to English.

### Hard gotchas (read these first)
- **XML comments cannot contain `--`.** `<!-- see .mainmenu--css -->` breaks the ENTIRE layout with
  "Unable to load layout file". Reword to avoid the double hyphen. (Classes/attrs/SCSS are fine.)
- **Panorama SCSS supports** `:not()`, child `>`, `#id`, `:hover`, descendant selectors, and
  percentage sizes. `fill-parent-flow(1)` fills remaining flow space (parent needs a definite size and
  `flow-children` set). `overflow: squish clip|scroll|noclip` — a `%`/`fill-parent-flow` height child
  needs its parent to be `scroll`/`clip`/definite, never `noclip`. 8‑digit hex alpha (`#00000000`) is
  valid.
- **Default `flow-children` is `none`** (children overlap, positioned by `horizontal-align` /
  `vertical-align` / `transform`), NOT a vertical stack.

---

## 1. Dynamic panels & common `$` patterns

- Create: `$.CreatePanel('Panel'|'Label'|'Image'|'Button'|..., parent, id, { style, text, class, src })`.
  Only `src`/`class`/`style`/`id`/`text` are reliably settable as creation props; unknown props are
  ignored (e.g. `textureheight` as a prop is unverified — set via XML attribute instead).
- Style at runtime: `panel.style.width = '50%'`, `panel.style.backgroundColor = '...'`, etc.
- Events: `panel.SetPanelEvent('onactivate', fn)`, `panel.ClearPanelEvent('onmouseover')`,
  `$.RegisterEventHandler(event, panel, fn)`, `$.RegisterForUnhandledEvent(event, fn)`.
- Scheduling: `$.Schedule(seconds, fn)` (0 ≈ next frame; self‑reschedule for a per‑frame loop).
- Guards: `panel.IsValid()` before touching a panel that may be deleted; `panel.SetAttributeInt/GetAttributeInt`.
- Async web: `$.AsyncWebRequest(url, { type:'GET', complete:(d)=> d.statusText==='success' ? ... })`.
- Debug: `$.Msg('...')` → console. `$.Localize('#Key')`. `$.PlaySoundEvent('MenuThemeLight')`.
- Enums helper: `Enum.fastValuesNumeric(Gamemode)` returns a real Array.

---

## 2. In‑game APIs (globals, typed in `scripts/types-mom/apis.d.ts`)

### Map cache (local, no HTTP)
- `MapCacheAPI.GetMapData(id)` → `{ staticData: MMap, userData?, mapFileExists }`.
  `staticData.leaderboards[]` = `{ gamemode, trackType, trackNum, style, tier, type, ... }`.
  `staticData.status` (MapStatus; APPROVED=0). `staticData.id`, `staticData.name`.
  `userData.tracks` = `Record<bitkey, {completed, time}>`, bitkey = `gm<<24 | tt<<16 | tn<<8 | style`.
  Helpers in `common/leaderboard.ts` (`getTrack`, `getUserMapDataTrack`), `common/maps.ts`
  (`getTier`, `handlePlayMap`). `MapCacheAPI.MapQueuedForDownload(id)`.
- **No "list all maps" API to JS.** The catalog is C++‑side. Workaround (stats page): brute‑force
  `GetMapData(id)` over id = 1..`MAX_ID`(6000) — ids are sparse SUBMISSION ids; the newest APPROVED
  maps sit at high ids, so scan the FULL range (no early "stop after N misses" cutoff).

### Movement / player / input
- `MomentumMovementAPI.GetLastTickStats()` → `{ strafeRight:int, speedGain, idealGain, yawRatio }`.
- `MomentumMovementAPI.GetLastJumpStats()` → `{ jumpCount, takeoffSpeed, speedGain, yawRatio, strafeSync, ... }`.
- `MomentumMovementAPI.GetMoveHudData()` → `{ wishVel, maxspeed, acceleration, ... }`.
- `MomentumMovementAPI.GetTickInterval()`, `GetCurrentTime()` (seconds — **continuous frame time**, not
  tick‑quantized; snap to ticks with `round(GetCurrentTime()/GetTickInterval())`).
- `MomentumPlayerAPI.GetVelocity()` (vec3), `GetAngles()` (vec3; `.y` = yaw — Source yaw INCREASES
  turning left, so turning right ⇒ Δyaw < 0).
- `MomentumInputAPI.GetButtons()` → `{ physicalButtons, toggledButtons, disabledButtons, forcedButtons }`
  bitmasks. Bits in `common/buttons.ts` (`Button.MOVELEFT = 1<<9`, `Button.MOVERIGHT = 1<<10`, etc.).
  `(physicalButtons & Button.MOVERIGHT) !== 0`.
- `MomentumAPI.GetLocalUserData()` → full User incl `id`, `alias`, `steamID`, `userStats.mapsCompleted`.
- `GameModeAPI.GetMetaGameMode()` / gamemode names/styles. `GameInterfaceAPI.GetSettingBool/Float(cvar)`,
  `GetGameUIState()`.
- `MomMath` (`util/math`): `magnitude2D(vec)`, `sumOfSquares2D(vec)`.

### Enums (`scripts/common/web/enums/…`)
- **Gamemode** (tiered): 1 Surf, 2 Bhop, 3 Bhop HL1, 7 RJ, 8 SJ, 9 Ahop, 10 Conc, 11 Defrag CPM,
  12 Defrag VQ3, 13 Defrag VTG; climb 5 KZT, 6 1.6 (4 Climb‑Mom has 0 maps). `GamemodeCategory`
  {SURF, BHOP, CLIMB, …}; `GamemodeCategoryToGamemode` maps a category → `Gamemode[]`.
- **LeaderboardType** (the `type` field): RANKED=0, UNRANKED=1, HIDDEN=2, IN_SUBMISSION=3. Count only
  RANKED/UNRANKED; exclude HIDDEN/IN_SUBMISSION.
- **Style:** NORMAL=0 … SIDEWAYS=3, W_ONLY=4 … PRO=8, TELEPORT=9. Normal modes use style 0; **climb
  modes use PRO(8)/TELEPORT(9), no style 0**. `GamemodeStyles` / `GamemodeDefaultUIStyle`.
- **TrackType:** MAIN=0, STAGE=1, BONUS=2. **MapStatus:** APPROVED=0 (others = beta/testing).

### Completion model (definitive)
- Denominator = approved maps' non‑hidden leaderboards at the relevant style.
- Numerator (local) = `userData.tracks` — keyed by the **run style (mom_style)**. Pro/Teleport are climb
  *leaderboard* classifications, not run styles: climb runs are recorded at **style 0**. So
  `isDone(map, gm, style)`: `trackStyle = (style===PRO||style===TELEPORT) ? 0 : style`, then check
  `getUserMapDataTrack(userData, gm, MAIN, 1, trackStyle)?.completed`.
- **Numerator (remote user, from web API `/v1/runs`):** climb runs come back at style **8/9** (NOT 0),
  so match at the real leaderboard style with no Pro/TP→0 remap. (Two different code paths!)

---

## 3. Web API (used by the Stats page)

- Base `https://api.momentum-mod.org` (Swagger `/docs`). Public read endpoints, no auth.
- **Domain whitelist:** Panorama enforces `panorama/domain_whitelist.kv3` (`{ domains=[...] }`). A
  non‑listed host makes `$.AsyncWebRequest` **throw synchronously**. `api.momentum-mod.org` is already
  whitelisted here. **Read at STARTUP only — full restart to change.** (`-unrestrictedwebrequests`
  launch arg bypasses it.)
- **AsyncWebRequest response quirk:** `responseText` has a trailing NUL byte → plain `JSON.parse`
  throws. Use a brace/bracket‑counting `parseLeadingJson(txt)` (see `stats.ts`).
- **Throttling:** parallel bursts get dropped → retry with jittered backoff (`fetchJson(url, tries)`),
  modest concurrency (`pool()` limit ~10), small breather between batches.
- **Endpoints:** users `/v1/users/{id}`, `/v1/users?steamID=`, `/v1/users?search=<alias>`; PBs
  `/v1/runs?userID=X&isPB=true&take=100&skip=N` (take max 100; run has `{mapID,gamemode,trackType,trackNum,style,...}`);
  per‑map leaderboard `/v1/maps/{id}/leaderboard?gamemode&trackType&trackNum&style&userIDs={uid}` →
  `data[0].rank` (add `&take=1` unfiltered → `totalCount` = board size for percentile).
- Rank/WR are ONLY on the leaderboard endpoint (not on `/v1/runs`).

---

## 4. HUD customizer (`scripts/common/hud-customizer.ts`)

Register a HUD component:
```ts
registerHUDCustomizerComponent($.GetContextPanel(), {
  name: $.Localize('#Customizer_...'),   // display name shown in the customizer
  resizeX: true, resizeY: false,          // width from customizer; give an explicit CSS height (see below)
  gamemode: [...GamemodeCategoryToGamemode.get(GamemodeCategory.BHOP), ...],
  events: { event: 'HudProcessInput', panel: $.GetContextPanel(), callbackFn: () => this.onUpdate() },
  dynamicStyles: { ... },
  postInit: () => { ... },
});
```

**`dynamicStyles`** — each entry `styleID → { name, type: CustomizerPropertyType, callbackFunc?, onChanged?,
targetPanel?, styleProperty?, valueFn?, settingProps?, options?, children?, expandable? }`.
- Types: `NONE, NUMBER_ENTRY, CHECKBOX, SLIDER, DROPDOWN, COLOR_PICKER, GRADIENT_PICKER, FONT_PICKER`.
- `DROPDOWN` needs `options: [{label, value:string}]` (string‑enum values fine).
- Conditional UI: a parent lists `children: [{ styleID, showWhen: value|value[] }]`; child shows only
  when the parent's value matches. `expandable:true` + `type:NONE` = a manually‑expandable group.
  Nesting works (a child dropdown can itself have children). A styleID referenced as a child is NOT
  rendered at top level.
- `targetPanel` (`#id`/`.class`/tag or array) + `styleProperty` → auto‑sets a CSS prop from the value
  (`valueFn` to format, e.g. `v => \`${v}px\``). `callbackFunc(panel, value)` runs on init AND change;
  `onChanged(value)` runs only on change. `postInit` runs once after all styles init.

**CRITICAL default behavior:**
- Defaults come from `momentum/cfg/hud/hud_default.kv3` (BASE game, not the override), keyed by the
  panel `id`. **Every non‑NONE dynamicStyle MUST have a value there or the customizer throws**
  ("Could not load dynamic style value…"). Also the component needs an `enabled/offsetX/offsetY/width/
  height` block there or `reset()` throws. kv3 syntax: `key = value` / `key = "str"` /
  `key = [ "a", "b" ]`, whitespace‑separated, **no commas**.
- On init, `callbackFunc`/`styleProperty` only apply when the stored value is defined. Keep the TS
  class field default matching the kv3 default.
- Components default **`enabled = false`** — must be toggled on in the customizer to render at all.

**NumberEntry typing gotcha:** it clamps to `min` on EVERY keystroke, so a `min > 9` makes multi‑digit
values impossible to type (first digit < min → autofills to min). Use `min: 1` and clamp to the real
range inside `callbackFunc`.

**Sizing gotcha:** the customizer sets width/height on the registered panel, but some C++ HUD panels
size to content — a `height: 100%` root child then collapses to 0. Give the component root an explicit
CSS height (like `.strafetrainer { height: 80px }`).

**Adding a NEW HUD component without C++:** HUD elements are C++ panel types (`MomHud*`/`Hud*`) declared
in `layout/hud/hud.xml`; the C++ type auto‑loads `layout/hud/<kebab>.xml`. You can't add a new C++ type.
Trick: **repurpose an existing unused one** — we reused `MomHudStrafeSync` (was commented out as
"broken") for Strafe Offsets. The user‑facing name comes from `registerHUDCustomizerComponent`, so the
internal type name is invisible. **`MomHudStrafeSync` does NOT dispatch `HudProcessInput`** (that's why
it was "broken") → don't rely on the `events` HudProcessInput; drive updates with a self‑scheduled
`$.Schedule(0, ()=>this.loop())` loop guarded by `if (!panel?.IsValid()) return;`.

---

## 5. UICanvas drawing (`<UICanvas id=...>`, type in `scripts/types/shared/panels.d.ts`)

- Methods: `Clear(color)`, `DrawLinePoints(count, coords[x,y,…], thickness, color)`,
  `DrawSoftLinePoints(…softness…)`, `DrawPoly(count, coords, color)`,
  `DrawShadedPoly(count, coords, colorsPerPoint[])`, `DrawFilledCircle/Wedge`, `SetMaxDrawCommands(n)`.
- Coords are logical px, origin top‑left, **y grows down**.
- **Per‑frame pattern:** each update `canvas.Clear('#00000000')` then re‑issue all draws (Clear resets
  the command list). Guard `if (!canvas?.IsValid()) return;` and skip when size is 0.
- Real pixel size (account for UI scale): `W = canvas.actuallayoutwidth / canvas.actualuiscale_x`,
  `H = actuallayoutheight / actualuiscale_y` (same as `components/graphs/line-graph.ts`).
- `SetMaxDrawCommands` generously — a shaded quad can be several commands; too low drops draws at
  regular positions (looks like static vertical gaps).
- **UICanvas does NOT paint its own `backgroundColor`** — put a background on a wrapper panel behind it.
- Tiling gotcha: bars drawn per fixed screen slot with gaps show **static vertical lines** as data
  scrolls; tile edge‑to‑edge with a small overlap (opaque colors hide seams).

---

## 6. Custom features built in this fork

### 6a. Stats page — `layout|scripts/pages/stats/stats.{xml,ts}`, `images/stats.svg`
Top‑nav "Stats" button (`main-menu.xml` → `navigateToPage('Stats','stats/stats')`). Chunked
brute‑force scan of the map cache (id 1..6000), cached module‑level; **Rescan** re‑scans. Per‑gamemode
completion by tier: header Ranked/Unranked/Both filter, a horizontal gamemode bar (+ pinned "All"
aggregate), a per‑mode style bar, a left "general stats" card (segmented donut gauge from rotated tick
panels, completion bar, stat tiles, ranked/unranked split) and a right per‑tier card with a clickable
tier drill‑down that lists maps (status dot + play/download button via `handlePlayMap`, with a
`pollDownload` poller to flip download→play). No‑flash re‑render: card boxes + bar buttons are persistent
refs, only contents/highlights are refilled.
- **Live leaderboard ranks** (WRs / top10 / avg rank / avg %): a background priority queue
  (`rankQueue`/`enqueueRank`/`processRankQueue`) scans EVERY gamemode via the web API (1–2 requests per
  completed map), caches per `rankKey = mode|style|filter`; **"both" and "All" are derived** by summing
  disjoint per‑(mode,style,filter) results (each map queried once). `rankGen` guards rescans.
- **View another player:** header search box (id/SteamID64/steam URL/alias → `/v1/users`), fetch their
  PBs (`/v1/runs?userID&isPB`) into a `remoteDone` Set keyed `mapID|gm|tt|tn|style`; `isDone(map,…)` uses
  it when set, and `viewUid()` swaps the uid for rank fetches. "Me" resets to local.
- **Preload:** opt‑in. `main-menu.ts onPanelLoad` only pre‑warms (`$.Schedule(4, preloadStatsPage)`)
  when persistent `stats.preloadEnabled` is truthy (default off); a header toggle button
  (`StatsHandler.togglePreload()`) flips it. `enqueueAllModes` warms BOTH ranked+unranked.

### 6b. Strafe Trainer — Graph mode — `hud/strafe-trainer.{ts,xml,scss}`
Existing `MomHudStrafeTrainer` component; added a `DisplayMode.GRAPH`. A `<UICanvas id="GraphCanvas">`
inside `#GraphWrapper` (hidden via `visibility:collapse`; `updateDisplayMode` swaps bar‑wrapper vs
graph). Plots the smoothed **yaw ratio** (actual/optimal turn) as colour‑graded slices (colour by gain
via `getColorPair`); turning too fast pushes a slice OVER the optimal line. `graphHistory` = ring buffer
`{ratio, speed, gain}`, updated each `onUpdate`; scaled **per‑sample** (never a window aggregate — that
caused shifting). **Flat vs Dynamic optimal line** (`graphOptimalLine`): Flat = level line at
`graphRange`; Dynamic = scale ramps with speed (`GRAPH_MIN_SCALE 1.05` at rest → `1/GRAPH_DYN_FLOOR`
(0.25) at `GRAPH_DYN_MAX_SPEED` (2500)), so the optimal line falls as you speed up. Orientation
(horizontal/vertical) is a `map(t,frac)` remap. Slices tile edge‑to‑edge (+0.75px overlap). Draws top/
bottom bound lines (`graphBoundColor`) + optimal polyline (`graphLineColor`). Settings: graphOrientation,
graphOptimalLine, graphSamples(10–500), graphRange(%), graphLineColor, graphBoundColor, graphBackgroundColor
(on `#GraphArea` behind the canvas, default transparent). `resizeY:false`, explicit CSS height.

### 6c. Strafe Offsets (sync trainer) — `hud/strafe-sync.{ts,xml,scss}` (class `StrafeOffset`)
Repurposes the unused `MomHudStrafeSync` C++ panel (re‑enabled in `hud.xml`; `StrafeSync` block added to
`hud_default.kv3`). Shows a history of key↔mouse timing per strafe **keyswitch**: keyDir from
`GetButtons()&MOVELEFT/MOVERIGHT`, turnDir from `GetAngles().y` delta; a keyswitch pairs with a
same‑direction turn‑switch within `PAIR_WINDOW_TICKS`, offset = `keyTick − turnTick` in **whole ticks**
(>0 late, <0 early; snap times to ticks with `round(GetCurrentTime()/GetTickInterval())`). Bars on a
`UICanvas` grow up (late) / down (early) from a centre "perfect" line; a `<Label>` shows "Late Nt /
Early Nt / Perfect". Gamemodes BHOP+SURF+CLIMB. **Driven by a self‑scheduled `$.Schedule` loop** because
this panel doesn't get `HudProcessInput`. Sign convention (early/late) is the one thing to re‑verify
in‑game (flip the `dYaw<0` mapping if reversed).

### 6d. Main menu — CSS background + CS:S menu — `pages/main-menu/main-menu.{ts,xml}`, `styles/pages/main-menu.scss`
- Background from persistent `settings.mainMenuBackground` (enum `BackgroundMode` LIGHT=0/DARK=1/CSS=2)
  + `settings.mainMenuMovie` (bool). Video → `videos/backgrounds/<Name>.webm`; static →
  `images/backgrounds/<Name>.dds` (`.png` works; `.tga` unproven). Added custom static
  `background01.dds` (mode CSS, no video variant).
- Bottombar button `toggleCssBackground()` using `images/game-logos/css.png`; toggles CSS on/off (off
  reverts to system light/dark).
- **CS:S menu:** in CSS mode `setMainMenuBackground` adds class `mainmenu--css` to the root; all show/
  hide is in CSS (`main-menu.scss`): hides `.topnav`/`.topnav__shadow` (but NOT in pause —
  `.mainmenu--css:not(.MainMenuRootPanel--PauseMenuMode)`), hides `.home__wrapper` (spinning
  `#MainMenuModel` + `#NewsPanel`), hides `.home__bottombar > .bottombar__tooltip:not(.bottombar__tooltip--css)`
  (all bottombar btns except the CSS toggle), shows `#CssMenu`. `#CssMenu` (in HomeContent, so auto‑hidden
  in pause via `.MainMenuModeOnly` and when a page opens via `home--hidden`) = a Bebas‑Neue
  (`$font-header`) "Momentum Mod" title + list: FIND SERVER→map selector, OPTIONS→settings, STATS→stats,
  QUIT→`onQuitButtonPressed()`. The right‑side drawer (`.drawer` — rightnav strip + lobby) is hidden in
  main‑menu CSS mode via `.mainmenu--css:not(.MainMenuRootPanel--PauseMenuMode)`, and its 50px strip
  reclaimed (`.mainmenu__content { margin-right: 0 }`); it stays intact in the pause menu. Escape returns
  to the menu from any page.

### 6e. CS:S map selector — `pages/map-selector/css-map-selector.{ts,xml,scss}` (class `CssMapSelectorHandler`)
A **new** main‑menu page styled like the Source engine "Server Browser" (warm desaturated greys,
beveled light‑top/left dark‑bottom/right panels, an orange selected row). Opened from the CS:S menu's
**FIND SERVER** button (`navigateToPage('CssMapSelector', 'map-selector/css-map-selector', false)` —
`hasBlur=false` so the CS:S background stays crisp behind the window, no dark blur backdrop) — the base
C++ map selector (`map-selector/wrapper`) is untouched and still used by the normal top‑nav Play button.
Layout is minimal chrome; tabs / header / rows / filters are all built in TS.
- **Data:** brute‑force map‑cache scan (id 1..6000, 300/frame) exactly like the Stats page (§0/§2),
  module‑level cache so re‑opens are instant; **Refresh** re‑scans. `buildRow(map, gm)` resolves a map to
  a row for the selected gamemode via `getTrack`/`getTier`/`getAuthorNames`, classifying it
  ranked/unranked (approved maps, by `board.type`) or **beta** (`MapStatuses.IN_SUBMISSION` status).
  Beta maps are only listed if they have a tier for that gamemode/track (`getTier` truthy) — a proxy for
  a leaderboard having been created for them.
- **Tabs** = one per gamemode that has any map (`GamemodeInfo` icon+name). **Columns:** Map, Downloaded
  (`mapFileExists` → green ✓; flips in place when a Connect download finishes, via `MapDownload_End`),
  Completed (local `userData.tracks` via `getUserMapDataTrack` → gold ✓; same completion model as Stats —
  climb Pro/Teleport map to run‑style 0; reflects scan‑time state, updated on Refresh), Players, Tier,
  Authors, Date Created (`info.creationDate` → `YYYY‑MM‑DD` — the authored date), Date Added (= when the map
  went live: `info.approvedDate` [released] for approved maps, else `createdAt` [entered beta] for beta;
  the default sort is newest Date Added first); click a header to sort (▲/▼), shared width config in the `COLS` array. **Bottom bar** = Ranked/Unranked/Beta checkboxes (multi‑select;
  default **Ranked only**) + a map count + Refresh + **Connect** (`handlePlayMap(map, selectedMode)` —
  launches a downloaded map straight away (no status line — loads are fast and a lingering message would
  still show on reopen), else queues a download and writes its progress into the status line via the
  `MapDownload_*` events). Double‑click a row = Connect; Esc/X closes.
- **Players column caveat:** per‑map lobby counts are **not** JS‑queryable (see §7); it approximates by
  counting current‑lobby members' `map_name` from the `PanoramaComponent_SteamLobby_*` events — 0 for
  maps nobody in your lobby is on. Cells update in place via kept `rowPlayerLabels` refs.
- **Close button** dispatches the `MainMenu_ClosePage` global event (see §7 cross‑context gotcha), handled
  in `main-menu.ts` → `hideMainMenuPageContent()`.

---

## 7. Gotchas cheat‑sheet
- XML comments can't contain `--` → whole layout fails to load.
- Every non‑NONE customizer style needs a `hud_default.kv3` default (base game, needs restart).
- `NumberEntry` clamps to `min` per keystroke → use `min:1`, clamp in callback.
- Custom HUD components: `MomHudStrafeSync` doesn't fire `HudProcessInput` → self‑schedule updates.
- `UICanvas` has no background → use a wrapper; `Clear` per frame; size via `actuallayout*/actualuiscale_*`.
- Climb completion: local cache stores at style 0; web `/v1/runs` stores at style 8/9.
- `GetCurrentTime()` is frame time — snap to ticks for tick‑accurate offsets.
- HUD components + main‑menu components default `enabled=false`; enable in the customizer.
- `domain_whitelist.kv3` + kv3 + localization = startup‑only (restart).
- **Sub‑page XML can't call another page's `@PanelHandler`.** Each layout file with its own `<scripts>`
  is a separate JS context, so a page loaded via `navigateToPage` can't do `MainMenuHandler.foo()` from
  its XML (name not in its context object). Go cross‑context via the global event bus: add the event to
  `util/event-definition.ts` (`$.DefineEvent` + a `GlobalEventNameMap` entry), `$.DispatchEvent` from the
  sub‑page, `$.RegisterForUnhandledEvent` in the target context (e.g. `MainMenu_ClosePage`).
- **Per‑map "players in lobby" count is NOT queryable from JS.** Only source is the C++ event
  `MapEntry_MapLobbiesUpdated(playerCount)`, fired per‑map onto each C++ `MomHudMapEntry` panel (see
  `map-entry.ts`) — no `MapCacheAPI`/web getter. Custom lists can only approximate via current‑lobby
  members' `map_name` (only the lobby you're in is visible).

## 8. Where things live
```
panorama/
  layout/hud/{strafe-trainer,strafe-sync,hud}.xml
  layout/pages/{stats/stats,main-menu/main-menu}.xml
  layout/pages/map-selector/css-map-selector.xml        (CS:S map selector — §6e)
  scripts/hud/{strafe-trainer,strafe-sync}.ts
  scripts/pages/{stats/stats,main-menu/main-menu}.ts
  scripts/pages/map-selector/css-map-selector.ts        (CS:S map selector — §6e)
  scripts/util/event-definition.ts        (MainMenu_ClosePage cross-context event — §7)
  scripts/common/{hud-customizer,buttons,leaderboard,maps}.ts
  scripts/common/web/enums/*        (Gamemode, Style, LeaderboardType, TrackType, MapStatus, …)
  scripts/types-mom/{apis,panels}.d.ts   (in-game API + panel types)
  scripts/types/shared/panels.d.ts       (UICanvas, base panel props)
  styles/pages/main-menu.scss, styles/hud/{strafe-trainer,strafe-sync}.scss, styles/config.scss
  styles/pages/map-selector/css-map-selector.scss       (CS:S map selector — §6e; in _index.scss)
  images/backgrounds/background01.dds, images/game-logos/css.png
momentum/cfg/hud/hud_default.kv3          (customizer defaults — base game, restart to apply)
momentum/resource/momentum_english.txt    (localization — base game, restart to apply)
momentum/panorama/domain_whitelist.kv3    (web request allowlist — startup only)  [also custom/panoDev copy]
```
> Note: the web‑request whitelist that matters is `custom/panoDev/panorama/domain_whitelist.kv3` (the
> override copy) — it already lists `api.momentum-mod.org`.
