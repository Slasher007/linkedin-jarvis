"use strict";

// Minimal Chrome-extension API stub shared by the jsdom unit tests.
// It implements just enough of MV3 (promise-based storage + runtime messaging)
// to run the content scripts and the dashboard/popup pages.
function makeChromeStub(options = {}) {
  const store = Object.assign({}, options.storage || {});
  const messages = [];
  const changeListeners = [];
  const messageListeners = [];

  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

  function emitChanges(changes) {
    changeListeners.forEach((fn) => fn(clone(changes), "local"));
  }

  const chrome = {
    runtime: {
      sendMessage(message) {
        messages.push(clone(message));
        const handler = options.onMessage;
        if (handler) {
          const result = handler(clone(message));
          if (result && typeof result.then === "function") {
            return result.then((r) => ({ ok: true, response: r }));
          }
          return Promise.resolve({ ok: true, response: result });
        }
        return Promise.resolve({ ok: true });
      },
      onMessage: {
        addListener(fn) {
          messageListeners.push(fn);
        }
      },
      getURL: (p) => `chrome-extension://test-extension-id/${p}`
    },
    storage: {
      local: {
        get(keys, callback) {
          const out = {};
          const list = Array.isArray(keys)
            ? keys
            : typeof keys === "string"
              ? [keys]
              : Object.keys(store);
          list.forEach((k) => {
            if (k in store) out[k] = clone(store[k]);
          });
          // MV3 supports both callback and promise styles
          if (typeof callback === "function") {
            callback(clone(out));
            return undefined;
          }
          return Promise.resolve(clone(out));
        },
        set(obj, callback) {
          const changes = {};
          Object.keys(obj).forEach((k) => {
            changes[k] = { oldValue: clone(store[k]), newValue: clone(obj[k]) };
            store[k] = clone(obj[k]);
          });
          emitChanges(changes);
          if (typeof callback === "function") {
            callback();
            return undefined;
          }
          return Promise.resolve();
        }
      },
      onChanged: {
        addListener(fn) {
          changeListeners.push(fn);
        }
      }
    },
    action: {
      setBadgeText() {},
      setBadgeBackgroundColor() {}
    },
    tabs: {
      created: [],
      async create(props) {
        chrome.tabs.created.push(clone(props));
        return { id: chrome.tabs.created.length, url: props.url };
      },
      async query() {
        return chrome.tabs.queried || [];
      },
      async update(id, props) {
        chrome.tabs.updated.push({ id, props: clone(props) });
        return { id, url: props.url };
      },
      async reload() {
        chrome.tabs.reloads++;
      },
      queried: [],
      updated: [],
      reloads: 0
    }
  };

  chrome.__messages = messages;
  chrome.__store = store;
  return chrome;
}

module.exports = { makeChromeStub };
