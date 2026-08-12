function createRng(seedValues, rx, ry) {
    let state = seedValues.reduce((acc, value, index) => {
        return (acc ^ (value + index * 31)) >>> 0;
    }, 0x9e3779b9);

    state ^= rx;
    state = (Math.imul(state, 0x9e3779b1) >>> 0) ^ ry;

    return () => {
        state = (Math.imul(state ^ (state >>> 15), 0x2b2bae35) ^ Math.imul(state ^ (state >>> 7), 0x1b873593)) >>> 0;
        return state / 4294967296;
    };
}

export function getLakeOrigin(rx, ry, seed, regionSize, lakeWidth, lakeHeight) {
    const key = `${rx},${ry}`;
    if (getLakeOrigin.cache.has(key)) {
        return getLakeOrigin.cache.get(key);
    }

    const rng = createRng(seed, rx, ry);
    const placeIndex = Math.floor(rng() * seed.length);

    if (seed[placeIndex] % 2 !== 0) {
        getLakeOrigin.cache.set(key, null);
        return null;
    }

    const baseCol = rx * regionSize;
    const baseRow = ry * regionSize;
    const col = baseCol + Math.floor(rng() * (regionSize - lakeWidth + 1));
    const row = baseRow + Math.floor(rng() * (regionSize - lakeHeight + 1));
    const origin = { col, row };
    getLakeOrigin.cache.set(key, origin);
    return origin;
}

getLakeOrigin.cache = new Map();

export function getBaseTileType(col, row, seed, regionSize, lakeWidth, lakeHeight) {
    const rx = Math.floor(col / regionSize);
    const ry = Math.floor(row / regionSize);

    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            const lake = getLakeOrigin(rx + dx, ry + dy, seed, regionSize, lakeWidth, lakeHeight);
            if (!lake) {
                continue;
            }
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
