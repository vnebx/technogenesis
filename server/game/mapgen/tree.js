// Deterministic PRNG identical to lake.js — folds the seed array into a 32-bit state,
// mixes in region coords, and returns a generator yielding floats in [0, 1).
// this is very advanced math for me to understand, I recommend not touching it
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

export function getTreeOrigin(rx, ry, seed, treeRegionSize) {
    const seedKey = seed.join(",");
    const key = `${seedKey}|${rx},${ry}`;
    if (getTreeOrigin.cache.has(key)) {
        return getTreeOrigin.cache.get(key);
    }

    const rng = createRng(seed, rx, ry);
    // Randomly position the tree trunk within the region
    // (minus 3 columns / 5 rows so the trunk + branches stay inside the region)
    const baseCol = rx * treeRegionSize + Math.floor(rng() * (treeRegionSize - 3));
    const baseRow = ry * treeRegionSize + 5 + Math.floor(rng() * (treeRegionSize - 5));
    const origin = { col: baseCol, row: baseRow };
    getTreeOrigin.cache.set(key, origin);
    return origin;
}

getTreeOrigin.cache = new Map();

export function getTreeAt(col, row, seed, regionSize, treeRegionSize) {
    const rx = Math.floor(col / regionSize);
    const ry = Math.floor(row / regionSize);

    // Check this region and its 8 neighbors — a tree's trunk/branches can spill into nearby tiles
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            const origin = getTreeOrigin(rx + dx, ry + dy, seed, treeRegionSize);
            const treeCol = origin.col;
            const treeBase = origin.row;
            // Trunk occupies the 2 rows directly above the origin (a vertical "log")
            const trunkRows = [treeBase - 1, treeBase - 2];
            if (col === treeCol && trunkRows.includes(row)) {
                return origin;
            }

            // Canopy/leaves occupy the 2 rows above the trunk, spanning 3 columns wide
            const leafRows = [treeBase - 3, treeBase - 4];
            if (col >= treeCol - 1 && col <= treeCol + 1 && leafRows.includes(row)) {
                return origin;
            }
        }
    }

    return null;
}

export function getTreeTile(col, row, seed, regionSize, treeRegionSize) {
    const origin = getTreeAt(col, row, seed, regionSize, treeRegionSize);
    if (!origin) return null;

    // Log tiles are the trunk; everything else in the tree footprint is leaves
    const trunkRows = [origin.row - 1, origin.row - 2];
    if (col === origin.col && trunkRows.includes(row)) {
        return "oak_log";
    }

    return "oak_tree_leaves";
}
