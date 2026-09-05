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
    INVENTORY_COLS: 4,
    INVENTORY_ROWS: 6,
    MAX_STACK: 64,
    INVENTORY_TEXT_SCALE: 0.9,
    ITEM_IMAGE_PATH: "assets/ui/items/",
    moveSpeed: 128,
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
    scaleX: 1,
    scaleY: 1,
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
