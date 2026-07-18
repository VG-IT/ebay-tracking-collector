# eBay Tracking Collector (Chrome Extension)

Browser extension port of `web_crawler/bin/ebay/tracking_collector.py`.

## Setup

1. Load unpacked extension from this folder in Chrome
2. Open the popup, enter **Buyer email** and **Everymarket Token** (password field), click **Save**

## Usage

1. Extension icon opens settings only (no auto collect)
2. Click **Check Login** to open the Purchase URL in the background:
   - Login page → prompt to sign in
   - Otherwise → treated as logged in (result is cached)
3. On any eBay page, click the bottom-right **Collect Tracking** button to start
4. If logout is detected while collecting, run **Check Login** again
5. Opened collector tabs are closed when the run finishes

## Notes

- Buyer email is stored in `chrome.storage.sync`
- Everymarket token is stored in `chrome.storage.local` and shown as a password field
- Tracking scans only lookback pages; remaining orders open order detail URLs directly
