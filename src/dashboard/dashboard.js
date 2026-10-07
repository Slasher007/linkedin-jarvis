// Jarvis Dashboard Controller

(function () {
  "use strict";

  const statusDot = document.getElementById("statusDot");
  const statusText = document.getElementById("statusText");
  const clockEl = document.getElementById("clock");
  const targetInfo = document.getElementById("targetInfo");
  const resultsFeed = document.getElementById("resultsFeed");
  const systemLog = document.getElementById("systemLog");
  const lastUpdate = document.getElementById("lastUpdate");
  const refreshBtn = document.getElementById("refreshBtn");

  // ---------- Matrix Rain ----------
  function initMatrix() {
    const container = document.getElementById("matrixBg");
    const canvas = document.createElement("canvas");
    container.appendChild(canvas);
    const ctx = canvas.getContext("2d");

    const chars = "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン0123456789ABCDEF";
    const fontSize = 14;
    let drops = [];

    function rebuild() {
      const columns = Math.max(1, Math.floor(canvas.width / fontSize));
      drops = Array(columns).fill(1);
    }
    rebuild();

    function resize() {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      rebuild();
    }
    resize();
    window.addEventListener("resize", resize);

    function draw() {
      ctx.fillStyle = "rgba(2, 8, 6, 0.05)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.fillStyle = "#00ff9f";
      ctx.font = fontSize + "px monospace";

      for (let i = 0; i < drops.length; i++) {
        const text = chars[Math.floor(Math.random() * chars.length)];
        ctx.fillText(text, i * fontSize, drops[i] * fontSize);

        if (drops[i] * fontSize > canvas.height && Math.random() > 0.975) {
          drops[i] = 0;
        }
        drops[i]++;
      }
    }

    setInterval(draw, 50);
  }

  // ---------- Clock ----------
  function updateClock() {
    const now = new Date();
    clockEl.textContent = now.toLocaleTimeString("en-GB", { hour12: false });
  }
  setInterval(updateClock, 1000);
  updateClock();

  // ---------- Logging ----------
  function log(msg, type = "") {
    const line = document.createElement("div");
    line.className = "log-line " + type;
    const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
    line.textContent = `> [${time}] ${msg}`;
    systemLog.appendChild(line);
    systemLog.scrollTop = systemLog.scrollHeight;

    // Keep log reasonable
    while (systemLog.children.length > 80) {
      systemLog.removeChild(systemLog.firstChild);
    }
  }

  // ---------- Render Target ----------
  function renderTarget(person) {
    if (!person) {
      targetInfo.innerHTML = `<div class="placeholder">Awaiting target lock...</div>`;
      return;
    }

    targetInfo.innerHTML = `
      <div class="target-name">${escapeHtml(person.fullName || (person.firstName + " " + person.lastName))}</div>
      <div class="target-field">
        <span class="target-label">FIRST</span>
        <span class="target-value">${escapeHtml(person.firstName)}</span>
      </div>
      <div class="target-field">
        <span class="target-label">LAST</span>
        <span class="target-value">${escapeHtml(person.lastName)}</span>
      </div>
      <div class="target-field">
        <span class="target-label">ORIGINAL</span>
        <span class="target-value">${escapeHtml(person.original || "—")}</span>
      </div>
    `;
  }

  // ---------- Render Results ----------
  let lastStatus = null;
  let lastError = null;
  let lastResults = null;

  function renderResults(data) {
    if (!data || !data.results) {
      if (lastStatus === "error") {
        resultsFeed.innerHTML = `
          <div class="no-results">
            ⚠ SEARCH FAULT<br>
            <strong>${escapeHtml(lastError || "unknown")}</strong>
          </div>
        `;
      } else {
        resultsFeed.innerHTML = `<div class="placeholder">No data stream active.</div>`;
      }
      return;
    }

    const { results, person } = data;

    if (!results.found && (!results.profiles || results.profiles.length === 0)) {
      resultsFeed.innerHTML = `
        <div class="no-results">
          ⚠ NO INTEL FOUND FOR<br>
          <strong>${escapeHtml(person?.fullName || "UNKNOWN")}</strong>
        </div>
        <div class="result-card">
          <h3>RAW PAGE TITLE</h3>
          <p>${escapeHtml(results.pageTitle || "—")}</p>
        </div>
      `;
      return;
    }

    let html = "";

    // Structured BrixHub dossier: every block the page exposed.
    if (results.dossier) {
      const d = results.dossier;

      if (d.status || d.consolidated) {
        html += `<div class="result-card"><h3>SEARCH STATUS</h3><p>${
          escapeHtml([d.status, d.consolidated].filter(Boolean).join(" — "))
        }</p></div>`;
      }

      if (d.displayName) {
        html += `<div class="result-card"><h3>MATCH</h3><p class="dossier-name">${escapeHtml(
          d.displayName
        )}</p></div>`;
      }

      if (d.sources && d.sources.length) {
        html += `<div class="result-card"><h3>SOURCES (${d.sources.length})</h3><p>${d.sources
          .map(escapeHtml)
          .join(" • ")}</p></div>`;
      }

      Object.entries(d.blocks || {}).forEach(([heading, pairs]) => {
        const rows = pairs
          .map(
            (p) =>
              `<div class="kv"><span class="kv-k">${escapeHtml(p.label)}</span><span class="kv-v">${escapeHtml(
                p.value
              )}</span></div>`
          )
          .join("");
        html += `<div class="result-card"><h3>${escapeHtml(
          heading.toUpperCase()
        )}</h3>${rows}</div>`;
      });

      if (d.familyTree && d.familyTree.households && d.familyTree.households.length) {
        const households = d.familyTree.households
          .map((h) => {
            const meta = (h.meta || []).join(" • ");
            const members = (h.members || [])
              .map((m) => {
                const bits = [m.name, m.dob, m.email, (m.phones || []).join(" / ")]
                  .filter(Boolean)
                  .map(escapeHtml)
                  .join(" — ");
                return `<li>${bits || "—"}</li>`;
              })
              .join("");
            return `<div class="household">
              <p class="household-addr">${escapeHtml(h.address || "Adresse inconnue")}</p>
              ${meta ? `<p class="household-meta">${escapeHtml(meta)}</p>` : ""}
              <ul class="household-members">${members}</ul>
            </div>`;
          })
          .join("");

        html += `<div class="result-card"><h3>FAMILY TREE${
          d.familyTree.summary ? ` — ${escapeHtml(d.familyTree.summary)}` : ""
        }</h3>${households}</div>`;
      }
    }

    if (results.nameMatches && results.nameMatches.length) {
      html += `<div class="result-card"><h3>NAME MATCHES</h3><p>${results.nameMatches.map(escapeHtml).join(" • ")}</p></div>`;
    }

    (results.profiles || []).forEach((p, i) => {
      html += `
        <div class="result-card">
          <h3>PROFILE SIGNAL #${i + 1}</h3>
          <p>${escapeHtml(p.text)}</p>
        </div>
      `;
    });

    resultsFeed.innerHTML = html || `<div class="placeholder">Empty feed.</div>`;
  }

  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ---------- Status ----------
  function setStatus(status) {
    lastStatus = status;
    statusDot.className = "status-dot";
    if (status === "searching") {
      statusDot.classList.add("searching");
      statusText.textContent = "SCANNING BRIXHUB...";
    } else if (status === "complete") {
      statusText.textContent = "INTEL RECEIVED";
    } else if (status === "error") {
      statusDot.classList.add("error");
      statusText.textContent = "SIGNAL LOST";
    } else {
      statusText.textContent = "SYSTEM ONLINE";
    }
  }

  // ---------- Load Data ----------
  let loadSeq = 0;

  async function loadData() {
    const seq = ++loadSeq;
    try {
      const data = await chrome.storage.local.get([
        "currentPerson",
        "latestResults",
        "searchStatus",
        "searchError",
        "lastUpdated"
      ]);

      // A live storage update arrived while we were reading: it has already
      // rendered fresher data, so this (now stale) response must not win.
      if (seq !== loadSeq) return;

      renderTarget(data.currentPerson);
      setStatus(data.searchStatus || "idle");
      lastError = data.searchError || null;
      lastResults = data.latestResults;
      renderResults(lastResults);

      if (data.searchError) {
        log(`Fault reported: ${data.searchError}`, "error");
      }

      if (data.lastUpdated) {
        const d = new Date(data.lastUpdated);
        lastUpdate.textContent = "LAST UPDATE: " + d.toLocaleTimeString("en-GB", { hour12: false });
      }

      if (data.currentPerson) {
        log(`Target: ${data.currentPerson.fullName}`, "info");
      }
      if (data.latestResults) {
        log("Intel package received.", "info");
      }
    } catch (err) {
      log("Storage read failed: " + err.message, "error");
    }
  }

  // ---------- Listen for live updates ----------
  chrome.storage.onChanged.addListener((changes) => {
    loadSeq++; // invalidate any in-flight loadData()
    if (changes.currentPerson) {
      renderTarget(changes.currentPerson.newValue);
      log(`New target locked: ${changes.currentPerson.newValue?.fullName || "?"}`, "info");
    }
    if (changes.latestResults) {
      lastResults = changes.latestResults.newValue;
      renderResults(lastResults);
      log("Fresh intel received from BrixHub.", "info");
    }
    if (changes.searchStatus) {
      setStatus(changes.searchStatus.newValue);
      renderResults(lastResults);
      if (changes.searchStatus.newValue === "searching") {
        log("Initiating BrixHub query...", "warn");
      } else if (changes.searchStatus.newValue === "error") {
        log("Search fault detected.", "error");
      }
    }
    if (changes.searchError) {
      lastError = changes.searchError.newValue || null;
      renderResults(lastResults);
      if (lastError) {
        log(`Fault: ${lastError}`, "error");
      }
    }
    if (changes.lastUpdated) {
      const d = new Date(changes.lastUpdated.newValue);
      lastUpdate.textContent = "LAST UPDATE: " + d.toLocaleTimeString("en-GB", { hour12: false });
    }
  });

  refreshBtn.addEventListener("click", () => {
    log("Manual refresh requested.", "info");
    loadData();
  });

  // ---------- ESC to minimize / restore ----------
  function toggleMinimize() {
    const minimized = document.body.classList.toggle("minimized");
    log(minimized ? "HUD minimized." : "HUD restored.", "info");
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      toggleMinimize();
    }
  });

  const restoreChip = document.getElementById("restoreChip");
  if (restoreChip) restoreChip.addEventListener("click", toggleMinimize);

  // ---------- Boot ----------
  initMatrix();
  loadData();
  log("Dashboard neural link established.", "info");
})();
