import { CONFIG } from "../state.js";

// Deterministic PRNG — folds the seed array + cell coords into a 32-bit state.
function createRng(seedValues, cx, cy) {
    let state = seedValues.reduce((acc, value, index) => {
        return (acc ^ (value + index * 31)) >>> 0;
    }, 0x9e3779b9);

    state ^= cx;
    state = (Math.imul(state, 0x9e3779b1) >>> 0) ^ cy;

    return () => {
        state = (Math.imul(state ^ (state >>> 15), 0x2b2bae35) ^ Math.imul(state ^ (state >>> 7), 0x1b873593)) >>> 0;
        return state / 4294967296;
    };
}

// ---------------------------------------------------------------------------
// Continents & seas — a smooth deterministic height field.
// The world is divided into cells of `CONTINENT_SPACING`; each cell corner gets
// a random height and tiles are bilinearly interpolated. Tiles below `SEA_LEVEL`
// are sea, so the result is a world of islands and continents where the seas
// naturally wrap around every piece of land.
// ---------------------------------------------------------------------------

const heightCache = new Map();

function heightPointKey(seed, cx, cy) {
    return `${seed.join(",")}|${cx},${cy}`;
}

function getHeightPoint(cx, cy, seed) {
    const key = heightPointKey(seed, cx, cy);
    if (heightCache.has(key)) return heightCache.get(key);
    const rng = createRng(seed, cx, cy);
    const value = rng();
    heightCache.set(key, value);
    return value;
}

function getHeight(col, row, seed) {
    const spacing = CONFIG.CONTINENT_SPACING;
    const c0 = Math.floor(col / spacing);
    const r0 = Math.floor(row / spacing);
    const fx = (col - c0 * spacing) / spacing;
    const fy = (row - r0 * spacing) / spacing;
    const h00 = getHeightPoint(c0, r0, seed);
    const h10 = getHeightPoint(c0 + 1, r0, seed);
    const h01 = getHeightPoint(c0, r0 + 1, seed);
    const h11 = getHeightPoint(c0 + 1, r0 + 1, seed);
    let h = h00 + (h10 - h00) * fx + (h01 - h00) * fy + (h00 - h10 - h01 + h11) * fx * fy;

    // Guarantee the spawn area (around the origin) is always land: raise the
    // height near (0,0) with a radial boost that fades out to `SPAWN_BOOST_RADIUS`.
    const d = Math.hypot(col, row);
    if (d < CONFIG.SPAWN_BOOST_RADIUS) {
        h += CONFIG.SPAWN_HEIGHT_BOOST * (1 - d / CONFIG.SPAWN_BOOST_RADIUS);
    }
    return h;
}

// ---------------------------------------------------------------------------
// Rivers — a water path from the interior of an island down to the sea.
// The world is divided into source cells of `RIVER_SPACING`. A cell may hold
// one river that starts on nicely elevated land inside the island and walks
// downhill (lowest of the 8 neighbours, with a little meander) until it reaches
// a sea tile. Rivers are `RIVER_WIDTH` tiles wide. Paths are cached per cell.
// ---------------------------------------------------------------------------

const riverSourceCache = new Map();
const riverPathCache = new Map();

function riverKey(seed, cx, cy) {
    return `${seed.join(",")}|${cx},${cy}`;
}

const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIRS8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

// A candidate river start: a deterministic point on land inside its cell that
// is elevated enough that the river will take a real downhill trip to the sea.
function getRiverSource(cx, cy, seed) {
    const key = riverKey(seed, cx, cy);
    if (riverSourceCache.has(key)) return riverSourceCache.get(key);

    const spacing = CONFIG.RIVER_SPACING;
    const left = cx * spacing;
    const top = cy * spacing;
    const rng = createRng(seed, cx + 6000, cy + 6000);

    const density = CONFIG.RIVER_DENSITY ?? 1;
    if (density < 1 && rng() >= density) {
        riverSourceCache.set(key, null);
        return null;
    }

    const col = left + 2 + Math.floor(rng() * Math.max(1, spacing - 4));
    const row = top + 2 + Math.floor(rng() * Math.max(1, spacing - 4));
    const minH = CONFIG.SEA_LEVEL + (CONFIG.RIVER_MIN_ELEVATION ?? 0.1);
    if (getHeight(col, row, seed) < minH) {
        riverSourceCache.set(key, null);
        return null;
    }

    const source = { col, row, cx, cy };
    riverSourceCache.set(key, source);
    return source;
}

// Walks downhill from the source until the sea, caching the 1-wide center line.
function getRiverPath(source, seed) {
    const key = riverKey(seed, source.cx, source.cy);
    if (riverPathCache.has(key)) return riverPathCache.get(key);

    const seaLevel = CONFIG.SEA_LEVEL;
    const maxSteps = CONFIG.RIVER_MAX_LENGTH ?? 70;

    let c = source.col;
    let r = source.row;
    let pc = c, pr = r;   // previous tile (avoid walking straight back up)
    const rng = createRng(seed, source.cx * 991, source.cy * 977);

    const center = [];
    const line = new Set();
    let reachedSea = false;

    for (let step = 0; step < maxSteps; step++) {
        line.add(`${c},${r}`);
        center.push(`${c},${r}`);
        if (getHeight(c, r, seed) < seaLevel) {
            reachedSea = true;
            break;
        }

        // Pick the lowest of the 8 neighbours (strictly downhill if possible).
        let bestC = c, bestR = r, bestH = getHeight(c, r, seed);
        for (const [dc, dr] of DIRS8) {
            const nc = c + dc, nr = r + dr;
            if (nc === pc && nr === pr) continue;
            const nh = getHeight(nc, nr, seed);
            if (nh < bestH) {
                bestC = nc;
                bestR = nr;
                bestH = nh;
            }
        }

        // Occasionally meander sideways so the river wobbles instead of sprinting.
        if (rng() < 0.3) {
            const pick = DIRS4[Math.floor(rng() * DIRS4.length)];
            bestC = c + pick[0];
            bestR = r + pick[1];
            if (bestC === pc && bestR === pr) {
                bestC = c - pick[0];
                bestR = r - pick[1];
            }
        }

        if (bestC === c && bestR === r) {
            // Stuck in a basin: shove the river in a random direction.
            const b = DIRS4[Math.floor(rng() * DIRS4.length)];
            bestC = c + b[0];
            bestR = r + b[1];
            if (bestC === pc && bestR === pr) {
                bestC = c - b[0];
                bestR = r - b[1];
            }
        }

        pc = c;
        pr = r;
        c = bestC;
        r = bestR;
    }

    // Rivers are `RIVER_WIDTH` tiles wide: expand the 1-wide center line into a
    // solid band `RIVER_WIDTH` wide.
    let path = null;
    if (reachedSea) {
        const hw = Math.max(0, Math.floor((CONFIG.RIVER_WIDTH ?? 3) / 2));
        path = new Set();
        for (const tile of center) {
            const [cc, rr] = tile.split(",").map(Number);
            for (let dc = -hw; dc <= hw; dc++) {
                for (let dr = -hw; dr <= hw; dr++) {
                    path.add(`${cc + dc},${rr + dr}`);
                }
            }
        }
    }
    riverPathCache.set(key, path);
    return path;
}

function isInRiver(col, row, seed) {
    const spacing = CONFIG.RIVER_SPACING;
    const reachCells = Math.max(2, Math.ceil((CONFIG.RIVER_MAX_LENGTH ?? 70) / spacing) + 1);
    const cx = Math.floor(col / spacing);
    const cy = Math.floor(row / spacing);
    for (let dy = -reachCells; dy <= reachCells; dy++) {
        for (let dx = -reachCells; dx <= reachCells; dx++) {
            const source = getRiverSource(cx + dx, cy + dy, seed);
            if (!source) continue;
            const path = getRiverPath(source, seed);
            if (path && path.has(`${col},${row}`)) return true;
        }
    }
    return false;
}

// ---------------------------------------------------------------------------

export function getBaseTileType(col, row, seed) {
    if (getHeight(col, row, seed) < CONFIG.SEA_LEVEL) return "water";
    if (isInRiver(col, row, seed)) return "water";
    return "grass";
}

export function clearTerrainCache() {
    heightCache.clear();
    riverSourceCache.clear();
    riverPathCache.clear();
}