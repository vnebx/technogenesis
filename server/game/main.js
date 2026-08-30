import { getBaseTileType } from "./mapgen/lake.js";
import { getTreeTile, getTreeAt } from "./mapgen/tree.js";

const urlParams = new URLSearchParams(window.location.search);
const serverId = urlParams.get("server") || "";

const isTouchDevice = (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) ||
    "ontouchstart" in window || navigator.maxTouchPoints > 0 ||
    /iPad|iPhone|iPod/i.test(window.navigator.userAgent);

if (!serverId) {
    window.location.href = "/";
}

(() => {
    const startEl = document.getElementById("mobile-start");
    const startBtn = document.getElementById("fullscreen-start");
    if (!isTouchDevice || !startEl) return;

    startEl.hidden = false;

    const el = document.documentElement;
    const reqFullscreen = () => {
        const req = el.requestFullscreen || el.webkitRequestFullscreen;
        if (req) {
            const p = req.call(el);
            if (p && p.catch) p.catch(() => {});
        }
    };

    startBtn.addEventListener("click", () => {
        startBtn.textContent = "Starting...";
        if (!el.requestFullscreen && !el.webkitRequestFullscreen) {
            setTimeout(startGame, 120);
            return;
        }
        reqFullscreen();
        const done = () => startGame();
        document.addEventListener("fullscreenchange", done, { once: true });
        document.addEventListener("webkitfullscreenchange", done, { once: true });
        // fallback in case the browser does not support fullscreen
        setTimeout(done, 900);
    });
})();

const tileWidth = 60;
const lakeWidth = 4;
const lakeHeight = 3;
const regionSize = 32;
const treeRegionSize = 16;
let characterPath = "assets/characters/basicrobot";
const directions = ["idle", "forward", "backward", "left", "right", "idleforward", "idlebackward", "idleleft", "idleright", "forwarduse", "backwarduse", "leftuse", "rightuse"];

const INVENTORY_SCALE = 3;
const INVENTORY_COLS = 4;
const INVENTORY_ROWS = 6;
const INVENTORY_SIZE = INVENTORY_COLS * INVENTORY_ROWS;

let playerInventory = Array(INVENTORY_SIZE).fill(null);
let inventoryVisible = false;
let inventoryEl = null;
let cursorItem = null;
let cursorItemEl = null;
let tooltipEl = null;
const slotElements = [];

const ITEM_IMAGE_PATH = "assets/ui/items/";
const MAX_STACK = 64;
const INVENTORY_TEXT_SCALE = 0.9;

const moveSpeed = 120;
const animInterval = 180;
const useDuration = 500;
const useCooldown = 500;
const CHOP_USES_REQUIRED = 4;
const CHOP_REWARD = "oak_log_chunk";
const CHOP_REWARD_COUNT = 4;
const GROUND_ITEM_SCALE = 2;
const GROUND_ITEM_BASE_SIZE = 16;
const DROP_DISTANCE = Math.round(tileWidth * 0.8);
const GROUND_ITEM_BOB_AMPLITUDE = 4;

const keys = {};
const imageCache = {};
const characterFrames = {};
const preloadedCharacters = new Set();
const tileElements = new Map();
const remotePlayers = new Map();
const remoteTargets = new Map();
const remoteAnim = new Map();
const removedTrees = new Set();
const treeUseCounts = new Map();
let groundItems = [];
const groundItemEls = new Map();
const pendingPickups = new Set();

let seed = [];
let playerWorldX = 0;
let playerWorldY = 0;
let direction = "idle";
let lastDirection = "backward";
let animFrame = 0;
let animTimer = 0;
let using = false;
let useTimer = 0;
let useCooldownTimer = 0;
let lastTime = 0;
let viewportEl = null;
let appEl = null;
let GAME_W = 0;
let GAME_H = 0;
let scaleX = 1;
let scaleY = 1;
let cameraX = 0;
let cameraY = 0;
let worldEl = null;
let playerEl = null;
let coordEl = null;
let ws = null;
let localPlayerId = null;
let lastSentSnapshot = null;

let initStarted = false;
let joystickEl = null;
let joystickKnobEl = null;
let joystickTouchId = null;
let joystickCenterX = 0;
let joystickCenterY = 0;
const JOYSTICK_RADIUS = 52;
const JOYSTICK_DEADZONE = 14;

function imageExists(src) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(true);
        img.onerror = () => resolve(false);
        img.src = src;
    });
}

async function discoverFrames(character) {
    const frames = characterFrames[character] || (characterFrames[character] = {});
    for (const name of directions) {
        let count = 0;
        while (await imageExists(`${character}/${name}${count}.png`)) {
            count++;
        }
        frames[name] = count;
    }
}

function getCharacterFrames(character) {
    return characterFrames[character] || characterFrames[characterPath] || {};
}

async function preloadSprites(character) {
    if (preloadedCharacters.has(character)) return;
    const frames = getCharacterFrames(character);
    for (const name of directions) {
        for (let i = 0; i < (frames[name] || 0); i++) {
            const src = `${character}/${name}${i}.png`;
            if (imageCache[src]) continue;
            const img = new Image();
            img.src = src;
            img.decode && img.decode().catch(() => {});
            imageCache[src] = img;
        }
    }
    preloadedCharacters.add(character);
}

const spriteDataUrls = new Map();

function spriteBackground(src) {
    if (spriteDataUrls.has(src)) return spriteDataUrls.get(src);
    const img = imageCache[src];
    if (img && img.complete && img.naturalWidth > 0) {
        try {
            const canvas = document.createElement("canvas");
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            canvas.getContext("2d").drawImage(img, 0, 0);
            const url = canvas.toDataURL("image/png");
            spriteDataUrls.set(src, url);
            return url;
        } catch (e) {
            return src;
        }
    }
    return src;
}

const TILE_TYPES = ["grass", "water", "oak_log", "oak_tree_leaves"];
const tileColors = {};

function preloadTiles() {
    for (const type of TILE_TYPES) {
        const src = `assets/tiles/${type}.png`;
        if (!imageCache[src]) {
            const img = new Image();
            img.src = src;
            imageCache[src] = img;
        }
    }
}

function loadImage(src) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = src;
    });
}

async function loadTileColors() {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    for (const type of TILE_TYPES) {
        const img = await loadImage(`assets/tiles/${type}.png`);
        if (!img) continue;
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);
        let data;
        try {
            data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        } catch (e) {
            continue;
        }
        let r = 0, g = 0, b = 0, count = 0;
        for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] < 50) continue;
            r += data[i];
            g += data[i + 1];
            b += data[i + 2];
            count++;
        }
        if (count > 0) {
            tileColors[type] = `rgb(${Math.round(r / count)}, ${Math.round(g / count)}, ${Math.round(b / count)})`;
        }
    }
}

async function setCharacterPath(newPath) {
    if (!newPath || newPath === characterPath) return;
    characterPath = newPath;
    await discoverFrames(characterPath);
    await preloadSprites(characterPath);
    animFrame = 0;
    animTimer = 0;
    if (playerEl) updatePlayerSprite();
}

async function ensureRemoteCharacter(character) {
    if (!character || preloadedCharacters.has(character)) return;
    await discoverFrames(character);
    await preloadSprites(character);
}

function tileKey(col, row) {
    return `${col},${row}`;
}

function createTileElement(col, row, type, zIndex = "0") {
    const tile = document.createElement("img");
    tile.className = "tile";
    tile.src = `assets/tiles/${type}.png`;
    tile.style.display = "block";
    tile.style.width = `${tileWidth + 2}px`;
    tile.style.height = `${tileWidth + 2}px`;
    tile.style.position = "absolute";
    tile.style.top = `${Math.round(row * tileWidth) - 1}px`;
    tile.style.left = `${Math.round(col * tileWidth) - 1}px`;
    tile.style.zIndex = zIndex;
    tile.style.pointerEvents = "none";
    if ((type === "grass" || type === "water") && tileColors[type]) {
        tile.style.backgroundColor = tileColors[type];
    }
    worldEl.appendChild(tile);
    return tile;
}

function ensureTile(col, row) {
    const key = tileKey(col, row);
    if (tileElements.has(key)) return;

    const baseType = getBaseTileType(col, row, seed, regionSize, lakeWidth, lakeHeight);
    const baseTile = createTileElement(col, row, baseType, "0");
    const treeOrigin = getTreeAt(col, row, seed, regionSize, treeRegionSize);
    if (!treeOrigin || removedTrees.has(treeKey(treeOrigin))) {
        tileElements.set(key, { base: baseTile });
        return;
    }
    const treeType = getTreeTile(col, row, seed, regionSize, treeRegionSize);
    const overlayZ = treeType === "oak_tree_leaves" ? "3" : "1";
    const overlayTile = createTileElement(col, row, treeType, overlayZ);
    tileElements.set(key, { base: baseTile, overlay: overlayTile });
}

function updateVisibleTiles() {
    const createMargin = 3;
    const keepMargin = 8;
    const startCol = Math.floor(cameraX / tileWidth) - createMargin;
    const endCol = Math.ceil((cameraX + GAME_W) / tileWidth) + createMargin;
    const startRow = Math.floor(cameraY / tileWidth) - createMargin;
    const endRow = Math.ceil((cameraY + GAME_H) / tileWidth) + createMargin;

    const keepStartCol = Math.floor(cameraX / tileWidth) - keepMargin;
    const keepEndCol = Math.ceil((cameraX + GAME_W) / tileWidth) + keepMargin;
    const keepStartRow = Math.floor(cameraY / tileWidth) - keepMargin;
    const keepEndRow = Math.ceil((cameraY + GAME_H) / tileWidth) + keepMargin;

    const viewKey = (col, row) => (col >= keepStartCol && col <= keepEndCol && row >= keepStartRow && row <= keepEndRow);

    for (let row = startRow; row <= endRow; row++) {
        for (let col = startCol; col <= endCol; col++) {
            ensureTile(col, row);
        }
    }

    for (const [key, entry] of tileElements) {
        const [colStr, rowStr] = key.split(",");
        const col = parseInt(colStr, 10);
        const row = parseInt(rowStr, 10);
        if (!viewKey(col, row)) {
            if (entry.base) entry.base.remove();
            if (entry.overlay) entry.overlay.remove();
            tileElements.delete(key);
        }
    }
}

function updateCamera() {
    cameraX = playerWorldX + tileWidth / 2 - GAME_W / 2;
    cameraY = playerWorldY + tileWidth / 2 - GAME_H / 2;
    const worldX = Math.round(cameraX);
    const worldY = Math.round(cameraY);
    worldEl.style.transform = `translate(${-worldX}px, ${-worldY}px)`;
    updateVisibleTiles();
}

function createPlayer() {
    playerEl = document.createElement("div");
    playerEl.style.width = `${tileWidth}px`;
    playerEl.style.height = `${tileWidth}px`;
    playerEl.style.position = "fixed";
    playerEl.style.top = "0";
    playerEl.style.left = "0";
    playerEl.style.backgroundSize = "contain";
    playerEl.style.backgroundPosition = "center";
    playerEl.style.backgroundRepeat = "no-repeat";
    playerEl.style.zIndex = "10";
    viewportEl.appendChild(playerEl);
    updatePlayerSprite();
}

function createRemotePlayer(playerId) {
    const player = document.createElement("div");
    player.style.width = `${tileWidth}px`;
    player.style.height = `${tileWidth}px`;
    player.style.position = "fixed";
    player.style.top = "0";
    player.style.left = "0";
    player.style.backgroundSize = "contain";
    player.style.backgroundPosition = "center";
    player.style.backgroundRepeat = "no-repeat";
    player.style.zIndex = "10";
    player.style.pointerEvents = "none";
    viewportEl.appendChild(player);
    remotePlayers.set(playerId, player);
    return player;
}

function createHud() {
    coordEl = document.createElement("div");
    coordEl.id = "coords";
    appEl.appendChild(coordEl);
    updateCoords();
}

function getItemTexturePath(itemId) {
    if (!itemId) return null;
    return `${ITEM_IMAGE_PATH}${itemId}.png`;
}

function createItemSlot(itemId, count = 1) {
    return { id: itemId, count: count };
}

function normalizeInventorySlot(slot) {
    if (!slot) return null;
    if (typeof slot === "string") return createItemSlot(slot, 1);
    if (typeof slot === "object") {
        const count = Math.max(1, Math.min(MAX_STACK, Number(slot.count) || 1));
        return createItemSlot(slot.id, count);
    }
    return null;
}

function addItem(itemId, count = 1) {
    let remaining = count;
    for (let i = 0; i < INVENTORY_SIZE && remaining > 0; i++) {
        const slot = playerInventory[i];
        if (slot && slot.id === itemId && slot.count < MAX_STACK) {
            const added = Math.min(MAX_STACK - slot.count, remaining);
            slot.count += added;
            remaining -= added;
        }
    }
    for (let i = 0; i < INVENTORY_SIZE && remaining > 0; i++) {
        if (!playerInventory[i]) {
            const added = Math.min(MAX_STACK, remaining);
            playerInventory[i] = createItemSlot(itemId, added);
            remaining -= added;
        }
    }
    renderInventory();
    sendPlayerUpdate();
    return remaining;
}

function grabFromSlot(index) {
    if (cursorItem) return;
    const slot = playerInventory[index];
    if (!slot) return;

    cursorItem = { id: slot.id, count: slot.count };
    playerInventory[index] = null;
    updateCursorItem();
    renderInventory();
    sendPlayerUpdate();
}

function grabHalfFromSlot(index) {
    if (cursorItem) return;
    const slot = playerInventory[index];
    if (!slot) return;

    const grabbed = Math.ceil(slot.count / 2);
    const remaining = slot.count - grabbed;
    cursorItem = { id: slot.id, count: grabbed };
    if (remaining > 0) {
        slot.count = remaining;
    } else {
        playerInventory[index] = null;
    }
    updateCursorItem();
    renderInventory();
    sendPlayerUpdate();
}

function placeOnSlot(index) {
    if (!cursorItem) return;
    const slot = playerInventory[index];
    if (!slot) {
        playerInventory[index] = cursorItem;
        cursorItem = null;
    } else if (slot.id === cursorItem.id) {
        const space = MAX_STACK - slot.count;
        if (space > 0) {
            const moved = Math.min(space, cursorItem.count);
            slot.count += moved;
            cursorItem.count -= moved;
            if (cursorItem.count <= 0) cursorItem = null;
        }
    } else {
        const temp = playerInventory[index];
        playerInventory[index] = cursorItem;
        cursorItem = temp;
    }
    updateCursorItem();
    renderInventory();
    sendPlayerUpdate();
}

function updateCursorItem() {
    if (!cursorItemEl) return;
    if (cursorItem) {
        const img = cursorItemEl.querySelector("img");
        const count = cursorItemEl.querySelector(".count");
        img.src = getItemTexturePath(cursorItem.id);
        img.alt = cursorItem.id;
        count.textContent = cursorItem.count > 1 ? cursorItem.count : "";
        cursorItemEl.style.display = "block";
    } else {
        cursorItemEl.style.display = "none";
    }
}

function renderInventory() {
    if (!inventoryEl) return;
    slotElements.forEach((el, idx) => {
        el.innerHTML = "";

        const item = playerInventory[idx];
        if (item) {
            const itemImg = document.createElement("img");
            itemImg.src = getItemTexturePath(item.id);
            itemImg.alt = item.id;
            itemImg.draggable = false;
            el.appendChild(itemImg);
            if (item.count > 1) {
                const countEl = document.createElement("span");
                countEl.className = "count";
                countEl.textContent = item.count;
                el.appendChild(countEl);
            }
        }
    });
}

function showItemTooltip(index, slotEl) {
    const item = playerInventory[index];
    if (!item || !tooltipEl) return;
    tooltipEl.textContent = item.id.split("_").join(" ");
    tooltipEl.style.display = "block";
    const rect = slotEl.getBoundingClientRect();
    let left = rect.left / scaleX;
    let top = rect.top / scaleY - (tooltipEl.offsetHeight / scaleY) - 4;
    if (top < 0) {
        top = rect.bottom / scaleY + 4;
    }
    const maxLeft = GAME_W - tooltipEl.offsetWidth;
    left = Math.max(0, Math.min(left, maxLeft));
    tooltipEl.style.left = `${left}px`;
    tooltipEl.style.top = `${top}px`;
}

function hideItemTooltip() {
    if (tooltipEl) tooltipEl.style.display = "none";
}

function createInventoryUI() {
    document.documentElement.style.setProperty('--inv-scale', INVENTORY_SCALE);
    document.documentElement.style.setProperty('--inv-text-scale', INVENTORY_TEXT_SCALE);

    inventoryEl = document.createElement("div");
    inventoryEl.id = "inventory";
    inventoryEl.style.gridTemplateColumns = `repeat(${INVENTORY_COLS}, calc(18px * ${INVENTORY_SCALE}))`;
    inventoryEl.style.display = inventoryVisible ? "grid" : "none";

    cursorItemEl = document.createElement("div");
    cursorItemEl.id = "cursor-item";
    cursorItemEl.style.display = "none";
    const cursorImg = document.createElement("img");
    const cursorCount = document.createElement("span");
    cursorCount.className = "count";
    cursorItemEl.appendChild(cursorImg);
    cursorItemEl.appendChild(cursorCount);
    appEl.appendChild(cursorItemEl);

    tooltipEl = document.createElement("div");
    tooltipEl.id = "item-tooltip";
    tooltipEl.style.display = "none";
    appEl.appendChild(tooltipEl);

    for (let i = 0; i < INVENTORY_SIZE; i++) {
        const slot = document.createElement("div");
        slot.className = "slot";
        slot.dataset.index = i.toString();

        slot.addEventListener("mouseenter", () => showItemTooltip(i, slot));
        slot.addEventListener("mouseleave", hideItemTooltip);

        slot.addEventListener("mousedown", (e) => {
            e.preventDefault();
            const index = parseInt(slot.dataset.index, 10);
            if (e.button === 0) {
                if (cursorItem) {
                    placeOnSlot(index);
                } else {
                    grabFromSlot(index);
                }
            } else if (e.button === 2) {
                grabHalfFromSlot(index);
            }
            if (cursorItemEl) {
                cursorItemEl.style.left = `${e.clientX / scaleX}px`;
                cursorItemEl.style.top = `${e.clientY / scaleY}px`;
            }
        });

        inventoryEl.appendChild(slot);
        slotElements.push(slot);
    }

    document.addEventListener("mousemove", (e) => {
        if (cursorItemEl) {
            cursorItemEl.style.left = `${e.clientX / scaleX}px`;
            cursorItemEl.style.top = `${e.clientY / scaleY}px`;
        }
    });

    appEl.appendChild(inventoryEl);
    renderInventory();
}

function getMovementState() {
    let vx = 0;
    let vy = 0;

    if (keys["a"]) vx -= 1;
    if (keys["d"]) vx += 1;
    if (keys["w"]) vy -= 1;
    if (keys["s"]) vy += 1;

    if (vx === 0 && vy === 0) return { vx: 0, vy: 0, direction: "idle" };

    let moveDirection;
    if (vy < 0) moveDirection = "forward";
    else if (vy > 0) moveDirection = "backward";
    else if (vx < 0) moveDirection = "left";
    else moveDirection = "right";

    return { vx, vy, direction: moveDirection };
}

function nextAnimFrame(name, current) {
    const total = getCharacterFrames(characterPath)[name];
    if (!total || total <= 1) return 0;
    const next = current + 1;
    return next < total ? next : 0;
}

function getFacingDirection() {
    return direction === "idle" ? lastDirection : direction;
}

function getCurrentSpriteName() {
    if (using) return `${getFacingDirection()}use`;
    return direction === "idle" ? `idle${lastDirection}` : direction;
}

function treeKey(origin) {
    return `${origin.col},${origin.row}`;
}

function refreshRemovedTiles() {
    for (const [key, entry] of [...tileElements]) {
        const [colStr, rowStr] = key.split(",");
        const col = parseInt(colStr, 10);
        const row = parseInt(rowStr, 10);
        const origin = getTreeAt(col, row, seed, regionSize, treeRegionSize);
        if (origin && removedTrees.has(treeKey(origin))) {
            if (entry.base) entry.base.remove();
            if (entry.overlay) entry.overlay.remove();
            tileElements.delete(key);
            ensureTile(col, row);
        }
    }
}

function treeAtPlayer() {
    const px = Math.floor(playerWorldX / tileWidth);
    const py = Math.floor(playerWorldY / tileWidth);
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            const origin = getTreeAt(px + dx, py + dy, seed, regionSize, treeRegionSize);
            if (origin && !removedTrees.has(treeKey(origin))) {
                return origin;
            }
        }
    }
    return null;
}

function sendRemoveTree(key) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ operation: "remove_tree", tree: key }));
}

function chopTree(origin, key) {
    removedTrees.add(key);
    refreshRemovedTiles();
    scatterDrop(CHOP_REWARD, CHOP_REWARD_COUNT, origin.col, origin.row);
    sendRemoveTree(key);
}

function applyUseEffect() {
    const origin = treeAtPlayer();
    if (!origin) return;
    const key = treeKey(origin);
    const count = (treeUseCounts.get(key) || 0) + 1;
    treeUseCounts.set(key, count);
    if (count >= CHOP_USES_REQUIRED) {
        treeUseCounts.delete(key);
        chopTree(origin, key);
    }
}

function groundItemPixelSize() {
    return Math.round(GROUND_ITEM_BASE_SIZE * GROUND_ITEM_SCALE);
}

function hashString(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
        h = (h * 31 + str.charCodeAt(i)) | 0;
    }
    return h;
}

function renderGroundItems() {
    const seen = new Set();
    const size = groundItemPixelSize();
    for (const item of groundItems) {
        if (pendingPickups.has(item.id)) {
            seen.add(item.id);
            const el = groundItemEls.get(item.id);
            if (el) el.style.display = "none";
            continue;
        }
        seen.add(item.id);
        let el = groundItemEls.get(item.id);
        if (!el) {
            el = document.createElement("img");
            el.className = "ground-item";
            el.draggable = false;
            el.style.position = "absolute";
            el.style.zIndex = "1";
            el.style.pointerEvents = "none";
            worldEl.appendChild(el);
            groundItemEls.set(item.id, el);
        }
        el.style.display = "block";
        el.src = getItemTexturePath(item.item);
        el.style.width = `${size}px`;
        el.style.height = `${size}px`;
    }
    for (const [id, el] of groundItemEls) {
        if (!seen.has(id)) {
            el.remove();
            groundItemEls.delete(id);
        }
    }
    updateGroundItemAnimation();
}

function updateGroundItemAnimation() {
    const size = groundItemPixelSize();
    const now = Date.now();
    for (const item of groundItems) {
        const el = groundItemEls.get(item.id);
        if (!el) continue;
        const phase = (hashString(item.id) % 628) / 100;
        const bob = Math.sin(now / 600 + phase) * GROUND_ITEM_BOB_AMPLITUDE;
        el.style.left = `${Math.round(item.x - size / 2)}px`;
        el.style.top = `${Math.round(item.y - size / 2 + bob)}px`;
    }
}

function syncGroundItems(list) {
    groundItems = Array.isArray(list) ? list : [];
    const present = new Set(groundItems.map((g) => g.id));
    for (const id of [...pendingPickups]) {
        if (!present.has(id)) {
            pendingPickups.delete(id);
        }
    }
    renderGroundItems();
}

function dropItemToGround(itemId, count, x, y) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ operation: "drop_item", data: { item: itemId, count, x, y } }));
}

function sendPickupGroundItem(id) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ operation: "pickup_item", id }));
}

function scatterDrop(itemId, totalCount, baseCol, baseRow) {
    const offsets = [[0, 0], [0, 1], [-1, 0], [1, 0]];
    for (let i = 0; i < totalCount; i++) {
        const [dx, dy] = offsets[i % offsets.length];
        dropItemToGround(
            itemId,
            1,
            (baseCol + dx) * tileWidth + tileWidth / 2,
            (baseRow + dy) * tileWidth + tileWidth / 2
        );
    }
}

function checkGroundPickup() {
    const size = groundItemPixelSize();
    const half = size / 2;
    const playerLeft = playerWorldX;
    const playerTop = playerWorldY;
    const playerRight = playerWorldX + tileWidth;
    const playerBottom = playerWorldY + tileWidth;
    let picked = false;
    for (const item of [...groundItems]) {
        if (pendingPickups.has(item.id)) continue;
        const itemLeft = item.x - half;
        const itemTop = item.y - half;
        const itemRight = item.x + half;
        const itemBottom = item.y + half;
        if (playerRight > itemLeft && playerLeft < itemRight && playerBottom > itemTop && playerTop < itemBottom) {
            addItem(item.item, item.count);
            pendingPickups.add(item.id);
            sendPickupGroundItem(item.id);
            groundItems = groundItems.filter((g) => g.id !== item.id);
            picked = true;
        }
    }
    if (picked) renderGroundItems();
}

function dropCursorItem() {
    if (!cursorItem) return;
    const facing = getFacingDirection();
    const offsets = { forward: [0, -1], backward: [0, 1], left: [-1, 0], right: [1, 0] };
    const [dx, dy] = offsets[facing] || [0, 1];
    const cx = playerWorldX + tileWidth / 2;
    const cy = playerWorldY + tileWidth / 2;
    dropItemToGround(cursorItem.id, cursorItem.count, cx + dx * DROP_DISTANCE, cy + dy * DROP_DISTANCE);
    cursorItem = null;
    updateCursorItem();
}

function startUse() {
    using = true;
    useTimer = useDuration;
    animFrame = 0;
    animTimer = 0;
    applyUseEffect();
}

function updatePlayerSprite() {
    const spriteName = getCurrentSpriteName();
    const src = `${characterPath}/${spriteName}${animFrame}.png`;
    if (playerEl.dataset.src !== src) {
        playerEl.dataset.src = src;
        playerEl.style.backgroundImage = `url(${spriteBackground(src)})`;
    }
    const left = Math.round(GAME_W / 2 - tileWidth / 2);
    const top = Math.round(GAME_H / 2 - tileWidth / 2);
    if (playerEl.dataset.left !== String(left)) {
        playerEl.dataset.left = String(left);
        playerEl.style.left = `${left}px`;
    }
    if (playerEl.dataset.top !== String(top)) {
        playerEl.dataset.top = String(top);
        playerEl.style.top = `${top}px`;
    }
}

function normalizeRemoteState(entity) {
    if (!entity || typeof entity !== "object") {
        return { position: { x: 0, y: 0 }, animation: "idlebackward", character: characterPath };
    }
    const position = entity.position || { x: 0, y: 0 };
    return {
        position: { x: Number(position.x) || 0, y: Number(position.y) || 0 },
        animation: entity.animation || "idlebackward",
        character: entity.character || characterPath,
    };
}

function updateRemotePlayers(players) {
    const knownIds = new Set();

    for (const [playerId, payload] of Object.entries(players || {})) {
        if (playerId === localPlayerId) continue;
        knownIds.add(playerId);

        const state = normalizeRemoteState(payload);
        if (!remotePlayers.has(playerId)) createRemotePlayer(playerId);

        const remoteChar = state.character || characterPath;
        ensureRemoteCharacter(remoteChar);

        const rawAnimation = state.animation || "idlebackward";
        const frames = getCharacterFrames(remoteChar);
        const animation = frames[rawAnimation] ? rawAnimation : "idlebackward";
        const target = remoteTargets.get(playerId);
        if (target && target.animation === animation && target.character === remoteChar) {
            target.tx = state.position.x;
            target.ty = state.position.y;
        } else {
            remoteTargets.set(playerId, {
                tx: state.position.x,
                ty: state.position.y,
                x: state.position.x,
                y: state.position.y,
                animation,
                character: remoteChar,
            });
            remoteAnim.set(playerId, { frame: 0, timer: 0 });
        }
    }

    for (const [playerId, player] of remotePlayers) {
        if (!knownIds.has(playerId)) {
            player.remove();
            remotePlayers.delete(playerId);
            remoteTargets.delete(playerId);
            remoteAnim.delete(playerId);
        }
    }
}

function updateRemotePlayersRender(dt) {
    for (const [playerId, target] of remoteTargets) {
        const anim = remoteAnim.get(playerId);
        if (!anim) continue;

        const dx = target.tx - target.x;
        const dy = target.ty - target.y;
        const dist = Math.hypot(dx, dy);
        if (dist > 0.5) {
            const step = Math.min(dist, moveSpeed * dt);
            target.x += (dx / dist) * step;
            target.y += (dy / dist) * step;
        } else {
            target.x = target.tx;
            target.y = target.ty;
        }

        if (target.animation && target.animation !== "idle" && !target.animation.startsWith("idle")) {
            anim.timer += dt * 1000;
            if (anim.timer >= animInterval) {
                anim.timer = 0;
                const total = getCharacterFrames(target.character)[target.animation] || 1;
                anim.frame = (anim.frame + 1) % (total || 1);
            }
        } else {
            anim.frame = 0;
            anim.timer = 0;
        }

        const player = remotePlayers.get(playerId);
        if (!player) continue;
        const totalFrames = getCharacterFrames(target.character)[target.animation] || 1;
        const frame = anim.frame % (totalFrames || 1);
        const spritePath = `${target.character}/${target.animation}${frame}.png`;
        const left = Math.round((target.x - Math.round(cameraX)) * scaleX) / scaleX;
        const top = Math.round((target.y - Math.round(cameraY)) * scaleY) / scaleY;

        if (player.dataset.src !== spritePath) {
            player.dataset.src = spritePath;
            player.style.backgroundImage = `url(${spriteBackground(spritePath)})`;
        }
        if (player.dataset.left !== String(left)) {
            player.dataset.left = String(left);
            player.style.left = `${left}px`;
        }
        if (player.dataset.top !== String(top)) {
            player.dataset.top = String(top);
            player.style.top = `${top}px`;
        }
    }
}

function updateCoords() {
    const x = Math.floor(playerWorldX / tileWidth);
    const y = Math.floor(playerWorldY / tileWidth);
    coordEl.textContent = `x: ${x}  y: ${y}`;
}

function syncRemovedTrees(list) {
    if (!Array.isArray(list)) return;
    removedTrees.clear();
    list.forEach((key) => removedTrees.add(String(key)));
    refreshRemovedTiles();
}

function getPlayerSnapshot() {
    const spriteName = getCurrentSpriteName();
    return {
        character: characterPath,
        position: { x: playerWorldX, y: playerWorldY },
        inventory: playerInventory.map((slot) => (slot ? { id: slot.id, count: slot.count } : null)),
        animation: spriteName,
    };
}

function sendPlayerUpdate() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const snapshot = getPlayerSnapshot();
    const payload = JSON.stringify({ operation: "update", data: snapshot });
    if (payload === lastSentSnapshot) return;

    ws.send(payload);
    lastSentSnapshot = payload;
}

async function handleServerMessage(event) {
    const message = JSON.parse(event.data);

    if (message.type === "welcome") {
        localPlayerId = message.player_id;
        seed = Array.isArray(message.seed) ? message.seed : [];
        syncRemovedTrees(message.removed_trees);
        syncGroundItems(message.ground_items);
        if (message.players) {
            const localData = message.players[localPlayerId];
            if (localData) {
                if (localData.character) {
                    await setCharacterPath(localData.character);
                }
                if (localData.position) {
                    playerWorldX = localData.position.x;
                    playerWorldY = localData.position.y;
                }
            }
            updateRemotePlayers(message.players);
        }
        if (seed.length) updateCamera();
        return;
    }

    if (message.type === "state") {
        if (Array.isArray(message.seed)) {
            seed = message.seed;
            if (seed.length) updateVisibleTiles();
        }
        syncRemovedTrees(message.removed_trees);
        syncGroundItems(message.ground_items);
        if (message.players) {
            const localData = message.players[localPlayerId];
            if (localData && localData.character) {
                await setCharacterPath(localData.character);
            }
            updateRemotePlayers(message.players);
        }
    }
}

function fetchLocalPlayerData() {
    return fetch(`/api/player-data?server=${encodeURIComponent(serverId)}`)
        .then((response) => response.json())
        .then((data) => {
            const localData = data.data || {};
            if (Array.isArray(localData.inventory)) {
                playerInventory = localData.inventory.slice(0, INVENTORY_SIZE).map(normalizeInventorySlot);
                while (playerInventory.length < INVENTORY_SIZE) {
                    playerInventory.push(null);
                }
            } else {
                playerInventory = Array(INVENTORY_SIZE).fill(null);
            }
            renderInventory();
            if (localData.position) {
                playerWorldX = Number(localData.position.x) || 0;
                playerWorldY = Number(localData.position.y) || 0;
            }
            if (localData.character) {
                return setCharacterPath(localData.character);
            }
        })
        .catch(() => {});
}

function connectToServer() {
    return fetch(`/api/ws-token?server=${encodeURIComponent(serverId)}`)
        .then((response) => response.json())
        .then((data) => {
            const protocol = window.location.protocol === "https:" ? "wss" : "ws";
            ws = new WebSocket(`${protocol}://${window.location.host}/ws?server=${encodeURIComponent(serverId)}`);

            return new Promise((resolve, reject) => {
                ws.onopen = () => ws.send(JSON.stringify({ token: data.token }));
                ws.onmessage = async (event) => {
                    const message = JSON.parse(event.data);
                    if (message.type === "welcome") {
                        await handleServerMessage(event);
                        resolve();
                        return;
                    }
                    await handleServerMessage(event);
                };
                ws.onerror = () => reject(new Error("WebSocket connection failed."));
                ws.onclose = () => { ws = null; };
            });
        });
}

function applyCanvasTransform() {
    if (!appEl) return;
    const newW = Math.max(1, Math.round(window.innerWidth));
    const newH = Math.max(1, Math.round(window.innerHeight));
    if (GAME_W === 0 || newW !== GAME_W || newH !== GAME_H) {
        GAME_W = newW;
        GAME_H = newH;
        appEl.style.width = `${GAME_W}px`;
        appEl.style.height = `${GAME_H}px`;
        if (viewportEl) {
            viewportEl.style.width = `${GAME_W}px`;
            viewportEl.style.height = `${GAME_H}px`;
        }
    }

    // The game is pure CSS pixels; do not apply any transform scale.
    // Re-writing a scale() on the container every frame forces mobile
    // browsers to re-resolve the containing block of every fixed-position
    // child each frame, which makes all players flicker.
    scaleX = 1;
    scaleY = 1;
    if (appEl.style.transform) appEl.style.transform = "";
}

function gameLoop(time) {
    const dt = lastTime ? (time - lastTime) / 1000 : 0;
    lastTime = time;

    if (!document.hasFocus()) clearMovementKeys();

    applyCanvasTransform();

    const movement = getMovementState();
    const newDirection = movement.direction;
    if (newDirection !== direction) {
        if (direction !== "idle") lastDirection = direction;
        direction = newDirection;
        animFrame = 0;
        animTimer = 0;
    }

    const currentAnim = getCurrentSpriteName();

    if (movement.vx !== 0 || movement.vy !== 0) {
        const len = Math.hypot(movement.vx, movement.vy);
        const speed = moveSpeed / len;
        playerWorldX += movement.vx * speed * dt;
        playerWorldY += movement.vy * speed * dt;
    }

    if (using) {
        useTimer -= dt * 1000;
        if (useTimer <= 0) {
            using = false;
            useCooldownTimer = useCooldown;
        }
    }
    if (useCooldownTimer > 0) {
        useCooldownTimer = Math.max(0, useCooldownTimer - dt * 1000);
    }
    if (keys["f"] && !using && useCooldownTimer <= 0) {
        startUse();
    }

    if (!using) {
        animTimer += dt * 1000;
        if (animTimer >= animInterval) {
            animTimer = 0;
            animFrame = nextAnimFrame(currentAnim, animFrame);
        }
    }

    checkGroundPickup();
    updateGroundItemAnimation();
    updatePlayerSprite();
    updateCamera();
    updateRemotePlayersRender(dt);
    updateCoords();
    sendPlayerUpdate();
    requestAnimationFrame(gameLoop);
}

window.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    const key = e.key.toLowerCase();
    keys[key] = true;

    if ((e.ctrlKey || e.metaKey) && ["+", "-", "=", "0"].includes(e.key)) {
        e.preventDefault();
    }

    if (key === "e") {
        inventoryVisible = !inventoryVisible;
        if (inventoryEl) {
            inventoryEl.style.display = inventoryVisible ? "grid" : "none";
        }
    } else if (key === "f") {
        if (!using && useCooldownTimer <= 0) {
            startUse();
        }
    }
});

window.addEventListener("keyup", (e) => {
    keys[e.key.toLowerCase()] = false;
});

window.addEventListener("wheel", (e) => {
    if (e.ctrlKey || e.metaKey) e.preventDefault();
}, { passive: false });

function clearMovementKeys() {
    keys["a"] = false;
    keys["d"] = false;
    keys["w"] = false;
    keys["s"] = false;
    keys["f"] = false;
}

window.addEventListener("blur", clearMovementKeys);
document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearMovementKeys();
});
window.addEventListener("mouseleave", () => {
    if (!document.hasFocus()) clearMovementKeys();
});

window.addEventListener("mousedown", (e) => {
    if (e.button === 0) {
        if (cursorItem && inventoryEl && !inventoryEl.contains(e.target) && e.target !== cursorItemEl) {
            dropCursorItem();
        }
        e.preventDefault();
    }
});

window.addEventListener("dragstart", (e) => e.preventDefault());
window.addEventListener("contextmenu", (e) => e.preventDefault());
window.addEventListener("selectstart", (e) => e.preventDefault());
window.addEventListener("gesturestart", (e) => e.preventDefault());
window.addEventListener("gesturechange", (e) => e.preventDefault());

window.addEventListener("resize", () => {
    applyCanvasTransform();
    if (playerEl) updatePlayerSprite();
    updateCamera();
});

function createJoystick() {
    joystickEl = document.createElement("div");
    joystickEl.id = "joystick";

    const base = document.createElement("div");
    base.className = "joystick-base";

    joystickKnobEl = document.createElement("div");
    joystickKnobEl.className = "joystick-knob";

    base.appendChild(joystickKnobEl);
    joystickEl.appendChild(base);
    document.body.appendChild(joystickEl);

    joystickEl.addEventListener("touchstart", (e) => {
        e.preventDefault();
        const rect = joystickEl.getBoundingClientRect();
        joystickCenterX = rect.left + rect.width / 2;
        joystickCenterY = rect.top + rect.height / 2;
        const touch = e.changedTouches[0];
        joystickTouchId = touch.identifier;
        updateJoystick(touch);
    }, { passive: false });

    window.addEventListener("touchmove", (e) => {
        for (const touch of e.changedTouches) {
            if (touch.identifier === joystickTouchId) {
                e.preventDefault();
                updateJoystick(touch);
                break;
            }
        }
    }, { passive: false });

    const releaseJoystick = () => {
        if (joystickTouchId === null) return;
        joystickTouchId = null;
        keys["w"] = false;
        keys["s"] = false;
        keys["a"] = false;
        keys["d"] = false;
        if (joystickKnobEl) joystickKnobEl.style.transform = "translate(0px, 0px)";
    };

    window.addEventListener("touchend", (e) => {
        for (const touch of e.changedTouches) {
            if (touch.identifier === joystickTouchId) {
                releaseJoystick();
                break;
            }
        }
    }, { passive: false });

    window.addEventListener("touchcancel", releaseJoystick, { passive: false });
}

function updateJoystick(touch) {
    let dx = touch.clientX - joystickCenterX;
    let dy = touch.clientY - joystickCenterY;
    const dist = Math.hypot(dx, dy);
    if (dist > JOYSTICK_RADIUS) {
        dx = (dx / dist) * JOYSTICK_RADIUS;
        dy = (dy / dist) * JOYSTICK_RADIUS;
    }
    joystickKnobEl.style.transform = `translate(${dx}px, ${dy}px)`;

    if (Math.hypot(dx, dy) < JOYSTICK_DEADZONE) {
        keys["w"] = false;
        keys["s"] = false;
        keys["a"] = false;
        keys["d"] = false;
        return;
    }

    const mag = Math.max(Math.abs(dx), Math.abs(dy));
    keys["w"] = dy < 0 && Math.abs(dy) >= mag * 0.5;
    keys["s"] = dy > 0 && Math.abs(dy) >= mag * 0.5;
    keys["a"] = dx < 0 && Math.abs(dx) >= mag * 0.5;
    keys["d"] = dx > 0 && Math.abs(dx) >= mag * 0.5;
}

function startGame() {
    if (initStarted) return;
    initStarted = true;
    const startEl = document.getElementById("mobile-start");
    if (startEl) startEl.hidden = true;
    init();
}

async function init() {
    GAME_W = window.innerWidth;
    GAME_H = window.innerHeight;
    if (isTouchDevice) {
        createJoystick();
    }

    appEl = document.createElement("div");
    appEl.id = "app";
    appEl.style.width = `${GAME_W}px`;
    appEl.style.height = `${GAME_H}px`;
    appEl.style.position = "fixed";
    appEl.style.top = "0";
    appEl.style.left = "0";
    appEl.style.transformOrigin = "0 0";
    appEl.style.background = "#000";
    appEl.style.overflow = "hidden";
    document.body.appendChild(appEl);

    viewportEl = document.createElement("div");
    viewportEl.id = "viewport";
    viewportEl.style.width = `${GAME_W}px`;
    viewportEl.style.height = `${GAME_H}px`;
    appEl.appendChild(viewportEl);

    worldEl = document.createElement("div");
    worldEl.id = "world";
    viewportEl.appendChild(worldEl);

    createHud();
    createInventoryUI();
    await fetchLocalPlayerData();
    await connectToServer();
    await discoverFrames(characterPath);
    await preloadSprites(characterPath);
    preloadTiles();
    await loadTileColors();
    createPlayer();
    applyCanvasTransform();
    updateCamera();
    requestAnimationFrame(gameLoop);
}

if (!isTouchDevice || !document.getElementById("mobile-start")) {
    startGame();
}