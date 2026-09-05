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
// Continents, oceans & inland seas — a deterministic continent-base world.
// Continent centers sit on a square lattice with `CONTINENT_SPACING` tiles
// between every two centers. Each continent is an irregular landmass roughly
// `CONTINENT_SIZE` tiles across (built from overlapping anchor blobs — never a
// perfect circle), so straight-line water between two neighbours is ~
// `CONTINENT_SPACING - CONTINENT_SIZE` tiles wide. This "~5k of continent,
// ~5k of sea" pattern repeats forever in every direction, giving an infinite
// world of continents scattered across the ocean.
// Centers get a small random warp (`CENTER_WARP`) so it is not a perfect grid,
// each continent has its own elongation axis, and a fine `INLAND_SPACING` field
// softens coasts and carves small inland seas and lakes that never dwarf the
// continent around them. Tiles with total height below `SEA_LEVEL` are water.
// ---------------------------------------------------------------------------

const heightCache = new Map();

// One lattice corner's stored value. `salt` keeps independent fields distinct.
function getHeightPoint(cx, cy, seed, salt) {
    const key = `${seed.join(",")}|${salt}|${cx},${cy}`;
    if (heightCache.has(key)) return heightCache.get(key);
    const rng = createRng(seed, cx + salt, cy + salt);
    const value = rng();
    heightCache.set(key, value);
    return value;
}

// Bilinear interpolation of one square lattice of cell-corner heights.
function sampleField(col, row, seed, salt, spacing) {
    const c0 = Math.floor(col / spacing);
    const r0 = Math.floor(row / spacing);
    const fx = (col - c0 * spacing) / spacing;
    const fy = (row - r0 * spacing) / spacing;
    const h00 = getHeightPoint(c0, r0, seed, salt);
    const h10 = getHeightPoint(c0 + 1, r0, seed, salt);
    const h01 = getHeightPoint(c0, r0 + 1, seed, salt);
    const h11 = getHeightPoint(c0 + 1, r0 + 1, seed, salt);
    return h00 + (h10 - h00) * fx + (h01 - h00) * fy + (h00 - h10 - h01 + h11) * fx * fy;
}

// The center of the continent that owns lattice cell (hcx, hcy), deterministically
// warped by up to `CENTER_WARP` tiles so continents are not perfectly aligned.
function continentCenter(hcx, hcy, seed) {
    const key = `center|${seed.join(",")}|${hcx},${hcy}`;
    if (heightCache.has(key)) return heightCache.get(key);
    const warp = CONFIG.CENTER_WARP ?? 0;
    const S = CONFIG.CONTINENT_SPACING;
    const wx = warp ? (createRng(seed, hcx * 31 + 7, hcy * 31 + 7)() - 0.5) * 2 * warp : 0;
    const wy = warp ? (createRng(seed, hcx * 31 + 13, hcy * 31 + 13)() - 0.5) * 2 * warp : 0;
    const center = { x: hcx * S + wx, y: hcy * S + wy };
    heightCache.set(key, center);
    return center;
}

// Optional inland sea for a continent: with `CONTINENT_SEA_CHANCE` probability a
// continent hides a small sea/lake completely enclosed inside it. It sits well
// inside the landmass (offset + radius bounded well below the coast) so it never
// dwarfs the continent, and it ends up surrounded by a ring of land and beach.
function continentInlandSea(hcx, hcy, seed) {
    const key = `sea|${seed.join(",")}|${hcx},${hcy}`;
    if (heightCache.has(key)) return heightCache.get(key);
    const rng = createRng(seed, hcx * 131 + 17, hcy * 131 + 19);
    let sea = null;
    if ((CONFIG.CONTINENT_SEA_CHANCE ?? 0) > 0 && rng() < CONFIG.CONTINENT_SEA_CHANCE) {
        const S = CONFIG.CONTINENT_SPACING;
        const base = CONFIG.CONTINENT_SIZE / 2;
        const ox = (rng() - 0.5) * 2 * CONFIG.INLAND_SEA_OFFSET_FRAC * base;
        const oy = (rng() - 0.5) * 2 * CONFIG.INLAND_SEA_OFFSET_FRAC * base;
        const rx = base * CONFIG.INLAND_SEA_RADIUS_FRAC * (0.6 + rng() * 0.8);
        const ry = base * CONFIG.INLAND_SEA_RADIUS_FRAC * (0.6 + rng() * 0.8);
        sea = { x: hcx * S + ox, y: hcy * S + oy, rx, ry };
    }
    heightCache.set(key, sea);
    return sea;
}

// ---------------------------------------------------------------------------
// A continent's silhouette. Instead of a plain disc, each continent is built
// from several overlapping "anchor" blobs: a big central core plus a few arms
// placed at random offsets with random sizes. The coastline is the contour of
// the summed falloffs, so continents come out as irregular, roughly-5k-wide
// landmasses with bays, peninsulas and island arms — never perfect circles.
// A per-continent elongation axis stretches some continents long and skinny
// (Chile-like) and squashes others. Everything is cached and deterministic.
// ---------------------------------------------------------------------------
function continentAnchorSet(hcx, hcy, seed) {
    const key = `anch|${seed.join(",")}|${hcx},${hcy}`;
    if (heightCache.has(key)) return heightCache.get(key);
    const base = CONFIG.CONTINENT_SIZE / 2;
    const rng = createRng(seed, hcx * 10007 + 29, hcy * 10007 + 31);

    const eAngle = rng() * Math.PI * 2;
    const eLen = 1 + rng() * (CONFIG.CONTINENT_ELONGATION ?? 0.35);

    const anchors = [];
    // Central core: guarantees the middle of the continent is always solid land,
    // which keeps the spawn, inland seas and river sources safely in a core.
    anchors.push({ x: 0, y: 0, r: base * (0.55 + rng() * 0.25) });
    const arms = 5 + Math.floor(rng() * 4); // 5..8 irregular arms
    for (let i = 0; i < arms; i++) {
        const ang = rng() * Math.PI * 2;
        const dist = base * (0.28 + rng() * 0.36);
        const r = base * (0.36 + rng() * 0.3);
        anchors.push({ x: Math.cos(ang) * dist, y: Math.sin(ang) * dist, r });
    }

    const shape = {
        cos: Math.cos(eAngle),
        sin: Math.sin(eAngle),
        eLen,
        anchors,
    };
    heightCache.set(key, shape);
    return shape;
}

function getHeight(col, row, seed) {
    const S = CONFIG.CONTINENT_SPACING;
    const hcx = Math.round(col / S);
    const hcy = Math.round(row / S);
    const center = continentCenter(hcx, hcy, seed);
    const shape = continentAnchorSet(hcx, hcy, seed);

    // Rotate to the continent's elongation frame, squashing the perpendicular
    // axis so some continents come out stretched along `eAngle`.
    const cx = col - center.x;
    const cy = row - center.y;
    const rx = cx * shape.cos + cy * shape.sin;
    const ry = (-cx * shape.sin + cy * shape.cos) / shape.eLen;

    // Landiness: sum of overlapping blob falloffs (≈2..4 deep inside the core,
    // dropping to 0 in open ocean). The coast is where the sum crosses ~1.
    let landiness = 0;
    for (const a of shape.anchors) {
        const dx = rx - a.x;
        const dy = ry - a.y;
        const d = Math.hypot(dx, dy);
        if (d < a.r) landiness += 1 - d / a.r;
    }
    let h = CONFIG.CONTINENT_WEIGHT * (landiness - 1);

    // Inland detail: softens coasts and carves small inland seas/lakes.
    const inland = sampleField(col, row, seed, 1000003, CONFIG.INLAND_SPACING);
    h += (inland - 0.5) * CONFIG.INLAND_WEIGHT;

    // An optional enclosed inland sea: sinks the whole ellipse below sea level.
    // The spawn continent never gets one, so a river or lake can't swallow it.
    const sea = (hcx === 0 && hcy === 0) ? null : continentInlandSea(hcx, hcy, seed);
    if (sea) {
        const ex = (col - sea.x) / sea.rx;
        const ey = (row - sea.y) / sea.ry;
        if (ex * ex + ey * ey < 1) h -= 2;
    }

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