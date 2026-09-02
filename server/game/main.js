import { CONFIG, state } from "./state.js";
import { loadSettings, applySettings } from "./settings.js";
import {
    discoverFrames,
    preloadSprites,
    preloadTiles,
    loadTileColors,
    getCurrentSpriteName,
    spriteBackground,
    nextAnimFrame,
} from "./sprites.js";
import { updateCamera } from "./tiles.js";
import { createInventoryUI, toggleInventory } from "./inventory.js";
import { checkGroundPickup, updateGroundItemAnimation, dropCursorItem } from "./grounditems.js";
import { updateRemotePlayersRender } from "./remote.js";
import { getMovementState, clearMovementKeys } from "./input.js";
import { connectToServer, fetchLocalPlayerData, sendPlayerUpdate } from "./net.js";
import { startUse } from "./gameplay.js";
import { isTouchDevice, createJoystick, createMobileButtons, createSettingsMenu } from "./mobile.js";

const urlParams = new URLSearchParams(window.location.search);
const serverId = urlParams.get("server") || "";

if (!serverId) {
    window.location.href = "/";
}

const settings = loadSettings();

applySettings(settings);

(() => {
    // Mobile-only entry: browsers require a user gesture before entering fullscreen.
    // Show a start overlay that requests fullscreen, then begins the game once it's active.
    // I may change this for an automtic fullscreen one, but by now it works well
    const startEl = document.getElementById("mobile-start");
    const startBtn = document.getElementById("fullscreen-start");
    if (!isTouchDevice() || !startEl) return;

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
        // If fullscreen isn't supported, just start after a short delay
        if (!el.requestFullscreen && !el.webkitRequestFullscreen) {
            setTimeout(startGame, 120);
            return;
        }
        reqFullscreen();
        // Start on the fullscreenchange event (with a fallback timeout in case it never fires)
        const done = () => startGame();
        document.addEventListener("fullscreenchange", done, { once: true });
        document.addEventListener("webkitfullscreenchange", done, { once: true });
        setTimeout(done, 900);
    });
})();

function createPlayer() {
    state.playerEl = document.createElement("div");
    state.playerEl.style.width = `${CONFIG.tileWidth}px`;
    state.playerEl.style.height = `${CONFIG.tileWidth}px`;
    state.playerEl.style.position = "fixed";
    state.playerEl.style.top = "0";
    state.playerEl.style.left = "0";
    state.playerEl.style.backgroundSize = "contain";
    state.playerEl.style.backgroundPosition = "center";
    state.playerEl.style.backgroundRepeat = "no-repeat";
    state.playerEl.style.zIndex = "10";
    state.viewportEl.appendChild(state.playerEl);
    updatePlayerSprite();
}

function createHud() {
    state.coordEl = document.createElement("div");
    state.coordEl.id = "coords";
    state.appEl.appendChild(state.coordEl);
    updateCoords();
}

function updateCoords() {
    const x = Math.floor(state.playerWorldX / CONFIG.tileWidth);
    const y = Math.floor(state.playerWorldY / CONFIG.tileWidth);
    state.coordEl.textContent = `x: ${x}  y: ${y}`;
}

function updatePlayerSprite() {
    const spriteName = getCurrentSpriteName();
    const src = `${state.characterPath}/${spriteName}${state.animFrame}.png`;
    if (state.playerEl.dataset.src !== src) {
        state.playerEl.dataset.src = src;
        state.playerEl.style.backgroundImage = `url(${spriteBackground(src)})`;
    }
    const left = Math.round(state.GAME_W / 2 - CONFIG.tileWidth / 2);
    const top = Math.round(state.GAME_H / 2 - CONFIG.tileWidth / 2);
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
    const newW = Math.max(1, Math.round(window.innerWidth));
    const newH = Math.max(1, Math.round(window.innerHeight));

    // Zooming the browser below 100% reveals more of the world than a player
    // should be able to see. The devicePixelRatio compared against the value
    // captured at startup tells us the current zoom. When zoomed out we keep the
    // logical (100%) viewport size constant and counter-scale the app so the
    // visible world is identical no matter how far out the user zooms.
    const baseline = state.baselineDPR || window.devicePixelRatio || 1;
    const zoom = window.devicePixelRatio / baseline;
    const zoomedOut = baseline > 0 && zoom > 0 && zoom < 1;

    let gw = newW;
    let gh = newH;
    if (zoomedOut) {
        // innerWidth grows as the browser zooms out; multiplying by zoom cancels
        // that growth so the logical viewport stays at the 100% equivalent size.
        gw = Math.max(1, Math.round(newW * zoom));
        gh = Math.max(1, Math.round(newH * zoom));
    }

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

    if (zoomedOut) {
        state.appEl.style.transformOrigin = "0 0";
        state.appEl.style.transform = `scale(${1 / zoom})`;
    } else if (state.appEl.style.transform) {
        state.appEl.style.transform = "";
    }

    state.scaleX = 1;
    state.scaleY = 1;
}

function gameLoop(time) {
    const rawDt = state.lastTime ? (time - state.lastTime) / 1000 : 0;
    const dt = Math.min(rawDt, 0.05);
    state.lastTime = time;

    if (!document.hasFocus()) clearMovementKeys();

    applyCanvasTransform();

    const movement = getMovementState();
    const newDirection = movement.direction;
    if (newDirection !== state.direction) {
        if (state.direction !== "idle") state.lastDirection = state.direction;
        state.direction = newDirection;
        state.animFrame = 0;
        state.animTimer = 0;
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
    if (state.playerEl) updatePlayerSprite();
    updateCamera();
});

function startGame() {
    if (state.initStarted) return;
    state.initStarted = true;
    const startEl = document.getElementById("mobile-start");
    if (startEl) startEl.hidden = true;
    init();
}

async function init() {
    state.GAME_W = window.innerWidth;
    state.GAME_H = window.innerHeight;
    // Capture the devicePixelRatio at startup; it represents 100% zoom and is the
    // baseline used to detect browser zoom-out so the world view can be locked.
    state.baselineDPR = window.devicePixelRatio || 1;

    if (isTouchDevice()) {
        createJoystick();
        createMobileButtons();
        createSettingsMenu(settings);
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
    createInventoryUI(settings);
    await fetchLocalPlayerData();
    await connectToServer();
    await discoverFrames(state.characterPath);
    await preloadSprites(state.characterPath);
    preloadTiles();
    await loadTileColors();
    createPlayer();
    applyCanvasTransform();
    updateCamera();
    requestAnimationFrame(gameLoop);
}

if (!isTouchDevice() || !document.getElementById("mobile-start")) {
    startGame();
}
