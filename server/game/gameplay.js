import { CONFIG, state } from "./state.js";
import { treeAtPlayer, treeKey, refreshRemovedTiles } from "./tiles.js";
import { scatterDrop } from "./grounditems.js";
import { sendRemoveTree } from "./net.js";

function chopTree(origin, key) {
    state.removedTrees.add(key);
    refreshRemovedTiles();
    scatterDrop(CONFIG.CHOP_REWARD, CONFIG.CHOP_REWARD_COUNT, origin.col, origin.row);
    sendRemoveTree(key);
}

export function applyUseEffect() {
    const origin = treeAtPlayer();
    if (!origin) return;
    const key = treeKey(origin);
    const count = (state.treeUseCounts.get(key) || 0) + 1;
    state.treeUseCounts.set(key, count);
    if (count >= CONFIG.CHOP_USES_REQUIRED) {
        state.treeUseCounts.delete(key);
        chopTree(origin, key);
    }
}

export function startUse() {
    state.using = true;
    state.useTimer = CONFIG.useDuration;
    state.animFrame = 0;
    state.animTimer = 0;
    applyUseEffect();
}
