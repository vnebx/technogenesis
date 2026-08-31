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
    tile.style.width = `${CONFIG.tileWidth + 2}px`;
    tile.style.height = `${CONFIG.tileWidth + 2}px`;
    tile.style.position = "absolute";
    tile.style.top = `${Math.round(row * CONFIG.tileWidth) - 1}px`;
    tile.style.left = `${Math.round(col * CONFIG.tileWidth) - 1}px`;
    tile.style.zIndex = zIndex;
    tile.style.pointerEvents = "none";
    if ((type === "grass" || type === "water") && state.tileColors[type]) {
        tile.style.backgroundColor = state.tileColors[type];
    }
    state.worldEl.appendChild(tile);
    return tile;
}

function ensureTile(col, row) {
    const key = tileKey(col, row);
    if (state.tileElements.has(key)) return;

    const baseType = getBaseTileType(col, row, state.seed, CONFIG.regionSize, CONFIG.lakeWidth, CONFIG.lakeHeight);
    const baseTile = createTileElement(col, row, baseType, "0");
    const treeOrigin = getTreeAt(col, row, state.seed, CONFIG.regionSize, CONFIG.treeRegionSize);
    if (!treeOrigin || state.removedTrees.has(treeKey(treeOrigin))) {
        state.tileElements.set(key, { base: baseTile });
        return;
    }
    const treeType = getTreeTile(col, row, state.seed, CONFIG.regionSize, CONFIG.treeRegionSize);
    const overlayZ = treeType === "oak_tree_leaves" ? "3" : "1";
    const overlayTile = createTileElement(col, row, treeType, overlayZ);
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
}

export function updateCamera() {
    state.cameraX = state.playerWorldX + CONFIG.tileWidth / 2 - state.GAME_W / 2;
    state.cameraY = state.playerWorldY + CONFIG.tileWidth / 2 - state.GAME_H / 2;
    const worldX = Math.round(state.cameraX);
    const worldY = Math.round(state.cameraY);
    state.worldEl.style.transform = `translate(${-worldX}px, ${-worldY}px)`;
    updateVisibleTiles();
}

export function refreshRemovedTiles() {
    for (const [key, entry] of [...state.tileElements]) {
        const [colStr, rowStr] = key.split(",");
        const col = parseInt(colStr, 10);
        const row = parseInt(rowStr, 10);
        const origin = getTreeAt(col, row, state.seed, CONFIG.regionSize, CONFIG.treeRegionSize);
        if (!origin) continue;
        if (state.removedTrees.has(treeKey(origin))) {
            if (entry.overlay) {
                entry.overlay.remove();
                entry.overlay = null;
            }
        } else if (!entry.overlay) {
            const treeType = getTreeTile(col, row, state.seed, CONFIG.regionSize, CONFIG.treeRegionSize);
            const overlayZ = treeType === "oak_tree_leaves" ? "3" : "1";
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
            const origin = getTreeAt(px + dx, py + dy, state.seed, CONFIG.regionSize, CONFIG.treeRegionSize);
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
    if (state.seed.length) {
        updateVisibleTiles();
        updateCamera();
    }
}
