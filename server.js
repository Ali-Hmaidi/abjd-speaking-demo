// server.js — zero-dependency static server that injects .env into the page.
// Run with: node server.js   (then open http://localhost:8000)

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PORT = process.env.PORT || 8000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** Read .env fresh on every request so editing it doesn't need a restart. */
function readEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return {};
  const out = {};
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);

  // Generated config — the only place the key reaches the browser.
  if (urlPath === "/config.js") {
    const env = readEnv();
    const body =
      "window.APP_CONFIG = " +
      JSON.stringify({
        key: env.AZURE_SPEECH_KEY || "",
        region: env.AZURE_SPEECH_REGION || "",
      }) +
      ";\n";
    res.writeHead(200, { "Content-Type": MIME[".js"], "Cache-Control": "no-store" });
    return res.end(body);
  }

  const relative = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const filePath = path.join(ROOT, relative);

  // Never serve anything outside the project folder, or the .env itself.
  if (!filePath.startsWith(ROOT) || path.basename(filePath) === ".env") {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
});

server.listen(PORT, () => {
  const env = readEnv();
  const ok = env.AZURE_SPEECH_KEY && env.AZURE_SPEECH_REGION;
  console.log(`Speaking demo running at http://localhost:${PORT}`);
  console.log(
    ok
      ? `.env loaded — region: ${env.AZURE_SPEECH_REGION}`
      : "No .env key/region found — you can still enter them in the page."
  );
});
