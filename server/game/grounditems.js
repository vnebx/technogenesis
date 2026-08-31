import { CONFIG, state } from "./state.js";
import { addItem, getItemTexturePath, updateCursorItem } from "./inventory.js";
import { dropItemToGround, sendPickupGroundItem } from "./net.js";
import { getFacingDirection } from "./sprites.js";

export function groundItemPixelSize() {
    return Math.round(CONFIG.GROUND_ITEM_BASE_SIZE * CONFIG.GROUND_ITEM_SCALE);
}

export function hashString(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
        h = (h * 31 + str.charCodeAt(i)) | 0;
    }
    return h;
}

export function renderGroundItems() {
    const seen = new Set();
    const size = groundItemPixelSize();
    for (const item of state.groundItems) {
        if (state.pendingPickups.has(item.id)) {
            seen.add(item.id);
            const el = state.groundItemEls.get(item.id);
            if (el) el.style.display = "none";
            continue;
        }
        seen.add(item.id);
        let el = state.groundItemEls.get(item.id);
        if (!el) {
            el = document.createElement("img");
            el.className = "ground-item";
            el.draggable = false;
            el.style.position = "absolute";
            el.style.zIndex = "1";
            el.style.pointerEvents = "none";
            state.worldEl.appendChild(el);
            state.groundItemEls.set(item.id, el);
        }
        el.style.display = "block";
        el.src = getItemTexturePath(item.item);
        el.style.width = `${size}px`;
        el.style.height = `${size}px`;
    }
    for (const [id, el] of state.groundItemEls) {
        if (!seen.has(id)) {
            el.remove();
            state.groundItemEls.delete(id);
        }
    }
    updateGroundItemAnimation();
}

export function updateGroundItemAnimation() {
    const size = groundItemPixelSize();
    const now = Date.now();
    for (const item of state.groundItems) {
        const el = state.groundItemEls.get(item.id);
        if (!el) continue;
        const phase = (hashString(item.id) % 628) / 100;
        const bob = Math.sin(now / 600 + phase) * CONFIG.GROUND_ITEM_BOB_AMPLITUDE;
        el.style.left = `${Math.round(item.x - size / 2)}px`;
        el.style.top = `${Math.round(item.y - size / 2 + bob)}px`;
    }
}

export function syncGroundItems(list) {
    state.groundItems = Array.isArray(list) ? list : [];
    const present = new Set(state.groundItems.map((g) => g.id));
    for (const id of [...state.pendingPickups]) {
        if (!present.has(id)) {
            state.pendingPickups.delete(id);
        }
    }
    renderGroundItems();
}

export function scatterDrop(itemId, totalCount, baseCol, baseRow) {
    const offsets = [[0, 0], [0, 1], [-1, 0], [1, 0]];
    for (let i = 0; i < totalCount; i++) {
        const [dx, dy] = offsets[i % offsets.length];
        dropItemToGround(
            itemId,
            1,
            (baseCol + dx) * CONFIG.tileWidth + CONFIG.tileWidth / 2,
            (baseRow + dy) * CONFIG.tileWidth + CONFIG.tileWidth / 2
        );
    }
}

export function checkGroundPickup() {
    const size = groundItemPixelSize();
    const half = size / 2;
    const playerLeft = state.playerWorldX;
    const playerTop = state.playerWorldY;
    const playerRight = state.playerWorldX + CONFIG.tileWidth;
    const playerBottom = state.playerWorldY + CONFIG.tileWidth;
    let picked = false;
    for (const item of [...state.groundItems]) {
        if (state.pendingPickups.has(item.id)) continue;
        const itemLeft = item.x - half;
        const itemTop = item.y - half;
        const itemRight = item.x + half;
        const itemBottom = item.y + half;
        if (playerRight > itemLeft && playerLeft < itemRight && playerBottom > itemTop && playerTop < itemBottom) {
            addItem(item.item, item.count);
            state.pendingPickups.add(item.id);
            sendPickupGroundItem(item.id);
            state.groundItems = state.groundItems.filter((g) => g.id !== item.id);
            picked = true;
        }
    }
    if (picked) renderGroundItems();
}

export function dropCursorItem() {
    if (!state.cursorItem) return;
    const facing = getFacingDirection();
    const offsets = { forward: [0, -1], backward: [0, 1], left: [-1, 0], right: [1, 0] };
    const [dx, dy] = offsets[facing] || [0, 1];
    const cx = state.playerWorldX + CONFIG.tileWidth / 2;
    const cy = state.playerWorldY + CONFIG.tileWidth / 2;
    dropItemToGround(state.cursorItem.id, state.cursorItem.count, cx + dx * CONFIG.DROP_DISTANCE, cy + dy * CONFIG.DROP_DISTANCE);
    state.cursorItem = null;
    updateCursorItem();
}
