export const SPRITE_SIZE = 16;
export const TILE_SCALE = 4;

export const CONFIG = {
    spriteSize: SPRITE_SIZE,
    tileScale: TILE_SCALE,
    tileWidth: SPRITE_SIZE * TILE_SCALE,
    lakeWidth: 4,
    lakeHeight: 3,
    regionSize: 32,
    // TREE QUANTITY CONTROL
    // Trees grow on a global lattice instead of per-region. The world is divided
    // into cells of `TREE_SPACING` tiles and each cell holds at most one tree,
    // so every tree is spread evenly across the whole map and can never overlap
    // another (its trunk + canopy always stay inside its own cell).
    //   `TREE_SPACING`  — distance between lattice slots in tiles. Smaller =
    //                     denser forest. 5 = dense, 8 = open woodland.
    //   `TREE_CELL_DENSITY` — chance (0..1) that a slot actually grows a tree.
    //                     1 = every slot, 0.5 = half the slots stay empty.
    TREE_SPACING: 5,
    TREE_CELL_DENSITY: 1,
    // Tree shadows are copies of the tree's own tiles re-deformed into ground
    // shadows. The shadow is planted at the tree's trunk (zero offset so the
    // shadow trunk starts exactly where the tree trunk starts) and the
    // silhouette is squashed, slightly widened and gently leaned toward the
    // right about the trunk's base (light from the left).
    treeShadowOffsetX: 0,
    treeShadowOffsetY: 0,
    treeShadowSkewDeg: -22,
    treeShadowScaleX: 1.15,
    treeShadowScaleY: 0.5,
    treeShadowOpacity: 0.4,
    // WORLD TERRAIN
    // Continent-base system: continent centers on a square lattice every
    // `CONTINENT_SPACING` tiles. Each continent is ~`CONTINENT_SIZE` tiles of
    // land, so roughly `CONTINENT_SPACING - CONTINENT_SIZE` tiles of ocean sit
    // between neighbours (~5k of continent, ~5k of sea) — repeating infinitely
    // in every direction. `CENTER_WARP` jitters the centers so it's not a
    // perfect grid; the `INLAND_SPACING`/`INLAND_WEIGHT` field adds mild relief
    // and softly indents the coasts, while enclosed seas/lakes come from the
    // `CONTINENT_SEA_CHANCE` rolls below.
    SEA_LEVEL: 0.0,
    CONTINENT_SPACING: 10000,
    CONTINENT_SIZE: 5000,
    CONTINENT_WEIGHT: 1.2,
    CENTER_WARP: 800,
    INLAND_SPACING: 48,
    INLAND_WEIGHT: 0.3,
    // How far continents can stretch along their random elongation axis
    // (1 = round-ish blobs, larger = long skinny continents like Chile).
    CONTINENT_ELONGATION: 0.35,
    // About this fraction of continents hide a small enclosed inland sea/lake
    // (a shallow oval ellipse well inside the landmass, so it never gets close
    // to the coast or dwarfs the continent around it).
    CONTINENT_SEA_CHANCE: 0.35,
    INLAND_SEA_RADIUS_FRAC: 0.16,
    INLAND_SEA_OFFSET_FRAC: 0.35,
    // Rivers start on elevated land and flow down to a sea. One river remains
    // possible per `RIVER_SPACING`-sized cell, and only where the land is
    // elevated (see `RIVER_MIN_ELEVATION`). They get wider as they approach
    // the coast, capped at `RIVER_MAX_LENGTH` tiles, and are `RIVER_WIDTH`
    // tiles wide (3 = a solid 3-tile-wide water band).
    RIVER_SPACING: 90,
    RIVER_DENSITY: 0.8,
    RIVER_MIN_ELEVATION: 0.1,
    RIVER_MAX_LENGTH: 300,
    RIVER_WIDTH: 3,
    // Radial boost around the world origin (the spawn) so the player never
    // starts on water. `SPAWN_HEIGHT_BOOST` is added and fades to zero at
    // `SPAWN_BOOST_RADIUS` tiles away.
    SPAWN_HEIGHT_BOOST: 0.9,
    SPAWN_BOOST_RADIUS: 7,
    // Trees keep this many tiles of clearance around their whole footprint; no
    // water (lakes, seas, rivers) may be closer than this to any part of a tree.
    TREE_WATER_GAP: 3,
    INVENTORY_COLS: 4,
    INVENTORY_ROWS: 6,
    MAX_STACK: 64,
    INVENTORY_TEXT_SCALE: 0.9,
    ITEM_IMAGE_PATH: "assets/ui/items/",
    moveSpeed: 128*128,
    animInterval: 180,
    useDuration: 500,
    useCooldown: 500,
    CHOP_USES_REQUIRED: 4,
    CHOP_REWARD: "oak_log_chunk",
    CHOP_REWARD_COUNT: 4,
    GROUND_ITEM_SCALE: 2,
    GROUND_ITEM_BASE_SIZE: 16,
    GROUND_ITEM_BOB_AMPLITUDE: 4,
    DROP_DISTANCE: Math.round(SPRITE_SIZE * TILE_SCALE * 0.8),
    UPDATE_SEND_INTERVAL: 80,
    JOYSTICK_DEADZONE: 14,
    defaultCharacter: "assets/characters/basicrobot",
    directions: ["idle", "forward", "backward", "left", "right", "idleforward", "idlebackward", "idleleft", "idleright", "forwarduse", "backwarduse", "leftuse", "rightuse"],
    TILE_TYPES: ["grass", "water", "oak_log", "oak_tree_leaves"],
};

export const INVENTORY_SIZE = CONFIG.INVENTORY_COLS * CONFIG.INVENTORY_ROWS;

export const state = {
    characterPath: CONFIG.defaultCharacter,
    playerInventory: Array(INVENTORY_SIZE).fill(null),
    inventoryVisible: false,
    inventoryEl: null,
    cursorItem: null,
    cursorItemEl: null,
    tooltipEl: null,
    slotElements: [],
    touchDrag: null,
    isTouching: false,

    seed: [],
    playerWorldX: 0,
    playerWorldY: 0,
    direction: "idle",
    lastDirection: "backward",
    animFrame: 0,
    animTimer: 0,
    using: false,
    useTimer: 0,
    useCooldownTimer: 0,
    lastTime: 0,

    viewportEl: null,
    appEl: null,
    GAME_W: 0,
    GAME_H: 0,
    baselineDPR: 1,
    lastAppTransform: "",
    lastViewTransform: "",
    scaleX: 1,
    scaleY: 1,
    // Temporary debug zoom (linear slider): 1 = normal, <0 = mirrored zoom-out
    // (the world flips and keeps zooming out linearly down to -2 = -200%).
    zoom: 1,
    cameraX: 0,
    cameraY: 0,
    lastWorldTransform: null,
    worldEl: null,
    playerEl: null,
    playerImgEl: null,
    drawnPlayerSrc: null,
    remotePlayerImgs: new Map(),
    drawnRemoteSrc: new Map(),
    coordEl: null,

    ws: null,
    localPlayerId: null,
    lastSentSnapshot: null,
    lastUpdateSentAt: 0,

    initStarted: false,
    gameLoopStarted: false,
    loadStatusEl: null,
    onGameConnected: null,

    joystickEl: null,
    joystickKnobEl: null,
    joystickTouchId: null,
    joystickCenterX: 0,
    joystickCenterY: 0,
    joystickRadius: 52,

    keys: {},
    imageCache: {},
    characterFrames: {},
    preloadedCharacters: new Set(),
    tileElements: new Map(),
    treeShadowEls: new Map(),
    coarseTiles: new Map(),
    tileColors: {},
    spriteDataUrls: new Map(),
    remotePlayers: new Map(),
    remoteTargets: new Map(),
    remoteAnim: new Map(),
    removedTrees: new Set(),
    treeUseCounts: new Map(),
    groundItems: [],
    groundItemEls: new Map(),
    pendingPickups: new Set(),
};
