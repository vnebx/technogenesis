import { CONFIG } from "../state.js";

// Deterministic PRNG — folds the seed array into a 32-bit state, mixes in cell
// coords, and returns a generator yielding floats in [0, 1).
// this is very advanced math for me to understand, I recommend not touching it
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

// Trees live on a global lattice: the world is divided into cells of
// CONFIG.TREE_SPACING tiles and every cell can hold at most one tree, placed with
// a random jitter. The tree's whole footprint (trunk + canopy, 3 wide x 4 tall)
// is guaranteed to fit inside its own cell, so two trees can never touch — not
// even across world regions — and the trees stay spread evenly everywhere. No
// region scanning needed: a tile can only belong to the tree in its own cell.
function cellTreeOrigin(cx, cy, rng, spacing) {
    const left = cx * spacing;
    const top = cy * spacing;
    // Containment bounds: footprint cols are [trunkCol-1, trunkCol+1] and rows are
    // [trunkRow-4, trunkRow-1], so keep those inside the cell.
    const col = left + 1 + Math.floor(rng() * Math.max(1, spacing - 2));
    const row = top + 4 + Math.floor(rng() * Math.max(1, spacing - 3));
    return { col, row };
}

function computeCellTree(cx, cy, seed, spacing) {
    const rng = createRng(seed, cx, cy);
    const density = CONFIG.TREE_CELL_DENSITY ?? 1;
    if (density < 1 && rng() >= density) {
        return null;
    }
    return { ...cellTreeOrigin(cx, cy, rng, spacing), cx, cy };
}

const treeCellCache = new Map();

function getCellTree(cx, cy, seed, spacing) {
    const seedKey = seed.join(",");
    const key = `${seedKey}|${cx},${cy}`;
    if (treeCellCache.has(key)) {
        return treeCellCache.get(key);
    }
    const tree = computeCellTree(cx, cy, seed, spacing);
    treeCellCache.set(key, tree);
    return tree;
}

// Returns the tree origin covering this tile, or null. The origin is a logical
// point ({col, row}) used to identify the tree (removed-tree sync, chopping).
export function getTreeAt(col, row, seed) {
    if (!seed || !seed.length) return null;
    const spacing = CONFIG.TREE_SPACING || 5;
    const cx = Math.floor(col / spacing);
    const cy = Math.floor(row / spacing);
    const tree = getCellTree(cx, cy, seed, spacing);
    if (!tree) return null;
    // Footprint: trunk = the 2 rows directly above the origin at its column,
    // canopy/leaves = the 2 rows above the trunk spanning 3 columns.
    const isTrunk = col === tree.col && (row === tree.row - 1 || row === tree.row - 2);
    const isLeaf =
        (row === tree.row - 3 || row === tree.row - 4) &&
        col >= tree.col - 1 && col <= tree.col + 1;
    return isTrunk || isLeaf ? tree : null;
}

export function getTreeTile(col, row, seed) {
    const origin = getTreeAt(col, row, seed);
    if (!origin) return null;

    // Log tiles are the trunk; everything else in the tree footprint is leaves
    const trunkRows = [origin.row - 1, origin.row - 2];
    if (col === origin.col && trunkRows.includes(row)) {
        return "oak_log";
    }

    return "oak_tree_leaves";
}

export function clearTreeCache() {
    treeCellCache.clear();
}