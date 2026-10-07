// Jarvis Network Scanner - Background Service Worker

const HOVER_THRESHOLD_MS = 3000;

// Store current target person
let currentTarget = null;

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case "PERSON_HOVER_START":
      handleHoverStart(message.payload, sender.tab?.id);
      sendResponse({ status: "tracking" });
      break;

    case "PERSON_HOVER_END":
      handleHoverEnd();
      sendResponse({ status: "cancelled" });
      break;

    case "PERSON_CONFIRMED":
      handlePersonConfirmed(message.payload, sender.tab?.id);
      sendResponse({ status: "searching" });
      break;

    case "BRIXHUB_RESULTS":
      handleBrixHubResults(message.payload);
      sendResponse({ status: "received" });
      break;

    case "SEARCH_FAILED":
      handleSearchFailed(message.payload);
      sendResponse({ status: "error" });
      break;

    case "GET_LATEST_RESULTS":
      chrome.storage.local.get(["latestResults", "currentPerson"], (data) => {
        sendResponse(data);
      });
      return true; // keep channel open for async

    case "OPEN_DASHBOARD":
      openDashboard();
      sendResponse({ status: "opened" });
      break;

    default:
      sendResponse({ status: "unknown" });
  }
});

function handleHoverStart(person, tabId) {
  currentTarget = {
    ...(person || {}),
    tabId,
    startTime: Date.now()
  };
  console.log("[Jarvis] Tracking hover:", person?.firstName, person?.lastName);
}

function handleHoverEnd() {
  currentTarget = null;
  console.log("[Jarvis] Hover cancelled");
}

async function handlePersonConfirmed(person, tabId) {
  console.log("[Jarvis] Confirmed target:", person);

  // Save current person
  await chrome.storage.local.set({
    currentPerson: person,
    searchStatus: "searching",
    searchId: Date.now(),
    searchPhase: null,
    searchError: null,
    latestResults: null
  });

  // Open or focus BrixHub search tab
  const searchUrl = "https://brixhub.to/search";

  const tabs = await chrome.tabs.query({ url: "https://brixhub.to/*" });
  let targetTab;

  if (tabs.length > 0) {
    targetTab = tabs[0];
    const alreadyThere =
      typeof targetTab.url === "string" &&
      targetTab.url.replace(/\/$/, "") === searchUrl;

    await chrome.tabs.update(targetTab.id, { active: true, url: searchUrl });

    // tabs.update with an identical URL is a no-op (no navigation), so the
    // content script would never re-run. Force a reload in that case.
    if (alreadyThere) {
      await chrome.tabs.reload(targetTab.id);
    }
  } else {
    targetTab = await chrome.tabs.create({ url: searchUrl, active: true });
  }
}

function handleSearchFailed(payload) {
  const reason = (payload && payload.reason) || "unknown";
  console.log("[Jarvis] Search failed:", reason);

  chrome.storage.local.get(["searchStatus"], (data) => {
    const patch = {
      searchError: reason,
      lastUpdated: Date.now()
    };
    // A name-extraction failure happens before any search starts, so it must
    // not clobber the status of a previous (or running) search.
    if (data.searchStatus === "searching" || reason !== "name_not_detected") {
      patch.searchStatus = "error";
    }
    chrome.storage.local.set(patch);
  });
}

function handleBrixHubResults(payload) {
  console.log("[Jarvis] Received BrixHub results:", payload);
  chrome.storage.local.set({
    latestResults: payload,
    searchStatus: "complete",
    searchError: null,
    lastUpdated: Date.now()
  });
}

function openDashboard() {
  // Open the full dashboard in a new tab for better UX
  chrome.tabs.create({
    url: chrome.runtime.getURL("src/dashboard/dashboard.html")
  });
}

// Optional: badge update
chrome.storage.onChanged.addListener((changes) => {
  if (changes.searchStatus) {
    const status = changes.searchStatus.newValue;
    if (status === "searching") {
      chrome.action.setBadgeText({ text: "..." });
      chrome.action.setBadgeBackgroundColor({ color: "#00ff9f" });
    } else if (status === "complete") {
      chrome.action.setBadgeText({ text: "OK" });
      chrome.action.setBadgeBackgroundColor({ color: "#00ff9f" });
    } else {
      chrome.action.setBadgeText({ text: "" });
    }
  }
});

console.log("[Jarvis] Background service worker online.");
