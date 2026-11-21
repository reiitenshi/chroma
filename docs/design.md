# chroma — design draft

A page of `element: colour` controls for Steam's Big Picture / Game Mode UI. Changes preview
live in Steam and save as a CSS Loader theme. Built on desktop Big Picture, then ported to the
Deck.

Runs alongside Decky Loader + CSS Loader. chroma exists because CSS Loader only exposes what a
theme's author chose to expose; chroma writes its own theme so any cataloged element can change.

## Reused, not rebuilt

| Need | Source |
|---|---|
| Talk to Steam (targets, DOM, styles, inject) | `steam-debug/` (kmturley, CC0) |
| Readable name ↔ hashed class, per Steam build | steamui-watch `stable.json` / `beta.json` (MIT) |
| Persist CSS across restarts | CSS Loader theme folder (`~/homebrew/themes/`); its hash translation isn't used (see below) |

steam-debug reads `webpackChunksteamui`. Steam beta has moved to Vite and removed it; stable will
follow. chroma keys on steamui-watch names and DOM classes, never on webpack internals.

## Parts

1. **Catalog**. Walk each screen and record every visible element: its steamui-watch name
   (e.g. `gamepadtabbedpage_Tab`), window (`BigPicture`, `QuickAccess`, `MainMenu`), sample
   text and current colours. Saved per Steam build.
2. **Editor page**. A local web page served by a small Node process: one row per element,
   `name: colour control` for each colour property. Changing a value injects the CSS into
   Steam immediately.
3. **Profile**. JSON of the edits, addressed by element name, never by hash:

   ```json
   { "name": "mine", "steamBuild": "1794536281",
     "edits": [
       { "part": "gamepadtabbedpage_Tab", "set": { "background": "#3b5bdb" } }
     ] }
   ```

4. **Export**. Profile → CSS for the current build, written as a CSS Loader theme.

## Decisions (user, 2026-11-20)

- Export to CSS Loader only; chroma itself is not a Decky plugin.
- Profiles are private.
- Colours only: background, text, border, highlight.
- Editor is a plain list of `element: colour` controls; no in-Steam overlay.
- steamui-watch lists several hashes per name. The catalog checks each against the live DOM and
  removes the unused ones, keeping only the hash this build uses.

## Phases

1. Desktop Big Picture. Done when ui.png's four edits (ec1–ec4) are made from the editor page
   and survive a Steam restart.
2. Steam Deck port (CSS Loader runs under Decky there).

## Decisions (build, 2026-11-20)

- Export writes live hashes, not readable names. CSS Loader rewrites every known variant to the
  last hash in its own map (`css_translations.json`), and that map is wrong for
  `Kp4Buf0X_EventInfo` and `Kp4Buf0X_Title` (dead hashes) and lacks `Kp4Buf0X_EventTime`. The
  live hashes aren't in its rewrite set, so they pass through. Cost: re-export per Steam build.
- Theme: `~/homebrew/themes/chroma/` (`theme.json` manifest 8, `shared.css` → `bigpicture`).
  Export applies it through CSS Loader's local server (`127.0.0.1:35821/req`, methods `reset`,
  `set_theme_state`) when that server is on.
- Values are limited to colour syntax (hex, rgb/rgba/hsl/hsla, keywords); props to `background`,
  `color`, `border-color`, `fill` (SVG icons, 2026-11-21: Steam sets `fill` in CSS, which beats
  the paths' `fill="currentColor"`, so `color` doesn't move them), plus `backdrop-filter` limited to
  `blur(Npx)`. Fill rows sit with the fills in Page / Blocks, not Text. `!important` on every rule.
- Text colour is generalised: `gamepadui_BasicHome`'s `color` is the master (about half the home
  text inherits it). Catalog `links` tie other parts' `color` to it (tab labels, selected tab, tile
  titles; section labels at 0.63 alpha, Steam's own grey ratio). CSS: master as a `:root` variable,
  followers use `var()` / `color-mix()`. One toggle (`followMaster` in the profile): on, linked
  rows are greyed out and follow; off, each row uses its own edit. Turning it off first copies
  each row's followed value into its own edit (cleared if it showed Steam's default), so nothing
  moves and rows can be nudged from there.
- Trawl results wait for review (user, 2026-11-21): a trawl writes nothing. Its new parts, and
  known parts that would gain rows, show in a "Trawl Data" section at the top. Rows are editable
  and preview in Steam (the server previews pending parts alongside the catalog), but their edits
  are saved to the profile only once the element is accepted. Each element has Accept (writes it to the catalog, `POST /api/accept`) and Discard, plus
  Accept All. Held in page memory, so a reload drops them; the server keeps only the last trawl's
  raw findings to apply on accept. Pointing at a Trawl Data row shows it in Steam like any row.
- Trawl also takes `::before` / `::after` rules (2026-11-21): the band behind the header and tabs
  when scrolled is `TabHeaderRowWrapper::before`, not an element. Such a part has `pseudo` set; its
  id ends in the pseudo; the CSS goes on `selector + pseudo` (state selectors already carry it).
  Pseudo-elements Steam isn't drawing (`content: none`) and other `::` selectors are skipped.
- Trawl (button): scans Steam's stylesheets for rules that set `color` or `background-*` and
  match an element on the current screen (has a box in the viewport; `visibility: hidden` counts,
  user 2026-11-21: Steam hides the like / comment bar on activity posts, `7fWhymK6_RatingBar`,
  until the post is hovered, and it keeps its box). Hashes → steamui-watch keys (part id); rules with
  an unresolvable hashed class are skipped. Defaults are read with chroma's preview and CSS
  Loader's styles disabled. New light-grey text (opaque, grey level ≥ 96) links to the master
  with alpha = its grey / master grey; dark or coloured text doesn't. Binned and known parts are
  skipped. No catalog for the build → trawl starts a new one (hand labels/links not carried over).
- UI names: props show as Background / Text; parts by plain name; steamui-watch ids in tooltips.
- States: the trawl also takes rules with `:hover`, `:focus*`, `.gpfocus`, `.gpfocuswithin`
  (→ "highlight") and `:active` (→ "pressed"). The state is stripped to find the base element; the
  state rows live under that element's part (`states.<state>.selectors / defaults / props`).
  Steam's value is kept per selector (hover and controller focus differ: a tab is white text on
  hover, dark text on a white pill under `gpfocus`); rows show the `gpfocus` value. An edit covers
  all of a state's selectors; with no edit, Steam's per-selector values are re-asserted whenever
  the base prop is overridden (our `!important` base rule would beat Steam's state rules).
- Locate: pointing at a row shows its subject in Steam, through a separate
  `<style id="chroma-locate">` (user, 2026-11-21: "the row just activates what's been called", to
  see which page uses what). A state row (Hover / Focus / Click) puts that state's colours (own
  edit, else Steam's) on every instance of the element; `:is(sel):not(#chroma-none)` adds id
  weight to beat the preview's `!important`. It is redrawn after each preview. The Blur row opens
  Steam's main menu (`SteamUIStore.WindowStore.GamepadUIMainWindowInstance.MenuStore.OpenMainMenu()`
  in SharedJSContext), which brings up the glass; leaving it calls `CloseSideMenus()`, but only if
  locate opened it. Header Line (`QcGXoqZ7_HeaderTopEdge`, the 2px line across the top of the
  home screen) exists only while the home tabs (What's New, Friends, Recommended) have focus: Steam
  keeps that in the home page's router state (`HomeTabsActive_HistoryValue`). Its row sets the
  flag through the main window's history (`GamepadUIMainWindowInstance.m_history`), going to
  `/library/home` first if Steam is elsewhere and re-setting it until home's own autofocus stops
  clearing it. Setting it also scrolls to the tabs. Leaving the row scrolls back and clears the flag, or goes
  back if locate navigated (user, 2026-11-21: "forcefully call the element"). Other rows outline
  the element (magenta, inset).
- Defaults (header switch, left of Trawl, no label; user, 2026-11-21): while on, Steam shows its own
  colours. Like the Link switch; when on, the knob is Steam's own logo (`SVGIcon_SteamLogo` from
  steamui, as a CSS mask). chroma's preview and CSS Loader's `style.css-loader-style` elements get
  `media="not all"` (marked `data-chroma-hidden`; only those are restored), which survives preview
  updates; edits still save. It turns off when switched off, on reload, and when the page closes
  (beacon). Locate still shows.
- Palette (user, 2026-11-21: "automate the rest following this theme"): Steam hard-codes colours
  (about 2% of its colour rules use variables), so the theme reaches other pages by swapping Steam's
  colours for yours in every rule that uses them. The profile's `palette` lists the Steam colours
  ({ kind: bg | fg, steam, name }); the values are edits on virtual parts `palette:<kind>:<steam>`,
  shown as rows in a Palette category, first. bg matches `background-color` and gradients in
  `background-image` and `box-shadow`; fg matches `color` and `fill`. It also reaches `@keyframes` (Ctrl+2's selected
  tab gets its colour from an animation held with `forwards`) and colour custom properties (`--*`;
  fg when the name says text/colour/foreground). Near shades: an opaque Steam colour within 20 (RGB
  distance) of a palette colour takes your colour shifted by the same offset, so Steam's dozen
  near-identical dark greys follow; alpha is kept (multiplied). The rules are built in Node from a
  snapshot of Steam's colour rules (user, 2026-11-21: export must not need Big Picture): taken in
  each theme window (Big Picture, MainMenu = Ctrl+1, QuickAccess = Ctrl+2), chroma's and CSS
  Loader's styles skipped, colours normalised to rgb(), `@media` / `@supports` kept; merged again
  whenever a window's stylesheets change (Steam loads a page's CSS lazily) and saved as
  `catalog/<build>.rules.json` (shipped; the writable copy under the data folder wins). About
  2,900 rules, 400 KB of CSS; a preview takes about 0.1 s. Palette edits survive a page that doesn't know
  them: the editor sends `palette: true` with a preview; without it the server keeps the saved
  palette edits (an old open page wiped them twice). First palette:
  built from the home edits, conflicts resolved by picking one; Steam's darkest background and dark
  panel grey mapped by role (Home colour; What's New card made solid, `#a189bc`) since the edits
  had only icon-sized light values for them. Left out as too broad: pure white, pure black, black
  overlays, 10% white, 50% white text. Readability pass (text.png…text_4.png): Grey Text was
  `#b395ffa8` (purple 66%), near-invisible on the purple backgrounds (contrast 1.1–1.4) and spread
  by near shades to Steam's other mid greys; now `#fffafaa8`, the white 66% the home page uses.
  Added Soft Grey Text (Steam `#b8bcbf`, settings list, storage sizes) as `#fffafad9`. The theme's
  mid-tone backgrounds cap white text at about 3:1, so secondary text sits at 2–2.7.
- Cascade layers order chroma's `!important` rules: `@layer chroma-locate, chroma-parts;` then the
  palette (unlayered), then the parts in `chroma-parts`; locate CSS is in `chroma-locate`. For
  important declarations earlier layers win and unlayered lose, so locate > parts > palette > Steam.
- Preview and Defaults go to all three theme windows; export injects `shared.css` into
  `bigpicture`, `MainMenu`, `QuickAccess` (CSS Loader's own tab names, from its `css_inject.py`).
- One server per Steam: the preview is one `<style>` in Big Picture, so two servers overwrite each
  other. Test against `--profile test` but expect to collide with a live session; restore after.
- Editor look: magik's layout and control states (zones; hover loses to focus
  and pressed; focus is never a ring) and JetBrains Mono, copied from `~/Projects/magik/assets/css`
  (user, 2026-11-21). Colours are the theme being edited (user, 2026-11-21, replacing Cream):
  each piece of the editor takes its Steam counterpart's live colour (`THEME` in the page): page ←
  Home screen background only; buttons ← Tabs (hover/focus ← tab pill); Export ← Selected tab;
  title ← top bar text; category headings ← "Trending among friends"; state names and the rows'
  guide line ← news date heading; category boxes ← What's New; row names ← news tile
  title; counts ← key cap; hex field ← search box; "follows" notes ← master text. Lines are the adjacent text colour, faded. A clash that
  is unreadable here is unreadable in Steam. The row being located is marked in the inverse of the
  Home screen colour (always visible against the page). The Steam outline stays magenta; the danger
  red stays chroma's own.
- Editor layout (user, 2026-11-21): each category is a dropdown — Page (backgrounds of parts
  covering ≥ half the screen, catalog `page: true`), Blocks (other backgrounds/borders), Text
  (font colours, headed by "All Text" with its Link on/off switch: on, linked rows follow it). Inside, a flat list of rows, one per
  element and state, in aligned columns with no header row: name, state, swatch, opacity slider,
  opacity %, hex, reset, bin. No descriptive text on the page (user, 2026-11-21). Names cut off
  with an ellipsis; the browser's own tooltip shows them in full. Tooltips only on cut-off text. The state comes
  from Steam's selectors (`:hover` → Hover, `.gpfocus`/`:focus` → Focus, both → "Hover, Focus",
  `:active` → Click); blank for the normal state. Fonts never share a list with fills: a part with both has rows in both. Rows are sorted
  by screen area (catalog `area` = steamui-watch module, top of screen first), then name, then
  state. Plain names are hand-set in the catalog `label`; the trawl still names new parts from
  their class names, plus a trailing tag (`svg`, `path`), so an icon's svg and path rows differ. Each row has its own bin (removes the whole part) and locate.
  Every name, state and button is Title Case (user, 2026-11-21); messages stay sentences. Rows for
  elements not on the current screen look the same as the rest (no dimming).
- Every category has subheadings (user, 2026-11-21; Blocks first, then all), from the catalogue's
  `group`, in screen order: Home, Header & Footer, Game Tile, Tabs, What's New, Friends (home
  Friends tab), Activity (activity posts: buttons, comment thread, day divider, achievement icon
  placeholder), Widgets (home widgets: App Carousel, calendar day, store carousel), Indicators (key
  cap, badges, avatar status), then Game Page, Library, Media, Settings, Main Menu, Quick Access,
  and Other for parts with no known group. Palette splits into Backgrounds and Text. A new trawl
  part gets its group from where it was found: Ctrl+1 / Ctrl+2 by window, Big Picture pages by
  route (`/library/app/` Game Page, `/settings` Settings, `/media` Media, library tabs Library);
  home parts start under Other and are sorted by hand. Each subheading is a dropdown with a count;
  closed ones are remembered with the categories (`chroma.closed`, ids `<category>/<group>`).
- Ctrl+1 / Ctrl+2 (user, 2026-11-21): the trawl scans Big Picture plus the side menu that is open
  (MenuStore `m_eOpenSideMenu`: 1 MainMenu, 2 QuickAccess; a closed menu's window keeps stale
  layout, so it isn't scanned). Parts record their `window`; the row counts and locate use it.
  Locating a menu part opens its menu (and closes it on leave, unless it was already open) and
  outlines in that window only.
- Two pages (user, 2026-11-21). `/` is chroma-picker, the default: Dark / Light, a hue slider, and
  Save As a named profile. `/dev` is the per-element editor ("dev mode"), for hand styling or an
  agent driving the HTTP API. The picker's maths: every colour of the template
  (`templates/chroma.json`, a copy of the hand-made `mine` profile) is turned in OKLCH by the
  slider's distance from the template's hue (its first palette colour, 305°), keeping lightness, so
  the template's contrast holds; colours leaving sRGB lose chroma until they fit. Dark lowers opaque
  backgrounds to about 0.2 lightness (`0.2 + (L - 0.6) × 0.9`, clamped 0.12–0.6) and translucent
  tints by 30%; text keeps its lightness. Light at the template's hue is the template exactly.
  Picker profiles carry `picker: { mode, hue }`; Save refuses names of hand-made profiles. The
  page sends one preview request at a time, always the latest pick. A Preview switch (user,
  2026-11-21; on by default, remembered per browser) stops previews; switching it off empties
  chroma's preview style in every window (`POST /api/preview/clear`). The preview sits above
  CSS Loader's themes (user, 2026-11-21: swapping themes in CSS Loader showed nothing while the
  dev page's preview was in), so leaving either page (pagehide beacon) and quitting the app
  (`before-quit`, two seconds at most) clear it too; a reloaded page pushes it again.
- No Decky plugin (user, 2026-11-21: "sounds like a headache"). chroma ships as an Electron app
  (`desktop/`, after magik's setup): an AppImage for the Deck and any Linux, a pacman package for
  Arch. It runs chroma.mjs in its main process on a free loopback port, with `CHROMA_DATA` =
  Electron's userData (`~/.config/chroma`) for everything chroma writes; the shipped files
  (editor, catalogue, rules snapshot, template) are read-only resources. No Steam launch button:
  the page checks Steam (`GET /api/status`, ports 8080 then 8081) and, while it can't reach it,
  says how to turn on the debugging port (Deck: Developer Mode › CEF Remote Debugging, on already
  with Decky; Linux: `touch ~/.steam/steam/.cef-enable-remote-debugging`) or to open Big Picture.
- Main use (user, 2026-11-21): the app open in the Deck's Desktop Mode next to Steam in Big
  Picture. The other: chroma on a PC, the exported theme sent to the Deck over a chat app.
- Export (user, 2026-11-21; picker and dev page): a profile becomes CSS Loader theme
  `chroma-<name>/` (`theme.json`, display name "chroma: <name>", description naming the Steam
  build; `shared.css` into bigpicture, MainMenu, QuickAccess). Written into `~/homebrew/themes/`
  when `~/homebrew` exists, never switched on or off (user, 2026-11-21: chroma shouldn't activate
  themes; CSS Loader's local server is no longer called), and zipped to `~/Downloads/chroma-<name>.zip` for sending: a theme
  is a folder of two files (the CSS is 400 KB), and CSS Loader only installs zips from its store,
  so the zip is extracted into `~/homebrew/themes/` by hand. Steam isn't needed: without it the
  build is the profile's and the palette comes from the stored snapshot.
- Best effort per Steam build (user, 2026-11-21): chroma is marked as made for stable build
  1794536281 (README, page footer, `MADE_FOR`); on another build the footer says so.
- Public repo: the catalogue's quoted on-screen samples had friend names; replaced with "Friend
  Name". Profiles stay out of git.
- Header (Tabs) is one part (user, 2026-11-21): the band behind the header and tabs, under the
  header (`awNNWnmm_GamepadTabbedPage.awNNWnmm_IsUnderHeader awNNWnmm_TabHeaderRowWrapper::before`,
  the surviving id) and when scrolled down (`awNNWnmm_TabHeaderRowWrapper.awNNWnmm_ScrolledDown::before`,
  now an alias). Both are `::before`, so `pseudo` stays set and goes on each member.
- A state can be fused into the normal row (user, 2026-11-21: Go To Friends' focus): the state is
  deleted and named in the part's `fused`, so the trawl doesn't add it back. The base `!important`
  rule then covers the state too.
- Favourite Friends is one row (user, 2026-11-21): favourite friend tiles (`7Vn4DG64_FavoriteFriend`,
  the surviving id), View Friends List (`7Vn4DG64_GoToFriends`), both with focus fused, and a
  friend's avatar and name on hover (`gFV3re5o_AvatarAndLabel`). The avatar's only colour is its
  hover, so its `:hover` selector is a member of the base selector list.
- Favourite Friends also takes the friends-playing game cards (`7Vn4DG64_InGameGame`, same colour,
  focus fused). Discovery Queue is one part (user, 2026-11-21): the widget
  (`V4hIzfTZ_DiscoveryQueueWidgetCtn`, surviving id) and its "Explore Your Discovery Queue" header
  (`uL3vOzrd_WidgetHeaderCtn`). Steam gives the header a purple-to-blue gradient; one colour replaces it.
- Activity Buttons is one part (user, 2026-11-21): the like and comment buttons under activity
  posts (`7fWhymK6_RatingBar … LikeButton.CanClick`, surviving id, and `… CommentButton.CanClick`),
  one Hover row, plus the like and comment icons' fill (`propSelectors.fill`: their svg / path),
  shown as "Activity Buttons Icon" (a fill row gets " Icon" unless the name has it). The icons'
  `color` does nothing (Steam's CSS fill wins), so it is in the part's `dropped`, which the trawl
  won't re-add. App Carousel (renamed from Discovery Queue) also takes
  `V4hIzfTZ_AppCarouselPosition`, which had the same Steam colour.
- The activity feed's day divider (`b5AGtz9j_AppActivityDay … Rule`, the "Today" line) isn't
  Friends (user, 2026-11-21): Steam shares that feed with game pages. It sits under Other.
- UI text is Australian English (user, 2026-11-21): colour, favourite, catalogue. Code, ids and the
  `catalog/` folder keep their names.
- Root background (`J5rxTYCm_BasicUiRoot.J5rxTYCm_BlackBackground`, behind the home screen) is
  black or white only, two swatch buttons in the Home screen row's state column, not a row
  (user, 2026-11-21).
  Black is Steam's default, so choosing it clears the edit.
- Header status has one highlight row: the focus part (`ehWSiALG_HeaderItem`, `.gpfocus`) was merged
  into the hover part (`ehWSiALG_HeaderItem.ehWSiALG_Clickable`), so one edit covers mouse hover and
  controller focus (user, 2026-11-21). The focus part sits in `removed` with `mergedInto`, so the
  trawl skips it.
- What's New is one part (user, 2026-11-21): the news tile caption bar (`Kp4Buf0X_EventInfo`, the
  surviving id) and the Recently updated tile (`263GZqVc_RecentlyCompletedItem`, now an alias, so
  the trawl doesn't re-add it). Both share one selector list and one Hover, Focus row. Steam gives
  the tile no hover colour (it only scales), so its hover selectors take the caption bar's. The
  tile's footer (`263GZqVc_BottomSection`) joined too; it sits on the tile, so its colour stacks
  on the tile's.
- Header And Bottom Bar is one part (user, 2026-11-21): the header band (`ehWSiALG_Header::before`,
  the surviving id) and the Bottom bar (`3AYJPRJR_BasicFooter`, now an alias). The band is a
  pseudo-element and the bar isn't, so the pseudo is written into that member of the selector
  list (`._a::before, ._b`) and `pseudo` is unset; `pseudo`, when set, goes on every member. Locate
  keeps each member's `::before` outside its `:is()`. The Focus row is the header's only (focus
  inside the header); Steam has no focus colour for the bottom bar. On store pages
  Steam makes the header (`HeaderOpaque`) and bar (`Opaque`) solid black, and the bar sits over the
  root background (white here), so a see-through colour came out pale. The part's `underlay` paints
  the Home screen background there (user, 2026-11-21: "retain my styling exactly"): the opaque header
  gets it under the band (`plain`), the opaque bar gets the edit layered over it (`layered`,
  `linear-gradient(edit, edit), home`). Emitted only when the part has its own edit.
- Background glass (`fjbDEq55_BackgroundGlass…`) is the layer Steam fades in over the home screen
  while a menu or dialog is open (opacity 0 otherwise); it blurs (8px) and tints (70% black)
  what's behind it. Shown as a "Blur" slider (0–100%, 100% = 40px; Steam's 8px = 20%) under the Home screen row,
  not a row (user, 2026-11-21). The one non-colour prop: `backdrop-filter`, values `blur(Npx)`
  only, applied through Steam's own blur rule (`propSelectors`). Its Reset clears the tint too,
  since the tint has no row.
- Editor controls: header buttons share one width (the widest); messages sit in the header, build
  and profile in the title's tooltip. Each row: swatch → colour wheel pop-up (hue/saturation wheel,
  brightness slider, recent colours in `localStorage` `chroma.recent`); opacity slider tinted with
  the row's colour; editable hex (`#rrggbb` / `#rrggbbaa`, also takes `#rgb` and `rgb()` on
  paste). Edits save as hex. Pointer cursor on everything clickable.
