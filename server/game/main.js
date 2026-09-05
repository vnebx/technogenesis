import { CONFIG, state } from "./state.js";
import { loadSettings, applySettings } from "./settings.js";
import {
    discoverFrames,
    preloadSprites,
    preloadTiles,
    preloadAllAssets,
    loadTileColors,
    getCurrentSpriteName,
    spriteBackground,
    nextAnimFrame,
    preloadImage,
} from "./sprites.js";
import { updateCamera, screenCenterPlayerLeft, screenCenterPlayerTop } from "./tiles.js";
import { createInventoryUI, toggleInventory } from "./inventory.js";
import { checkGroundPickup, updateGroundItemAnimation, dropCursorItem } from "./grounditems.js";
import { updateRemotePlayersRender } from "./remote.js";
import { getMovementState, clearMovementKeys } from "./input.js";
import { connectToServer, fetchLocalPlayerData, sendPlayerUpdate } from "./net.js";
import { startUse } from "./gameplay.js";
import { isTouchDevice, createJoystick, createMobileButtons, createSettingsMenu, initMobileViewport } from "./mobile.js";

const urlParams = new URLSearchParams(window.location.search);
const serverId = urlParams.get("server") || "";

if (!serverId) {
    window.location.href = "/";
}

const settings = loadSettings();

applySettings(settings);

function createPlayer() {
    state.playerEl = document.createElement("div");
    state.playerEl.id = "player";
    state.playerEl.style.width = `${CONFIG.tileWidth}px`;
    state.playerEl.style.height = `${CONFIG.tileWidth}px`;
    state.playerEl.style.position = "absolute";
    state.playerEl.style.top = "0";
    state.playerEl.style.left = "0";
    state.playerEl.style.zIndex = "10";
    state.playerEl.style.pointerEvents = "none";

    const img = document.createElement("img");
    img.style.display = "block";
    img.style.width = `${CONFIG.tileWidth}px`;
    img.style.height = `${CONFIG.tileWidth}px`;
    img.style.imageRendering = "pixelated";
    img.style.pointerEvents = "none";
    state.playerEl.appendChild(img);
    state.playerImgEl = img;

    state.viewportEl.appendChild(state.playerEl);
}

function createHud() {
    state.coordEl = document.createElement("div");
    state.coordEl.id = "coords";
    state.appEl.appendChild(state.coordEl);
    updateCoords();
}

// TEMPORARY debug control: a simple linear zoom slider. Moving it rescales the
// world so more of the map is visible. It runs from 100% (normal) down through
// 0% and all the way to -200% (negative zoom mirrors the world, like a flipped
// map, and keeps "zooming out" linearly past zero). Below ~30% it switches to
// coarse-block rendering (one element per NxN tiles) so the node count stays
// bounded at any depth. Overlays (inventory, buttons) stay put.
function createZoomSlider() {
    const wrap = document.createElement("div");
    wrap.style.cssText =
        "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:900;" +
        "background:rgba(0,0,0,0.55);padding:6px 10px;border-radius:6px;" +
        "display:flex;align-items:center;gap:8px;";

    const label = document.createElement("span");
    label.textContent = "Zoom";
    label.style.cssText = "color:#fff;font-family:'Silkscreen',monospace;font-size:12px;";

    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "-2";
    slider.max = "1";
    slider.step = "0.01";
    slider.value = "1";
    slider.style.cssText = "width:140px;accent-color:#79c0ff;";

    const value = document.createElement("span");
    value.style.cssText = "color:#fff;font-family:'Silkscreen',monospace;font-size:12px;min-width:52px;text-align:right;";
    value.textContent = "100%";

    slider.addEventListener("input", () => {
        state.zoom = parseFloat(slider.value);
        value.textContent = `${Math.round(state.zoom * 100)}%`;
        applyCanvasTransform();
        updateCamera();
    });

    wrap.appendChild(label);
    wrap.appendChild(slider);
    wrap.appendChild(value);
    document.body.appendChild(wrap);
}

function updateCoords() {
    const x = Math.floor(state.playerWorldX / CONFIG.tileWidth);
    const y = Math.floor(state.playerWorldY / CONFIG.tileWidth);
    const text = `x: ${x}  y: ${y}`;
    if (state.coordEl.textContent !== text) {
        state.coordEl.textContent = text;
    }
}

function updatePlayerSprite() {
    const spriteName = getCurrentSpriteName();
    const src = `${state.characterPath}/${spriteName}${state.animFrame}.png`;

    if (state.playerImgEl && state.drawnPlayerSrc !== src) {
        state.drawnPlayerSrc = src;
        state.playerImgEl.src = src;
    }

    const left = screenCenterPlayerLeft();
    const top = screenCenterPlayerTop();
    if (state.playerEl.dataset.left !== String(left)) {
        state.playerEl.dataset.left = String(left);
        state.playerEl.style.left = `${left}px`;
    }
    if (state.playerEl.dataset.top !== String(top)) {
        state.playerEl.dataset.top = String(top);
        state.playerEl.style.top = `${top}px`;
    }
}

function applyCanvasTransform() {
    if (!state.appEl) return;
    const { w: newW, h: newH } = getViewportSize();

    // Zooming the browser below 100% reveals more of the world than a player
    // should be able to see. The devicePixelRatio compared against the value
    // captured at startup tells us the current zoom. When zoomed out we keep the
    // logical (100%) viewport size constant and counter-scale the app so the
    // visible world is identical no matter how far out the user zooms.
    const baseline = state.baselineDPR || window.devicePixelRatio || 1;
    const zoom = window.devicePixelRatio / baseline;
    const zoomedOut = baseline > 0 && zoom > 0 && zoom < 1;

    // Temporary debug zoom (-2..1): the world is laid out at a larger logical
    // size and the viewport is scaled down about its top-left corner, so more
    // tiles are visible while every overlay stays full-size. Negative zoom uses
    // its absolute value for the layout size and mirrors the viewport with a
    // translate so the world keeps filling the screen (flipped like a mirror).
    // The slider is linear: 100% = 1, 0% = the zoom-out floor, -200% = -2.
    const viewScale = state.zoom ?? 1;
    const ms = Math.max(0.002, Math.abs(viewScale));

    let gw = newW;
    let gh = newH;
    if (zoomedOut) {
        // innerWidth grows as the browser zooms out; multiplying by zoom cancels
        // that growth so the logical viewport stays at the 100% equivalent size.
        gw = Math.max(1, Math.round(newW * zoom));
        gh = Math.max(1, Math.round(newH * zoom));
    }
    // Zoom out further on top of the (possibly browser-adjusted) base size.
    gw = Math.max(1, Math.round(gw / ms));
    gh = Math.max(1, Math.round(gh / ms));

    if (state.GAME_W === 0 || gw !== state.GAME_W || gh !== state.GAME_H) {
        state.GAME_W = gw;
        state.GAME_H = gh;
        state.appEl.style.width = `${state.GAME_W}px`;
        state.appEl.style.height = `${state.GAME_H}px`;
        if (state.viewportEl) {
            state.viewportEl.style.width = `${state.GAME_W}px`;
            state.viewportEl.style.height = `${state.GAME_H}px`;
        }
    }

    const appTransform = zoomedOut ? `scale(${1 / zoom})` : "";
    if (state.lastAppTransform !== appTransform) {
        state.lastAppTransform = appTransform;
        state.appEl.style.transformOrigin = "0 0";
        state.appEl.style.transform = appTransform;
    }

    // The viewport holds the world and the player; scaling it about the top-left
    // lets the zoomed-out world fill the screen while HUD/inventory stay crisp.
    let viewTransform = "";
    if (viewScale < 0) {
        // Mirrored: scale by the magnitude, then flip about the screen's middle
        // so the world's left edge lands at the right side of the screen and the
        // whole map still fills it, exactly like a mirror image.
        viewTransform = `translate(${Math.round(gw * ms)}px,0) scale(${-ms}, ${ms})`;
    } else if (ms !== 1) {
        viewTransform = `scale(${ms})`;
    }
    if (state.viewportEl && state.lastViewTransform !== viewTransform) {
        state.lastViewTransform = viewTransform;
        state.viewportEl.style.transformOrigin = "0 0";
        state.viewportEl.style.transform = viewTransform;
    }

    state.scaleX = 1;
    state.scaleY = 1;
}

function gameLoop(time) {
    const rawDt = state.lastTime ? (time - state.lastTime) / 1000 : 0;
    const dt = Math.min(rawDt, 0.05);
    state.lastTime = time;

    applyCanvasTransform();

    const movement = getMovementState();
    const newDirection = movement.direction;
    if (newDirection !== state.direction) {
        if (state.direction !== "idle") state.lastDirection = state.direction;
        const wasMoving = state.direction !== "idle";
        const isMoving = newDirection !== "idle";
        state.direction = newDirection;
        if (wasMoving !== isMoving) {
            state.animFrame = 0;
            state.animTimer = 0;
        }
    }

    const currentAnim = getCurrentSpriteName();

    if (movement.vx !== 0 || movement.vy !== 0) {
        const len = Math.hypot(movement.vx, movement.vy);
        const speed = CONFIG.moveSpeed / len;
        state.playerWorldX += movement.vx * speed * dt;
        state.playerWorldY += movement.vy * speed * dt;
    }

    if (state.using) {
        state.useTimer -= dt * 1000;
        if (state.useTimer <= 0) {
            state.using = false;
            state.useCooldownTimer = CONFIG.useCooldown;
        }
    }
    if (state.useCooldownTimer > 0) {
        state.useCooldownTimer = Math.max(0, state.useCooldownTimer - dt * 1000);
    }
    if (state.keys["f"] && !state.using && state.useCooldownTimer <= 0) {
        startUse();
    }

    if (!state.using) {
        state.animTimer += dt * 1000;
        if (state.animTimer >= CONFIG.animInterval) {
            state.animTimer = 0;
            state.animFrame = nextAnimFrame(currentAnim, state.animFrame);
        }
    }

    checkGroundPickup();
    updateGroundItemAnimation();
    updateCamera();
    updatePlayerSprite();
    updateRemotePlayersRender(dt);
    updateCoords();
    sendPlayerUpdate();
    requestAnimationFrame(gameLoop);
}

window.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    const key = e.key.toLowerCase();
    state.keys[key] = true;

    if ((e.ctrlKey || e.metaKey) && ["+", "-", "=", "0"].includes(e.key)) {
        e.preventDefault();
    }

    if (key === "e") {
        toggleInventory();
    } else if (key === "f") {
        if (!state.using && state.useCooldownTimer <= 0) {
            startUse();
        }
    }
});

window.addEventListener("keyup", (e) => {
    state.keys[e.key.toLowerCase()] = false;
});

window.addEventListener("wheel", (e) => {
    if (e.ctrlKey || e.metaKey) e.preventDefault();
}, { passive: false });

window.addEventListener("blur", clearMovementKeys);
document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearMovementKeys();
});
window.addEventListener("mouseleave", () => {
    if (!document.hasFocus()) clearMovementKeys();
});

window.addEventListener("mousedown", (e) => {
    if (e.button === 0) {
        if (state.isTouching) return;
        if (state.cursorItem && state.inventoryEl && !state.inventoryEl.contains(e.target) && e.target !== state.cursorItemEl) {
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
    updateCamera();
    if (state.playerEl) updatePlayerSprite();
});

function getViewportSize() {
    const vv = window.visualViewport;
    return {
        w: Math.max(1, Math.round(vv?.width ?? window.innerWidth)),
        h: Math.max(1, Math.round(vv?.height ?? window.innerHeight)),
    };
}

function setLoadStatus(text) {
    if (!state.loadStatusEl) {
        state.loadStatusEl = document.createElement("div");
        state.loadStatusEl.id = "load-status";
        state.loadStatusEl.style.position = "fixed";
        state.loadStatusEl.style.inset = "0";
        state.loadStatusEl.style.display = "flex";
        state.loadStatusEl.style.alignItems = "center";
        state.loadStatusEl.style.justifyContent = "center";
        state.loadStatusEl.style.color = "#fff";
        state.loadStatusEl.style.fontFamily = "'Silkscreen', monospace";
        state.loadStatusEl.style.fontSize = "14px";
        state.loadStatusEl.style.zIndex = "2000";
        state.loadStatusEl.style.pointerEvents = "none";
        state.loadStatusEl.style.background = "rgba(0, 0, 0, 0.35)";
        document.body.appendChild(state.loadStatusEl);
    }
    state.loadStatusEl.textContent = text || "";
    state.loadStatusEl.style.display = text ? "flex" : "none";
}

function hideLoadStatus() {
    setLoadStatus("");
}

function beginGameLoop() {
    if (state.gameLoopStarted) return;
    state.gameLoopStarted = true;
    requestAnimationFrame(gameLoop);
}

function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`${label} timeout`)), ms);
        }),
    ]);
}

async function connectWithRetry(maxAttempts = 8) {
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        setLoadStatus(attempt === 1 ? "Connecting..." : `Reconnecting (${attempt}/${maxAttempts})...`);
        try {
            await connectToServer(8000);
            return;
        } catch (err) {
            lastError = err;
            if (attempt < maxAttempts) {
                await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
            }
        }
    }
    setLoadStatus("Connection failed. Tap to retry.");
    if (lastError && /another device/i.test(lastError.message)) {
        setLoadStatus("Already connected elsewhere. Close other tab and tap to retry.");
    }
    const retry = () => connectWithRetry();
    document.addEventListener("touchstart", retry, { once: true });
    document.addEventListener("click", retry, { once: true });
    console.error("Failed to connect:", lastError);
}

async function loadGameAssets() {
    try {
        await withTimeout(preloadAllAssets(), 12000, "Asset preload");
        updatePlayerSprite();
        await withTimeout(fetchLocalPlayerData(), 8000, "Player data");
        await withTimeout(loadTileColors(), 8000, "Tile colors");
        updateCamera();
        updatePlayerSprite();
    } catch (err) {
        console.error("Asset load failed:", err);
        updatePlayerSprite();
        updateCamera();
    }
}

function startGame() {
    if (state.initStarted) return;
    state.initStarted = true;
    init().catch((err) => {
        console.error("Game init failed:", err);
        setLoadStatus("Failed to start. Tap to reload.");
        const reload = () => window.location.reload();
        document.addEventListener("touchstart", reload, { once: true });
        document.addEventListener("click", reload, { once: true });
    });
}

async function init() {
    const { w, h } = getViewportSize();
    state.GAME_W = w;
    state.GAME_H = h;
    state.baselineDPR = window.devicePixelRatio || 1;

    if (isTouchDevice()) {
        initMobileViewport();
    }

    state.appEl = document.createElement("div");
    state.appEl.id = "app";
    state.appEl.style.width = `${state.GAME_W}px`;
    state.appEl.style.height = `${state.GAME_H}px`;
    state.appEl.style.position = "fixed";
    state.appEl.style.top = "0";
    state.appEl.style.left = "0";
    state.appEl.style.transformOrigin = "0 0";
    state.appEl.style.background = "#000";
    state.appEl.style.overflow = "hidden";
    state.appEl.style.zIndex = "1";
    document.body.appendChild(state.appEl);

    state.viewportEl = document.createElement("div");
    state.viewportEl.id = "viewport";
    state.viewportEl.style.width = `${state.GAME_W}px`;
    state.viewportEl.style.height = `${state.GAME_H}px`;
    state.appEl.appendChild(state.viewportEl);

    state.worldEl = document.createElement("div");
    state.worldEl.id = "world";
    state.viewportEl.appendChild(state.worldEl);

    createHud();
    createZoomSlider();
    createInventoryUI(settings);
    createPlayer();
    applyCanvasTransform();
    updateCamera();
    updatePlayerSprite();
    beginGameLoop();

    if (isTouchDevice()) {
        createJoystick();
        createMobileButtons();
        createSettingsMenu(settings);
    }

    if (window.visualViewport) {
        window.visualViewport.addEventListener("resize", () => {
            applyCanvasTransform();
            updateCamera();
            if (state.playerEl) updatePlayerSprite();
        });
    }

    setLoadStatus("Loading...");
    state.onGameConnected = hideLoadStatus;

    connectWithRetry();
    loadGameAssets();

    setTimeout(() => {
        if (state.loadStatusEl && state.loadStatusEl.style.display !== "none") {
            hideLoadStatus();
        }
    }, 15000);
}

startGame();
