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
- `server/game/` — the entire client. `index.html` + a bunch of ES modules + `style.css`. There is no build step, it's just files.
- `server/game/mapgen/` — the procedural generation (lakes, trees).

### The client modules (`server/game/*.js`)
The client is split into small ES modules, all sharing a central `state`. `main.js` only holds the core logic (init, the render loop, the player, the camera, the HUD); everything else lives in its own file.

- `index.html` — the game shell. Loads `style.css` and the `main.js` module, and holds the mobile "tap to go fullscreen" start screen.
- `main.js` — **core logic & orchestration.** Boots the game (`init`/`startGame`), owns the `requestAnimationFrame` render loop, the local player, the HUD (`#coords`), the camera transform defense (`applyCanvasTransform`), and the desktop keyboard/window input handlers. Imports everything else and wires it together.
- `style.css` — all the styling for the entire game.
- `state.js` — the shared brain. Exports `CONFIG` (all the balance/geometry constants like `tileWidth`, `CHOP_USES_REQUIRED`) and `state`, one big object holding every bit of mutable game state (player position, inventory, camera, websocket, caches, remote players, etc.). Every module reads/writes through it, which is what lets them talk to each other without a mess of circular globals.
- `settings.js` — the mobile settings. Loads, applies, and saves the joystick/inventory/button sizes to `localStorage`. `applySettings` writes the CSS variables and recalculates the joystick radius.
- `sprites.js` — images. Discovers character animation frames on disk, preloads them into an image cache, converts them to data URLs to dodge Chrome's background-image flicker, and averages tile colors for the black-seam workaround. Also picks the current sprite frame name.
- `tiles.js` — the world's ground & trees. Creates/destroys tile elements as you move, applies the removed-tree set, and drives `updateCamera()` (the big `translate` transform). Tree existence queries (`treeAtPlayer`) live here too.
- `inventory.js` — your 24-slot bag. Builds the inventory grid, the cursor-following item, and the tooltip. Handles grab/place, grab-half, the 1-second-hold split, and touch drag & drop.
- `grounditems.js` — items lying on the world. Renders them with the little bobbing animation, picks them up when the player overlaps them, and drops the held item onto the ground.
- `remote.js` — the other players. Creates remote player elements, holds their animation state, and eases them toward their network target each frame (interpolation).
- `net.js` — the websocket. Connects with a token, sends the player snapshot, and handles `welcome`/`state` messages from the server (applying seed, removed trees, ground items, remote players, your saved inventory).
- `gameplay.js` — "use" actions. `startUse()`/`applyUseEffect()` count chops towards a tree and fell it, dropping the log and telling the server.
- `input.js` — keys. Turns `W A S D` into a movement/direction vector and resets keys when the window loses focus.
- `mobile.js` — the touch UI. The joystick, the USE/INV action buttons, and the settings gear + panel. Also exports `isTouchDevice`.

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
- `CHOP_USES_REQUIRED` (state.js) — chops needed to fell a tree
- `tileWidth = 60` (state.js) — world tile size in px
- `applyCanvasTransform()` (main.js) — the browser-zoom defense
- `updateRemotePlayersRender(dt)` (remote.js) — the remote-player movement
- `settings.js` — where the mobile sizes are applied to the CSS variables

---

I still have to think the progression of the game itself and implement a lot of basic features.
