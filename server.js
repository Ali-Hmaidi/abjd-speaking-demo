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

/** Which LLM the coach should use, if any. Never returns the key itself. */
function coachProvider(env) {
  if (env.OPENAI_API_KEY) {
    return {
      name: "openai",
      key: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL || "gpt-4o-mini",
      url: "https://api.openai.com/v1/chat/completions",
    };
  }
  if (env.ANTHROPIC_API_KEY) {
    return {
      name: "anthropic",
      key: env.ANTHROPIC_API_KEY,
      model: env.ANTHROPIC_MODEL || "claude-sonnet-5",
      url: "https://api.anthropic.com/v1/messages",
    };
  }
  return null;
}

const COACH_SYSTEM =
  "You are a warm, concrete English pronunciation coach for a school-age learner. " +
  "You are given a sentence they were asked to read, what the recogniser actually heard, " +
  "their Azure pronunciation scores, and the specific sounds that scored badly. " +
  "Reply in at most 120 words, in this shape: one sentence of honest encouragement; " +
  "then 2-3 bullets, each naming one word, what went wrong in plain language, and a " +
  "physical instruction for the mouth, tongue or lips; then one short practice drill they " +
  "can do in 30 seconds. Never invent errors that are not in the data. No headings, no preamble.";

/** Ask the configured LLM for a practice plan. Resolves to text. */
async function askCoach(provider, payload) {
  const user =
    `Sentence to read: "${payload.sentence}"\n` +
    `Recogniser heard: "${payload.heard || "(nothing)"}"\n` +
    `Scores: ${JSON.stringify(payload.scores || {})}\n` +
    `Weak spots: ${JSON.stringify(payload.issues || [])}`;

  const isOpenAi = provider.name === "openai";
  const headers = isOpenAi
    ? { "Content-Type": "application/json", Authorization: `Bearer ${provider.key}` }
    : { "Content-Type": "application/json", "x-api-key": provider.key, "anthropic-version": "2023-06-01" };

  const body = isOpenAi
    ? {
        model: provider.model,
        max_tokens: 400,
        messages: [
          { role: "system", content: COACH_SYSTEM },
          { role: "user", content: user },
        ],
      }
    : {
        model: provider.model,
        max_tokens: 400,
        system: COACH_SYSTEM,
        messages: [{ role: "user", content: user }],
      };

  const resp = await fetch(provider.url, { method: "POST", headers, body: JSON.stringify(body) });
  const raw = await resp.text();
  if (!resp.ok) {
    // Surface the provider's own complaint, but never echo the key back.
    let detail = raw.slice(0, 300);
    try { detail = JSON.parse(raw).error?.message || detail; } catch (_e) {}
    throw new Error(`${provider.name} returned ${resp.status}: ${detail}`);
  }

  const data = JSON.parse(raw);
  const text = isOpenAi
    ? data.choices?.[0]?.message?.content
    : (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  if (!text) throw new Error("The model returned an empty response.");
  return text.trim();
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);

  // Generated config — the only place a key reaches the browser. The LLM key is
  // deliberately not here: the page only learns whether a coach is available.
  if (urlPath === "/config.js") {
    const env = readEnv();
    const provider = coachProvider(env);
    const body =
      "window.APP_CONFIG = " +
      JSON.stringify({
        key: env.AZURE_SPEECH_KEY || "",
        region: env.AZURE_SPEECH_REGION || "",
        coach: { enabled: !!provider, provider: provider ? provider.name : null },
      }) +
      ";\n";
    res.writeHead(200, { "Content-Type": MIME[".js"], "Cache-Control": "no-store" });
    return res.end(body);
  }

  // LLM coaching proxy — keeps the OpenAI/Anthropic key on this side of the wire.
  if (urlPath === "/api/coach") {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "POST only" }));
    }
    const provider = coachProvider(readEnv());
    if (!provider) {
      res.writeHead(501, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "No OPENAI_API_KEY or ANTHROPIC_API_KEY in .env" }));
    }

    let body = "";
    let tooBig = false;
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) { tooBig = true; req.destroy(); }
    });
    req.on("end", async () => {
      if (tooBig) return;
      try {
        const text = await askCoach(provider, JSON.parse(body || "{}"));
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ text, provider: provider.name, model: provider.model }));
      } catch (err) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err.message || err) }));
      }
    });
    return;
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
