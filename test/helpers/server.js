"use strict";

const https = require("https");
const fs = require("fs");
const path = require("path");

const FIXTURES = path.join(__dirname, "..", "fixtures");

const PAGES = {
  "linkedin-grow": fs.readFileSync(path.join(FIXTURES, "linkedin-grow.html"), "utf8"),
  "brixhub-search": fs.readFileSync(path.join(FIXTURES, "brixhub-search.html"), "utf8"),
  "brixhub-results": fs.readFileSync(path.join(FIXTURES, "brixhub-results.html"), "utf8"),
  "brixhub-dossier": fs.readFileSync(path.join(FIXTURES, "brixhub-dossier.html"), "utf8")
};

function resolve(host, url) {
  const pathname = url.split("?")[0];
  if (host.startsWith("www.linkedin.com")) {
    if (pathname.startsWith("/mynetwork/grow")) return PAGES["linkedin-grow"];
    return null;
  }
  if (host.startsWith("brixhub.to")) {
    if (pathname === "/search") return PAGES["brixhub-search"];
    if (pathname === "/results") return PAGES["brixhub-results"];
    if (pathname === "/dossier") return PAGES["brixhub-dossier"];
    return null;
  }
  return null;
}

function createFixtureServer(port) {
  const key = fs.readFileSync(path.join(FIXTURES, "key.pem"));
  const cert = fs.readFileSync(path.join(FIXTURES, "cert.pem"));

  const server = https.createServer({ key, cert }, (req, res) => {
    const host = req.headers.host || "";
    const body = resolve(host, req.url);
    if (!body) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found: " + host + req.url);
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  });

  return new Promise((resolvePromise) => {
    server.listen(port, "127.0.0.1", () => resolvePromise(server));
  });
}

module.exports = { createFixtureServer };
