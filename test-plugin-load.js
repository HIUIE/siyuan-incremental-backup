/**
 * 插件加载冒烟测试：mock siyuan.Plugin 基类 + 最小 DOM/window，
 * 实例化插件并执行 onload/onunload，验证 UI 装配链路（继承、顶栏、命令、样式、配置）。
 * 目的：抓住"未继承基类 / 方法名冲突 / onload 抛错"这类核心逻辑测试覆盖不到的问题。
 */
"use strict";
const Module = require("module");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { version: expectedVersion } = require("./plugin.json");

const calls = [];
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sibk-load-")));
const tmpDest = path.join(tmp, "backup");
const tmpWs = path.join(tmp, "workspace");

// ---- fake 基类：模拟思源 Plugin 提供的能力 ----
class FakePlugin {
    constructor(options) {
        this.opts = options || {};
        this._commands = [];
    }
    addIcons(svg) { this.registeredSvg = svg; calls.push("addIcons"); }
    addTopBar(cfg) {
        this.topBarConfig = cfg;
        calls.push("addTopBar:" + (cfg && cfg.icon));
        const el = {
            setAttribute() {}, style: {}, appendChild() {},
            querySelector() { return null; },
        };
        return el;
    }
    addCommand(cmd) { this._commands.push(cmd); calls.push("addCommand"); }
    loadData(p) { calls.push("loadData"); return { destRoot: tmpDest, intervalMinutes: 0, dailyFirst: false, autoStart: false }; }
    saveData(p, d) { calls.push("saveData"); }
}

// ---- mock DOM / window ----
// Only the DOM surface used by the plugin: retain element identity, attributes,
// listeners and focus. Navigation behavior always comes from index.js itself.
function fakeEl(initialAttributes = {}) {
    const attributes = new Map(Object.entries(initialAttributes));
    const listeners = new Map(), children = new Map();
    let markup = "";
    return {
        destroy() {}, value: "", checked: false, hidden: false, tabIndex: -1,
        textContent: "", style: {},
        get innerHTML() { return markup; },
        set innerHTML(value) {
            markup = String(value); children.clear();
            if (markup.includes("sibk-workbench")) this.navigation = navigationFixture(this);
        },
        childNodes: [], parentNode: null,
        classList: { add() {}, remove() {} },
        appendChild(child) { child.remove(); child.parentNode = this; this.childNodes.push(child); return child; },
        replaceChildren(...nodes) { for (const child of this.childNodes.slice()) child.remove(); for (const node of nodes) this.appendChild(node); },
        remove() { if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter(child => child !== this); this.parentNode = null; },
        contains(node) { return node === this || this.childNodes.some(child => child.contains(node)); },
        get isConnected() { return this === document.body || this === document.head || !!(this.parentNode && this.parentNode.isConnected); },
        addEventListener(type, listener) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(listener);
        },
        dispatch(type, fields = {}) {
            const event = { target: this, currentTarget: this, ...fields, defaultPrevented: false,
                preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
            for (const listener of listeners.get(type) || []) listener(event);
            return event;
        },
        focus() { document.activeElement = this; },
        querySelector(selector) {
            if (!children.has(selector)) { const child = fakeEl(); children.set(selector, child); this.appendChild(child); }
            return children.get(selector);
        },
        querySelectorAll() { return []; },
        setAttribute(name, value) { attributes.set(name, String(value)); },
        removeAttribute(name) { attributes.delete(name); },
        getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
    };
}
function navigationFixture(root = fakeEl()) {
    const names = ["overview", "plan", "scope"];
    const tabs = names.map(name => fakeEl({ "data-section": name, role: "tab" }));
    const pages = names.map(name => fakeEl({ "data-page": name, role: "tabpanel" }));
    const settingsActions = [fakeEl(), fakeEl()], backup = fakeEl();
    const query = root.querySelector.bind(root);
    root.querySelectorAll = selector => ({
        "[data-section]": tabs, "[data-page]": pages, "[data-settings-action]": settingsActions,
    })[selector] || [];
    root.querySelector = selector => selector === "#sibkBackupNow" ? backup : query(selector);
    return { root, tabs, pages, settingsActions, backup };
}

global.document = { createElement: () => fakeEl(), head: fakeEl(), body: fakeEl(), activeElement: null };
global.window = {
    addEventListener() { calls.push("winListener"); },
    removeEventListener() {},
    siyuan: { config: { system: { dataDir: path.join(tmpWs, "data") } } },
};
global.setInterval = () => 0; // 不真正启动定时器
global.clearInterval = () => {};

// 捕获 Dialog 构造时的 content，供 UI 结构断言
const dialogContents = [], dialogs = [];

// ---- mock siyuan 模块 ----
const origLoad = Module._load;
Module._load = function (request) {
    if (request === "siyuan") {
        return {
            Plugin: FakePlugin,
            Dialog: class {
                constructor(cfg) {
                    this.cfg = cfg;
                    dialogContents.push(JSON.stringify(cfg));
                    this.element = fakeEl();
                    document.body.appendChild(this.element);
                    dialogs.push(this);
                }
                destroy() {
                    if (this.destroyed) return;
                    this.destroyed = true;
                    this.element.remove();
                    if (this.cfg.destroyCallback) this.cfg.destroyCallback();
                }
            },
            Menu: class { addItem() {} addSeparator() {} open() {} },
            showMessage() {}, confirm() {},
        };
    }
    return origLoad.apply(this, arguments);
};

const Cls = require(path.join(__dirname, "index.js"));

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log("  PASS  " + name); }
    else { fail++; console.log("  FAIL  " + name + (extra ? "  -> " + extra : "")); }
}

async function main() {
    check("插件类继承 siyuan.Plugin 基类", Cls.prototype instanceof FakePlugin,
        "prototype: " + Object.getPrototypeOf(Cls).name);

    const plugin = new Cls({ app: {}, i18n: { backupNow: "立即备份" } });
    check("构造后 i18n 可用", plugin.t("backupNow") === "立即备份");
    check("构造后 settings 有默认值", plugin.settings.keepCount === 30);

    let err = null;
    try { await plugin.onload(); } catch (e) { err = e; }
    check("onload 无异常", err === null, err && (err.stack || err.message));
    check("已注册顶栏按钮", calls.indexOf("addTopBar:iconSibkBackup") !== -1);
    check("已注册备份专用图标符号", calls.includes("addIcons") && plugin.registeredSvg.includes('id="iconSibkBackup"'));
    check("已注册命令", calls.indexOf("addCommand") !== -1);
    check("已加载配置", calls.indexOf("loadData") !== -1);
    check("默认备份目录指向临时目录（未误写真实目录）", plugin.destRoot() === tmpDest, plugin.destRoot());
    const originalOpenSettings = plugin.openSettings;
    let workbenchOpens = 0;
    plugin.openSettings = () => { workbenchOpens++; };
    plugin.openSetting();
    check("思源插件设置入口打开工作台", workbenchOpens === 1);
    plugin.topBarConfig.callback();
    check("顶栏点击直接打开工作台", workbenchOpens === 2);
    const openCommand = plugin._commands.find(command => command.langKey === "SIBK_OPEN_WORKBENCH");
    if (openCommand) openCommand.callback();
    check("命令面板提供工作台入口", workbenchOpens === 3);
    plugin.openSettings = originalOpenSettings;

    plugin.onLayoutReady(); // dailyFirst=false，不应触发备份
    check("onLayoutReady 无异常", true);

    plugin.updateTopBar("测试 50%", "running");
    check("updateTopBar 状态更新", plugin.status.text === "测试 50%");

    let unloadErr = null;
    try { plugin.onunload(); } catch (e) { unloadErr = e; }
    check("onunload 无异常", unloadErr === null, unloadErr && (unloadErr.stack || unloadErr.message));

    // ---- Workbench structure and actual navigation event handlers ----
    console.log("\n[UI] " + expectedVersion + " 工作台与侧栏导航");
    dialogContents.length = 0;
    let openErr = null;
    try { plugin.openSettings(); } catch (e) { openErr = e; }
    check("openSettings 无异常", openErr === null, openErr && (openErr.stack || openErr.message));
    const view = plugin.windowState.current;
    const sCfg = view.root.innerHTML;
    const workbench = plugin.windowState.native;
    check("工作台采用侧栏导航与主内容区", ["sibk-workbench", "sibk-sidebar", "sibk-navigation", "sibk-main"].every(name => sCfg.includes(name)));
    check("工作台宽度为 1060px", workbench.cfg.width === "1060px");
    check("工作台标题版本与插件metadata一致", view.title === "备份工作台 · v" + expectedVersion);
    check("导航声明垂直标签组及三个关联面板", sCfg.includes('role="tablist" aria-orientation="vertical"') && ["overview", "plan", "scope"].every(name => sCfg.includes(`aria-controls="sibkPage-${name}"`) && sCfg.includes(`aria-labelledby="sibkTab-${name}"`)));
    check("提供状态、取消和保存并备份", ["data-status-title", "data-cancel-backup", "sibkRunNow"].every((key) => sCfg.includes(key)));
    check("升级默认关闭自动清理", plugin.settings.autoPrune === false);
    check("计划与范围提供独立标签页", ['data-page="plan"', 'data-page="scope"', "sibkAutoStart", "data-source"].every(key => sCfg.includes(key)));
    check("包含系统目录选择按钮", sCfg.indexOf("sibkPick") !== -1);
    check("频率下拉（每天/每周/自定义）", sCfg.indexOf("sibkIntervalSel") !== -1 && sCfg.indexOf("每天一次") !== -1 && sCfg.indexOf("自定义") !== -1);

    const nav = view.root.navigation;
    const active = index => nav.tabs.every((tab, i) => tab.getAttribute("aria-selected") === String(i === index) && tab.tabIndex === (i === index ? 0 : -1));
    const visible = index => nav.pages.every((page, i) => page.hidden === (i !== index));
    check("默认概览为唯一选中且可Tab聚焦的标签", active(0));
    check("默认仅概览面板可见", visible(0));
    check("概览显示立即备份并隐藏设置保存动作", !nav.backup.hidden && nav.settingsActions.every(button => button.hidden));
    const draftPath = nav.root.querySelector("#sibkDest"), draftRules = nav.root.querySelector("#sibkExcludes"), draftToggle = nav.root.querySelector("#sibkAutoPrune");
    const settingsBeforeNavigation = JSON.stringify(plugin.settings);
    const savesBeforeNavigation = calls.filter(call => call === "saveData").length;
    nav.tabs[1].dispatch("click");
    check("点击计划更新aria-selected与Tab焦点入口", active(1));
    check("点击计划仅显示对应面板", visible(1));
    check("计划页显示保存动作并隐藏立即备份", nav.backup.hidden && nav.settingsActions.every(button => !button.hidden));
    draftPath.value = path.join(tmp, "unsaved-destination");
    draftRules.value = "custom-cache/\n*.draft";
    draftToggle.checked = true;
    nav.tabs[1].focus();
    const down = nav.tabs[1].dispatch("keydown", { key: "ArrowDown" });
    check("ArrowDown切换范围、更新面板并移动焦点", down.defaultPrevented && active(2) && visible(2) && document.activeElement === nav.tabs[2]);
    const right = nav.tabs[2].dispatch("keydown", { key: "ArrowRight" });
    check("ArrowRight从末标签循环到概览", right.defaultPrevented && active(0) && visible(0) && document.activeElement === nav.tabs[0]);
    const up = nav.tabs[0].dispatch("keydown", { key: "ArrowUp" });
    check("ArrowUp从首标签循环到范围", up.defaultPrevented && active(2) && visible(2) && document.activeElement === nav.tabs[2]);
    const left = nav.tabs[2].dispatch("keydown", { key: "ArrowLeft" });
    check("ArrowLeft切换前一标签并移动焦点", left.defaultPrevented && active(1) && visible(1) && document.activeElement === nav.tabs[1]);
    const home = nav.tabs[1].dispatch("keydown", { key: "Home" });
    check("Home返回首标签及概览动作", home.defaultPrevented && active(0) && visible(0) && document.activeElement === nav.tabs[0] && !nav.backup.hidden && nav.settingsActions.every(button => button.hidden));
    const end = nav.tabs[0].dispatch("keydown", { key: "End" });
    check("End选中末标签并显示设置动作", end.defaultPrevented && active(2) && visible(2) && document.activeElement === nav.tabs[2] && nav.backup.hidden && nav.settingsActions.every(button => !button.hidden));
    const unrelated = nav.tabs[2].dispatch("keydown", { key: "Escape" });
    check("无关键不拦截、不切换标签或焦点", !unrelated.defaultPrevented && active(2) && visible(2) && document.activeElement === nav.tabs[2]);
    nav.tabs[0].dispatch("click");
    nav.tabs[1].dispatch("click");
    check("来回导航保留输入元素及未保存的路径草稿", nav.root.querySelector("#sibkDest") === draftPath && draftPath.value === path.join(tmp, "unsaved-destination"));
    check("来回导航保留未保存的排除规则与开关", nav.root.querySelector("#sibkExcludes") === draftRules && draftRules.value === "custom-cache/\n*.draft" && draftToggle.checked);
    check("导航不修改或保存插件配置", JSON.stringify(plugin.settings) === settingsBeforeNavigation && calls.filter(call => call === "saveData").length === savesBeforeNavigation);
    plugin.openSettings("scope");
    const scoped = plugin.windowState.current.root.navigation;
    check("显式打开范围页时选中范围并隐藏其余面板", scoped.tabs.every((tab, i) => tab.getAttribute("aria-selected") === String(i === 2) && tab.tabIndex === (i === 2 ? 0 : -1)) && scoped.pages.every((page, i) => page.hidden === (i !== 2)));

    // ---- 快照管理面板含「实际写入」列 ----
    dialogContents.length = 0;
    let snapErr = null;
    try { await plugin.openSnapshots(); } catch (e) { snapErr = e; }
    check("openSnapshots 无异常", snapErr === null, snapErr && (snapErr.stack || snapErr.message));
    const mHtml = plugin.windowState.current.root.innerHTML;
    check("快照面板包含「实际写入」列", mHtml.indexOf("实际写入") !== -1, "面板片段: " + mHtml.slice(0, 200));

    // 核心函数仍可直接使用（__internals）
    check("__internals 暴露 runSnapshot", typeof Cls.__internals.runSnapshot === "function");
    check("__internals 暴露 restoreSnapshot", typeof Cls.__internals.restoreSnapshot === "function");

    console.log("\n[状态] 调度、保存与安全恢复");
    fs.mkdirSync(path.join(tmpWs, "data"), { recursive: true });
    fs.mkdirSync(path.join(tmpWs, "conf"), { recursive: true });
    fs.writeFileSync(path.join(tmpWs, "data", "test.sy"), "isolated test note");
    fs.writeFileSync(path.join(tmpWs, "conf", "conf.json"), "{}");
    plugin.settings.autoStart = false;
    plugin.settings.intervalMinutes = 60;
    plugin.startTimer();
    check("关闭自动启动后保存设置不会开启定时器", plugin.timer === null);
    plugin.settings.lastDailyDay = "";
    await plugin.scheduleBackup("daily");
    check("真实临时备份完成后才记录每日成功日期", !!plugin.settings.lastDailyDay && plugin.settings.lastBackupAt > 0 && !plugin.settings.lastError);
    check("完成后不残留运行中提示", plugin.running === false && plugin.status.text === "");
    const successfulAt = plugin.settings.lastBackupAt;
    plugin.settings.destRoot = path.join(tmpWs, "data", "unsafe");
    plugin.settings.lastDailyDay = "";
    await plugin.scheduleBackup("daily");
    check("备份失败不推进成功时间与每日日期", plugin.settings.lastBackupAt === successfulAt && plugin.settings.lastDailyDay === "");
    check("备份失败留下可见错误状态", !!plugin.settings.lastError && plugin.status.kind === "error");
    plugin.settings.destRoot = tmpDest;
    const savedOrder = [];
    plugin.saveData = async (_name, data) => { savedOrder.push(data.lastError); };
    plugin.settings.lastError = "earlier";
    const saveA = plugin.saveSettings();
    plugin.settings.lastError = "later";
    const saveB = plugin.saveSettings();
    await Promise.all([saveA, saveB]);
    check("并发配置保存按顺序写入各自快照", savedOrder.join(",") === "earlier,later");
    plugin.saveData = async () => { throw new Error("injected save failure"); };
    check("保存失败明确返回false", await plugin.saveSettings() === false);
    plugin.settings.lastError = "";
    const fields = {
        "#sibkDest": { value: tmpDest }, "#sibkIntervalSel": { value: "custom" },
        "#sibkInterval": { value: "abc" }, "#sibkIdle": { value: "2" },
        "#sibkKeep": { value: "30" }, "#sibkExcludes": { value: "" },
        "#sibkAutoStart": { checked: false }, "#sibkDailyFirst": { checked: true },
        "#sibkAutoPrune": { checked: false },
    };
    const form = { querySelector: key => fields[key], querySelectorAll: () => [] };
    let invalidRejected = false;
    try { plugin.collectSettings(form); } catch (_) { invalidRejected = true; }
    check("非法数字被拒绝且不把自动备份静默关闭", invalidRejected && plugin.settings.intervalMinutes === 60);
    fields["#sibkInterval"].value = "90";
    const next = plugin.collectSettings(form);
    check("收集设置返回独立副本", next.intervalMinutes === 90 && plugin.settings.intervalMinutes === 60 && next.sources !== plugin.settings.sources);
    dialogContents.length = 0;
    plugin.openRestore(path.join(tmpDest, "snap-20260101-000000"));
    const restoreMarkup = plugin.windowState.current.root.innerHTML;
    check("恢复界面不再提供运行中覆盖", restoreMarkup.includes("sibkExport") && !restoreMarkup.includes("sibkOverwrite"));
    const system = window.siyuan.config.system;
    window.siyuan.config.system = {};
    check("无法识别工作空间时不猜测真实笔记路径", plugin.workspace() === "");
    window.siyuan.config.system = system;

    if (!path.basename(tmp).startsWith("sibk-load-")) throw new Error("Unsafe test cleanup path");
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log("\n========== 结果：" + pass + " 通过 / " + fail + " 失败 ==========");
    process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("测试异常：", e && e.stack || e); process.exit(1); });
