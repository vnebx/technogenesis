import { CONFIG, state } from "./state.js";
// Every character has a set of animations for each direction (up, down, left, right) and idle states.
// For diagonals vertical animations are used
export function imageExists(src) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(true);
        img.onerror = () => resolve(false);
        img.src = src;
    });
}
// Animations available:
// idle, up, down, left, right, use
// when creating png's for each animation put the animation name, and a number starting from 0
// for example: idle0.png, idle1.png, idle2.png, up0.png, up1.png, up2.png, etc
export async function discoverFrames(character) {
    const frames = state.characterFrames[character] || (state.characterFrames[character] = {});
    // For each animation direction, probe images named `name0.png, name1.png, ...`
    // and count how many exist by testing until one fails to load.
    for (const name of CONFIG.directions) {
        let count = 0;
        while (await imageExists(`${character}/${name}${count}.png`)) {
            count++;
        }
        frames[name] = count;
    }
}

export function getCharacterFrames(character) {
    return state.characterFrames[character] || state.characterFrames[state.characterPath] || {};
}

export async function preloadSprites(character) {
    if (state.preloadedCharacters.has(character)) return;
    const frames = getCharacterFrames(character);
    const jobs = [];
    for (const name of CONFIG.directions) {
        for (let i = 0; i < (frames[name] || 0); i++) {
            const src = `${character}/${name}${i}.png`;
            if (state.imageCache[src]) continue;
            const img = new Image();
            img.src = src;
            state.imageCache[src] = img;
            jobs.push(img.decode ? img.decode().catch(() => {}) : Promise.resolve());
        }
    }
    await Promise.all(jobs);
    // After preloading, convert each sprite to a data URL so it can be set as a
    // CSS background-image. This avoids browser redraws / caching issues and lets
    // us swap sprites instantly without re-fetching from the server.
    // some issues may happen if disconecter from internet while on multiplayer, but thats fixable
    for (const name of CONFIG.directions) {
        for (let i = 0; i < (frames[name] || 0); i++) {
            const src = `${character}/${name}${i}.png`;
            const img = state.imageCache[src];
            if (img && img.complete && img.naturalWidth > 0 && !state.spriteDataUrls.has(src)) {
                try {
                    const canvas = document.createElement("canvas");
                    canvas.width = img.naturalWidth;
                    canvas.height = img.naturalHeight;
                    canvas.getContext("2d").drawImage(img, 0, 0);
                    state.spriteDataUrls.set(src, canvas.toDataURL("image/png"));
                } catch (e) {
                    /* keep raw path fallback */
                }
            }
        }
    }
    state.preloadedCharacters.add(character);
}

// Returns the data-URL version of a sprite for use as a CSS background.
// Falls back to the raw path (or lazy-converts on demand) if not yet converted.
export function spriteBackground(src) {
    if (state.spriteDataUrls.has(src)) return state.spriteDataUrls.get(src);
    const img = state.imageCache[src];
    if (img && img.complete && img.naturalWidth > 0) {
        try {
            const canvas = document.createElement("canvas");
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            canvas.getContext("2d").drawImage(img, 0, 0);
            const url = canvas.toDataURL("image/png");
            state.spriteDataUrls.set(src, url);
            return url;
        } catch (e) {
            return src;
        }
    }
    return src;
}

export async function setCharacterPath(newPath) {
    if (!newPath || newPath === state.characterPath) return;
    state.characterPath = newPath;
    await discoverFrames(state.characterPath);
    await preloadSprites(state.characterPath);
    state.animFrame = 0;
    state.animTimer = 0;
}

export function nextAnimFrame(name, current) {
    const total = getCharacterFrames(state.characterPath)[name];
    if (!total || total <= 1) return 0;
    const next = current + 1;
    return next < total ? next : 0;
}

export function getFacingDirection() {
    return state.direction === "idle" ? state.lastDirection : state.direction;
}

export function getCurrentSpriteName() {
    if (state.using) return `${getFacingDirection()}use`;
    return state.direction === "idle" ? `idle${state.lastDirection}` : state.direction;
}

export async function ensureRemoteCharacter(character) {
    if (!character || state.preloadedCharacters.has(character)) return;
    await discoverFrames(character);
    await preloadSprites(character);
}

export function preloadTiles() {
    for (const type of CONFIG.TILE_TYPES) {
        const src = `assets/tiles/${type}.png`;
        if (!state.imageCache[src]) {
            const img = new Image();
            img.src = src;
            state.imageCache[src] = img;
        }
    }
}

export function loadImage(src) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = src;
    });
}
// This is sort of a workaround for black backround lines appearing between tiles on some browsers
// Just put a seamless gap color for the specific tile used and fine
export async function loadTileColors() {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    for (const type of CONFIG.TILE_TYPES) {
        const img = await loadImage(`assets/tiles/${type}.png`);
        if (!img) continue;
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);
        let data;
        try {
            data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        } catch (e) {
            // Reading pixel data fails cross-origin (tiled canvases); skip averaging for this tile
            continue;
        }
        // Average the RGB of all non-transparent pixels to derive a representative
        // background color for the tile (used to fill gaps between tile edges).
        let r = 0, g = 0, b = 0, count = 0;
        for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] < 50) continue;
            r += data[i];
            g += data[i + 1];
            b += data[i + 2];
            count++;
        }
        if (count > 0) {
            state.tileColors[type] = `rgb(${Math.round(r / count)}, ${Math.round(g / count)}, ${Math.round(b / count)})`;
        }
    }
}
