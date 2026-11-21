// chroma's desktop shell: runs chroma's server (../chroma.mjs, or the app's resources once
// packaged) in this process on a free loopback port, and opens one window on chroma-picker.
// Writable data (profiles, cache, catalogues the trawl extends) lives in Electron's userData.
// `npm start` runs it from the repo; `npm run dist` builds the AppImage (Steam Deck, any Linux)
// and the pacman package (Arch).
const { app, BrowserWindow, dialog, shell } = require("electron")
const net = require("node:net")
const path = require("node:path")
const { pathToFileURL } = require("node:url")

const chromaDir = () => (app.isPackaged ? path.join(process.resourcesPath, "chroma") : path.join(__dirname, ".."))

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })

let win = null
let chroma = null // chroma.mjs's exports

async function start() {
  process.env.CHROMA_DATA = app.getPath("userData")
  process.env.CHROMA_PORT = String(await freePort())
  chroma = await import(pathToFileURL(path.join(chromaDir(), "chroma.mjs")).href)
  const origin = await chroma.listening

  win = new BrowserWindow({
    width: 760,
    height: 900,
    backgroundColor: "#967cb5",
    autoHideMenuBar: true,
    title: "chroma",
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: { contextIsolation: true, sandbox: true },
  })
  // chroma's own pages stay in the window; anything else opens in the browser.
  const own = (url) => url.startsWith(origin)
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!own(url)) shell.openExternal(url)
    return { action: "deny" }
  })
  win.webContents.on("will-navigate", (event, url) => {
    if (!own(url)) {
      event.preventDefault()
      shell.openExternal(url)
    }
  })
  await win.loadURL(origin)
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
  app.whenReady().then(start).catch((e) => {
    dialog.showErrorBox("chroma couldn't start", String(e?.stack ?? e))
    app.quit()
  })
  app.on("window-all-closed", () => app.quit())
  // Quitting takes chroma's preview out of Steam (it sits above CSS Loader's themes). Steam
  // may be gone already: give it two seconds at most.
  let cleared = false
  app.on("before-quit", (event) => {
    if (cleared || !chroma) return
    event.preventDefault()
    cleared = true
    const timeout = new Promise((resolve) => setTimeout(resolve, 2000))
    Promise.race([chroma.clearPreview().catch(() => {}), timeout]).finally(() => app.quit())
  })
}
