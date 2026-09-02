import { CONFIG, state } from "./state.js";
import { getCharacterFrames, ensureRemoteCharacter, spriteBackground } from "./sprites.js";
// Players animation and movement handling for remote players, may need a change if new player actions are introduced
export function createRemotePlayer(playerId) {
    const player = document.createElement("div");
    player.style.width = `${CONFIG.tileWidth}px`;
    player.style.height = `${CONFIG.tileWidth}px`;
    player.style.position = "fixed";
    player.style.top = "0";
    player.style.left = "0";
    player.style.backgroundSize = "contain";
    player.style.backgroundPosition = "center";
    player.style.backgroundRepeat = "no-repeat";
    player.style.zIndex = "10";
    player.style.pointerEvents = "none";
    // Own compositor layer so sprite-background swaps don't repaint the viewport.
    player.style.transform = "translateZ(0)";
    player.style.willChange = "transform";
    state.viewportEl.appendChild(player);
    state.remotePlayers.set(playerId, player);
    return player;
}

function normalizeRemoteState(entity) {
    if (!entity || typeof entity !== "object") {
        return { position: { x: 0, y: 0 }, animation: "idlebackward", character: state.characterPath };
    }
    const position = entity.position || { x: 0, y: 0 };
    return {
        position: { x: Number(position.x) || 0, y: Number(position.y) || 0 },
        animation: entity.animation || "idlebackward",
        character: entity.character || state.characterPath,
    };
}

export function updateRemotePlayers(players) {
    const knownIds = new Set();

    for (const [playerId, payload] of Object.entries(players || {})) {
        if (playerId === state.localPlayerId) continue;
        knownIds.add(playerId);

        const s = normalizeRemoteState(payload);
        if (!state.remotePlayers.has(playerId)) createRemotePlayer(playerId);

        const remoteChar = s.character || state.characterPath;
        ensureRemoteCharacter(remoteChar);

        const rawAnimation = s.animation || "idlebackward";
        const frames = getCharacterFrames(remoteChar);
        const animation = frames[rawAnimation] ? rawAnimation : "idlebackward";
        const target = state.remoteTargets.get(playerId);
        if (target && target.character === remoteChar) {
            // Already tracking this player: update the destination and interpolate toward it.
            target.tx = s.position.x;
            target.ty = s.position.y;
            // If the gap is very large (e.g. player teleported), snap instantly instead of interpolating
            const gap = Math.hypot(s.position.x - target.x, s.position.y - target.y);
            if (gap > CONFIG.tileWidth * 3) {
                target.x = s.position.x;
                target.y = s.position.y;
            }
            if (target.animation !== animation) {
                target.animation = animation;
                state.remoteAnim.set(playerId, { frame: 0, timer: 0 });
            }
        } else {
            state.remoteTargets.set(playerId, {
                tx: s.position.x,
                ty: s.position.y,
                x: s.position.x,
                y: s.position.y,
                animation,
                character: remoteChar,
            });
            state.remoteAnim.set(playerId, { frame: 0, timer: 0 });
        }
    }

    for (const [playerId, player] of state.remotePlayers) {
        if (!knownIds.has(playerId)) {
            player.remove();
            state.remotePlayers.delete(playerId);
            state.remoteTargets.delete(playerId);
            state.remoteAnim.delete(playerId);
        }
    }
}

export function updateRemotePlayersRender(dt) {
    for (const [playerId, target] of state.remoteTargets) {
        const anim = state.remoteAnim.get(playerId);
        if (!anim) continue;

        const dx = target.tx - target.x;
        const dy = target.ty - target.y;
        const dist = Math.hypot(dx, dy);
        if (dist > 0.5) {
            // Move toward the target each frame; speed up (4x) when far behind to catch up
            const catchUp = dist > CONFIG.moveSpeed ? CONFIG.moveSpeed * 4 : CONFIG.moveSpeed;
            const step = Math.min(dist, catchUp * dt);
            target.x += (dx / dist) * step;
            target.y += (dy / dist) * step;
        } else {
            target.x = target.tx;
            target.y = target.ty;
        }

        if (target.animation && target.animation !== "idle" && !target.animation.startsWith("idle")) {
            anim.timer += dt * 1000;
            if (anim.timer >= CONFIG.animInterval) {
                anim.timer = 0;
                const total = getCharacterFrames(target.character)[target.animation] || 1;
                anim.frame = (anim.frame + 1) % (total || 1);
            }
        } else {
            anim.frame = 0;
            anim.timer = 0;
        }

        const player = state.remotePlayers.get(playerId);
        if (!player) continue;
        const totalFrames = getCharacterFrames(target.character)[target.animation] || 1;
        const frame = anim.frame % (totalFrames || 1);
        const spritePath = `${target.character}/${target.animation}${frame}.png`;
        const left = Math.round((target.x - Math.round(state.cameraX)) * state.scaleX) / state.scaleX;
        const top = Math.round((target.y - Math.round(state.cameraY)) * state.scaleY) / state.scaleY;

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
