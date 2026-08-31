import { state } from "./state.js";

export function getMovementState() {
    let vx = 0;
    let vy = 0;

    if (state.keys["a"]) vx -= 1;
    if (state.keys["d"]) vx += 1;
    if (state.keys["w"]) vy -= 1;
    if (state.keys["s"]) vy += 1;

    if (vx === 0 && vy === 0) return { vx: 0, vy: 0, direction: "idle" };

    let moveDirection;
    if (vy < 0) moveDirection = "forward";
    else if (vy > 0) moveDirection = "backward";
    else if (vx < 0) moveDirection = "left";
    else moveDirection = "right";

    return { vx, vy, direction: moveDirection };
}

export function clearMovementKeys() {
    state.keys["a"] = false;
    state.keys["d"] = false;
    state.keys["w"] = false;
    state.keys["s"] = false;
    state.keys["f"] = false;
}
