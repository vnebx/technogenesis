const tileWidth = 60;
const lakeWidth = 4;
const lakeHeight = 3;
const regionSize = 32;
const seedLength = 24;
const characterPath = "assets/characters/basicrobot";
const directions = ["idle", "forward", "backward", "left", "right"];
const moveSpeed = 120;
const animInterval = 180;

const keys = {};
const imageCache = {};
const frameCounts = {};
const tileElements = new Map();
const lakeCache = new Map();
const remotePlayers = new Map();

let seed = [];
let playerWorldX = 0;
let playerWorldY = 0;
let direction = "idle";
let animFrame = 0;
let animTimer = 0;
let lastTime = 0;
let viewportEl = null;
let cameraX = 0;
let cameraY = 0;
let worldEl = null;
let playerEl = null;
let coordEl = null;
let ws = null;
let localPlayerId = null;
let lastSentSnapshot = null;

function imageExists(src) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(true);
        img.onerror = () => resolve(false);
        img.src = src;
    });
}

async function discoverFrames() {
    for (const name of directions) {
        let count = 0;
        while (await imageExists(`${characterPath}/${name}${count}.png`)) {
            count++;
        }
        frameCounts[name] = count;
    }
}

async function preloadSprites() {
    for (const name of directions) {
        for (let i = 0; i < frameCounts[name]; i++) {
            const src = `${characterPath}/${name}${i}.png`;
            const img = new Image();
            img.src = src;
            imageCache[src] = img;
        }
    }
}

function createRng(values) {
    let state = values.reduce((acc, value, index) => {
        return (acc ^ (value + index * 31)) >>> 0;
    }, 0x9e3779b9);

    return () => {
        state = (Math.imul(state ^ (state >>> 15), 0x2b2bae35) ^ Math.imul(state ^ (state >>> 7), 0x1b873593)) >>> 0;
        return state / 4294967296;
    };
}

function regionSeed(rx, ry) {
    return seed.map((value, index) => {
        return (value ^ ((rx * 73856093 + ry * 19349663 + index * 83492791) >>> 0)) & 255;
    });
}

function getLakeOrigin(rx, ry) {
    const key = `${rx},${ry}`;
    if (lakeCache.has(key)) {
        return lakeCache.get(key);
    }

    const rng = createRng(regionSeed(rx, ry));
    const placeIndex = Math.floor(rng() * seedLength);

    if (seed[placeIndex] % 2 !== 0) {
        lakeCache.set(key, null);
        return null;
    }

    const baseCol = rx * regionSize;
    const baseRow = ry * regionSize;
    const col = baseCol + Math.floor(rng() * (regionSize - lakeWidth + 1));
    const row = baseRow + Math.floor(rng() * (regionSize - lakeHeight + 1));
    const origin = { col, row };
    lakeCache.set(key, origin);
    return origin;
}

function getTileType(col, row) {
    const rx = Math.floor(col / regionSize);
    const ry = Math.floor(row / regionSize);

    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            const lake = getLakeOrigin(rx + dx, ry + dy);
            if (!lake) {
                continue;
            }
            if (
                col >= lake.col &&
                col < lake.col + lakeWidth &&
                row >= lake.row &&
                row < lake.row + lakeHeight
            ) {
                return "water";
            }
        }
    }

    return "grass";
}

function tileKey(col, row) {
    return `${col},${row}`;
}

function createTileElement(col, row, type) {
    const tile = document.createElement("div");
    tile.className = "tile";
    tile.style.width = `${tileWidth}px`;
    tile.style.height = `${tileWidth}px`;
    tile.style.position = "absolute";
    tile.style.top = `${row * tileWidth}px`;
    tile.style.left = `${col * tileWidth}px`;
    tile.style.backgroundImage = `url(assets/tiles/${type}.png)`;
    tile.style.backgroundSize = "cover";
    tile.style.backgroundPosition = "center";
    tile.style.backgroundRepeat = "no-repeat";
    worldEl.appendChild(tile);
    return tile;
}

function ensureTile(col, row) {
    const key = tileKey(col, row);
    if (tileElements.has(key)) {
        return;
    }
    const type = getTileType(col, row);
    tileElements.set(key, createTileElement(col, row, type));
}

function updateVisibleTiles() {
    const margin = 2;
    const startCol = Math.floor(cameraX / tileWidth) - margin;
    const endCol = Math.ceil((cameraX + window.innerWidth) / tileWidth) + margin;
    const startRow = Math.floor(cameraY / tileWidth) - margin;
    const endRow = Math.ceil((cameraY + window.innerHeight) / tileWidth) + margin;

    const needed = new Set();
    for (let row = startRow; row <= endRow; row++) {
        for (let col = startCol; col <= endCol; col++) {
            needed.add(tileKey(col, row));
            ensureTile(col, row);
        }
    }

    for (const [key, element] of tileElements) {
        if (!needed.has(key)) {
            element.remove();
            tileElements.delete(key);
        }
    }
}

function updateCamera() {
    cameraX = playerWorldX + tileWidth / 2 - window.innerWidth / 2;
    cameraY = playerWorldY + tileWidth / 2 - window.innerHeight / 2;
    worldEl.style.transform = `translate(${-cameraX}px, ${-cameraY}px)`;
    updateVisibleTiles();
}

function createPlayer() {
    playerEl = document.createElement("div");
    playerEl.style.width = `${tileWidth}px`;
    playerEl.style.height = `${tileWidth}px`;
    playerEl.style.position = "absolute";
    playerEl.style.backgroundSize = "contain";
    playerEl.style.backgroundPosition = "center";
    playerEl.style.backgroundRepeat = "no-repeat";
    playerEl.style.zIndex = "1";
    worldEl.appendChild(playerEl);
    updatePlayerSprite();
}

function createRemotePlayer(playerId) {
    const player = document.createElement("div");
    player.style.width = `${tileWidth}px`;
    player.style.height = `${tileWidth}px`;
    player.style.position = "absolute";
    player.style.backgroundSize = "contain";
    player.style.backgroundPosition = "center";
    player.style.backgroundRepeat = "no-repeat";
    player.style.zIndex = "2";
    player.style.pointerEvents = "none";
    worldEl.appendChild(player);
    remotePlayers.set(playerId, player);
    return player;
}

function createHud() {
    coordEl = document.createElement("div");
    coordEl.id = "coords";
    document.body.appendChild(coordEl);
    updateCoords();
}

function getMovementState() {
    let vx = 0;
    let vy = 0;

    if (keys["a"]) vx -= 1;
    if (keys["d"]) vx += 1;
    if (keys["w"]) vy -= 1;
    if (keys["s"]) vy += 1;

    if (vx === 0 && vy === 0) {
        return { vx: 0, vy: 0, direction: "idle" };
    }

    let moveDirection;
    if (vy < 0) moveDirection = "forward";
    else if (vy > 0) moveDirection = "backward";
    else if (vx < 0) moveDirection = "left";
    else moveDirection = "right";

    return { vx, vy, direction: moveDirection };
}

function nextAnimFrame(name, current) {
    const total = frameCounts[name];
    if (total <= 1) return 0;
    const next = current + 1;
    return next < total ? next : 0;
}

function updatePlayerSprite() {
    const src = `${characterPath}/${direction}${animFrame}.png`;
    playerEl.style.backgroundImage = `url(${src})`;
    playerEl.style.left = `${playerWorldX}px`;
    playerEl.style.top = `${playerWorldY}px`;
}

function normalizeRemoteState(entity) {
    if (!entity || typeof entity !== "object") {
        return { position: { x: 0, y: 0 }, animation: "idle", character: characterPath };
    }
    const position = entity.position || { x: 0, y: 0 };
    return {
        position: { x: Number(position.x) || 0, y: Number(position.y) || 0 },
        animation: entity.animation || "idle",
        character: entity.character || characterPath,
    };
}

function updateRemotePlayers(players) {
    const knownIds = new Set();

    for (const [playerId, payload] of Object.entries(players || {})) {
        if (playerId === localPlayerId) {
            continue;
        }
        knownIds.add(playerId);

        const state = normalizeRemoteState(payload);
        let player = remotePlayers.get(playerId);
        if (!player) {
            player = createRemotePlayer(playerId);
        }

        const animation = state.animation || "idle";
        const totalFrames = frameCounts[animation] || 1;
        const currentFrame = Math.floor(Date.now() / animInterval) % totalFrames;
        const spritePath = `${state.character}/${animation}${currentFrame}.png`;

        player.style.backgroundImage = `url(${spritePath})`;
        player.style.left = `${state.position.x}px`;
        player.style.top = `${state.position.y}px`;
    }

    for (const [playerId, player] of remotePlayers) {
        if (!knownIds.has(playerId)) {
            player.remove();
            remotePlayers.delete(playerId);
        }
    }
}

function updateCoords() {
    const x = Math.floor(playerWorldX / tileWidth);
    const y = Math.floor(playerWorldY / tileWidth);
    coordEl.textContent = `x: ${x}  y: ${y}`;
}

function getPlayerSnapshot() {
    return {
        position: { x: playerWorldX, y: playerWorldY },
        animation: direction,
        character: characterPath,
    };
}

function sendPlayerUpdate() {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return;
    }

    const snapshot = getPlayerSnapshot();
    const payload = JSON.stringify({ operation: "update", data: snapshot });
    if (payload === lastSentSnapshot) {
        return;
    }

    ws.send(payload);
    lastSentSnapshot = payload;
}

function handleServerMessage(event) {
    const message = JSON.parse(event.data);

    if (message.type === "welcome") {
        localPlayerId = message.player_id;
        seed = Array.isArray(message.seed) ? message.seed : [];
        if (message.players) {
            updateRemotePlayers(message.players);
        }
        if (seed.length) {
            updateCamera();
        }
        return;
    }

    if (message.type === "state") {
        if (Array.isArray(message.seed)) {
            seed = message.seed;
            if (seed.length) {
                updateVisibleTiles();
            }
        }
        if (message.players) {
            updateRemotePlayers(message.players);
        }
    }
}

function connectToServer() {
    return fetch("/api/ws-token")
        .then((response) => response.json())
        .then((data) => {
            const protocol = window.location.protocol === "https:" ? "wss" : "ws";
            ws = new WebSocket(`${protocol}://${window.location.hostname}:8900`);

            return new Promise((resolve, reject) => {
                ws.onopen = () => {
                    ws.send(JSON.stringify({ token: data.token }));
                };

                ws.onmessage = (event) => {
                    const message = JSON.parse(event.data);
                    if (message.type === "welcome") {
                        handleServerMessage(event);
                        resolve();
                        return;
                    }
                    handleServerMessage(event);
                };

                ws.onerror = () => reject(new Error("WebSocket connection failed."));
                ws.onclose = () => {
                    ws = null;
                };
            });
        });
}

function gameLoop(time) {
    const dt = lastTime ? (time - lastTime) / 1000 : 0;
    lastTime = time;

    const movement = getMovementState();
    const newDirection = movement.direction;
    if (newDirection !== direction) {
        direction = newDirection;
        animFrame = 0;
        animTimer = 0;
    }

    if (movement.vx !== 0 || movement.vy !== 0) {
        const len = Math.hypot(movement.vx, movement.vy);
        const speed = moveSpeed / len;
        playerWorldX += movement.vx * speed * dt;
        playerWorldY += movement.vy * speed * dt;

        animTimer += dt * 1000;
        if (animTimer >= animInterval) {
            animTimer = 0;
            animFrame = nextAnimFrame(direction, animFrame);
        }
    } else {
        animFrame = 0;
        animTimer = 0;
    }

    updatePlayerSprite();
    updateCamera();
    updateCoords();
    sendPlayerUpdate();
    requestAnimationFrame(gameLoop);
}

window.addEventListener("keydown", (e) => {
    keys[e.key.toLowerCase()] = true;
});

window.addEventListener("keyup", (e) => {
    keys[e.key.toLowerCase()] = false;
});

window.addEventListener("resize", () => {
    updateCamera();
});

async function init() {
    document.body.style.margin = "0";
    document.body.style.overflow = "hidden";

    viewportEl = document.createElement("div");
    viewportEl.id = "viewport";
    document.body.appendChild(viewportEl);

    worldEl = document.createElement("div");
    worldEl.id = "world";
    worldEl.style.position = "absolute";
    worldEl.style.top = "0";
    worldEl.style.left = "0";
    viewportEl.appendChild(worldEl);

    await connectToServer();
    await discoverFrames();
    await preloadSprites();
    createHud();
    createPlayer();
    updateCamera();
    requestAnimationFrame(gameLoop);
}

init();
