"use strict";

// Small DOM test double with real parent/child identity, parsing and event
// delivery. No browser, dependencies, real SiYuan module or real note paths.
const assert = require("assert").strict;
const Module = require("module");
const fs = require("fs");
const path = require("path");
const os = require("os");
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sibk-window-")));
let checks = 0;
function check(value, message) { assert.ok(value, message); checks++; console.log("PASS " + message); }
const decode = value => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#10;/g, "\n").replace(/&amp;/g, "&");
const voidTags = new Set(["input", "br", "hr", "img", "meta", "link", "area", "source"]);
class Element {
    constructor(tag = "div") {
        this.tagName = tag.toLowerCase(); this.attributes = new Map(); this.childNodes = [];
        this.parentNode = null; this.listeners = new Map(); this.style = {}; this.scrollTop = 0;
        this.hidden = false; this.checked = false; this.disabled = false; this.value = ""; this.tabIndex = -1;
        this._text = ""; this._markup = "";
        this.classList = {
            add: (...names) => { this.className = [...new Set(this.className.split(/\s+/).filter(Boolean).concat(names))].join(" "); },
            contains: name => this.className.split(/\s+/).includes(name),
        };
    }
    get className() { return this.getAttribute("class") || ""; }
    set className(value) { this.setAttribute("class", value); }
    get isConnected() { return this === document.body || this === document.head || !!(this.parentNode && this.parentNode.isConnected); }
    get textContent() { return this._text + this.childNodes.map(n => n.textContent).join(""); }
    set textContent(value) { this.replaceChildren(); this._text = String(value); }
    setAttribute(name, value) {
        this.attributes.set(name, String(value));
        if (name === "value") this.value = decode(String(value));
        if (name === "tabindex") this.tabIndex = Number(value);
        if (["checked", "hidden", "disabled"].includes(name)) this[name] = true;
    }
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
    removeAttribute(name) { this.attributes.delete(name); if (["checked", "hidden", "disabled"].includes(name)) this[name] = false; }
    appendChild(node) { node.remove(); node.parentNode = this; this.childNodes.push(node); return node; }
    replaceChildren(...nodes) { for (const node of this.childNodes.slice()) node.remove(); for (const node of nodes) this.appendChild(node); this._text = ""; }
    remove() { if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter(n => n !== this); this.parentNode = null; }
    contains(node) { return this === node || this.childNodes.some(child => child.contains(node)); }
    focus() { document.activeElement = this; }
    addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(listener); }
    async fire(type, fields = {}) {
        const event = { target: this, ...fields, defaultPrevented: false, propagationStopped: false,
            preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.propagationStopped = true; } };
        const pending = [];
        for (let node = this; node; node = node.parentNode) {
            event.currentTarget = node;
            for (const listener of node.listeners.get(type) || []) pending.push(listener(event));
            if (event.propagationStopped) break;
        }
        await Promise.all(pending);
        return event;
    }
    matches(selector) {
        let rest = selector;
        const tag = /^[a-z][\w-]*/i.exec(rest);
        if (tag) { if (this.tagName !== tag[0].toLowerCase()) return false; rest = rest.slice(tag[0].length); }
        while (rest) {
            let m;
            if ((m = /^#([\w-]+)/.exec(rest))) { if (this.getAttribute("id") !== m[1]) return false; }
            else if ((m = /^\.([\w-]+)/.exec(rest))) { if (!this.classList.contains(m[1])) return false; }
            else if ((m = /^\[([\w-]+)(?:="([^"]*)")?\]/.exec(rest))) { if (this.getAttribute(m[1]) === null || (m[2] !== undefined && this.getAttribute(m[1]) !== m[2])) return false; }
            else throw new Error("Unsupported test selector: " + selector);
            rest = rest.slice(m[0].length);
        }
        return true;
    }
    querySelectorAll(selector) {
        const found = [];
        for (const child of this.childNodes) { if (child.matches(selector)) found.push(child); found.push(...child.querySelectorAll(selector)); }
        return found;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    closest(selector) { for (let n = this; n; n = n.parentNode) if (n.matches(selector)) return n; return null; }
    get innerHTML() { return this._markup; }
    set innerHTML(markup) {
        this._markup = String(markup); this.replaceChildren();
        const stack = [this];
        for (const token of this._markup.match(/<[^>]+>|[^<]+/g) || []) {
            if (token.startsWith("</")) { if (stack.length > 1) stack.pop(); continue; }
            if (!token.startsWith("<")) { stack[stack.length - 1]._text += decode(token); continue; }
            const match = /^<([\w-]+)([\s\S]*?)\/?\s*>$/.exec(token);
            if (!match) continue;
            const node = new Element(match[1]);
            const attrs = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
            for (const attr of match[2].matchAll(attrs)) node.setAttribute(attr[1], decode(attr[2] ?? attr[3] ?? attr[4] ?? ""));
            stack[stack.length - 1].appendChild(node);
            if (!voidTags.has(node.tagName) && !token.endsWith("/>")) stack.push(node);
        }
        for (const textarea of this.querySelectorAll("textarea")) textarea.value = textarea.textContent;
    }
}
global.document = { createElement: tag => new Element(tag), head: new Element("head"), body: new Element("body"), activeElement: null };
global.window = { addEventListener() {}, removeEventListener() {}, siyuan: { zIndex: 2048, config: { system: { dataDir: path.join(tmp, "workspace", "data") } } } };
const dialogs = [], live = new Set();
class Dialog {
    constructor(cfg) {
        this.cfg = cfg; this.destroyCount = 0; this.focusTrapActive = true;
        this.element = new Element();
        this.element.innerHTML = `<div class="b3-dialog__container" aria-labelledby="native-title"><div class="b3-dialog__header">${cfg.title}</div><div class="b3-dialog__body">${cfg.content}</div></div>`;
        document.body.appendChild(this.element); dialogs.push(this); live.add(this);
    }
    destroy() {
        if (this.destroyCount) return;
        this.destroyCount++; this.focusTrapActive = false; this.element.remove(); live.delete(this);
        if (this.cfg.destroyCallback) this.cfg.destroyCallback();
    }
}
class Plugin {
    addIcons() {}
    addTopBar(cfg) { this.topBarConfig = cfg; const button = new Element("button"); document.body.appendChild(button); return button; }
    addCommand() {}
    async loadData() { return { destRoot: path.join(tmp, "backup"), intervalMinutes: 0, autoStart: false, dailyFirst: false }; }
    async saveData() {}
}
const originalLoad = Module._load;
Module._load = function (name) { return name === "siyuan" ? { Plugin, Dialog, showMessage() {}, confirm() {}, Menu: class {} } : originalLoad.apply(this, arguments); };
const BackupPlugin = require("./index");
Module._load = originalLoad;

async function main() {
    const plugin = new BackupPlugin({ i18n: {} });
    try {
        await plugin.onload();
        plugin.topBarConfig.callback();
        const state = plugin.windowState, settings = state.current, root = settings.root, native = state.native;
        check(settings.key === "settings" && settings.title.includes("v" + require("./plugin.json").version), "topbar opens versioned settings view");
        check(native.cfg.width === "1060px" && native.cfg.height === "min(86vh, 860px)", "native window has one fixed width and height");
        check(native.cfg.disableClose && native.cfg.disableAnimation && native.cfg.hideCloseIcon, "native automatic close and animation are disabled for custom chrome");
        check(native.cfg.content === '<div class="sibk-frame-content"></div>', "native content contains only the persistent view host");
        check(native.element.querySelector(".b3-dialog__container").classList.contains("sibk-dialog-container") && native.cfg.containerClassName === "sibk-dialog-container", "native container receives dedicated window class");
        check(native.element.querySelector(".sibk-frame-content").childNodes[0] === root && root.isConnected, "view DOM is mounted into the live native host");
        check(native.element.querySelector("[data-window-title]").textContent === settings.title && native.element.querySelector(".b3-dialog__container").getAttribute("aria-label") === settings.title, "visible title and accessible window label match current view");
        check(native.element.querySelector("[data-window-back]").disabled, "back control is disabled on the initial overview");
        plugin.topBarConfig.callback();
        check(dialogs.length === 1 && live.size === 1 && state.current.root === root, "repeated active topbar opens reuse the same native and view");
        await root.querySelector('[data-section="plan"]').fire("click");
        const input = root.querySelector("#sibkDest"), excludes = root.querySelector("#sibkExcludes");
        input.value = path.join(tmp, "unsaved-export"); excludes.value = "draft-cache/"; root.scrollTop = 47;
        check(state.current.section === "plan" && !native.element.querySelector("[data-window-back]").disabled, "plan navigation updates state and enables back");
        await plugin.openSnapshots();
        const snapshots = state.current;
        check(state.native === native && dialogs.length === 1 && snapshots.key === "snapshots", "snapshot navigation reuses the native window");
        check(state.history.length === 1 && state.history[0] === settings && !root.isConnected, "previous settings DOM is retained in history while detached");
        await native.element.querySelector("[data-window-back]").fire("click");
        check(state.current === settings && state.native === native && root.isConnected, "back mounts the exact earlier view object and root");
        check(root.querySelector("#sibkDest") === input && input.value === path.join(tmp, "unsaved-export") && excludes.value === "draft-cache/" && root.scrollTop === 47, "back preserves input identity, unsaved drafts and scroll position");
        check(settings.section === "plan" && document.activeElement === root.querySelector('[role="tab"][aria-selected="true"]'), "back restores the earlier tab and focuses its selected control");
        await native.element.querySelector("[data-window-back]").fire("click");
        check(settings.section === "overview" && state.current.root === root && state.history.length === 0, "back from a settings subpage selects overview without discarding the view");
        await plugin.openLog(); const log = state.current;
        await plugin.openSnapshots();
        check(state.native === native && dialogs.length === 1 && state.history.length === 2 && state.history[1] === log, "multiple view routes share one native host and retain ordered history");
        plugin.backWindow(); check(state.current === log && log.root.isConnected, "back restores retained log DOM");
        plugin.backWindow(); check(state.current === settings && root.querySelector("#sibkDest") === input, "second back restores retained settings DOM");
        await root.querySelector('[data-section="plan"]').fire("click");
        input.focus();
        plugin.running = true; plugin.operation = "backup"; plugin.canceled = false;
        const minimizeControl = native.element.querySelector("[data-window-minimize]");
        check((await minimizeControl.fire("mousedown")).propagationStopped, "chrome mousedown does not bubble into native dragging");
        await minimizeControl.fire("click");
        const dock = state.dock;
        check(state.minimized && state.native === null && state.current === settings && !root.isConnected, "minimize detaches and retains the current view");
        check(native.destroyCount === 1 && !native.focusTrapActive && live.size === 0, "minimize destroys the modal host and releases its focus trap");
        check(plugin.running && plugin.operation === "backup" && !plugin.canceled, "minimize does not cancel or reset an active backup");
        check(dock.isConnected && document.body.querySelectorAll(".sibk-dock").length === 1 && document.activeElement === dock.querySelector("[data-window-restore]"), "minimize creates one focused restore dock");
        check(!plugin.statusViews.has(root), "minimized detached view is not an active status host");
        plugin.minimizeWindow();
        check(state.dock === dock && document.body.querySelectorAll(".sibk-dock").length === 1, "repeated minimize is idempotent");
        plugin.topBarConfig.callback();
        const restoredNative = state.native;
        check(!state.minimized && state.current === settings && state.current.root === root && root.isConnected, "topbar restores the same retained view");
        check(restoredNative !== native && live.size === 1 && dialogs.length === 2, "restore creates exactly one replacement native host");
        check(state.dock === null && !dock.isConnected && document.body.querySelectorAll(".sibk-dock").length === 0, "restore removes the dock");
        check(root.querySelector("#sibkDest") === input && document.activeElement === input && input.value === path.join(tmp, "unsaved-export") && settings.section === "plan", "restore preserves draft element, section and prior input focus");
        check(plugin.statusViews.has(root) && plugin.running && !plugin.canceled, "restored view resumes status observation without affecting backup");
        plugin.topBarConfig.callback(); plugin.topBarConfig.callback();
        check(dialogs.length === 2 && live.size === 1 && state.current.root === root, "repeated topbar restore calls never create duplicate native instances");
        plugin.minimizeWindow(); const secondDock = state.dock;
        await secondDock.querySelector("[data-window-restore]").fire("click");
        check(state.current === settings && root.querySelector("#sibkDest") === input && dialogs.length === 3 && live.size === 1, "dock restore remounts the same input and exactly one native instance");
        await state.native.element.querySelector("[data-window-close]").fire("click");
        check(plugin.windowState === null && live.size === 0 && !root.isConnected && document.body.querySelectorAll(".sibk-dock").length === 0, "close releases native window, view state and dock");
        check(plugin.running && !plugin.canceled && plugin.operation === "backup", "closing the window keeps the active backup running");
        check(plugin.statusViews.size === 0, "close removes retained views from status subscriptions");
        plugin.closeWindow(); check(plugin.windowState === null && live.size === 0, "repeated close is harmless");
        plugin.openSettings();
        check(plugin.windowState.current.root !== root && plugin.windowState.current.root.querySelector("#sibkDest").value !== input.value, "reopening a fully closed window creates a fresh form rather than stale drafts");
        plugin.minimizeWindow(); const closeDock = plugin.windowState.dock;
        await closeDock.querySelector("[data-dock-close]").fire("click");
        check(plugin.windowState === null && !closeDock.isConnected && live.size === 0 && !plugin.canceled, "dock close releases minimized UI without canceling backup");
        plugin.openSettings(); const external = plugin.windowState.native;
        external.destroy();
        check(plugin.windowState === null && external.destroyCount === 1 && live.size === 0, "native destroy callback closes state without recursive destruction");
        plugin.openSettings(); const escapeNative = plugin.windowState.native;
        await escapeNative.element.fire("keydown", { key: "Escape", repeat: true });
        await escapeNative.element.fire("keydown", { key: "Escape", isComposing: true });
        check(plugin.windowState && live.size === 1, "repeat and composition Escape do not close the window");
        const escape = await escapeNative.element.fire("keydown", { key: "Escape" });
        check(escape.defaultPrevented && escape.propagationStopped && plugin.windowState === null && live.size === 0 && !plugin.canceled, "plain Escape closes UI while leaving backup uncanceled");
        check(dialogs.every(d => d.cfg.width === "1060px" && d.cfg.height === "min(86vh, 860px)"), "every native recreation uses the same fixed dimensions");
        plugin.openSettings();
        const readFile = fs.promises.readFile;
        let releaseLog, logStarted;
        const delayedLog = new Promise(resolve => { releaseLog = resolve; });
        const startedLog = new Promise(resolve => { logStarted = resolve; });
        fs.promises.readFile = async function (file, ...args) {
            if (String(file) === path.join(tmp, "backup", "backup.log")) { logStarted(); return delayedLog; }
            return readFile.call(this, file, ...args);
        };
        const pendingLog = plugin.openLog();
        try {
            await startedLog;
            plugin.closeWindow();
            const dialogsAtClose = dialogs.length;
            releaseLog("late log contents");
            await pendingLog;
            check(plugin.windowState === null && live.size === 0 && dialogs.length === dialogsAtClose, "delayed log read cannot reopen a window closed while loading");
        } finally { releaseLog(""); await pendingLog; fs.promises.readFile = readFile; }
        // Suspend the real save handler after real temporary-path validation.
        // Only persistence itself is stubbed; navigation and ownership checks run
        // unchanged through the actual button listener and plugin implementation.
        fs.mkdirSync(path.join(tmp, "workspace", "data"), { recursive: true });
        plugin.running = false; plugin.operation = ""; plugin.canceled = false;
        const originalSave = plugin.saveSettings, originalBackup = plugin.scheduleBackup;
        let backupsAfterSave = 0;
        plugin.scheduleBackup = async () => { backupsAfterSave++; };
        async function startPendingSave(backup = false) {
            plugin.closeWindow(); plugin.openSettings("plan");
            const owner = plugin.windowState, view = owner.current, form = view.root;
            form.querySelector("#sibkDest").value = path.join(tmp, "backup");
            form.querySelector("#sibkIntervalSel").value = "0";
            form.querySelector("#sibkIdle").value = "0";
            form.querySelector("#sibkKeep").value = "30";
            form.querySelector("#sibkExcludes").value = "saved-after-navigation/";
            let release, started;
            const saveGate = new Promise(resolve => { release = resolve; });
            const saveStarted = new Promise(resolve => { started = resolve; });
            plugin.saveSettings = () => { started(); return saveGate; };
            const pending = form.querySelector(backup ? "#sibkRunNow" : "#sibkSave").fire("click");
            await Promise.race([saveStarted, pending.then(() => { throw new Error("save did not reach persistence: " + form.querySelector("#sibkSettingsError").textContent); })]);
            return { owner, view, release, pending };
        }
        try {
            const closingSave = await startPendingSave(true);
            plugin.closeWindow(); const countAfterClose = dialogs.length;
            closingSave.release(true); await closingSave.pending;
            check(plugin.windowState === null && live.size === 0 && dialogs.length === countAfterClose, "delayed save completion cannot reopen a closed window");
            check(backupsAfterSave === 1 && plugin.settings.extraExcludes === "saved-after-navigation/" && !plugin.savingSettings, "save-and-backup continues after close without restoring UI");
            const minimizedSave = await startPendingSave();
            plugin.minimizeWindow(); const savingDock = minimizedSave.owner.dock, countAfterMinimize = dialogs.length;
            minimizedSave.release(true); await minimizedSave.pending;
            check(plugin.windowState === minimizedSave.owner && minimizedSave.owner.minimized && minimizedSave.owner.native === null && minimizedSave.owner.dock === savingDock && savingDock.isConnected && dialogs.length === countAfterMinimize && live.size === 0, "delayed save completion leaves a minimized window docked");
            plugin.restoreWindow();
            check(minimizedSave.owner.current === minimizedSave.view && minimizedSave.view.root.querySelector("#sibkSave").disabled === false, "minimized saved view remains retained and usable after restore");
            const navigatedSave = await startPendingSave();
            await plugin.openSnapshots(); const selectedSnapshotView = plugin.windowState.current;
            navigatedSave.release(true); await navigatedSave.pending;
            check(plugin.windowState === navigatedSave.owner && plugin.windowState.current === selectedSnapshotView && selectedSnapshotView.key === "snapshots", "delayed save completion does not jump back from a later view");
            const tabbedSave = await startPendingSave();
            await tabbedSave.view.root.querySelector('[data-section="scope"]').fire("click");
            tabbedSave.release(true); await tabbedSave.pending;
            check(plugin.windowState === tabbedSave.owner && plugin.windowState.current === tabbedSave.view && tabbedSave.view.section === "scope", "delayed save completion respects a later tab change in the same view");
        } finally { plugin.saveSettings = originalSave; plugin.scheduleBackup = originalBackup; plugin.closeWindow(); }
        plugin.openSettings(); plugin.minimizeWindow();
        plugin.onunload();
        check(plugin.windowState === null && document.body.querySelectorAll(".sibk-dock").length === 0 && live.size === 0 && plugin.statusViews.size === 0, "plugin unload cleans minimized UI and subscriptions");
        console.log("\n" + checks + " isolated window checks passed");
    } finally {
        plugin.closeWindow();
        assert.ok(path.basename(tmp).startsWith("sibk-window-"));
        assert.equal(fs.realpathSync(tmp), tmp);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
