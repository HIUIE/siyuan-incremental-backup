# Incremental Backup 1.3.2 / 本地增量备份

See the [version-by-version changelog](CHANGELOG.md) for individual changes and release status (Chinese).

Local directory snapshots for SiYuan desktop. Each completed snapshot contains the selected files. Unchanged content is hard-linked between snapshots; workspace files are always independent copies.

## Icon and feedback in 1.3.2

The toolbar now uses a drive with a history arrow. Running backups show a dot; failures and notices keep an exclamation badge with details in the accessible label. Snapshots can be searched by date, name or note. Successful results include available copy/reuse counts and duration.

## Stable window in 1.3.1

All pages now share one fixed-size dialog. Back sits at the top left; minimize and close sit at the top right. Back preserves the original view and draft. Minimize releases the modal host and shows a restore bar without canceling background tasks.

## New workbench in 1.3.0

Click the top-bar backup icon to open the versioned workbench. Overview shows recent results and snapshots; Schedule and Scope keep settings in separate tabs without losing unsaved input. Arrow keys, Home and End navigate tabs. Right-click retains quick actions. The plugin settings entry and a new command also open the workbench.

Re-enable the plugin or restart SiYuan after installation. Confirm the title shows v1.3.2. Marketplace cards and the plugin's internal workbench are separate surfaces. This version preserves the 1.2.0 backup engine.

## Backup safety introduced in 1.2.0

- v3 manifests record a SHA-256 fingerprint for each file. Reuse is based on actual content rather than size and modification time alone.
- Read/copy errors, cancellation, changing sources and publication errors are failures. They do not trigger retention.
- A destination lock coordinates backup, export, notes and deletion. Files are flushed before publication; the new snapshot is verified before retention.
- Bounded directory scanning and file processing, directory creation caching, and manifest-only settings statistics reduce unnecessary I/O.
- Theme-aware settings, visible results/progress/cancellation, snapshot verification, and a recovery guide.
- **Automatic pruning is off by default, including upgrades.** Enable it explicitly in advanced settings.
- **Recovery exports verified independent copies.** Live overwrite of a running workspace has been removed.

## Usage

Open the top-bar backup menu → Settings. Confirm the workspace, destination, schedule and scope, then choose **Save and back up**. Default scope is `data` and `conf`. An enabled but missing source is an error.

The default schedule is every 60 minutes after 2 idle minutes. Scheduled backups and daily first-launch backups have separate switches. Daily success is recorded only after a successful backup.

Settings only reads manifests. A listed completed snapshot has valid submission metadata; use **Verify** to check actual files. Verification checks paths, counts, bytes and v3 fingerprints. Legacy v2 snapshots can be exported but have no historical fingerprints: only their structure and aggregate sizes can be checked. That limitation is shown in the UI.

“Written” is bytes copied when a snapshot was created, not current total physical usage. Never edit snapshot files directly: they may share inodes with other historical versions. Export first.

## Recovery

1. Verify a snapshot, then select Restore and choose an export location outside both the workspace and backup root. The plugin creates a new folder; nonempty destinations are rejected.
2. Inspect the exported notes/assets and confirm export succeeded.
3. Completely quit SiYuan. Move the current corresponding workspace folders to a safe place as a fallback, then replace them with the exported folders.
4. Reopen SiYuan and check the results. Keep the original folders until satisfied.

Export does not alter the workspace. Restoring historical directories omits files added afterwards, so keep the current directories as a fallback.

## Retention and failure handling

With pruning disabled, all history stays and disk usage must be monitored. When enabled, pruning runs only after successful verified backup and only for the same workspace. It prefers the newest 10 snapshots, then one per earlier day, subject to the configured maximum. A limit of 5 keeps only the newest 5. Notes do not pin snapshots.

Unknown, corrupt and incomplete history is preserved. Failed output keeps an `_incomplete` marker for diagnosis; startup does not delete it. Snapshot management exposes incomplete entries for inspection, without enabling restore or delete.

A crash may leave `.backup.lock`. Completely quit every SiYuan instance/process using that destination before inspecting and manually removing a stale lock. Never delete an active lock.

## Limits

- Use real paths; symbolic links in source, destination or ancestor paths are rejected.
- Unsupported hard links fall back to independent copies and may use a full snapshot's space. Different source/backup disks alone do not prevent links between snapshots on the backup disk.
- Default exclusions: `temp/`, `corrupted/`, `.DS_Store`, `.lock`, `*.tmp`, `*.log`, `node_modules/`. Review custom exclusions carefully.
- Files can change while SiYuan is running. Before/after checks and a final scan detect changes and fail; retry when idle. This is not a transaction-consistent database snapshot or protection against a hostile process changing parent directories.
- Content verification and durability checks add I/O. Backup runs may take longer than the old metadata-only implementation. Benchmark results are synthetic, not a guarantee for real workspaces or network storage.
- Keep another copy on a different disk or off-site for important data.

## Upgrade and development

Download `package.zip` or the versioned plugin ZIP from [GitHub Releases](https://github.com/HIUIE/siyuan-incremental-backup/releases/latest); the automatically generated Source code archives are not installation packages. Keep the old installation package and backups. Quit SiYuan, extract the new package into `data/plugins/siyuan-incremental-backup/`, and preserve settings under `data/storage/petal/siyuan-incremental-backup/`. Reopen, check settings, create/verify a backup, and test export before relying on the update.

No third-party development dependencies are required. Verified locally with Node 24; the bundled SiYuan Node/Electron runtime still requires an installation smoke check.

```bash
node test-backup-plugin.js
node test-backup-safety.js
node test-plugin-load.js
node test-toolbar.js
node test-window.js
node test-plugin-management.js
node benchmark.js
node preview-ui.js
bash build.sh
node test-package.js
```

Tests use unique temporary directories and local source files, never the installed plugin or real notes. The synthetic benchmark compares the fixed v1.1.1 tag with the current engine. The interactive preview uses real UI code with demo-only I/O, not the SiYuan host.

Packaging creates `siyuan-incremental-backup-v1.3.2.zip` and refuses to overwrite an existing package. Publish the same archive as `package.zip` in a GitHub Release for SiYuan marketplace compatibility. First-time marketplace listing requires a separate entry in `siyuan-note/bazaar` `plugins.txt`. The build script does not publish or install anything.

See `README_zh_CN.md` for the full Chinese guide.
