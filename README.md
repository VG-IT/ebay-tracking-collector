# eBay Tracking Collector (Chrome Extension)

Browser extension port of `web_crawler/bin/ebay/tracking_collector.py`. Scrapes eBay purchase/tracking data and syncs to EveryMarket.

## Setup

1. Load unpacked extension from this folder (or a deployed install dir) in Chrome
2. Open the popup, enter **Buyer email** and **Everymarket Token** (password field), click **Save**

## Usage

1. Extension icon opens settings only (no auto collect)
2. Click **Check Login** to open the Purchase URL in the background:
   - Login page → prompt to sign in
   - Otherwise → treated as logged in (result is cached)
3. On any eBay page, click the bottom-right **Collect Tracking** button to start a **full** collect (or use **Start** in the popup)
4. Use **Collect Pending** in the popup for **request** mode
5. If logout is detected while collecting, run **Check Login** again
6. Order-detail tabs are opened one order at a time and closed after scrape

### Full mode (Start / 00:00 / 12:00)

1. Collect lookback purchase-list status (status, purchase date, order number, amount) and upload
2. Walk lookback **Shipped** pages, ask em-data which of those order numbers lack tracking, collect tracking only for those, upload

### Request mode (Collect Pending / pending poll)

1. Always run lookback purchase-list status collection first
2. Load pending `order_status` / `tracking` requests from em-data
3. Open a **new** order-detail tab per order, scrape, upload, then **close** that tab

### Scheduled collection

After saving a valid login and settings:

- **Auto-run full collect daily at 00:00 and 12:00** — full scrape + upload
- **Auto-poll pending collection requests** — every N hours (default 2), reads pending from EveryMarket, collects only those, uploads; skips when empty

Schedules use the computer's local time. Chrome must be running; if the eBay session expires, check login again.

## Notes

- Buyer email is stored in `chrome.storage.sync`
- Everymarket token is stored in `chrome.storage.local` and shown as a password field
- Tracking scans only lookback **Shipped** pages that em-data says are missing tracking; remaining missing numbers open a fresh order-detail tab, closed when that order is done
- Buyer email is stored lowercase in `chrome.storage.sync`
- Successful syncs report to EveryMarket logging; completed runs also post a plugin click log

## Release (GitHub Release zip)

Not published to the Chrome Web Store. Updates are zip files attached to [GitHub Releases](https://github.com/VG-IT/ebay-tracking-collector/releases).

### Publish a new version (one-click)

Working tree must be clean. Requires [GitHub CLI](https://cli.github.com/) (`gh auth login`).

```bash
# bump patch (1.2.0 → 1.2.1), pack, commit, tag, upload zip
npm run publish:release

# or: --minor / --major / --version 1.3.0 / --current / --dry-run
npm run publish:current
```

Windows: double-click `scripts/publish-release.cmd` (publishes **current** version).

### Auto deploy (CI)

Pushing to `master`/`main` with a new `manifest.json` version (no matching tag yet) triggers [`.github/workflows/auto-deploy.yml`](.github/workflows/auto-deploy.yml): pack zip → create GitHub Release automatically.

You can still publish manually with `npm run publish:release`.

### Install / update for users

**Windows without Node/npm** (recommended for ops machines):

1. Copy `scripts/deploy-windows.cmd` + `scripts/deploy-windows.ps1` to the PC  
   (or clone/download the repo zip — only these two files are needed)
2. Double-click `deploy-windows.cmd`

Works on **Windows PowerShell 4.0+** (uses .NET zip APIs when `Expand-Archive` is unavailable).  
Release zips are **public** (repo is public). No GitHub token required.

Installs to `%LOCALAPPDATA%\ebay-tracking-collector`, then opens `chrome://extensions`.  
First time: **Load unpacked** → that folder. Later: run again → **Reload**.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\deploy-windows.ps1 -InstallDir "C:\extensions\ebay-tracking-collector"
powershell -ExecutionPolicy Bypass -File scripts\deploy-windows.ps1 -DryRun
```

**Windows Scheduled Task** (auto-check GitHub Release daily):

```powershell
# default: daily 09:00 local, task name EbayTrackingCollector-Deploy
powershell -ExecutionPolicy Bypass -File scripts\install-deploy-task.ps1

# custom time / install dir
powershell -ExecutionPolicy Bypass -File scripts\install-deploy-task.ps1 -Time 08:30 -InstallDir "C:\extensions\ebay-tracking-collector"

# remove
powershell -ExecutionPolicy Bypass -File scripts\uninstall-deploy-task.ps1
```

Or double-click `scripts/install-deploy-task.cmd`. After a scheduled update, open `chrome://extensions` and click **Reload** (Chrome cannot auto-reload unpacked extensions).

**Dev machine (Node + gh):**

```bash
npm run deploy
# or double-click scripts/deploy.cmd
```

Override install path:

```bash
npm run deploy -- --dir "C:\\extensions\\ebay-tracking-collector"
# or set EBAY_TRACKING_COLLECTOR_HOME / write path into .deploy-dir
```

Manual download (no auth):

https://github.com/VG-IT/ebay-tracking-collector/releases/latest

The popup checks GitHub Releases on open and prompts when a newer version exists.
