import { CONFIG, state } from "./state.js";
import { applySettings, saveSettings, DEFAULT_SETTINGS } from "./settings.js";
import { startUse } from "./gameplay.js";
import { toggleInventory } from "./inventory.js";

export function isTouchDevice() {
    return (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) ||
        "ontouchstart" in window || navigator.maxTouchPoints > 0 ||
        /iPad|iPhone|iPod/i.test(window.navigator.userAgent);
}

export function createJoystick() {
    state.joystickEl = document.createElement("div");
    state.joystickEl.id = "joystick";

    const base = document.createElement("div");
    base.className = "joystick-base";

    state.joystickKnobEl = document.createElement("div");
    state.joystickKnobEl.className = "joystick-knob";

    base.appendChild(state.joystickKnobEl);
    state.joystickEl.appendChild(base);
    document.body.appendChild(state.joystickEl);

    state.joystickEl.addEventListener("touchstart", (e) => {
        e.preventDefault();
        const rect = state.joystickEl.getBoundingClientRect();
        state.joystickCenterX = rect.left + rect.width / 2;
        state.joystickCenterY = rect.top + rect.height / 2;
        const touch = e.changedTouches[0];
        state.joystickTouchId = touch.identifier;
        updateJoystick(touch);
    }, { passive: false });

    window.addEventListener("touchmove", (e) => {
        for (const touch of e.changedTouches) {
            if (touch.identifier === state.joystickTouchId) {
                e.preventDefault();
                updateJoystick(touch);
                break;
            }
        }
    }, { passive: false });

    const releaseJoystick = () => {
        if (state.joystickTouchId === null) return;
        state.joystickTouchId = null;
        state.keys["w"] = false;
        state.keys["s"] = false;
        state.keys["a"] = false;
        state.keys["d"] = false;
        if (state.joystickKnobEl) state.joystickKnobEl.style.transform = "translate(0px, 0px)";
    };

    window.addEventListener("touchend", (e) => {
        for (const touch of e.changedTouches) {
            if (touch.identifier === state.joystickTouchId) {
                releaseJoystick();
                break;
            }
        }
    }, { passive: false });

    window.addEventListener("touchcancel", releaseJoystick, { passive: false });
}

export function updateJoystick(touch) {
    let dx = touch.clientX - state.joystickCenterX;
    let dy = touch.clientY - state.joystickCenterY;
    const dist = Math.hypot(dx, dy);
    if (dist > state.joystickRadius) {
        dx = (dx / dist) * state.joystickRadius;
        dy = (dy / dist) * state.joystickRadius;
    }
    state.joystickKnobEl.style.transform = `translate(${dx}px, ${dy}px)`;

    if (Math.hypot(dx, dy) < CONFIG.JOYSTICK_DEADZONE) {
        state.keys["w"] = false;
        state.keys["s"] = false;
        state.keys["a"] = false;
        state.keys["d"] = false;
        return;
    }

    const mag = Math.max(Math.abs(dx), Math.abs(dy));
    // Map analog stick direction to WASD keys. Use the dominant axis (compared against
    // half the max projection) so diagonal input maps to the two relevant keys,
    // and a deadzone-free center returns to idle. The joystick basically works the same as WASD
    state.keys["w"] = dy < 0 && Math.abs(dy) >= mag * 0.5;
    state.keys["s"] = dy > 0 && Math.abs(dy) >= mag * 0.5;
    state.keys["a"] = dx < 0 && Math.abs(dx) >= mag * 0.5;
    state.keys["d"] = dx > 0 && Math.abs(dx) >= mag * 0.5;
}

export function createMobileButtons() {
    const useBtn = document.createElement("button");
    useBtn.id = "mobile-use-btn";
    useBtn.textContent = "USE";
    useBtn.addEventListener("touchstart", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!state.using && state.useCooldownTimer <= 0) {
            startUse();
        }
    }, { passive: false });
    document.body.appendChild(useBtn);
    useBtn.style.display = "flex";
    useBtn.style.alignItems = "center";
    useBtn.style.justifyContent = "center";

    const invBtn = document.createElement("button");
    invBtn.id = "mobile-inv-btn";
    // Buttons may need icons instead of text for better look, but for now this is fine
    invBtn.textContent = "INV";
    invBtn.addEventListener("touchstart", (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleInventory();
    }, { passive: false });
    document.body.appendChild(invBtn);
    invBtn.style.display = "flex";
    invBtn.style.alignItems = "center";
    invBtn.style.justifyContent = "center";
}

export function createSettingsMenu(settings) {
    const gearBtn = document.createElement("button");
    gearBtn.id = "mobile-settings-btn";
    gearBtn.textContent = "\u2699";
    gearBtn.setAttribute("aria-label", "Settings");

    const panel = document.createElement("div");
    panel.id = "settings-panel";

    const header = document.createElement("div");
    header.className = "settings-header";
    const title = document.createElement("h2");
    title.textContent = "Settings";
    const closeBtn = document.createElement("button");
    closeBtn.className = "settings-close";
    closeBtn.textContent = "X";
    header.appendChild(title);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    const rows = [
        { key: "joystick", label: "Joystick size", min: 90, max: 240, step: 5, display: (v) => `${v}px` },
        { key: "inventory", label: "Inventory size", min: 2, max: 5, step: 0.5, display: (v) => `${v}x` },
        { key: "useBtn", label: "USE button size", min: 55, max: 130, step: 5, display: (v) => `${v}px` },
        { key: "invBtn", label: "INV button size", min: 40, max: 90, step: 5, display: (v) => `${v}px` },
    ];

    rows.forEach((row) => {
        const wrap = document.createElement("div");
        wrap.className = "settings-row";
        const label = document.createElement("label");
        label.textContent = row.label;
        wrap.appendChild(label);

        const control = document.createElement("div");
        control.className = "settings-control";
        const slider = document.createElement("input");
        slider.type = "range";
        slider.min = String(row.min);
        slider.max = String(row.max);
        slider.step = String(row.step);
        slider.value = String(settings[row.key]);
        const valueEl = document.createElement("span");
        valueEl.className = "settings-value";
        valueEl.textContent = row.display(settings[row.key]);

        slider.addEventListener("input", () => {
            const v = Number(slider.value);
            settings[row.key] = v;
            valueEl.textContent = row.display(v);
            applySettings(settings);
            saveSettings(settings);
        });

        const resetBtn = document.createElement("button");
        resetBtn.className = "settings-reset";
        resetBtn.textContent = "\u21ba";
        resetBtn.setAttribute("aria-label", `Reset ${row.label}`);
        resetBtn.addEventListener("touchstart", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const def = DEFAULT_SETTINGS[row.key];
            settings[row.key] = def;
            slider.value = String(def);
            valueEl.textContent = row.display(def);
            applySettings(settings);
            saveSettings(settings);
        }, { passive: false });

        control.appendChild(slider);
        control.appendChild(valueEl);
        control.appendChild(resetBtn);
        wrap.appendChild(control);
        panel.appendChild(wrap);
    });

    gearBtn.addEventListener("touchstart", (e) => {
        e.preventDefault();
        e.stopPropagation();
        panel.setAttribute("data-open", "true");
    }, { passive: false });
    closeBtn.addEventListener("touchstart", (e) => {
        e.preventDefault();
        e.stopPropagation();
        panel.setAttribute("data-open", "false");
    }, { passive: false });

    document.body.appendChild(gearBtn);
    document.body.appendChild(panel);
    gearBtn.style.display = "flex";
    applySettings(settings);
}
