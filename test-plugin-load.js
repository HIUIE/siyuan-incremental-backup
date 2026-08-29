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

const calls = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sibk-load-"));
const tmpDest = path.join(tmp, "backup");

// ---- fake 基类：模拟思源 Plugin 提供的能力 ----
class FakePlugin {
    constructor(options) {
        this.opts = options || {};
        this._commands = [];
    }
    addIcons(svg) { calls.push("addIcons"); }
    addTopBar(cfg) {
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
// 可交互的假元素：querySelector 返回能挂监听、读 value 的对象
function fakeEl() {
    return {
        addEventListener() {}, destroy() {}, value: "", checked: false,
        querySelector() { return fakeEl(); },
        querySelectorAll() { return []; },
        setAttribute() {}, getAttribute() { return "data"; },
        textContent: "", innerHTML: "", style: {},
    };
}

global.document = {
    createElement() {
        return { textContent: "", style: {}, setAttribute() {}, appendChild() {}, remove() {}, querySelector() { return null; } };
    },
    head: { appendChild() {} },
};
global.window = {
    addEventListener() { calls.push("winListener"); },
    removeEventListener() {},
    siyuan: { config: { system: { dataDir: path.join(tmp, "data") } } },
};
global.setInterval = () => 0; // 不真正启动定时器
global.clearInterval = () => {};

// 捕获 Dialog 构造时的 content，供 UI 结构断言
const dialogContents = [];

// ---- mock siyuan 模块 ----
const origLoad = Module._load;
Module._load = function (request) {
    if (request === "siyuan") {
        return {
            Plugin: FakePlugin,
            Dialog: class {
                constructor(cfg) { this.cfg = cfg; dialogContents.push(JSON.stringify(cfg)); this.element = fakeEl(); }
                destroy() {}
            },
            Menu: class { addItem() {} addSeparator() {} open() {} },
            showMessage() {}, confirm() {},
        };
    }
    return origLoad.apply(this, arguments);
};

const Cls = require("/Users/carlosfu/SiYuan/data/plugins/siyuan-incremental-backup/index.js");

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
    check("已注册顶栏按钮", calls.indexOf("addTopBar:iconSibk") !== -1);
    check("已注册图标符号", calls.indexOf("addIcons") !== -1);
    check("已注册命令", calls.indexOf("addCommand") !== -1);
    check("已加载配置", calls.indexOf("loadData") !== -1);
    check("默认备份目录指向临时目录（未误写真实目录）", plugin.destRoot() === tmpDest, plugin.destRoot());

    plugin.onLayoutReady(); // dailyFirst=false，不应触发备份
    check("onLayoutReady 无异常", true);

    plugin.updateTopBar("测试 50%", "running");
    check("updateTopBar 状态更新", plugin.status.text === "测试 50%");

    let unloadErr = null;
    try { plugin.onunload(); } catch (e) { unloadErr = e; }
    check("onunload 无异常", unloadErr === null, unloadErr && (unloadErr.stack || unloadErr.message));

    // ---- 设置面板 UI 结构（v1.1.1 布局修复）----
    console.log("\n[UI] 设置面板布局");
    dialogContents.length = 0;
    let openErr = null;
    try { plugin.openSettings(); } catch (e) { openErr = e; }
    check("openSettings 无异常", openErr === null, openErr && (openErr.stack || openErr.message));
    const sCfg = dialogContents[0] || "";
    check("使用双列 grid 布局", sCfg.indexOf("sibk-grid") !== -1 && sCfg.indexOf("sibk-col") !== -1);
    check("面板宽度提升至 820px", sCfg.indexOf('"width":"820px"') !== -1, "cfg 前 120 字符: " + sCfg.slice(0, 120));
    check("备份范围与基础设置同屏分列", sCfg.indexOf("备份保存位置") !== -1 && sCfg.indexOf("备份范围") !== -1);
    check("包含系统目录选择按钮", sCfg.indexOf("sibkPick") !== -1);
    check("频率下拉（每天/每周/自定义）", sCfg.indexOf("sibkIntervalSel") !== -1 && sCfg.indexOf("每天一次") !== -1 && sCfg.indexOf("自定义") !== -1);

    // ---- 快照管理面板含「实际写入」列 ----
    dialogContents.length = 0;
    let snapErr = null;
    try { await plugin.openSnapshots(); } catch (e) { snapErr = e; }
    check("openSnapshots 无异常", snapErr === null, snapErr && (snapErr.stack || snapErr.message));
    const mHtml = dialogContents[dialogContents.length - 1] || "";
    check("快照面板包含「实际写入」列", mHtml.indexOf("实际写入") !== -1, "面板片段: " + mHtml.slice(0, 200));

    // 核心函数仍可直接使用（__internals）
    check("__internals 暴露 runSnapshot", typeof Cls.__internals.runSnapshot === "function");
    check("__internals 暴露 restoreSnapshot", typeof Cls.__internals.restoreSnapshot === "function");

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log("\n========== 结果：" + pass + " 通过 / " + fail + " 失败 ==========");
    process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("测试异常：", e && e.stack || e); process.exit(1); });
