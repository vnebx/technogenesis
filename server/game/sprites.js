import { CONFIG, state } from "./state.js";

export function setupPixelSpriteCanvas(canvas, ctx) {
    canvas.width = CONFIG.spriteSize;
    canvas.height = CONFIG.spriteSize;
    canvas.style.width = `${CONFIG.tileWidth}px`;
    canvas.style.height = `${CONFIG.tileWidth}px`;
    canvas.style.display = "block";
    canvas.style.imageRendering = "pixelated";
    ctx.imageSmoothingEnabled = false;
}

export function drawPixelSprite(ctx, img) {
    ctx.clearRect(0, 0, CONFIG.spriteSize, CONFIG.spriteSize);
    ctx.drawImage(img, 0, 0, CONFIG.spriteSize, CONFIG.spriteSize);
}
export const CHARACTER_MANIFEST = {
    "assets/characters/basicrobot": {
        backward: 2,
        backwarduse: 1,
        forward: 2,
        forwarduse: 1,
        idlebackward: 1,
        idleforward: 1,
        idleleft: 1,
        idleright: 1,
        left: 2,
        leftuse: 1,
        right: 2,
        rightuse: 1,
    },
    "assets/characters/basicrobot2": {
        backward: 2,
        backwarduse: 1,
        forward: 2,
        forwarduse: 1,
        idlebackward: 1,
        idleforward: 1,
        idleleft: 1,
        idleright: 1,
        left: 2,
        leftuse: 1,
        right: 2,
        rightuse: 1,
    },
};

export function getCharacterFrames(character) {
    return CHARACTER_MANIFEST[character] || CHARACTER_MANIFEST[state.characterPath] || CHARACTER_MANIFEST[CONFIG.defaultCharacter] || {};
}

export function discoverFrames(character) {
    state.characterFrames[character] = getCharacterFrames(character);
    return Promise.resolve();
}

export function preloadImage(src) {
    if (state.imageCache[src]) {
        const cached = state.imageCache[src];
        if (cached.complete && cached.naturalWidth > 0) return Promise.resolve(cached);
    }
    return new Promise((resolve) => {
        const img = state.imageCache[src] || new Image();
        state.imageCache[src] = img;
        img.onload = () => {
            if (img.decode) {
                img.decode().catch(() => {}).then(() => resolve(img));
            } else {
                resolve(img);
            }
        };
        img.onerror = () => {
            resolve(img);
        };
        if (!img.src || !img.src.endsWith(src)) {
            img.src = src;
        }
    });
}

export async function preloadSprites(character) {
    const frames = getCharacterFrames(character);
    const jobs = [];
    for (const [animName, count] of Object.entries(frames)) {
        for (let i = 0; i < count; i++) {
            jobs.push(preloadImage(`${character}/${animName}${i}.png`));
        }
    }
    await Promise.all(jobs);
    state.preloadedCharacters.add(character);
}

export async function preloadAllAssets() {
    const jobs = [];
    for (const [character, anims] of Object.entries(CHARACTER_MANIFEST)) {
        for (const [animName, count] of Object.entries(anims)) {
            for (let i = 0; i < count; i++) {
                jobs.push(preloadImage(`${character}/${animName}${i}.png`));
            }
        }
        state.preloadedCharacters.add(character);
        state.characterFrames[character] = anims;
    }
    for (const type of CONFIG.TILE_TYPES) {
        jobs.push(preloadImage(`assets/tiles/${type}.png`));
    }
    jobs.push(preloadImage("assets/ui/inventory/slot.png"));
    jobs.push(preloadImage("assets/ui/items/oak_log_chunk.png"));
    await Promise.all(jobs);
}

export function spriteBackground(src) {
    return src;
}

export function setCharacterPath(newPath) {
    if (!newPath || newPath === state.characterPath) return;
    state.characterPath = newPath;
    discoverFrames(state.characterPath);
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

export function ensureRemoteCharacter(character) {
    if (!character) return;
    discoverFrames(character);
    if (!state.preloadedCharacters.has(character)) {
        preloadSprites(character);
    }
}

export function preloadTiles() {
    for (const type of CONFIG.TILE_TYPES) {
        preloadImage(`assets/tiles/${type}.png`);
    }
}

export function loadImage(src) {
    return preloadImage(src);
}

// Workaround for background gaps between tiles on some browsers
export async function loadTileColors() {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    for (const type of CONFIG.TILE_TYPES) {
        const img = await loadImage(`assets/tiles/${type}.png`);
        if (!img || !img.naturalWidth) continue;
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);
        let data;
        try {
            data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        } catch (e) {
            continue;
        }
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
