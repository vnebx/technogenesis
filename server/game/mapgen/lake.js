// Creates a deterministic pseudo-random number generator for a given world seed + region coords.
// Uses a splitmix32-style hash: the seed array is folded into a single 32-bit state,
// then mixed with the region x/y so each region gets unique but reproducible randomness.
// this it very advanced math for me to understand, I recommend not touching this
function createRng(seedValues, rx, ry) {
    // Fold all seed values into one 32-bit integer using XOR mixing (golden ratio constant)
    let state = seedValues.reduce((acc, value, index) => {
        return (acc ^ (value + index * 31)) >>> 0;
    }, 0x9e3779b9);

    // Mix in region coordinates so each region produces different random sequences
    state ^= rx;
    state = (Math.imul(state, 0x9e3779b1) >>> 0) ^ ry;

    // Returns a generator function; each call advances the state and yields a float in [0, 1)
    return () => {
        state = (Math.imul(state ^ (state >>> 15), 0x2b2bae35) ^ Math.imul(state ^ (state >>> 7), 0x1b873593)) >>> 0;
        return state / 4294967296;
    };
}

export function getLakeOrigin(rx, ry, seed, regionSize, lakeWidth, lakeHeight) {
    const seedKey = seed.join(",");
    const key = `${seedKey}|${rx},${ry}`;
    if (getLakeOrigin.cache.has(key)) {
        return getLakeOrigin.cache.get(key);
    }

    const rng = createRng(seed, rx, ry);
    // Pick one seed value pseudo-randomly to decide if this region has a lake
    const placeIndex = Math.floor(rng() * seed.length);

    // Odd seed values disable lakes in this region (roughly 50% of regions get lakes)
    if (seed[placeIndex] % 2 !== 0) {
        getLakeOrigin.cache.set(key, null);
        return null;
    }

    // Place the lake's top-left corner within the region, ensuring it fits without overflowing
    const baseCol = rx * regionSize;
    const baseRow = ry * regionSize;
    const col = baseCol + Math.floor(rng() * (regionSize - lakeWidth + 1));
    const row = baseRow + Math.floor(rng() * (regionSize - lakeHeight + 1));
    const origin = { col, row }; // origin = top-left tile of the lake rectangle
    getLakeOrigin.cache.set(key, origin);
    return origin;
}

getLakeOrigin.cache = new Map();

export function getBaseTileType(col, row, seed, regionSize, lakeWidth, lakeHeight) {
    const rx = Math.floor(col / regionSize);
    const ry = Math.floor(row / regionSize);

    // Check this region and all 8 neighbors — a lake in an adjacent region could overlap into this tile
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            const lake = getLakeOrigin(rx + dx, ry + dy, seed, regionSize, lakeWidth, lakeHeight);
            if (!lake) {
                continue;
            }
            // Test if the tile falls inside the lake's rectangle
            if (
                col >= lake.col &&
                col < lake.col + lakeWidth &&
                row >= lake.row &&
                row < lake.row + lakeHeight
            ) {
                return "water";
            }
        }
    }

    return "grass";
}
