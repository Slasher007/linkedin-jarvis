// Jarvis Network Scanner - BrixHub Content Script
// Runs on https://brixhub.to/*

(function () {
  "use strict";

  console.log("[Jarvis] BrixHub content script loaded.");

  const POLL_INTERVAL_MS = 1000;
  const POLL_TIMEOUT_MS = 12000;
  const FORM_RETRY_MS = 800;

  let inFlight = false;
  let activeSearchId = null;

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function safeSend(message) {
    try {
      const p = chrome.runtime.sendMessage(message);
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (_) {
      /* extension context invalidated */
    }
  }

  async function init() {
    if (inFlight) return;

    const data = await chrome.storage.local.get([
      "currentPerson",
      "searchStatus",
      "searchId",
      "searchPhase"
    ]);

    if (!data.currentPerson || data.searchStatus !== "searching") {
      console.log("[Jarvis] No pending search.");
      return;
    }

    const searchId = data.searchId ?? 0;

    // Same search already processed on this page
    if (searchId === activeSearchId) return;
    activeSearchId = searchId;

    inFlight = true;
    try {
      await runSearch(data);
    } catch (err) {
      console.error("[Jarvis] Search error:", err);
      safeSend({
        type: "SEARCH_FAILED",
        payload: { reason: err && err.message ? err.message : "unknown" }
      });
    } finally {
      inFlight = false;
    }
  }

  async function runSearch(data) {
    const { firstName, lastName, fullName } = data.currentPerson;
    console.log(`[Jarvis] Auto-searching: ${fullName}`);

    // Phase "submitted" means this page load is the (possibly post-navigation)
    // result page of an already-submitted search -> only scrape, never refill.
    if (data.searchPhase !== "submitted") {
      await sleep(FORM_RETRY_MS);

      const fillStatus = await fillAndSearch(firstName, lastName);

      if (fillStatus !== "ok") {
        console.warn("[Jarvis] Could not fill search form:", fillStatus);
        safeSend({
          type: "SEARCH_FAILED",
          payload: { reason: fillStatus }
        });
        return;
      }

      try {
        await chrome.storage.local.set({ searchPhase: "submitted" });
      } catch (_) {}
    }

    const scraped = await pollForResults(fullName);

    safeSend({
      type: "BRIXHUB_RESULTS",
      payload: {
        person: data.currentPerson,
        results: scraped,
        scrapedAt: Date.now(),
        url: window.location.href
      }
    });
    console.log("[Jarvis] Results reported:", scraped.found);
  }

  async function pollForResults(fullName) {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let results = scrapeResults(fullName);

    while (!results.found && Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      results = scrapeResults(fullName);
    }

    return results;
  }

  // ---------- Field resolution ----------
  // BrixHub renders its two name inputs in the order LAST then FIRST, so a
  // naive "first input = first name" assumption swaps the values.
  // Prefer explicit labels; fall back to POSITIONAL_FALLBACK_ORDER.
  const POSITIONAL_FALLBACK_ORDER = ["last", "first"];

  const FIELD_HINTS = {
    first: [
      "first",
      "firstname",
      "first-name",
      "first_name",
      "given",
      "given-name",
      "givenname",
      "prénom",
      "prenom",
      "prénom",
      "fore",
      "forename"
    ],
    last: [
      "last",
      "lastname",
      "last-name",
      "last_name",
      "family",
      "family-name",
      "familyname",
      "surname",
      "nom",
      "nom de famille"
    ]
  };

  const FIELD_SOURCES = ["name", "id", "placeholder", "aria-label", "autocomplete", "data-testid"];

  // BrixHub's identity block also contains "Nom de naissance" and "Nom affiché".
  // Those are decoys: neither is the family-name search field, so they must
  // never win the label match.
  const FIELD_DENYLIST = [
    "nom de naissance",
    "nom_naissance",
    "nomnaissance",
    "nom affiche",
    "nom_affichage",
    "nomaffichage",
    "nom complet",
    "nom_affiche"
  ];

  const STRONG_FIELD_SELECTORS = {
    first: [
      'input[name="first_name"]',
      'input[name="firstname"]',
      'input[name="firstName"]',
      'input[autocomplete="given-name"]'
    ],
    last: [
      'input[name="last_name"]',
      'input[name="lastname"]',
      'input[name="lastName"]',
      'input[autocomplete="family-name"]'
    ]
  };

  function normalizeFieldText(value) {
    return String(value || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "") // strip accents so "prénom" matches "prenom"
      .trim();
  }

  // Text that identifies an input: its attributes plus any associated <label>.
  function fieldSignature(input) {
    const parts = [];
    for (const attr of FIELD_SOURCES) {
      const v = input.getAttribute && input.getAttribute(attr);
      if (v) parts.push(normalizeFieldText(v));
    }

    // <label for="…">, a wrapping <label>, or aria-labelledby
    try {
      if (input.labels && input.labels.length) {
        for (const label of input.labels) parts.push(normalizeFieldText(label.textContent));
      } else if (input.id) {
        const label = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
        if (label) parts.push(normalizeFieldText(label.textContent));
      } else {
        const wrapper = input.closest("label");
        if (wrapper) parts.push(normalizeFieldText(wrapper.textContent));
      }
    } catch (_) {}

    return parts.join(" ");
  }

  function classifyField(input) {
    const sig = fieldSignature(input);
    if (!sig) return null;

    // Reject decoy fields outright ("Nom de naissance", "Nom affiché", …)
    if (FIELD_DENYLIST.some((d) => sig.includes(d))) return null;

    const matches = (kind) =>
      FIELD_HINTS[kind].some((hint) => {
        const h = normalizeFieldText(hint);
        // Whole-token match first so "nom" does not swallow "prénom"
        return new RegExp(`(^|[^a-z])${h}([^a-z]|$)`).test(sig) || sig === h;
      });

    const isFirst = matches("first");
    const isLast = matches("last");

    if (isFirst && !isLast) return "first";
    if (isLast && !isFirst) return "last";
    return null; // ambiguous or unlabelled
  }

  function visibleTextInputs() {
    return Array.from(
      document.querySelectorAll('input[type="text"], input:not([type]), input[type="search"]')
    ).filter(isVisible);
  }

  function resolveNameFields() {
    const found = { first: null, last: null };

    // 1) strong selectors (name/autocomplete) - unambiguous
    for (const kind of ["first", "last"]) {
      for (const sel of STRONG_FIELD_SELECTORS[kind]) {
        let el = null;
        try {
          el = document.querySelector(sel);
        } catch (_) {
          continue;
        }
        if (el && isVisible(el) && el !== found.first && el !== found.last) {
          found[kind] = el;
          break;
        }
      }
    }

    // 2) labels / attributes
    if (!found.first || !found.last) {
      for (const input of visibleTextInputs()) {
        if (input === found.first || input === found.last) continue;
        const kind = classifyField(input);
        if (kind && !found[kind]) found[kind] = input;
      }
    }

    // 3) positional fallback in the site's real order (last, then first)
    const inputs = visibleTextInputs();
    for (const kind of POSITIONAL_FALLBACK_ORDER) {
      if (found[kind]) continue;
      const candidate = inputs.find((el) => el !== found.first && el !== found.last);
      if (candidate) found[kind] = candidate;
    }

    return found;
  }

  async function fillAndSearch(firstName, lastName) {
    const { first: firstInput, last: lastInput } = resolveNameFields();

    if (!firstInput && !lastInput) {
      return "form_not_found";
    }

    // Two fields -> split first/last; a single field gets the full name.
    const single = !firstInput || !lastInput;
    const only = firstInput || lastInput;
    const hasLast = Boolean(lastName);

    if (single) {
      const full = hasLast ? `${firstName} ${lastName}` : firstName;
      setNativeValue(only, full);
      fireInputEvents(only);
    } else {
      if (hasLast) {
        setNativeValue(firstInput, firstName);
        fireInputEvents(firstInput);
        setNativeValue(lastInput, lastName);
        fireInputEvents(lastInput);
      } else {
        // mononym: put it in the first-name slot
        setNativeValue(firstInput, firstName);
        fireInputEvents(firstInput);
      }
    }

    await sleep(300);

    const form = firstInput.closest("form");
    const submitBtn = findSubmitButton(form);

    if (submitBtn) {
      activateButton(submitBtn);
    } else if (form && typeof form.requestSubmit === "function") {
      form.requestSubmit();
    } else if (form) {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    } else {
      const target = lastInput || firstInput;
      target.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true })
      );
      target.dispatchEvent(
        new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true })
      );
    }

    console.log("[Jarvis] Search submitted.");
    return "ok";
  }

  function fireInputEvents(el) {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // BrixHub renders its primary action as
  //   <button type="submit" class="brix-btn brix-btn--primary">…Rechercher</button>
  // and that button is not guaranteed to live inside the <form> (the app is a
  // React SPA), so the form scope alone is not enough.
  const SUBMIT_SELECTORS = [
    "button[type='submit']",
    "input[type='submit']",
    "[class*='brix-btn--primary']",
    "[class*='brix-btn']",
    "[class*='search-button']",
    "[class*='search-btn']",
    "button[aria-label*='search' i]",
    "button[aria-label*='rechercher' i]",
    "button:not([type])"
  ];

  const SUBMIT_LABELS =
    /^(rechercher|rechercher\s+la\s+recherche|search|search\s+people|lancer\s+la\s+recherche|submit|go|find|voir)$/i;

  function safeQuery(scope, selector) {
    try {
      return scope.querySelector(selector);
    } catch (_) {
      return null;
    }
  }

  function isUsable(el) {
    return Boolean(el) && isVisible(el) && !el.disabled && el.getAttribute("aria-hidden") !== "true";
  }

  function findSubmitButton(form) {
    // Prefer the form's own control, then fall back to the whole document.
    const scopes = form ? [form, document] : [document];

    for (const scope of scopes) {
      for (const sel of SUBMIT_SELECTORS) {
        const found = safeQuery(scope, sel);
        if (isUsable(found)) return found;
      }
    }

    // Fall back to the visible control whose label says "search".
    for (const scope of scopes) {
      let controls = [];
      try {
        controls = Array.from(
          scope.querySelectorAll("button, [role='button'], input[type='button'], input[type='submit']")
        );
      } catch (_) {
        continue;
      }
      const byLabel = controls.find((el) => isUsable(el) && SUBMIT_LABELS.test(textOf(el)));
      if (byLabel) return byLabel;
    }

    return null;
  }

  // A bare .click() is enough for React (it delegates from the root), but some
  // widgets only act on the pointer sequence, so fire that first.
  function activateButton(btn) {
    const init = { bubbles: true, cancelable: true, view: window };
    try {
      btn.dispatchEvent(new PointerEvent("pointerdown", init));
    } catch (_) {
      /* PointerEvent unavailable */
    }
    try {
      btn.dispatchEvent(new MouseEvent("mousedown", init));
      btn.dispatchEvent(new MouseEvent("mouseup", init));
    } catch (_) {}
    btn.click();
  }

  function setNativeValue(element, value) {
    const prototype = Object.getPrototypeOf(element);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (descriptor && descriptor.set) {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
  }

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0" &&
      el.offsetWidth > 0 &&
      el.offsetHeight > 0
    );
  }

  // ---------- BrixHub structured extraction ----------
  // BrixHub renders a rich dossier (identity, contact, address, professional
  // blocks, source badges and a family tree). Extract it as structured data so
  // the dashboard can report every field that is present.

  function pairSections(scope) {
    const blocks = {};
    scope.querySelectorAll("section").forEach((section) => {
      const headingEl = section.querySelector("h2, h3, p");
      const heading = headingEl ? textOf(headingEl) : "";
      const pairs = [];
      section.querySelectorAll("dt").forEach((dt) => {
        const dd = dt.nextElementSibling;
        if (dd && dd.tagName === "DD") {
          const label = textOf(dt);
          const value = textOf(dd);
          if (label && value) pairs.push({ label, value });
        }
      });
      if (heading && pairs.length) blocks[heading] = pairs;
    });
    return blocks;
  }

  function extractSources(article) {
    const seen = new Set();
    const sources = [];
    article.querySelectorAll("span.rounded-full[title], span[title]").forEach((el) => {
      const title = (el.getAttribute("title") || "").trim();
      if (!title || seen.has(title)) return;
      // ignore non-source tooltips ("Personnes liées à ce numéro", …)
      if (/personnes li|supprimer|copier|approfondir|graphe/i.test(title)) return;
      seen.add(title);
      sources.push(title);
    });
    return sources;
  }

  function extractMember(li) {
    const nameEl = li.querySelector("p");
    const name = nameEl ? textOf(nameEl) : "";
    const spans = Array.from(li.querySelectorAll("span")).map((s) => textOf(s));
    const email = spans.find((s) => s.includes("@")) || "";
    const phones = Array.from(li.querySelectorAll("button"))
      .map((b) => textOf(b))
      .filter((t) => /^[+(\s]*\d[\d\s]{5,}$/.test(t));
    const dob = spans.find((s) => /^\d{4}-\d{2}-\d{2}$/.test(s)) || "";
    return { name, email, phones, dob };
  }

  function extractFamilyTree(root) {
    const section = Array.from(root.querySelectorAll("section")).find((s) =>
      /arbre familial|family tree/i.test(textOf(s.querySelector("h2, p, span")))
    );
    if (!section) return null;

    const households = [];
    section.querySelectorAll("article").forEach((art) => {
      const titleEl = art.querySelector("p");
      const address = titleEl ? textOf(titleEl) : "";
      const meta = Array.from(art.querySelectorAll("span"))
        .map((s) => textOf(s))
        .filter((t) => /membre|même adresse|téléphone partagé|adresse inconnue/i.test(t));
      const members = Array.from(art.querySelectorAll("li")).map(extractMember);
      if (address || members.length) {
        households.push({ address, meta: [...new Set(meta)], members });
      }
    });

    const counts = Array.from(section.querySelectorAll("span, p"))
      .map((s) => textOf(s))
      .find((t) => /\d+\s+profils?\s*[·•]/.test(t));

    return { summary: counts || "", households };
  }

  function extractDossier() {
    const article =
      document.querySelector("article.brix-result") ||
      document.querySelector("article[class*='result']");
    if (!article) return null;

    const headingEl = article.querySelector("h3, h2");
    const consolidated = Array.from(article.querySelectorAll("span"))
      .map((s) => textOf(s))
      .find((t) => /consolid/i.test(t));

    const statusEl = document.querySelector("p[role='status']");

    return {
      displayName: headingEl ? textOf(headingEl) : "",
      sources: extractSources(article),
      consolidated: consolidated || "",
      blocks: pairSections(article),
      familyTree: extractFamilyTree(document),
      status: statusEl ? textOf(statusEl) : ""
    };
  }

  function textOf(el) {
    // innerText is layout-dependent and unavailable in some engines;
    // textContent is always safe.
    return ((el && el.innerText) || (el && el.textContent) || "").trim();
  }

  function scrapeResults(searchedName) {
    // Generic scraper – adapt once we know the exact structure of brixhub.to
    const results = {
      searchedName,
      found: false,
      profiles: [],
      rawText: textOf(document.body).slice(0, 5000),
      pageTitle: document.title
    };

    const candidates = Array.from(
      document.querySelectorAll(
        ".result, .profile-card, .search-result, [class*='result'], [class*='card'], article, .person"
      )
    );

    // Keep only leaf nodes: drop any container that holds another candidate
    // (otherwise a single wrapper card yields dozens of duplicates).
    const cards = candidates.filter(
      (el) => !candidates.some((other) => other !== el && el.contains(other))
    );

    cards.forEach((card, idx) => {
      if (idx > 15) return; // limit
      const text = textOf(card);
      if (text.length < 10) return;

      results.profiles.push({
        text: text.slice(0, 800),
        htmlSnippet: card.outerHTML.slice(0, 1200)
      });
      results.found = true;
    });

    // Also capture any highlighted name matches
    const nameMatches = Array.from(
      document.querySelectorAll("h1, h2, h3, strong, b, .name, [class*='name']")
    )
      .map((el) => textOf(el))
      .filter((t) => t.length > 2 && t.length < 80);

    results.nameMatches = [...new Set(nameMatches)].slice(0, 10);

    // Structured dossier, when the page exposes one.
    results.dossier = extractDossier();
    if (results.dossier && results.dossier.displayName) {
      results.found = true;
    }

    return results;
  }

  // Expose for tests
  if (typeof globalThis.__jarvisTestHooks === "object") {
    globalThis.__jarvisTestHooks.brixhub = { scrapeResults, fillAndSearch, init };
  }

  // Start
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Also listen for storage changes (in case the page was already open)
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.currentPerson || changes.searchStatus || changes.searchId) {
      init();
    }
  });
})();
