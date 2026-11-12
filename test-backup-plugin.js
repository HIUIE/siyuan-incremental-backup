/**
 * 独立回归测试：mock 掉 siyuan 模块后直接载入插件 index.js，
 * 在临时目录里真实执行备份/恢复/清理，覆盖 v1.1.0 全部核心逻辑。
 */
"use strict";
const Module = require("module");
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");

// ---- mock siyuan ----
const origLoad = Module._load;
Module._load = function (request) {
    if (request === "siyuan") {
        return { Plugin: class {}, Dialog: class {}, Menu: class {}, showMessage: () => {}, confirm: () => {} };
    }
    return origLoad.apply(this, arguments);
};

const pluginPath = path.join(__dirname, "index.js");
const PluginClass = require(pluginPath);
const I = PluginClass.__internals;

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log("  PASS  " + name); }
    else { fail++; console.log("  FAIL  " + name + (extra ? "  -> " + extra : "")); }
}

async function main() {
    const tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "sibk-test-")));
    const ws = path.join(tmp, "workspace");
    const dest = path.join(tmp, "backup");
    console.log("测试目录：" + tmp);

    // ---------- 构造模拟工作空间 ----------
    async function w(rel, content) {
        const p = path.join(ws, rel);
        await fsp.mkdir(path.dirname(p), { recursive: true });
        await fsp.writeFile(p, content, "utf8");
        return p;
    }
    await w("data/20240101000000-abc1234/note1.sy", "v1-note1");
    await w("data/20240101000000-abc1234/note2.sy", "v1-note2");
    await w("data/assets/img-1.png", "PNG-BYTES-AAAA");
    await w("data/assets/sub/deep.txt", "deep");
    await w("data/plugins/demo/index.js", "console.log(1)");
    await w("data/plugins/demo/node_modules/x/lib.js", "should-be-excluded");
    await w("data/temp/junk.tmp", "junk");
    await w("data/.DS_Store", "mac");
    await w("conf/conf.json", '{"theme":"dark"}');
    await w("conf/appearance/themes/custom.css", "body{}");
    await w("history/2024/h1.txt", "history-content");

    const excludes = I.buildExcludes("");
    const args = () => ({ workspace: ws, destRoot: dest, sources: ["data", "conf"], excludes, keepCount: 30 });

    // ---------- [1] 首次全量 ----------
    console.log("\n[1] 首次全量备份");
    const r1 = await I.runSnapshot(args());
    console.log("   ", JSON.stringify({ files: r1.files, copied: r1.copied, linked: r1.linked, failed: r1.failed }));
    check("扫描到 7 个文件（排除 node_modules/temp/.DS_Store）", r1.files === 7, "实际 " + r1.files);
    check("全部为复制（无上一份快照）", r1.copied === 7 && r1.linked === 0);
    check("无失败项", r1.failed === 0);
    check("快照返回成功", r1.ok === true);
    const snap1 = r1.snapshot;
    check("note1 内容正确", (await fsp.readFile(path.join(snap1, "data/20240101000000-abc1234/note1.sy"), "utf8")) === "v1-note1");
    check("清单文件已生成", fs.existsSync(path.join(snap1, "_manifest.json")));
    check("半成品标记已移除", !fs.existsSync(path.join(snap1, "_incomplete")));

    // ---------- [2] 无变化 -> 全硬链接 ----------
    console.log("\n[2] 无变化的第二次备份（应全部硬链接）");
    const r2 = await I.runSnapshot(args());
    check("全部走硬链接", r2.linked === 7 && r2.copied === 0, "linked=" + r2.linked + " copied=" + r2.copied);
    check("两次快照目录名不同（未覆盖）", r1.snapshot !== r2.snapshot);
    const [s1, s2] = await Promise.all([
        fsp.stat(path.join(snap1, "conf/conf.json")),
        fsp.stat(path.join(r2.snapshot, "conf/conf.json")),
    ]);
    check("两份快照共享同一 inode（真硬链接）", s1.ino === s2.ino && s1.dev === s2.dev);

    // ---------- [3] 版本隔离 ----------
    console.log("\n[3] 修改 + 删除后再备份（版本隔离）");
    await fsp.writeFile(path.join(ws, "data/20240101000000-abc1234/note1.sy"), "v2-note1-CHANGED");
    await fsp.unlink(path.join(ws, "data/20240101000000-abc1234/note2.sy"));
    const r3 = await I.runSnapshot(args());
    const snap3 = r3.snapshot;
    check("只复制了 1 个变更文件", r3.copied === 1, "copied=" + r3.copied);
    check("其余 5 个硬链接", r3.linked === 5, "linked=" + r3.linked);
    check("新快照是新内容", (await fsp.readFile(path.join(snap3, "data/20240101000000-abc1234/note1.sy"), "utf8")) === "v2-note1-CHANGED");
    check("旧快照仍是旧内容（版本隔离）", (await fsp.readFile(path.join(r2.snapshot, "data/20240101000000-abc1234/note1.sy"), "utf8")) === "v1-note1");
    check("被删文件仍存在于旧快照", fs.existsSync(path.join(r2.snapshot, "data/20240101000000-abc1234/note2.sy")));
    check("被删文件不出现在新快照", !fs.existsSync(path.join(snap3, "data/20240101000000-abc1234/note2.sy")));

    // ---------- [4] 保留策略 ----------
    console.log("\n[4] 保留策略");
    const snaps = [];
    for (let i = 0; i < 20; i++) {
        const d = new Date(2026, 0, 1 + i, 10, 0, 0);
        snaps.push({ name: "snap-" + I.stampOf(d), path: "/x/s" + i, time: d.getTime() });
    }
    const newest5 = snaps.slice(-5).map((s) => s.name);
    check("20 份未超上限时全部保留", I.selectSnapshotsToDelete(snaps, 30).length === 0);
    const del5 = I.selectSnapshotsToDelete(snaps, 5);
    check("keepCount=5 时只保留 5 份（不突破上限）", 20 - del5.length === 5, "实际保留 " + (20 - del5.length));
    check("保留的是最新 5 份", newest5.every((n) => del5.indexOf(n) === -1));
    const sameDay = [];
    for (let i = 0; i < 12; i++) {
        const d = new Date(2026, 0, 1, 10, i, 0);
        sameDay.push({ name: "snap-" + I.stampOf(d), path: "/x/d" + i, time: d.getTime() });
    }
    const delSame = I.selectSnapshotsToDelete(sameDay, 30);
    check("同一天 12 份默认保留 10 份", delSame.length === 2, "删除 " + delSame.length);
    check("同日保留的是较新的 10 份", sameDay.slice(-10).every((s) => delSame.indexOf(s.name) === -1));

    // ---------- [5] 排除规则 ----------
    console.log("\n[5] 排除规则");
    check("目录前缀匹配", I.isExcluded("data/temp/x.txt", ["temp/"]));
    check("文件名匹配", I.isExcluded("data/.DS_Store", [".DS_Store"]));
    check("后缀通配", I.isExcluded("data/a.tmp", ["*.tmp"]));
    check("普通文件不误伤", !I.isExcluded("data/note.sy", [".DS_Store", "temp/", "*.tmp"]));
    check("自定义规则生效", I.isExcluded("data/cache/x.bin", I.buildExcludes("cache/")));

    // ---------- [6] 安全检查 ----------
    console.log("\n[6] 安全检查（v1.1 新增）");
    check("拒绝备份到工作空间自身", !(await I.runSnapshot({ workspace: ws, destRoot: ws, sources: ["data"], excludes })).ok);
    const rInside = await I.runSnapshot({ workspace: ws, destRoot: path.join(ws, "data/backup-inner"), sources: ["data"], excludes });
    check("拒绝备份到工作空间内部（防递归自备份）", !rInside.ok && /内部/.test(rInside.error || ""), rInside.error);
    check("isPathInside 判定", I.isPathInside("/a/b/c", "/a/b") && !I.isPathInside("/a/xx", "/a/b"));
    const fe = I.friendlyError({ code: "ENOSPC", message: "x" });
    check("错误码映射为友好提示", /磁盘空间不足/.test(fe), fe);

    // ---------- [7] 半成品快照治理 ----------
    console.log("\n[7] 半成品快照治理（v1.1 新增）");
    const orphan = path.join(dest, "snap-20250101-000000");
    await fsp.mkdir(path.join(orphan, "data"), { recursive: true });
    await fsp.writeFile(path.join(orphan, "data/orphan.sy"), "half-written");
    await fsp.writeFile(path.join(orphan, "_incomplete"), "{}");
    const listed = await I.listSnapshots(dest);
    check("listSnapshots 默认跳过未完成快照", listed.every((s) => s.path !== orphan), "数量 " + listed.length);
    const listedAll = await I.listSnapshots(dest, { includeIncomplete: true });
    check("includeIncomplete 可见未完成快照", listedAll.some((s) => s.path === orphan));
    const removed = await I.cleanupIncomplete(dest);
    check("cleanupIncomplete 保留半成品供排查", removed === 0 && fs.existsSync(orphan), "删除 " + removed);
    check("完整快照未被误删", fs.existsSync(snap3));

    // 取消 -> 半成品即时删除
    const rCancel = await I.runSnapshot({ ...args(), shouldStop: () => true });
    check("取消时 ok=false", rCancel.ok === false);
    check("取消后不留半成品目录", !rCancel.snapshot || !fs.existsSync(rCancel.snapshot), rCancel.snapshot);

    // 半成品不作为硬链接基准：造一个「时间最新」的无清单快照，
    // 若它被错误地当作基准，全部文件都无法命中 -> 全量复制；正确行为是跳过它、命中上一份完整快照
    const futureIncomplete = path.join(dest, "snap-20990101-000000");
    await fsp.mkdir(futureIncomplete, { recursive: true });
    await fsp.writeFile(path.join(futureIncomplete, "_incomplete"), "{}");
    const rAfterOrphan = await I.runSnapshot(args());
    check("未完成快照不会被用作硬链接基准", rAfterOrphan.linked === rAfterOrphan.files && rAfterOrphan.copied === 0,
        "copied=" + rAfterOrphan.copied + " linked=" + rAfterOrphan.linked + " files=" + rAfterOrphan.files);

    // ---------- [8] 快照时间从目录名解析 ----------
    console.log("\n[8] 快照时间解析（v1.1 新增）");
    const pt = I.parseSnapshotTime("snap-20260829-130419-2");
    check("目录名 -> 时间戳", pt === new Date(2026, 7, 29, 13, 4, 19).getTime(), String(pt));
    check("非法名返回 null", I.parseSnapshotTime("not-a-snap") === null);
    const snapsNow = await I.listSnapshots(dest);
    check("listSnapshots 使用目录名时间", snapsNow.length >= 1 && snapsNow.every((s) => I.parseSnapshotTime(s.name) !== null ? true : false));

    // ---------- [9] 恢复（导出） ----------
    console.log("\n[9] 恢复（导出）");
    const exportDir = path.join(tmp, "exported");
    const rr = await I.restoreSnapshot({ snapshotDir: snap3, targetRoot: exportDir });
    check("导出成功", rr.ok && rr.copied === r3.files, "copied=" + rr.copied + " files=" + r3.files);
    check("导出内容一致", (await fsp.readFile(path.join(exportDir, "data/20240101000000-abc1234/note1.sy"), "utf8")) === "v2-note1-CHANGED");
    check("manifest 不被导出", !fs.existsSync(path.join(exportDir, "_manifest.json")));
    const rrBad = await I.restoreSnapshot({ snapshotDir: "", targetRoot: exportDir });
    check("参数不完整时拒绝恢复", !rrBad.ok);

    // ---------- [10] 日志 ----------
    console.log("\n[10] 日志");
    const logTxt = await fsp.readFile(path.join(dest, "backup.log"), "utf8");
    check("日志已记录多次备份", logTxt.trim().split("\n").length >= 4, logTxt.trim().split("\n").length + " 条");

    await fsp.rm(tmp, { recursive: true, force: true });
    console.log("\n========== 结果：" + pass + " 通过 / " + fail + " 失败 ==========");
    process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("测试异常：", e); process.exit(1); });
