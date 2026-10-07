// Jarvis Network Scanner - LinkedIn Content Script
// Runs on https://www.linkedin.com/mynetwork/grow/

(function () {
  "use strict";

  const HOVER_DELAY_MS = 3000;
  let hoverTimer = null;
  let currentCard = null;
  let overlay = null;
  let overlayCard = null;
  let tracking = false;

  // sendMessage can throw synchronously if the extension was reloaded/removed
  function safeSend(message) {
    try {
      const p = chrome.runtime.sendMessage(message);
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (_) {
      /* extension context invalidated */
    }
  }

  // ---------- Text helpers ----------
  const SKIP_TEXT_TAGS = new Set(["SCRIPT", "STYLE", "SVG", "NOSCRIPT", "TEMPLATE"]);

  // Reads the text a human actually sees. LinkedIn decorates names with badges
  // (Premium star, verified ticks) that live in aria-hidden subtrees and inline
  // <svg>, so a plain textContent yields "Léo Kempf" + junk, or nothing useful
  // when the badge is the only child.
  function visibleText(node) {
    if (!node) return "";
    if (node.nodeType === 3) return node.nodeValue || "";
    if (node.nodeType !== 1) return "";
    if (SKIP_TEXT_TAGS.has(node.tagName)) return "";
    if (typeof node.getAttribute === "function" && node.getAttribute("aria-hidden") === "true") {
      return "";
    }
    let out = "";
    for (const child of node.childNodes) out += visibleText(child);
    return out;
  }

  // ---------- Name Extraction ----------
  const NAME_SELECTORS = [
    ".artdeco-entity-lockup__title",
    ".discover-entity-type-card__name",
    "a[data-control-name='view_profile'] span",
    "a[data-view-name*='profile'][dir='ltr']",
    ".entity-result__title-text a span[aria-hidden='true']",
    ".artdeco-entity-lockup__title span",
    "span.t-16.t-black.t-bold",
    "span.t-14.t-black.t-bold",
    "span.t-18.t-black.t-bold",
    "span[dir='ltr']"
  ];

  // Elements that can hold a person's name. <p> is first-class because the
  // current React card renders the name as <p><span>Name</span></p>.
  const NAME_TEXT_SELECTORS = "p, span, strong, b, h1, h2, h3";

  // UI strings that must never be mistaken for a person's name.
  // LinkedIn is localised, so both English and French variants are listed.
  const NOT_A_NAME = new RegExp(
    "^(" +
      [
        "see all", "show all", "view all", "tout afficher", "afficher", "voir plus",
        "voir tout", "montrer plus",
        "view profile", "voir le profil", "connect", "connect with", "connecter",
        "se connecter", "follow", "suivre", "message", "envoyer", "accept",
        "accepter", "ignore", "ignorer", "more", "plus", "invite", "inviter",
        "sent", "pending", "save", "share", "partager", "comment", "repondre",
        "reply", "like", "post", "next", "previous", "back", "close", "search",
        "filter", "sort", "home", "profil", "reseau", "messagerie", "emploi"
      ].join("|") +
      ")$",
    "i"
  );

  function isNameLike(text) {
    if (!text) return false;
    const t = text.trim();
    if (t.length < 2 || t.length > 80) return false;
    if (NOT_A_NAME.test(t)) return false;
    // Judge the shape on the cleaned form, so that suffixes such as
    // "(she/her)" or ", PhD" do not disqualify an otherwise valid name.
    const cleaned = cleanName(t);
    if (!cleaned) return false;
    if (NOT_A_NAME.test(cleaned)) return false;
    if (!/^[A-Za-zÀ-ÿÀ-ſ'’\-. ]+$/.test(cleaned)) return false;
    return cleaned.split(/\s+/).length >= 1;
  }

  function cleanName(raw) {
    return raw
      .replace(/\s+/g, " ")
      // drop titles: "Lovelace, PhD" / "Hopper, Rear Admiral"
      .replace(/,.*$/, "")
      // drop pronouns / company suffixes: "(she/her)", "(Google)"
      .replace(/\s*\([^)]*\)\s*/g, " ")
      // drop trailing separators
      .replace(/[\s|·,\-–—]+$/, "")
      .trim();
  }

  // French/Belgian convention: many members write their surname first and in
  // capitals ("FIZIR Emy", "DUPONT Marie"). Detect that shape and swap, so
  // firstName/lastName always come out in the right order.
  function isShoutedToken(token) {
    const letters = token.replace(/[^A-Za-zÀ-ÿ]/g, "");
    return letters.length >= 3 && letters === letters.toUpperCase();
  }

  function parseNameParts(fullName) {
    const parts = fullName.split(/\s+/).filter(Boolean);
    if (parts.length < 2) {
      return { firstName: parts[0] || "", lastName: "" };
    }

    // "FIZIR Emy" -> swap. Require the first token to be shouted and at least
    // one later token not to be, otherwise "ADA LOVELACE" stays as-is.
    const swap = isShoutedToken(parts[0]) && parts.slice(1).some((p) => !isShoutedToken(p));

    return swap
      ? { firstName: parts[parts.length - 1], lastName: parts[0] }
      : { firstName: parts[0], lastName: parts[parts.length - 1] };
  }

  function extractNameFromCard(card) {
    if (!card) return null;

    const candidates = [];

    // 1) The profile permalink (/in/<slug>) is the most reliable source when
    //    present. It often only wraps the avatar, so we keep looking if it
    //    yields nothing usable.
    const profileLinks =
      card.matches && card.matches("a[href*='/in/']")
        ? [card]
        : Array.from(card.querySelectorAll("a[href*='/in/']"));

    for (const link of profileLinks) {
      candidates.push(visibleText(link));
      link.querySelectorAll(NAME_TEXT_SELECTORS).forEach((el) => {
        candidates.push(visibleText(el));
      });
    }

    // 2) Dedicated name elements, most specific first. Generic ones such as
    //    span[dir=ltr] also match headlines and subtitles, so they come last.
    for (const sel of NAME_SELECTORS) {
      let el = null;
      try {
        el = card.querySelector(sel);
      } catch (_) {
        continue;
      }
      if (el) candidates.push(visibleText(el));
    }

    // 3) Structural fallback: the name is the shortest human-readable text in
    //    the card. Headlines and blurbs are much longer and are rejected by the
    //    length cap; badges/icons contribute no visible text.
    //    <p> is scanned first because LinkedIn renders the name in a paragraph,
    //    before the headline paragraph.
    const paragraphs = Array.from(card.querySelectorAll("p"));
    for (const el of paragraphs) candidates.push(visibleText(el));

    for (const el of card.querySelectorAll(NAME_TEXT_SELECTORS)) {
      if (el.closest("p")) continue; // already covered above
      candidates.push(visibleText(el));
    }

    let fallback = null;
    for (const raw of candidates) {
      if (!isNameLike(raw)) continue;
      const fullName = cleanName(raw);
      if (!fullName) continue;

      const parts = fullName.split(/\s+/).filter(Boolean);
      if (parts.length === 0) continue;
      if (parts[0].length < 2) continue;

      const { firstName, lastName } = parseNameParts(fullName);

      const person = {
        firstName,
        lastName,
        fullName: [firstName, lastName].filter(Boolean).join(" "),
        original: fullName
      };

      // Prefer a first+last name; keep the shortest single-token match only as
      // a fallback, so a stray short word cannot outrank a real full name.
      if (parts.length > 1) return person;
      if (!fallback || fullName.length < fallback.original.length) fallback = person;
    }

    return fallback;
  }

  // ---------- Hover Handling ----------
  function clearHover() {
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
    const wasTracking = tracking;
    tracking = false;
    currentCard = null;
    removeOverlay();
    if (wasTracking) safeSend({ type: "PERSON_HOVER_END" });
  }

  function onCardEnter(card) {
    if (currentCard === card) return;
    clearHover();
    currentCard = card;
    tracking = true;

    // Visual feedback immediately
    showOverlay(card, "SCANNING...", false);

    safeSend({ type: "PERSON_HOVER_START" });

    hoverTimer = setTimeout(() => {
      if (currentCard !== card || !tracking) return;

      const person = extractNameFromCard(card);
      if (!person) {
        showOverlay(card, "NAME NOT DETECTED", true);
        safeSend({ type: "SEARCH_FAILED", payload: { reason: "name_not_detected" } });
        return;
      }

      showOverlay(card, `TARGET LOCKED: ${person.fullName}`, false, true);

      // Notify background
      safeSend({
        type: "PERSON_CONFIRMED",
        payload: person
      });

      // Also store locally for quick access
      try {
        chrome.storage.local.set({ lastHoveredPerson: person });
      } catch (_) {}
    }, HOVER_DELAY_MS);
  }

  function onCardLeave(card) {
    if (currentCard === card) {
      clearHover();
    }
  }

  // ---------- Visual Overlay (Matrix/Jarvis style) ----------
  function showOverlay(card, text, isError = false, isLocked = false) {
    removeOverlay();

    overlay = document.createElement("div");
    overlay.className = "jarvis-hover-overlay";
    if (isError) overlay.classList.add("error");
    if (isLocked) overlay.classList.add("locked");

    const scanline = document.createElement("div");
    scanline.className = "jarvis-scanline";
    const textEl = document.createElement("div");
    textEl.className = "jarvis-text";
    textEl.textContent = text; // never inject page text as HTML
    const progress = document.createElement("div");
    progress.className = "jarvis-progress";

    overlay.appendChild(scanline);
    overlay.appendChild(textEl);
    overlay.appendChild(progress);

    // Position relative to the card using viewport coordinates
    // (position: fixed => no window.scrollY offset)
    overlayCard = card;
    positionOverlay();
    window.addEventListener("scroll", positionOverlay, { passive: true });
    window.addEventListener("resize", positionOverlay);

    document.body.appendChild(overlay);

    // Animate progress bar during the 3s wait
    if (!isLocked && !isError) {
      progress.style.transition = `width ${HOVER_DELAY_MS}ms linear`;
      requestAnimationFrame(() => {
        progress.style.width = "100%";
      });
    }
  }

  function positionOverlay() {
    if (!overlay || !overlayCard) return;
    const rect = overlayCard.getBoundingClientRect();
    overlay.style.position = "fixed";
    overlay.style.top = `${rect.top - 8}px`;
    overlay.style.left = `${rect.left - 8}px`;
    overlay.style.width = `${rect.width + 16}px`;
    overlay.style.height = `${rect.height + 16}px`;
    overlay.style.pointerEvents = "none";
    overlay.style.zIndex = "999999";
  }

  function removeOverlay() {
    if (overlay && overlay.parentNode) {
      overlay.parentNode.removeChild(overlay);
    }
    overlay = null;
    overlayCard = null;
    window.removeEventListener("scroll", positionOverlay);
    window.removeEventListener("resize", positionOverlay);
  }

  // ---------- Card Detection ----------
  // LinkedIn renames its CSS classes constantly (the current React UI ships
  // hashed classes such as "dj9mgo dj9ia0 …") and some cards contain no /in/
  // permalink at all, so class names and links alone are not enough. We seed on
  // the things that actually identify a person card - an avatar image, a
  // profile permalink, or the "open to new opportunities" label - then walk up
  // to the smallest container that holds both an avatar and a readable name.
  const CARD_CONTAINER_SELECTORS = [
    ".discover-entity-type-card",
    ".artdeco-card",
    "li.artdeco-list__item",
    ".entity-result",
    "[data-view-name*='people-search-result']",
    ".scaffold-finite-scroll__content > ul > li",
    ".mn-discovery-person-card",
    ".invitation-card",
    "[data-occludable-job-id]"
  ];

  const CARD_SEED_SELECTORS = [
    "a[href*='/in/']",
    "img[src*='licdn.com']",
    "img[src*='media.licdn']",
    "figure img",
    // "… est à l'écoute de nouvelles opportunités" / "… is open to new
    // opportunities" - present on person cards in both languages.
    "[aria-label*='opportunit']"
  ];

  const AVATAR_SELECTOR = "img[src*='licdn.com'], img[src*='media.licdn'], figure img";

  function looksLikeCard(el) {
    return CARD_CONTAINER_SELECTORS.some((sel) => {
      try {
        return el.matches(sel);
      } catch (_) {
        return false;
      }
    });
  }

  function hasAvatar(el) {
    try {
      return Boolean(el.querySelector(AVATAR_SELECTOR));
    } catch (_) {
      return false;
    }
  }

  // A card must not be a wrapper around many people, or the hover overlay
  // would cover the whole grid.
  function aggregatesManyPeople(el) {
    try {
      const avatars = el.querySelectorAll(AVATAR_SELECTOR).length;
      if (avatars > 4) return true;
      const permalinks = el.querySelectorAll("a[href*='/in/']").length;
      return permalinks > 4;
    } catch (_) {
      return true;
    }
  }

  function closestCard(seed) {
    let node = seed;
    for (let depth = 0; depth < 8 && node && node !== document.body; depth++) {
      if (looksLikeCard(node)) return node;

      // The first ancestor that also holds an avatar is the card itself.
      if (node !== seed && hasAvatar(node)) {
        if (aggregatesManyPeople(node)) return null;
        if (extractNameFromCard(node) !== null) return node;
      }

      node = node.parentElement;
    }
    return null;
  }

  function findPersonCards() {
    const cards = new Set();

    // 1) seed on avatars / permalinks / person labels, then walk up
    for (const sel of CARD_SEED_SELECTORS) {
      let seeds = [];
      try {
        seeds = document.querySelectorAll(sel);
      } catch (_) {
        continue;
      }
      seeds.forEach((seed) => {
        const card = closestCard(seed);
        if (card) cards.add(card);
      });
    }

    // 2) keep known card containers that hold an avatar or a profile link
    CARD_CONTAINER_SELECTORS.forEach((sel) => {
      let matches = [];
      try {
        matches = document.querySelectorAll(sel);
      } catch (_) {
        return;
      }
      matches.forEach((el) => {
        if (el.querySelector("img") || el.querySelector("a[href*='/in/']")) {
          cards.add(el);
        }
      });
    });

    return Array.from(cards).filter(
      // A real card must be able to yield a name.
      (el) => el && extractNameFromCard(el) !== null
    );
  }

  function attachListeners() {
    const cards = findPersonCards();
    cards.forEach((card) => {
      if (card.dataset.jarvisBound) return;
      card.dataset.jarvisBound = "true";

      card.addEventListener("mouseenter", () => onCardEnter(card));
      card.addEventListener("mouseleave", () => onCardLeave(card));
    });
  }

  // Expose for tests (only when the harness pre-defines the hooks object)
  if (typeof globalThis.__jarvisTestHooks === "object") {
    globalThis.__jarvisTestHooks.linkedin = {
      extractNameFromCard,
      findPersonCards,
      attachListeners
    };
  }

  // ---------- Mutation Observer (LinkedIn is SPA) ----------
  const observer = new MutationObserver(() => {
    attachListeners();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  // Initial attach
  attachListeners();

  // Also re-scan periodically in case of virtual scrolling
  setInterval(attachListeners, 2500);

  console.log("[Jarvis] LinkedIn content script active. Hover any person card for 3s.");
})();
