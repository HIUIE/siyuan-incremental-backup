"use strict";
// Reproducible synthetic workload. Never points at a real SiYuan workspace.
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const vm = require("vm");
const assert = require("assert").strict;
const { execFileSync } = require("child_process");
const current = require("./backup-core");
const baselineCode = execFileSync("git", ["show", "v1.1.1:index.js"], { cwd: __dirname, encoding: "utf8" });
const sandbox = { require: name => name === "siyuan" ? { Plugin: class {} } : require(name), module: { exports: {} }, console, setImmediate, setTimeout, Buffer, process };
vm.runInNewContext(baselineCode, sandbox, { filename: "baseline-index.js" });
const baseline = sandbox.module.exports.__internals;
const median = values => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
async function measure(fn, rounds = 3) {
    const values = [];
    for (let i = 0; i < rounds; i++) { const started = performance.now(); await fn(); values.push(performance.now() - started); }
    return Math.round(median(values) * 10) / 10;
}
async function main() {
    const allocated = await fsp.mkdtemp(path.join(os.tmpdir(), "sibk-benchmark-"));
    const tmp = await fsp.realpath(allocated);
    const workspace = path.join(tmp, "workspace");
    try {
        for (let d = 0; d < 12; d++) {
            const dir = path.join(workspace, "data", "notebook-" + d);
            await fsp.mkdir(dir, { recursive: true });
            await Promise.all(Array.from({ length: 100 }, (_, n) => fsp.writeFile(path.join(dir, "note-" + n + ".sy"), JSON.stringify({ id: n, content: "synthetic note ".repeat(80) }))));
        }
        await fsp.mkdir(path.join(workspace, "data", "assets"));
        for (let n = 0; n < 8; n++) await fsp.writeFile(path.join(workspace, "data", "assets", n + ".bin"), Buffer.alloc(1024 * 1024, n));
        await fsp.mkdir(path.join(workspace, "conf"));
        await fsp.writeFile(path.join(workspace, "conf", "conf.json"), "{}");
        const rows = [];
        for (const [name, core] of [["1.1.1", baseline], [require("./plugin.json").version, current]]) {
            const destRoot = path.join(tmp, "backup-" + name);
            const opts = { workspace, destRoot, sources: ["data", "conf"], excludes: core.buildExcludes(""), keepCount: 30, prune: false };
            const scanMs = await measure(() => core.scanTree(path.join(workspace, "data"), "data", opts.excludes));
            let first;
            const fullMs = await measure(async () => { first = await core.runSnapshot(opts); assert.ok(first.ok, first.error); }, 1);
            const incrementalMs = await measure(async () => { const r = await core.runSnapshot(opts); assert.ok(r.ok, r.error); assert.equal(r.copied, 0); });
            // Old settings enumerated every historical file and deduplicated inodes;
            // current settings reads manifests only. Compare the actual two paths.
            const settingsMs = await measure(async () => {
                await core.listSnapshots(destRoot);
                if (name === "1.1.1") {
                    const seen = new Set(); let bytes = 0;
                    async function walk(dir) {
                        for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
                            const target = path.join(dir, ent.name), st = await fsp.lstat(target);
                            if (st.isDirectory()) { await walk(target); continue; }
                            const key = st.dev + ":" + st.ino;
                            if (!seen.has(key)) { seen.add(key); bytes += st.size; }
                        }
                    }
                    await walk(destRoot);
                    assert.ok(bytes > 0);
                }
            });
            rows.push({ version: name, files: first.files, scanMs, fullMs, incrementalMs, settingsMs });
        }
        const report = { generatedAt: new Date().toISOString(), node: process.version, platform: process.platform, workload: "1200 small notes, 8 x 1MiB assets, 1 config file; four snapshots; warm filesystem; median of 3 except initial full backup", rows, note: "The current engine scans for source changes and reads SHA-256 content before reuse and publication. Backup timing is not equivalent integrity work. Settings benchmark excludes DOM rendering and the original traversal was reproduced from duOf." };
        console.log(JSON.stringify(report, null, 2));
        await fsp.mkdir(path.join(__dirname, "artifacts"), { recursive: true });
        await fsp.writeFile(path.join(__dirname, "artifacts", "benchmark.json"), JSON.stringify(report, null, 2) + "\n");
    } finally {
        assert.ok(path.basename(tmp).startsWith("sibk-benchmark-"));
        assert.equal(await fsp.realpath(allocated), tmp);
        await fsp.rm(tmp, { recursive: true, force: true });
    }
}
main().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
