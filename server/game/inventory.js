import { CONFIG, INVENTORY_SIZE, state } from "./state.js";
import { applySettings } from "./settings.js";
import { sendPlayerUpdate } from "./net.js";
import { dropCursorItem } from "./grounditems.js";

export function getItemTexturePath(itemId) {
    if (!itemId) return null;
    return `${CONFIG.ITEM_IMAGE_PATH}${itemId}.png`;
}

export function createItemSlot(itemId, count = 1) {
    return { id: itemId, count: count };
}

export function normalizeInventorySlot(slot) {
    if (!slot) return null;
    if (typeof slot === "string") return createItemSlot(slot, 1);
    if (typeof slot === "object") {
        const count = Math.max(1, Math.min(CONFIG.MAX_STACK, Number(slot.count) || 1));
        return createItemSlot(slot.id, count);
    }
    return null;
}

export function renderInventory() {
    if (!state.inventoryEl) return;
    state.slotElements.forEach((el, idx) => {
        el.innerHTML = "";

        const item = state.playerInventory[idx];
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

export function addItem(itemId, count = 1) {
    let remaining = count;
    for (let i = 0; i < INVENTORY_SIZE && remaining > 0; i++) {
        const slot = state.playerInventory[i];
        if (slot && slot.id === itemId && slot.count < CONFIG.MAX_STACK) {
            const added = Math.min(CONFIG.MAX_STACK - slot.count, remaining);
            slot.count += added;
            remaining -= added;
        }
    }
    for (let i = 0; i < INVENTORY_SIZE && remaining > 0; i++) {
        if (!state.playerInventory[i]) {
            const added = Math.min(CONFIG.MAX_STACK, remaining);
            state.playerInventory[i] = createItemSlot(itemId, added);
            remaining -= added;
        }
    }
    renderInventory();
    sendPlayerUpdate();
    return remaining;
}

export function updateCursorItem() {
    if (!state.cursorItemEl) return;
    if (state.cursorItem) {
        const img = state.cursorItemEl.querySelector("img");
        const count = state.cursorItemEl.querySelector(".count");
        img.src = getItemTexturePath(state.cursorItem.id);
        img.alt = state.cursorItem.id;
        count.textContent = state.cursorItem.count > 1 ? state.cursorItem.count : "";
        state.cursorItemEl.style.display = "block";
    } else {
        state.cursorItemEl.style.display = "none";
    }
}

function grabFromSlot(index) {
    if (state.cursorItem) return;
    const slot = state.playerInventory[index];
    if (!slot) return;

    state.cursorItem = { id: slot.id, count: slot.count };
    state.playerInventory[index] = null;
    updateCursorItem();
    renderInventory();
    sendPlayerUpdate();
}

function splitHeldItem(fromIndex) {
    if (!state.cursorItem || state.cursorItem.count < 2) return;
    const keep = Math.floor(state.cursorItem.count / 2);
    const held = state.cursorItem.count - keep;
    if (!state.playerInventory[fromIndex]) {
        state.playerInventory[fromIndex] = createItemSlot(state.cursorItem.id, keep);
    }
    state.cursorItem.count = held;
    updateCursorItem();
    renderInventory();
    sendPlayerUpdate();
}

function placeOnSlot(index) {
    if (!state.cursorItem) return;
    const slot = state.playerInventory[index];
    if (!slot) {
        state.playerInventory[index] = state.cursorItem;
        state.cursorItem = null;
    } else if (slot.id === state.cursorItem.id) {
        const space = CONFIG.MAX_STACK - slot.count;
        if (space > 0) {
            const moved = Math.min(space, state.cursorItem.count);
            slot.count += moved;
            state.cursorItem.count -= moved;
            if (state.cursorItem.count <= 0) state.cursorItem = null;
        }
    } else {
        const temp = state.playerInventory[index];
        state.playerInventory[index] = state.cursorItem;
        state.cursorItem = temp;
    }
    updateCursorItem();
    renderInventory();
    sendPlayerUpdate();
}

function showItemTooltip(index, slotEl) {
    const item = state.playerInventory[index];
    if (!item || !state.tooltipEl) return;
    state.tooltipEl.textContent = item.id.split("_").join(" ");
    state.tooltipEl.style.display = "block";
    const rect = slotEl.getBoundingClientRect();
    let left = rect.left / state.scaleX;
    let top = rect.top / state.scaleY - (state.tooltipEl.offsetHeight / state.scaleY) - 4;
    if (top < 0) {
        top = rect.bottom / state.scaleY + 4;
    }
    const maxLeft = state.GAME_W - state.tooltipEl.offsetWidth;
    left = Math.max(0, Math.min(left, maxLeft));
    state.tooltipEl.style.left = `${left}px`;
    state.tooltipEl.style.top = `${top}px`;
}

function hideItemTooltip() {
    if (state.tooltipEl) state.tooltipEl.style.display = "none";
}

export function setInventoryVisible(visible) {
    state.inventoryVisible = visible;
    if (state.inventoryEl) {
        state.inventoryEl.style.display = visible ? "grid" : "none";
    }
}

export function toggleInventory() {
    setInventoryVisible(!state.inventoryVisible);
}

function setupInventoryInput() {
    if (!isTouchDevice()) return;
    window.addEventListener("touchmove", (e) => {
        if (!state.touchDrag) return;
        for (const touch of e.changedTouches) {
            if (touch.identifier === state.touchDrag.touchId) {
                e.preventDefault();
                state.touchDrag.lastTime = performance.now();
                const dx = touch.clientX - state.touchDrag.startX;
                const dy = touch.clientY - state.touchDrag.startY;
                if (Math.hypot(dx, dy) > 8) {
                    state.touchDrag.dragged = true;
                    window.clearTimeout(state.touchDrag.holdTimer);
                }
                if (state.touchDrag.dragged && state.cursorItemEl) {
                    state.cursorItemEl.style.left = `${touch.clientX}px`;
                    state.cursorItemEl.style.top = `${touch.clientY}px`;
                    state.cursorItemEl.style.display = "block";
                }
                break;
            }
        }
    }, { passive: false });

    window.addEventListener("touchend", (e) => {
        if (!state.touchDrag) return;
        for (const touch of e.changedTouches) {
            if (touch.identifier === state.touchDrag.touchId) {
                e.preventDefault();
                window.clearTimeout(state.touchDrag.holdTimer);
                const drag = state.touchDrag;
                state.touchDrag = null;
                const el = document.elementFromPoint(touch.clientX, touch.clientY);
                const targetSlot = el ? el.closest(".slot") : null;
                if (targetSlot) {
                    placeOnSlot(parseInt(targetSlot.dataset.index, 10));
                } else {
                    dropCursorItem();
                }
                break;
            }
        }
    }, { passive: false });

    window.addEventListener("touchcancel", (e) => {
        if (!state.touchDrag) return;
        for (const touch of e.changedTouches) {
            if (touch.identifier === state.touchDrag.touchId) {
                window.clearTimeout(state.touchDrag.holdTimer);
                state.touchDrag = null;
                break;
            }
        }
    }, { passive: false });
}

function isTouchDevice() {
    return (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) ||
        "ontouchstart" in window || navigator.maxTouchPoints > 0 ||
        /iPad|iPhone|iPod/i.test(window.navigator.userAgent);
}

export function createInventoryUI(settings) {
    document.documentElement.style.setProperty('--inv-scale', settings.inventory);
    document.documentElement.style.setProperty('--inv-text-scale', CONFIG.INVENTORY_TEXT_SCALE);

    state.inventoryEl = document.createElement("div");
    state.inventoryEl.id = "inventory";
    state.inventoryEl.style.gridTemplateColumns = `repeat(${CONFIG.INVENTORY_COLS}, calc(18px * var(--inv-scale)))`;
    state.inventoryEl.style.display = state.inventoryVisible ? "grid" : "none";

    state.cursorItemEl = document.createElement("div");
    state.cursorItemEl.id = "cursor-item";
    state.cursorItemEl.style.display = "none";
    const cursorImg = document.createElement("img");
    const cursorCount = document.createElement("span");
    cursorCount.className = "count";
    state.cursorItemEl.appendChild(cursorImg);
    state.cursorItemEl.appendChild(cursorCount);
    state.appEl.appendChild(state.cursorItemEl);

    state.tooltipEl = document.createElement("div");
    state.tooltipEl.id = "item-tooltip";
    state.tooltipEl.style.display = "none";
    state.appEl.appendChild(state.tooltipEl);

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
                if (state.cursorItem) {
                    placeOnSlot(index);
                } else {
                    grabFromSlot(index);
                }
            } else if (e.button === 2) {
                grabHalf(e, index);
            }
            if (state.cursorItemEl) {
                state.cursorItemEl.style.left = `${e.clientX / state.scaleX}px`;
                state.cursorItemEl.style.top = `${e.clientY / state.scaleY}px`;
            }
        });

        slot.addEventListener("touchstart", (e) => {
            const touch = e.changedTouches[0];
            if (state.touchDrag) return;
            e.preventDefault();
            e.stopPropagation();
            const index = parseInt(slot.dataset.index, 10);
            if (!state.cursorItem) grabFromSlot(index);
            state.touchDrag = {
                touchId: touch.identifier,
                startX: touch.clientX,
                startY: touch.clientY,
                fromIndex: index,
                dragged: false,
                holdTimer: window.setTimeout(() => {
                    if (state.touchDrag && !state.touchDrag.dragged) {
                        splitHeldItem(state.touchDrag.fromIndex);
                    }
                }, 1000),
            };
        }, { passive: false });

        state.inventoryEl.appendChild(slot);
        state.slotElements.push(slot);
    }

    setupInventoryInput();

    document.addEventListener("mousemove", (e) => {
        if (state.cursorItemEl) {
            state.cursorItemEl.style.left = `${e.clientX / state.scaleX}px`;
            state.cursorItemEl.style.top = `${e.clientY / state.scaleY}px`;
        }
    });

    state.appEl.appendChild(state.inventoryEl);
    applySettings(settings);
    renderInventory();
}

function grabHalf(e, index) {
    if (state.cursorItem) return;
    const slot = state.playerInventory[index];
    if (!slot) return;
    const grabbed = Math.ceil(slot.count / 2);
    const remaining = slot.count - grabbed;
    state.cursorItem = { id: slot.id, count: grabbed };
    if (remaining > 0) {
        slot.count = remaining;
    } else {
        state.playerInventory[index] = null;
    }
    updateCursorItem();
    renderInventory();
    sendPlayerUpdate();
}
