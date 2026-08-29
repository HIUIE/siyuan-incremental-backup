/**
 * SiYuan Incremental Backup / 思源增量备份
 *
 * 基于硬链接的时间点快照（Time Machine 风格）：
 *  - 每次备份生成一个完整目录树快照 snap-YYYYMMDD-HHMMSS/
 *  - 与上一份快照相比未变化的文件用硬链接共享，几乎不占额外磁盘
 *  - 源端文件被删除或修改时，旧快照不受影响，可回溯任意时间点
 *
 * 稳定性设计：
 *  - 快照以 _manifest.json 写入完成为「完整」标志；中断/取消的半成品会被自动清理，绝不作为硬链接基准
 *  - 备份前做磁盘空间预检（fs.statfs）
 *  - 拒绝把备份目录放在工作空间内部（防止递归自备份）
 *  - 自动备份失败后按 lastAttemptAt 节流，避免重试风暴
 *
 * 依赖 Electron 的 nodeIntegration（思源桌面端默认开启），直接使用 Node 的 fs。
 */
"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");

const PLUGIN_NAME = "siyuan-incremental-backup";
const SNAP_PREFIX = "snap-";
const LOG_NAME = "backup.log";
const MANIFEST_NAME = "_manifest.json";
const INCOMPLETE_NAME = "_incomplete";
const LOG_MAX_BYTES = 1024 * 1024;          // 日志超过 1MB 轮转
const LOG_KEEP_BYTES = 256 * 1024;

/** 默认排除规则（相对工作空间根的路径 / 文件名 / 目录前缀） */
const DEFAULT_EXCLUDES = [
    "temp/",
    "corrupted/",
    ".DS_Store",
    ".lock",
    "*.tmp",
    "*.log",
    "node_modules/",
];

/** 可备份的候选源（相对工作空间根）。label 走 i18n。 */
const SOURCE_DEFS = [
    { key: "data", dir: "data", i18n: "srcData" },
    { key: "conf", dir: "conf", i18n: "srcConf" },
    { key: "history", dir: "history", i18n: "srcHistory" },
    { key: "repo", dir: "repo", i18n: "srcRepo" },
];

const DEFAULT_SETTINGS = {
    destRoot: "",                 // 备份根目录，空则使用 ~/SiYuanBackup
    sources: { data: true, conf: true, history: false, repo: false },
    intervalMinutes: 60,          // 自动备份间隔（分钟），0 = 关闭
    idleMinutes: 2,               // 空闲阈值（分钟）：距上次键鼠操作超过该时长才执行自动备份，0 = 不要求空闲
    autoStart: true,              // 启动后自动开启定时备份
    dailyFirst: true,             // 每天首次启动思源时强制备份一次
    keepCount: 30,                // 最多保留快照份数
    extraExcludes: "",            // 额外排除规则，每行一条
    lastBackupAt: 0,
    lastAttemptAt: 0,             // 上次尝试备份的时间（含失败），用于失败节流
    lastDailyDay: "",             // 上次「每日首启备份」的日期
    lastResult: null,
};

// ---------------------------------------------------------------- 基础工具

function pad2(n) { return n < 10 ? "0" + n : "" + n; }

/** 20260829-122700 */
function stampOf(d) {
    d = d || new Date();
    return "" + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
        "-" + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
}

/** 2026-08-29 12:27:00 */
function readable(d) {
    d = d || new Date();
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) +
        " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
}

function dayString(d) {
    d = d || new Date();
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

function humanSize(bytes) {
    if (!bytes || bytes < 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0, v = bytes;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return (i === 0 ? v : v.toFixed(v < 10 ? 2 : 1)) + " " + units[i];
}

function expandHome(p) {
    if (!p) return p;
    if (p === "~") return os.homedir();
    if (p.startsWith("~" + path.sep)) return path.join(os.homedir(), p.slice(2));
    return p;
}

function contractHome(p) {
    if (!p) return p;
    const home = os.homedir();
    return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

/** 让出事件循环，避免大目录遍历 / 复制时卡住思源界面 */
function breathe() { return new Promise((r) => setImmediate(r)); }

/** child 是否位于 parent 内部（或与之相同） */
function isPathInside(child, parent) {
    if (!child || !parent) return false;
    const rel = path.relative(path.resolve(parent), path.resolve(child));
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** 把底层错误翻译成用户能读懂的提示 */
function friendlyError(e) {
    const code = e && e.code;
    const msg = (e && e.message) || String(e || "未知错误");
    const map = {
        ENOSPC: "磁盘空间不足",
        EACCES: "没有写入权限（检查备份目录权限）",
        EPERM: "操作被系统拒绝（可能被安全软件拦截）",
        ENOENT: "文件或目录不存在",
        EBUSY: "文件被占用",
        EMFILE: "打开的文件过多",
        EXDEV: "跨文件系统操作受限",
    };
    return (code && map[code] ? map[code] : "") + (code ? "（" + code + "） " : "") + msg;
}

// ---------------------------------------------------------------- 排除规则

/**
 * 判断相对路径是否命中排除规则。
 * 规则形态：目录前缀 "temp/"、文件名 ".DS_Store"、后缀通配 "*.tmp"、路径片段 ".git/"
 */
function isExcluded(rel, excludes) {
    if (!rel) return true;
    const norm = rel.split(path.sep).join("/");
    const base = path.basename(norm);
    for (const raw of excludes) {
        const rule = String(raw || "").trim().split(path.sep).join("/").replace(/^\/+/, "");
        if (!rule) continue;
        if (rule.endsWith("/")) {
            const dirName = rule.slice(0, -1);
            if (!dirName) continue;
            const parts = norm.split("/");
            if (parts.indexOf(dirName) !== -1) return true;
        } else if (rule.startsWith("*")) {
            const suffix = rule.slice(1);
            if (suffix && base.endsWith(suffix)) return true;
        } else if (rule.includes("/")) {
            if (norm === rule || norm.startsWith(rule + "/")) return true;
        } else {
            if (base === rule) return true;
        }
    }
    return false;
}

function buildExcludes(extraText) {
    const list = DEFAULT_EXCLUDES.slice();
    const extra = String(extraText || "").split(/\r?\n/);
    for (const line of extra) {
        const v = line.trim();
        if (v && list.indexOf(v) === -1) list.push(v);
    }
    return list;
}

// ---------------------------------------------------------------- 目录扫描

/**
 * 扫描源根目录，产出扁平文件清单。
 * @returns {Promise<Array<{rel:string, abs:string, size:number, mtimeMs:number}>>}
 */
async function scanTree(rootAbs, relRoot, excludes, onProgress) {
    const files = [];
    let dirs = 0;

    async function walk(dirAbs, dirRel) {
        let entries;
        try {
            entries = await fsp.readdir(dirAbs, { withFileTypes: true });
        } catch (e) {
            return; // 权限 / 已删除，跳过
        }
        dirs++;
        if (dirs % 40 === 0) {
            if (onProgress) onProgress({ phase: "scan", scanned: files.length, dirs });
            await breathe();
        }
        for (const ent of entries) {
            const childAbs = path.join(dirAbs, ent.name);
            const childRel = dirRel ? dirRel + "/" + ent.name : ent.name;
            if (isExcluded(childRel, excludes)) continue;
            if (ent.isDirectory()) {
                await walk(childAbs, childRel);
            } else if (ent.isFile()) {
                try {
                    const st = await fsp.stat(childAbs);
                    files.push({ rel: childRel, abs: childAbs, size: st.size, mtimeMs: st.mtimeMs });
                } catch (e) { /* 文件已消失，忽略 */ }
            }
        }
    }

    await walk(rootAbs, relRoot);
    return files;
}

// ---------------------------------------------------------------- 快照核心

/** 从快照目录名解析时间（snap-20260829-130419[-2]），解析失败返回 null */
function parseSnapshotTime(name) {
    const m = /^snap-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-(\d+))?$/.exec(name);
    if (!m) return null;
    const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    const t = d.getTime();
    return isNaN(t) ? null : t;
}

async function readManifest(snapDir) {
    try {
        const text = await fsp.readFile(path.join(snapDir, MANIFEST_NAME), "utf8");
        return JSON.parse(text);
    } catch (e) {
        return null;
    }
}

/**
 * 列出备份根下的快照（按时间升序）。
 * 默认跳过未完成的快照（无 _manifest.json / 带 _incomplete 标记）。
 */
async function listSnapshots(destRoot, opts) {
    const includeIncomplete = opts && opts.includeIncomplete;
    let names = [];
    try {
        names = await fsp.readdir(destRoot);
    } catch (e) {
        return [];
    }
    const snaps = [];
    for (const name of names) {
        if (!name.startsWith(SNAP_PREFIX)) continue;
        const full = path.join(destRoot, name);
        try {
            const st = await fsp.stat(full);
            if (!st.isDirectory()) continue;
            const manifest = await readManifest(full);
            const complete = !!manifest;
            if (!complete && !includeIncomplete) continue;
            snaps.push({
                name, path: full,
                time: parseSnapshotTime(name) !== null ? parseSnapshotTime(name) : st.mtimeMs,
                complete,
                files: manifest ? manifest.fileCount : 0,
                copied: manifest ? manifest.copied : 0,
                bytes: manifest ? (manifest.copiedBytes || 0) : 0,
                linked: manifest ? manifest.linked : 0,
                note: manifest && manifest.note ? manifest.note : "",
            });
        } catch (e) { /* ignore */ }
    }
    snaps.sort((a, b) => a.time - b.time);
    return snaps;
}

/** 清理半成品快照（中断/断电残留），在插件启动时调用 */
async function cleanupIncomplete(destRoot) {
    let removed = 0;
    let names = [];
    try { names = await fsp.readdir(destRoot); } catch (e) { return 0; }
    for (const name of names) {
        if (!name.startsWith(SNAP_PREFIX)) continue;
        const full = path.join(destRoot, name);
        try {
            const st = await fsp.stat(full);
            if (!st.isDirectory()) continue;
            const manifest = await readManifest(full);
            if (manifest) continue;
            await fsp.rm(full, { recursive: true, force: true });
            removed++;
        } catch (e) { /* ignore */ }
    }
    return removed;
}

/**
 * 计算需要删除的快照：
 *  - 最近 10 份无条件保留
 *  - 更早的按「自然日」去重，每天只保留最新一份（日期已被代表则跳过）
 *  - 总数不超过 keepCount
 */
function selectSnapshotsToDelete(snaps, keepCount) {
    const ordered = snaps.slice().sort((a, b) => b.time - a.time); // 新 -> 旧
    const limit = Math.max(1, keepCount || 30);

    const dayKey = (t) => dayString(new Date(t));

    const candidates = ordered.slice(0, 10).map((s) => s.name);
    const seenDay = new Set(ordered.slice(0, 10).map((s) => dayKey(s.time)));
    for (const s of ordered.slice(10)) {
        const day = dayKey(s.time);
        if (seenDay.has(day)) continue;
        seenDay.add(day);
        candidates.push(s.name);
    }
    const keep = new Set(candidates.slice(0, limit));

    return ordered.filter((s) => !keep.has(s.name)).map((s) => s.name);
}

async function removeSnapshot(dir) {
    await fsp.rm(dir, { recursive: true, force: true });
}

/** 目标目录所在磁盘的剩余字节数；statfs 不可用时返回 -1（跳过预检） */
async function freeBytesOf(dir) {
    try {
        if (typeof fsp.statfs !== "function") return -1;
        const st = await fsp.statfs(dir);
        return (st.bavail || 0) * (st.bsize || 0);
    } catch (e) {
        return -1;
    }
}

/** 追加一行日志（>1MB 时轮转，仅保留尾部 256KB） */
async function appendLog(destRoot, line) {
    try {
        const logPath = path.join(destRoot, LOG_NAME);
        let st = null;
        try { st = await fsp.stat(logPath); } catch (e) { st = null; }
        if (st && st.size > LOG_MAX_BYTES) {
            const buf = await fsp.readFile(logPath, "utf8");
            await fsp.writeFile(logPath, buf.slice(buf.length - LOG_KEEP_BYTES), "utf8");
        }
        await fsp.appendFile(logPath, "[" + readable() + "] " + line + "\n", "utf8");
    } catch (e) { /* 日志失败不影响备份 */ }
}

/**
 * 从快照目录复制内容到目标根目录（用于导出与还原）。
 * @param {object} opts snapshotDir / targetRoot / onProgress / shouldStop
 */
async function restoreSnapshot(opts) {
    const t0 = Date.now();
    const snapshotDir = opts.snapshotDir;
    const targetRoot = expandHome(opts.targetRoot);
    const onProgress = opts.onProgress || function () {};
    const shouldStop = opts.shouldStop || function () { return false; };

    const result = { ok: false, copied: 0, bytes: 0, failed: 0, files: 0, ms: 0, error: "" };
    if (!snapshotDir || !targetRoot) { result.error = "参数不完整"; return result; }

    let manifest = await readManifest(snapshotDir);
    // 快照内部排除清单/标记文件本身
    const excludes = [MANIFEST_NAME, INCOMPLETE_NAME, LOG_NAME];
    const files = await scanTree(snapshotDir, "", excludes, onProgress);
    result.files = files.length;

    let processed = 0;
    for (const f of files) {
        if (shouldStop()) { result.error = "已取消"; break; }
        processed++;
        if (processed % 150 === 0) {
            onProgress({ phase: "copy", current: processed, total: files.length });
            await breathe();
        }
        const destAbs = path.join(targetRoot, f.rel);
        try {
            await fsp.mkdir(path.dirname(destAbs), { recursive: true });
            await fsp.copyFile(f.abs, destAbs);
            await fsp.utimes(destAbs, new Date(f.mtimeMs), new Date(f.mtimeMs));
            result.copied++;
            result.bytes += f.size;
        } catch (e) {
            result.failed++;
        }
    }
    result.ms = Date.now() - t0;
    result.ok = !result.error && result.failed === 0;
    return result;
}

/**
 * 执行一次快照备份。
 *
 * @param {object} opts
 *   workspace   {string} 思源工作空间根目录（~/SiYuan）
 *   destRoot    {string} 备份根目录
 *   sources     {string[]} 要备份的顶层目录名，如 ["data","conf"]
 *   excludes    {string[]} 排除规则
 *   keepCount   {number} 保留快照份数
 *   onProgress  {(info:object)=>void} 进度回调
 *   shouldStop  {()=>boolean} 返回 true 时中止
 *   note        {string} 快照备注
 * @returns {Promise<{ok:boolean, snapshot:string, copied:number, linked:number,
 *                    bytes:number, files:number, failed:number, deleted:number, ms:number, error?:string}>}
 */
async function runSnapshot(opts) {
    const t0 = Date.now();
    const workspace = opts.workspace;
    const destRoot = expandHome(opts.destRoot);
    const sources = (opts.sources || []).filter(Boolean);
    const excludes = opts.excludes || DEFAULT_EXCLUDES;
    const onProgress = opts.onProgress || function () {};
    const shouldStop = opts.shouldStop || function () { return false; };

    const result = {
        ok: false, snapshot: "", copied: 0, linked: 0, bytes: 0,
        files: 0, failed: 0, deleted: 0, ms: 0, failures: [],
    };

    if (!workspace || !destRoot) { result.error = "缺少工作空间或备份目录"; return result; }
    if (isPathInside(destRoot, workspace)) {
        result.error = "备份目录不能位于工作空间内部（否则会递归备份自身）：" + contractHome(destRoot);
        return result;
    }

    try {
        await fsp.mkdir(destRoot, { recursive: true });
    } catch (e) {
        result.error = "无法创建备份目录 " + contractHome(destRoot) + "：" + friendlyError(e);
        return result;
    }

    // 1) 扫描全部源文件
    let totalBytes = 0;
    const all = [];
    for (const src of sources) {
        const rootAbs = path.join(workspace, src);
        let st = null;
        try { st = await fsp.stat(rootAbs); } catch (e) { st = null; }
        if (!st || !st.isDirectory()) continue;
        const files = await scanTree(rootAbs, src, excludes, onProgress);
        all.push(...files);
        if (shouldStop()) { result.error = "已取消"; return result; }
    }
    result.files = all.length;
    for (const f of all) totalBytes += f.size;

    // 2) 上一份「完整」快照作为硬链接基准
    const existing = await listSnapshots(destRoot);
    const prevDir = existing.length ? existing[existing.length - 1].path : null;

    // 3) 磁盘空间预检
    const free = await freeBytesOf(destRoot);
    if (free >= 0) {
        const need = prevDir ? 100 * 1024 * 1024 : totalBytes * 1.15 + 50 * 1024 * 1024;
        if (free < need) {
            result.error = "目标磁盘空间不足：仅剩 " + humanSize(free) +
                "，预计需要 " + humanSize(need) + "。请清理后重试。";
            return result;
        }
    }

    // 4) 建立本次快照目录（同名已存在时追加序号，避免覆盖上一份）
    const base = SNAP_PREFIX + stampOf();
    let name = base;
    let snapDir = path.join(destRoot, name);
    let seq = 1;
    while (fs.existsSync(snapDir)) {
        seq++;
        name = base + "-" + seq;
        snapDir = path.join(destRoot, name);
    }
    try {
        await fsp.mkdir(snapDir, { recursive: true });
        // 半成品标记：完整清单写入完成后才移除
        await fsp.writeFile(path.join(snapDir, INCOMPLETE_NAME), JSON.stringify({ startedAt: Date.now() }), "utf8");
    } catch (e) {
        result.error = "无法创建快照目录：" + friendlyError(e);
        return result;
    }
    result.snapshot = snapDir;

    let linkFailed = false;
    const failures = [];

    // 5) 逐文件处理：命中则硬链接，否则复制
    let processed = 0;
    for (const f of all) {
        if (shouldStop()) { result.error = "已取消"; break; }

        processed++;
        if (processed % 150 === 0) {
            onProgress({ phase: "copy", current: processed, total: all.length });
            await breathe();
        }

        const destAbs = path.join(snapDir, f.rel);
        try {
            await fsp.mkdir(path.dirname(destAbs), { recursive: true });
        } catch (e) {
            failures.push(f.rel + " (" + friendlyError(e) + ")");
            result.failed++;
            continue;
        }

        // 与上一份快照比对：尺寸 + 修改时间一致即视为未变化。
        // 时间用 2ms 容差——部分文件系统写入 utimes 时会丢失亚毫秒精度，
        // 严格相等会把未变动的文件误判为已变更，导致每次都全量复制。
        let canLink = !!prevDir;
        if (canLink) {
            try {
                const pst = await fsp.stat(path.join(prevDir, f.rel));
                canLink = pst.size === f.size && Math.abs(pst.mtimeMs - f.mtimeMs) < 2;
            } catch (e) {
                canLink = false;
            }
        }
        if (canLink && !linkFailed) {
            try {
                await fsp.link(path.join(prevDir, f.rel), destAbs);
                result.linked++;
                continue;
            } catch (e) {
                const code = e && e.code;
                if (code === "EXDEV" || code === "ENOSYS" || code === "EMLINK" || code === "EPERM") {
                    // 跨设备 / 文件系统不支持硬链接 -> 本次其余文件一律改用复制
                    linkFailed = true;
                }
                // 其余错误只影响这一个文件，退化为复制即可
            }
        }

        // 复制（最多重试 3 次，规避源文件正处于写入中）
        let copied = false;
        for (let attempt = 0; attempt < 3 && !copied; attempt++) {
            try {
                await fsp.copyFile(f.abs, destAbs);
                await fsp.utimes(destAbs, new Date(f.mtimeMs), new Date(f.mtimeMs));
                // 复制后尺寸漂移说明源文件正被写入，重试
                const after = await fsp.stat(f.abs);
                if (after.size !== f.size) { await breathe(); continue; }
                copied = true;
            } catch (e) {
                if (attempt === 2) {
                    failures.push(f.rel + " (" + friendlyError(e) + ")");
                } else {
                    await breathe();
                }
            }
        }
        if (copied) {
            result.copied++;
            result.bytes += f.size;
        } else {
            result.failed++;
        }
    }

    if (result.error) {
        // 取消/异常：删除半成品快照，不留垃圾
        try { await fsp.rm(snapDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
        result.snapshot = "";
        result.ms = Date.now() - t0;
        await appendLog(destRoot, name + " 已中止（" + result.error + "），半成品已清理");
        return result;
    }

    // 6) 写入清单并移除半成品标记 —— 至此快照才算「完整」
    try {
        const manifest = {
            plugin: PLUGIN_NAME,
            version: 2,
            createdAt: Date.now(),
            workspace,
            sources,
            excludes,
            note: opts.note || "",
            fileCount: all.length,
            totalBytes,
            copied: result.copied,
            copiedBytes: result.bytes,
            linked: result.linked,
            failed: result.failed,
            failures: failures.slice(0, 200),
            hardlink: !linkFailed,
        };
        await fsp.writeFile(path.join(snapDir, MANIFEST_NAME), JSON.stringify(manifest), "utf8");
        try { await fsp.unlink(path.join(snapDir, INCOMPLETE_NAME)); } catch (e) { /* ignore */ }
    } catch (e) {
        result.error = "写入快照清单失败：" + friendlyError(e);
    }

    result.failures = failures;

    // 7) 清理过期快照
    try {
        const after = await listSnapshots(destRoot);
        const doomed = selectSnapshotsToDelete(after, opts.keepCount || 30);
        for (const d of doomed) {
            try { await removeSnapshot(path.join(destRoot, d)); result.deleted++; } catch (e) { /* ignore */ }
        }
    } catch (e) { /* ignore */ }

    result.ms = Date.now() - t0;
    result.ok = !result.error;

    try {
        await appendLog(destRoot,
            name + " 文件 " + result.files + "，新增/变更 " + result.copied +
            "，硬链接 " + result.linked + "，失败 " + result.failed +
            "，清理 " + result.deleted + "，用时 " + (result.ms / 1000).toFixed(1) + "s" +
            (result.error ? " [错误: " + result.error + "]" : ""));
    } catch (e) { /* ignore */ }

    return result;
}

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
        this.status = { text: "", kind: "idle" };
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

        // 启动时清理半成品快照
        this.cleanupIncomplete(this.destRoot()).then((n) => {
            if (n > 0) {
                console.log("[" + PLUGIN_NAME + "] 已清理 " + n + " 份未完成的快照");
                appendLog(this.destRoot(), "启动清理：删除 " + n + " 份未完成的快照");
            }
        });
    }

    /** 界面就绪后再做每日首启备份（此时 UI/调度都已可用） */
    onLayoutReady() {
        if (this.settings.dailyFirst && this.settings.lastDailyDay !== dayString()) {
            this.settings.lastDailyDay = dayString();
            this.saveSettings();
            this.scheduleBackup("daily");
        }
    }

    onunload() {
        this.stopTimer();
        window.removeEventListener("mousedown", this.activityHandler, { capture: true });
        window.removeEventListener("keydown", this.activityHandler, { capture: true });
        if (this.styleEl && this.styleEl.remove) this.styleEl.remove();
        this.canceled = true;
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
        try { await this.saveData("settings.json", this.settings); } catch (e) { /* ignore */ }
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
        return path.join(os.homedir(), "SiYuan");
    }

    // ---------------- UI ----------------

    addStyle() {
        const css = `
.sibk-log { max-height: 240px; overflow: auto; font-family: var(--b3-font-family-code); font-size: 12px; line-height: 1.6; white-space: pre-wrap; word-break: break-all; }
.sibk-hint { color: var(--b3-theme-on-surface-light); font-size: 12px; margin: 4px 0 8px; }
.sibk-field { margin: 0 0 10px; }
.sibk-field > .b3-text-field { width: 100%; box-sizing: border-box; }
.sibk-inline { display: flex; gap: 8px; align-items: center; }
.sibk-inline > input { flex: 1; }
/* 设置面板：双列紧凑布局，防止纵向溢出 */
.sibk-settings .b3-dialog__content { max-height: min(72vh, 560px); overflow: auto; box-sizing: border-box; }
.sibk-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 28px; align-items: start; }
.sibk-col { min-width: 0; }
.sibk-settings .b3-label { padding: 2px 0 !important; }
.sibk-settings .sibk-sources label { margin: 2px 0; }
.sibk-settings textarea.b3-text-field { resize: vertical; min-height: 56px; }
/* 统计卡片 */
.sibk-stat { display: flex; gap: 10px; flex-wrap: wrap; margin: 4px 0 0; }
.sibk-stat > div { background: var(--b3-theme-surface-lighter); border-radius: 4px; padding: 6px 10px; flex: 1 1 30%; box-sizing: border-box; }
.sibk-stat b { display: block; font-size: 14px; }
.sibk-stat span { font-size: 11px; color: var(--b3-theme-on-surface-light); }
/* 快照管理表格 */
.sibk-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.sibk-table th, .sibk-table td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--b3-border-color); white-space: nowrap; }
.sibk-table th { color: var(--b3-theme-on-surface-light); font-weight: normal; font-size: 12px; }
.sibk-table .sibk-note { color: var(--b3-theme-on-surface-light); max-width: 140px; overflow: hidden; text-overflow: ellipsis; }
.sibk-actions { white-space: nowrap; }
.sibk-actions button { margin-right: 4px; }
.sibk-scroll { max-height: 420px; overflow: auto; }
`;
        this.styleEl = document.createElement("style");
        this.styleEl.textContent = css;
        document.head.appendChild(this.styleEl);
    }

    /** 注册顶栏图标符号（调用基类 addIcons；注意勿与基类同名，否则无限递归） */
    registerIcons() {
        const svg = `<symbol id="iconSibk" viewBox="0 0 32 32">
<path d="M16 3a7 7 0 0 0-7 7v3H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V15a2 2 0 0 0-2-2h-2v-3a7 7 0 0 0-7-7zm0 3a4 4 0 0 1 4 4v3h-8v-3a4 4 0 0 1 4-4z"/>
<path d="M16 17.5a1.5 1.5 0 0 1 1.5 1.5.75.75 0 0 0 1.5 0 3 3 0 0 0-6 0c0 1.6 1.1 2.1 2 2.5.7.3 1 .6 1 1a1.5 1.5 0 0 1-3 0 .75.75 0 0 0-1.5 0 3 3 0 0 0 6 0c0-1.7-1.2-2.2-2-2.6-.8-.35-1-.6-1-.9z"/>
</symbol>`;
        try { this.addIcons(svg); } catch (e) { console.error("[" + PLUGIN_NAME + "] 注册图标失败", e); }
    }

    addTopBarButton() {
        const self = this;
        this.topBarElement = this.addTopBar({
            icon: "iconSibk",
            title: this.t("topbarTitle", "增量备份"),
            position: "right",
            callback: (evt) => { self.showMenu(evt); },
        });
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
        } catch (e) { /* ignore */ }
    }

    updateTopBar(text, kind) {
        if (text !== undefined) { this.status.text = text; this.status.kind = kind || "idle"; }
        if (!this.topBarElement) return;
        const el = this.topBarElement;
        const label = this.status.text
            ? this.status.text
            : (this.settings.lastBackupAt
                ? this.t("lastBackup", "上次备份") + " " + readable(new Date(this.settings.lastBackupAt))
                : this.t("neverBackup", "尚未备份"));
        el.setAttribute("aria-label", label);
        const svg = el.querySelector("svg");
        if (svg) svg.style.opacity = this.running ? "0.55" : "1";
        let badge = el.querySelector(".sibk-badge");
        if (this.running) {
            if (!badge) {
                badge = document.createElement("span");
                badge.className = "sibk-badge";
                badge.style.cssText = "position:absolute;right:2px;bottom:2px;width:6px;height:6px;border-radius:50%;background:var(--b3-theme-primary);";
                el.style.position = "relative";
                el.appendChild(badge);
            }
        } else if (badge) badge.remove();
    }

    showMenu(evt) {
        const Menu = siyuan.Menu;
        const menu = new Menu("sibk-menu");
        menu.addItem({
            icon: "iconSibk",
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

    openSettings() {
        const Dialog = siyuan.Dialog;
        const self = this;
        const s = this.settings;

        const sourceHtml = SOURCE_DEFS.map((def) => {
            const checked = s.sources[def.key] ? " checked" : "";
            return `<label class="fn__flex b3-label">
    <input type="checkbox" class="b3-switch" data-source="${def.key}"${checked}>
    <span class="fn__space"></span>
    <span class="fn__flex-1">${this.escapeHtml(this.t(def.i18n, def.key))}</span>
</label>`;
        }).join("");

        const ws = this.workspace();
        const html = `<div class="b3-dialog__content sibk-settings">
    <div class="sibk-grid">
        <div class="sibk-col">
            <div class="sibk-field">
                <label class="b3-label fn__block">${this.t("destRoot", "备份保存位置")}</label>
                <div class="sibk-inline">
                    <input id="sibkDest" class="b3-text-field" value="${this.escapeHtml(contractHome(s.destRoot))}">
                    <button class="b3-button b3-button--text" id="sibkPick">${this.t("pickFolder", "选择…")}</button>
                </div>
                <div class="sibk-hint">${this.t("destRootHint", "建议放在工作空间之外的磁盘上。")}</div>
            </div>
            <div class="sibk-field">
                <label class="b3-label fn__block">${this.t("interval", "自动备份频率")}</label>
                <select id="sibkIntervalSel" class="b3-select fn__block">
                    <option value="30"${s.intervalMinutes === 30 ? " selected" : ""}>${this.t("every30m", "每 30 分钟")}</option>
                    <option value="120"${s.intervalMinutes === 120 ? " selected" : ""}>${this.t("every2h", "每 2 小时")}</option>
                    <option value="1440"${s.intervalMinutes === 1440 ? " selected" : ""}>${this.t("everyDay", "每天一次")}</option>
                    <option value="10080"${s.intervalMinutes === 10080 ? " selected" : ""}>${this.t("everyWeek", "每周一次")}</option>
                    <option value="custom"${[30, 120, 1440, 10080].indexOf(s.intervalMinutes) === -1 ? " selected" : ""}>${this.t("custom", "自定义（分钟）")}</option>
                </select>
                <div class="sibk-inline" style="margin-top:6px">
                    <input id="sibkInterval" class="b3-text-field" type="number" min="0" step="5" value="${s.intervalMinutes}"${[30, 120, 1440, 10080].indexOf(s.intervalMinutes) !== -1 ? " disabled" : ""}>
                    <span class="sibk-hint">${this.t("minutesUnit", "分钟，0 关闭定时")}</span>
                </div>
            </div>
            <div class="sibk-field">
                <label class="b3-label fn__block">${this.t("idleMinutes", "空闲判定（分钟，0 不等待空闲）")}</label>
                <input id="sibkIdle" class="b3-text-field fn__block" type="number" min="0" step="1" value="${s.idleMinutes}">
            </div>
            <div class="sibk-field">
                <label class="b3-label fn__block">${this.t("keepCount", "最多保留快照份数")}</label>
                <input id="sibkKeep" class="b3-text-field fn__block" type="number" min="1" step="1" value="${s.keepCount}">
            </div>
            <div class="sibk-field">
                <label class="b3-label fn__block">${this.t("excludes", "额外排除规则（每行一条）")}</label>
                <textarea id="sibkExcludes" class="b3-text-field fn__block" rows="3" placeholder="cache/&#10;*.zip">${this.escapeHtml(s.extraExcludes || "")}</textarea>
            </div>
        </div>
        <div class="sibk-col">
            <div class="sibk-field">
                <label class="b3-label fn__block">${this.t("sourceScope", "备份范围")}</label>
                <div class="sibk-sources">${sourceHtml}</div>
                <div class="sibk-hint">${this.t("sourceHint", "工作空间：")}${this.escapeHtml(contractHome(ws))}</div>
            </div>
            <div class="sibk-field">
                <label class="fn__flex b3-label fn__block">
                    <input type="checkbox" id="sibkAutoStart" class="b3-switch"${s.autoStart ? " checked" : ""}>
                    <span class="fn__space"></span>
                    <span class="fn__flex-1">${this.t("autoStart", "启动思源后自动开启定时备份")}</span>
                </label>
                <label class="fn__flex b3-label fn__block">
                    <input type="checkbox" id="sibkDailyFirst" class="b3-switch"${s.dailyFirst ? " checked" : ""}>
                    <span class="fn__space"></span>
                    <span class="fn__flex-1">${this.t("dailyFirst", "每天首次启动思源时自动备份一次")}</span>
                </label>
            </div>
            <div class="sibk-field">
                <label class="b3-label fn__block">${this.t("excludesHintTitle", "默认排除")}</label>
                <div class="sibk-hint">${this.t("excludeHint", "temp/、corrupted/、.DS_Store、.lock、*.tmp、*.log、node_modules/")}</div>
            </div>
            <div class="sibk-field" id="sibkStatBox"></div>
        </div>
    </div>
</div>
<div class="b3-dialog__action">
    <button class="b3-button b3-button--cancel">${this.t("cancel", "取消")}</button>
    <div class="fn__space"></div>
    <button class="b3-button b3-button--text" id="sibkRunNow">${this.t("backupNow", "立即备份")}</button>
    <button class="b3-button b3-button--text" id="sibkSave">${this.t("save", "保存")}</button>
</div>`;

        const dialog = new Dialog({ title: this.t("settingsTitle", "增量备份设置"), content: html, width: "820px" });
        const root = dialog.element;
        this.renderStatBox(root.querySelector("#sibkStatBox"));

        root.querySelector(".b3-button--cancel").addEventListener("click", () => dialog.destroy());
        // 频率下拉与自定义分钟输入联动
        const intervalSel = root.querySelector("#sibkIntervalSel");
        const intervalInput = root.querySelector("#sibkInterval");
        if (intervalSel && intervalInput) {
            intervalSel.addEventListener("change", () => {
                const custom = intervalSel.value === "custom";
                intervalInput.disabled = !custom;
                if (!custom) intervalInput.value = intervalSel.value;
            });
        }
        root.querySelector("#sibkPick").addEventListener("click", async () => {
            const picked = await self.pickDirectory(root.querySelector("#sibkDest").value);
            if (picked) root.querySelector("#sibkDest").value = contractHome(picked);
        });
        root.querySelector("#sibkRunNow").addEventListener("click", () => {
            self.collectSettings(root);
            self.saveSettings();
            dialog.destroy();
            self.scheduleBackup("manual");
        });
        root.querySelector("#sibkSave").addEventListener("click", () => {
            self.collectSettings(root);
            self.saveSettings();
            siyuan.showMessage(self.t("saved", "设置已保存"), 3000, "info");
            self.startTimer();
            self.updateTopBar();
            dialog.destroy();
        });
    }

    collectSettings(root) {
        const s = this.settings;
        const dest = root.querySelector("#sibkDest").value.trim();
        s.destRoot = dest ? expandHome(dest) : path.join(os.homedir(), "SiYuanBackup");
        root.querySelectorAll("[data-source]").forEach((el) => {
            s.sources[el.getAttribute("data-source")] = el.checked;
        });
        const sel = root.querySelector("#sibkIntervalSel");
        const selVal = sel ? sel.value : "custom";
        let iv;
        if (selVal && selVal !== "custom") {
            iv = parseInt(selVal, 10);
        } else {
            iv = parseInt(root.querySelector("#sibkInterval").value, 10);
        }
        s.intervalMinutes = isNaN(iv) || iv < 0 ? 0 : iv;
        const idm = parseInt(root.querySelector("#sibkIdle").value, 10);
        s.idleMinutes = isNaN(idm) || idm < 0 ? 0 : idm;
        const kc = parseInt(root.querySelector("#sibkKeep").value, 10);
        s.keepCount = isNaN(kc) || kc < 1 ? 30 : kc;
        s.extraExcludes = root.querySelector("#sibkExcludes").value;
        s.autoStart = root.querySelector("#sibkAutoStart").checked;
        s.dailyFirst = root.querySelector("#sibkDailyFirst").checked;
    }

    async renderStatBox(box) {
        if (!box) return;
        box.innerHTML = `<div class="sibk-hint">${this.t("loading", "统计中…")}</div>`;
        try {
            const snaps = await listSnapshots(this.destRoot());
            const last = snaps.length ? snaps[snaps.length - 1] : null;
            const { logical, physical } = await this.duOf(this.destRoot());
            box.innerHTML = `<div class="sibk-stat">
    <div><b>${snaps.length}</b><span>${this.t("snapshotCount", "已有快照")}</span></div>
    <div><b>${last ? readable(new Date(last.time)) : "-"}</b><span>${this.t("latestSnapshot", "最新快照")}</span></div>
    <div><b>${humanSize(physical)}</b><span>${this.t("statPhysical", "实际占用（去重）")}</span></div>
</div>
<div class="sibk-hint">${this.t("statLogicalHint", "逻辑大小")} ${humanSize(logical)}（Finder 视角，快照相加）；${this.t("statPhysicalHint", "真实磁盘占用仅")} ${humanSize(physical)}${this.t("statHardlink", "（硬链接共享）")}</div>`;
        } catch (e) {
            box.innerHTML = `<div class="sibk-hint">${this.t("statFailed", "统计失败")}</div>`;
        }
    }

    /**
     * 备份根目录占用统计。
     * @returns {Promise<{logical:number, physical:number}>}
     *   logical  = 各快照文件大小之和（Finder 视角，硬链接重复计入）
     *   physical = 按 inode 去重后的真实磁盘占用
     */
    async duOf(dir) {
        let logical = 0, physical = 0;
        const seen = new Set();
        async function walk(d) {
            let entries;
            try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch (e) { return; }
            for (const ent of entries) {
                const p = path.join(d, ent.name);
                try {
                    const st = await fsp.lstat(p);
                    if (st.isDirectory()) { await walk(p); continue; }
                    logical += st.size;
                    const key = st.dev + ":" + st.ino;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    physical += st.size;
                } catch (e) { /* ignore */ }
            }
        }
        await walk(dir);
        return { logical, physical };
    }

    openLog() {
        const Dialog = siyuan.Dialog;
        const logPath = path.join(this.destRoot(), LOG_NAME);
        let content = "";
        try {
            const text = fs.readFileSync(logPath, "utf8");
            const lines = text.trim().split("\n");
            content = lines.slice(-200).reverse().join("\n") || this.t("emptyLog", "暂无日志");
        } catch (e) {
            content = this.t("emptyLog", "暂无日志");
        }
        const dialog = new Dialog({
            title: this.t("logTitle", "备份日志"),
            content: `<div class="b3-dialog__content"><div class="sibk-log">${this.escapeHtml(content)}</div></div>
<div class="b3-dialog__action">
    <button class="b3-button b3-button--cancel">${this.t("close", "关闭")}</button>
    <div class="fn__space"></div>
    <button class="b3-button b3-button--text" id="sibkOpenLog">${this.t("openBackupDir", "打开备份目录")}</button>
</div>`,
            width: "720px",
        });
        dialog.element.querySelector(".b3-button--cancel").addEventListener("click", () => dialog.destroy());
        dialog.element.querySelector("#sibkOpenLog").addEventListener("click", () => this.openPath(this.destRoot()));
    }

    // ---------------- 快照管理 ----------------

    async openSnapshots() {
        const Dialog = siyuan.Dialog;
        const self = this;
        const snaps = await listSnapshots(this.destRoot());

        const rows = snaps.slice().reverse().map((s) => {
            return `<tr data-snap="${this.escapeHtml(s.name)}">
    <td>${readable(new Date(s.time))}</td>
    <td>${s.files}</td>
    <td>${s.copied}${s.linked ? " / +" + s.linked : ""}</td>
    <td>${s.copied === 0 ? "0（全硬链接）" : humanSize(s.bytes)}</td>
    <td class="sibk-note">${this.escapeHtml(s.note || "-")}</td>
    <td class="sibk-actions">
        <button class="b3-button b3-button--small b3-button--text" data-act="restore">${this.t("restore", "恢复")}</button>
        <button class="b3-button b3-button--small b3-button--text" data-act="note">${this.t("editNote", "备注")}</button>
        <button class="b3-button b3-button--small b3-button--text" data-act="open">${this.t("open", "打开")}</button>
        <button class="b3-button b3-button--small b3-button--text" data-act="del">${this.t("delete", "删除")}</button>
    </td>
</tr>`;
        }).join("");

        const dialog = new Dialog({
            title: this.t("snapshotsTitle", "快照管理 / 恢复"),
            content: `<div class="b3-dialog__content">
    <div class="sibk-hint">${this.t("snapshotsHint", "「实际写入」是该快照相对上一份的真实新增磁盘占用；每份快照显示的文件夹大小为逻辑大小，未变化文件实际与上一份共享存储。")}</div>
    <div class="sibk-scroll"><table class="sibk-table">
        <thead><tr><th>${this.t("colTime", "时间")}</th><th>${this.t("colFiles", "文件数")}</th><th>${this.t("colChanges", "复制/链接")}</th><th>${this.t("colBytes", "实际写入")}</th><th>${this.t("colNote", "备注")}</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="6">${this.t("noSnapshots", "暂无快照")}</td></tr>`}</tbody>
    </table></div>
</div>
<div class="b3-dialog__action">
    <button class="b3-button b3-button--cancel">${this.t("close", "关闭")}</button>
    <div class="fn__space"></div>
    <button class="b3-button b3-button--text" id="sibkSnapBackup">${this.t("backupNow", "立即备份")}</button>
</div>`,
            width: "760px",
        });

        const root = dialog.element;
        root.querySelector(".b3-button--cancel").addEventListener("click", () => dialog.destroy());
        root.querySelector("#sibkSnapBackup").addEventListener("click", () => {
            dialog.destroy();
            this.scheduleBackup("manual");
        });

        root.querySelector("tbody").addEventListener("click", async (evt) => {
            const btn = evt.target.closest("button[data-act]");
            if (!btn) return;
            const tr = btn.closest("tr");
            const name = tr.getAttribute("data-snap");
            const snapPath = path.join(self.destRoot(), name);

            if (btn.getAttribute("data-act") === "open") {
                self.openPath(snapPath);
            } else if (btn.getAttribute("data-act") === "del") {
                siyuan.confirm(self.t("delete", "删除"), self.t("deleteConfirm", "确定删除快照") + " " + name + " ？", () => {
                    removeSnapshot(snapPath).then(() => { dialog.destroy(); self.openSnapshots(); });
                });
            } else if (btn.getAttribute("data-act") === "note") {
                self.editSnapshotNote(snapPath, () => { dialog.destroy(); self.openSnapshots(); });
            } else if (btn.getAttribute("data-act") === "restore") {
                dialog.destroy();
                self.openRestore(snapPath);
            }
        });
    }

    async editSnapshotNote(snapPath, onDone) {
        const Dialog = siyuan.Dialog;
        const self = this;
        const manifest = await readManifest(snapPath);
        const current = manifest && manifest.note ? manifest.note : "";
        const dialog = new Dialog({
            title: this.t("editNote", "快照备注"),
            content: `<div class="b3-dialog__content">
    <input id="sibkNoteInput" class="b3-text-field fn__block" value="${this.escapeHtml(current)}" placeholder="${this.t("notePlaceholder", "例如：改版完成/每周留存")}">
</div>
<div class="b3-dialog__action">
    <button class="b3-button b3-button--cancel">${this.t("cancel", "取消")}</button>
    <div class="fn__space"></div>
    <button class="b3-button b3-button--text" id="sibkNoteSave">${this.t("save", "保存")}</button>
</div>`,
            width: "460px",
        });
        const root = dialog.element;
        root.querySelector(".b3-button--cancel").addEventListener("click", () => dialog.destroy());
        root.querySelector("#sibkNoteSave").addEventListener("click", () => {
            const note = root.querySelector("#sibkNoteInput").value.trim();
            const m = manifest || { plugin: PLUGIN_NAME, version: 2, createdAt: Date.now() };
            m.note = note;
            fsp.writeFile(path.join(snapPath, MANIFEST_NAME), JSON.stringify(m), "utf8")
                .catch(() => { /* ignore */ })
                .then(() => { dialog.destroy(); onDone && onDone(); });
        });
        setTimeout(() => { const el = root.querySelector("#sibkNoteInput"); el && el.focus(); }, 100);
    }

    // ---------------- 恢复向导 ----------------

    openRestore(snapPath) {
        const Dialog = siyuan.Dialog;
        const self = this;
        const name = path.basename(snapPath);
        const dialog = new Dialog({
            title: this.t("restoreTitle", "恢复快照") + "：" + name,
            content: `<div class="b3-dialog__content">
    <div class="sibk-field">
        <label class="b3-label fn__block">${this.t("restoreExport", "① 导出到文件夹")}</label>
        <div class="sibk-hint">${this.t("restoreExportHint", "把该快照的完整内容复制到指定文件夹，不影响当前工作空间，最安全。")}</div>
        <button class="b3-button b3-button--text" id="sibkExport">${this.t("chooseExport", "选择导出位置…")}</button>
    </div>
    <div class="sibk-field">
        <label class="b3-label fn__block">${this.t("restoreOverwrite", "② 还原到工作空间（覆盖当前数据）")}</label>
        <div class="sibk-hint">${this.t("restoreOverwriteHint", "将用该快照覆盖当前工作空间的 data/conf 目录。覆盖前会自动生成一份「还原前安全快照」。完成后需重启思源。")}</div>
        <button class="b3-button b3-button--text" id="sibkOverwrite">${this.t("doOverwrite", "覆盖还原…")}</button>
    </div>
    <div class="sibk-field"><div class="sibk-hint" id="sibkRestoreStatus"></div></div>
</div>
<div class="b3-dialog__action">
    <button class="b3-button b3-button--cancel">${this.t("close", "关闭")}</button>
</div>`,
            width: "560px",
        });
        const root = dialog.element;
        const statusEl = root.querySelector("#sibkRestoreStatus");

        root.querySelector(".b3-button--cancel").addEventListener("click", () => dialog.destroy());

        // 模式一：导出
        root.querySelector("#sibkExport").addEventListener("click", async () => {
            const target = await self.pickDirectory(os.homedir());
            if (!target) return;
            if (isPathInside(expandHome(target), self.workspace())) {
                siyuan.showMessage(self.t("insideWorkspace", "导出目录不能位于工作空间内部"), 4000, "error");
                return;
            }
            statusEl.textContent = self.t("restoring", "恢复中…");
            const res = await restoreSnapshot({ snapshotDir: snapPath, targetRoot: target });
            if (res.ok) {
                statusEl.textContent = self.t("restoreDone", "恢复完成") + "：" + res.copied + " " + self.t("files", "个文件") + " → " + contractHome(target);
                self.openPath(target);
            } else {
                statusEl.textContent = self.t("restoreFailed", "恢复失败") + "：" + (res.error || res.failed + " 个文件失败");
            }
        });

        // 模式二：覆盖还原
        root.querySelector("#sibkOverwrite").addEventListener("click", () => {
            siyuan.confirm(
                self.t("restoreOverwrite", "覆盖还原"),
                self.t("overwriteWarn", "将用快照") + " " + name + " " + self.t("overwriteWarn2", "覆盖当前工作空间数据。覆盖前会自动做一份安全快照。确定继续？"),
                async () => {
                    dialog.destroy();
                    await self.doOverwriteRestore(snapPath);
                });
        });
    }

    async doOverwriteRestore(snapPath) {
        const self = this;
        // 1) 还原前安全快照
        this.running = true;
        this.updateTopBar(this.t("safetySnapshot", "正在生成还原前安全快照…"), "running");
        let safety = null;
        try {
            safety = await runSnapshot({
                workspace: this.workspace(),
                destRoot: this.destRoot(),
                sources: this.activeSources(),
                excludes: buildExcludes(this.settings.extraExcludes),
                keepCount: this.settings.keepCount,
                note: this.t("safetyNote", "还原前安全快照"),
                shouldStop: () => self.canceled,
            });
        } catch (e) { safety = null; }
        this.running = false;
        this.updateTopBar();

        if (!safety || !safety.ok) {
            siyuan.showMessage(this.t("safetyFailed", "安全快照生成失败，已中止还原，当前数据未受影响"), 8000, "error");
            return;
        }

        // 2) 覆盖还原
        this.running = true;
        this.updateTopBar(this.t("restoring", "还原中…"), "running");
        let res = null;
        try {
            res = await restoreSnapshot({
                snapshotDir: snapPath,
                targetRoot: this.workspace(),
                shouldStop: () => self.canceled,
            });
        } catch (e) {
            res = { ok: false, error: (e && e.message) || String(e) };
        }
        this.running = false;
        this.updateTopBar();

        if (res.ok) {
            await appendLog(this.destRoot(), "还原完成：" + path.basename(snapPath) + " -> 工作空间（还原前安全快照：" + path.basename(safety.snapshot) + "）");
            siyuan.confirm(
                this.t("restoreDone", "还原完成"),
                this.t("restartHint", "已还原") + " " + res.copied + " " + this.t("files", "个文件") + "。" +
                this.t("restartNow", "请立即重启思源以重建索引。安全快照：") + path.basename(safety.snapshot),
                () => { try { require("@electron/remote").app.relaunch(); require("@electron/remote").app.exit(0); } catch (e) { /* ignore */ } },
                null);
        } else {
            siyuan.showMessage(this.t("restoreFailed", "还原失败") + "：" + (res.error || "-"), 8000, "error");
        }
    }

    // ---------------- 调度 ----------------

    stopTimer() {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
    }

    startTimer() {
        this.stopTimer();
        const minutes = this.settings.intervalMinutes;
        if (!minutes || minutes <= 0) return;
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
        if (this.running) {
            if (reason === "manual") siyuan.showMessage(this.t("alreadyRunning", "备份正在进行中"), 3000, "info");
            return;
        }
        const sources = this.activeSources();
        if (!sources.length) {
            siyuan.showMessage(this.t("noSource", "请先在设置里选择备份范围"), 4000, "error");
            return;
        }
        this.running = true;
        this.canceled = false;
        // 节流时间戳先行落盘，防止失败后每 30 秒重复触发
        this.settings.lastAttemptAt = Date.now();
        this.saveSettings();
        this.updateTopBar(this.t("backupRunning", "备份中 0%"), "running");

        const onProgress = (info) => {
            if (info.phase === "scan") {
                this.updateTopBar(this.t("scanning", "扫描中…") + " " + info.scanned, "running");
            } else if (info.phase === "copy" && info.total) {
                const pct = Math.floor((info.current / info.total) * 100);
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
                onProgress,
                shouldStop: () => this.canceled,
                note: reason === "daily" ? this.t("dailyNote", "每日首启自动备份") : "",
            });
        } catch (e) {
            res = { ok: false, error: friendlyError(e), files: 0, copied: 0, linked: 0, failed: 0, deleted: 0, ms: 0 };
        }

        this.running = false;
        if (res.ok) {
            this.settings.lastBackupAt = Date.now();
            this.settings.lastResult = {
                snapshot: res.snapshot, files: res.files, copied: res.copied,
                linked: res.linked, deleted: res.deleted, ms: res.ms,
            };
            await this.saveSettings();
            this.updateTopBar();
            siyuan.showMessage(
                this.t("backupDone", "备份完成") + "：" + res.files + " " + this.t("files", "个文件") +
                "，" + this.t("changed", "新增/变更") + " " + res.copied +
                "，" + this.t("written", "实际写入") + " " + humanSize(res.bytes) +
                "，" + (res.ms / 1000).toFixed(1) + "s",
                6000, "info");
        } else {
            this.updateTopBar();
            siyuan.showMessage(this.t("backupFailed", "备份失败") + "：" + (res.error || "-"), 8000, "error");
        }
    }
}

// 暴露内部函数便于独立测试（思源加载时会一并带上）
IncrementalBackupPlugin.__internals = {
    runSnapshot, restoreSnapshot, listSnapshots, selectSnapshotsToDelete, scanTree,
    isExcluded, buildExcludes, humanSize, stampOf, parseSnapshotTime, readManifest,
    cleanupIncomplete, isPathInside, friendlyError, freeBytesOf,
    DEFAULT_EXCLUDES, SOURCE_DEFS,
};

module.exports = IncrementalBackupPlugin;
