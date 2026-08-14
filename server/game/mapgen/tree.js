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
    const key = `${rx},${ry}`;
    if (getTreeOrigin.cache.has(key)) {
        return getTreeOrigin.cache.get(key);
    }

    const rng = createRng(seed, rx, ry);
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

    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            const origin = getTreeOrigin(rx + dx, ry + dy, seed, treeRegionSize);
            const treeCol = origin.col;
            const treeBase = origin.row;
            const trunkRows = [treeBase - 1, treeBase - 2];
            if (col === treeCol && trunkRows.includes(row)) {
                return origin;
            }

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

    const trunkRows = [origin.row - 1, origin.row - 2];
    if (col === origin.col && trunkRows.includes(row)) {
        return "oak_log";
    }

    return "oak_tree_leaves";
}
