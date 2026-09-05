import { getBaseTileType } from "./mapgen/lake.js";
import { getTreeTile, getTreeAt } from "./mapgen/tree.js";
import { CONFIG, state } from "./state.js";
// This code has tile rendering and terrain generation logic.
export function tileKey(col, row) {
    return `${col},${row}`;
}

export function treeKey(origin) {
    return `${origin.col},${origin.row}`;
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
    // baseCol/baseRow = the trunk's bottom tile, used to cull the shadow with the view
    state.treeShadowEls.set(key, { el, baseCol: treeOrigin.col, baseRow: treeOrigin.row - 1 });
}

function ensureTile(col, row) {
    const key = tileKey(col, row);
    if (state.tileElements.has(key)) return;

    const baseType = getBaseTileType(col, row, state.seed, CONFIG.regionSize, CONFIG.lakeWidth, CONFIG.lakeHeight);
    const baseTile = createTileElement(col, row, baseType, "0");
    const treeOrigin = getTreeAt(col, row, state.seed);
    if (!treeOrigin || state.removedTrees.has(treeKey(treeOrigin))) {
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
        } else if (!entry.overlay) {
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
            if (origin && !state.removedTrees.has(treeKey(origin))) {
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
    for (const entry of state.treeShadowEls.values()) entry.el.remove();
    state.treeShadowEls.clear();
    if (state.seed.length) {
        updateVisibleTiles();
        updateCamera();
    }
}
