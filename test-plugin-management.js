"use strict";
// Regressions for cross-window destination changes and atomic note failures.
const assert = require("assert").strict;
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const Module = require("module");
const core = require("./backup-core");
let lastDialog, confirmation, checks = 0;
const messages = [];
function element() {
    const children = new Map(), events = new Map();
    return { events, value: "", textContent: "", innerHTML: "", style: {},
        querySelector(key) { if (!children.has(key)) children.set(key, element()); return children.get(key); },
        addEventListener(event, fn) { events.set(event, fn); },
        querySelectorAll() { return []; },
        setAttribute() {}, removeAttribute() {},
    };
}
const originalLoad = Module._load;
Module._load = function (name) {
    if (name === "siyuan") return {
        Plugin: class {},
        Dialog: class { constructor() { this.element = element(); lastDialog = this; } destroy() {} },
        showMessage(text) { messages.push(text); },
        confirm(_title, _text, fn) { confirmation = Promise.resolve(fn()); },
    };
    return originalLoad.apply(this, arguments);
};
const Cls = require("./index");
Module._load = originalLoad;
const check = (value, message) => { assert.ok(value, message); checks++; console.log("PASS " + message); };
async function main() {
    const allocated = await fsp.mkdtemp(path.join(os.tmpdir(), "sibk-management-"));
    const tmp = await fsp.realpath(allocated), workspace = path.join(tmp, "workspace"), a = path.join(tmp, "backup-a"), b = path.join(tmp, "backup-b");
    const originalRename = fsp.rename;
    try {
        await fsp.mkdir(path.join(workspace, "data"), { recursive: true });
        await fsp.writeFile(path.join(workspace, "data", "note.sy"), "important fixture note");
        const result = await core.runSnapshot({ workspace, destRoot: a, sources: ["data"], prune: false });
        assert.ok(result.ok, result.error);
        const plugin = new Cls({ i18n: {} });
        // Window chrome is covered separately; these checks isolate real file I/O.
        plugin.createWindow = () => { lastDialog = { element: element(), destroy() {} }; return lastDialog; };
        plugin.settings.destRoot = b;
        await plugin.editSnapshotNote(result.snapshot);
        let dialog = lastDialog;
        dialog.element.querySelector("#sibkNoteInput").value = "new note";
        const save = () => dialog.element.querySelector("#sibkNoteSave").events.get("click")();
        await core.withDestinationLock(a, save);
        check((await core.readManifest(result.snapshot)).note === "", "note edits lock the captured snapshot root even after destination changes");
        check(messages.some(message => message.includes("ELOCKED")), "cross-window note edit reports held original lock");
        await save();
        check((await core.readManifest(result.snapshot)).note === "new note", "note save succeeds once original lock is released");
        await plugin.editSnapshotNote(result.snapshot);
        dialog = lastDialog;
        dialog.element.querySelector("#sibkNoteInput").value = "must not commit";
        fsp.rename = async (from, to) => {
            if (to === path.join(result.snapshot, core.MANIFEST_NAME)) { const e = new Error("injected note rename failure"); e.code = "EACCES"; throw e; }
            return originalRename(from, to);
        };
        await save();
        fsp.rename = originalRename;
        check((await core.verifySnapshot(result.snapshot)).ok, "failed note publication leaves the original snapshot verifiable");
        check((await core.readManifest(result.snapshot)).note === "new note", "failed note publication retains previous manifest");
        check(!(await fsp.readdir(a)).some(name => name.startsWith(".note-")), "failed note publication cleans only its sibling temporary file");
        await save();
        check((await core.readManifest(result.snapshot)).note === "must not commit", "note save can retry after rename failure without EEXIST");
        plugin.settings.destRoot = a;
        await plugin.openSnapshots();
        const snapshotsDialog = lastDialog;
        plugin.settings.destRoot = b;
        const click = action => snapshotsDialog.element.querySelector("tbody").events.get("click")({ target: {
            closest: () => ({ disabled: false, getAttribute: () => action, closest: () => ({ getAttribute: () => path.basename(result.snapshot) }) }),
        } });
        messages.length = 0;
        await core.withDestinationLock(a, () => click("verify"));
        check(messages.some(message => message.includes("ELOCKED")), "verification locks original snapshot root after destination changes");
        messages.length = 0;
        await core.withDestinationLock(a, async () => { await click("del"); await confirmation; });
        check(messages.some(message => message.includes("ELOCKED")) && !!await core.readManifest(result.snapshot), "delete cannot bypass original root lock after destination changes");
        console.log("\n" + checks + " management regression checks passed");
    } finally {
        fsp.rename = originalRename;
        assert.ok(path.basename(tmp).startsWith("sibk-management-"));
        assert.equal(await fsp.realpath(allocated), tmp);
        await fsp.rm(tmp, { recursive: true, force: true });
    }
}
main().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
