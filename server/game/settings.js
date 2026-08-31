import { CONFIG, state } from "./state.js";

export const SETTINGS_KEY = "technogenesis_mobile_settings";
export const DEFAULT_SETTINGS = { joystick: 150, inventory: 3, useBtn: 80, invBtn: 50 };

export function loadSettings() {
    try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (raw) return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(raw));
    } catch (e) {}
    return Object.assign({}, DEFAULT_SETTINGS);
}

export function saveSettings(settings) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {}
}

function clampSetting(v, min, max) { return Math.max(min, Math.min(max, v)); }

export function applySettings(settings) {
    settings.joystick = clampSetting(Number(settings.joystick) || DEFAULT_SETTINGS.joystick, 90, 240);
    settings.inventory = clampSetting(Number(settings.inventory) || DEFAULT_SETTINGS.inventory, 2, 5);
    settings.useBtn = clampSetting(Number(settings.useBtn) || DEFAULT_SETTINGS.useBtn, 55, 130);
    settings.invBtn = clampSetting(Number(settings.invBtn) || DEFAULT_SETTINGS.invBtn, 40, 90);

    const root = document.documentElement.style;
    root.setProperty("--joy-size", `${settings.joystick}px`);
    root.setProperty("--joy-knob", `${Math.round(58 * settings.joystick / 150)}px`);
    root.setProperty("--inv-scale", settings.inventory);
    root.setProperty("--btn-use-size", `${settings.useBtn}px`);
    root.setProperty("--btn-inv-size", `${settings.invBtn}px`);
    state.joystickRadius = Math.round(52 * settings.joystick / 150);
    if (state.inventoryEl) {
        state.inventoryEl.style.gridTemplateColumns = `repeat(${CONFIG.INVENTORY_COLS}, calc(18px * var(--inv-scale)))`;
    }
}
