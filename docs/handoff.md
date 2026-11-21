# Handoff — 2026-11-20

Started in a magik-rooted session; moved here because magik's project settings
(`allowUnsandboxedCommands: false`) kept `node` sandboxed, so it could not reach Steam.

## State

- Steam runs on the user's Arch PC in Big Picture with CDP on `localhost:8080`
  (`steam -dev -windowed -cef-enable-debugging -gamepadui`). Confirmed: `/json/version` answers,
  Chrome/126.
- User settings (`~/.claude-personal/settings.json`) exclude `node` from the sandbox, so `node`
  should reach `localhost:8080` from a session started in chroma. First thing: run
  `node steam-debug/steam-debug.mjs status`. If it still says Steam is not running, check whether
  `node` is sandboxed (`/proc/1/cmdline` is `/proc/self/fd/3` inside bubblewrap).
- First crawler run listed these pages: `MainMenu_uid7`, `notificationtoasts_uid7`,
  `QuickAccess_uid7`, `Steam Big Picture Mode`, `SharedJSContext` (only the last has
  `webpackChunksteamui`; all have `SteamClient`).
- steam-debug cloned from upstream. User will fork later (`gh` not installed; not urgent).

## Elements of concern (ui.png, `~/Downloads/claude/ui.png`, home tab)

- ec1: lower home panel background, currently transparent black.
- ec2: highlight colour of the selected/focused tab pill ("WHAT'S NEW"); the green Friends badge
  was circled too and is a separate element.
- ec3: news tile caption strip background ("Y11S4 DESIGNER'S NOTES").
- ec4: font colours (section labels "Yesterday / This week", tab labels, tile titles).

`~/Downloads/claude/ui2.png` shows desktop Quick Access: only Audio and Display scaling. Deck
panels differ; Deck work is phase 2.

## Findings that shape the design

- Steam beta moved from webpack to Vite + Rolldown: `webpackChunksteamui` gone, ~85% of class
  names stripped from JS. Stable (this PC) still webpack. steam-debug depends on webpack.
  Key everything on steamui-watch names and DOM classes.
- steamui-watch publishes readable-name ↔ hash maps every 6h:
  `https://beallio.github.io/steamui-watch/stable.json` (and `beta.json`). Entry shape:
  `"jadbof4z_Title": ["_jadbof4z_Title", "quickaccessvoicecontrolssteamdeck_Title_3-YlD"]`.
- CSS Loader theme: `theme.json` with `manifest_version: 8`; inject targets include
  `"bigpicture"`, `"QuickAccess"`, `"MainMenu"`.

## Session 2 (2026-11-20): home screen cataloged

- `node` reaches Steam from this project; `status` OK. Steam build 1794536281 (stable, webpack).
- ec1–ec4 found and verified: each was repainted by injected CSS and checked by screenshot.
  Result: `catalog/1794536281.json`.
- ec1 has no background of its own. The panel (`awNNWnmm_GamepadTabbedPage`) is transparent; the
  dark colour is `gamepadui_BasicHome`'s radial gradient, with the hero art masked to fade into it.
- The green Friends badge in ui.png wasn't on screen (no friends online), so it isn't cataloged yet.
- steam-debug gotchas: `inject`, `screenshot` and `eval` must get `--target BigPicture` (help text
  omits this for inject/screenshot). Without it, injection goes into SharedJSContext, which renders
  nothing, and screenshots come back 2x2 blank. `elementsFromPoint` misses `pointer-events:none`
  layers; scan all elements by rect instead.
- Naming: a stable.json key (`Kp4Buf0X_EventTime`) is always present; the `module_Name` alias
  isn't (EventTime has none). Each entry lists several hashes; the live one has to be picked by
  checking which is in the DOM. Profiles should key on the stable.json key.
- `~/homebrew/themes` doesn't exist: no CSS Loader on this PC. Phase 1's "survives restart" needs
  CSS Loader for desktop (or another persistence route). Undecided.

## Session 2, part 2: editor built

- `node chroma.mjs` serves http://localhost:7300. Verified through the API: state, live preview
  (screenshot confirmed all four edits painted), autosave to `profiles/mine.json`, export
  to `~/homebrew/themes/chroma/`. The page itself was only checked for loading and parsing; it
  hasn't been clicked through.
- Not verified: CSS Loader loading the theme, or the edits surviving a restart. Its server
  (35821) is off: `~/homebrew/themes/STORE` has no `server` key, so "Enable Standalone Backend"
  isn't on. Its file watcher is also off.
- Each row has a bin. It moves the part to the catalog's `removed` list (restore by moving it
  back by hand) and drops its edits. The lower home panel (`awNNWnmm_GamepadTabbedPage`) is removed.
- Master text colour + links built and verified (computed colours + screenshot). Profile is empty
  and the exported theme has no rules.
- Follow-master toggle, plain names and Trawl button built. Verified through the API and in Steam
  (computed colours): toggle on/off, trawl adds 20–32 parts per screen in <1s and is idempotent.
  The page itself hasn't been clicked through in a browser.
- Trawl groups rules that hit the same elements into one part (`aliases`; a prop set by another of
  Steam's rules keeps that rule's selector in `propSelectors`) and names parts from their own text
  only. Trawled parts were dropped and the home screen re-trawled: 6 hand + 35 trawled. Other
  screens (store page etc.) need trawling again.
- `.gitignore` written (profiles/, cache/, .claude/, out/). Not a git repo yet; steam-debug/ is a
  clone with its own .git (plan: submodule).
- Highlight/pressed states, per-selector Steam defaults and the magenta locate outline built and
  verified in Steam (computed colours under a simulated `gpfocus`, screenshot of the outline).

## Deferred (user, 2026-11-20)

- Git/GitHub: not now. `.gitignore` is ready. When it happens: steam-debug as a submodule; the
  catalog quotes on-screen text (game names), which matters if the repo is public.
- Windows machine: dropped; this Arch PC is the only machine.
- Steam Deck: not now. Route when wanted: CEF Remote Debugging on the Deck (port 8081), chroma
  gets `--host/--port`, export copies the theme to the Deck over SSH. No cable route: the
  Framework's HDMI/USB-C are outputs only.
- Known gap: a new Steam build has no catalog, and the first trawl starts an empty one (hand
  parts, names, master links lost). Fix when it bites: carry the newest catalog forward,
  re-resolving selectors from steamui-watch keys.

## Session 3 (2026-11-21): palette, side menus, picker

- Palette (Steam colour → yours, everywhere), Ctrl+1 / Ctrl+2 trawl and locate, subheadings in
  every category, chroma-picker at `/` (dev editor moved to `/dev`). See design.md.
- chroma runs from `node chroma.mjs`; after any change to chroma.mjs restart it, or the old server
  keeps pushing old CSS (the Ctrl+2 black band came back that way).

## Session 3, part 2: app, export, GitHub prep

- Decky dropped for an Electron app (`desktop/`). AppImage and pacman package built and run
  (`desktop/dist/`); both reached Steam and served the picker.
- Export works without Steam (rules snapshot); tested from the dev page: installed
  `~/homebrew/themes/chroma-mine/`, zip in `~/Downloads`. CSS Loader's local server (35821) didn't
  answer here, so switching on was left to CSS Loader. Not yet tested: a theme loaded by CSS Loader
  on the Deck; the picker page clicked through in the app.

## 0.2.0 done (2026-11-21)

- Released as chroma 0.2.0: `desktop/dist/chroma-0.2.0.AppImage` and `chroma-desktop-0.2.0.pacman`.
  MIT licence (`LICENSE`, holder "chroma contributors"). README covers install, Steam debugging,
  use, save, export, sending to a Deck, dev mode (agent-first, names not Steam's).
- Export never switches CSS Loader themes; the picker's Preview switch, leaving a page and quitting
  the app take chroma's preview out of Steam (it sits above CSS Loader's themes).
- Not yet tested: an exported theme loaded by CSS Loader on the Deck; the AppImage on the Deck.

## Next step: 3.0, on the Deck (user)

Developed on the Steam Deck for edge cases: Deck-only screens (trawl them with the Deck's Quick
Access panels open), the AppImage in Desktop Mode next to Big Picture, CSS Loader on SteamOS.
Git and distribution (repo, submodule for steam-debug, GitHub Release) still to walk through.

## Earlier next step

Big Picture only. Turn on CSS Loader's Standalone Backend, export, confirm `applied: true`, then
check the theme survives a Steam restart (phase 1 done criterion).
