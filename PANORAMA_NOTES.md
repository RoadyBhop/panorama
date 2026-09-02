# Momentum Panorama — Custom HUD & Menu Notes

Reference for working on this custom Panorama override. Written to bootstrap a fresh, context‑free
session: it covers the folder layout, the important in‑game + web APIs, the HUD customizer system,
`UICanvas` drawing, every custom feature built here, and the gotchas that cost real debugging time.

> This is a **local client‑side override** of the game's Panorama files. It's overwritten by game
> updates and there's no addon/distribution system for HUD mods — it's for personal use.

---

## 0. Environment & workflow

- **Override root:** `steamapps/common/Momentum Mod Playtest/momentum/custom/panoDev/panorama/`
  (`custom/panoDev/` mounts over `momentum/`, so files here shadow the base game's). It's mostly
  `panorama/`, plus a **`cfg/hud/hud_default.kv3` override** (`custom/panoDev/cfg/hud/hud_default.kv3` — the
  customizer defaults, see §4; edit THIS copy, not the base one). Other `cfg/` files (e.g. `config.cfg`)
  and `resource/` localization are **not** overridden — those live in the base game and are edited in place.
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
- Defaults come from `custom/panoDev/cfg/hud/hud_default.kv3` (the **override** copy — it shadows the base
  `momentum/cfg/hud/hud_default.kv3`; edit the override), keyed by the
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

**Adding a NEW HUD component — you do NOT need C++.** (Earlier notes claimed you had to repurpose an
existing C++ panel — that's wrong; the whole customizer is pure Panorama/JS.) `registerHUDCustomizerComponent`
takes ANY `GenericPanel`, and `customizer.ts` `Component.register` only gates on **`panel.id` existing as a
key in `hud_default.kv3`** (`if (!defaultLayout[panel.id]) return null`). Positioning/sizing/enable are all
done in JS via `LayoutUtil.setPosition/​setWidth/​setHeight` + `panel.enabled` — they work on any panel. Proof:
the customizer registers its own plain `#CustomizerSettings` `<Panel>` as a component. So a brand‑new element
just needs: a `<Panel id="Foo">` on the HUD, an id‑matched `Foo` block in `hud_default.kv3`, and a
`registerHUDCustomizerComponent($('#Foo'), …)` call. The C++ `MomHud*`/`Hud*` types only exist to (a)
auto‑load their `layout/hud/<kebab>.xml` and (b) fire gameplay‑specific events (e.g. `DFJumpDataUpdate`) —
neither is required for a display element.
- **Getting a scripted panel onto the HUD without a C++ type:** put a **`<Frame src="…/foo.xml" …>`** in
  `hud.xml` (same mechanism as `console-notify`). The frame's own layout file has its own `<styles>`/
  `<scripts>`. `$.GetContextPanel()` inside that file returns the **layout's inner root**, NOT the `<Frame>`
  (verified: `news.ts` does `$.GetContextPanel().ToggleClass('news--minimized')` and the CSS is on the inner
  `.news` panel, not `#NewsPanel`). The inner root must have **no id** (loader rule, §7), so give the
  positioned element an **id on a CHILD** of the root and register THAT child; make the frame + inner root
  full‑screen (`width/height:100%`) so the customizer's absolute offset lands in screen coords. See the
  Segment Timer (§6g) for the full pattern.
- **A plain panel does NOT receive `HudProcessInput`** (only some C++ HUD panels do). Drive per‑frame updates
  with a self‑scheduled `$.Schedule(0, ()=>this.loop())` guarded by `if (!panel?.IsValid()) return;` — same as
  the repurposed `MomHudStrafeSync` (Strafe Offsets, §6c), which was reused precisely because it also doesn't
  fire `HudProcessInput`. Repurposing an unused C++ panel is still an option when you need its C++ events, but
  it's no longer necessary just to add a component.

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
- **`DrawPoly` is winding‑sensitive** — it culls the reverse vertex order, so a quad traced clockwise
  paints while the same quad traced counter‑clockwise draws nothing. Bars that grow in BOTH directions
  from a baseline (e.g. strafe‑offset up=late / down=early) must trace every quad with a FIXED winding
  (normalise to `[yTop, yBot]` and use one vertex order) — otherwise the opposite‑direction bars silently
  vanish. (`DrawShadedPoly` behaves the same; the trainer graph never hit this because its bars only ever
  grow one way.)
- **UICanvas does NOT paint its own `backgroundColor`** — put a background on a wrapper panel behind it.
- Tiling gotcha: bars drawn per fixed screen slot with gaps show **static vertical lines** as data
  scrolls; tile edge‑to‑edge with a small overlap (opaque colors hide seams).

---

## 6. Custom features built in this fork

### 6a. Stats page — `layout|scripts/pages/stats/stats.{xml,ts}`, `images/stats.svg`
Top‑nav "Stats" button (`main-menu.xml` → `navigateToPage('Stats','stats/stats')`). Chunked
brute‑force scan of the map cache (id 1..6000), cached module‑level; **Rescan** re‑scans. Per‑gamemode
completion by tier. **Top layout:** row 1 = title + Preload/Rescan; row 2 = player search (left) +
Ranked/Unranked/Both filter (`#StatsFilter`, right) on one level; then only the gamemode bar (+ pinned
"All" aggregate). A left "general stats" card (segmented donut gauge from rotated tick panels, completion
bar, stat tiles, ranked/unranked split, then the group‑rankings block). The **right card is two columns**
(`fillRight`): a narrow **sub‑left** (fixed 330px, scrolls) holding the **per‑mode style selector**
(`renderStyles` — moved here from the page top; there's no `#StatsStyleBar` any more) + the clickable
per‑tier completion bars, and a **sub‑right** = the map list filling the **full card height** (so it shows
many more maps). **The map list shows every tier's maps when no tier is selected** (`renderTierMaps(holder,
null)` → `mapsInTier(null)`; rows get a `T#` badge); clicking a tier filters to it, clicking again
deselects → all maps again. **Sort: completed maps first, then low→high tier, then name.** Rows = status
dot + name + (async) rank cell + play/download button via `handlePlayMap` (`pollDownload` poller flips
download→play). No‑flash re‑render: the two card boxes + gamemode/filter buttons are persistent refs; the
right card's inner columns rebuild on mode/style/filter change (a tier click only refills the map holder +
restyles the tier rows, via `refreshTierExpansion`).
- **Live leaderboard ranks** (group rankings + avg rank + avg %): a background priority queue
  (`rankQueue`/`enqueueRank`/`processRankQueue`) scans EVERY gamemode via the web API (1–2 requests per
  completed map), caches per `rankKey = mode|style|filter`; **"both" and "All" are derived** by summing
  disjoint per‑(mode,style,filter) results (each map queried once). `rankGen` guards rescans. The old
  separate "Leaderboard ranks" section (WRs/Top 10 tiles) is gone — those counts live in the ladder's
  WR/T10 cells now; only **Avg rank** + **Avg %** remain, as small boxes under the ladder.
  - **Scan yields HTTP to map play/download** (`rankPausedUntil` / `pauseRankScan` / `waitWhilePaused`): the
    scan's flood (`pool` concurrency 10 × up to 20 retries, every mode) shares the game's HTTP client with
    **map downloads**, so a tier‑row play/download button appeared dead until the whole scan finished. Now a
    play click calls `pauseRankScan(6)` (and `pollDownload` refreshes it each tick while the map is queued), and
    every `fetchJson` attempt first `await`s `waitWhilePaused()` — so in‑flight scan requests drain and no new
    ones fire, freeing HTTP for the download; the scan resumes ~6s after the download ends. Pause starts at 0
    (no delay to the initial scan).
- **Group rankings ladder** — the headline of the left card's rank block, best→worst:
  **WR · T10 · G1 … G6** (+ implicit "No group"). Each completed *ranked* map lands in exactly ONE cell.
  **WR (rank 1)** and **Top 10 (ranks 2–10)** are pulled out ABOVE the numeric groups — since every G1
  threshold is ≥ 20, a rank ≤ 10 would otherwise always be G1, so those maps are marked WR/Top 10 instead
  (both in the strip and per‑map). A map with rank > 10 earns group *i* if `r ≤ max(N·pct + 10, floor)` —
  `GROUP_DEFS` = G1 (2%,20) G2 (4%,35) G3 (8%,60) G4 (16%,100) G5 (33%,150) G6 (66%,225); the floor keeps
  small boards fair; thresholds nest so `bestGroup(rank,total)` returns the first that qualifies G1→G6.
  The WR/T10 cell counts come from `RankResult.wr`/`top10` (phase 1, rank only); the G1…G6 counts
  (`groups[6]`, index 0=G1, now **excluding rank ≤ 10**) need each board's total so they're computed in
  the scan's **phase 2** and read "…" until then. All are summable, so "both"/"All" aggregate like the
  other rank stats — but clone `groups` at every result‑creation site (a bare `{...EMPTY_RANK}` shares the
  array). These stay separate from the cumulative **WRs**/**Top 10** tiles above (WR ⊂ Top 10 there).
- **Per‑map rank detail in the tier map list** — clicking a tier lists its maps; each *completed* map's
  row shows **group · placement (#rank) · your time · WR diff** on the right. Sourced from the same rank
  scan (no extra calls): `fetchRank` now also returns your `time`; `fetchTotal` (the `take=1` percentile
  call) also returns `data[0].time` = the **rank‑1 WR time**, so the WR diff is free. Stored in
  `perMapRank[mapID|gm|style]` (`{rank,time,total,wrTime}`), cleared with the rank cache. The list renders
  instantly (blank cells) and each cell is **filled in place** by `updateTierRankRow` as the scan lands —
  it never blocks the list. Only completed maps are scan targets, so incomplete maps stay blank (you have
  no rank). Group cell reads **WR** / **TOP 10** (rank ≤ 10, shown at once from phase 1), else **G#** /
  **No group** (below G6) once phase 2 lands, "not ranked" when you're not on the current board. The WR‑diff
  column is blank for the WR itself (the group cell already says WR). `tierRankRows` holds the live cell
  refs (like the css‑map‑selector Players column).
- **Top‑10 popup (click a map name).** Each tier‑map row's **name label** is clickable (attached to the
  label, NOT the row, so it never conflicts with the play button's own click; onactivate bubbles up) →
  `openMapLeaderboard(mapID, gm, style, name)`. Full‑page overlay `#StatsLbPopup`, toggled via
  **`style.visibility` visible/collapse** (reliable). A layout `<root>` allows only ONE top‑level panel and
  it must have **no id**, so the page and the popup are wrapped in a single **id‑less root `<Panel>`** with
  default (overlap) flow — the popup then covers the page. Rows = badge (WR/T10/G1..G6) · #rank · avatar ·
  player · time · **+WR diff** (vs rank‑1) · **vs You** (signed gap to the viewed user's own PB — `−` faster,
  `+` slower; header reads "vs Them" for a searched user), unified via `fillLbRow`. **Popup times show 3
  decimals** — `fmtTime`/`fmtDiff`/`fmtVsYou` take a `decimals` arg (default 2; `fillLbRow` passes 3); the
  tier‑list rank cells keep the 2‑dp default. The viewed user's time is
  free from `perMapRank[key].time` when the scan has it, else one `userIDs=` call via `getYourTime` (cached in
  `yourTimeCache[key|uid]`, run in PARALLEL with the board fetch so it adds no latency). Data:
  `GET /v1/maps/{id}/leaderboard?…&take=10` — **the response embeds `user` (alias + `steamID` + avatarURL) by
  DEFAULT; `expand` is REJECTED (400 "property expand should not exist")**. Avatars come from
  `<AvatarImage>`/`.steamid = user.steamID` (Steam client supplies them — **no web call**; the avatarURL host
  isn't whitelisted anyway).
- **Popup map-image strip (left column).** The popup card is now **two columns** (`flow-children: right`,
  widened to 1080px): a left **`#StatsLbImages`** vertical strip of the map's screenshots + the right
  leaderboard content column (title/subtitle/status/`#StatsLbList`, unchanged). `renderMapImages(mapID)`
  (called at the top of `openMapLeaderboard`) pulls `mapStaticById(mapID)?.images` — the **`MapImage[]`
  already in the local scan cache**, each with full CDN urls (`small/medium/large/xl`) — and `SetImage`s
  the `medium` url (plenty for a 240px strip) onto a 240×135 `<Image>` per screenshot (cast to `ImagePanel`
  to call `SetImage`). Modelled
  on the map selector's **Gallery** button (`components/gallery.ts` → `openGallery`), but that path needs the
  `MomentumMapSelector` C++ panel's `applyMapImageToImagePanel` (not available in this context); here we just
  `SetImage` the CDN url directly, exactly like `loading-screen.ts` does with `thumbnail.large`. **Image
  `SetImage(httpUrl)` is NOT domain-whitelist-gated** (only `$.AsyncWebRequest` is), so no web-request plumbing.
  The strip **collapses** (`visibility: collapse`, no reserved width — the content column fills) when the map
  has no images, and is cleared in `closeMapLeaderboard`.
- **Group cutoffs (last place in each group) + where you place.** Below the top 10 the popup lists the **cutoff
  person for each group G1..G6** — the worst rank still inside that group — and slots the **viewed user's own
  row** in at the rank they'd place (`getViewedUserIdentity` for alias/steamID + `getYourStanding` for rank),
  merged into the cutoff list in rank order, badged with their `bestGroup`. Only shown when they're OUTSIDE the
  top 10 (they already appear there — highlighted) and actually on the board. The cutoff RANK is computed from
  the board size (`computeGroupCutoffs`) with the SAME thresholds as `bestGroup` (`floor(max(total·pct+10,
  floor))`, capped at `total`, above the Top‑10 boundary, empty groups skipped), so only **one
  `skip=rank-1&take=1` call per group** is needed (not the whole board). **After G6 the board's absolute last
  place** (worst rank = `total`) is appended as a final **`LAST`** row (muted red badge) — added as a cutoff
  with **sentinel `group: 0`** (`cutoffBadge(group)` maps 0→`LAST`, 1..6→`G#`), so it reuses the same
  `fetchCutoffs`/`lbCutoffRefs` in-place fill. Only added when the board runs past the top 10 AND that rank
  isn't already a group cutoff (on small boards the last group cutoff already IS last place, so no dup; the
  `showYou` dedup also then covers a viewed user who is last). Fetched in parallel via `fetchCutoffs`,
  each filled **in place** into its kept `lbCutoffRefs` row as it lands ('…' pending → '—' if it fails). Everything is cached in
  **`mapLbCache[perMapKey]`** (`{rows,total,cutoffs}`) for the session (0 calls on re‑open); the completion
  count is LOCAL cache (no HTTP) and the rank scan only pulled `take=1`/your‑rank, so none of this is available
  without these on‑demand calls. `lbGen` guards stale/overlapping fetches; a `MainMenuPageHidden` handler
  collapses the popup on Esc/leave so it can't reappear over a fresh open. Cleared on rescan.
  - **Per‑map Refresh button** (popup header, next to ✕): re‑fetches just the open board. `openMapLeaderboard`
    takes a `force` flag → `delete mapLbCache[key]` (board re‑fetched) and `getYourStanding(…, force)` bypasses
    BOTH the `perMapRank` and `yourStandingCache` reads for a fresh `userIDs=` call (perMapRank is NOT cleared,
    so the tier row behind the popup keeps its value). The open map is remembered on the handler
    (`lbMapID/lbGm/lbStyle/lbMapName`, set in `openMapLeaderboard`, nulled in `closeMapLeaderboard`) so
    `refreshCurrentMap()` can re‑open it with `force=true`. Cutoffs re‑fetch automatically (fresh entry →
    all `fetched:false`).
  - **Popup click‑through fix:** the card `<Panel>` has **`hittest="true"` + `onactivate=""`** so clicks on its
    own background/labels don't fall through to the full‑screen `#StatsLbBackdrop` button and close it (see §7).
  - **Right‑click a run row → context menu** (`fillLbRow` sets `oncontextmenu` on each filled row →
    `showRunContextMenu(row)`) via `UiToolkitAPI.ShowSimpleContextMenu`: **View map on Momentum** (opens
    `<mom_api_url_frontend>/maps/<name>` in the Steam overlay) + **Show Steam Profile**
    (`SteamOverlayAPI.OpenToProfileID`).
    - ⛔ **Watching an online replay in‑game is NOT possible from this popup** (tested: does nothing in map or
      lobby). Confirmed dead ends: `mom_tv_replay_watch` takes a **local file path only** (a CDN URL is a no‑op);
      no exposed JS API downloads an arbitrary run's `.mrec` to disk; `MomentumReplayAPI` only controls an
      already‑loaded replay. The base game watches online replays purely in C++ via
      **`LeaderboardEntry_PlayReplay(itemIndex)`**, where `itemIndex` is the row's **position in a C++
      `Leaderboards` panel's loaded times list — NOT the global rank** — and that panel must already hold this
      exact map+gamemode+track+style (only ever the map selected in the base map selector, or the map you're
      currently on). Our web‑API popup has no such panel for arbitrary maps, and the panel's exposed methods
      (`selectTrack`/`applyFilters`/`getTimesListStatus`) can't load an arbitrary map or play a rank. So the menu
      links out instead. `Top10Row.downloadURL` is still captured (from `e.downloadURL`) for a possible future
      local‑download+`mom_tv_replay_watch` path, but is currently unused.
- **Tier‑row tooltip flicker fix / persistent tier rows.** Clicking a tier used to rebuild the whole
  right card, recreating the hovered row — so its "Show tier X maps" hover tooltip flashed at the press
  point for one frame (the tooltip re‑anchored to the not‑yet‑laid‑out new panel) before snapping back.
  Fix: the tier rows are now **persistent** (`tierBtns`) and the expanded list lives in a persistent
  `tierMapHolder`; `selectTier` → `refreshTierExpansion` only restyles rows (`styleTierRow` — toggles bg +
  `borderColor`, since only border‑left has width) and refills the holder. The hovered row is never
  recreated, so no flicker. Full rebuild (`fillRight`) still happens on mode/style/filter change.
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
- **Both axes resize** (`resizeX:true`, `resizeY:true`): `.strafeoffset` is `width:100% height:100%` so it
  fills the panel the customizer sizes (defaults `width 240 height 90` in the kv3 block); `draw()` reads
  the live canvas size each frame, so the bars rescale as you drag the knobs. (Do NOT reinstate a fixed
  CSS height — that pins the graph and the resize knob does nothing.)
- **Per‑tick grid:** `draw()` lays one faint **full‑width solid line** at every whole‑tick offset (rows
  `half/maxOffset` px apart, thickness `GRID_THICKNESS`=1) behind the bars, so magnitudes read at a glance.
  Skipped when a row would be < `GRID_MIN_TICK_PX`(3)px tall (too dense). Colour = the solid line colour
  dimmed to `GRID_ALPHA_FACTOR`(0.5×) via a `dim()` helper — **build the rgba string with a short
  `alpha.toFixed(3)`**; a long float alpha (`0.2007843…`) can trip the colour parser and draw nothing.
  ⚠️ **Do NOT make these dotted:** a dashed line is dozens of tiny `DrawLinePoints` per row, and with ~14
  rows every frame it dropped FPS ~500→200. One solid line per row is ~free (`SetMaxDrawCommands` back to
  512). If you want a dashed *look*, do it some other way (e.g. a tiled texture), never per‑dash draw calls.
- **Visibility gotcha (nothing renders, but logs fire):** the C++ `MomHudStrafeSync` panel gates its own
  visibility on the legacy convar **`mom_hud_strafesync_draw`**, which ships as **0** in `cfg/config.cfg`
  — so C++ forces the whole panel invisible (no bars, no lines, no text) *regardless of our layout*, while
  the self‑scheduled loop keeps running and `$.Msg`‑logging the right offsets. THIS is the "old disabled
  hud" trap. Fix: the constructor runs `GameInterfaceAPI.ConsoleCommand('mom_hud_strafesync_draw 1')` on
  every (re)load (survives `panorama_reload`, which re‑runs the ctor but does NOT re‑read `config.cfg`),
  and `config.cfg` was flipped to `"1"` so it's on at a fresh launch too. After that the customizer's
  `enabled` toggle governs show/hide like any other component. (Other HUD panels use the same per‑panel
  convar pattern — e.g. `mom_hud_speedometer_show 1`; strafesync was the only one shipping at 0.)

### 6d. Main menu — CSS background + CS:S menu — `pages/main-menu/main-menu.{ts,xml}`, `styles/pages/main-menu.scss`
- Background from persistent `settings.mainMenuBackground` (enum `BackgroundMode` LIGHT=0/DARK=1/CSS=2)
  + `settings.mainMenuMovie` (bool). Video → `videos/backgrounds/<Name>.webm`; static →
  `images/backgrounds/<Name>.dds` (`.png` works; `.tga` unproven). Added custom static
  `background01.dds` (mode CSS, no video variant). `setMainMenuBackground()` was refactored into
  `showBackgroundVideo(file)` / `showBackgroundImage(file)` helpers + `isVideoFile()`.
- Bottombar button `toggleCssBackground()` using `images/game-logos/css.png`; toggles CSS on/off (off
  reverts to system light/dark).
- **Background selector (override any background by file name).** Persistent `settings.mainMenuBackgroundOverride`
  (`BG_OVERRIDE_KEY`) holds a **file name with extension**; when set it wins over the themed default in
  `setMainMenuBackground` (`.webm`→video from `videos/backgrounds/`, image ext→static from `images/backgrounds/`).
  Opened from **both menus**: a bottombar button (`movie-open-outline.svg`, normal menu) and a **BACKGROUND**
  `#CssMenu` item (CS:S menu). UI = the `#BackgroundSelector` overlay (`.bgselector`, a centred card +
  click‑backdrop, **hidden via `visibility:collapse` + toggled with the `bgselector--open` class** — a plain
  `visible="false"` attribute did NOT keep it closed on load) with a `TextEntry` name input, an Apply button, quick‑pick buttons for the
  `KNOWN_BACKGROUNDS` (Panorama **can't list a folder from JS**, so these are hardcoded — extend as art is
  added), a status line, and a **Reset to theme default** button (clears the override). **"Error if not found"**
  for images uses the `#BackgroundProbe` preview Image: `applyBackgroundByName` routes by extension, and for an
  image `SetImage`s the probe — its **`PanelLoaded`** handler (registered in `onPanelLoad`) commits the override,
  its **`ImageFailedLoad`** handler reports "not found" (guarded by `pendingBackground`). webm can't be probed
  (no image‑load event), so it's applied directly. The light/dark + CSS toggles clear the override first so they
  still visibly change the background. `onEscapeKeyPressed` closes the selector before anything else.
- **Background selector — remote image URLs + anime image search (nekos.best).** The override now also accepts a
  **full `http(s)://` URL**: `setMainMenuBackground` routes it (via `isRemoteUrl`) to `showBackgroundImageUrl` →
  `image.SetImage(url)` directly (SetImage takes a CDN url and is **NOT domain‑whitelist‑gated**, unlike
  `$.AsyncWebRequest`). `applyBackgroundByName` also commits a pasted URL as‑is. The selector has an **anime
  image search** section (added below the presets in `main-menu.xml`): a keyword `TextEntry` + Search button, the
  `NEKO_CATEGORIES` quick‑picks (`neko/waifu/husbando/kitsune` — the 4 **PNG** categories; the ~58 GIF ones are
  skipped since a static background wants a still image), a status line, and a scrollable thumbnail grid
  (`#NekoResults`, `.bgselector__nekogrid`). **Why nekos.best** (`https://nekos.best/api/v2`, added to
  `domain_whitelist.kv3`): among the no‑auth anime APIs it's the one that actually works in Panorama — **no API
  key**, a real **`/search?query=&type=1&amount=`** keyword endpoint AND **`/{category}?amount=`** browse, and it
  serves **PNG** (waifu.im/nekosapi serve **webp**, which the Image panel may not render; nekosia.cat is
  Cloudflare‑gated; nekosapi defaults to explicit content). Response = `{ results: [{ url, artist_name, source_url,
  dimensions }] }`; each result's `url` is a PNG on `nekos.best`. `nekoFetch` = promise‑wrapped `AsyncWebRequest`
  + `parseLeadingJson` (same trailing‑NUL quirk as the Stats page). `nekoGen` discards stale responses; clicking a
  thumbnail → `applyNekoImage` → `commitBackgroundOverride(url)`. Opening the selector auto‑loads the `neko`
  category so the grid isn't empty. **CAVEATS:** (1) the whitelist is **startup‑only → full game restart** (not
  `panorama_reload`) before the API call works — until then it shows "Search failed…". (2) nekos.best docs say a
  User‑Agent header is "mandatory"; `AsyncWebRequest` can't set headers, so this relies on the **engine's default
  UA** being accepted — verify in‑game. (3) if the whitelist host is missing, `AsyncWebRequest` **throws
  synchronously**, but it's inside `nekoFetch`'s Promise executor so it rejects cleanly (no crash).
- **CS:S menu:** in CSS mode `setMainMenuBackground` adds class `mainmenu--css` to the root; all show/
  hide is in CSS (`main-menu.scss`): hides `.topnav`/`.topnav__shadow` (but NOT in pause —
  `.mainmenu--css:not(.MainMenuRootPanel--PauseMenuMode)`), hides `.home__wrapper` (spinning
  `#MainMenuModel` + `#NewsPanel`), hides `.home__bottombar > .bottombar__tooltip:not(.bottombar__tooltip--css)`
  (all bottombar btns except the CSS toggle), shows `#CssMenu`. `#CssMenu` (in HomeContent, so auto‑hidden
  in pause via `.MainMenuModeOnly` and when a page opens via `home--hidden`) = a Bebas‑Neue
  (`$font-header`) "Momentum Mod" title + list: FIND MAPS→CS:S map selector (§6e), FIND LOBBIES→CS:S
  lobby browser (§6f), OPTIONS→settings, STATS→stats, BACKGROUND→`openBackgroundSelector()` (§6d
  background selector), QUIT→`onQuitButtonPressed()`. (Menu items are
  plain `.cssmenu__item` buttons — add one by copying a `<Button>` in `#CssMenu`, no SCSS needed.)
  The right‑side drawer (`.drawer` — rightnav strip + lobby) is hidden in
  main‑menu CSS mode via `.mainmenu--css:not(.MainMenuRootPanel--PauseMenuMode)`, and its 50px strip
  reclaimed (`.mainmenu__content { margin-right: 0 }`); it stays intact in the pause menu. Escape returns
  to the menu from any page.

### 6e. CS:S map selector — `pages/map-selector/css-map-selector.{ts,xml,scss}` (class `CssMapSelectorHandler`)
A **new** main‑menu page styled like the Source engine "Server Browser" (warm desaturated greys,
beveled light‑top/left dark‑bottom/right panels, an orange selected row). Opened from the CS:S menu's
**FIND MAPS** button (`navigateToPage('CssMapSelector', 'map-selector/css-map-selector', false)` —
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

### 6f. CS:S lobby browser — `pages/lobby-list/css-lobby-list.{ts,xml,scss}` (class `CssLobbyListHandler`)
A sibling to the CS:S map selector, opened from the CS:S menu's **FIND LOBBIES** button
(`navigateToPage('CssLobbyList', 'lobby-list/css-lobby-list', false)`). Same Source "Server Browser"
look (its `.csslobbies` SCSS mirrors `.cssmaps`; registered via a new `styles/pages/lobby-list/_index.scss`
that `styles/pages/_index.scss` `@use`s). Lists the **same lobbies as the drawer's lobby tab** — but the
drawer's `LobbyHandler` is a **different JS context**, so this page can't read its data; instead it keeps
its **own** copy by registering for the same broadcast events (§7 — unhandled events reach every context):
`PanoramaComponent_SteamLobby_OnListUpdated` (friends/global lists — only arrive after a
`SteamLobbyAPI.RefreshList({})`), `_OnDataUpdated` (our `current` lobby, arrives automatically while in
one), `_OnLobbyStateChanged` (LEAVE clears `current`). On open (root `onload` + a `MainMenuPageShown`
handler) it calls `RefreshList({})` (no‑op on the C++ 10s cooldown → keeps the existing list).
- **Rows** de‑dupe across the three lists (`current`/`friends`/`global`) by lobby id and sort by member
  count desc. **Columns:** Lobby (owner name via `#Lobby_Owner`+`FriendsAPI.GetNameForXUID`, or "Map Lobby"
  — tinted — for `is_map_lobby===1`; mirrors the drawer's `getLobbyName` but drops the empty
  `MapCacheAPI.GetMapName()` parenthetical), Type (`#Lobby_Type_*` from `LobbyProperties`), Source
  (Yours/Friends/Global), Players (`members/limit`). Header is static (no sort). **Bottom bar:** count +
  Create (same `lobby-create.xml` popup the drawer opens) + Refresh + **Join** (disabled unless a lobby is
  selected and it isn't the one you're in). Join replicates the drawer's leave‑and‑join confirm
  (`#Lobby_TransferWarning`/`#Lobby_LeaveWarning` → `SteamLobbyAPI.Leave()`+`Join(id)`). Double‑click a row =
  Join; Esc/X closes via `MainMenu_ClosePage`. The lobby id (the list's record key) is what `Join` takes.
- **Caveat:** in main‑menu CS:S mode the real drawer is hidden, so after joining there's no in‑CS:S lobby
  details/chat UI — toggle CSS off (or use the pause menu) to see the lobby. Joining still works.

### 6g. Segment Timer (HUD) — `hud/segment-timer.{ts,xml,scss}` (class `SegmentTimerHandler`)
**The proof that a HUD customizer element needs no C++** (see §4). A savestate‑practice stopwatch: the real
run timer is disabled by `mom_savestate_create`/`_load` (practice mode), so this keeps an INDEPENDENT
"virtual run time" that survives save/load.
- **Not a C++ panel.** A `<Frame class="segmenttimer-frame" src="…/segment-timer.xml" hittest="false" …>` is
  added to `hud.xml` among the general elements. `segment-timer.xml`'s root is an id‑less full‑screen
  `.segmenttimer-root`; the positioned element is its **child `#SegmentTimer`** (id on the child, not the
  topmost root — §7 loader rule). Both frame + root are `width/height:100%` so the customizer's absolute
  offset = screen coords. Registered with `registerHUDCustomizerComponent($('#SegmentTimer'), …)`; dynamicStyles
  = `fontSize` (NUMBER_ENTRY→fontSize px), `fontColor` (COLOR_PICKER→color + `getTextShadowFast`), `showSlot`
  (CHECKBOX→`.segmenttimer__slot` visibility). Names are **plain strings** (no `$.Localize`) so no
  localization/restart needed. `hud_default.kv3` `SegmentTimer` block: `enabled/offsetX 900/offsetY 480` +
  those three dynamicStyles.
- **One clock** — the SEGMENT time (`Stopwatch` helper: pausable, `value = base + (now − origin)` while
  running, else `base`, off `MomentumMovementAPI.GetCurrentTime()`), updated each frame by a **self‑scheduled
  `$.Schedule(0,…)` loop** (a plain panel gets no `HudProcessInput`), shown via
  `SetDialogVariableFloat('segtime', …)` + label `{g:time:segtime}` (`.segmenttimer__segment`, green; the
  customizer font controls target it). It's the **"spliced" virtual run time**: only accumulates real gameplay
  progress — creating a savestate snapshots THIS value; loading rewinds to that snapshot, so failed retries are
  discarded and good segments stitch together (= run pace). Unknown savestate → rewinds to 0. (An earlier
  version had a second white "total" wall‑clock timer; removed — the layout/scss still support a second label
  if wanted.)
- **Sits at 0 in the start zone**: `OnObservedTimerStateChange` → `PRIMED` = in start zone → `resetPaused()`
  (0, frozen); `RUNNING && majorNum===1 && minorNum===1` = run start → `resetRunning()` (0, counting). All
  other states (mid‑run, FINISHED, **DISABLED/practice**) are left alone so the clock keeps running through
  savestate practice. `LevelInitPostEntity` resets to 0/frozen.
- **Per‑slot save/load** via `OnSaveStateUpdate(count, current, usingMenu)` (§7): `current` is 0‑indexed;
  `usingMenu` true ONLY on teleport/load (incl console command), false on create/menu‑close. Storage =
  **`Map<slotIndex, segmentTimeAtCreation>`** (NOT a splice array — that got corrupted by pre‑existing
  savestates). Branch order matters: **count===prev+1 = create** → `creation.set(current, segment.value())`
  (snapshots the GREEN value); **count>prev+1 = bulk sync** (savestates loaded from disk — adopt count, store
  nothing); **count<prev = delete** → drop keys ≥ count; **count 0 = clear**; **count===prev && usingMenu =
  load**.
- **Freeze at a saveloc is driven by the LIVE player movetype in `update()`, NOT by the savestate events.**
  A load‑type `OnSaveStateUpdate` (`count===prev && usingMenu`) — a `+mom_savestate_load` hold press, a menu
  **switch**, or a load — only RECORDS the target slot's snapshot in `loadTarget` (`onSaveStateLoad`). Each
  frame `update()` reads `MomentumMovementAPI.GetMoveType()`: on the transition **into `NONE`** (parked at a
  saveloc) it parks the timer at `loadTarget` (`setValue`+`pause`, `segFrozen=true`, gated on `loadTarget` so
  an unrelated spawn‑NONE can't freeze it); on the transition **out of `NONE`** it resumes (`segment.start()`).
  - ⚠️ **Three dead ends before this** (all in git history): (1) a press/release **toggle** — but a hold
    fires the event on both press AND release while **switching/map‑load teleports fire LONE events**, so the
    parity flipped → stuck/inverted after a switch. (2) resume on **velocity** — while held the player's
    velocity reads the **stored EXIT speed** (not 0), so it resumed instantly. (3) freeze/resume decided
    **from the event's movetype** — a single hold fires TWO events with different movetype (`move=0`/NONE on
    the frozen press, `move=2`/WALK on the release) in inconsistent order, so it worked only sometimes. Only
    the **live** movetype, sampled every frame, reflects the true parked‑vs‑playing state. `MoveType.NONE=0`;
    while parked velocity is stored‑but‑not‑applied (hence the non‑zero speedometer), so movetype — not
    velocity — is the signal.
  - A `#SegmentTimerSlot` label shows `SS current/count`. `const DEBUG` `$.Msg`‑logs each event + freeze /
    resume (with `move=`) — leave on until confirmed in‑game.
- **Spliced jump count** — a `splicedJumps` counter that mirrors the segment clock: ++ on each jump, reset to
  0 on run start / start‑zone / level load, snapshotted on savestate create and **rewound on load** (so the
  jump number splices with savestate practice just like the time). Driven by the **global unhandled
  `OnJumpStarted` event** (same one the jump‑stats/strafe‑trainer HUDs use; register with
  `$.RegisterForUnhandledEvent`, NOT tied to a C++ panel — replaces the earlier raw
  `GetLastJumpStats().jumpCount`).
- **Jump log** (`#SegmentTimerLog`) — the spliced jump count + segment time at each of the last
  `JUMP_LOG_SIZE`(6) jumps, **newest on the bottom** (`push` + `shift` off the top), as `<splicedJumps>
  M:SS.hh`. Rendered via `SetDialogVariable('jump_log', …\n‑joined)`. Cleared on run start / start‑zone /
  level load.
- **Persistence** (`$.persistentStorage`, JSON key/value, survives map loads AND restarts — no file I/O): the
  `creation` map is saved per map, keyed `segment-timer.creation.<MapCacheAPI.GetMapName()>`, as
  `[...creation.entries()]` — now `[slot, {time, jumps}][]` (`loadCreation` back‑compats the old bare‑number
  format → `{time, jumps:0}`). `saveCreation()` runs whenever `creation` changes (create/delete/clear). The
  game reloads a map's savestates from its own `.msav`, so on re‑entry the restored `creation` supplies each
  slot's spliced time + jump count — pre‑existing savestates rewind to their real values instead of 0. (Only
  the slot→snapshot map is persisted; the live clock/counter are ephemeral — back at 0 on re‑entry.)
  - **Load timing was the bug** (first attempt didn't persist across reload): `MapCacheAPI.GetMapName()` can
    be **empty at `LevelInitPostEntity`/ctor time**, so `loadCreation` keyed on `""` and loaded nothing. Fixed
    with **`ensureLoaded()`** (loads only once the name is available, tracked by `loadedForMap`) called from
    ctor, `reset()`, AND the top of `onSaveStateUpdate` (the map name is reliably ready by the time savestates
    load — the safety net). **And** the disk‑load re‑announces existing savestates as `count===prev+1` (looks
    like a create), which used to overwrite the restored value with the current (0) time — now guarded by
    `if (!creation.has(current))` so only genuinely new slots snapshot.
  - **The wipe** (found via the debug logs — `saveCreation … data=[[11,…]]` then after reload
    `loadCreation … stored=[]`): a **`count=0` `OnSaveStateUpdate` fires on level SHUTDOWN** (and as a
    transient at level init) — NOT just when the user clears all savestates, and all three are
    indistinguishable. The `count===0` branch was doing `creation.clear()` + save, so the shutdown one saved
    `[]` and wiped storage right as you left the map. **Fix: NEVER save on `count===0`.** It only clears the
    in‑memory map when `saveStateCount > 0` (so a later recreate stores fresh; the init transient leaves the
    freshly‑restored `creation` alone). Stale storage after a genuine clear‑all is harmless — overwritten by
    the next create/delete save. (Creates `count===prev+1` and deletes `count<prev` still persist; the
    bulk disk‑load `count>prev+1` and the `!creation.has(current)` guard on the single‑savestate reload keep
    restored values intact.) `DEBUG` (currently **true**) `$.Msg`‑logs map name + saved/loaded data at every
    step — set false once confirmed.
- **Input — mind the `+`:** the game's own "Savestate Goto" bind is **`+mom_savestate_load`** (a `+/-` hold
  command; see `settings/input.xml` `#Keybind_Savestate_Goto`), NOT the bare name — binding `mom_savestate_load`
  may fire no teleport (→ "load does nothing"). Create is a normal command. Raw MOUSE4/MOUSE5 aren't readable
  from JS (`MomentumInputAPI.GetButtons()` only reports bound `Button`‑enum actions), so we bridge through the
  commands + event: `bind "mouse5" "mom_savestate_create"` / `bind "mouse4" "+mom_savestate_load"`.
- **First run needs a full game restart** (new `hud_default.kv3` block is read at startup only; `panorama_reload`
  won't pick it up). Enable it in the customizer if it defaulted off. To VERIFY: things to eyeball in‑game are
  (a) the component appears/moves in the customizer, (b) the full‑screen‑frame offset lands where expected, and
  (c) a created savestate maps to `current` on both the create and the later load event — read the DEBUG
  `$.Msg` log; if create doesn't select the new slot, the `creation` map key is wrong.

### 6h. Zone system reference (checkpoint / stage / end) — RESEARCH, not a built feature
Notes from exploring why non‑start zones vanish once the run timer stops (savestate/practice), and how the
zone editor works. Filed for a future "keep zones visible in practice" attempt.

- **Data model** (`common/web/types/models`, used all over `pages/zoning/zoning.ts`):
  `MapZones = { formatVersion, dataTimestamp, tracks: { main?: MainTrack, bonuses?: BonusTrack[] },
  globalRegions?: { allowBhop?, cancel?, overbounce? }, maxVelocity? }`. A track's
  `zones = { segments: Segment[], end: Zone }` (MainTrack also `stagesEndAtStageStarts`, `bhopEnabled`;
  BonusTrack also `defragModifiers`). `Segment = { checkpoints: Zone[], cancel?: Zone[], name,
  checkpointsRequired, checkpointsOrdered, limitStartGroundSpeed }`. `Zone = { regions: Region[], filtername,
  filterNegated }`. `Region = { points[], bottom, height, safeHeight?, teleDestPos?, teleDestYaw?,
  teleDestTargetname? }`.
- **Terminology → data mapping** (this is the key decoder):
  - **Start zone** = `segments[0].checkpoints[0]` (first segment, first checkpoint). `isStartZone()` checks this.
  - **Stage** = a `Segment`; a **stage start / major checkpoint** = `segments[i>0].checkpoints[0]`.
  - **Minor checkpoint** = `checkpoints[j>0]`. **End zone** = `track.zones.end`. **Cancel** = `segment.cancel[]`.
  - Global regions: `allowBhop`, `cancel` (timer), `overbounce`. `RegionRenderMode` enum names the lot
    (START, START_WITH_SAFE_HEIGHT, TRACK_SWITCH, END, MAJOR_CHECKPOINT, MINOR_CHECKPOINT, CANCEL, ALLOW_BHOP,
    OVERBOUNCE).
- **Editor** = `ZoneMenuHandler` (`pages/zoning/zoning.{ts,xml}`), a C++ `ZoneMenu` panel wrapped in a
  `ConVarEnabler convar="mom_zoning_enable"` in `hud.xml`. Shown/hidden via the `ZoneMenu_Show` / `ZoneMenu_Hide`
  unhandled events. C++ panel methods: `getEntityList()`, `getZoningLimits()`, `createRegion(isStart)`,
  `editRegion(PickType)`, `moveToRegion(region)`, `previewTeleDest(region)`, `updateEditorRegions(renderRegions[])`,
  `createDefaultTeleDest`. Data flow: `MomentumTimerAPI.GetActiveZoneDefs()` → mutate the JS `mapZoneData` →
  `SetActiveZoneDefs(mapZoneData)` on hide → `SaveZoneDefs(mapZoneData)` writes the file; `LoadZoneDefs(useLocal)`
  loads local vs online, `GetSavedZoneStatus()` → LOCAL/ONLINE bitflags. Events: `OnZoneDefsSet(newDefs)`,
  `ActiveZoneDefsChanged`, `OnRegionEditCompleted/Canceled`. UI = 3 columns (tracks | segments+end |
  checkpoints+cancel) + a per‑selection properties panel. `updateEditorRegions()` is what draws the coloured
  region outlines **while the editor is open** (a different path from normal gameplay drawing).
- **In‑world zone drawing is C++, driven by `cfg/config.cfg` convars** (base game, edited in place — NOT
  overridden here): per‑type `mom_zonetype_{start,stage,checkpoint,end,bhop,cancel,overbounce}_draw_style` and
  `_color`, plus global `mom_zone_face_alpha`, `mom_zone_outline_thickness`, `mom_zone_outline_subdivisions`,
  `mom_zone_experimental_appearance`. Shipping values: start/stage/checkpoint/end `draw_style 1`;
  bhop/cancel/overbounce `0`.
- **Why start persists but stage/checkpoint/end vanish in practice:** not a Panorama thing — the non‑start
  zones are drawn by C++ only while the run timer is active/approaching; a savestate disables the timer
  (practice mode) and C++ stops drawing them, while the start zone stays (it's the prime/reset anchor).
  **Can't be fixed from our Panorama override.** Things to try/know: (a) experiment with the `draw_style` values
  in console (1 is current; try other values to see if any forces always‑draw) — unconfirmed, likely still
  timer‑gated in C++; (b) **opening the zone editor draws every region regardless of timer state** (via
  `updateEditorRegions`), so that's the one reliable in‑game way to see them during practice; (c) a proper fix
  Panorama‑side would be our OWN overlay: we can read every region's `points`/`height` from
  `GetActiveZoneDefs()` and draw them with a `UICanvas` (§5), but projecting world→screen ourselves is a big
  feature. No JS API was found to force the native zone rendering on during practice.
- **FINDINGS (after building the §6j harness — the hard limits are now confirmed, not guesses):**
  - **No DIRECT player world‑position API** (but see the `cl_showpos` workaround below — position IS obtainable).
    Verified against BOTH the override and the base game's `types-mom/apis.d.ts` (identical): `MomentumPlayerAPI`
    exposes only `GetVelocity`/`GetAngles`/`GetEnergy`/`GetStrafeSync`/`IsDucking`/… — no `GetPosition`/`GetOrigin`,
    and no `WorldToScreen`. So there's no one‑call getter — **but** the Pos/Ang HUD (`cl_showpos`) surfaces the live
    origin/angles indirectly, harvested by the player‑state bridge (§6l). With that, self‑computed point‑in‑polygon
    collision DOES work (the harness ships the PIP + z‑range code and consumes the bridge as its position source).
  - **In‑world 3D zone drawing stays C++‑only** and unreachable from a normal HUD context: `zoning.xml`'s root
    IS the `<ZoneMenu>` C++ panel, and `updateEditorRegions()` is its method (gated by `mom_zoning_enable`). A
    plain HUD `<Frame>` is a different JS context and can't call it. So the editor (`mom_zoning_enable 1`) is
    still the one native way to see all regions during practice.
  - **`ZonesAPI` is GONE — not just legacy.** In‑game `typeof ZonesAPI === 'undefined'` (touching it throws
    `ReferenceError: ZonesAPI is not defined`). So there is **no live "current zone index" getter** at all. The
    only per‑zone signal is the timer (next bullet). (speedometer.ts still names `ZonesAPI` but only inside a
    commented‑out block, so it never runs.)
  - **`GetObservedTimerStatus().majorNum` IS the game's live zone collision — but only during an ACTIVE run.**
    Confirmed on surf_anzchamps: as you enter each stage's start zone the status steps `RUNNING major=1 → major=2 →
    …` (minorNum tracks minor checkpoints); the End zone would be `major = segmentsCount + 1`. A savestate **CREATE
    keeps the timer RUNNING**; a savestate **LOAD flips it to DISABLED (practice) and freezes majorNum at 1** — so in
    practice this signal dies (matches §6h). The harness highlights the active stage on its minimap from this. ⇒ the
    dream of auto‑splitting the Segment Timer at stage zones **during practice** is NOT achievable today (no practice
    zone signal + no player position).
  - **Console text is NOT readable from JS** (checked while hunting for a `getpos`→parse route to position): Panorama
    gets only a payload‑free `NewConsoleMessages` ping (`() => void`); the C++ `NotifyConsoleMessageTarget` /
    `StaticConsoleMessageTarget` panels render the text with no JS getter, and there's no `GetConsoleLog`/spew reader.
    JS can only read/write **convar values** (`GetSettingString/Int/Float/Bool/Color`, `SetSetting*`,
    `$.RegisterConVarChangeListener`) — and no convar holds live position — so the console route to position is dead.
  - **★ SOLVED — player position IS reachable via the Pos/Ang HUD (`HudShowPos`) + `cl_showpos`.** `hud/show-pos.xml`
    labels read `Pos: {s:origin}` / `Ang: {s:angle}`; the C++ panel writes the live origin/angles into those
    **dialog variables every frame — but ONLY when `cl_showpos` is `1`** (ships at 0; it's a convar gate, exactly
    like strafesync §6c). There's no `GetDialogVariable`, BUT a `Label`'s `.text` GETTER **returns the substituted
    value** once the var is set. The earlier "dead end" was a false negative: with `cl_showpos 0` the var is unset
    and `.text` reads back the bare token `"Pos: origin"`; with **`cl_showpos 1`** it reads the real coordinates —
    in‑game: `[ShowPosProbe] labels=2 [0] "Pos: -14592.00 -14080.00 14957.40" [1] "Ang: 0.00 -90.00 0.00"`,
    updating live as you move. Crucially `cl_showpos` updates **regardless of timer state**, so this works during
    savestate practice too. ⇒ real point‑in‑polygon zone collision AND segment auto‑split during practice are now
    possible. Built as the **player‑state bridge (§6l)**. Requirements: the Pos/Ang component must be **enabled in
    the customizer** (labels only exist when it's shown — a disabled component logs `labels=0`) and `cl_showpos 1`
    (forced by show‑pos.ts). To hide the on‑screen readout while keeping the data, set its **font color alpha to 0**
    in the customizer (the labels still populate). (Value precision: origin to 2 dp, plenty for zones ≥256u tall.)
  - **No JS API registers a real concommand.** `GameInterfaceAPI.ConsoleCommand` only RUNS commands. The harness's
    "console command" is a `$.RegisterConVarChangeListener('mom_zone_experimental_appearance', …)` toggle (that
    convar also flips the C++ experimental zone look — handy for the rendering experiment) plus always‑on `$.Msg`.
    ⚠️ **Stale‑listener trap:** a `panorama_reload` builds a fresh handler + a NEW listener but does NOT remove the
    old one, whose captured panel is now deleted → the old listener fires and throws **"Underlying object is
    deleted!"**. Guard every panel touch in a convar/keybind callback with `IsValid()` and have the stale handler
    `$.UnregisterConVarChangeListener(id)` itself (the per‑frame `$.Schedule` loop already self‑stops on `!IsValid()`).
  - **Native `draw_style` has 5 modes** (`mom_zonetype_<type>_draw_style`, min 0 max 4): 0 off, 1 outlines
    (default), 2 outlines as overlays (see through walls), 3 side faces, 4 side faces as overlays. **Still to
    test:** set 2 or 4, then LOAD a savestate (enter DISABLED/practice) and check whether stage zones stay drawn —
    if any mode ignores the timer gate, that's a zero‑code way to keep zones visible in practice.

### 6j. Zone Debug harness (BUILT — `hud/zone-debug.{ts,xml,scss}`, class `ZoneDebugHandler`)
A pure‑Panorama HUD `<Frame>` (same no‑C++ pattern as the Segment Timer §6g), added to `hud.xml` as
`zone-debug.xml`. A research scratchpad for the §6h questions; **not a customizer component** (deliberately — no
`hud_default.kv3` block, so `panorama_reload` picks up all edits, no restart). Toggle it with the console convar
`mom_zone_experimental_appearance` (0 hide / 1 show + re‑dump); everything else auto‑logs to console with no setup.
- **Reads zone geometry** from `MomentumTimerAPI.GetActiveZoneDefs()` and flattens it to `{region, kind, label}`
  (kind = Start/Stage/Checkpoint/End/Cancel/AllowBhop/Overbounce, classified from the data shape the same way
  `zoning.ts updateEditorRegions` does — first segment's first checkpoint = Start, other segments' CP0 = Stage,
  CP>0 = minor Checkpoint; plus `end` and global regions). Enum/colours kept LOCAL — do NOT `import` from
  `pages/zoning/zoning` (that would run the zoning page's `@PanelHandler` and double‑register it).
- **2D TOP‑DOWN minimap** (`UICanvas`, corner card) — the feasible "render the zones" test. Auto‑fits all region
  polygons to the canvas (world X/Y → screen, Y inverted so north is up), one coloured closed outline per region
  (`DrawLinePoints`, count = #points, close by repeating point 0). It's our own panel ⇒ **stays visible during
  savestate practice** regardless of the timer — which the native drawing does not. It's schematic, not a real
  3D in‑world projection (no world→screen API). Canvas size via `actuallayout*/actualuiscale_*` (§5); bg on the
  wrapper (UICanvas paints none). **The active stage is highlighted** (thick yellow outline) from the timer's
  live `majorNum` while RUNNING/PRIMED — each main‑track region carries its `major` (segment index +1; End =
  segmentsCount+1) so the highlight advances as you cross stages.
- **C++ collision, surfaced live:** `update()` (self‑scheduled loop — a plain frame gets no `HudProcessInput`)
  reads `GetObservedTimerStatus()` each frame and logs every `state/majorNum/minorNum` transition. **Confirmed
  in‑game:** majorNum steps up as you enter each stage zone during an active run (the game's own zone collision),
  and freezes at 1 once a savestate LOAD flips the timer to DISABLED (practice). `ZonesAPI` is confirmed absent
  (`typeof … === 'undefined'`). The timer signal works only for live runs — but with the player‑state bridge (§6l)
  now feeding real position, zone‑debug also does true point‑in‑polygon occupancy + a player dot, which works in
  practice too.
- **Self‑collision (probe‑gated):** `discoverPositionSource()` defensively calls a list of plausible getter names
  (`GetPosition/GetOrigin/GetAbsOrigin/GetLastPos/…`) on `MomentumPlayerAPI`/`MomentumMovementAPI` in try/catch,
  accepting any `[x,y,z]` (`asTriple`). If found, `pointInRegion` (ray‑cast PIP on XY + `bottom`/`height` z‑range;
  `bottom>=COORD_MAX 65536` = "no vertical bound", the createRegion sentinel) reports the occupied zone each frame
  and draws a player dot. **As of writing no source is found** (see §6h findings) so this path stays dark.
- **Report** (`$.Msg`, once per map + on every zone‑defs change + on convar‑on): map name, region count, per‑region
  pts/bottom/height/centroid, world XY bounds, the legacy `ZonesAPI` probe results, the position‑source verdict,
  and the current timer status. This is the "try multiple options / debug msgs to see what works" surface.
- **Pure‑console experiments to run alongside it** (no code — type in the dev console): sweep the native draw
  styles to see if any value forces always‑draw in practice — `mom_zonetype_stage_draw_style 0..3`,
  `..._checkpoint_...`, `..._end_...`, `..._start_...` (shipping: start/stage/checkpoint/end = 1, bhop/cancel/
  overbounce = 0); `mom_zone_face_alpha`, `mom_zone_outline_thickness`, `mom_zone_experimental_appearance 0/1`;
  and `mom_zoning_enable 1` (opens the editor = every region drawn regardless of timer, the known‑good baseline).
  Config lives in the BASE `momentum/cfg/config.cfg` (edited in place, not overridden here).

### 6k. Segment Timer zone splits (BUILT — `hud/segment-timer.{ts,xml,scss}`)
"Show the spliced segment time each time you enter a stage / checkpoint / end zone" — and it works **during
savestate practice**, which was the whole ask. Originally driven by the timer's `majorNum` (RUNNING‑only, so it
died after a savestate load); now driven by **real player position** (the §6l bridge) + point‑in‑polygon, so it
fires whenever you physically enter a zone regardless of timer state.
- `checkZoneSplits()` runs every frame in the existing `update()` loop. `buildSplitZones()` flattens the MAIN
  track's stage‑start / minor‑checkpoint / end zones into `splitZones` (the overall start zone is the reset anchor,
  excluded; bonus tracks not split for now); rebuilt on level load + `OnZoneDefsSet`. Each frame it reads
  `readPlayerState()` and, for every zone the player is newly inside (edge‑detected via `insideKeys`), captures
  `segment.value()` into `splitTimes[key]`. Rendered into `#SegmentTimerSplits` sorted by zone order — `S2 0:12.34`
  / `S2c1 …` / `End …` per line.
- **Savestate‑load rewind handling (the neat part):** each frame it prunes any split whose captured time is
  `> segment.value() + 0.05` — i.e. a split you've since rewound past (a load rewinds the spliced clock). So after
  a load, splits "ahead" of the current spliced time auto‑clear and re‑capture on the next attempt, giving
  current‑attempt splits with no savestate‑event bookkeeping. `resetSplits()` (clears `splitTimes`/`insideKeys`)
  still runs on run start / prime / level load.
- **REQUIRES the position feed:** the Pos/Ang HUD must be enabled in the customizer + `cl_showpos 1` (both handled
  by §6l; hide the readout via font‑alpha 0). No feed ⇒ `readPlayerState()` null ⇒ no splits. Uses the shared
  `common/zone-geometry.ts` `pointInRegion`. No `hud_default.kv3` change; `panorama_reload` picks it up.

### 6l. Player‑state bridge (BUILT — `common/player-state.ts` + `hud/show-pos.ts`)
**The way to get player world position into Panorama JS** (there is no position API — §6h). The C++ `HudShowPos`
panel (the customizer "Pos/Ang" element, Panorama's `cl_showpos`) writes the live origin/angles into its labels'
dialog variables each frame when `cl_showpos 1`, and a `Label`'s `.text` getter reads the substituted value back.
- `common/player-state.ts` — a **side‑effect‑free** shared module (no `@PanelHandler`, safe to import from many
  contexts): `publishPlayerState()` / `readPlayerState()` stash/fetch `{pos:[x,y,z], ang:[pitch,yaw,roll], time}`
  on the **cross‑context global** `UiToolkitAPI.GetGlobalObject()` (the same shared object the HUD customizer uses
  to expose its handler across contexts — a value written in one panel's JS context is visible in all others).
  `parseShowPosVec()` pulls the 3 numbers out of a `"Pos: x y z"` label string.
- `hud/show-pos.ts` — forces `cl_showpos 1` in the ctor, then a self‑scheduled loop reads the two
  `.showpos-entry__label` texts (`FindChildrenWithClassTraverse`), parses them, and `publishPlayerState()`s each
  frame. It's the **only JS context with access to those labels** (they live in the C++ panel's own layout), which
  is why the reader lives here and hands off via the global rather than every consumer reading the labels directly.
- Consumers: `zone-debug.ts` uses `readPlayerState().pos` for real point‑in‑polygon occupancy + a player dot on
  the minimap; `segment-timer.ts` (§6k) uses it to capture stage/checkpoint/end splits **during practice** (cl_showpos
  updates even when the timer is DISABLED — the thing majorNum couldn't do). Both share `common/zone-geometry.ts`
  `pointInRegion`.
- **Requirements / caveats:** the Pos/Ang component must be **enabled in the customizer** (labels don't exist when
  it's disabled → `readPlayerState()` returns null) and `cl_showpos` must be `1` (forced here). Forcing the convar
  shows the on‑screen readout — hide it by setting the component's **font color alpha to 0** (data still flows).
  Position is the player **origin (feet)**, 2‑dp; fine against zone `bottom`/`height` ranges. `time` lets a
  consumer detect a stale/paused feed.

### 6i. Stats page persistence & cheaper refresh (BUILT — `stats.ts`)
`$.persistentStorage` (proven in §6g — JSON key/value, survives `panorama_reload` AND full restarts, no file
I/O) makes the Stats page (§6a) load its rank data instantly and refresh cheaply. **The expensive part isn't
the local map‑cache scan** (`MapCacheAPI`, no HTTP, fast) — it's the **web rank scan**
(`rankQueue`/`processRankQueue`, 1–2 API requests per completed map across every gamemode, throttled, many
seconds). That's what's persisted.

- **What's persisted = `perMapRank` ONLY, keyed by the VIEWED user's id.** `stats.cache.<userId>` →
  `{ v: STATS_CACHE_VERSION, ts, ranks: perMapRank }` (`ranks` = `{ mapID|gm|style → {rank,time,total,wrTime} }`,
  a few numbers per completed map). `saveRankCache()` / `loadRankCache(uid)` / `statsCacheKey(uid)`; version‑gated
  so a shape change invalidates old caches. Self id from `viewUid()` (local `MomentumAPI.GetLocalUserData().id`,
  or the searched user). Each viewed player keys its own entry, so "Me" and searched users never clobber each
  other. **Do NOT persist the `MMap` static data** (local via `MapCacheAPI`) **nor completion** (tier bars are
  recomputed from the fast local scan / `remoteDone`).
- **`rankResults` (the per‑`mode|style|filter` ladder/avg aggregates) are NOT persisted — they're re‑derived
  from `perMapRank`** so it's the single source of truth. `recomputeRankResult(mode,style,filter)` mirrors the
  live scan's accumulation EXACTLY (`gatherTargetsFor` → per completed map: absent from `perMapRank` = an
  `error`, `rank==null` = `noEntry`, `rank!=null` = ranked; a ranked map still missing its `total` leaves the
  result `pctPending` so `enqueueRank` re‑scans it). `recomputeTrackedRankResults()` rebuilds the set
  `enqueueAllModes` scans (every mode's default style + the current selection's style). Because those results
  end up present‑and‑not‑pending, **`enqueueAllModes` no‑ops every cached‑complete key** (its `enqueueRank`
  guard `if (r && !r.pctPending) return`), so a cached open fires zero rank web requests.
- **Load flow** (`loadCacheForView()` in `buildAll` + `applyUserChange`): resets `perMapRank`/`rankResults`/
  `dataTimestamp`, loads the viewed user's cache, `recomputeTrackedRankResults()`, returns `hadCache`.
  `hadCache` → render instantly + `startIncrementalRefresh()`; else it's a first‑ever **full scan**. **Rescan**
  sets `forceFullScan` so `buildAll` SKIPS the (now‑stale) cache and does the full accurate scan.
- **Full‑scan persistence** (`onScanQueueDrained`): when the rank queue empties AND `scanIsFull` (set true on a
  first‑ever open or a forced Rescan), stamp `dataTimestamp = now`, `saveRankCache()`, re‑render. A cached
  open's queue also drains here but with `scanIsFull=false` it's a no‑op (nothing scanned or persisted). Persist
  is **once, at drain** (not per‑mode) — an interrupted first scan just re‑scans next open. A non‑default‑STYLE
  scan on a cached open isn't persisted either (rare; recomputes/rescans on demand).
- **Popup → main cache** (`writeBackFromBoard`, called from `openMapLeaderboard`): the Top‑10 popup already
  fetches the board (rank‑1 WR time + `total`) + the viewed user's standing (rank + time), so it folds that
  straight into `perMapRank[mapID|gm|style]` (same key) + re‑derives that map's two aggregates + persists —
  **opening a map's popup / hitting Refresh updates the stats cache for that map for free**. Guards: only when
  `standing.time != null` (a null could be a transient request failure, not "unranked" — don't clobber good
  data), and diff‑checked so a cached re‑open doesn't re‑persist. Keeps the existing `dataTimestamp`.
- **Incremental PB refresh** (`startIncrementalRefresh`, auto on every cached open): re‑queries ONLY the maps
  whose rank data is stale — `gatherIncrementalTargets()` (completed maps across all modes' default style + the
  current selection) filtered to **changed** = absent from `perMapRank` (new completion / prior error), OR was
  `rank==null` (recheck — board may have re‑versioned), OR PB time moved by > `PB_EPS` (0.05s). For each, one
  `fetchRank` (+ `fetchTotal` if ranked) → patch `perMapRank`, `updateTierRankRow`; then recompute + re‑render +
  persist. **Current PB time**: local from the local map cache (`currentPbTime`, Pro/TP→run‑style‑0 remap like
  `isDone`); remote from `remotePbTimes` (captured in `fetchUserDone` while fetching the searched user's runs —
  main‑track only, keyed like `perMapRank`). *(Deviation from the original design: rather than "re‑fetch PBs
  newest‑first and stop at the first cached run", the local path reads PB times straight from the local cache —
  zero HTTP to find changes — and only the CHANGED maps cost a request; remote reuses the PB list we fetch on
  search anyway. And `rankResults` is derived, not stored.)*
- **⚠️ Caveat of incremental refresh:** it catches YOUR new/improved times, but NOT **other people** beating you
  on a map where your PB didn't move (that board isn't re‑queried, so your rank drifts stale). So: incremental =
  cheap auto‑load ("did my new runs land"); **full Rescan = the truth**. The left card's rank section shows
  **"Updated Xm ago · Rescan for a full refresh"** (`agoText(dataTimestamp)`); `dataTimestamp` is bumped ONLY by
  a full scan (never by incremental or popup write‑back), so the staleness reading is honest.

---

## 7. Gotchas cheat‑sheet
- XML comments can't contain `--` → whole layout fails to load.
- **Click‑through close on a full‑screen backdrop.** The centred‑card‑over‑a‑backdrop‑`<Button>` popup pattern
  (`.bgselector`, `#StatsLbPopup`) closes on clicks over the CARD's own background/labels unless the card
  **catches hits itself** — a plain `<Panel>` / `<Image>` can be transparent to hit‑testing, so the click falls
  through to the full‑screen close‑backdrop behind it. Fix: put **`hittest="true"`** (+ empty `onactivate=""`)
  on the card panel; for dynamically‑created children that must be clickable (Images default `hittest=false`),
  set **`panel.hittest = true`** in TS. Same trick the gallery uses (`MainImage hittest="true" onactivate=""`).
- A layout `<root>` allows only ONE top‑level panel ("Found duplicate panel description" if two), and that
  topmost panel must have **no `id`** ("Top most panel should not have an ID. This ID is set in code" — the
  loader/`CreatePanel` names it). It CAN have `class`/`style`/`onload`. To overlay a popup over a whole page,
  wrap the page + popup in one id‑less root panel (default overlap flow), not two top‑level panels.
- A `visible="false"` XML attribute did NOT reliably keep a custom overlay hidden on load (it showed up on
  game open). Hide overlays with a base `visibility: collapse` class and toggle a `--open` class via
  `AddClass`/`RemoveClass` (the codebase pattern) — and don't mix the two (a false `visible` property will
  keep it hidden even after the class says visible).
- Every non‑NONE customizer style needs a `hud_default.kv3` default (override copy at
  `custom/panoDev/cfg/hud/`, needs restart).
- `NumberEntry` clamps to `min` per keystroke → use `min:1`, clamp in callback.
- **A new HUD customizer component needs NO C++** — any `<Panel>` with an id present in `hud_default.kv3`
  works (customizer positions/sizes/enables it in JS). Add it via a `<Frame>` in `hud.xml`. See §4 / §6g.
- Custom HUD components: plain panels (and `MomHudStrafeSync`) don't fire `HudProcessInput` → self‑schedule updates.
- `MomHudStrafeSync` also **self‑hides** unless `mom_hud_strafesync_draw` is `1` (ships as 0) — C++ forces
  the panel invisible even while the JS loop runs/logs. Force the convar on in the ctor (see §6c).
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
- **No DIRECT player‑position API, but position IS obtainable via `cl_showpos`.** `MomentumPlayerAPI` gives
  velocity/angles/energy, no position/origin. The workaround: force `cl_showpos 1` and read the C++ Pos/Ang HUD's
  labels — a `Label`'s `.text` getter returns the substituted dialog‑variable value (the live origin/angles). See
  the player‑state bridge §6l (and §6h). World→screen projection is still unavailable, so an in‑world 3D overlay
  isn't feasible — a top‑down schematic minimap (§6j) is the most you can render yourself.
- **No JS API to register a console command.** `GameInterfaceAPI.ConsoleCommand` only RUNS commands. For a
  console‑driven trigger use `$.RegisterConVarChangeListener(existingConvar, cb)` (cb gets the value string;
  the convar must already exist; don't use on server‑DLL convars per its own warning). `RegisterKeyBind` exists
  but is unused/unverified anywhere in either codebase.

## 8. Where things live
```
panorama/
  layout/hud/{strafe-trainer,strafe-sync,segment-timer,zone-debug,hud}.xml   (segment-timer + zone-debug = pure-JS HUD frames, §6g/§6j)
  layout/pages/{stats/stats,main-menu/main-menu}.xml
  layout/pages/map-selector/css-map-selector.xml        (CS:S map selector — §6e)
  layout/pages/lobby-list/css-lobby-list.xml            (CS:S lobby browser — §6f)
  scripts/hud/{strafe-trainer,strafe-sync,segment-timer,zone-debug}.ts   (zone-debug = zone render/collision research harness, §6j)
  scripts/pages/{stats/stats,main-menu/main-menu}.ts
  scripts/pages/map-selector/css-map-selector.ts        (CS:S map selector — §6e)
  scripts/pages/lobby-list/css-lobby-list.ts            (CS:S lobby browser — §6f)
  scripts/pages/drawer/lobby.ts        (drawer lobby tab — shares the SteamLobby events §6f reuses)
  scripts/common/online.ts             (Lobby/LobbyType/LobbyProperties types used by §6f)
  scripts/util/event-definition.ts        (MainMenu_ClosePage cross-context event — §7)
  scripts/common/{hud-customizer,buttons,leaderboard,maps}.ts
  scripts/common/player-state.ts       (player position/angle bridge via cl_showpos — §6l; consumed by zone-debug + segment-timer)
  scripts/common/zone-geometry.ts      (shared pointInRegion / COORD_MAX — §6j/§6k)
  scripts/hud/show-pos.ts              (forces cl_showpos 1 + publishes player pos to the global — §6l)
  scripts/common/web/enums/*        (Gamemode, Style, LeaderboardType, TrackType, MapStatus, …)
  scripts/types-mom/{apis,panels}.d.ts   (in-game API + panel types)
  scripts/types/shared/panels.d.ts       (UICanvas, base panel props)
  styles/pages/main-menu.scss, styles/hud/{strafe-trainer,strafe-sync,segment-timer,zone-debug}.scss, styles/config.scss
  styles/pages/map-selector/css-map-selector.scss       (CS:S map selector — §6e; in _index.scss)
  styles/pages/lobby-list/css-lobby-list.scss           (CS:S lobby browser — §6f; own _index.scss)
  images/backgrounds/background01.dds, images/game-logos/css.png
custom/panoDev/cfg/hud/hud_default.kv3    (customizer defaults — OVERRIDE copy, edit this; restart to apply)
momentum/resource/momentum_english.txt    (localization — base game, restart to apply)
momentum/panorama/domain_whitelist.kv3    (web request allowlist — startup only)  [also custom/panoDev copy]
```
> Note: the web‑request whitelist that matters is `custom/panoDev/panorama/domain_whitelist.kv3` (the
> override copy) — it already lists `api.momentum-mod.org`.
