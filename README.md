# Jarvis Network Scanner

Chrome extension that lets you hover person cards on LinkedIn (e.g. the **Grow your network** page) and automatically search them on **BrixHub**, then displays the results in a futuristic Jarvis / Matrix-style dashboard.

## Features

- **3-second hover activation** on LinkedIn person cards, on any LinkedIn page
- Person cards are detected from the profile permalink (`/in/…`), so detection
  survives LinkedIn's frequent CSS-class changes
- UI rows such as **“Tout afficher” / “Show all”**, “Connect” or “View profile”
  are never mistaken for a person's name
- Accurate extraction of **first name** + **last name**
- Auto-fill & search on `https://brixhub.to/search`
- Sci-fi / Matrix / Jarvis HUD dashboard with:
  - Matrix rain background
  - Neon glowing panels
  - Live system log
  - Real-time status updates
- Manifest V3

## How to Install (Developer Mode)

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `linkedin-brixhub-jarvis` folder
5. Pin the extension if you want

## How to Use

1. Go to:  
   [https://www.linkedin.com/mynetwork/grow/](https://www.linkedin.com/mynetwork/grow/)  
   (or any LinkedIn page showing person cards)
2. Hover your mouse over any person card for **more than 3 seconds**
3. A glowing Jarvis overlay appears and locks the target
4. The extension opens/focuses BrixHub and fills the search form
5. Results are collected and shown in the Jarvis dashboard
6. Click the extension icon → **Open Full Dashboard** to see the complete HUD

## Project Structure

```
linkedin-brixhub-jarvis/
├── manifest.json
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── src/
│   ├── background/
│   │   └── background.js
│   ├── content/
│   │   ├── linkedin.js      # Hover detection + name extraction
│   │   └── brixhub.js       # Form fill + results scraping
│   ├── dashboard/
│   │   ├── dashboard.html   # Full Jarvis HUD
│   │   ├── dashboard.css
│   │   ├── dashboard.js
│   │   ├── popup.html
│   │   └── popup.js
│   └── styles/
│       └── linkedin-overlay.css
├── test/                    # Automated tests (see below)
└── README.md
```

## Tests

Automated tests live in `test/` and cover both the isolated logic and the real
extension running in Chrome.

```bash
cd test
npm install
npm run certs     # generate a self-signed cert for the fixture hosts
npm test          # unit + end-to-end
```

- `npm run test:unit` – jsdom tests for the content scripts, background service
  worker, dashboard and popup (fast, no browser).
- `npm run test:e2e` – loads the unpacked extension into a real Chrome via
  `--host-resolver-rules`, points `www.linkedin.com` / `brixhub.to` at local
  HTTPS fixtures, and drives the full hover → search → scrape → dashboard flow.

Set `CHROME_PATH` if Chrome is not at the default macOS location.

## Notes & Next Improvements

- BrixHub form selectors are written generically. If the site structure changes, update the selectors inside `src/content/brixhub.js`.
- LinkedIn DOM also changes frequently — name extraction uses multiple fallback selectors.
- Results scraping is currently generic (text + cards). Can be refined once the exact BrixHub result layout is known.
- No data is sent to any external server. Everything stays local in the browser.

## Disclaimer

This tool is for personal productivity / research purposes. Respect LinkedIn’s and BrixHub’s Terms of Service and applicable privacy laws.
