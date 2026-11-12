/**
 * SiYuan Incremental Backup / 思源增量备份
 *
 * 基于硬链接的时间点快照（Time Machine 风格）：
 *  - 每次备份生成一个完整目录树快照 snap-YYYYMMDD-HHMMSS/
 *  - 与上一份快照相比未变化的文件用硬链接共享，几乎不占额外磁盘
 *  - 源端文件被删除或修改时，旧快照不受影响，可回溯任意时间点
 *
 * 稳定性设计：
 *  - v3 清单记录 SHA-256；提交后校验内容，失败或取消不清理旧历史
 *  - 未完成目录保留标记供排查，不能作为硬链接基准
 *  - 使用操作锁、磁盘空间检查，并拒绝嵌套目录与符号链接
 *  - 恢复仅导出独立副本，退出思源后再替换目录
 *  - 自动备份失败后按 lastAttemptAt 节流，避免重试风暴
 *
 * 依赖 Electron 的 nodeIntegration（思源桌面端默认开启），直接使用 Node 的 fs。
 */
"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");

const core = require("./backup-core");
const {
    PLUGIN_NAME, LOG_NAME, MANIFEST_NAME, DEFAULT_EXCLUDES, SOURCE_DEFS,
    expandHome, contractHome, readable, dayString, stampOf, humanSize,
    isPathInside, friendlyError, buildExcludes, runSnapshot, restoreSnapshot,
    listSnapshots, readManifest, removeSnapshot, withDestinationLock,
    verifySnapshot, cleanupIncomplete, validateBackupPaths,
} = core;

const PLUGIN_VERSION = "1.3.2";

const BACKUP_ICON_PATHS = '<path d="M4 10a8 8 0 0 1 13.3-5.7L21 8M21 3v5h-5"/><rect x="3" y="13" width="18" height="8" rx="2"/><path d="M7 17h.01M11 17h6"/>';

const DEFAULT_SETTINGS = {
    destRoot: "",                 // 备份根目录，空则使用 ~/SiYuanBackup
    sources: { data: true, conf: true, history: false, repo: false },
    intervalMinutes: 60,          // 自动备份间隔（分钟），0 = 关闭
    idleMinutes: 2,               // 空闲阈值（分钟）：距上次键鼠操作超过该时长才执行自动备份，0 = 不要求空闲
    autoStart: true,              // 启动后自动开启定时备份
    dailyFirst: true,             // 每天首次启动思源时强制备份一次
    autoPrune: false,             // 自动清理由用户明确开启，升级时保留历史快照
    lastError: "",
    keepCount: 30,                // 最多保留快照份数
    extraExcludes: "",            // 额外排除规则，每行一条
    lastBackupAt: 0,
    lastAttemptAt: 0,             // 上次尝试备份的时间（含失败），用于失败节流
    lastDailyDay: "",             // 上次「每日首启备份」的日期
    lastResult: null,
};

// ---------------------------------------------------------------- 插件主体

let siyuan = null;
try { siyuan = require("siyuan"); } catch (e) { siyuan = null; }

// 必须继承思源 Plugin 基类：addTopBar / addIcons / addCommand / loadData / saveData 均来自基类
const BasePlugin = (siyuan && siyuan.Plugin) ? siyuan.Plugin : class {};

class IncrementalBackupPlugin extends BasePlugin {
    constructor(options) {
        super(options);
        this.app = (options && options.app) || this.app;
        this.i18n = (options && options.i18n) || this.i18n || {};
        this.settings = Object.assign({}, DEFAULT_SETTINGS);
        this.settings.sources = Object.assign({}, DEFAULT_SETTINGS.sources);

        this.running = false;
        this.canceled = false;
        this.timer = null;
        this.topBarElement = null;
        this.status = { text: "", kind: "idle", progress: null };
        this.statusViews = new Set();
        this.lastActive = Date.now();
        this.activityHandler = () => { this.lastActive = Date.now(); };
    }

    // ---------------- 生命周期 ----------------

    async onload() {
        if (!siyuan) {
            console.error("[" + PLUGIN_NAME + "] 未能加载 siyuan 模块，插件不可用");
            return;
        }
        await this.loadSettings();

        this.addStyle();
        this.registerIcons();
        this.addTopBarButton();
        this.registerCommand();

        // 空闲检测：监听全局键鼠活动
        window.addEventListener("mousedown", this.activityHandler, { passive: true, capture: true });
        window.addEventListener("keydown", this.activityHandler, { passive: true, capture: true });

        if (this.settings.autoStart && this.settings.intervalMinutes > 0) {
            this.startTimer();
        }

        // 中断、损坏或无法识别的目录保留供排查，启动时不做破坏性清理。
    }

    /** 界面就绪后再做每日首启备份（此时 UI/调度都已可用） */
    onLayoutReady() {
        if (this.settings.dailyFirst && this.settings.lastDailyDay !== dayString()) {
            this.scheduleBackup("daily");
        }
    }

    onunload() {
        this.stopTimer();
        this.closeWindow();
        window.removeEventListener("mousedown", this.activityHandler, { capture: true });
        window.removeEventListener("keydown", this.activityHandler, { capture: true });
        if (this.styleEl && this.styleEl.remove) this.styleEl.remove();
        this.canceled = true;
        this.statusViews.clear();
        try { super.onunload && super.onunload(); } catch (e) { /* ignore */ }
    }

    // ---------------- 配置 ----------------

    async loadSettings() {
        try {
            const raw = await this.loadData("settings.json");
            if (raw && typeof raw === "object") {
                this.settings = Object.assign({}, DEFAULT_SETTINGS, raw);
                this.settings.sources = Object.assign({}, DEFAULT_SETTINGS.sources, raw.sources || {});
            }
        } catch (e) {
            this.settings = Object.assign({}, DEFAULT_SETTINGS);
            this.settings.sources = Object.assign({}, DEFAULT_SETTINGS.sources);
        }
        if (!this.settings.destRoot) {
            this.settings.destRoot = path.join(os.homedir(), "SiYuanBackup");
        }
    }

    async saveSettings() {
        // 排队写入配置，防止较早的异步保存覆盖刚完成的备份状态。
        const value = JSON.parse(JSON.stringify(this.settings));
        const pending = (this.settingsWrite || Promise.resolve()).catch(() => {}).then(() => this.saveData("settings.json", value));
        this.settingsWrite = pending;
        try { await pending; return true; }
        catch (e) {
            siyuan.showMessage(this.t("saveFailed", "设置保存失败，请检查工作空间的写入权限。") + " " + friendlyError(e), 6000, "error");
            return false;
        }
    }

    destRoot() { return expandHome(this.settings.destRoot); }

    activeSources() {
        const keys = [];
        for (const def of SOURCE_DEFS) {
            if (this.settings.sources[def.key]) keys.push(def.dir);
        }
        return keys;
    }

    /** 思源工作空间根目录：dataDir 的父目录 */
    workspace() {
        try {
            const dataDir = window.siyuan.config.system.dataDir || window.siyuan.config.system.workspaceDir;
            if (dataDir) {
                const abs = path.resolve(expandHome(dataDir));
                if (path.basename(abs) === "data") return path.dirname(abs);
                return abs;
            }
        } catch (e) { /* ignore */ }
        return ""; // 无法识别工作空间时由核心拒绝备份，不能猜测另一个笔记目录。
    }

    // ---------------- UI ----------------

    addStyle() {
        const css = fs.readFileSync(path.join(__dirname, "index.css"), "utf8");
        this.styleEl = document.createElement("style");
        this.styleEl.textContent = css;
        document.head.appendChild(this.styleEl);
    }

    /** 注册顶栏图标符号（调用基类 addIcons；注意勿与基类同名，否则无限递归） */
    registerIcons() {
        const svg = `<symbol id="iconSibkBackup" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${BACKUP_ICON_PATHS}</g></symbol>`;
        try { this.addIcons(svg); } catch (e) { console.error("[" + PLUGIN_NAME + "] 注册图标失败", e); }
    }

    addTopBarButton() {
        const self = this;
        this.topBarElement = this.addTopBar({
            icon: "iconSibkBackup",
            title: this.t("topbarTitle", "增量备份"),
            position: "right",
            callback: () => { self.openSettings(); },
        });
        if (this.topBarElement && this.topBarElement.addEventListener) {
            this.topBarElement.addEventListener("contextmenu", evt => { evt.preventDefault(); self.showMenu(evt); });
        }
        this.updateTopBar();
    }

    registerCommand() {
        const self = this;
        try {
            this.addCommand({
                langKey: "SIBK_BACKUP_NOW",
                langText: this.t("backupNow", "立即备份"),
                hotkey: "",
                callback: () => { self.scheduleBackup("manual"); },
            });
            this.addCommand({
                langKey: "SIBK_OPEN_WORKBENCH",
                langText: this.t("openWorkbench", "打开备份工作台"),
                hotkey: "",
                callback: () => self.openSettings(),
            });
        } catch (e) { /* ignore */ }
    }

    updateTopBar(text, kind) {
        if (text !== undefined) { this.status.text = text; this.status.kind = kind || "idle"; }
        this.refreshStatusViews();
        if (!this.topBarElement) return;
        const el = this.topBarElement;
        const warnings = (this.settings.lastResult && this.settings.lastResult.warnings) || [];
        const indicatorKind = this.running ? "running" : this.settings.lastError ? "error" : warnings.length ? "warning" : this.settings.lastBackupAt ? "success" : "idle";
        const detail = this.running ? this.status.text : this.settings.lastError ? this.t("lastBackupFailed", "最近一次备份未完成") + "：" + this.settings.lastError : warnings.length ? this.t("backupWithWarning", "备份已完成，请查看提示") + "：" + warnings.join("；") : this.settings.lastBackupAt ? this.t("lastBackup", "上次备份") + " " + readable(new Date(this.settings.lastBackupAt)) : this.t("neverBackup", "尚未备份");
        const label = this.t("topbarTitle", "本地增量备份") + " · " + detail + " · " + this.t("topbarHint", "单击打开工作台，右键查看快捷操作");
        el.setAttribute("aria-label", label);
        el.setAttribute("data-sibk-state", indicatorKind);
        const svg = el.querySelector("svg");
        if (svg) svg.style.opacity = this.running ? "0.7" : "1";
        let badge = el.querySelector(".sibk-badge");
        if (["running", "error", "warning"].includes(indicatorKind)) {
            if (!badge) {
                badge = document.createElement("span");
                badge.className = "sibk-badge";
                badge.setAttribute("aria-hidden", "true");
                el.style.position = "relative";
                el.appendChild(badge);
            }
            badge.setAttribute("data-kind", indicatorKind);
            badge.textContent = indicatorKind === "running" ? "" : "!";
        } else if (badge) badge.remove();
    }

    showMenu(evt) {
        const Menu = siyuan.Menu;
        const menu = new Menu("sibk-menu");
        menu.addItem({
            icon: "iconSibkBackup",
            label: this.t("backupNow", "立即备份"),
            disabled: this.running,
            click: () => { this.scheduleBackup("manual"); },
        });
        menu.addItem({
            icon: "iconFolder",
            label: this.t("openBackupDir", "打开备份目录"),
            click: () => { this.openPath(this.destRoot()); },
        });
        menu.addSeparator();
        menu.addItem({
            icon: "iconHistory",
            label: this.t("snapshots", "快照管理 / 恢复"),
            click: () => { this.openSnapshots(); },
        });
        menu.addItem({
            icon: "iconSettings",
            label: this.t("settings", "备份设置"),
            click: () => { this.openSettings(); },
        });
        menu.addItem({
            icon: "iconInfo",
            label: this.t("viewLog", "查看备份日志"),
            click: () => { this.openLog(); },
        });
        const rect = (evt && evt.currentTarget) ? evt.currentTarget.getBoundingClientRect() : null;
        menu.open(rect ? { x: rect.left, y: rect.bottom } : { x: 200, y: 200 });
    }

    /** 系统目录选择对话框；不可用或取消返回 null */
    async pickDirectory(current) {
        try {
            const remote = require("@electron/remote");
            const r = await remote.dialog.showOpenDialog({
                title: this.t("destRoot", "备份保存位置"),
                defaultPath: expandHome(current || os.homedir()),
                properties: ["openDirectory", "createDirectory"],
            });
            if (!r.canceled && r.filePaths && r.filePaths[0]) return r.filePaths[0];
        } catch (e) {
            siyuan.showMessage(this.t("pickerUnavailable", "无法打开系统目录选择器，请手动输入路径"), 4000, "error");
        }
        return null;
    }

    openPath(p) {
        try {
            const remote = require("@electron/remote");
            remote.shell.openPath(expandHome(p));
        } catch (e) {
            siyuan.showMessage(contractHome(p), 4000, "info");
        }
    }

    t(key, fallback) {
        return (this.i18n && this.i18n[key]) || fallback || key;
    }

    escapeHtml(s) {
        return String(s === undefined || s === null ? "" : s)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    // ---------------- 设置面板 ----------------

    // SiYuan's plugin settings entry uses the singular hook name.
    openSetting() { this.openSettings(); }

    icon(name, className = "") {
        const paths = {
            backup: BACKUP_ICON_PATHS,
            shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9S4 17 4 12V6l8-3Z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
            overview: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
            clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
            folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10H3Z"/>',
            history: '<path d="M3 11a9 9 0 1 1 2.6 7.4M3 4v7h7M12 7v5l3 2"/>',
            log: '<path d="M8 3H5v18h14V3h-3M9 3h6v4H9ZM8 12h8M8 16h6"/>',
            arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
            upload: '<path d="M12 16V4m-4 4 4-4 4 4M4 15v5h16v-5"/>',
            check: '<path d="m5 12 4 4L19 6"/>',
            back: '<path d="M19 12H5m5-5-5 5 5 5"/>',
            minimize: '<path d="M5 12h14"/>',
            close: '<path d="m6 6 12 12M18 6 6 18"/>',
            restore: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 9h16"/>',
        };
        return `<svg class="sibk-icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.folder}</svg>`;
    }

    createWindow({ key, title, content }) {
        this.windowRequest = (this.windowRequest || 0) + 1;
        const state = this.windowState || (this.windowState = { native: null, current: null, history: [], dock: null, minimized: false });
        const root = document.createElement("div");
        root.className = "sibk-view";
        root.innerHTML = content;
        if (state.current) {
            this.statusViews.delete(state.current.root);
            const previous = state.history.map(view => view.key).lastIndexOf(key);
            if (previous >= 0) state.history = state.history.slice(0, previous);
            else if (state.current.key !== key) state.history.push(state.current);
        }
        const view = { key, title, root, section: "overview" };
        root.addEventListener("focusin", event => { view.focused = event.target; });
        state.current = view;
        this.mountWindow();
        return { element: root, destroy: () => this.closeWindow() };
    }

    mountWindow() {
        const state = this.windowState;
        if (!state || !state.current) return;
        if (state.dock) { state.dock.remove(); state.dock = null; }
        state.minimized = false;
        if (!state.native) {
            const header = `<div class="sibk-window-chrome"><button type="button" class="sibk-window-control" data-window-back aria-label="${this.t("back", "返回")}" title="${this.t("back", "返回")}">${this.icon("back")}</button><span class="sibk-window-title" data-window-title></span><div class="sibk-window-controls"><button type="button" class="sibk-window-control" data-window-minimize aria-label="${this.t("minimizeWindow", "缩小窗口")}" title="${this.t("minimizeHint", "缩小为恢复条，后台任务继续")}">${this.icon("minimize")}</button><button type="button" class="sibk-window-control sibk-window-close" data-window-close aria-label="${this.t("closeWindow", "关闭窗口")}" title="${this.t("closeWindowHint", "关闭窗口，后台任务继续")}">${this.icon("close")}</button></div></div>`;
            const native = new siyuan.Dialog({
                title: header,
                content: '<div class="sibk-frame-content"></div>',
                width: "1060px", height: "min(86vh, 860px)",
                containerClassName: "sibk-dialog-container",
                hideCloseIcon: true, disableClose: true, disableAnimation: true,
                destroyCallback: () => {
                    if (this.windowState === state && state.native === native) this.closeWindow();
                },
            });
            state.native = native;
            const container = native.element.querySelector(".b3-dialog__container");
            container.classList.add("sibk-dialog-container");
            const controls = [["[data-window-back]", () => this.backWindow()], ["[data-window-minimize]", () => this.minimizeWindow()], ["[data-window-close]", () => this.closeWindow()]];
            for (const [selector, action] of controls) {
                const button = native.element.querySelector(selector);
                button.addEventListener("click", action);
                button.addEventListener("mousedown", event => event.stopPropagation());
                button.addEventListener("pointerdown", event => event.stopPropagation());
            }
            native.element.addEventListener("keydown", event => {
                if (event.key === "Escape" && !event.repeat && !event.isComposing) {
                    event.preventDefault(); event.stopPropagation(); this.closeWindow();
                }
            });
        }
        state.native.element.querySelector(".sibk-frame-content").replaceChildren(state.current.root);
        this.statusViews.add(state.current.root);
        this.updateWindowHeader();
        this.refreshStatusViews();
        state.native.element.querySelector(".b3-dialog__container").focus({ preventScroll: true });
    }

    ownsWindow(state, view, request) {
        return !!state && this.windowState === state && !state.minimized && state.current === view && this.windowRequest === request;
    }

    updateWindowHeader() {
        const state = this.windowState;
        if (!state || !state.native || !state.current) return;
        const title = state.current.title.includes("v" + PLUGIN_VERSION) ? state.current.title : state.current.title + " · v" + PLUGIN_VERSION;
        const element = state.native.element;
        element.querySelector("[data-window-title]").textContent = title;
        const container = element.querySelector(".b3-dialog__container");
        container.removeAttribute("aria-labelledby");
        container.setAttribute("aria-label", title);
        element.querySelector("[data-window-back]").disabled = !state.history.length && !(state.current.key === "settings" && state.current.section !== "overview");
    }

    backWindow() {
        this.windowRequest = (this.windowRequest || 0) + 1;
        const state = this.windowState;
        if (!state || !state.current) return;
        if (state.current.key === "settings" && state.current.section !== "overview") {
            state.current.selectSection("overview", true);
            return;
        }
        if (!state.history.length) return;
        this.statusViews.delete(state.current.root);
        state.current = state.history.pop();
        this.mountWindow();
        if (state.current.key === "settings") this.renderStatBox(state.current.root.querySelector("#sibkStatBox"), state.current.root.querySelector("#sibkRecentList"));
        const focus = state.current.root.querySelector('[role="tab"][aria-selected="true"]') || state.native.element.querySelector("[data-window-back]");
        if (focus) focus.focus({ preventScroll: true });
    }

    minimizeWindow() {
        this.windowRequest = (this.windowRequest || 0) + 1;
        const state = this.windowState;
        if (!state || !state.native || !state.current) return;
        state.focused = state.current.root.contains(document.activeElement) ? document.activeElement : state.current.focused || null;
        state.current.root.remove();
        this.statusViews.delete(state.current.root);
        const native = state.native;
        state.native = null;
        state.minimized = true;
        // Destroy the modal host to release its backdrop and keyboard focus trap.
        // The detached view keeps its inputs, event handlers and scroll positions.
        native.destroy();
        const dock = document.createElement("div");
        dock.className = "sibk-dock";
        dock.style.zIndex = String(((window.siyuan && window.siyuan.zIndex) || 1000) + 1);
        dock.innerHTML = `<button type="button" class="sibk-dock-restore" data-window-restore aria-label="${this.t("restoreWindow", "恢复备份窗口")}">${this.icon("restore")}<span>${this.t("workbenchTitle", "备份工作台")}<small>${this.t("minimizedHint", "已缩小 · 点击恢复")}</small></span></button><button type="button" class="sibk-window-control sibk-window-close" data-dock-close aria-label="${this.t("closeWindow", "关闭窗口")}">${this.icon("close")}</button>`;
        state.dock = dock;
        document.body.appendChild(dock);
        dock.querySelector("[data-window-restore]").addEventListener("click", () => this.restoreWindow());
        dock.querySelector("[data-dock-close]").addEventListener("click", () => this.closeWindow());
        dock.querySelector("[data-window-restore]").focus();
    }

    restoreWindow() {
        this.windowRequest = (this.windowRequest || 0) + 1;
        const state = this.windowState;
        if (!state) return;
        this.mountWindow();
        if (state.current && state.current.key === "settings") this.renderStatBox(state.current.root.querySelector("#sibkStatBox"), state.current.root.querySelector("#sibkRecentList"));
        if (state.focused && state.focused.isConnected) state.focused.focus({ preventScroll: true });
    }

    closeWindow() {
        this.windowRequest = (this.windowRequest || 0) + 1;
        const state = this.windowState;
        if (!state) return;
        this.windowState = null;
        this.statusViews.delete(state.current && state.current.root);
        for (const view of state.history) this.statusViews.delete(view.root);
        if (state.dock) state.dock.remove();
        if (state.native) state.native.destroy();
    }

    setupNavigation(root, initial = "overview") {
        const tabs = Array.from(root.querySelectorAll("[data-section]"));
        const select = (name, focus = false) => {
            this.windowRequest = (this.windowRequest || 0) + 1;
            for (const tab of tabs) {
                const active = tab.getAttribute("data-section") === name;
                tab.setAttribute("aria-selected", String(active));
                tab.tabIndex = active ? 0 : -1;
                if (active && focus) tab.focus();
            }
            root.querySelectorAll("[data-page]").forEach(page => { page.hidden = page.getAttribute("data-page") !== name; });
            root.querySelectorAll("[data-settings-action]").forEach(button => { button.hidden = name === "overview"; });
            const backup = root.querySelector("#sibkBackupNow");
            if (backup) backup.hidden = name !== "overview";
            const current = this.windowState && this.windowState.current;
            if (current && current.root === root) { current.section = name; this.updateWindowHeader(); }
        };
        tabs.forEach((tab, index) => {
            tab.addEventListener("click", () => select(tab.getAttribute("data-section")));
            tab.addEventListener("keydown", event => {
                const offsets = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
                let next;
                if (event.key in offsets) next = (index + offsets[event.key] + tabs.length) % tabs.length;
                else if (event.key === "Home") next = 0;
                else if (event.key === "End") next = tabs.length - 1;
                if (next === undefined) return;
                event.preventDefault();
                select(tabs[next].getAttribute("data-section"), true);
            });
        });
        const current = this.windowState && this.windowState.current;
        if (current && current.root === root) current.selectSection = select;
        select(initial);
    }

    statusMarkup() {
        return `<div class="sibk-status" data-kind="idle" role="status" aria-live="polite" aria-atomic="true">
            ${this.icon("shield", "sibk-status-emblem")}
            <div class="sibk-status-heading"><span class="sibk-status-dot" aria-hidden="true"></span><span data-status-title></span></div>
            <div class="sibk-status-detail" data-status-detail></div>
            <progress data-status-progress max="100" aria-label="${this.t("backupProgress", "备份进度")}" hidden></progress>
            <div class="sibk-status-actions" hidden><button class="b3-button b3-button--text" data-cancel-backup>${this.t("cancelBackup", "取消本次备份")}</button></div>
        </div>`;
    }

    trackStatus(root) {
        this.statusViews.add(root);
        const button = root.querySelector("[data-cancel-backup]");
        if (button) button.addEventListener("click", () => {
            this.canceled = true;
            this.updateTopBar(this.t("canceling", "正在停止，请等待当前文件处理完成…"), "running");
        });
        this.refreshStatusViews();
    }

    refreshStatusViews() {
        for (const root of this.statusViews) {
            if (root.isConnected === false) { this.statusViews.delete(root); continue; }
            const box = root.querySelector(".sibk-status");
            if (!box) continue;
            const failed = this.settings.lastError;
            const warnings = (this.settings.lastResult && this.settings.lastResult.warnings) || [];
            const last = this.settings.lastBackupAt;
            const kind = this.running ? "running" : failed ? "error" : last ? "success" : "idle";
            box.setAttribute("data-kind", kind);
            const title = this.running ? this.status.text : failed ? this.t("lastBackupFailed", "最近一次备份未完成") : warnings.length ? this.t("backupWithWarning", "备份已完成，请查看提示") : last ? this.t("backupReady", "最近一次备份已完成") : this.t("firstBackupTitle", "先为笔记创建第一份备份");
            const detail = this.running ? this.t("runningHint", "完成并通过校验后才会发布快照；可以安全取消。") : failed ? failed : warnings.length ? warnings.join("；") : last ? this.t("lastBackup", "上次备份") + " · " + readable(new Date(last)) : this.t("firstBackupHint", "选择工作空间以外的保存位置，再点击“保存并备份”。");
            const result = this.settings.lastResult;
            const summary = !this.running && !failed && !warnings.length && last && result && Number.isFinite(result.copied) && Number.isFinite(result.linked) && Number.isFinite(result.ms)
                ? " · " + this.t("changed", "新增/变更") + " " + result.copied + "，" + this.t("reused", "复用") + " " + result.linked + "，" + (result.ms / 1000).toFixed(1) + "s" : "";
            box.querySelector("[data-status-title]").textContent = title;
            box.querySelector("[data-status-detail]").textContent = detail + summary;
            const progress = box.querySelector("[data-status-progress]");
            progress.hidden = !this.running;
            if (typeof this.status.progress === "number") progress.value = this.status.progress;
            else progress.removeAttribute("value");
            box.querySelector(".sibk-status-actions").hidden = !this.running;
            const cancel = box.querySelector("[data-cancel-backup]");
            cancel.hidden = this.operation !== "backup";
            cancel.disabled = this.canceled;
            for (const selector of ["#sibkBackupNow", "#sibkRunNow", "#sibkSave", "#sibkSnapBackup"]) {
                const button = root.querySelector(selector);
                if (button) button.disabled = this.running || this.savingSettings;
            }
        }
    }

    openSettings(initialPage = "overview", refresh = false) {
        this.windowRequest = (this.windowRequest || 0) + 1;
        const state = this.windowState;
        if (state && state.minimized && !refresh) { this.restoreWindow(); return; }
        if (state && state.current && state.current.key === "settings" && !refresh) {
            state.current.selectSection(initialPage, true); return;
        }
        if (!["overview", "plan", "scope"].includes(initialPage)) initialPage = "overview";
        const s = this.settings;
        const sourceText = {
            data: ["scopeDataTitle", "笔记与附件", "scopeDataDetail", "笔记本、图片、文档和插件 · data"],
            conf: ["scopeConfTitle", "偏好与配置", "scopeConfDetail", "外观、快捷键与工作空间配置 · conf"],
            history: ["scopeHistoryTitle", "编辑历史", "scopeHistoryDetail", "历史编辑记录，可能占用较多空间 · history"],
            repo: ["scopeRepoTitle", "数据仓库", "scopeRepoDetail", "思源数据仓库，请确认目录存在 · repo"],
        };
        const sourceHtml = SOURCE_DEFS.map((def) => {
            const [titleKey, title, detailKey, detail] = sourceText[def.key];
            return `<label class="sibk-source-option">${this.icon(def.key === "history" ? "history" : "folder")}<span><strong>${this.t(titleKey, title)}</strong><span class="sibk-source-detail">${this.t(detailKey, detail)}</span></span><input type="checkbox" class="b3-switch" data-source="${def.key}"${s.sources[def.key] ? " checked" : ""}></label>`;
        }).join("");
        const presets = [0, 30, 60, 120, 1440, 10080];
        const title = this.t("workbenchTitle", "备份工作台");
        const html = `<div class="b3-dialog__content sibk-workbench">
            <aside class="sibk-sidebar">
                <div class="sibk-brand">${this.icon("backup")}<span>${this.t("topbarTitle", "本地增量备份")}<small>v${PLUGIN_VERSION}</small></span></div>
                <nav class="sibk-navigation" aria-label="${this.t("backupNavigation", "备份导航")}">
                    <div role="tablist" aria-orientation="vertical">
                        ${[["overview", "overview", "navOverview", "备份概览"], ["plan", "clock", "navPlan", "自动计划"], ["scope", "folder", "navScope", "备份范围"]].map(([id, icon, key, text]) => `<button type="button" class="sibk-nav-item" id="sibkTab-${id}" role="tab" data-section="${id}" aria-controls="sibkPage-${id}" aria-selected="${id === initialPage}" tabindex="${id === initialPage ? 0 : -1}">${this.icon(icon)}${this.t(key, text)}</button>`).join("")}
                    </div>
                    <div class="sibk-nav-divider"></div>
                    <button class="sibk-nav-item" id="sibkManage">${this.icon("history")}${this.t("navSnapshots", "快照与恢复")}</button>
                    <button class="sibk-nav-item" id="sibkWorkbenchLog">${this.icon("log")}${this.t("viewLog", "查看备份日志")}</button>
                </nav>
                <div class="sibk-sidebar-note">${this.icon("shield")}<span>${this.t("localOnly", "本地保存，独立留存")}<small>${this.t("localOnlyHint", "备份位置由你掌握")}</small></span></div>
            </aside>
            <div class="sibk-main">
                <section id="sibkPage-overview" data-page="overview" role="tabpanel" aria-labelledby="sibkTab-overview" tabindex="0">
                    <header class="sibk-page-header"><h2>${this.t("navOverview", "备份概览")}</h2><p>${this.t("overviewIntro", "确认最近备份，留好每一次积累。")}</p></header>
                    ${this.statusMarkup()}
                    <div class="sibk-overview-location">${this.icon("folder")}<span><span class="sibk-hint">${this.t("destRoot", "备份保存位置")}</span><strong class="sibk-path">${this.escapeHtml(contractHome(s.destRoot))}</strong></span></div>
                    <div id="sibkStatBox" class="sibk-overview-stats"></div>
                    <div class="sibk-section-bar"><h3>${this.t("recentSnapshots", "最近快照")}</h3><button class="sibk-text-button" id="sibkViewAll">${this.t("viewAll", "查看全部")}${this.icon("arrow")}</button></div>
                    <div id="sibkRecentList" class="sibk-recent-list"><p class="sibk-hint">${this.t("loading", "读取快照…")}</p></div>
                    <div class="sibk-plan-summary">${this.icon("clock")}<span>${this.t("currentPlan", "当前计划")}<strong>${s.autoStart && s.intervalMinutes > 0 ? s.intervalMinutes + " " + this.t("planMinutes", "分钟 / 次") : this.t("timerOff", "关闭定时")}</strong></span><span>${this.t("historyPolicy", "历史保留")}<strong>${s.autoPrune ? this.t("retentionEnabled", "按保留策略清理") : this.t("keepAllHistory", "保留全部快照")}</strong></span></div>
                </section>
                <section id="sibkPage-plan" data-page="plan" role="tabpanel" aria-labelledby="sibkTab-plan" tabindex="0" hidden>
                    <header class="sibk-page-header"><h2>${this.t("navPlan", "自动计划")}</h2><p>${this.t("planIntro", "安排合适的备份节奏，尽量在空闲时执行。")}</p></header>
                    <div class="sibk-field"><label for="sibkDest" class="sibk-label">${this.t("destRoot", "备份保存位置")}</label><div class="sibk-inline"><input id="sibkDest" class="b3-text-field" spellcheck="false" value="${this.escapeHtml(contractHome(s.destRoot))}" aria-describedby="sibkDestHint"><button class="sibk-secondary" id="sibkPick">${this.t("pickFolder", "选择…")}</button></div><p class="sibk-hint" id="sibkDestHint">${this.t("destRootHint", "建议选择另一块磁盘，不能放在当前工作空间内。")}</p></div>
                    <div class="sibk-form-grid">
                        <div class="sibk-field"><label for="sibkIntervalSel" class="sibk-label">${this.t("interval", "自动备份频率")}</label><select id="sibkIntervalSel" class="b3-select">${[[0, "timerOff", "关闭定时"], [30, "every30m", "每 30 分钟"], [60, "everyHour", "每小时"], [120, "every2h", "每 2 小时"], [1440, "everyDay", "每天一次"], [10080, "everyWeek", "每周一次"]].map(([v, key, label]) => `<option value="${v}"${s.intervalMinutes === v ? " selected" : ""}>${this.t(key, label)}</option>`).join("")}<option value="custom"${!presets.includes(s.intervalMinutes) ? " selected" : ""}>${this.t("custom", "自定义（分钟）")}</option></select><div class="sibk-inline sibk-custom-interval" id="sibkCustomInterval"${presets.includes(s.intervalMinutes) ? " hidden" : ""}><input id="sibkInterval" class="b3-text-field" aria-label="${this.t("customMinutes", "自定义间隔（分钟）")}" type="number" min="1" step="1" value="${s.intervalMinutes || 60}"></div></div>
                        <div class="sibk-field"><label for="sibkIdle" class="sibk-label">${this.t("idleMinutes", "等待空闲（分钟）")}</label><input id="sibkIdle" class="b3-text-field" type="number" min="0" step="1" value="${s.idleMinutes}" aria-describedby="sibkIdleHint"><p class="sibk-hint" id="sibkIdleHint">${this.t("idleHint", "定时备份等待空闲后执行；0 表示不等待。")}</p></div>
                    </div>
                    <div class="sibk-toggle-list"><label class="sibk-toggle-row"><span><strong>${this.t("autoStart", "启动后开启定时备份")}</strong><span class="sibk-source-detail">${this.t("autoStartDetail", "按照上方频率，在思源空闲后自动执行。")}</span></span><input type="checkbox" id="sibkAutoStart" class="b3-switch"${s.autoStart ? " checked" : ""}></label><label class="sibk-toggle-row"><span><strong>${this.t("dailyFirst", "每天首次启动时备份一次")}</strong><span class="sibk-source-detail">${this.t("dailyFirstDetail", "独立于定时计划，仅在备份成功后记录当天完成。")}</span></span><input type="checkbox" id="sibkDailyFirst" class="b3-switch"${s.dailyFirst ? " checked" : ""}></label></div>
                </section>
                <section id="sibkPage-scope" data-page="scope" role="tabpanel" aria-labelledby="sibkTab-scope" tabindex="0" hidden>
                    <header class="sibk-page-header"><h2>${this.t("navScope", "备份范围")}</h2><p>${this.t("scopeIntro", "选择需要留存的内容，笔记和附件建议始终保留。")}</p></header>
                    <div class="sibk-sources">${sourceHtml}</div><p class="sibk-hint">${this.t("sourceHint", "工作空间：")}${this.escapeHtml(contractHome(this.workspace()))}</p>
                    <details class="sibk-disclosure"><summary>${this.t("advancedSettings", "历史保留与排除规则")}</summary><label class="sibk-toggle-row"><span>${this.t("autoPrune", "自动清理历史快照")}</span><input type="checkbox" id="sibkAutoPrune" class="b3-switch"${s.autoPrune ? " checked" : ""}></label><p class="sibk-hint">${this.t("retentionHint", "默认关闭，保留所有历史。开启后仅在新备份成功时清理：优先保留最近 10 份，更早每天一份，并受份数上限限制。")}</p><div class="sibk-field"><label for="sibkKeep" class="sibk-label">${this.t("keepCount", "最多保留快照份数")}</label><input id="sibkKeep" class="b3-text-field" type="number" min="1" step="1" value="${s.keepCount}"></div><div class="sibk-field"><label for="sibkExcludes" class="sibk-label">${this.t("excludes", "额外排除规则（每行一条）")}</label><textarea id="sibkExcludes" class="b3-text-field" rows="3" spellcheck="false" placeholder="cache/&#10;*.zip">${this.escapeHtml(s.extraExcludes || "")}</textarea><p class="sibk-hint">${this.t("excludeHint", "默认排除临时文件、日志和 node_modules；排除内容不会备份。")}</p></div></details>
                </section>
                <div id="sibkSettingsError" class="sibk-error" role="alert" tabindex="-1"></div>
            </div>
        </div><div class="b3-dialog__action sibk-footer"><button class="sibk-text-button" id="sibkOpenFolder">${this.icon("folder")}${this.t("openBackupDir", "打开备份目录")}</button><span class="sibk-footer-spacer"></span><button class="sibk-secondary" id="sibkSave" data-settings-action hidden>${this.t("save", "保存")}</button><button class="sibk-primary" id="sibkRunNow" data-settings-action hidden>${this.t("saveAndBackup", "保存并备份")}</button><button class="sibk-primary" id="sibkBackupNow">${this.icon("upload")}${this.t("backupNow", "立即备份")}</button></div>`;
        const dialog = this.createWindow({ key: "settings", title: title + " · v" + PLUGIN_VERSION, content: html });
        const root = dialog.element;
        this.trackStatus(root);
        this.setupNavigation(root, initialPage);
        this.renderStatBox(root.querySelector("#sibkStatBox"), root.querySelector("#sibkRecentList"));
        root.querySelector("#sibkWorkbenchLog").addEventListener("click", () => this.openLog());
        root.querySelector("#sibkOpenFolder").addEventListener("click", () => this.openPath(this.destRoot()));
        root.querySelector("#sibkBackupNow").addEventListener("click", () => this.scheduleBackup("manual"));
        root.querySelector("#sibkViewAll").addEventListener("click", () => { this.openSnapshots(); });
        root.querySelector("#sibkManage").addEventListener("click", () => { this.openSnapshots(); });
        root.querySelector("#sibkIntervalSel").addEventListener("change", () => {
            root.querySelector("#sibkCustomInterval").hidden = root.querySelector("#sibkIntervalSel").value !== "custom";
        });
        root.querySelector("#sibkPick").addEventListener("click", async () => {
            const picked = await this.pickDirectory(root.querySelector("#sibkDest").value);
            if (picked) root.querySelector("#sibkDest").value = contractHome(picked);
        });
        const save = async (backup) => {
            const owner = this.windowState, view = owner && owner.current, request = this.windowRequest;
            const error = root.querySelector("#sibkSettingsError");
            const showError = message => { if (this.ownsWindow(owner, view, request)) { error.textContent = message; error.focus(); } };
            error.textContent = "";
            if (this.running || this.savingSettings) { showError(this.t("waitOperation", "请等待当前操作完成后再修改设置。")); return; }
            let next;
            try { next = this.collectSettings(root); }
            catch (e) { showError(e.message); return; }
            try { await validateBackupPaths(this.workspace(), next.destRoot); }
            catch (e) { showError(friendlyError(e)); return; }
            if (this.running || this.savingSettings) { showError(this.t("waitOperation", "请等待当前操作完成。")); return; }
            this.savingSettings = true;
            const previous = this.settings;
            this.settings = next;
            root.querySelector("#sibkSave").disabled = true;
            root.querySelector("#sibkRunNow").disabled = true;
            if (!await this.saveSettings()) {
                this.settings = previous;
                this.savingSettings = false;
                showError(this.t("saveFailed", "设置保存失败，请检查工作空间的写入权限。"));
                root.querySelector("#sibkSave").disabled = false;
                root.querySelector("#sibkRunNow").disabled = false;
                return;
            }
            this.savingSettings = false;
            this.startTimer();
            this.updateTopBar();
            if (this.ownsWindow(owner, view, request)) this.openSettings("overview", true);
            if (backup) await this.scheduleBackup("manual");
            else siyuan.showMessage(this.t("saved", "设置已保存"), 3000, "info");
        };
        root.querySelector("#sibkRunNow").addEventListener("click", () => save(true));
        root.querySelector("#sibkSave").addEventListener("click", () => save(false));
    }

    collectSettings(root) {
        const s = { ...this.settings, sources: { ...this.settings.sources } };
        const dest = root.querySelector("#sibkDest").value.trim();
        s.destRoot = dest ? expandHome(dest) : path.join(os.homedir(), "SiYuanBackup");
        if (!path.isAbsolute(s.destRoot) || isPathInside(s.destRoot, this.workspace())) throw new Error(this.t("invalidDestination", "请输入工作空间以外的绝对路径。"));
        root.querySelectorAll("[data-source]").forEach((el) => { s.sources[el.getAttribute("data-source")] = el.checked; });
        if (!Object.values(s.sources).some(Boolean)) throw new Error(this.t("noSource", "请先选择备份范围。"));
        const integer = (value, min) => {
            const number = Number(value);
            if (String(value).trim() === "" || !Number.isSafeInteger(number) || number < min) throw new Error(this.t("invalidNumber", "请输入有效的整数：间隔和空闲时间不能为负数，保留份数至少为 1。"));
            return number;
        };
        const choice = root.querySelector("#sibkIntervalSel").value;
        s.intervalMinutes = integer(choice === "custom" ? root.querySelector("#sibkInterval").value : choice, choice === "custom" ? 1 : 0);
        s.idleMinutes = integer(root.querySelector("#sibkIdle").value, 0);
        s.keepCount = integer(root.querySelector("#sibkKeep").value, 1);
        s.extraExcludes = root.querySelector("#sibkExcludes").value;
        s.autoStart = root.querySelector("#sibkAutoStart").checked;
        s.dailyFirst = root.querySelector("#sibkDailyFirst").checked;
        s.autoPrune = root.querySelector("#sibkAutoPrune").checked;
        return s;
    }

    async renderStatBox(box, recent) {
        if (!box) return;
        box.innerHTML = `<p class="sibk-hint">${this.t("loading", "读取快照…")}</p>`;
        try {
            const snaps = await listSnapshots(this.destRoot());
            const last = snaps.length ? snaps[snaps.length - 1] : null;
            if (recent) recent.innerHTML = snaps.slice(-3).reverse().map(snap => `<div class="sibk-recent-row">${this.icon("history")}<span><strong>${readable(new Date(snap.time))}</strong><small>${this.escapeHtml(snap.note || this.t("snapshotCopy", "独立目录快照"))}</small></span><span class="sibk-recent-meta">${snap.files} ${this.t("files", "个文件")}<small>${this.t("written", "实际写入")} ${humanSize(snap.bytes)}</small></span></div>`).join("") || `<div class="sibk-empty">${this.icon("history")}<strong>${this.t("noSnapshots", "还没有备份快照")}</strong><span>${this.t("emptySnapshotHint", "创建第一份备份后，可以在这里校验、导出并查看历史版本。")}</span></div>`;
            box.innerHTML = `<div class="sibk-stat">
                <div class="sibk-stat-row"><span>${this.t("snapshotCount", "已有快照")}</span><strong>${snaps.length}</strong></div>
                <div class="sibk-stat-row"><span>${this.t("latestSnapshot", "最新快照")}</span><strong>${last ? readable(new Date(last.time)) : "—"}</strong></div>
                <div class="sibk-stat-row"><span>${this.t("latestWritten", "最新一次写入")}</span><strong>${last ? humanSize(last.bytes) : "—"}</strong></div>
            </div><p class="sibk-hint">${this.t("statsFastHint", "仅读取快照清单，不扫描历史文件。完整性请在快照管理中点击“校验”。")}</p>`;
        } catch (e) {
            box.textContent = this.t("statFailed", "无法读取快照") + "：" + friendlyError(e);
            if (recent) recent.textContent = this.t("statFailed", "无法读取快照");
        }
    }

    async openLog() {
        const request = this.windowRequest = (this.windowRequest || 0) + 1;
        const logPath = path.join(this.destRoot(), LOG_NAME);
        let content = "";
        try {
            const text = await fsp.readFile(logPath, "utf8");
            const lines = text.trim().split("\n");
            content = lines.slice(-200).reverse().join("\n") || this.t("emptyLog", "暂无日志");
        } catch (e) {
            content = this.t("emptyLog", "暂无日志");
        }
        if (request !== this.windowRequest) return;
        const dialog = this.createWindow({ key: "log",
            title: this.t("logTitle", "备份日志"),
            content: `<div class="b3-dialog__content sibk-log-page"><div class="sibk-log">${this.escapeHtml(content)}</div></div>
<div class="b3-dialog__action">

    <div class="fn__space"></div>
    <button class="b3-button b3-button--text" id="sibkOpenLog">${this.t("openBackupDir", "打开备份目录")}</button>
</div>`,
        });
        dialog.element.querySelector("#sibkOpenLog").addEventListener("click", () => this.openPath(this.destRoot()));
    }

    // ---------------- 快照管理 ----------------

    async openSnapshots() {
        const request = this.windowRequest = (this.windowRequest || 0) + 1;
        let snaps;
        try { snaps = await listSnapshots(this.destRoot(), { includeIncomplete: true }); }
        catch (e) { siyuan.showMessage(friendlyError(e), 6000, "error"); return; }
        if (request !== this.windowRequest) return;
        const incomplete = snaps.filter((s) => !s.complete).length;
        const rows = snaps.slice().reverse().map((s) => `<tr data-snap="${this.escapeHtml(s.name)}" data-search="${this.escapeHtml(readable(new Date(s.time)) + " " + s.name + " " + (s.note || ""))}">
            <td><span class="sibk-time">${this.icon("history")}${readable(new Date(s.time))}</span>${!s.complete ? `<div class="sibk-error">${this.t("incompleteSnapshot", "未完成 / 清单异常")}</div>` : ""}</td>
            <td>${s.files || 0}</td><td>${s.copied || 0} / ${s.linked || 0}</td>
            <td>${humanSize(s.bytes)}</td><td class="sibk-note" title="${this.escapeHtml(s.note)}">${this.escapeHtml(s.note || "—")}</td>
            <td class="sibk-actions">
                <button class="b3-button b3-button--small b3-button--text" data-act="verify"${!s.complete ? " disabled" : ""}>${this.t("verify", "校验")}</button>
                <button class="b3-button b3-button--small b3-button--text" data-act="restore"${!s.complete ? " disabled" : ""}>${this.t("restore", "恢复")}</button>
                <button class="b3-button b3-button--small b3-button--text" data-act="note"${!s.complete ? " disabled" : ""}>${this.t("editNote", "备注")}</button>
                <button class="b3-button b3-button--small b3-button--text" data-act="open">${this.t("open", "打开")}</button>
                <button class="b3-button b3-button--small b3-button--text" data-act="del"${!s.complete ? " disabled" : ""}>${this.t("delete", "删除")}</button>
            </td></tr>`).join("");
        const dialog = this.createWindow({ key: "snapshots",
            title: this.t("snapshotsTitle", "快照管理 / 恢复") + " · v" + PLUGIN_VERSION,
            content: `<div class="b3-dialog__content sibk-snapshots">
                <header class="sibk-page-header sibk-page-header-inline"><div><h2>${this.t("navSnapshots", "快照与恢复")}</h2><p>${this.escapeHtml(contractHome(this.destRoot()))}</p></div><span class="sibk-version">v${PLUGIN_VERSION}</span></header>
                ${this.statusMarkup()}
                <p class="sibk-hint">${this.t("snapshotsHint", "每份快照可独立导出。先校验，再选择恢复；“实际写入”仅表示创建该快照时复制的字节数。")}</p>
                ${incomplete ? `<p class="sibk-warning">${incomplete} ${this.t("incompleteHint", "份快照未完成或清单异常，已保留原文件，不参与恢复和自动清理。可打开目录检查。")}</p>` : ""}
                <div class="sibk-search-row"><label for="sibkSnapshotSearch" class="sibk-search-label">${this.t("findSnapshot", "查找快照")}</label><input type="search" id="sibkSnapshotSearch" class="b3-text-field" placeholder="${this.t("searchSnapshotPlaceholder", "搜索日期、快照名或备注")}" aria-describedby="sibkSearchCount"><span id="sibkSearchCount" class="sibk-hint" role="status" aria-atomic="true"></span></div>
                <p id="sibkNoMatches" class="sibk-hint" hidden>${this.t("noMatchingSnapshots", "没有匹配的快照，请换个日期或关键词。")}</p>
                <p id="sibkSnapshotResult" class="sibk-hint" role="status" aria-live="polite"></p>
                <div class="sibk-scroll"><table class="sibk-table"><thead><tr>
                    <th scope="col">${this.t("colTime", "时间")}</th><th scope="col">${this.t("colFiles", "文件数")}</th><th scope="col">${this.t("colChanges", "复制 / 链接")}</th><th scope="col">${this.t("colBytes", "实际写入")}</th><th scope="col">${this.t("colNote", "备注")}</th><th scope="col">${this.t("colActions", "操作")}</th>
                </tr></thead><tbody>${rows || `<tr><td colspan="6" class="sibk-empty"><strong>${this.t("noSnapshots", "还没有备份快照")}</strong>${this.t("emptySnapshotHint", "创建第一份备份后，可以在这里校验、导出并查看历史版本。")}</td></tr>`}</tbody></table></div>
            </div><div class="b3-dialog__action sibk-footer"><button class="sibk-text-button" id="sibkSnapshotFolder">${this.t("openBackupDir", "打开备份目录")}</button><span class="sibk-footer-spacer"></span><button class="sibk-primary" id="sibkSnapBackup">${this.t("backupNow", "立即备份")}</button></div>`
        });
        const root = dialog.element;
        this.trackStatus(root);
        root.querySelector("#sibkSnapshotFolder").addEventListener("click", () => this.openPath(this.destRoot()));
        root.querySelector("#sibkSnapBackup").addEventListener("click", () => this.scheduleBackup("manual"));
        const search = root.querySelector("#sibkSnapshotSearch");
        const filter = () => {
            const query = search.value.trim().toLocaleLowerCase();
            let shown = 0;
            root.querySelectorAll("tr[data-snap]").forEach(row => {
                row.hidden = !row.getAttribute("data-search").toLocaleLowerCase().includes(query);
                if (!row.hidden) shown++;
            });
            root.querySelector("#sibkSearchCount").textContent = this.t("showingSnapshots", "显示快照") + " " + shown + " / " + snaps.length;
            root.querySelector("#sibkNoMatches").hidden = shown > 0 || snaps.length === 0;
        };
        search.addEventListener("input", filter);
        filter();
        root.querySelector("tbody").addEventListener("click", async (evt) => {
            const btn = evt.target.closest("button[data-act]");
            if (!btn || btn.disabled) return;
            const name = btn.closest("tr").getAttribute("data-snap");
            const snapshot = snaps.find((s) => s.name === name);
            if (!snapshot) return;
            const act = btn.getAttribute("data-act");
            if (act === "open") { this.openPath(snapshot.path); return; }
            if (this.running) { siyuan.showMessage(this.t("waitOperation", "请等待当前操作完成。"), 4000, "info"); return; }
            if (act === "restore") { this.openRestore(snapshot.path); }
            else if (act === "verify") {
                const result = root.querySelector("#sibkSnapshotResult");
                await this.performOperation("verify", async () => {
                    result.textContent = this.t("verifying", "正在读取文件并校验内容…");
                    const checked = await withDestinationLock(path.dirname(snapshot.path), () => verifySnapshot(snapshot.path, { shouldStop: () => this.canceled }));
                    result.textContent = checked.ok ? `${this.t("verifyDone", "校验通过")} · ${checked.files} ${this.t("files", "个文件")}${checked.legacy ? " · " + this.t("legacyVerify", "旧版快照仅核对结构与大小，缺少创建时的内容指纹。") : " · SHA-256"}` : this.t("verifyFailed", "校验未通过") + "：" + checked.error;
                });
            } else if (act === "note") this.editSnapshotNote(snapshot.path, () => { this.openSnapshots(); });
            else if (act === "del") {
                const owner = this.windowState, view = owner && owner.current, request = this.windowRequest;
                siyuan.confirm(this.t("delete", "删除"), this.t("deleteConfirm", "删除后无法撤销，确定删除快照") + " " + name + "？", async () => {
                    const done = await this.performOperation("delete", () => withDestinationLock(path.dirname(snapshot.path), async () => {
                        if (!await readManifest(snapshot.path)) throw new Error(this.t("invalidSnapshot", "清单异常，已保留快照，请手动检查。"));
                        await removeSnapshot(snapshot.path, { locked: true });
                    }));
                    if (done && this.ownsWindow(owner, view, request)) this.openSnapshots();
                });
            }
        });
    }

    async performOperation(kind, action) {
        if (this.running) { siyuan.showMessage(this.t("waitOperation", "请等待当前操作完成。"), 4000, "info"); return false; }
        this.running = true;
        this.operation = kind;
        this.canceled = false;
        this.status.progress = null;
        this.updateTopBar(this.t("operationRunning", "正在处理，请稍候…"), "running");
        try { await action(); return true; }
        catch (e) { siyuan.showMessage(friendlyError(e), 8000, "error"); return false; }
        finally { this.running = false; this.operation = null; this.updateTopBar("", "idle"); }
    }

    async editSnapshotNote(snapPath, onDone) {
        const request = this.windowRequest = (this.windowRequest || 0) + 1;
        const manifest = await readManifest(snapPath);
        if (request !== this.windowRequest) return;
        if (!manifest) { siyuan.showMessage(this.t("invalidSnapshot", "清单异常，已保留快照，请手动检查。"), 6000, "error"); return; }
        const dialog = this.createWindow({ key: "note", title: this.t("editNote", "快照备注"),
            content: `<div class="b3-dialog__content sibk-note-editor"><label for="sibkNoteInput" class="sibk-label">${this.t("editNote", "快照备注")}</label><input id="sibkNoteInput" class="b3-text-field fn__block" maxlength="500" value="${this.escapeHtml(manifest.note || "")}" placeholder="${this.t("notePlaceholder", "例如：每周留存")}"></div><div class="b3-dialog__action sibk-footer"><span class="sibk-footer-spacer"></span><button class="b3-button" id="sibkNoteSave">${this.t("save", "保存")}</button></div>` });
        const root = dialog.element;
        root.querySelector("#sibkNoteSave").addEventListener("click", async () => {
            const owner = this.windowState, view = owner && owner.current, request = this.windowRequest;
            const done = await this.performOperation("note", () => withDestinationLock(path.dirname(snapPath), async () => {
                const current = await readManifest(snapPath);
                if (!current) throw new Error(this.t("invalidSnapshot", "快照清单无法读取。"));
                current.note = root.querySelector("#sibkNoteInput").value.trim();
                // Sibling temporary files cannot invalidate a snapshot if the app exits mid-edit.
                const temporary = path.join(path.dirname(snapPath), ".note-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(16).slice(2) + ".tmp");
                const handle = await fsp.open(temporary, "wx", 0o600);
                let renamed = false;
                try {
                    try { await handle.writeFile(JSON.stringify(current)); await handle.sync(); }
                    finally { await handle.close(); }
                    await fsp.rename(temporary, path.join(snapPath, MANIFEST_NAME));
                    renamed = true;
                } finally {
                    if (!renamed) await fsp.unlink(temporary).catch((e) => { if (e.code !== "ENOENT") throw e; });
                }
            }));
            if (done && this.ownsWindow(owner, view, request)) { this.backWindow(); if (onDone) onDone(); }
        });
    }

    // 恢复只导出独立副本；退出思源后再替换目录，避免内核持续写入。
    openRestore(snapPath) {
        const name = path.basename(snapPath);
        const dialog = this.createWindow({ key: "restore", title: this.t("restoreTitle", "恢复快照") + " · v" + PLUGIN_VERSION,
            content: `<div class="b3-dialog__content sibk-restore">
                <header class="sibk-page-header"><div class="sibk-restore-emblem">${this.icon("shield")}</div><h2>${this.t("safeRestoreTitle", "先导出，再恢复")}</h2></header>
                <p>${this.t("safeRestoreIntro", "导出前会校验快照，并复制为独立文件。你可以先查看笔记和附件，再决定是否替换工作空间。")}</p>
                <ol class="sibk-steps"><li>${this.t("restoreStep1", "选择导出位置，插件会新建文件夹保存这份快照。")}</li><li>${this.t("restoreStep2", "检查导出结果，然后完全退出思源笔记。")}</li><li>${this.t("restoreStep3", "保留当前工作空间的原目录作为退路，再用导出的对应目录替换，最后重新打开思源。")}</li></ol>
                <div class="sibk-warning">${this.t("offlineRestoreHint", "运行中的思源会持续写入数据，因此这里不执行在线覆盖。导出不删除当前笔记，也不会删除快照创建之后新增的笔记。")}</div>
                <p class="sibk-path">${this.escapeHtml(contractHome(snapPath))}</p>
                <p id="sibkRestoreStatus" class="sibk-hint" role="status" aria-live="polite"></p>
            </div><div class="b3-dialog__action sibk-footer"><span class="sibk-footer-spacer"></span><button class="sibk-primary" id="sibkExport">${this.t("chooseExport", "选择位置并导出…")}</button></div>` });
        const root = dialog.element;
        root.querySelector("#sibkExport").addEventListener("click", async () => {
            if (this.running) { siyuan.showMessage(this.t("waitOperation", "请等待当前操作完成。"), 4000, "info"); return; }
            const folder = await this.pickDirectory(os.homedir());
            if (!folder) return;
            const target = path.join(folder, name + "-export-" + stampOf());
            if (isPathInside(target, this.workspace()) || isPathInside(target, this.destRoot()) || isPathInside(this.destRoot(), target)) {
                siyuan.showMessage(this.t("exportOutside", "请选择工作空间和备份目录以外的位置。"), 5000, "error"); return;
            }
            const button = root.querySelector("#sibkExport");
            const status = root.querySelector("#sibkRestoreStatus");
            button.disabled = true;
            await this.performOperation("export", async () => {
                status.textContent = this.t("restoring", "正在校验并导出…");
                const result = await restoreSnapshot({ snapshotDir: snapPath, targetRoot: target, shouldStop: () => this.canceled, onProgress: (info) => {
                    status.textContent = this.t("restoring", "正在校验并导出…") + (info.total ? " " + info.current + " / " + info.total : "");
                } });
                if (!result.ok) { status.textContent = this.t("restoreFailed", "导出未完成，请勿用于恢复") + "：" + result.error; return; }
                status.textContent = this.t("restoreDone", "已导出独立副本") + " · " + result.copied + " " + this.t("files", "个文件") + " → " + contractHome(target) + (result.legacy ? " · " + this.t("legacyVerify", "旧版快照仅核对结构与大小，缺少创建时的内容指纹。") : "");
                this.openPath(target);
            });
            button.disabled = false;
        });
    }

    async doOverwriteRestore(snapPath) {
        // 保留旧入口兼容调用，所有恢复均转入离线恢复说明。
        this.openRestore(snapPath);
    }

    // ---------------- 调度 ----------------

    stopTimer() {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
    }

    startTimer() {
        this.stopTimer();
        const minutes = this.settings.intervalMinutes;
        if (!this.settings.autoStart || !minutes || minutes <= 0) return;
        const self = this;
        this.timer = setInterval(() => {
            if (self.running) return;
            const now = Date.now();
            // 失败节流：最近一次尝试（无论成败）之后必须满一个间隔
            const last = Math.max(self.settings.lastBackupAt || 0, self.settings.lastAttemptAt || 0);
            if (now - last < minutes * 60 * 1000) return;
            // 空闲检测：避免在编辑过程中突然全量扫描造成卡顿感
            const idleMin = self.settings.idleMinutes || 0;
            if (idleMin > 0 && now - self.lastActive < idleMin * 60 * 1000) return;
            self.scheduleBackup("auto");
        }, 30 * 1000);
    }

    async cleanupIncomplete(destRoot) {
        const n = await cleanupIncomplete(expandHome(destRoot));
        return n;
    }

    async scheduleBackup(reason) {
        if (this.running || this.savingSettings) {
            if (reason === "manual") siyuan.showMessage(this.t("alreadyRunning", "备份正在进行中"), 3000, "info");
            return;
        }
        const sources = this.activeSources();
        if (!sources.length) {
            siyuan.showMessage(this.t("noSource", "请先在设置里选择备份范围"), 4000, "error");
            return;
        }
        this.running = true;
        this.operation = "backup";
        this.canceled = false;
        this.status.progress = null;
        // 节流时间戳先行落盘，防止失败后每 30 秒重复触发
        this.settings.lastAttemptAt = Date.now();
        await this.saveSettings();
        this.updateTopBar(this.t("backupRunning", "备份中 0%"), "running");

        let lastProgressAt = 0;
        const onProgress = (info) => {
            const now = Date.now();
            const completed = Number.isFinite(info.total) && info.current === info.total;
            if (now - lastProgressAt < 100 && !completed && info.phase !== "verify") return;
            lastProgressAt = now;
            if (info.phase === "verify" && !info.total) {
                this.status.progress = null;
                this.updateTopBar(this.t("verifying", "正在读取文件并校验内容…"), "running");
            } else if (info.phase === "scan") {
                this.status.progress = null;
                this.updateTopBar(this.t("scanning", "扫描中…") + " " + info.scanned, "running");
            } else if ((info.phase === "copy" || info.phase === "verify") && info.total) {
                const pct = Math.floor((info.current / info.total) * 100);
                this.status.progress = pct;
                this.updateTopBar(this.t("backupRunning", "备份中") + " " + pct + "%", "running");
            }
        };

        let res = null;
        try {
            res = await runSnapshot({
                workspace: this.workspace(),
                destRoot: this.destRoot(),
                sources,
                excludes: buildExcludes(this.settings.extraExcludes),
                keepCount: this.settings.keepCount,
                prune: this.settings.autoPrune,
                onProgress,
                shouldStop: () => this.canceled,
                note: reason === "daily" ? this.t("dailyNote", "每日首启自动备份") : "",
            });
        } catch (e) {
            res = { ok: false, error: friendlyError(e), files: 0, copied: 0, linked: 0, failed: 0, deleted: 0, ms: 0 };
        }

        this.running = false;
        this.operation = null;
        this.status.progress = null;
        if (res.ok) {
            this.settings.lastError = "";
            if (reason === "daily") this.settings.lastDailyDay = dayString();
            this.settings.lastBackupAt = Date.now();
            this.settings.lastResult = {
                snapshot: res.snapshot, files: res.files, copied: res.copied,
                linked: res.linked, deleted: res.deleted, ms: res.ms, bytes: res.bytes,
                warnings: (res.warnings || []).concat(res.pruneError ? [res.pruneError] : []),
            };
            await this.saveSettings();
            this.updateTopBar("", "success");
            await Promise.all(Array.from(this.statusViews).map(root => {
                const box = root.querySelector("#sibkStatBox");
                return box ? this.renderStatBox(box, root.querySelector("#sibkRecentList")) : undefined;
            }));
            siyuan.showMessage(
                this.t("backupDone", "备份完成") + "：" + res.files + " " + this.t("files", "个文件") +
                "，" + this.t("changed", "新增/变更") + " " + res.copied +
                "，" + this.t("written", "实际写入") + " " + humanSize(res.bytes) +
                "，" + (res.ms / 1000).toFixed(1) + "s",
                6000, "info");
        } else {
            this.settings.lastError = res.error || this.t("backupFailed", "备份失败");
            await this.saveSettings();
            this.updateTopBar("", "error");
            siyuan.showMessage(this.t("backupFailed", "备份失败") + "：" + (res.error || "-"), 8000, "error");
        }
    }
}

// 暴露内部函数便于独立测试（思源加载时会一并带上）
IncrementalBackupPlugin.__internals = core;

module.exports = IncrementalBackupPlugin;
