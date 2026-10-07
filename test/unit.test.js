"use strict";

const { test, describe, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const { JSDOM, VirtualConsole } = require("jsdom");
const { makeChromeStub } = require("./helpers/chrome-stub");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src");

const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const LINKEDIN_SRC = read("src/content/linkedin.js");
const BRIXHUB_SRC = read("src/content/brixhub.js");
const BACKGROUND_SRC = read("src/background/background.js");
const DASHBOARD_SRC = read("src/dashboard/dashboard.js");
const POPUP_SRC = read("src/dashboard/popup.js");

const openWindows = [];
after(() => {
  openWindows.forEach((w) => {
    try {
      w.close();
    } catch (_) {}
  });
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, { timeout = 8000, interval = 40, label = "condition" } = {}) {
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
  throw new Error(`Timed out waiting for ${label}${lastErr ? ` (last error: ${lastErr.message})` : ""}`);
}

function stubLayout(win) {
  // jsdom has no layout engine: offsetWidth/offsetHeight are always 0, which
  // would make the extension's isVisible() reject every input.
  Object.defineProperty(win.HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() {
      return 120;
    }
  });
  Object.defineProperty(win.HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return 32;
    }
  });
}

function makeWindow(html, url) {
  const vc = new VirtualConsole();
  const jsdomErrors = [];
  vc.on("jsdomError", (e) => jsdomErrors.push(e));
  const dom = new JSDOM(html, {
    url,
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole: vc
  });
  stubLayout(dom.window);
  openWindows.push(dom.window);
  return { dom, win: dom.window, jsdomErrors };
}

// ---------------------------------------------------------------------------
// 1. Manifest + static integrity
// ---------------------------------------------------------------------------
describe("manifest", () => {
  const manifest = JSON.parse(read("manifest.json"));

  test("is valid Manifest V3 with required fields", () => {
    assert.strictEqual(manifest.manifest_version, 3);
    assert.ok(manifest.name);
    assert.ok(/^\d+\.\d+\.\d+$/.test(manifest.version), "version must be x.y.z");
    assert.ok(Array.isArray(manifest.permissions));
  });

  test("every referenced file exists", () => {
    const referenced = [
      manifest.background.service_worker,
      ...(manifest.content_scripts.flatMap((c) => [...c.js, ...(c.css || [])])),
      manifest.action.default_popup,
      ...Object.values(manifest.action.default_icon || {}),
      ...Object.values(manifest.icons || {})
    ];
    for (const rel of referenced) {
      assert.ok(fs.existsSync(path.join(ROOT, rel)), `missing file: ${rel}`);
    }
  });

  test("web_accessible_resources globs resolve to real files", () => {
    for (const entry of manifest.web_accessible_resources) {
      for (const res of entry.resources) {
        if (res.endsWith("/*")) {
          const dir = path.join(ROOT, res.slice(0, -2));
          assert.ok(fs.existsSync(dir) && fs.statSync(dir).isDirectory(), `missing dir: ${dir}`);
          assert.ok(fs.readdirSync(dir).length > 0, `empty dir: ${dir}`);
        } else {
          assert.ok(fs.existsSync(path.join(ROOT, res)), `missing: ${res}`);
        }
      }
    }
  });

  test("content script match patterns are syntactically valid", () => {
    const pattern =
      /^(\*|https?|file|ftp):\/\/(\*|\*\.[^*/:]+|[^*/:]+)(\/.*)$/;
    const all = [
      ...manifest.content_scripts.flatMap((c) => c.matches),
      ...manifest.host_permissions
    ];
    for (const m of all) {
      assert.match(m, pattern, `invalid match pattern: ${m}`);
      const authority = m.slice(m.indexOf("://") + 3).split("/")[0];
      assert.ok(!authority.includes(":"), `match patterns must not contain a port: ${m}`);
    }
  });

  test("covers LinkedIn and all of BrixHub", () => {
    const linkedin = manifest.content_scripts.find((c) =>
      c.js.some((j) => j.includes("linkedin"))
    );
    // person cards appear on many LinkedIn surfaces, not only /mynetwork/grow
    assert.ok(linkedin.matches.includes("https://www.linkedin.com/*"));

    const brixhub = manifest.content_scripts.find((c) =>
      c.js.some((j) => j.includes("brixhub"))
    );
    assert.ok(brixhub.matches.includes("https://brixhub.to/*"));
  });

  test("all source files pass a syntax check", () => {
    const files = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".js")) files.push(p);
      }
    })(SRC);
    assert.ok(files.length >= 5, "expected source files");
    for (const f of files) {
      execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Background service worker
// ---------------------------------------------------------------------------
describe("background service worker", () => {
  function bootBackground() {
    const chrome = makeChromeStub();
    const listeners = [];
    chrome.runtime.onMessage.addListener = (fn) => listeners.push(fn);
    const sandbox = {
      chrome,
      console: { log() {}, error() {}, warn() {} },
      Date,
      setTimeout,
      clearTimeout
    };
    vm.createContext(sandbox);
    vm.runInContext(BACKGROUND_SRC, sandbox);
    return {
      chrome,
      dispatch(message, sender = {}) {
        let response;
        const channelHeld =
          listeners[0](message, sender, (r) => {
            response = r;
          }) === true;
        return { response, channelHeld };
      }
    };
  }

  test("PERSON_CONFIRMED opens BrixHub and records the search", async () => {
    const bg = bootBackground();
    const { response } = bg.dispatch({
      type: "PERSON_CONFIRMED",
      payload: { firstName: "Ada", lastName: "Lovelace", fullName: "Ada Lovelace" }
    });
    assert.strictEqual(response.status, "searching");
    await sleep(20);

    assert.strictEqual(bg.chrome.tabs.created.length, 1);
    assert.strictEqual(bg.chrome.tabs.created[0].url, "https://brixhub.to/search");

    const s = bg.chrome.__store;
    assert.strictEqual(s.searchStatus, "searching");
    assert.strictEqual(s.searchPhase, null);
    assert.strictEqual(s.currentPerson.fullName, "Ada Lovelace");
    assert.strictEqual(typeof s.searchId, "number");
    assert.strictEqual(s.latestResults, null);
  });

  test("existing BrixHub tab already on /search is force-reloaded", async () => {
    const bg = bootBackground();
    bg.chrome.tabs.queried = [
      { id: 7, url: "https://brixhub.to/search" }
    ];
    bg.dispatch({
      type: "PERSON_CONFIRMED",
      payload: { firstName: "Grace", lastName: "Hopper", fullName: "Grace Hopper" }
    });
    await sleep(20);

    assert.strictEqual(bg.chrome.tabs.updated.length, 1);
    assert.strictEqual(bg.chrome.tabs.updated[0].props.url, "https://brixhub.to/search");
    assert.strictEqual(
      bg.chrome.tabs.reloads,
      1,
      "tab already at the search URL must be reloaded, otherwise no navigation happens and the content script never re-runs"
    );
  });

  test("existing BrixHub tab on another URL is updated without reload", async () => {
    const bg = bootBackground();
    bg.chrome.tabs.queried = [
      { id: 8, url: "https://brixhub.to/results?first_name=Ada" }
    ];
    bg.dispatch({
      type: "PERSON_CONFIRMED",
      payload: { firstName: "Cher", lastName: "", fullName: "Cher" }
    });
    await sleep(20);

    assert.strictEqual(bg.chrome.tabs.updated.length, 1);
    assert.strictEqual(bg.chrome.tabs.reloads, 0);
  });

  test("BRIXHUB_RESULTS marks the search complete", async () => {
    const bg = bootBackground();
    const payload = { person: { fullName: "Ada Lovelace" }, results: { found: true } };
    bg.dispatch({ type: "BRIXHUB_RESULTS", payload });
    await sleep(20);

    assert.strictEqual(bg.chrome.__store.searchStatus, "complete");
    assert.deepStrictEqual(bg.chrome.__store.latestResults, payload);
    assert.strictEqual(bg.chrome.__store.searchError, null);
  });

  test("name extraction failure does not clobber a finished search", async () => {
    const bg = bootBackground();
    bg.dispatch({ type: "BRIXHUB_RESULTS", payload: { results: { found: true } } });
    await sleep(20);

    bg.dispatch({
      type: "SEARCH_FAILED",
      payload: { reason: "name_not_detected" }
    });
    await sleep(20);

    assert.strictEqual(bg.chrome.__store.searchStatus, "complete");
    assert.strictEqual(bg.chrome.__store.searchError, "name_not_detected");
  });

  test("form failure during a running search flips status to error", async () => {
    const bg = bootBackground();
    bg.dispatch({
      type: "PERSON_CONFIRMED",
      payload: { firstName: "Ada", lastName: "Lovelace", fullName: "Ada Lovelace" }
    });
    await sleep(20);

    bg.dispatch({ type: "SEARCH_FAILED", payload: { reason: "form_not_found" } });
    await sleep(20);

    assert.strictEqual(bg.chrome.__store.searchStatus, "error");
    assert.strictEqual(bg.chrome.__store.searchError, "form_not_found");
  });

  test("PERSON_HOVER_START without a payload does not throw", () => {
    const bg = bootBackground();
    const { response } = bg.dispatch({ type: "PERSON_HOVER_START" });
    assert.strictEqual(response.status, "tracking");
  });

  test("GET_LATEST_RESULTS keeps the message channel open", () => {
    const bg = bootBackground();
    const { channelHeld } = bg.dispatch({ type: "GET_LATEST_RESULTS" });
    assert.strictEqual(channelHeld, true);
  });

  test("unknown message types are answered", () => {
    const bg = bootBackground();
    assert.strictEqual(bg.dispatch({ type: "NOPE" }).response.status, "unknown");
  });
});

// ---------------------------------------------------------------------------
// 3. LinkedIn content script
// ---------------------------------------------------------------------------
describe("linkedin content script", () => {
  function boot(storage = {}, onMessage) {
    const { win } = makeWindow(read("test/fixtures/linkedin-grow.html"), "https://www.linkedin.com/mynetwork/grow/");
    const chrome = makeChromeStub({ storage, onMessage });
    win.chrome = chrome;
    win.__jarvisTestHooks = {};
    win.eval(LINKEDIN_SRC);
    return { win, chrome, hooks: win.__jarvisTestHooks };
  }

  const el = (win, sel) => win.document.querySelector(sel);
  const fire = (win, node, type) => node.dispatchEvent(new win.Event(type));

  test("prefers the dedicated name selector over a generic span[dir=ltr] headline", () => {
    const { win, hooks } = boot();
    const person = hooks.linkedin.extractNameFromCard(el(win, "#card-ada"));
    assert.strictEqual(person.firstName, "Ada");
    assert.strictEqual(person.lastName, "Lovelace");
    assert.strictEqual(person.fullName, "Ada Lovelace");
    assert.ok(!person.original.includes("Mathematician"), "headline must not leak into the name");
  });

  test("strips pronoun suffixes", () => {
    const { win, hooks } = boot();
    const person = hooks.linkedin.extractNameFromCard(el(win, "#card-grace"));
    assert.strictEqual(person.fullName, "Grace Hopper");
    assert.ok(!person.original.includes("she/her"));
  });

  test("accepts mononyms", () => {
    const { win, hooks } = boot();
    const person = hooks.linkedin.extractNameFromCard(el(win, "#card-cher"));
    assert.strictEqual(person.firstName, "Cher");
    assert.strictEqual(person.lastName, "");
    assert.strictEqual(person.fullName, "Cher", "mononym must not gain a trailing space");
  });

  test("returns null when there is no name", () => {
    const { win, hooks } = boot();
    assert.strictEqual(hooks.linkedin.extractNameFromCard(el(win, "#card-anon")), null);
  });

  test("extracts the name from the current hashed-class React card (Léo Kempf)", () => {
    const { win, hooks } = boot();
    const person = hooks.linkedin.extractNameFromCard(el(win, "#card-leo"));
    assert.ok(person, "name must be extracted from <p><span> markup");
    assert.strictEqual(person.firstName, "Léo");
    assert.strictEqual(person.lastName, "Kempf");
    assert.strictEqual(person.fullName, "Léo Kempf");
    assert.ok(
      !person.fullName.includes("Premium"),
      "the Premium badge must not leak into the name"
    );
    assert.ok(
      !person.fullName.includes("ISAT"),
      "the headline must not be used as the name"
    );
  });

  test("detects the hashed-class React card without a /in/ permalink", () => {
    const { win, hooks } = boot();
    const cards = hooks.linkedin.findPersonCards();
    const leo = cards.find((c) => c.id === "card-leo");
    assert.ok(leo, "card must be detected from its avatar + name");
    assert.strictEqual(leo.querySelector("a[href*='/in/']"), null, "no permalink in this card");
  });

  test("surname written first in capitals is swapped back (FIZIR Emy)", () => {
    const { win, hooks } = boot();
    const div = win.document.createElement("div");
    div.innerHTML = '<p><span>Emy FIZIR</span></p>';
    const person = hooks.linkedin.extractNameFromCard(div);
    assert.strictEqual(person.firstName, "Emy", "prénom is the trailing token");
    assert.strictEqual(person.lastName, "FIZIR", "nom is the leading capitalised token");
    assert.strictEqual(person.fullName, "Emy FIZIR");
  });

  test("all-caps surname-first also swaps", () => {
    const { win, hooks } = boot();
    const div = win.document.createElement("div");
    div.innerHTML = '<p><span>FIZIR Emy</span></p>';
    const person = hooks.linkedin.extractNameFromCard(div);
    assert.strictEqual(person.firstName, "Emy");
    assert.strictEqual(person.lastName, "FIZIR");
  });

  test("ordinary 'Firstname Lastname' casing is left alone", () => {
    const { win, hooks } = boot();
    const div = win.document.createElement("div");
    div.innerHTML = '<p><span>Léo Kempf</span></p>';
    const person = hooks.linkedin.extractNameFromCard(div);
    assert.strictEqual(person.firstName, "Léo");
    assert.strictEqual(person.lastName, "Kempf");
  });

  test("two shouted tokens are ambiguous and keep their order", () => {
    const { win, hooks } = boot();
    const div = win.document.createElement("div");
    div.innerHTML = '<p><span>ADA LOVELACE</span></p>';
    const person = hooks.linkedin.extractNameFromCard(div);
    assert.strictEqual(person.firstName, "ADA");
    assert.strictEqual(person.lastName, "LOVELACE");
  });

  test("detects person cards", () => {
    const { win, hooks } = boot();
    const cards = hooks.linkedin.findPersonCards();
    assert.strictEqual(cards.length, 6);
    assert.ok(
      !cards.some((c) => c.id === "card-showall"),
      "the 'Tout afficher' row is not a person card"
    );
    assert.ok(
      !cards.some((c) => c.id === "card-anon"),
      "a card with no detectable name is not treated as a person"
    );
  });

  test("'Tout afficher' is never extracted as a name", () => {
    const { win, hooks } = boot();
    const person = hooks.linkedin.extractNameFromCard(el(win, "#card-showall"));
    assert.strictEqual(person, null);
  });

  test("extracts the name when the profile link only wraps the avatar", () => {
    const { win, hooks } = boot();
    const div = win.document.createElement("div");
    div.innerHTML = `
      <a href="/in/ada-lovelace" class="photo"><img alt="" /></a>
      <a href="/in/ada-lovelace" data-control-name="view_profile">View profile</a>
      <div class="artdeco-entity-lockup__title">Ada Lovelace</div>
    `;
    const person = hooks.linkedin.extractNameFromCard(div);
    assert.strictEqual(person.firstName, "Ada");
    assert.strictEqual(person.lastName, "Lovelace");
  });

  test("detects cards whose name is only the profile permalink", () => {
    const { win, hooks } = boot();
    const cards = hooks.linkedin.findPersonCards();
    const match = cards.find((c) => c.id === "card-linkonly");
    assert.ok(match, "card anchored on /in/ link should be detected");

    const person = hooks.linkedin.extractNameFromCard(match);
    assert.strictEqual(person.firstName, "marcell");
    assert.strictEqual(person.lastName, "dupont");
  });

  test("rejects button labels and other non-name text", () => {
    const { win, hooks } = boot();
    const person = hooks.linkedin.extractNameFromCard(el(win, "#card-anon"));
    assert.strictEqual(person, null, "'Connect' must not be read as a name");
  });

  test("extracts the BrixHub test subject", () => {
    const { win, hooks } = boot();
    const person = hooks.linkedin.extractNameFromCard(el(win, "#card-laura"));
    assert.deepStrictEqual(
      { firstName: person.firstName, lastName: person.lastName },
      { firstName: "laura", lastName: "tracqui" }
    );
  });

  test("hover shorter than 3s is cancelled and reported", async () => {
    const { win, chrome } = boot();
    const card = el(win, "#card-ada");

    fire(win, card, "mouseenter");
    assert.ok(el(win, ".jarvis-hover-overlay"), "overlay should appear immediately");
    assert.strictEqual(el(win, ".jarvis-text").textContent, "SCANNING...");
    assert.ok(chrome.__messages.some((m) => m.type === "PERSON_HOVER_START"));

    await sleep(300);
    fire(win, card, "mouseleave");

    assert.strictEqual(el(win, ".jarvis-hover-overlay"), null, "overlay must be removed");
    assert.ok(chrome.__messages.some((m) => m.type === "PERSON_HOVER_END"));
    assert.ok(!chrome.__messages.some((m) => m.type === "PERSON_CONFIRMED"));
  });

  test("hover for 3s locks the target and confirms it", async () => {
    const { win, chrome } = boot();
    const card = el(win, "#card-grace");

    fire(win, card, "mouseenter");
    await waitFor(() => chrome.__messages.some((m) => m.type === "PERSON_CONFIRMED"), {
      label: "PERSON_CONFIRMED",
      timeout: 6000
    });

    const msg = chrome.__messages.find((m) => m.type === "PERSON_CONFIRMED");
    assert.strictEqual(msg.payload.fullName, "Grace Hopper");
    assert.strictEqual(el(win, ".jarvis-text").textContent, "TARGET LOCKED: Grace Hopper");
    assert.ok(el(win, ".jarvis-hover-overlay").classList.contains("locked"));
    assert.strictEqual(chrome.__store.lastHoveredPerson.firstName, "Grace");
  });

  test("name-not-detectable card reports a fault", async () => {
    const { win, chrome } = boot({ searchStatus: "complete" });

    // A bound card whose name disappears before the timer fires (LinkedIn
    // re-renders constantly, so this is a realistic race).
    const card = el(win, "#card-laura");
    fire(win, card, "mouseenter");
    card.querySelector(".artdeco-entity-lockup__title").textContent = "";

    await waitFor(() => chrome.__messages.some((m) => m.type === "SEARCH_FAILED"), {
      label: "SEARCH_FAILED",
      timeout: 6000
    });
    assert.strictEqual(el(win, ".jarvis-text").textContent, "NAME NOT DETECTED");
    assert.strictEqual(chrome.__store.searchStatus, "complete", "status must not be clobbered");
  });

  test("cards without a name are never bound in the first place", () => {
    const { win, hooks } = boot();
    const ids = hooks.linkedin.findPersonCards().map((c) => c.id);
    assert.ok(!ids.includes("card-anon"), "anonymous card must not be hoverable");
    assert.ok(!ids.includes("card-showall"), "'Tout afficher' row must not be hoverable");
  });

  test("hostile markup is rejected as a name, so it can never reach the overlay", async () => {
    const { win, chrome } = boot();
    const card = el(win, "#card-ada");
    const title = card.querySelector(".artdeco-entity-lockup__title");
    title.textContent = "<img/src=x/onerror=window.__pwned=1>";

    fire(win, card, "mouseenter");
    await waitFor(() => chrome.__messages.some((m) => m.type === "SEARCH_FAILED"), {
      label: "SEARCH_FAILED",
      timeout: 6000
    });

    assert.ok(
      !chrome.__messages.some((m) => m.type === "PERSON_CONFIRMED"),
      "markup must not be accepted as a person"
    );
    assert.strictEqual(win.__pwned, undefined);
  });

  test("overlay is positioned relative to the viewport, not the scrolled document", async () => {
    const { win } = boot();
    // jsdom has no layout, so scroll position is simulated
    Object.defineProperty(win, "scrollY", { value: 400, configurable: true });
    Object.defineProperty(win, "scrollX", { value: 0, configurable: true });

    const card = el(win, "#card-ada");
    fire(win, card, "mouseenter");

    const overlay = el(win, ".jarvis-hover-overlay");
    const rect = card.getBoundingClientRect();
    const top = parseFloat(overlay.style.top);
    const left = parseFloat(overlay.style.left);

    assert.strictEqual(overlay.style.position, "fixed");
    assert.ok(
      Math.abs(top - (rect.top - 8)) < 1,
      `overlay top ${top} must track the card viewport rect (${rect.top}); scrollY=400 must not be added`
    );
    assert.ok(Math.abs(left - (rect.left - 8)) < 1);

    fire(win, card, "mouseleave");
  });

  test("name with HTML characters is rejected rather than parsed", () => {
    const { win, hooks } = boot();
    const div = win.document.createElement("div");
    div.innerHTML =
      '<div class="artdeco-entity-lockup__title">Zoe &lt;script&gt;alert(1)&lt;/script&gt;</div>';
    assert.strictEqual(
      hooks.linkedin.extractNameFromCard(div),
      null,
      "only letter-like text is ever accepted as a name"
    );
  });
});

// ---------------------------------------------------------------------------
// 4. BrixHub content script
// ---------------------------------------------------------------------------
describe("brixhub content script", () => {
  function boot(fixture, storage, onMessage) {
    const url =
      fixture === "brixhub-results"
        ? "https://brixhub.to/results?first_name=Ada&last_name=Lovelace"
        : "https://brixhub.to/search";
    const { win, jsdomErrors } = makeWindow(read(`test/fixtures/${fixture}.html`), url);
    const chrome = makeChromeStub({ storage, onMessage });
    win.chrome = chrome;
    win.__jarvisTestHooks = {};
    win.eval(BRIXHUB_SRC);
    return { win, chrome, hooks: win.__jarvisTestHooks, jsdomErrors };
  }

  const pendingSearch = (extra = {}) => ({
    currentPerson: { firstName: "Ada", lastName: "Lovelace", fullName: "Ada Lovelace" },
    searchStatus: "searching",
    searchId: 111,
    searchPhase: null,
    ...extra
  });

  test("fills both fields and submits the form", async () => {
    const messages = [];
    const { win, chrome } = boot("brixhub-search", pendingSearch(), (m) => messages.push(m));

    await waitFor(
      () =>
        chrome.__store.searchPhase === "submitted" ||
        messages.some((m) => m.type === "BRIXHUB_RESULTS"),
      { label: "form submitted", timeout: 6000 }
    );

    // Assert by field identity, not DOM position: BrixHub renders Nom first.
    const byName = (n) => win.document.querySelector(`input[name="${n}"]`).value;
    assert.strictEqual(byName("prenom"), "Ada", "Prénom field gets the first name");
    assert.strictEqual(byName("nom_famille"), "Lovelace", "Nom field gets the last name");
    assert.strictEqual(chrome.__store.searchPhase, "submitted");
    assert.ok(!messages.some((m) => m.type === "SEARCH_FAILED"));
  });

  test("maps values to the right fields when the DOM order is reversed", () => {
    const { win } = boot("brixhub-search", pendingSearch());
    const inputs = Array.from(win.document.querySelectorAll("input"));
    // sanity: the fixture really does put Nom before Prénom
    assert.strictEqual(inputs[0].name, "nom_famille");
    assert.strictEqual(inputs[1].name, "prenom");
  });

  test("fills the fields before submitting", async () => {
    const { win } = boot("brixhub-search", pendingSearch());
    const btn = win.document.querySelector(".brix-btn--primary");

    const valuesAtClick = [];
    btn.addEventListener("click", () => {
      // Nom, Prénom, then the two decoys which must remain untouched
      valuesAtClick.push(
        Array.from(win.document.querySelectorAll("input")).map((i) => `${i.name}=${i.value}`)
      );
    });

    await waitFor(() => valuesAtClick.length > 0, { label: "click", timeout: 6000 });
    assert.deepStrictEqual(valuesAtClick[0], [
      "nom_famille=Lovelace",
      "prenom=Ada",
      "nom_naissance=",
      "nom_affichage="
    ]);
  });

  test("clicks the BrixHub primary button even when it sits outside the <form>", async () => {
    const { win } = boot("brixhub-button-outside", pendingSearch());

    const btn = win.document.querySelector(".brix-btn--primary");
    assert.ok(btn, "fixture must expose the primary button");

    // It is a real sibling of the form, so a form-scoped lookup would miss it.
    assert.strictEqual(btn.closest("form"), null, "button must not be inside the form");

    let clicked = 0;
    ["pointerdown", "mousedown", "mouseup", "click"].forEach((type) => {
      btn.addEventListener(type, () => {
        if (type === "click") clicked++;
      });
    });

    await waitFor(() => clicked > 0, { label: "submit button clicked", timeout: 6000 });
    assert.strictEqual(clicked, 1, "the submit button must be clicked exactly once");
  });


  test("extracts the full BrixHub dossier when present", async () => {
    const messages = [];
    boot("brixhub-dossier", pendingSearch({ searchPhase: "submitted" }), (m) => messages.push(m));

    const msg = await waitFor(() => messages.find((m) => m.type === "BRIXHUB_RESULTS"), {
      label: "BRIXHUB_RESULTS",
      timeout: 6000
    });
    const d = msg.payload.results.dossier;
    assert.ok(d, "a dossier must be extracted");
    assert.strictEqual(d.found, undefined);
    assert.strictEqual(msg.payload.results.found, true);

    assert.strictEqual(d.displayName, "ORIANE BONTEMPS");
    assert.match(d.status, /Recherche termin/i);
    assert.match(d.consolidated, /4 sources/i);

    // sources, excluding button tooltips
    assert.deepStrictEqual(d.sources, [
      "Colis Privé (2025)",
      "Ameli (2022)",
      "FranceConnect",
      "Mutuelle des Motards"
    ]);

    // every labelled block is captured
    assert.deepStrictEqual(Object.keys(d.blocks).sort(), [
      "Adresse",
      "Contact",
      "Identité",
      "Professionnel"
    ]);
    assert.deepStrictEqual(d.blocks["Identité"], [
      { label: "Nom de famille", value: "BONTEMPS" },
      { label: "Prénom", value: "ORIANE" },
      { label: "Nom d'utilisateur", value: "10008063603" },
      { label: "Civilité", value: "F" }
    ]);
    assert.ok(d.blocks.Contact.some((p) => p.value === "oriane.bontemps@gmail.com"));
    assert.ok(d.blocks.Adresse.some((p) => p.value === "Toulouse"));
    assert.ok(d.blocks.Professionnel.some((p) => p.value === "Psychomotricien"));

    // family tree
    const ft = d.familyTree;
    assert.ok(ft, "family tree must be extracted");
    assert.match(ft.summary, /60 profils/);
    assert.strictEqual(ft.households.length, 2);
    assert.strictEqual(ft.households[0].address, "17 RUE LAGANNE");
    assert.ok(ft.households[0].meta.includes("3 membres"));
    assert.deepStrictEqual(ft.households[0].members.map((m) => m.name), [
      "Ghislaine BONTEMPS",
      "PIERRE BONTEMPS"
    ]);
    assert.strictEqual(ft.households[0].members[1].dob, "2014-04-28");
    assert.strictEqual(ft.households[0].members[0].email, "ghislainebontemps@icloud.com");
    assert.deepStrictEqual(ft.households[0].members[0].phones, ["620775236"]);
    assert.strictEqual(ft.households[1].address, "Adresse inconnue");
  });

  test("ignores BrixHub decoy fields (Nom de naissance / Nom affiché)", async () => {
    const { win, chrome } = boot("brixhub-search", pendingSearch());

    await waitFor(() => chrome.__store.searchPhase === "submitted", {
      label: "form submitted",
      timeout: 6000
    });

    const value = (name) => win.document.querySelector(`input[name="${name}"]`).value;
    assert.strictEqual(value("nom_famille"), "Lovelace");
    assert.strictEqual(value("prenom"), "Ada");
    assert.strictEqual(value("nom_naissance"), "", "birth-name decoy must stay empty");
    assert.strictEqual(value("nom_affichage"), "", "display-name decoy must stay empty");
  });

  test("scrapes only leaf result cards and reports them", async () => {
    const messages = [];
    const { chrome } = boot(
      "brixhub-results",
      pendingSearch({ searchPhase: "submitted" }),
      (m) => messages.push(m)
    );

    const msg = await waitFor(() => messages.find((m) => m.type === "BRIXHUB_RESULTS"), {
      label: "BRIXHUB_RESULTS",
      timeout: 6000
    });

    const results = msg.payload.results;
    assert.strictEqual(results.found, true);
    assert.strictEqual(
      results.profiles.length,
      2,
      "wrapper containers must be excluded (fixture has 5 matching nodes, 2 leaves)"
    );
    assert.ok(results.profiles.every((p) => p.text.includes("Lovelace")));
    assert.strictEqual(msg.payload.person.fullName, "Ada Lovelace");
    assert.ok(msg.payload.url.startsWith("https://brixhub.to/results"));
    assert.strictEqual(chrome.__store.searchPhase, "submitted");
  });

  test("reports a fault when no search form exists", async () => {
    const messages = [];
    boot("brixhub-results", pendingSearch(), (m) => messages.push(m));

    const msg = await waitFor(() => messages.find((m) => m.type === "SEARCH_FAILED"), {
      label: "SEARCH_FAILED",
      timeout: 6000
    });
    assert.strictEqual(msg.payload.reason, "form_not_found");
  });

  test("does nothing when there is no pending search", async () => {
    const messages = [];
    boot("brixhub-search", { searchStatus: "complete" }, (m) => messages.push(m));
    await sleep(1200);
    assert.strictEqual(messages.length, 0);
  });

  test("re-initialisation for the same search does not re-run it", async () => {
    const messages = [];
    const { hooks } = boot(
      "brixhub-results",
      pendingSearch({ searchPhase: "submitted" }),
      (m) => messages.push(m)
    );
    await waitFor(() => messages.some((m) => m.type === "BRIXHUB_RESULTS"), {
      label: "first results",
      timeout: 6000
    });

    await hooks.brixhub.init();
    await hooks.brixhub.init();
    const count = messages.filter((m) => m.type === "BRIXHUB_RESULTS").length;
    assert.strictEqual(count, 1, "each search must report exactly once");
  });

  test("a finished search is not picked up again on page load", async () => {
    const messages = [];
    boot("brixhub-search", { searchStatus: "complete" }, (m) => messages.push(m));
    await sleep(1200);
    assert.strictEqual(messages.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 5. Dashboard page
// ---------------------------------------------------------------------------
describe("dashboard", () => {
  const REAL_RESULTS = {
    person: { firstName: "Ada", lastName: "Lovelace", fullName: "Ada Lovelace" },
    results: {
      found: true,
      profiles: [{ text: "Ada Lovelace — Mathematician" }],
      nameMatches: ["Ada Lovelace"],
      pageTitle: "BrixHub | Results"
    },
    scrapedAt: Date.now()
  };

  function boot(storage) {
    const { win } = makeWindow(read("src/dashboard/dashboard.html"), "chrome-extension://test-extension-id/src/dashboard/dashboard.html");
    const fakeCtx = {
      fillStyle: "",
      font: "",
      fillRect() {},
      fillText() {}
    };
    win.HTMLCanvasElement.prototype.getContext = () => fakeCtx;
    const chrome = makeChromeStub({ storage });
    win.chrome = chrome;
    win.eval(DASHBOARD_SRC);
    return { win, chrome };
  }

  test("renders the target, results and status from storage", async () => {
    const { win } = boot({
      currentPerson: REAL_RESULTS.person,
      latestResults: REAL_RESULTS,
      searchStatus: "complete"
    });

    await waitFor(() => win.document.getElementById("statusText").textContent === "INTEL RECEIVED", {
      label: "status rendered"
    });
    assert.strictEqual(win.document.querySelector(".target-name").textContent, "Ada Lovelace");
    assert.ok(win.document.getElementById("resultsFeed").textContent.includes("PROFILE SIGNAL #1"));
    assert.ok(win.document.getElementById("resultsFeed").textContent.includes("Mathematician"));
  });

  test("renders the full BrixHub dossier when present", async () => {
    const dossier = {
      displayName: "ORIANE BONTEMPS",
      sources: ["Colis Privé (2025)", "Ameli (2022)"],
      consolidated: "Profil consolidé depuis 4 sources",
      status: "Recherche terminée : 1 résultat.",
      blocks: {
        Identité: [
          { label: "Nom de famille", value: "BONTEMPS" },
          { label: "Prénom", value: "ORIANE" }
        ],
        Contact: [{ label: "Adresse e-mail", value: "oriane.bontemps@gmail.com" }],
        Adresse: [{ label: "Ville", value: "Toulouse" }]
      },
      familyTree: {
        summary: "60 profils · 30 foyers",
        households: [
          {
            address: "17 RUE LAGANNE",
            meta: ["3 membres"],
            members: [
              { name: "Ghislaine BONTEMPS", email: "ghislaine@icloud.com", phones: ["620775236"], dob: "" }
            ]
          }
        ]
      }
    };

    const { win } = boot({
      currentPerson: REAL_RESULTS.person,
      latestResults: { person: REAL_RESULTS.person, results: { found: true, dossier } },
      searchStatus: "complete"
    });

    await waitFor(() => win.document.querySelector(".dossier-name"), { label: "dossier rendered" });
    const feed = win.document.getElementById("resultsFeed").textContent;

    assert.ok(feed.includes("ORIANE BONTEMPS"), "matched profile name");
    assert.ok(feed.includes("SOURCES (2)"));
    assert.ok(feed.includes("Colis Privé (2025)"));
    assert.ok(feed.includes("IDENTITÉ"));
    assert.ok(feed.includes("Nom de famille"));
    assert.ok(feed.includes("BONTEMPS"));
    assert.ok(feed.includes("oriane.bontemps@gmail.com"));
    assert.ok(feed.includes("Toulouse"));
    assert.ok(feed.includes("FAMILY TREE"));
    assert.ok(feed.includes("60 profils"));
    assert.ok(feed.includes("17 RUE LAGANNE"));
    assert.ok(feed.includes("Ghislaine BONTEMPS"));
    assert.ok(feed.includes("ghislaine@icloud.com"));
    assert.ok(feed.includes("620775236"));
    assert.ok(feed.includes("Recherche terminée"));

    // key/value pairs are rendered as labelled rows
    const kv = Array.from(win.document.querySelectorAll(".kv")).map(
      (el) => el.querySelector(".kv-k").textContent + "=" + el.querySelector(".kv-v").textContent
    );
    assert.deepStrictEqual(kv, [
      "Nom de famille=BONTEMPS",
      "Prénom=ORIANE",
      "Adresse e-mail=oriane.bontemps@gmail.com",
      "Ville=Toulouse"
    ]);
  });

  test("escapes hostile values instead of injecting them", async () => {
    const { win } = boot({
      currentPerson: {
        firstName: "<img src=x onerror=window.__pwned=1>",
        lastName: "Lovelace",
        fullName: "<img src=x onerror=window.__pwned=1> Lovelace"
      },
      searchStatus: "complete"
    });

    await waitFor(() => win.document.querySelector(".target-name"), { label: "target rendered" });
    const target = win.document.getElementById("targetInfo");
    assert.strictEqual(target.querySelectorAll("img").length, 0, "no elements may be injected");
    assert.ok(target.textContent.includes("<img"));
    assert.strictEqual(win.__pwned, undefined);
  });

  test("live storage updates re-render the feed", async () => {
    const { win, chrome } = boot({ searchStatus: "idle" });

    // wait for the initial load to finish rather than the static HTML text
    await waitFor(() => win.document.getElementById("systemLog").textContent.includes("neural link"), {
      label: "dashboard booted"
    });

    await chrome.storage.local.set({
      currentPerson: REAL_RESULTS.person,
      latestResults: REAL_RESULTS,
      searchStatus: "complete"
    });

    await waitFor(() => win.document.querySelector(".target-name"), { label: "target" });
    assert.strictEqual(win.document.querySelector(".target-name").textContent, "Ada Lovelace");
    assert.strictEqual(win.document.getElementById("statusText").textContent, "INTEL RECEIVED");
  });

  test("a slow initial load cannot overwrite fresher live data", async () => {
    // Reproduces the race where loadData() resolves after a storage change.
    const { win, chrome } = boot({ searchStatus: "idle" });

    await chrome.storage.local.set({
      currentPerson: REAL_RESULTS.person,
      searchStatus: "complete"
    });

    // force another load with a stale snapshot
    await chrome.storage.local.set({ searchStatus: "idle" });
    chrome.__store.currentPerson = undefined;
    delete chrome.__store.currentPerson;
    win.document.getElementById("refreshBtn").click();
    await sleep(200);

    assert.strictEqual(
      win.document.querySelector(".target-name"),
      null,
      "the empty re-read must win over the older completed search"
    );
  });

  test("shows a fault panel when the search errored", async () => {
    const { win } = boot({ searchStatus: "error", searchError: "form_not_found" });

    await waitFor(() => win.document.getElementById("statusText").textContent === "SIGNAL LOST", {
      label: "error status"
    });
    const feed = win.document.getElementById("resultsFeed").textContent;
    assert.ok(feed.includes("SEARCH FAULT"));
    assert.ok(feed.includes("form_not_found"));
  });

  test("ESC minimizes and restores the HUD", async () => {
    const { win } = boot({});

    win.document.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await waitFor(() => win.document.body.classList.contains("minimized"), { label: "minimized" });

    win.document.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await waitFor(() => !win.document.body.classList.contains("minimized"), { label: "restored" });
  });

  test("refresh button reloads data", async () => {
    const { win, chrome } = boot({ searchStatus: "idle" });
    await waitFor(() => win.document.getElementById("statusText"), { label: "boot" });

    chrome.__store.searchStatus = "complete";
    win.document.getElementById("refreshBtn").click();

    await waitFor(() => win.document.getElementById("statusText").textContent === "INTEL RECEIVED", {
      label: "refreshed status"
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Popup page
// ---------------------------------------------------------------------------
describe("popup", () => {
  function boot(storage) {
    const { win } = makeWindow(read("src/dashboard/popup.html"), "chrome-extension://test-extension-id/src/dashboard/popup.html");
    const chrome = makeChromeStub({ storage });
    win.chrome = chrome;
    win.eval(POPUP_SRC);
    return { win, chrome };
  }

  test("shows the last target from storage", async () => {
    const { win } = boot({ currentPerson: { fullName: "Ada Lovelace" } });
    await waitFor(
      () => win.document.getElementById("status").textContent.includes("Ada Lovelace"),
      { label: "status text" }
    );
  });

  test("reports ready when there is no data", async () => {
    const { win } = boot({});
    await waitFor(
      () => win.document.getElementById("status").textContent.includes("Ready"),
      { label: "ready text" }
    );
  });

  test("dashboard button messages the background", async () => {
    const { win, chrome } = boot({});
    win.document.getElementById("openDash").click();
    await waitFor(() => chrome.__messages.some((m) => m.type === "OPEN_DASHBOARD"), {
      label: "OPEN_DASHBOARD"
    });
  });
});
