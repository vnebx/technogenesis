import { CONFIG, INVENTORY_SIZE, state } from "./state.js";
import { getCurrentSpriteName, setCharacterPath } from "./sprites.js";
import { applySeed, syncRemovedTrees, updateCamera } from "./tiles.js";
import { syncGroundItems } from "./grounditems.js";
import { updateRemotePlayers } from "./remote.js";
import { renderInventory, normalizeInventorySlot } from "./inventory.js";
// You shall not touch this code, net issues are a pain to debug
function getServerId() {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get("server") || "";
}

export function getPlayerSnapshot() {
    const spriteName = getCurrentSpriteName();
    return {
        character: state.characterPath,
        position: {
            x: Math.round(state.playerWorldX * 10) / 10,
            y: Math.round(state.playerWorldY * 10) / 10,
        },
        inventory: state.playerInventory.map((slot) => (slot ? { id: slot.id, count: slot.count } : null)),
        animation: spriteName,
    };
}

export function sendPlayerUpdate() {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;

    const now = performance.now();
    if (now - state.lastUpdateSentAt < CONFIG.UPDATE_SEND_INTERVAL) return;
    state.lastUpdateSentAt = now;

    const snapshot = getPlayerSnapshot();
    const payload = JSON.stringify({ operation: "update", data: snapshot });
    if (payload === state.lastSentSnapshot) return;

    state.ws.send(payload);
    state.lastSentSnapshot = payload;
}
// May need to move network world actions to a separate file, butits not a big deal
export function sendRemoveTree(key) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    state.ws.send(JSON.stringify({ operation: "remove_tree", tree: key }));
}

export function dropItemToGround(itemId, count, x, y) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    state.ws.send(JSON.stringify({ operation: "drop_item", data: { item: itemId, count, x, y } }));
}

export function sendPickupGroundItem(id) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    state.ws.send(JSON.stringify({ operation: "pickup_item", id }));
}

async function handleServerMessage(event) {
    let message;
    try {
        message = JSON.parse(event.data);
    } catch (e) {
        return;
    }
    if (!message) return;

    if (message.type === "welcome") {
        state.localPlayerId = message.player_id;
        applySeed(message.seed);
        syncRemovedTrees(message.removed_trees);
        syncGroundItems(message.ground_items);
        if (message.players) {
            const localData = message.players[state.localPlayerId];
            if (localData) {
                if (localData.character) {
                    setCharacterPath(localData.character);
                }
                if (localData.position) {
                    state.playerWorldX = Number(localData.position.x) || 0;
                    state.playerWorldY = Number(localData.position.y) || 0;
                }
            }
            updateRemotePlayers(message.players);
        }
        if (state.seed.length) updateCamera();
        if (typeof state.onGameConnected === "function") state.onGameConnected();
        return;
    }

    if (message.type === "state") {
        applySeed(message.seed);
        syncRemovedTrees(message.removed_trees);
        syncGroundItems(message.ground_items);
        if (message.players) {
            const localData = message.players[state.localPlayerId];
            if (localData && localData.character) {
                setCharacterPath(localData.character);
            }
            updateRemotePlayers(message.players);
        }
    }
}

export function fetchLocalPlayerData() {
    const serverId = getServerId();
    return fetch(`/api/player-data?server=${encodeURIComponent(serverId)}`, { credentials: "same-origin" })
        .then((response) => response.json())
        .then((data) => {
            const localData = data.data || {};
            if (Array.isArray(localData.inventory)) {
                state.playerInventory = localData.inventory.slice(0, INVENTORY_SIZE).map(normalizeInventorySlot);
                while (state.playerInventory.length < INVENTORY_SIZE) {
                    state.playerInventory.push(null);
                }
            } else {
                state.playerInventory = Array(INVENTORY_SIZE).fill(null);
            }
            renderInventory();
            if (localData.position) {
                state.playerWorldX = Number(localData.position.x) || 0;
                state.playerWorldY = Number(localData.position.y) || 0;
            }
            if (localData.character) {
                return setCharacterPath(localData.character);
            }
        })
        .catch(() => {});
}

export function connectToServer(timeoutMs = 10000) {
    const serverId = getServerId();
    return fetch(`/api/ws-token?server=${encodeURIComponent(serverId)}`, { credentials: "same-origin" })
        .then((response) => {
            if (!response.ok) throw new Error(`Token request failed (${response.status})`);
            return response.json();
        })
        .then((data) => {
            if (!data.token) throw new Error("Missing WebSocket token");
            const protocol = window.location.protocol === "https:" ? "wss" : "ws";
            state.ws = new WebSocket(`${protocol}://${window.location.host}/ws?server=${encodeURIComponent(serverId)}`);

            return new Promise((resolve, reject) => {
                let settled = false;
                const finish = (fn, value) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    fn(value);
                };

                const timer = setTimeout(
                    () => finish(reject, new Error("Connection timeout")),
                    timeoutMs,
                );

                state.ws.onopen = () => state.ws.send(JSON.stringify({ token: data.token }));
                state.ws.onmessage = async (event) => {
                    let message;
                    try {
                        message = JSON.parse(event.data);
                    } catch (e) {
                        return;
                    }
                    if (message.type === "welcome") {
                        await handleServerMessage(event);
                        finish(resolve);
                        return;
                    }
                    await handleServerMessage(event);
                };
                state.ws.onerror = () => finish(reject, new Error("WebSocket connection failed."));
                state.ws.onclose = (event) => {
                    state.ws = null;
                    if (!settled) {
                        const msg = event.code === 4004
                            ? "Already connected on another device"
                            : `WebSocket closed (${event.code})`;
                        finish(reject, new Error(msg));
                    }
                };
            });
        });
}
