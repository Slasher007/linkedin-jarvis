"use strict";

// End-to-end test: loads the real unpacked extension into Chrome and drives the
// whole flow (hover -> extract name -> open BrixHub -> fill form -> scrape ->
// dashboard) against local HTTPS fixtures that impersonate linkedin.com and
// brixhub.to via --host-resolver-rules.

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const puppeteer = require("puppeteer-core");
const { createFixtureServer } = require("./helpers/server");

const EXT_DIR = path.join(__dirname, "..");
const CHROME =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// BrixHub test subject requested for this suite
const TEST_USER = { firstName: "laura", lastName: "tracqui", fullName: "laura tracqui" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 20000, interval = 100, label = "condition" } = {}) {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeout) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${label}${lastErr ? `: ${lastErr.message}` : ""}`);
}

describe("end-to-end in Chrome", { concurrency: 1 }, () => {
  let browser;
  let cdp;
  let linkedinServer;
  let brixhubServer;
  let userDataDir;
  let extensionId;
  const consoleErrors = [];
  const pageErrors = [];

  before(async () => {
    assert.ok(fs.existsSync(CHROME), `Chrome not found at ${CHROME}; set CHROME_PATH`);

    linkedinServer = await createFixtureServer(8443);
    brixhubServer = await createFixtureServer(8444);
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-e2e-"));

    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      userDataDir,
      // Puppeteer disables extensions by default; that would make every
      // chrome-extension:// navigation fail with ERR_BLOCKED_BY_CLIENT.
      ignoreDefaultArgs: ["--disable-extensions"],
      args: [
        "--no-first-run",
        "--no-default-browser-check",
        "--ignore-certificate-errors",
        "--host-resolver-rules=MAP www.linkedin.com 127.0.0.1:8443, MAP brixhub.to 127.0.0.1:8444",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding"
      ]
    });

    cdp = await browser.target().createCDPSession();
    ({ id: extensionId } = await cdp.send("Extensions.loadUnpacked", { path: EXT_DIR }));
  });

  after(async () => {
    if (browser) await browser.close().catch(() => {});
    if (linkedinServer) linkedinServer.close();
    if (brixhubServer) brixhubServer.close();
    if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  // Extension pages have chrome.* APIs; web pages do not, so all storage
  // assertions run through a dashboard tab.
  async function openExtensionPage(file = "src/dashboard/dashboard.html") {
    const page = await browser.newPage();
    page.on("pageerror", (e) => pageErrors.push(`${page.url()}: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(`${page.url()}: ${m.text()}`);
    });
    await page.goto(`chrome-extension://${extensionId}/${file}`, {
      waitUntil: "domcontentloaded"
    });
    return page;
  }

  async function storage() {
    const page = await openExtensionPage();
    try {
      return await page.evaluate(
        () => new Promise((resolve) => chrome.storage.local.get(null, resolve))
      );
    } finally {
      await page.close();
    }
  }

  async function clearStorage() {
    const page = await openExtensionPage();
    try {
      await page.evaluate(() => new Promise((r) => chrome.storage.local.clear(r)));
    } finally {
      await page.close();
    }
  }

  function trackPage(page) {
    page.on("pageerror", (e) => pageErrors.push(`${page.url()}: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error" && !/favicon|404/i.test(m.text())) {
        consoleErrors.push(`${page.url()}: ${m.text()}`);
      }
    });
    return page;
  }

  // Each scenario starts from a clean slate: no leftover BrixHub tab holding a
  // previous person's query, and no stale extension state.
  async function resetState() {
    for (const p of await browser.pages()) {
      if (p.url().startsWith("https://brixhub.to/")) await p.close().catch(() => {});
    }
    await clearStorage();
  }

  test("extension loads and exposes its dashboard", async () => {
    const dash = await openExtensionPage();
    assert.match(extensionId, /^[a-z]{32}$/);
    await waitFor(
      () =>
        dash.evaluate(() =>
          document.getElementById("systemLog").textContent.includes("neural link")
        ),
      { label: "dashboard booted" }
    );
    await dash.close();
  });

  test("content script activates on the LinkedIn grow page and injects its CSS", async () => {
    const page = trackPage(await browser.newPage());
    await page.goto("https://www.linkedin.com/mynetwork/grow/", {
      waitUntil: "domcontentloaded"
    });

    await waitFor(() => page.evaluate(() => document.querySelectorAll(".artdeco-card").length === 5), {
      label: "fixture rendered"
    });

    const styled = await page.evaluate(() => {
      const el = document.createElement("div");
      el.className = "jarvis-hover-overlay";
      document.body.appendChild(el);
      const ok = getComputedStyle(el).borderTopColor === "rgb(0, 255, 159)";
      el.remove();
      return ok;
    });
    assert.ok(styled, "linkedin-overlay.css should be injected by the extension");

    await page.close();
  });

  test("hovering the target card for 3s locks the name", async () => {
    await clearStorage();
    const page = trackPage(await browser.newPage());
    await page.goto("https://www.linkedin.com/mynetwork/grow/", {
      waitUntil: "domcontentloaded"
    });
    await waitFor(() => page.evaluate(() => document.querySelector("#card-laura")), {
      label: "fixture ready"
    });

    await page.evaluate(() =>
      document
        .querySelector("#card-laura")
        .dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }))
    );

    // immediate feedback
    await waitFor(() => page.evaluate(() => document.querySelector(".jarvis-hover-overlay") !== null), {
      label: "scan overlay"
    });
    assert.strictEqual(
      await page.$eval(".jarvis-text", (el) => el.textContent),
      "SCANNING..."
    );

    await waitFor(
      () =>
        page.evaluate(() => {
          const el = document.querySelector(".jarvis-text");
          return el && el.textContent.startsWith("TARGET LOCKED");
        }),
      { label: "target lock", timeout: 12000 }
    );

    assert.strictEqual(
      await page.$eval(".jarvis-text", (el) => el.textContent),
      "TARGET LOCKED: laura tracqui"
    );

    const stored = await storage();
    assert.strictEqual(stored.lastHoveredPerson.firstName, TEST_USER.firstName);
    assert.strictEqual(stored.lastHoveredPerson.lastName, TEST_USER.lastName);

    await page.close();
  });

  test("hovering the hashed-class React card locks 'Léo Kempf'", async () => {
    await resetState();
    const page = trackPage(await browser.newPage());
    await page.goto("https://www.linkedin.com/mynetwork/grow/", {
      waitUntil: "domcontentloaded"
    });
    await waitFor(() => page.evaluate(() => document.querySelector("#card-leo")), {
      label: "fixture ready"
    });

    await page.evaluate(() =>
      document
        .querySelector("#card-leo")
        .dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }))
    );

    await waitFor(
      () =>
        page.evaluate(() => {
          const e = document.querySelector(".jarvis-text");
          return e && e.textContent.startsWith("TARGET LOCKED");
        }),
      { label: "target lock", timeout: 12000 }
    );

    assert.strictEqual(
      await page.$eval(".jarvis-text", (el) => el.textContent),
      "TARGET LOCKED: Léo Kempf"
    );

    const stored = await storage();
    assert.strictEqual(stored.lastHoveredPerson.firstName, "Léo");
    assert.strictEqual(stored.lastHoveredPerson.lastName, "Kempf");

    await page.close();
    // this hover also triggers a real BrixHub search; do not leak it
    for (const p of await browser.pages()) {
      if (p.url().startsWith("https://brixhub.to/")) await p.close().catch(() => {});
    }
  });

  test("BrixHub tab opens, form is filled and results are scraped in place", async () => {
    await resetState();
    const page = trackPage(await browser.newPage());
    await page.goto("https://www.linkedin.com/mynetwork/grow/", {
      waitUntil: "domcontentloaded"
    });
    await waitFor(() => page.evaluate(() => document.querySelector("#card-laura")), {
      label: "fixture ready"
    });

    await page.evaluate(() =>
      document
        .querySelector("#card-laura")
        .dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }))
    );

    // 1) the background opens/activates a BrixHub tab
    const brixTab = await waitFor(
      async () => {
        const pages = await browser.pages();
        return pages.find((p) => p.url().startsWith("https://brixhub.to/"));
      },
      { label: "brixhub tab opened", timeout: 20000 }
    );

    // 2) the content script fills the requested first/last name. BrixHub renders
    //    Nom before Prénom, so values are asserted per field name.
    await waitFor(
      async () =>
        brixTab.evaluate(() => {
          const first = document.querySelector('input[name="prenom"]');
          const last = document.querySelector('input[name="nom_famille"]');
          return Boolean(first && last && first.value === "laura" && last.value === "tracqui");
        }),
      { label: "form filled with laura/tracqui", timeout: 25000 }
    );

    // 3) the SPA renders results BELOW the form without navigating
    await waitFor(
      () => brixTab.evaluate(() => document.querySelector("article.brix-result") !== null),
      { label: "results rendered in place", timeout: 20000 }
    );

    assert.strictEqual(
      brixTab.url(),
      "https://brixhub.to/search",
      "BrixHub is a SPA: the page must not navigate"
    );

    // 4) the in-page results describe the person we searched for
    const heading = await brixTab.$eval("article.brix-result h3", (el) => el.textContent);
    assert.strictEqual(heading, "LAURA TRACQUI", "results must echo the submitted name");

    // 5) results are scraped and reported back
    const data = await waitFor(
      async () => {
        const s = await storage();
        return s.searchStatus === "complete" ? s : null;
      },
      { label: "search complete", timeout: 30000 }
    );

    assert.strictEqual(data.currentPerson.firstName, TEST_USER.firstName);
    assert.strictEqual(data.currentPerson.lastName, TEST_USER.lastName);
    assert.strictEqual(data.latestResults.results.found, true);
    assert.strictEqual(data.latestResults.results.profiles.length > 0, true);
    assert.strictEqual(typeof data.searchId, "number");
    assert.strictEqual(data.searchError, null);

    // the structured dossier is captured from the in-page results
    const dossier = data.latestResults.results.dossier;
    assert.ok(dossier, "a dossier must be extracted from the in-page results");
    assert.strictEqual(dossier.displayName, "LAURA TRACQUI");
    assert.match(dossier.status, /Recherche termin/i);
    assert.ok(dossier.sources.includes("Colis Privé (2025)"));
    assert.ok(dossier.blocks["Identité"], "identity block must be captured");
    assert.strictEqual(
      dossier.blocks["Identité"].find((p) => p.label === "Nom de famille").value,
      "TRACQUI"
    );
    assert.strictEqual(
      dossier.blocks["Identité"].find((p) => p.label === "Prénom").value,
      "LAURA"
    );
    assert.ok(dossier.familyTree, "family tree must be captured");
    assert.match(dossier.familyTree.summary, /60 profils/);

    await brixTab.close().catch(() => {});
    await page.close();
  });

  test("dashboard renders the target, intel feed and dossier", async () => {
    const dash = trackPage(await browser.newPage());
    await dash.goto(`chrome-extension://${extensionId}/src/dashboard/dashboard.html`, {
      waitUntil: "domcontentloaded"
    });

    await waitFor(() => dash.evaluate(() => document.querySelector(".target-name")), {
      label: "target rendered"
    });

    assert.strictEqual(
      await dash.$eval(".target-name", (el) => el.textContent),
      "laura tracqui"
    );
    assert.strictEqual(
      await dash.$eval("#statusText", (el) => el.textContent),
      "INTEL RECEIVED"
    );

    const feed = await dash.$eval("#resultsFeed", (el) => el.textContent);
    assert.ok(feed.includes("LAURA TRACQUI"), "dossier match should be rendered");
    assert.ok(feed.includes("SOURCES"), "sources block should be rendered");
    assert.ok(feed.includes("IDENTITÉ"), "identity block should be rendered");
    assert.ok(feed.includes("Nom de famille"), "labelled key/value rows should be rendered");
    assert.ok(feed.includes("FAMILY TREE"), "family tree should be rendered");
    assert.ok(feed.includes("17 RUE LAGANNE"), "household address should be rendered");
    assert.ok(feed.includes("ghislaine@icloud.com"), "relative email should be rendered");

    // the matrix canvas is actually painting
    const painted = await dash.evaluate(() => {
      const c = document.querySelector(".matrix-bg canvas");
      return Boolean(c && c.width > 0 && c.height > 0);
    });
    assert.ok(painted, "matrix background canvas should be sized");

    await dash.close();
  });

  test("a second hover reuses and reloads the existing BrixHub tab", async () => {
    await resetState();

    // Leave a BrixHub tab parked on /search (as after a manual visit), so the
    // background finds an existing tab already sitting on the search URL.
    const existing = trackPage(await browser.newPage());
    await existing.goto("https://brixhub.to/search", { waitUntil: "domcontentloaded" });

    await clearStorage();
    const page = trackPage(await browser.newPage());
    await page.goto("https://www.linkedin.com/mynetwork/grow/", {
      waitUntil: "domcontentloaded"
    });
    await waitFor(() => page.evaluate(() => document.querySelector("#card-laura")), {
      label: "fixture ready"
    });

    const before = (await browser.pages()).filter((p) =>
      p.url().startsWith("https://brixhub.to/")
    ).length;
    assert.strictEqual(before, 1, "one BrixHub tab is already open");

    await page.evaluate(() =>
      document
        .querySelector("#card-laura")
        .dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }))
    );

    // Without the reload fix, tabs.update with the same URL is a no-op: the
    // content script never re-runs and the search would hang in "searching".
    const data = await waitFor(
      async () => {
        const s = await storage();
        return s.searchStatus === "complete" ? s : null;
      },
      { label: "second search completes", timeout: 30000 }
    );

    assert.strictEqual(data.currentPerson.fullName, TEST_USER.fullName);

    // the reused tab ran the search and rendered results in place
    await waitFor(
      () => existing.evaluate(() => document.querySelector("article.brix-result") !== null),
      { label: "reused tab rendered results", timeout: 15000 }
    );

    const after = (await browser.pages()).filter((p) =>
      p.url().startsWith("https://brixhub.to/")
    ).length;
    assert.strictEqual(after, 1, "the existing tab must be reused, not duplicated");

    for (const p of await browser.pages()) {
      if (p.url().startsWith("https://brixhub.to/")) await p.close().catch(() => {});
    }
    await page.close();
  });

  test("'Tout afficher' and nameless rows are never scanned as people", async () => {
    await clearStorage();
    const page = trackPage(await browser.newPage());
    await page.goto("https://www.linkedin.com/mynetwork/grow/", {
      waitUntil: "domcontentloaded"
    });
    await waitFor(() => page.evaluate(() => document.querySelector("#card-showall")), {
      label: "fixture ready"
    });

    for (const id of ["#card-showall", "#card-anon"]) {
      await page.evaluate(
        (sel) =>
          document
            .querySelector(sel)
            .dispatchEvent(new MouseEvent("mouseenter", { bubbles: false })),
        id
      );
    }

    // Well past the 3s threshold: nothing may lock and no scan may start.
    await sleep(4500);

    assert.strictEqual(
      await page.evaluate(() => document.querySelector(".jarvis-hover-overlay")),
      null,
      "no overlay should appear for non-person rows"
    );
    const data = await storage();
    assert.strictEqual(data.currentPerson, undefined, "no target may be locked");
    assert.strictEqual(data.searchStatus, undefined, "no search may be started");
  });

  test("dashboard ESC minimize and popup work", async () => {
    const dash = await openExtensionPage();
    await waitFor(
      () => dash.evaluate(() => document.getElementById("systemLog").textContent.includes("neural link")),
      { label: "dashboard booted" }
    );

    await dash.keyboard.press("Escape");
    await waitFor(() => dash.evaluate(() => document.body.classList.contains("minimized")), {
      label: "minimized"
    });
    assert.ok(
      await dash.evaluate(
        () => getComputedStyle(document.getElementById("restoreChip")).display !== "none"
      ),
      "restore chip should be visible when minimized"
    );

    await dash.keyboard.press("Escape");
    await waitFor(() => dash.evaluate(() => !document.body.classList.contains("minimized")), {
      label: "restored"
    });
    await dash.close();

    const popup = await openExtensionPage("src/dashboard/popup.html");
    await waitFor(() => popup.evaluate(() => document.getElementById("status").textContent.length > 0), {
      label: "popup status"
    });
    await popup.close();
  });

  test("no uncaught errors were produced by the extension", () => {
    assert.deepStrictEqual(pageErrors, [], "no page errors expected");
    assert.deepStrictEqual(consoleErrors, [], "no console errors expected");
  });
});
