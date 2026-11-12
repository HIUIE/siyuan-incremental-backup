"use strict";

// Pure Node backup engine. No SiYuan APIs and no access to a default workspace.
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const PLUGIN_NAME = "siyuan-incremental-backup";
const SNAP_PREFIX = "snap-";
const LOG_NAME = "backup.log";
const MANIFEST_NAME = "_manifest.json";
const INCOMPLETE_NAME = "_incomplete";
const LOCK_NAME = ".backup.lock";
const LOG_MAX_BYTES = 1024 * 1024;
const LOG_KEEP_BYTES = 256 * 1024;
const DEFAULT_EXCLUDES = ["temp/", "corrupted/", ".DS_Store", ".lock", "*.tmp", "*.log", "node_modules/"];
const SOURCE_DEFS = [
    { key: "data", dir: "data", i18n: "srcData" },
    { key: "conf", dir: "conf", i18n: "srcConf" },
    { key: "history", dir: "history", i18n: "srcHistory" },
    { key: "repo", dir: "repo", i18n: "srcRepo" },
];
const sourceNames = new Set(SOURCE_DEFS.map(s => s.dir));
const noFollow = fs.constants.O_NOFOLLOW || 0;
const integer = n => Number.isSafeInteger(n) && n >= 0;
const pad2 = n => n < 10 ? "0" + n : "" + n;
function stampOf(d = new Date()) {
    return "" + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + "-" + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
}
function dayString(d = new Date()) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
function readable(d = new Date()) { return dayString(d) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds()); }
function humanSize(bytes) {
    if (!bytes || bytes < 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0, n = bytes;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (i ? n.toFixed(n < 10 ? 2 : 1) : n) + " " + units[i];
}
function expandHome(p) { return p === "~" ? os.homedir() : typeof p === "string" && p.startsWith("~" + path.sep) ? path.join(os.homedir(), p.slice(2)) : p; }
function contractHome(p) { return p && isPathInside(p, os.homedir()) ? "~" + path.resolve(p).slice(os.homedir().length) : p; }
function breathe() { return new Promise(resolve => setImmediate(resolve)); }
function isPathInside(child, parent) {
    if (!child || !parent) return false;
    const rel = path.relative(path.resolve(parent), path.resolve(child));
    return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}
function friendlyError(e) {
    const map = { ENOSPC: "磁盘空间不足", EACCES: "没有读写权限", EPERM: "操作被系统拒绝", ENOENT: "文件或目录不存在", EBUSY: "文件被占用", EMFILE: "打开的文件过多", EXDEV: "跨文件系统操作受限", ELOCKED: "备份目录有其他操作或遗留锁，请核实后手动移除锁" };
    return (e && map[e.code] ? map[e.code] + " " : "") + (e && e.code ? "（" + e.code + "） " : "") + (e && e.message || String(e));
}
function fail(message, code = "EUNSAFE") { const e = new Error(message); e.code = code; throw e; }
function checkStop(shouldStop) { if (shouldStop && shouldStop()) fail("已取消", "ECANCELED"); }
function validRel(rel) {
    return typeof rel === "string" && rel.length > 0 && !rel.includes("\\") && !rel.includes("\0") && !path.posix.isAbsolute(rel) && !/^[A-Za-z]:/.test(rel) && rel.split("/").every(p => p && p !== "." && p !== "..");
}
function validSources(sources) { return Array.isArray(sources) && sources.length > 0 && new Set(sources).size === sources.length && sources.every(s => sourceNames.has(s)); }

// Check every existing component, including ancestors of a not-yet-created target.
// Node lacks openat(2); these checks plus O_NOFOLLOW protect ordinary symlink
// mistakes, but do not provide isolation from a hostile process renaming parents.
async function safePath(input, allowMissing = false) {
    if (typeof input !== "string" || !input.trim() || input.includes("\0")) fail("路径为空或无效");
    const absolute = path.resolve(expandHome(input));
    const parsed = path.parse(absolute);
    let current = parsed.root;
    const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
        current = path.join(current, parts[i]);
        let st;
        try { st = await fsp.lstat(current); }
        catch (e) { if (allowMissing && e.code === "ENOENT") return absolute; throw e; }
        if (st.isSymbolicLink()) fail("路径含符号链接：" + current);
        if (i < parts.length - 1 && !st.isDirectory()) fail("路径父级不是目录：" + current);
    }
    return absolute;
}
async function directory(input, create = false) {
    const absolute = await safePath(input, create);
    if (create) await fsp.mkdir(absolute, { recursive: true });
    await safePath(absolute);
    if (!(await fsp.lstat(absolute)).isDirectory()) fail("不是目录：" + absolute);
    return fsp.realpath(absolute);
}
async function exists(p) {
    try { await fsp.lstat(p); return true; }
    catch (e) { if (e.code === "ENOENT") return false; throw e; }
}

function isExcluded(rel, excludes = []) {
    if (!rel) return true;
    const norm = rel.split(path.sep).join("/"), base = path.posix.basename(norm);
    for (const raw of excludes) {
        const rule = String(raw || "").trim().split(path.sep).join("/").replace(/^\/+/, "");
        if (!rule) continue;
        if (rule.endsWith("/")) {
            const dir = rule.slice(0, -1);
            if (dir && (dir.includes("/") ? norm === dir || norm.startsWith(dir + "/") : norm.split("/").includes(dir))) return true;
        } else if (rule.startsWith("*")) {
            if (rule.length > 1 && base.endsWith(rule.slice(1))) return true;
        } else if (rule.includes("/")) {
            if (norm === rule || norm.startsWith(rule + "/")) return true;
        } else if (base === rule) return true;
    }
    return false;
}
function buildExcludes(extraText) { return [...new Set(DEFAULT_EXCLUDES.concat(String(extraText || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean)))]; }
async function mapLimit(items, limit, fn) {
    let cursor = 0, failed = false, firstError;
    // Workers absorb their own failure so Promise.all waits for EVERY started
    // operation before a caller can release its filesystem lock.
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (!failed && cursor < items.length) {
            const i = cursor++;
            try { await fn(items[i], i); }
            catch (e) { if (!failed) { failed = true; firstError = e; } }
        }
    }));
    if (failed) throw firstError;
}
function sameStat(a, b) { return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.ino === b.ino && a.dev === b.dev; }
async function scanTree(rootAbs, relRoot = "", excludes = [], onProgress, opts = {}) {
    if (relRoot && !validRel(relRoot)) fail("非法扫描相对路径");
    const root = await directory(rootAbs), files = [], queue = [{ abs: root, rel: relRoot }];
    const concurrency = Math.max(1, Math.min(32, Math.floor(opts.concurrency) || 8));
    let dirs = 0;
    for (let cursor = 0; cursor < queue.length; cursor++) {
        checkStop(opts.shouldStop);
        const dir = queue[cursor];
        await safePath(dir.abs);
        const entries = await fsp.readdir(dir.abs, { withFileTypes: true });
        dirs++;
        await mapLimit(entries, concurrency, async ent => {
            checkStop(opts.shouldStop);
            const abs = path.join(dir.abs, ent.name), rel = dir.rel ? dir.rel + "/" + ent.name : ent.name;
            if (!validRel(rel)) fail("非法文件路径：" + rel);
            const st = await fsp.lstat(abs);
            if (st.isSymbolicLink()) fail("源含符号链接，无法安全备份：" + rel);
            if (!st.isDirectory() && !st.isFile()) fail("源含不支持的文件类型：" + rel);
            if (isExcluded(rel, excludes)) return;
            if (st.isDirectory()) queue.push({ abs, rel });
            else files.push({ rel, abs, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, ino: st.ino, dev: st.dev });
        });
        if (dirs % 40 === 0) {
            if (onProgress) onProgress({ phase: "scan", scanned: files.length, dirs });
            await breathe();
        }
    }
    return files.sort((a, b) => a.rel.localeCompare(b.rel));
}

function parseSnapshotTime(name) {
    const m = /^snap-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-([2-9]|[1-9]\d+))?$/.exec(name);
    if (!m || +m[1] < 1970) return null;
    const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    return d.getFullYear() === +m[1] && d.getMonth() === +m[2] - 1 && d.getDate() === +m[3] && d.getHours() === +m[4] && d.getMinutes() === +m[5] && d.getSeconds() === +m[6] ? d.getTime() : null;
}
async function stableHash(file, shouldStop, buffer = Buffer.allocUnsafe(256 * 1024)) {
    await safePath(file);
    const handle = await fsp.open(file, fs.constants.O_RDONLY | noFollow);
    try {
        const before = await handle.stat();
        if (!before.isFile()) fail("不是普通文件：" + file);
        const hash = crypto.createHash("sha256");
        let position = 0;
        while (true) {
            checkStop(shouldStop);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
            if (!bytesRead) break;
            hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
        }
        const after = await handle.stat(), current = await fsp.lstat(file);
        if (!sameStat(before, after) || !sameStat(after, current) || position !== after.size || current.isSymbolicLink()) fail("读取期间文件变化：" + file, "ECHANGED");
        return { sha256: hash.digest("hex"), stat: after };
    } finally { await handle.close(); }
}
function validateManifest(m) {
    if (!m || m.plugin !== PLUGIN_NAME || ![2, 3].includes(m.version) || !integer(m.createdAt) || m.createdAt === 0 || typeof m.workspace !== "string" || !path.isAbsolute(m.workspace) || m.workspace.includes("\0") || !validSources(m.sources)) return false;
    if (![m.fileCount, m.totalBytes, m.copied, m.copiedBytes, m.linked, m.failed].every(integer) || m.fileCount === 0 || m.failed !== 0 || m.copied + m.linked !== m.fileCount || m.copiedBytes > m.totalBytes) return false;
    if (!Array.isArray(m.excludes) || !m.excludes.every(e => typeof e === "string") || (m.failures !== undefined && (!Array.isArray(m.failures) || m.failures.length)) || (m.note !== undefined && typeof m.note !== "string") || (m.hardlink !== undefined && typeof m.hardlink !== "boolean")) return false;
    if (m.version === 3) {
        if (!Array.isArray(m.entries) || m.entries.length !== m.fileCount) return false;
        const seen = new Set(); let bytes = 0;
        for (const e of m.entries) {
            if (!e || !validRel(e.rel) || !m.sources.includes(e.rel.split("/")[0]) || seen.has(e.rel) || !integer(e.size) || !Number.isFinite(e.mtimeMs) || typeof e.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(e.sha256)) return false;
            seen.add(e.rel); bytes += e.size;
        }
        if (!Number.isSafeInteger(bytes) || bytes !== m.totalBytes) return false;
    }
    return true;
}
async function loadManifest(snapDir) {
    const absolute = await directory(snapDir);
    if (parseSnapshotTime(path.basename(absolute)) === null) fail("非法快照名称");
    if (await exists(path.join(absolute, INCOMPLETE_NAME))) fail("快照尚未完成");
    const manifestPath = path.join(absolute, MANIFEST_NAME);
    await safePath(manifestPath);
    const handle = await fsp.open(manifestPath, fs.constants.O_RDONLY | noFollow);
    let manifest;
    try {
        const st = await handle.stat();
        if (!st.isFile() || st.size > 64 * 1024 * 1024) fail("快照清单不是有效普通文件或过大");
        manifest = JSON.parse(await handle.readFile("utf8"));
    } finally { await handle.close(); }
    if (!validateManifest(manifest)) fail("无效或失败的快照清单");
    return { manifest, path: absolute };
}
async function loadVerifiedSnapshot(snapDir, shouldStop) {
    const { manifest, path: absolute } = await loadManifest(snapDir);
    const files = await scanTree(absolute, "", [], null, { shouldStop });
    const content = files.filter(f => f.rel !== MANIFEST_NAME);
    if (content.length !== manifest.fileCount || content.reduce((n, f) => n + f.size, 0) !== manifest.totalBytes) fail("快照文件数量或字节数与清单不符");
    const expected = new Map((manifest.entries || []).map(e => [e.rel, e]));
    const hashes = new Map(), stats = new Map();
    await mapLimit(content, 4, async file => {
        if (!manifest.sources.includes(file.rel.split("/")[0])) fail("快照含清单范围外文件：" + file.rel);
        const hash = await stableHash(file.abs, shouldStop), entry = expected.get(file.rel);
        if (manifest.version === 3 && (!entry || entry.size !== hash.stat.size || entry.sha256 !== hash.sha256)) fail("快照内容校验失败：" + file.rel);
        hashes.set(file.rel, hash.sha256); stats.set(file.rel, hash.stat);
    });
    if (await exists(path.join(absolute, INCOMPLETE_NAME))) fail("快照尚未完成");
    return { manifest, files: content, hashes, stats, path: absolute };
}
async function verifySnapshot(snapshotDir, opts = {}) {
    try {
        const verified = await loadVerifiedSnapshot(snapshotDir, opts.shouldStop);
        const m = verified.manifest;
        return { ok: true, files: m.fileCount, bytes: m.totalBytes, legacy: m.version === 2, error: "", warning: m.version === 2 ? "旧版 v2 清单缺少历史内容指纹；已核对文件数和字节数，无法证明内容未被篡改" : "" };
    } catch (e) { return { ok: false, files: 0, bytes: 0, error: friendlyError(e) }; }
}
async function validateBackupPaths(workspace, destRoot) {
    const root = await directory(workspace), candidate = await safePath(destRoot, true);
    if (isPathInside(candidate, root) || isPathInside(root, candidate)) fail("备份目录与工作空间不能相同或互相位于内部");
    return { workspace: root, destRoot: candidate };
}
async function readManifest(snapDir) {
    // Submission status only. Use verifySnapshot for actual content integrity.
    try { return (await loadManifest(snapDir)).manifest; }
    catch (_) { return null; }
}
async function listSnapshots(destRoot, opts = {}) {
    let root;
    try { root = await directory(destRoot); }
    catch (e) { if (e.code === "ENOENT") return []; throw e; }
    const snaps = [];
    for (const name of await fsp.readdir(root)) {
        if (parseSnapshotTime(name) === null) continue;
        const full = path.join(root, name), manifest = await readManifest(full);
        if (manifest && (!opts.workspace || path.resolve(manifest.workspace) === path.resolve(opts.workspace))) {
            snaps.push({ name, path: full, time: parseSnapshotTime(name), complete: true, files: manifest.fileCount, copied: manifest.copied, bytes: manifest.copiedBytes, linked: manifest.linked, note: manifest.note || "", workspace: manifest.workspace });
        }
        if (!manifest && opts.includeIncomplete) {
            const st = await fsp.lstat(full).catch(() => null);
            if (st && st.isDirectory() && !st.isSymbolicLink()) snaps.push({ name, path: full, time: parseSnapshotTime(name), complete: false, files: 0, copied: 0, bytes: 0, linked: 0, note: "" });
        }
    }
    return snaps.sort((a, b) => a.time - b.time || a.name.localeCompare(b.name, undefined, { numeric: true }));
}
async function cleanupIncomplete() { return 0; }
function selectSnapshotsToDelete(snaps, keepCount) {
    const ordered = snaps.slice().sort((a, b) => b.time - a.time || b.name.localeCompare(a.name, undefined, { numeric: true }));
    const limit = Math.max(1, Math.floor(Number(keepCount)) || 30), candidates = ordered.slice(0, 10).map(s => s.name);
    const seen = new Set(ordered.slice(0, 10).map(s => dayString(new Date(s.time))));
    for (const s of ordered.slice(10)) {
        const day = dayString(new Date(s.time));
        if (!seen.has(day)) { seen.add(day); candidates.push(s.name); }
    }
    const keep = new Set(candidates.slice(0, limit));
    return ordered.filter(s => !keep.has(s.name)).map(s => s.name);
}
async function withDestinationLock(destRoot, fn) {
    const root = await directory(destRoot, true), lockPath = path.join(root, LOCK_NAME);
    let handle;
    try { handle = await fsp.open(lockPath, "wx", 0o600); }
    catch (e) { if (e.code === "EEXIST") fail("目标操作锁已存在：" + lockPath, "ELOCKED"); throw e; }
    const owned = await handle.stat();
    try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
        return await fn(root);
    } finally {
        await handle.close();
        // Never remove a replacement lock belonging to somebody else.
        const current = await fsp.lstat(lockPath).catch(() => null);
        if (current && current.ino === owned.ino && current.dev === owned.dev && !current.isSymbolicLink()) await fsp.unlink(lockPath);
    }
}
// Caller holding withDestinationLock may pass { locked: true }; otherwise this
// operation acquires the same lock used by backup/export/retention.
async function removeSnapshot(dir, opts = {}) {
    const remove = async () => {
        await loadVerifiedSnapshot(dir);
        await safePath(dir);
        await fsp.rm(path.resolve(dir), { recursive: true, force: false });
    };
    return opts.locked ? remove() : withDestinationLock(path.dirname(path.resolve(dir)), remove);
}
async function freeBytesOf(dir) {
    try { if (typeof fsp.statfs !== "function") return -1; const st = await fsp.statfs(dir); return st.bavail * st.bsize; }
    catch (_) { return -1; }
}
async function appendLog(destRoot, line) {
    try {
        const logPath = path.join(await directory(destRoot), LOG_NAME);
        if (await exists(logPath)) {
            await safePath(logPath);
            const st = await fsp.lstat(logPath);
            // Logs must never overwrite an inode shared with a source or snapshot.
            if (!st.isFile() || st.nlink !== 1) return;
            if (st.size > LOG_MAX_BYTES) {
                const h = await fsp.open(logPath, fs.constants.O_RDONLY | noFollow);
                let buffer;
                try { buffer = Buffer.alloc(LOG_KEEP_BYTES); const r = await h.read(buffer, 0, buffer.length, Math.max(0, st.size - buffer.length)); buffer = buffer.subarray(0, r.bytesRead); }
                finally { await h.close(); }
                await fsp.unlink(logPath);
                await fsp.writeFile(logPath, buffer, { flag: "wx" });
            }
        }
        const h = await fsp.open(logPath, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | noFollow, 0o600);
        try { await h.writeFile("[" + readable() + "] " + line + "\n"); } finally { await h.close(); }
    } catch (_) { /* Logging is best effort, never the backup's success signal. */ }
}
function mkdirCached(root) {
    const pending = new Map([[root, Promise.resolve()]]);
    return dir => {
        if (pending.has(dir)) return pending.get(dir);
        const task = (async () => {
            if (!isPathInside(dir, root)) fail("输出路径越界");
            await safePath(dir, true); await fsp.mkdir(dir, { recursive: true }); await safePath(dir);
        })();
        pending.set(dir, task);
        return task;
    };
}
async function copyStable(source, target, shouldStop) {
    let last;
    for (let attempt = 0; attempt < 3; attempt++) {
        checkStop(shouldStop);
        let input, output, owned = false;
        try {
            await safePath(source); await safePath(path.dirname(target));
            input = await fsp.open(source, fs.constants.O_RDONLY | noFollow);
            const before = await input.stat();
            if (!before.isFile()) fail("源不是普通文件");
            const free = await freeBytesOf(path.dirname(target));
            if (free >= 0 && free < before.size + 5 * 1024 * 1024) fail("复制文件所需磁盘空间不足", "ENOSPC");
            output = await fsp.open(target, "wx", 0o600); owned = true;
            const hash = crypto.createHash("sha256"), buffer = Buffer.allocUnsafe(256 * 1024);
            let position = 0;
            while (true) {
                checkStop(shouldStop);
                const { bytesRead } = await input.read(buffer, 0, buffer.length, position);
                if (!bytesRead) break;
                hash.update(buffer.subarray(0, bytesRead));
                let written = 0;
                while (written < bytesRead) {
                    const r = await output.write(buffer, written, bytesRead - written, position + written);
                    if (!r.bytesWritten) fail("复制写入未取得进展", "EIO");
                    written += r.bytesWritten;
                }
                position += bytesRead;
            }
            const after = await input.stat(), current = await fsp.lstat(source);
            if (!sameStat(before, after) || !sameStat(after, current) || position !== after.size || current.isSymbolicLink()) fail("复制期间源文件变化：" + source, "ECHANGED");
            await output.utimes(new Date(after.mtimeMs), new Date(after.mtimeMs));
            await output.sync();
            await output.close(); output = null;
            const sha256 = hash.digest("hex");
            if ((await stableHash(target, shouldStop, buffer)).sha256 !== sha256) fail("复制内容校验失败", "EIO");
            return { size: after.size, mtimeMs: after.mtimeMs, sha256, sourceStat: after };
        } catch (e) {
            last = e;
            if (output) { await output.close().catch(() => {}); output = null; }
            if (owned) { await safePath(target); await fsp.unlink(target); }
            if (e.code === "ECANCELED" || e.code === "EEXIST") throw e;
            await breathe();
        } finally { if (input) await input.close(); }
    }
    throw last;
}

async function runSnapshot(opts = {}) {
    const started = Date.now();
    const result = { ok: false, snapshot: "", copied: 0, linked: 0, bytes: 0, files: 0, failed: 0, deleted: 0, ms: 0, failures: [] };
    try {
        if (!opts.workspace || !opts.destRoot || !validSources(opts.sources)) fail("缺少工作空间、备份目录或有效非空源目录列表");
        const workspace = await directory(opts.workspace), candidate = await safePath(opts.destRoot, true);
        if (isPathInside(candidate, workspace) || isPathInside(workspace, candidate)) fail("备份目录与工作空间不能相同或互相位于内部");
        await withDestinationLock(candidate, async destRoot => {
            try {
            checkStop(opts.shouldStop);
            const excludes = opts.excludes || DEFAULT_EXCLUDES;
            if (!Array.isArray(excludes) || !excludes.every(s => typeof s === "string")) fail("无效排除规则");
            const scan = async () => {
                const files = [];
                for (const src of opts.sources) {
                    const root = await directory(path.join(workspace, src));
                    if (!isPathInside(root, workspace)) fail("源路径超出工作空间");
                    files.push(...await scanTree(root, src, excludes, opts.onProgress, { shouldStop: opts.shouldStop, concurrency: opts.scanConcurrency }));
                }
                return files;
            };
            const all = await scan(); result.files = all.length;
            if (!all.length) fail("源文件清单为空，拒绝生成快照或清理历史");
            const totalBytes = all.reduce((n, f) => n + f.size, 0);
            const existing = await listSnapshots(destRoot, { workspace });
            let previous = null;
            for (let i = existing.length - 1; i >= 0 && !previous; i--) {
                try { previous = await loadVerifiedSnapshot(existing[i].path, opts.shouldStop); }
                catch (e) {
                    if (e.code === "ECANCELED") throw e;
                    (result.warnings || (result.warnings = [])).push("跳过损坏基线 " + existing[i].name + "：" + friendlyError(e));
                }
            }
            const free = await freeBytesOf(destRoot);
            const required = (previous ? 0 : totalBytes * 1.15) + 50 * 1024 * 1024;
            if (free >= 0 && free < required) fail("目标磁盘空间不足：" + humanSize(free), "ENOSPC");
            checkStop(opts.shouldStop);
            const base = SNAP_PREFIX + stampOf(); let name = base, seq = 1;
            while (true) {
                try { await fsp.mkdir(path.join(destRoot, name)); break; }
                catch (e) { if (e.code !== "EEXIST") throw e; name = base + "-" + (++seq); }
            }
            const snapDir = path.join(destRoot, name); result.snapshot = snapDir;
            await fsp.writeFile(path.join(snapDir, INCOMPLETE_NAME), JSON.stringify({ plugin: PLUGIN_NAME, startedAt: Date.now(), workspace }), { flag: "wx" });
            const mkdir = mkdirCached(snapDir), entries = [], sourceStats = new Map();
            let linkDisabled = false, completed = 0;
            await mapLimit(all, 4, async file => {
                checkStop(opts.shouldStop);
                const target = path.join(snapDir, file.rel);
                try {
                    await mkdir(path.dirname(target));
                    let entry;
                    if (previous && !linkDisabled && previous.hashes.has(file.rel)) {
                        const source = await stableHash(file.abs, opts.shouldStop);
                        if (source.sha256 === previous.hashes.get(file.rel)) {
                            const oldPath = path.join(previous.path, file.rel), verifiedStat = previous.stats.get(file.rel);
                            await safePath(oldPath);
                            const oldStat = await fsp.lstat(oldPath);
                            if (sameStat(verifiedStat, oldStat) && (source.stat.ino !== oldStat.ino || source.stat.dev !== oldStat.dev)) {
                                try {
                                    await fsp.link(oldPath, target);
                                    const linked = await fsp.lstat(target), currentOld = await fsp.lstat(oldPath);
                                    if (linked.isSymbolicLink() || linked.ino !== oldStat.ino || linked.dev !== oldStat.dev || linked.size !== oldStat.size || linked.mtimeMs !== oldStat.mtimeMs || !sameStat(linked, currentOld) || !sameStat(source.stat, await fsp.lstat(file.abs))) fail("硬链接验证期间文件变化", "ECHANGED");
                                    entry = { size: source.stat.size, mtimeMs: source.stat.mtimeMs, sha256: source.sha256, sourceStat: source.stat };
                                    result.linked++;
                                } catch (e) {
                                    if (await exists(target)) throw e;
                                    if (["EXDEV", "ENOSYS", "EMLINK", "EPERM", "EOPNOTSUPP"].includes(e.code)) linkDisabled = true;
                                    else throw e;
                                }
                            }
                        }
                    }
                    if (!entry) { entry = await copyStable(file.abs, target, opts.shouldStop); result.copied++; result.bytes += entry.size; }
                    entries.push({ rel: file.rel, size: entry.size, mtimeMs: entry.mtimeMs, sha256: entry.sha256 });
                    sourceStats.set(file.rel, entry.sourceStat);
                } catch (e) { result.failed++; result.failures.push(file.rel + " (" + friendlyError(e) + ")"); throw e; }
                completed++;
                if (opts.onProgress) opts.onProgress({ phase: "copy", current: completed, total: all.length });
                if (completed % 150 === 0) await breathe();
            });
            entries.sort((a, b) => a.rel.localeCompare(b.rel));
            // Detect additions/removals or source changes after the initial scan.
            const finalFiles = await scan();
            if (finalFiles.length !== all.length || finalFiles.some(f => !sourceStats.has(f.rel) || !sameStat(f, sourceStats.get(f.rel)))) fail("备份期间源目录发生变化，请重试", "ECHANGED");
            checkStop(opts.shouldStop);
            const manifest = { plugin: PLUGIN_NAME, version: 3, createdAt: Date.now(), workspace, sources: opts.sources.slice(), excludes: excludes.slice(), note: String(opts.note || ""), fileCount: entries.length, totalBytes: entries.reduce((n, e) => n + e.size, 0), copied: result.copied, copiedBytes: result.bytes, linked: result.linked, failed: 0, failures: [], hardlink: !linkDisabled, entries };
            const temporary = path.join(snapDir, MANIFEST_NAME + ".tmp");
            const h = await fsp.open(temporary, "wx", 0o600);
            try { await h.writeFile(JSON.stringify(manifest)); await h.sync(); } finally { await h.close(); }
            checkStop(opts.shouldStop);
            await fsp.rename(temporary, path.join(snapDir, MANIFEST_NAME));
            // Removing the marker is a required publish step; errors must abort retention.
            if (opts.onProgress) opts.onProgress({ phase: "verify" });
            await fsp.unlink(path.join(snapDir, INCOMPLETE_NAME));
            await loadVerifiedSnapshot(snapDir, opts.shouldStop);
            checkStop(opts.shouldStop);
            result.ok = true;
            if (opts.prune !== false) {
                const snapshots = await listSnapshots(destRoot, { workspace });
                for (const name of selectSnapshotsToDelete(snapshots, opts.keepCount)) {
                    if (opts.shouldStop && opts.shouldStop()) break;
                    try {
                        const doomed = path.join(destRoot, name), metadata = await readManifest(doomed);
                        if (!metadata || path.resolve(metadata.workspace) !== workspace || doomed === snapDir) continue;
                        await removeSnapshot(doomed, { locked: true }); result.deleted++;
                    } catch (e) { result.pruneError = friendlyError(e); }
                }
            }
            await appendLog(destRoot, name + " 文件 " + result.files + "，复制 " + result.copied + "，硬链接 " + result.linked + "，清理 " + result.deleted);
            } catch (e) {
                // Invalidate our output BEFORE releasing the root lock, including
                // a failure/cancellation immediately after marker removal.
                if (result.snapshot) {
                    try {
                        await safePath(result.snapshot);
                        await fsp.writeFile(path.join(result.snapshot, INCOMPLETE_NAME), JSON.stringify({ plugin: PLUGIN_NAME, error: friendlyError(e) }), { flag: "wx" });
                    } catch (_) { /* Existing marker already makes it invalid. */ }
                }
                await appendLog(destRoot, "备份失败：" + friendlyError(e));
                throw e;
            }
        });
    } catch (e) {
        result.ok = false; result.error = friendlyError(e);
    }
    result.ms = Date.now() - started;
    return result;
}

async function restoreSnapshot(opts = {}) {
    const started = Date.now(), result = { ok: false, copied: 0, bytes: 0, failed: 0, files: 0, ms: 0, error: "" };
    try {
        if (!opts.snapshotDir || !opts.targetRoot) fail("参数不完整");
        const snapshotDir = await directory(opts.snapshotDir), target = await safePath(opts.targetRoot, true);
        if (isPathInside(target, snapshotDir) || isPathInside(snapshotDir, target)) fail("导出目录和快照不能相同或互相嵌套");
        await withDestinationLock(path.dirname(snapshotDir), async () => {
            const verified = await loadVerifiedSnapshot(snapshotDir, opts.shouldStop);
            result.legacy = verified.manifest.version === 2;
            if (result.legacy) result.warning = "旧版 v2 清单缺少历史内容指纹，不能证明历史内容未被修改";
            let workspace;
            try { workspace = await fsp.realpath(verified.manifest.workspace); }
            catch (e) { if (e.code !== "ENOENT") throw e; workspace = path.resolve(verified.manifest.workspace); }
            if (isPathInside(target, workspace) || isPathInside(workspace, target)) fail("导出目录不能与原工作空间相同或互相嵌套");
            if (isPathInside(target, path.dirname(snapshotDir))) fail("导出目录必须位于备份存储目录之外，避免嵌入其他快照");
            const root = await directory(target, true);
            if ((await fsp.readdir(root)).length) fail("导出只允许空目录，拒绝覆盖现有文件");
            // A second export to this directory sees this lock and is rejected.
            await withDestinationLock(root, async () => {
                const mkdir = mkdirCached(root); result.files = verified.files.length;
                for (let i = 0; i < verified.files.length; i++) {
                    checkStop(opts.shouldStop);
                    const f = verified.files[i], output = path.join(root, f.rel);
                    await mkdir(path.dirname(output));
                    const entry = await copyStable(f.abs, output, opts.shouldStop);
                    if (entry.sha256 !== verified.hashes.get(f.rel)) fail("导出期间快照内容变化：" + f.rel, "ECHANGED");
                    result.copied++; result.bytes += entry.size;
                    if (opts.onProgress) opts.onProgress({ phase: "copy", current: i + 1, total: verified.files.length });
                }
                checkStop(opts.shouldStop);
                // A final read catches an externally modified shared snapshot inode.
                await loadVerifiedSnapshot(snapshotDir, opts.shouldStop);
                result.ok = true;
            });
        });
    } catch (e) { result.ok = false; result.error = friendlyError(e); if (e.code !== "ECANCELED") result.failed++; }
    result.ms = Date.now() - started;
    return result;
}

module.exports = {
    runSnapshot, restoreSnapshot, listSnapshots, selectSnapshotsToDelete, scanTree,
    isExcluded, buildExcludes, humanSize, stampOf, parseSnapshotTime, readManifest,
    cleanupIncomplete, isPathInside, friendlyError, freeBytesOf, DEFAULT_EXCLUDES, SOURCE_DEFS,
    PLUGIN_NAME, SNAP_PREFIX, LOG_NAME, MANIFEST_NAME, INCOMPLETE_NAME, LOCK_NAME,
    LOG_MAX_BYTES, LOG_KEEP_BYTES, pad2, readable, dayString, expandHome, contractHome,
    breathe, appendLog, removeSnapshot, withDestinationLock, verifySnapshot, validateBackupPaths,
};
