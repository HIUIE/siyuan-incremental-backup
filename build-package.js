"use strict";
// SiYuan evaluates plugin entries with its own require. Ship a self-contained
// CommonJS entry instead of relying on relative module or __dirname resolution.
const fs = require("fs");
const path = require("path");
const os = require("os");
const assert = require("assert").strict;
const { execFileSync } = require("child_process");
const root = __dirname;
const metadata = JSON.parse(fs.readFileSync(path.join(root, "plugin.json"), "utf8"));
assert.match(metadata.name, /^[a-z0-9-]+$/);
assert.match(metadata.version, /^\d+\.\d+\.\d+$/);
const out = path.join(root, metadata.name + "-v" + metadata.version + ".zip");
if (fs.existsSync(out)) throw new Error("安装包已存在，请先保留或重命名：" + out);
const stage = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sibk-package-")));
try {
    const core = fs.readFileSync(path.join(root, "backup-core.js"), "utf8");
    const css = fs.readFileSync(path.join(root, "index.css"), "utf8");
    let entry = fs.readFileSync(path.join(root, "index.js"), "utf8");
    const coreImport = 'const core = require("./backup-core");';
    const cssImport = 'const css = fs.readFileSync(path.join(__dirname, "index.css"), "utf8");';
    assert.equal(entry.split(coreImport).length, 2, "Expected one engine import");
    assert.equal(entry.split(cssImport).length, 2, "Expected one stylesheet import");
    entry = entry.replace(coreImport, () => `const core = (() => {\nconst module = { exports: {} };\n${core}\nreturn module.exports;\n})();`);
    entry = entry.replace(cssImport, () => "const css = " + JSON.stringify(css) + ";");
    fs.writeFileSync(path.join(stage, "index.js"), entry);
    const files = ["plugin.json", "index.css", "i18n", "icon.png", "icon.svg", "preview.png", "README.md", "README_zh_CN.md", "CHANGELOG.md", "LICENSE"];
    for (const file of files) fs.cpSync(path.join(root, file), path.join(stage, file), { recursive: true });
    execFileSync(process.execPath, ["--check", path.join(stage, "index.js")], { stdio: "inherit" });
    execFileSync("zip", ["-r", out, "index.js", ...files, "-x", "*.DS_Store"], { cwd: stage, stdio: "inherit" });
    console.log("打包完成（单文件入口，含内嵌核心与样式）：" + out);
} finally {
    // Delete only the exact real directory allocated above, never a caller path.
    assert.ok(path.basename(stage).startsWith("sibk-package-"));
    assert.equal(fs.realpathSync(stage), stage);
    fs.rmSync(stage, { recursive: true, force: true });
}
