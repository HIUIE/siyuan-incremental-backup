"use strict";
// Exercise the packaged entry from an unrelated virtual location, so a missing
// relative dependency or embedded stylesheet cannot hide behind the source tree.
const assert = require("assert").strict;
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const Module = require("module");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const metadata = require("./plugin.json");
const archive = path.join(__dirname, metadata.name + "-v" + metadata.version + ".zip");
let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; console.log("PASS " + message); };
async function main() {
    execFileSync("unzip", ["-t", archive], { stdio: "pipe" });
    check(true, "archive CRC validation passes");
    const entries = execFileSync("unzip", ["-Z1", archive], { encoding: "utf8" }).trim().split("\n");
    check(["index.js", "index.css", "plugin.json", "i18n/zh_CN.json", "i18n/en_US.json", "CHANGELOG.md"].every(file => entries.includes(file)), "required plugin files are at archive root");
    check(!entries.some(name => name.startsWith("/") || name.split("/").includes("..") || name.endsWith(".zip")), "archive has no path traversal or nested old packages");
    const source = execFileSync("unzip", ["-p", archive, "index.js"], { encoding: "utf8" });
    check(!source.includes('require("./backup-core")') && !source.includes("__dirname") && source.includes('const PLUGIN_VERSION = "' + metadata.version + '";'), "packed entry is self-contained and its visible version matches metadata");
    const originalLoad = Module._load;
    Module._load = function (name) { if (name === "siyuan") return { Plugin: class {} }; return originalLoad.apply(this, arguments); };
    const packed = new Module(path.join(os.tmpdir(), "unrelated-packed-plugin.js"), module);
    packed.filename = packed.id;
    packed.paths = module.paths;
    try { packed._compile(source, packed.filename); } finally { Module._load = originalLoad; }
    const Plugin = packed.exports, core = Plugin.__internals;
    check(typeof core.runSnapshot === "function" && typeof core.verifySnapshot === "function", "packaged entry exposes the bundled engine");
    let style;
    global.document = { createElement: () => ({}), head: { appendChild: value => { style = value.textContent; } } };
    new Plugin({}).addStyle();
    delete global.document;
    check(style === fs.readFileSync(path.join(__dirname, "index.css"), "utf8"), "packaged style injection exactly matches source stylesheet");
    const allocated = await fsp.mkdtemp(path.join(os.tmpdir(), "sibk-package-test-"));
    const tmp = await fsp.realpath(allocated);
    try {
        const workspace = path.join(tmp, "workspace"), destRoot = path.join(tmp, "backup");
        await fsp.mkdir(path.join(workspace, "data"), { recursive: true });
        await fsp.writeFile(path.join(workspace, "data", "note.sy"), "packaged engine test");
        const first = await core.runSnapshot({ workspace, destRoot, sources: ["data"], prune: false });
        check(first.ok && first.copied === 1, "packaged engine creates a full backup using isolated files");
        const second = await core.runSnapshot({ workspace, destRoot, sources: ["data"], prune: false });
        check(second.ok && second.linked === 1, "packaged engine reuses verified hardlinks");
        check((await core.verifySnapshot(second.snapshot)).ok, "packaged snapshot passes content verification");
        const target = path.join(tmp, "export");
        const exported = await core.restoreSnapshot({ snapshotDir: second.snapshot, targetRoot: target });
        check(exported.ok && await fsp.readFile(path.join(target, "data", "note.sy"), "utf8") === "packaged engine test", "packaged engine exports exact independent content");
    } finally {
        assert.ok(path.basename(tmp).startsWith("sibk-package-test-"));
        assert.equal(await fsp.realpath(allocated), tmp);
        await fsp.rm(tmp, { recursive: true, force: true });
    }
    const hash = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
    const checksum = hash + "  " + path.basename(archive) + "\n";
    fs.writeFileSync(path.join(__dirname, "artifacts", "package.sha256"), checksum);
    fs.writeFileSync(path.join(__dirname, "artifacts", "package-" + metadata.version + ".sha256"), checksum);
    console.log("\n" + checks + " packaged-entry checks passed\nSHA256 " + hash);
}
main().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
