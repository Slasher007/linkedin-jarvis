document.getElementById("openDash").addEventListener("click", () => {
  try {
    const p = chrome.runtime.sendMessage({ type: "OPEN_DASHBOARD" });
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch (_) {}
  window.close();
});

// Quick status
chrome.storage.local.get(["searchStatus", "currentPerson"], (data) => {
  const el = document.getElementById("status");
  if (data.searchStatus === "searching") {
    el.textContent = "Scanning BrixHub...";
  } else if (data.currentPerson) {
    el.textContent = `Last target: ${data.currentPerson.fullName}`;
  } else {
    el.textContent = "System online • Ready";
  }
});
