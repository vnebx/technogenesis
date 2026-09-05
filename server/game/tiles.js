import { getBaseTileType, clearTerrainCache } from "./mapgen/terrain.js";
import { getTreeTile, getTreeAt, clearTreeCache } from "./mapgen/tree.js";
import { CONFIG, state } from "./state.js";
// This code has tile rendering and terrain generation logic.
export function tileKey(col, row) {
    return `${col},${row}`;
}

export function treeKey(origin) {
    return `${origin.col},${origin.row}`;
}

// At very low zoom, rendering one DOM node per 32px tile would spawn hundreds of
// thousands of tiles. Instead each node from here down represents a `stride x
// stride` block of real tiles, so the node count stays bounded no matter how far
// out the zoom slider goes. `getCoarseStride` picks 1 for normal zoom and grows
// the block size as you zoom out (a 1:1 block at 30%, a whole-continent view at
// ~0.5% by using ~50x50-tile blocks).
export function getCoarseStride(zoom) {
    const s = Math.abs(zoom ?? 1);
    if (s >= 0.3) return 1;
    return Math.max(2, Math.min(64, Math.ceil(0.3 / Math.max(s, 0.001))));
}

function createCoarseTile(cx, cy, stride, type) {
    const cell = CONFIG.tileWidth * stride;
    const bleed = 1;
    const tile = document.createElement("img");
    tile.className = "tile";
    tile.src = `assets/tiles/${type}.png`;
    tile.style.display = "block";
    tile.style.position = "absolute";
    tile.style.zIndex = "0";
    tile.style.pointerEvents = "none";
    tile.style.width = `${cell + bleed}px`;
    tile.style.height = `${cell + bleed}px`;
    tile.style.top = `${cy * cell - bleed / 2}px`;
    tile.style.left = `${cx * cell - bleed / 2}px`;
    if ((type === "grass" || type === "water") && state.tileColors[type]) {
        tile.style.backgroundColor = state.tileColors[type];
    }
    state.worldEl.appendChild(tile);
    return tile;
}

// A block is water when the majority of its sampled tiles are water. Sampling a
// few tiles (not all stride^2) keeps the far-zoom cost small while still showing
// rivers and inland seas.
function coarseType(cx, cy, stride) {
    const startCol = cx * stride;
    const startRow = cy * stride;
    const n = Math.min(5, stride);
    const step = Math.floor(stride / n) || 1;
    let water = 0;
    let total = 0;
    for (let i = 0; i < n; i++) {
        const col = startCol + i * step + Math.floor(step / 2);
        for (let j = 0; j < n; j++) {
            const row = startRow + j * step + Math.floor(step / 2);
            if (getBaseTileType(col, row, state.seed) === "water") water++;
            total++;
        }
    }
    return water >= total / 2 ? "water" : "grass";
}

function clearTileElements() {
    for (const entry of state.tileElements.values()) {
        if (entry.base) entry.base.remove();
        if (entry.overlay) entry.overlay.remove();
    }
    state.tileElements.clear();
    for (const entry of state.treeShadowEls.values()) {
        if (entry.shade) entry.shade.remove();
        entry.el.remove();
    }
    state.treeShadowEls.clear();
}

function clearCoarseTiles() {
    for (const el of state.coarseTiles.values()) el.remove();
    state.coarseTiles.clear();
}

function updateCoarseTiles(stride) {
    clearTileElements();
    const cell = CONFIG.tileWidth * stride;
    const createMargin = 3;
    const keepMargin = 8;
    const startCx = Math.floor(state.cameraX / cell) - createMargin;
    const endCx = Math.ceil((state.cameraX + state.GAME_W) / cell) + createMargin;
    const startCy = Math.floor(state.cameraY / cell) - createMargin;
    const endCy = Math.ceil((state.cameraY + state.GAME_H) / cell) + createMargin;
    const keepStartCx = Math.floor(state.cameraX / cell) - keepMargin;
    const keepEndCx = Math.ceil((state.cameraX + state.GAME_W) / cell) + keepMargin;
    const keepStartCy = Math.floor(state.cameraY / cell) - keepMargin;
    const keepEndCy = Math.ceil((state.cameraY + state.GAME_H) / cell) + keepMargin;
    const inKeep = (cx, cy) => cx >= keepStartCx && cx <= keepEndCx && cy >= keepStartCy && cy <= keepEndCy;

    for (let cy = startCy; cy <= endCy; cy++) {
        for (let cx = startCx; cx <= endCx; cx++) {
            const key = `${stride}:${cx},${cy}`;
            if (state.coarseTiles.has(key)) continue;
            state.coarseTiles.set(key, createCoarseTile(cx, cy, stride, coarseType(cx, cy, stride)));
        }
    }
    for (const [key, el] of state.coarseTiles) {
        const [strideStr, xy] = key.split(":");
        if (parseInt(strideStr, 10) !== stride) {
            el.remove();
            state.coarseTiles.delete(key);
            continue;
        }
        const [cx, cy] = xy.split(",").map(Number);
        if (!inKeep(cx, cy)) {
            el.remove();
            state.coarseTiles.delete(key);
        }
    }
}

export function createTileElement(col, row, type, zIndex = "0") {
    const tile = document.createElement("img");
    tile.className = "tile";
    tile.src = `assets/tiles/${type}.png`;
    tile.style.display = "block";
    tile.style.position = "absolute";
    tile.style.zIndex = zIndex;
    tile.style.pointerEvents = "none";
    // 1px bleed: tiles overlap their neighbors by half a pixel on every side so
    // Chrome's sub-pixel antialiasing can never open a gap to the page background.
    const bleed = 1;
    tile.style.width = `${CONFIG.tileWidth + bleed}px`;
    tile.style.height = `${CONFIG.tileWidth + bleed}px`;
    tile.style.top = `${row * CONFIG.tileWidth - bleed / 2}px`;
    tile.style.left = `${col * CONFIG.tileWidth - bleed / 2}px`;
    if ((type === "grass" || type === "water") && state.tileColors[type]) {
        tile.style.backgroundColor = state.tileColors[type];
    }
    state.worldEl.appendChild(tile);
    return tile;
}

function removeTreeShadow(key) {
    const entry = state.treeShadowEls.get(key);
    if (entry) {
        if (entry.shade) entry.shade.remove();
        entry.el.remove();
        state.treeShadowEls.delete(key);
    }
}

// One shadow element per tree. All of the tree's tile sprites are assembled
// into a single container which is blackened and warped with ONE transform about
// the trunk base. Because the pieces live inside one element and are never
// individually transformed, there can be no black seams between them — the
// whole silhouette is rasterized as a continuous ground shadow (light from the
// left, so it leans toward the right).
function createTreeShadow(treeOrigin) {
    const key = treeKey(treeOrigin);
    if (state.treeShadowEls.has(key)) return;
    const tw = CONFIG.tileWidth;
    const startCol = treeOrigin.col - 1;
    const startRow = treeOrigin.row - 4;

    const el = document.createElement("div");
    el.className = "tree-shadow";
    el.style.position = "absolute";
    el.style.pointerEvents = "none";
    el.style.zIndex = "1";
    el.style.left = `${startCol * tw}px`;
    el.style.top = `${startRow * tw}px`;
    el.style.width = `${tw * 3}px`;
    el.style.height = `${tw * 4}px`;
    el.style.filter = "brightness(0)";
    el.style.opacity = String(CONFIG.treeShadowOpacity ?? 0.4);

    // Reassemble the tree footprint (3 wide x 4 tall) from its real sprites,
    // with a small bleed between pieces so nothing peaks through the seams.
    const bleed = 2;
    for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 3; col++) {
            const treeType = getTreeTile(startCol + col, startRow + row, state.seed);
            if (!treeType) continue;
            const piece = document.createElement("img");
            piece.src = `assets/tiles/${treeType}.png`;
            piece.style.position = "absolute";
            piece.style.pointerEvents = "none";
            piece.style.width = `${tw + bleed}px`;
            piece.style.height = `${tw + bleed}px`;
            piece.style.left = `${col * tw - bleed / 2}px`;
            piece.style.top = `${row * tw - bleed / 2}px`;
            el.appendChild(piece);
        }
    }

    // One warp about the trunk base (horizontal center of the trunk's bottom
    // edge) so the shadow stays planted at the tree and spreads to the right.
    const anchorX = (treeOrigin.col + 0.5) * tw;
    const anchorY = treeOrigin.row * tw;
    el.style.transformOrigin = `${anchorX - startCol * tw}px ${anchorY - startRow * tw}px`;
    el.style.transform =
        `translate(${CONFIG.treeShadowOffsetX}px, ${CONFIG.treeShadowOffsetY}px) ` +
        `skewX(${CONFIG.treeShadowSkewDeg}deg) ` +
        `scale(${CONFIG.treeShadowScaleX}, ${CONFIG.treeShadowScaleY})`;
    state.worldEl.appendChild(el);

    // The tree's own side shading: a BLOCKY, pixel-art gradient of solid dark
    // bands across the right side of the trunk and leaves, matching the
    // direction the ground shadow falls (light from the left). Each band is a
    // flat color with a hard edge — no smooth blending. Masked with the tree's
    // real sprites so it darkens only the tree itself (no halo in leaf gaps).
    const shade = document.createElement("div");
    shade.className = "tree-shade";
    shade.style.position = "absolute";
    shade.style.pointerEvents = "none";
    shade.style.zIndex = "4";
    shade.style.left = `${startCol * tw}px`;
    shade.style.top = `${startRow * tw}px`;
    shade.style.width = `${tw * 3}px`;
    shade.style.height = `${tw * 4}px`;
    // Five stepped bands (~32px each): darkest on the right edge, fading to
    // untouched toward the middle, so the trunk (center column) gets shaded too.
    shade.style.background =
        "linear-gradient(to left, " +
        "rgba(0,0,0,0.45) 0%, rgba(0,0,0,0.45) 16.6%, " +
        "rgba(0,0,0,0.36) 16.6%, rgba(0,0,0,0.36) 33.3%, " +
        "rgba(0,0,0,0.26) 33.3%, rgba(0,0,0,0.26) 50%, " +
        "rgba(0,0,0,0.16) 50%, rgba(0,0,0,0.16) 66.6%, " +
        "rgba(0,0,0,0.08) 66.6%, rgba(0,0,0,0.08) 83.3%, " +
        "rgba(0,0,0,0) 83.3%)";

    const urls = [];
    const positions = [];
    const sizes = [];
    const sbleed = 1;
    for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 3; col++) {
            const treeType = getTreeTile(startCol + col, startRow + row, state.seed);
            if (!treeType) continue;
            urls.push(`url(assets/tiles/${treeType}.png)`);
            positions.push(`${col * tw - sbleed / 2}px ${row * tw - sbleed / 2}px`);
            sizes.push(`${tw + sbleed}px ${tw + sbleed}px`);
        }
    }
    shade.style.maskImage = urls.join(",");
    shade.style.maskPosition = positions.join(",");
    shade.style.maskSize = sizes.join(",");
    shade.style.maskRepeat = "no-repeat";
    shade.style.webkitMaskImage = urls.join(",");
    shade.style.webkitMaskPosition = positions.join(",");
    shade.style.webkitMaskSize = sizes.join(",");
    shade.style.webkitMaskRepeat = "no-repeat";
    state.worldEl.appendChild(shade);

    // baseCol/baseRow = the trunk's bottom tile, used to cull the shadow with the view
    state.treeShadowEls.set(key, { el, shade, baseCol: treeOrigin.col, baseRow: treeOrigin.row - 1 });
}

function ensureTile(col, row) {
    const key = tileKey(col, row);
    if (state.tileElements.has(key)) return;

    const baseType = getBaseTileType(col, row, state.seed);
    const baseTile = createTileElement(col, row, baseType, "0");
    const treeOrigin = getTreeAt(col, row, state.seed);
    // Trees only grow on grass — never on water or rivers.
    if (!treeOrigin || state.removedTrees.has(treeKey(treeOrigin)) || baseType !== "grass") {
        state.tileElements.set(key, { base: baseTile });
        return;
    }
    const treeType = getTreeTile(col, row, state.seed);
    const overlayZ = treeType === "oak_tree_leaves" ? "3" : "2";
    const overlayTile = createTileElement(col, row, treeType, overlayZ);
    createTreeShadow(treeOrigin);
    state.tileElements.set(key, { base: baseTile, overlay: overlayTile });
}

export function updateVisibleTiles() {
    if (!state.seed || !state.seed.length) return;
    const stride = getCoarseStride(state.zoom);
    if (stride > 1) return updateCoarseTiles(stride);
    if (state.coarseTiles.size) clearCoarseTiles();
    // createMargin: tiles rendered slightly beyond the viewport so nothing pops in at the edges
    // keepMargin: tiles kept alive further out (larger) so scrolling doesn't recreate them repeatedly
    const createMargin = 3;
    const keepMargin = 8;
    const startCol = Math.floor(state.cameraX / CONFIG.tileWidth) - createMargin;
    const endCol = Math.ceil((state.cameraX + state.GAME_W) / CONFIG.tileWidth) + createMargin;
    const startRow = Math.floor(state.cameraY / CONFIG.tileWidth) - createMargin;
    const endRow = Math.ceil((state.cameraY + state.GAME_H) / CONFIG.tileWidth) + createMargin;

    const keepStartCol = Math.floor(state.cameraX / CONFIG.tileWidth) - keepMargin;
    const keepEndCol = Math.ceil((state.cameraX + state.GAME_W) / CONFIG.tileWidth) + keepMargin;
    const keepStartRow = Math.floor(state.cameraY / CONFIG.tileWidth) - keepMargin;
    const keepEndRow = Math.ceil((state.cameraY + state.GAME_H) / CONFIG.tileWidth) + keepMargin;

    const viewKey = (col, row) => (col >= keepStartCol && col <= keepEndCol && row >= keepStartRow && row <= keepEndRow);

    for (let row = startRow; row <= endRow; row++) {
        for (let col = startCol; col <= endCol; col++) {
            ensureTile(col, row);
        }
    }

    for (const [key, entry] of state.tileElements) {
        const [colStr, rowStr] = key.split(",");
        const col = parseInt(colStr, 10);
        const row = parseInt(rowStr, 10);
        if (!viewKey(col, row)) {
            if (entry.base) entry.base.remove();
            if (entry.overlay) entry.overlay.remove();
            state.tileElements.delete(key);
        }
    }

    for (const [key, entry] of state.treeShadowEls) {
        if (!viewKey(entry.baseCol, entry.baseRow)) {
            if (entry.shade) entry.shade.remove();
            entry.el.remove();
            state.treeShadowEls.delete(key);
        }
    }
}

export function screenXFromWorld(worldX) {
    return Math.round((worldX - state.cameraX) * state.scaleX) / state.scaleX;
}

export function screenYFromWorld(worldY) {
    return Math.round((worldY - state.cameraY) * state.scaleY) / state.scaleY;
}

export function screenCenterPlayerLeft() {
    return Math.round((state.GAME_W / 2 - CONFIG.tileWidth / 2) * state.scaleX) / state.scaleX;
}

export function screenCenterPlayerTop() {
    return Math.round((state.GAME_H / 2 - CONFIG.tileWidth / 2) * state.scaleY) / state.scaleY;
}

export function updateCamera() {
    state.cameraX = state.playerWorldX + CONFIG.tileWidth / 2 - state.GAME_W / 2;
    state.cameraY = state.playerWorldY + CONFIG.tileWidth / 2 - state.GAME_H / 2;
    // Snap the world translate to whole device pixels so tiles land on exact
    // pixel boundaries; fractional translates make Chrome antialias 1px seams
    // between neighbouring tiles.
    const dpr = state.baselineDPR || window.devicePixelRatio || 1;
    const tx = Math.round(-state.cameraX * dpr) / dpr;
    const ty = Math.round(-state.cameraY * dpr) / dpr;
    const transform = `translate(${tx}px, ${ty}px)`;
    if (state.lastWorldTransform !== transform) {
        state.lastWorldTransform = transform;
        state.worldEl.style.transform = transform;
    }
    updateVisibleTiles();
}

export function refreshRemovedTiles() {
    for (const [key, entry] of [...state.tileElements]) {
        const [colStr, rowStr] = key.split(",");
        const col = parseInt(colStr, 10);
        const row = parseInt(rowStr, 10);
        const origin = getTreeAt(col, row, state.seed);
        if (!origin) continue;
        if (state.removedTrees.has(treeKey(origin))) {
            if (entry.overlay) {
                entry.overlay.remove();
                entry.overlay = null;
            }
            removeTreeShadow(treeKey(origin));
        } else if (!entry.overlay && getBaseTileType(col, row, state.seed) === "grass") {
            const treeType = getTreeTile(col, row, state.seed);
            const overlayZ = treeType === "oak_tree_leaves" ? "3" : "2";
            entry.overlay = createTileElement(col, row, treeType, overlayZ);
        }
    }
}

export function treeAtPlayer() {
    const px = Math.floor(state.playerWorldX / CONFIG.tileWidth);
    const py = Math.floor(state.playerWorldY / CONFIG.tileWidth);
    // Search a 3x3 tile area around the player to find the tree being interacted with
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            const origin = getTreeAt(px + dx, py + dy, state.seed);
            if (origin && !state.removedTrees.has(treeKey(origin)) && getBaseTileType(px + dx, py + dy, state.seed) === "grass") {
                return origin;
            }
        }
    }
    return null;
}

export function syncRemovedTrees(list) {
    if (!Array.isArray(list)) return;
    let changed = false;
    for (const key of list) {
        const k = String(key);
        if (!state.removedTrees.has(k)) {
            state.removedTrees.add(k);
            changed = true;
        }
    }
    if (changed) refreshRemovedTiles();
}

export function applySeed(newSeed) {
    const next = Array.isArray(newSeed) ? newSeed : [];
    if (JSON.stringify(next) === JSON.stringify(state.seed)) return;
    state.seed = next;
    for (const [, entry] of state.tileElements) {
        if (entry.base) entry.base.remove();
        if (entry.overlay) entry.overlay.remove();
    }
    state.tileElements.clear();
    for (const entry of state.treeShadowEls.values()) {
        if (entry.shade) entry.shade.remove();
        entry.el.remove();
    }
    state.treeShadowEls.clear();
    for (const el of state.coarseTiles.values()) el.remove();
    state.coarseTiles.clear();
    clearTerrainCache();
    clearTreeCache();
    if (state.seed.length) {
        updateVisibleTiles();
        updateCamera();
    }
}
