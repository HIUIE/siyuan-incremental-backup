"use strict";

// Exercise the real toolbar methods using only in-memory host elements. This
// suite never calls onload, loads settings, scans disks or opens a workspace.
const assert = require("assert").strict;
const Module = require("module");
class Element {
    constructor(tag = "span") {
        this.tagName = tag; this.attributes = new Map(); this.children = [];
        this.parentNode = null; this.className = ""; this.textContent = "";
        this.style = {}; this.listeners = new Map();
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    appendChild(child) { child.remove(); child.parentNode = this; this.children.push(child); return child; }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    querySelectorAll(selector) {
        const matches = node => selector.startsWith(".") ? node.className.split(/\s+/).includes(selector.slice(1)) : node.tagName === selector;
        return this.children.flatMap(child => (matches(child) ? [child] : []).concat(child.querySelectorAll(selector)));
    }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    fire(type) {
        const event = { target: this, currentTarget: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
        const listener = this.listeners.get(type); if (listener) listener(event);
        return event;
    }
}
const registrations = [];
class FakePlugin {
    addIcons(markup) { registrations.push(markup); }
    addTopBar(config) {
        this.toolbarConfig = config;
        const button = new Element("button"), svg = button.appendChild(new Element("svg"));
        svg.appendChild(new Element("use")).setAttribute("href", "#" + config.icon);
        return button;
    }
}
global.document = { createElement: tag => new Element(tag) };
const originalLoad = Module._load;
Module._load = function (name) { return name === "siyuan" ? { Plugin: FakePlugin } : originalLoad.apply(this, arguments); };
let BackupPlugin;
try { BackupPlugin = require("./index"); } finally { Module._load = originalLoad; }
let count = 0;
function check(value, message) { assert.ok(value, message); count++; console.log("PASS " + message); }

const plugin = new BackupPlugin({ i18n: {} });
plugin.registerIcons();
check(registrations.length === 1, "registerIcons calls the inherited icon registrar once");
const icon = registrations[0];
check(icon.includes('id="iconSibkBackup"') && icon.includes('viewBox="0 0 24 24"'), "registered symbol uses the backup-specific id and matching 24px viewbox");
check(icon.includes('<g fill="none" stroke="currentColor"') && /<rect\b/.test(icon) && (icon.match(/<path\b/g) || []).length >= 2, "registered glyph contains outlined drive and circular-arrow geometry");
check(!/id="iconSibk"/.test(icon), "old lock symbol id is not registered");
const sidebar = plugin.icon("backup");
const geometry = markup => markup.match(/<(?:path|rect)\b[^>]*\/>/g) || [];
check(JSON.stringify(geometry(sidebar)) === JSON.stringify(geometry(icon)) && geometry(icon).length > 0, "sidebar backup glyph shares the registered toolbar geometry");
plugin.addTopBarButton();
const toolbar = plugin.topBarElement, svg = toolbar.querySelector("svg");
const label = () => toolbar.getAttribute("aria-label");
const badge = () => toolbar.querySelector(".sibk-badge");
check(plugin.toolbarConfig.icon === "iconSibkBackup" && toolbar.querySelector("use").getAttribute("href") === "#iconSibkBackup", "toolbar uses the registered backup glyph");
check(toolbar.getAttribute("data-sibk-state") === "idle" && badge() === null, "first-run idle toolbar is quiet without a badge");
check(label().includes("本地增量备份") && label().includes("尚未备份"), "idle accessible tooltip identifies product and first-run state");
check(label().includes("单击打开工作台") && label().includes("右键查看快捷操作"), "accessible tooltip explains click and context-menu actions");
check(svg.style.opacity === "1", "idle glyph is fully visible");
let opened = 0, contextEvents = 0;
plugin.openSettings = () => { opened++; };
plugin.showMenu = event => { contextEvents++; check(event.defaultPrevented, "context menu handler prevents the native menu"); };
plugin.toolbarConfig.callback();
check(opened === 1, "toolbar click invokes the real registered workbench callback");
toolbar.fire("contextmenu");
check(contextEvents === 1, "toolbar right click invokes shortcut menu");

plugin.running = true;
plugin.settings.lastError = "previous failure";
plugin.settings.lastResult = { warnings: ["previous warning"] };
plugin.updateTopBar("正在复制 3 / 8", "running");
const runningBadge = badge();
check(toolbar.getAttribute("data-sibk-state") === "running", "active backup takes precedence over older error and warning state");
check(runningBadge && runningBadge.getAttribute("data-kind") === "running" && runningBadge.textContent === "", "running state renders a dot badge without warning text");
check(runningBadge.getAttribute("aria-hidden") === "true", "visual badge is hidden from screen readers to avoid duplicate announcements");
check(svg.style.opacity === "0.7" && label().includes("正在复制 3 / 8") && !label().includes("previous failure"), "running glyph and tooltip reflect current progress");
plugin.updateTopBar("正在复制 4 / 8", "running");
check(badge() === runningBadge && toolbar.querySelectorAll(".sibk-badge").length === 1, "repeated running updates reuse one badge");

plugin.running = false;
plugin.settings.lastError = "EACCES: simulated read denied";
plugin.updateTopBar();
check(toolbar.getAttribute("data-sibk-state") === "error", "persisted backup failure remains visible after execution stops");
check(badge() === runningBadge && badge().getAttribute("data-kind") === "error" && badge().textContent === "!", "failure reuses the badge as a persistent exclamation mark");
check(label().includes("最近一次备份未完成") && label().includes("EACCES: simulated read denied") && !label().includes("正在复制"), "failure tooltip exposes the specific error instead of stale progress");
check(svg.style.opacity === "1" && badge().getAttribute("aria-hidden") === "true", "stopped failure restores icon visibility and keeps badge decorative");
plugin.settings.lastBackupAt = new Date(2026, 0, 2, 3, 4, 5).getTime();
plugin.updateTopBar();
check(toolbar.getAttribute("data-sibk-state") === "error" && badge().textContent === "!", "older success timestamp cannot hide a later failure");

plugin.settings.lastError = "";
plugin.settings.lastResult = { warnings: ["baseline was skipped", "retention needs review"] };
plugin.updateTopBar();
check(toolbar.getAttribute("data-sibk-state") === "warning" && badge().getAttribute("data-kind") === "warning" && badge().textContent === "!", "completed backup warnings retain a warning exclamation badge");
check(label().includes("备份已完成，请查看提示") && label().includes("baseline was skipped") && label().includes("retention needs review"), "warning tooltip includes every concrete warning");
check(toolbar.querySelectorAll(".sibk-badge").length === 1 && badge().getAttribute("aria-hidden") === "true", "warning updates retain exactly one decorative badge");

plugin.settings.lastResult = { warnings: [] };
plugin.updateTopBar();
check(toolbar.getAttribute("data-sibk-state") === "success" && badge() === null, "clean success removes the attention badge rather than adding a permanent success marker");
check(label().includes("上次备份") && label().includes("2026-01-02 03:04:05") && !label().includes("baseline was skipped"), "success tooltip shows last backup time and clears stale warnings");
check(svg.style.opacity === "1", "quiet success keeps normal glyph visibility");
plugin.status = { text: "stale progress", kind: "error" };
plugin.settings.lastBackupAt = 0; plugin.settings.lastResult = null;
plugin.updateTopBar();
check(toolbar.getAttribute("data-sibk-state") === "idle" && badge() === null && !label().includes("stale progress"), "idle state derives from actual backup result rather than stale transient status");
plugin.running = true; plugin.updateTopBar("next backup", "running");
plugin.running = false; plugin.updateTopBar();
check(badge() === null && toolbar.getAttribute("data-sibk-state") === "idle", "returning from running to idle removes the stale badge");
check(label().includes("单击") && label().includes("右键"), "action hints remain available after all state transitions");
console.log("\n" + count + " in-memory toolbar checks passed");
