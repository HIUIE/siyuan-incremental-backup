"use strict";

// This suite requires only the local engine and creates ALL data below one
// freshly allocated temporary directory. It never loads the plugin or SiYuan.
const assert = require("assert").strict;
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");
const core = require("./backup-core");
let assertions = 0;
function check(value, message) { assert.ok(value, message); assertions++; console.log("PASS " + message); }
async function rejected(fn, message) { let failed = false; try { await fn(); } catch (_) { failed = true; } check(failed, message); }

async function main() {
    const allocated = await fsp.mkdtemp(path.join(os.tmpdir(), "siyuan-backup-safety-"));
    const tmp = await fsp.realpath(allocated);
    const ws = path.join(tmp, "workspace"), dest = path.join(tmp, "backups");
    const write = async (rel, text) => { const p = path.join(ws, rel); await fsp.mkdir(path.dirname(p), { recursive: true }); await fsp.writeFile(p, text); return p; };
    const args = extra => ({ workspace: ws, destRoot: dest, sources: ["data", "conf"], excludes: core.buildExcludes(""), keepCount: 30, ...extra });
    const read = p => fsp.readFile(p, "utf8");
    const names = () => fsp.readdir(dest);
    const present = async p => { try { await fsp.lstat(p); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; } };
    const original = { open: fsp.open, rename: fsp.rename, unlink: fsp.unlink, readdir: fsp.readdir, link: fsp.link, statfs: fsp.statfs };
    try {
        const note = await write("data/notebook/note.sy", "AAAA");
        await write("conf/conf.json", "{} ");
        await write("data/assets/a.bin", Buffer.alloc(1024 * 1024, 7));
        await write("data/temp/skip.tmp", "excluded");
        const a = await core.runSnapshot(args());
        check(a.ok && a.files === 3 && a.copied === 3, "first snapshot copies all included files");
        check(!await present(path.join(a.snapshot, core.INCOMPLETE_NAME)), "published snapshot has no incomplete marker");
        const m = await core.readManifest(a.snapshot);
        check(m && m.version === 3 && m.entries.every(e => /^[0-9a-f]{64}$/.test(e.sha256)), "v3 manifest records SHA256 fingerprints");
        check((await core.verifySnapshot(a.snapshot)).ok, "standalone verification validates published content");
        check(m.entries.every((e, i) => i === 0 || m.entries[i - 1].rel.localeCompare(e.rel) <= 0), "concurrent workers produce a deterministically sorted manifest");
        const progress = [];
        const b = await core.runSnapshot(args({ onProgress: p => { if (p.phase === "copy") progress.push(p.current); } }));
        check(b.ok && b.linked === 3 && b.copied === 0, "unchanged files reuse verified hardlinks");
        check(progress.length === b.files && progress.every((n, i) => n === i + 1), "concurrent progress counts completed files monotonically");
        const ba = await fsp.stat(path.join(a.snapshot, "data/notebook/note.sy"));
        const bb = await fsp.stat(path.join(b.snapshot, "data/notebook/note.sy"));
        check(ba.ino === bb.ino && ba.dev === bb.dev, "unchanged snapshots share an inode");
        const time = await fsp.stat(note);
        await fsp.writeFile(note, "BBBB");
        await fsp.utimes(note, time.atime, time.mtime);
        const c = await core.runSnapshot(args());
        check(c.ok && c.copied === 1 && c.linked === 2, "same size and restored mtime still detect changed bytes");
        check(await read(path.join(c.snapshot, "data/notebook/note.sy")) === "BBBB", "new snapshot contains the changed bytes");
        check(await read(path.join(a.snapshot, "data/notebook/note.sy")) === "AAAA", "old hardlinked version stays intact");

        for (const sources of [[], ["missing"], ["../data"], ["data", "data"], ["/data"]]) {
            check(!(await core.runSnapshot(args({ sources, keepCount: 1 }))).ok, "invalid sources rejected: " + JSON.stringify(sources));
        }
        const missingWs = path.join(tmp, "missing-workspace");
        check(!(await core.runSnapshot(args({ workspace: missingWs }))).ok, "missing workspace fails");
        check(!(await core.runSnapshot(args({ sources: ["repo"] }))).ok, "enabled but absent known source fails");
        await fsp.mkdir(path.join(tmp, "empty-workspace", "data"), { recursive: true });
        check(!(await core.runSnapshot(args({ workspace: path.join(tmp, "empty-workspace"), sources: ["data"] }))).ok, "empty source inventory cannot trigger retention");
        check(!(await core.runSnapshot(args({ destRoot: path.join(ws, "data", "backup") }))).ok, "workspace descendant backup rejected");
        check(!(await core.runSnapshot(args({ destRoot: tmp }))).ok, "workspace ancestor backup rejected");
        check(core.isPathInside("/a/..note", "/a") && !core.isPathInside("/a2", "/a"), "path containment handles dot-prefixed filenames and sibling prefixes");
        check(core.parseSnapshotTime("snap-20260231-010101") === null && core.parseSnapshotTime("snap-20260101-250000") === null, "impossible snapshot dates rejected");

        // Force a same-size, same-mtime edit DURING the actual copy. ctime and
        // identity checks must retry rather than publish the mixed first read.
        const retryWs = path.join(tmp, "retry-workspace"), retryDest = path.join(tmp, "retry-backups");
        await fsp.mkdir(path.join(retryWs, "data"), { recursive: true });
        const moving = path.join(retryWs, "data", "moving.sy");
        await fsp.writeFile(moving, "1111");
        let sourceOpens = 0, changedOnce = false;
        fsp.open = async function (p, ...rest) {
            const h = await original.open.call(this, p, ...rest);
            if (String(p) === moving) {
                sourceOpens++;
                const readOriginal = h.read.bind(h);
                h.read = async (...readArgs) => {
                    const r = await readOriginal(...readArgs);
                    if (!changedOnce && r.bytesRead) {
                        changedOnce = true;
                        const st = await fsp.stat(moving);
                        await fsp.writeFile(moving, "2222"); await fsp.utimes(moving, st.atime, st.mtime);
                    }
                    return r;
                };
            }
            return h;
        };
        const retried = await core.runSnapshot({ workspace: retryWs, destRoot: retryDest, sources: ["data"], prune: false });
        fsp.open = original.open;
        check(retried.ok && sourceOpens >= 2, "copy retries on same-size same-mtime mutation using ctime");
        check(await read(path.join(retried.snapshot, "data/moving.sy")) === "2222", "retry publishes a consistent fresh copy");
        await fsp.writeFile(moving, "3333");
        let mutation = 0;
        fsp.open = async function (p, ...rest) {
            const h = await original.open.call(this, p, ...rest);
            if (String(p) === moving) {
                const readOriginal = h.read.bind(h); let changed = false;
                h.read = async (...readArgs) => {
                    const r = await readOriginal(...readArgs);
                    if (!changed && r.bytesRead) { changed = true; await fsp.writeFile(moving, String(++mutation).padStart(4, "0")); }
                    return r;
                };
            }
            return h;
        };
        const unstable = await core.runSnapshot({ workspace: retryWs, destRoot: path.join(tmp, "unstable-backups"), sources: ["data"] });
        fsp.open = original.open;
        check(!unstable.ok && mutation === 3 && unstable.deleted === 0, "persistently changing source exhausts bounded retries and fails");
        const simultaneous = await Promise.all([core.runSnapshot(args({ prune: false })), core.runSnapshot(args({ prune: false }))]);
        check(simultaneous.filter(r => r.ok).length === 1 && simultaneous.some(r => /ELOCKED/.test(r.error || "")), "truly concurrent backups admit exactly one writer");
        fsp.link = async () => { const e = new Error("unsupported links"); e.code = "EXDEV"; throw e; };
        const fallback = await core.runSnapshot(args({ prune: false }));
        fsp.link = original.link;
        check(fallback.ok && fallback.copied === fallback.files && fallback.linked === 0, "unsupported hardlinks safely fall back to independent copies");

        const spaceWs = path.join(tmp, "space-workspace"), spaceDest = path.join(tmp, "space-backups");
        await fsp.mkdir(path.join(spaceWs, "data"), { recursive: true });
        const sparse = await fsp.open(path.join(spaceWs, "data", "large.bin"), "wx");
        await sparse.truncate(16 * 1024 * 1024); await sparse.close();
        const spaceBase = await core.runSnapshot({ workspace: spaceWs, destRoot: spaceDest, sources: ["data"], prune: false });
        check(spaceBase.ok, "space test establishes an isolated sparse-file baseline");
        fsp.statfs = async () => ({ bavail: 55 * 1024 * 1024, bsize: 1 });
        const lowSpaceIncremental = await core.runSnapshot({ workspace: spaceWs, destRoot: spaceDest, sources: ["data"], prune: false });
        fsp.statfs = original.statfs;
        check(lowSpaceIncremental.ok && lowSpaceIncremental.linked === 1, "incremental hardlinks work with less free space than a full-copy estimate");

        // Three already-started writers wait in fsync while the fourth fails.
        // A fail-fast Promise.all would return/unlock before these writers finish.
        const drainWs = path.join(tmp, "drain-workspace"), drainDest = path.join(tmp, "drain-backups");
        await fsp.mkdir(path.join(drainWs, "data"), { recursive: true });
        for (let i = 0; i < 12; i++) await fsp.writeFile(path.join(drainWs, "data", String(i).padStart(2, "0") + ".sy"), "drain " + i);
        let releaseSlow, notifySlow, notifyFailure;
        const slowGate = new Promise(r => { releaseSlow = r; });
        const allSlowStarted = new Promise(r => { notifySlow = r; });
        const failureInjected = new Promise(r => { notifyFailure = r; });
        let slowStarted = 0, activeWriters = 0, writes = 0, failureAttempts = 0, returned = false;
        const openedSources = new Set();
        fsp.open = async function (p, ...rest) {
            const filename = String(p);
            if (filename.startsWith(drainWs + path.sep)) {
                openedSources.add(path.basename(filename));
                if (filename.endsWith("00.sy")) {
                    failureAttempts++;
                    if (failureAttempts === 3) { await allSlowStarted; notifyFailure(); }
                    const e = new Error("injected concurrent copy failure"); e.code = "EIO"; throw e;
                }
            }
            const h = await original.open.call(this, p, ...rest);
            if (filename.startsWith(drainDest + path.sep) && rest[0] === "wx" && /0[1-3]\.sy$/.test(filename)) {
                activeWriters++;
                const sync = h.sync.bind(h), close = h.close.bind(h), writeChunk = h.write.bind(h);
                h.write = async (...a) => { writes++; return writeChunk(...a); };
                h.sync = async () => { if (++slowStarted === 3) notifySlow(); await slowGate; return sync(); };
                h.close = async () => { try { return await close(); } finally { activeWriters--; } };
            }
            return h;
        };
        const drainRun = core.runSnapshot({ workspace: drainWs, destRoot: drainDest, sources: ["data"], prune: false }).then(r => { returned = true; return r; });
        let drained;
        try {
            await failureInjected;
            for (let i = 0; i < 3; i++) await new Promise(setImmediate);
            check(!returned && activeWriters === 3, "concurrent failure waits for every already-started writer");
            check(await present(path.join(drainDest, core.LOCK_NAME)), "destination lock remains held while failed operation drains");
            const whileDraining = await core.runSnapshot({ workspace: drainWs, destRoot: drainDest, sources: ["data"] });
            check(!whileDraining.ok && /ELOCKED/.test(whileDraining.error), "another backup cannot enter during failure drain");
        } finally { releaseSlow(); drained = await drainRun; fsp.open = original.open; }
        check(!drained.ok && activeWriters === 0 && openedSources.size === 4, "failure stops dispatch and returns only after active writers close");
        const writesAtReturn = writes;
        for (let i = 0; i < 3; i++) await new Promise(setImmediate);
        check(writes === writesAtReturn && !await present(path.join(drainDest, core.LOCK_NAME)), "no delayed writes occur after failure returns and releases lock");
        check(await core.readManifest(drained.snapshot) === null, "drained failure output cannot publish a valid manifest");

        const completeBeforeUnknown = (await core.listSnapshots(dest)).length;
        const unknown = path.join(dest, "snap-personal-documents"), corrupt = path.join(dest, "snap-20200101-000000");
        await fsp.mkdir(unknown); await fsp.writeFile(path.join(unknown, "precious"), "keep");
        await fsp.mkdir(corrupt); await fsp.writeFile(path.join(corrupt, core.MANIFEST_NAME), "{}");
        const partial = path.join(dest, "snap-20200102-000000");
        await fsp.mkdir(partial); await fsp.writeFile(path.join(partial, core.INCOMPLETE_NAME), "{}");
        check(await core.cleanupIncomplete(dest) === 0, "startup cleanup conservatively removes nothing");
        const listed = await core.listSnapshots(dest, { includeIncomplete: true });
        check(listed.length === completeBeforeUnknown + 2 && listed.filter(s => s.complete).length === completeBeforeUnknown && listed.filter(s => !s.complete).length === 2, "strictly named corrupt/incomplete directories are visible only as non-actionable incomplete entries");
        await rejected(() => core.removeSnapshot(unknown), "manual delete rejects arbitrary snap-prefixed directory");
        await rejected(() => core.removeSnapshot(corrupt), "manual delete rejects invalid manifest");
        await fsp.writeFile(path.join(c.snapshot, core.INCOMPLETE_NAME), "{}");
        check(await core.readManifest(c.snapshot) === null, "manifest with incomplete marker is invalid");
        await fsp.unlink(path.join(c.snapshot, core.INCOMPLETE_NAME));

        // Listing must not open note contents: settings/UI can read metadata cheaply.
        fsp.open = async function (p, ...rest) { if (String(p).startsWith(dest + path.sep) && !String(p).endsWith(core.MANIFEST_NAME)) throw new Error("unexpected content read during listing"); return original.open.call(this, p, ...rest); };
        check((await core.listSnapshots(dest)).length === completeBeforeUnknown, "listing never opens snapshot content files");
        fsp.open = original.open;

        const beforeFailure = (await core.listSnapshots(dest)).map(s => s.path);
        const assertHistory = async title => check((await Promise.all(beforeFailure.map(p => present(p)))).every(Boolean), title);
        fsp.readdir = async function (p, ...rest) { if (String(p) === path.join(ws, "data")) { const e = new Error("injected EACCES"); e.code = "EACCES"; throw e; } return original.readdir.call(this, p, ...rest); };
        const scanFailure = await core.runSnapshot(args({ keepCount: 1 }));
        fsp.readdir = original.readdir;
        check(!scanFailure.ok && /EACCES/.test(scanFailure.error), "scan permission failure is explicit");
        check(/备份失败：.*EACCES/.test(await read(path.join(dest, core.LOG_NAME))), "scan failure is recorded in the destination log");
        await assertHistory("scan failure does not prune history");
        await write("data/notebook/new.sy", "new file needing copy");
        fsp.open = async function (p, ...rest) { if (String(p).startsWith(ws + path.sep) && String(p).endsWith("new.sy")) { const e = new Error("injected copy read error"); e.code = "EIO"; throw e; } return original.open.call(this, p, ...rest); };
        const copyFailure = await core.runSnapshot(args({ keepCount: 1 }));
        fsp.open = original.open;
        check(!copyFailure.ok && copyFailure.failed > 0 && copyFailure.deleted === 0, "copy failure is not a successful snapshot");
        check(await core.readManifest(copyFailure.snapshot) === null, "failed file snapshot cannot become a link baseline");
        await assertHistory("copy failure does not prune history");
        fsp.rename = async function (from, to) { if (String(to).endsWith(core.MANIFEST_NAME)) { const e = new Error("injected manifest rename failure"); e.code = "EIO"; throw e; } return original.rename.call(this, from, to); };
        const manifestFailure = await core.runSnapshot(args({ keepCount: 1 }));
        fsp.rename = original.rename;
        check(!manifestFailure.ok && manifestFailure.deleted === 0, "atomic manifest publication failure aborts retention");
        check(await present(path.join(manifestFailure.snapshot, core.INCOMPLETE_NAME)), "manifest failure keeps incomplete marker");
        await assertHistory("manifest failure preserves old snapshots");
        fsp.unlink = async function (p, ...rest) { if (String(p).endsWith(core.INCOMPLETE_NAME)) { const e = new Error("injected marker unlink failure"); e.code = "EIO"; throw e; } return original.unlink.call(this, p, ...rest); };
        const markerFailure = await core.runSnapshot(args({ keepCount: 1 }));
        fsp.unlink = original.unlink;
        check(!markerFailure.ok && markerFailure.deleted === 0, "incomplete marker removal is mandatory for success");
        check(await core.readManifest(markerFailure.snapshot) === null, "marker removal failure is never listed as complete");
        await assertHistory("marker removal failure preserves old snapshots");
        let publishCancel = false;
        fsp.unlink = async function (p, ...rest) { const r = await original.unlink.call(this, p, ...rest); if (String(p).endsWith(core.INCOMPLETE_NAME)) publishCancel = true; return r; };
        const afterPublishCancel = await core.runSnapshot(args({ keepCount: 1, shouldStop: () => publishCancel }));
        fsp.unlink = original.unlink;
        check(!afterPublishCancel.ok && afterPublishCancel.deleted === 0, "cancellation after marker removal still prevents pruning");
        check(await core.readManifest(afterPublishCancel.snapshot) === null, "post-publication cancellation reinstates incomplete marker under lock");
        await assertHistory("post-publication cancellation preserves old snapshots");
        let cancel = false;
        const canceled = await core.runSnapshot(args({ keepCount: 1, shouldStop: () => cancel, onProgress: p => { if (p.phase === "copy") cancel = true; } }));
        check(!canceled.ok && /已取消/.test(canceled.error) && canceled.deleted === 0, "mid-copy cancellation returns failure without pruning");
        check(await core.readManifest(canceled.snapshot) === null, "canceled snapshot remains invalid");
        await assertHistory("cancellation preserves history");
        const preCanceled = await core.runSnapshot(args({ shouldStop: () => true }));
        check(!preCanceled.ok && !preCanceled.snapshot, "pre-cancellation creates no snapshot");
        const noPrune = await core.runSnapshot(args({ prune: false, keepCount: 1 }));
        check(noPrune.ok && noPrune.deleted === 0, "prune=false disables retention explicitly");
        await assertHistory("prune=false preserves all old snapshots");

        let unlock, entered;
        const gate = new Promise(r => { unlock = r; });
        const inside = new Promise(r => { entered = r; });
        const held = core.withDestinationLock(dest, async () => { entered(); await gate; });
        await inside;
        const busy = await core.runSnapshot(args({ keepCount: 1 }));
        check(!busy.ok && /ELOCKED/.test(busy.error), "same-destination backup cannot run under held lock");
        const busyExport = await core.restoreSnapshot({ snapshotDir: a.snapshot, targetRoot: path.join(tmp, "busy-export") });
        check(!busyExport.ok && /ELOCKED/.test(busyExport.error), "export coordinates with snapshot root lock");
        await rejected(() => core.removeSnapshot(a.snapshot), "manual delete coordinates with backup lock");
        unlock(); await held;
        check(!await present(path.join(dest, core.LOCK_NAME)), "owned lock is released");
        await fsp.writeFile(path.join(dest, core.LOCK_NAME), "stale lock");
        check(!(await core.runSnapshot(args())).ok, "stale lock is never automatically stolen");
        check(await read(path.join(dest, core.LOCK_NAME)) === "stale lock", "foreign lock remains untouched");
        await fsp.unlink(path.join(dest, core.LOCK_NAME));

        const foreignWs = path.join(tmp, "other-workspace");
        await fsp.mkdir(path.join(foreignWs, "data"), { recursive: true });
        await fsp.writeFile(path.join(foreignWs, "data", "foreign.sy"), "foreign");
        const foreign = await core.runSnapshot(args({ workspace: foreignWs, sources: ["data"], prune: false }));
        check(foreign.ok && foreign.linked === 0, "different workspace never reuses previous snapshots");
        const pruned = await core.runSnapshot(args({ keepCount: 1 }));
        check(pruned.ok && pruned.deleted > 0, "successful snapshot can apply compatible retention policy");
        check(await present(foreign.snapshot), "retention never deletes a different workspace snapshot");
        check(await present(unknown) && await present(corrupt) && await present(partial), "retention preserves unknown and damaged history");
        check(await present(copyFailure.snapshot) && await present(canceled.snapshot), "retention preserves failed and canceled outputs for diagnosis");

        const exported = path.join(tmp, "export");
        const exportedResult = await core.restoreSnapshot({ snapshotDir: pruned.snapshot, targetRoot: exported });
        check(exportedResult.ok && exportedResult.copied === pruned.files, "verified snapshot exports to absent directory");
        check(await read(path.join(exported, "data/notebook/note.sy")) === "BBBB", "exported note matches snapshot");
        const sourceInode = await fsp.stat(path.join(pruned.snapshot, "data/notebook/note.sy"));
        const exportInode = await fsp.stat(path.join(exported, "data/notebook/note.sy"));
        check(sourceInode.ino !== exportInode.ino || sourceInode.dev !== exportInode.dev, "export uses independent copies, never hardlinks");
        await fsp.writeFile(path.join(exported, "data/notebook/note.sy"), "export edited");
        check(await read(path.join(pruned.snapshot, "data/notebook/note.sy")) === "BBBB", "editing exported data cannot corrupt shared snapshot inode");
        check(!(await core.restoreSnapshot({ snapshotDir: pruned.snapshot, targetRoot: exported })).ok, "nonempty export directory is rejected");
        check(!(await core.restoreSnapshot({ snapshotDir: pruned.snapshot, targetRoot: ws })).ok, "source workspace overwrite is rejected");
        check(!(await core.restoreSnapshot({ snapshotDir: pruned.snapshot, targetRoot: path.join(ws, "empty-export") })).ok, "export inside source workspace is rejected");
        check(!(await core.restoreSnapshot({ snapshotDir: pruned.snapshot, targetRoot: pruned.snapshot })).ok, "export over same snapshot rejected");
        check(!(await core.restoreSnapshot({ snapshotDir: pruned.snapshot, targetRoot: path.join(pruned.snapshot, "nested") })).ok, "export nested in snapshot rejected");
        check(!(await core.restoreSnapshot({ snapshotDir: pruned.snapshot, targetRoot: dest })).ok, "export ancestor of snapshot rejected");
        check(!(await core.restoreSnapshot({ snapshotDir: pruned.snapshot, targetRoot: path.join(foreign.snapshot, "empty-nested") })).ok, "export cannot nest inside a different snapshot");
        const existingEmpty = path.join(tmp, "existing-empty"); await fsp.mkdir(existingEmpty);
        check((await core.restoreSnapshot({ snapshotDir: pruned.snapshot, targetRoot: existingEmpty })).ok, "existing empty export directory supported");
        let exportCancel = false;
        const canceledExport = await core.restoreSnapshot({ snapshotDir: pruned.snapshot, targetRoot: path.join(tmp, "cancel-export"), shouldStop: () => exportCancel, onProgress: () => { exportCancel = true; } });
        check(!canceledExport.ok && /已取消/.test(canceledExport.error), "export cancellation reports failure");

        const symlink = path.join(ws, "data", "link.sy");
        await fsp.symlink(note, symlink);
        const symlinkResult = await core.runSnapshot(args({ keepCount: 1 }));
        check(!symlinkResult.ok && /符号链接/.test(symlinkResult.error), "source symlink is an explicit scan error");
        await fsp.unlink(symlink);
        const directoryLink = path.join(tmp, "workspace-link"); await fsp.symlink(ws, directoryLink, "dir");
        check(!(await core.runSnapshot(args({ workspace: directoryLink }))).ok, "workspace symlink rejected");
        const destLink = path.join(tmp, "dest-link"); await fsp.symlink(dest, destLink, "dir");
        check(!(await core.runSnapshot(args({ destRoot: path.join(destLink, "nested") }))).ok, "symlink ancestor cannot disguise recursive backup path");
        const exportLink = path.join(tmp, "export-link"); await fsp.symlink(existingEmpty, exportLink, "dir");
        check(!(await core.restoreSnapshot({ snapshotDir: pruned.snapshot, targetRoot: path.join(exportLink, "new") })).ok, "export rejects symlink ancestors");
        const dataFile = path.join(pruned.snapshot, "data/notebook/note.sy");
        await fsp.writeFile(dataFile, "CCCC");
        check(!(await core.verifySnapshot(pruned.snapshot)).ok, "same-size damaged snapshot fails SHA256 verification");
        check((await core.readManifest(pruned.snapshot)).version === 3, "lightweight readManifest reports valid submission metadata without hashing content");
        check(!(await core.restoreSnapshot({ snapshotDir: pruned.snapshot, targetRoot: path.join(tmp, "bad-export") })).ok, "corrupt content cannot be exported as valid snapshot");
        await rejected(() => core.removeSnapshot(pruned.snapshot), "damaged history is not automatically or manually deleted by owned-snapshot API");
        const afterDamagedBaseline = await core.runSnapshot(args({ keepCount: 1 }));
        check(afterDamagedBaseline.ok && afterDamagedBaseline.warnings && afterDamagedBaseline.warnings.length, "damaged latest baseline is skipped with warning so a fresh backup can still succeed");
        check(await present(pruned.snapshot), "successful retention still preserves physically damaged history");
        await fsp.writeFile(dataFile, "BBBB");
        await fsp.unlink(dataFile); await fsp.symlink(note, dataFile);
        check(!(await core.verifySnapshot(pruned.snapshot)).ok, "snapshot symlink fails verification");
        await fsp.unlink(dataFile); await fsp.writeFile(dataFile, "BBBB");

        const v2 = path.join(dest, "snap-20200103-000000");
        await fsp.mkdir(path.join(v2, "data"), { recursive: true });
        await fsp.writeFile(path.join(v2, "data", "legacy.sy"), "old");
        const oldManifest = { plugin: core.PLUGIN_NAME, version: 2, workspace: ws, sources: ["data"], excludes: [], createdAt: Date.now(), fileCount: 1, totalBytes: 3, copied: 1, copiedBytes: 3, linked: 0, failed: 0, failures: [] };
        await fsp.writeFile(path.join(v2, core.MANIFEST_NAME), JSON.stringify(oldManifest));
        const legacy = await core.verifySnapshot(v2);
        check(legacy.ok && legacy.legacy && /缺少/.test(legacy.warning), "v2 compatibility explicitly discloses missing historical fingerprints");
        check((await core.restoreSnapshot({ snapshotDir: v2, targetRoot: path.join(tmp, "legacy-export") })).ok, "valid v2 snapshot still exports");
        await fsp.writeFile(path.join(v2, core.MANIFEST_NAME), JSON.stringify({ ...oldManifest, workspace: directoryLink }));
        check(!(await core.restoreSnapshot({ snapshotDir: v2, targetRoot: path.join(ws, "legacy-alias-export") })).ok, "legacy workspace aliases resolve canonically before export containment check");
        await fsp.writeFile(path.join(v2, core.MANIFEST_NAME), JSON.stringify({ ...oldManifest, failed: 1 }));
        check(await core.readManifest(v2) === null, "legacy failed>0 snapshots are invalid");
        await fsp.writeFile(path.join(v2, core.MANIFEST_NAME), JSON.stringify({ ...oldManifest, fileCount: 2 }));
        check(!(await core.verifySnapshot(v2)).ok, "legacy file count mismatch is invalid");
        const valid = await core.readManifest(pruned.snapshot);
        const manifestFile = path.join(pruned.snapshot, core.MANIFEST_NAME);
        await fsp.writeFile(manifestFile, JSON.stringify({ ...valid, entries: valid.entries.map((e, i) => i ? e : { ...e, rel: "../escape" }) }));
        check(!(await core.verifySnapshot(pruned.snapshot)).ok, "manifest path traversal rejected");
        await fsp.writeFile(manifestFile, JSON.stringify(valid));
        await fsp.writeFile(path.join(pruned.snapshot, "data", "unexpected.sy"), "unexpected");
        check(!(await core.verifySnapshot(pruned.snapshot)).ok, "unlisted extra files invalidate snapshot");
        check(core.selectSnapshotsToDelete(Array.from({ length: 12 }, (_, i) => ({ name: "snap-20260101-1200" + String(i).padStart(2, "0"), time: new Date(2026, 0, 1, 12, 0, i).getTime() })), 30).length === 2, "same-day retention keeps newest ten by default");
        check((await names()).includes("snap-personal-documents"), "unowned data survived every operation");
        console.log("\n" + assertions + " isolated safety checks passed");
    } finally {
        Object.assign(fsp, original);
        // The deletion target is the exact realpath of our freshly allocated
        // unique temporary directory, never an input workspace or real SiYuan path.
        assert.equal(path.basename(tmp).startsWith("siyuan-backup-safety-"), true);
        assert.equal(await fsp.realpath(allocated), tmp);
        await fsp.rm(tmp, { recursive: true, force: true });
    }
}
main().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
