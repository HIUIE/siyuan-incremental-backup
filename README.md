# Incremental Backup / 本地增量备份

Local automatic incremental backup for SiYuan Notes, built on hard-link time-point snapshots (Time Machine style).

- Scheduled auto backup (default every 60 min), manual trigger from the top bar, or via command
- True incremental: unchanged files are hard-linked to the previous snapshot, so each run typically writes only a few KB
- Every snapshot is a full directory tree — deleted/modified sources never affect older snapshots
- Automatic pruning: newest 10 always kept, older ones deduplicated per day, capped at `keepCount` (default 30)
- Selectable scope: data / conf / history / repo
- Desktop only (requires local filesystem access)

Each run creates `snap-YYYYMMDD-HHMMSS/` inside the destination folder (default `~/SiYuanBackup`).

Restore a single file: copy it from any snapshot back into the workspace.
Full restore: quit SiYuan, replace `~/SiYuan/data/` with the snapshot's `data/` folder.

Run `node test-backup-plugin.js` for a 33-assertion regression suite (pure Node, no SiYuan needed).
