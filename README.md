# technogenesis

A little browser RPG about, uhh, technological progression. It runs on a server in Python (aiohttp), the rendering is client-side, and the rendering engine is made from scratch in JavaScript. No frameworks, it uses http request and websockets to comunicate with the server.

Right now it's not really a working game yet — it's more like a small multiplayer sandbox where you walk around a procedurally generated world, chop trees, and see other people walking around.

---

## Things you can do right now

**Movement & controls**
- `W A S D` — move around. The camera is always locked to your player.
- `E` — open / close your inventory.
- `F` — "use". Currently that means chopping a tree if you're standing next to one.
- You cannot make the page zoom (the game cancels browser zoom), and if you alt-tab while walking your player stops instead of gliching out and moving forever.

**The world**
- Procedurally generated, infinite-ish ground made of 16x16 tiles: grass, water, trees. There's a seed generation so every world has the same start.
- The world generators are in `server/game/mapgen/` (`lake.js` and `tree.js`).
- I'm still working on terrain generation and player settings.

**Multiplayer**
- Real-time via websocket. You see other players move around, with their little walking animation playing.
- Other players are drawn interpolated so they don't teleport between network updates.

**Inventory & items**
- 24 slots (4×6 grid), left-click to grab/place, right-click to grab half a stack.
- Hover a slot to see a tooltip with the item name.
- Trees drop `oak_log_chunk` on the ground. Walk over a drop to pick it up.

---

## Information about the code

### Main files & folders
- `server/main.py` — the aiohttp server. Handles login/register, the websocket, and keeps the "world state" in memory. Sends the current positions of all players to everyone on each update.
- `server/game/` — the entire client. `index.html` + `main.js` + `style.css`. There is no build step, it's just files.
- `server/game/mapgen/` — the procedural generation (lakes, trees).

### Technical details about the code

**The camera is basically one big transform.**
Everything the player sees is inside `<div id="world">`, and the camera is just `transform: translate(-cameraX, -cameraY)`. Move the player, move the camera.

**Your own character is fake.**
Your player isn't drawn inside the world like the tiles — it's a `position: fixed` element stuck to the center of the screen. The **world moves around you**, you never move. That's why you never feel "screen shake" or lag while walking. Other players are also drawn as fixed-ish elements, positioned manually each frame.

**Tiles get created and destroyed as you move.**
We don't render the whole infinite world, only the tiles near the camera (with a bit of margin so they don't pop in/out). As you walk, old tiles get removed and new ones created. The margins are tweaked so Chrome doesn't flicker seams at the screen edges.

**The flicker problems (why the code looks like this).**
Chrome is really picky about sprites that change their `background-image` while sitting inside a GPU-transformed layer — it flashes. So players are drawn on their own composited layer (`translateZ(0)`, `will-change: transform`), outside the scrolling world, and their position is updated every animation frame. Positions are rounded to whole device pixels so they don't jitter at weird zoom levels. It took way too long to learn this.

**Browser zoom is disabled to prevent more view**
The whole game lives inside an `<div id="app">` that is a fixed logical canvas. Every frame is measured using `innerWidth * devicePixelRatio` and scale the canvas,when you resize the page (which you shouldn't). Window resize vs. browser zoom are told apart by `devicePixelRatio`, so actually resizing the window still works normally (square pixels, the view doesn't stretch).

**Visual bug, black horizontal lines workaround**
To hide the pixel seams between tiles, each ground tile gets a `background-color`. Instead of hardcoding grass green / water blue, the game draws each tile image onto a hidden canvas at load and average the pixels. Change the image, the color follows automatically. (Transparent bits are skipped so tree leaves don't get a weird dark background.) THIS IS A WORKAROUND, MAY GET REMOVED

**Remote players are interpolated.**
The server sends positions whenever they change, but the game doesn't snap to them — each remote player has a `target` position it eases toward every frame, plus a timer-driven animation. Slow internet? The player just freezes on the last frame instead of glitching.

**Chop counts live client-side.**
Each tree remembers how many "uses" it's had (`treeUseCounts`). After `CHOP_USES_REQUIRED` chops the tree falls and drops its log. The server gets told the tree is gone so everyone sees it disappear.

### Quick references
- `CHOP_USES_REQUIRED` (main.js) — chops needed to fell a tree
- `tileWidth = 60` (main.js) — world tile size in px
- `applyCanvasTransform()` (main.js) — the browser-zoom defense
- `updateRemotePlayersRender(dt)` (main.js) — the remote-player movement

---

I still have to think the progression of the game itself and implement a lot of basic features.
