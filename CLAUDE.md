# chroma

Theme Steam's Big Picture / Game Mode UI. chroma-picker (`/`, the default) makes a whole theme
from Dark / Light and a hue; dev mode (`/dev`) is the per-element `element: colour` editor, for
hand styling or an agent. Changes preview live in Steam; the result saves as a CSS Loader theme.

Read `docs/design.md` (what we're building, decisions) and `docs/handoff.md` (state, next step)
at session start.

## Working with the user

- Short, direct, no preamble or recap. Lead with the answer; say what is unknown.
- A question gets an answer, not an action. Build only on an explicit go-ahead.
- The user commits and pushes. Hand over paths to stage and a one-line imperative message.
- Shell commands for the user: plain commands, no `!` prefix. Machine is Arch, bash.
- Reuse before building: search for existing tools first.

## Layout

- `steam-debug/` — clone of kmturley/steam-debug (CC0). CLI over Chrome DevTools Protocol:
  `node steam-debug/steam-debug.mjs help`. Node 22+ required (22.20.0 installed via asdf).
- `chroma.mjs` — server: `node chroma.mjs`, then http://localhost:7300 (picker) or /dev (editor).
  Own small CDP client (steam-debug is CLI-only; too slow per keystroke).
- `editor/picker.html` — chroma-picker. `editor/index.html` — the dev editor: magik's layout,
  coloured by the theme being edited. `editor/fonts/` — JetBrains Mono from magik, served by chroma.mjs.
- `templates/chroma.json` — the picker's template (a copy of the hand-made `mine` profile).
- `desktop/` — the Electron app (magik's setup): `npm start`, `npm run dist` (AppImage + pacman).
  Writes to `~/.config/chroma` (`CHROMA_DATA`). `README.md` — user docs, dev-mode API.
- `catalog/<steamBuild>.json` — parts: stable id, live selector, Steam defaults.
  `catalog/<steamBuild>.rules.json` — snapshot of Steam's colour rules (the palette's source).
- `profiles/<name>.json` — edits by part + `followMaster` + `palette` (Steam colours swapped everywhere; autosaved on every change).
- `cache/` — steamui-watch `stable.json`, refetched when older than 6h (used by the trawl).
- `docs/` — design and handoff.
- `crawl.mjs` — first-run crawler, superseded by steam-debug; reference only.
