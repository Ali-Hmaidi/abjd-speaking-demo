// app.js — tab switching + per-component orchestration on top of speech.js

const SENTENCES = [
  "The quick brown fox jumps over the lazy dog.",
  "She sells seashells by the seashore.",
  "Reading every day helps you learn new words.",
  "The weather was sunny, so we walked to the park.",
  "Practice makes progress, not perfection.",
];

const QUESTIONS = [
  "What did you do last weekend?",
  "Describe your favorite place to visit.",
  "What is your favorite subject in school, and why?",
  "Tell me about a book or movie you enjoyed recently.",
];

let sentenceIndex = 0;
let questionIndex = 0;

// ---------- config bar ----------

const keyInput = document.getElementById("keyInput");
const regionInput = document.getElementById("regionInput");
const saveConfigBtn = document.getElementById("saveConfigBtn");
const configStatus = document.getElementById("configStatus");

function setStatus(el, text, kind) {
  el.textContent = text;
  el.className = "status status-" + kind;
}

function tryConnect(key, region) {
  try {
    configureSpeech(key, region);
    setStatus(configStatus, "Connected", "good");
    return true;
  } catch (err) {
    setStatus(configStatus, err.message || "Connection failed", "bad");
    return false;
  }
}

(function initConfig() {
  // .env (via server.js → /config.js) wins over anything typed in the page before.
  const envCfg = window.APP_CONFIG || {};
  const key = envCfg.key || localStorage.getItem("azureSpeechKey") || "";
  const region = envCfg.region || localStorage.getItem("azureSpeechRegion") || "";

  keyInput.value = key;
  regionInput.value = region;

  if (envCfg.key && envCfg.region) {
    document.getElementById("configRow").hidden = true;
    document.getElementById("configHint").textContent = `Key and region loaded from .env (${envCfg.region})`;
  }
  if (key && region) tryConnect(key, region);
})();

saveConfigBtn.addEventListener("click", () => {
  const key = keyInput.value.trim();
  const region = regionInput.value.trim();
  if (!key || !region) {
    setStatus(configStatus, "Enter both a key and a region", "bad");
    return;
  }
  localStorage.setItem("azureSpeechKey", key);
  localStorage.setItem("azureSpeechRegion", region);
  tryConnect(key, region);
});

function requireConnection() {
  if (!isConfigured()) {
    setStatus(configStatus, "Connect your Azure key first (above)", "bad");
    return false;
  }
  return true;
}

// ---------- tabs ----------

const tabButtons = document.querySelectorAll(".tab-btn");
const panels = document.querySelectorAll(".tab-panel");

tabButtons.forEach((btn) => {
  btn.addEventListener("click", async () => {
    raTeardown();                  // release the read-aloud meter + UI
    hidePhonemeTip();
    if (raStopWordPlayback) raStopWordPlayback();
    await stopAllRecognition();    // never leave a mic open when switching tabs
    setStatus(raStatus, "Idle", "idle");
    tabButtons.forEach((b) => b.classList.remove("active"));
    panels.forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("panel-" + btn.dataset.tab).classList.add("active");
  });
});

// ---------- 1. Read-aloud scoring ----------

const sentenceText = document.getElementById("sentenceText");
const newSentenceBtn = document.getElementById("newSentenceBtn");
const hearItBtn = document.getElementById("hearItBtn");
const raRecordBtn = document.getElementById("raRecordBtn");
const raStatus = document.getElementById("raStatus");
const raResults = document.getElementById("raResults");
const raOverallScore = document.getElementById("raOverallScore");
const raWordRender = document.getElementById("raWordRender");
const raMonitor = document.getElementById("raMonitor");
const raLevel = document.getElementById("raLevel");
const raLevelHint = document.getElementById("raLevelHint");
const raPipeline = document.getElementById("raPipeline");
const raInterim = document.getElementById("raInterim");
const raTimer = document.getElementById("raTimer");

const raCountdown = document.getElementById("raCountdown");
const raCountdownNum = document.getElementById("raCountdownNum");
const raRetryBtn = document.getElementById("raRetryBtn");
const raPlayAllBtn = document.getElementById("raPlayAllBtn");
const raWordHint = document.getElementById("raWordHint");
const raProsodyRow = document.getElementById("raProsodyRow");
const raNote = document.getElementById("raNote");
const phonemeTip = document.getElementById("phonemeTip");

let raRecording = false;
let raHandle = null;   // in-flight assessment
let raMeter = null;    // mic level meter + tape
let raTimerId = null;
let raStartedAt = null;
let raHeardSound = false;
let raCountdownId = null;
let raTake = null;          // { samples, sampleRate } of the last read
let raBuffer = null;        // that take as an AudioBuffer, built once
let raPlayCtx = null;       // playback context, separate from the capture one
let raAlignSec = 0;         // recording clock -> Azure clock offset, seconds
let raStopWordPlayback = null;

// Nudge slices out a little at each end; word boundaries from a recogniser are
// approximate, and a hard cut swallows the consonant that starts the word.
const SLICE_PAD_BEFORE = 0.07;
const SLICE_PAD_AFTER = 0.10;

const TICKS_PER_SEC = 10_000_000; // Azure reports offsets in 100-nanosecond ticks

function setBar(barId, valId, value) {
  const v = Math.round(value || 0);
  const bar = document.getElementById(barId);
  const val = document.getElementById(valId);
  bar.style.width = v + "%";
  bar.style.background = v >= 80 ? "var(--good)" : v >= 60 ? "var(--warn)" : "var(--bad)";
  val.textContent = v;
}

newSentenceBtn.addEventListener("click", () => {
  raTeardown();
  stopAssessment();
  raClearRecording();
  sentenceIndex = (sentenceIndex + 1) % SENTENCES.length;
  sentenceText.textContent = SENTENCES[sentenceIndex];
  raResults.hidden = true;
  setStatus(raStatus, "Idle", "idle");
});

/** Reset every piece of read-aloud recording UI back to resting state. */
function raTeardown() {
  raRecording = false;
  raHandle = null;
  if (raMeter) { raMeter.stop(); raMeter = null; }
  if (raTimerId) { clearInterval(raTimerId); raTimerId = null; }
  if (raCountdownId) { clearInterval(raCountdownId); raCountdownId = null; }
  raRecordBtn.disabled = false;
  raRecordBtn.classList.remove("recording");
  raRecordBtn.textContent = "🎙 Record";
  raMonitor.hidden = true;
  raCountdown.hidden = true;
  raTimer.hidden = true;
  raInterim.textContent = "";
  raLevel.style.width = "0%";
}

/** Drop the previous take — new attempt, new audio. */
function raClearRecording() {
  raStopPlayback();
  raTake = null;
  raBuffer = null;
  raAlignSec = 0;
  raPlayAllBtn.hidden = true;
  hidePhonemeTip();
}

hearItBtn.addEventListener("click", () => {
  if (!requireConnection()) return;
  hearItBtn.disabled = true;
  speak(sentenceText.textContent, {
    onDone: () => { hearItBtn.disabled = false; },
    onError: (err) => { hearItBtn.disabled = false; setStatus(raStatus, String(err), "bad"); },
  });
});

const ERROR_CLASS = {
  None: "correct",
  Mispronunciation: "error",
  Omission: "omission",
  Insertion: "insertion",
};

/** Azure nests per-word detail under PronunciationAssessment over the SDK; be tolerant anyway. */
function wordDetail(w) {
  return w.PronunciationAssessment || w;
}

function renderWords(words) {
  raWordRender.innerHTML = "";
  raWordHint.hidden = true;
  if (!words.length) {
    raWordRender.textContent = "(word-level detail unavailable for this result)";
    return;
  }

  words.forEach((w, i) => {
    const d = wordDetail(w);
    const cls = ERROR_CLASS[d.ErrorType] || "correct";
    const span = document.createElement("span");
    span.className = "word " + cls;
    span.textContent = w.Word;

    const phonemes = w.Phonemes || [];
    const accuracy = d.AccuracyScore;
    if (typeof accuracy === "number") span.dataset.accuracy = Math.round(accuracy);
    if (phonemes.length) span.dataset.phonemes = JSON.stringify(
      phonemes.map((p) => ({ p: p.Phoneme, s: Math.round(p.AccuracyScore) }))
    );

    // Omissions were never spoken, so there is no audio to replay for them.
    const playable = raTake && d.ErrorType !== "Omission" && typeof w.Offset === "number";
    if (playable) {
      span.classList.add("playable");
      span.dataset.start = (w.Offset / TICKS_PER_SEC).toFixed(3);
      span.dataset.dur = ((w.Duration || 0) / TICKS_PER_SEC).toFixed(3);
    }
    if (phonemes.length || typeof accuracy === "number") span.classList.add("has-detail");

    raWordRender.appendChild(span);
    if (i < words.length - 1) raWordRender.appendChild(document.createTextNode(" "));
  });

  raWordHint.hidden = false;
}

// ---- phoneme tooltip ----

function showPhonemeTip(span) {
  const accuracy = span.dataset.accuracy;
  const raw = span.dataset.phonemes;
  if (!accuracy && !raw) return;

  let html = `<div class="tip-head">${span.textContent} — ${accuracy ?? "?"}/100</div>`;
  if (raw) {
    const rows = JSON.parse(raw)
      .map((p) => {
        const tone = p.s >= 80 ? "good" : p.s >= 60 ? "warn" : "bad";
        return `<span class="tip-ph ${tone}"><b>${p.p}</b>${p.s}</span>`;
      })
      .join("");
    html += `<div class="tip-phonemes">${rows}</div>`;
  }
  if (span.classList.contains("playable")) html += `<div class="tip-foot">click to replay</div>`;
  phonemeTip.innerHTML = html;
  phonemeTip.hidden = false;

  const r = span.getBoundingClientRect();
  const t = phonemeTip.getBoundingClientRect();
  let left = r.left + window.scrollX + r.width / 2 - t.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - t.width - 8));
  let top = r.top + window.scrollY - t.height - 8;
  if (top < window.scrollY + 4) top = r.bottom + window.scrollY + 8; // flip below if clipped
  phonemeTip.style.left = left + "px";
  phonemeTip.style.top = top + "px";
}

function hidePhonemeTip() {
  phonemeTip.hidden = true;
}

raWordRender.addEventListener("mouseover", (e) => {
  const span = e.target.closest(".word.has-detail");
  if (span) showPhonemeTip(span);
});
raWordRender.addEventListener("mouseout", (e) => {
  if (e.target.closest(".word")) hidePhonemeTip();
});

// ---- per-word replay ----

/** Lazily build the playback context and buffer for the current take. */
function raEnsureBuffer() {
  if (!raTake) return null;
  if (!raPlayCtx) raPlayCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (raPlayCtx.state === "suspended") raPlayCtx.resume().catch(() => {});
  if (!raBuffer) {
    raBuffer = raPlayCtx.createBuffer(1, raTake.samples.length, raTake.sampleRate);
    raBuffer.copyToChannel(raTake.samples, 0);
  }
  return raBuffer;
}

function raStopPlayback() {
  if (raStopWordPlayback) raStopWordPlayback();
}

/**
 * Play [start, start+dur] of the take, in Azure's clock.
 *
 * AudioBufferSourceNode.start takes an offset and duration in seconds and
 * begins on the exact sample, which is why the take is kept as raw PCM.
 */
function playSlice(startSec, durSec) {
  const buffer = raEnsureBuffer();
  if (!buffer) return;
  raStopPlayback();

  const from = Math.max(0, startSec + raAlignSec - SLICE_PAD_BEFORE);
  const span = Math.max(0.05, durSec + SLICE_PAD_BEFORE + SLICE_PAD_AFTER);
  if (from >= buffer.duration) return;

  const src = raPlayCtx.createBufferSource();
  src.buffer = buffer;
  src.connect(raPlayCtx.destination);
  src.start(0, from, Math.min(span, buffer.duration - from));

  raStopWordPlayback = () => {
    try { src.stop(); } catch (_e) {}
    raStopWordPlayback = null;
  };
  src.onended = () => { raStopWordPlayback = null; };
}

raWordRender.addEventListener("click", (e) => {
  const span = e.target.closest(".word.playable");
  if (!span) return;
  raWordRender.querySelectorAll(".word.playing").forEach((s) => s.classList.remove("playing"));
  span.classList.add("playing");
  setTimeout(() => span.classList.remove("playing"), 600);
  playSlice(parseFloat(span.dataset.start), parseFloat(span.dataset.dur));
});

raPlayAllBtn.addEventListener("click", () => {
  const buffer = raEnsureBuffer();
  if (!buffer) return;
  raStopPlayback();
  const src = raPlayCtx.createBufferSource();
  src.buffer = buffer;
  src.connect(raPlayCtx.destination);
  src.start();
  raStopWordPlayback = () => {
    try { src.stop(); } catch (_e) {}
    raStopWordPlayback = null;
  };
  src.onended = () => { raStopWordPlayback = null; };
});

raRecordBtn.addEventListener("click", async () => {
  if (!requireConnection()) return;

  // Second click = "I'm done reading".
  if (raRecording) {
    if (raHandle) raHandle.stop();
    return;
  }

  raRecording = true;
  raHeardSound = false;
  raResults.hidden = true;
  raClearRecording();
  raRecordBtn.classList.add("recording");
  raRecordBtn.textContent = "⏹ Done reading";
  raMonitor.hidden = false;
  raInterim.textContent = "";
  raPipeline.textContent = "connecting…";
  raPipeline.className = "pipeline-state";
  raLevelHint.textContent = "waiting for sound…";
  raLevelHint.classList.remove("ok");
  setStatus(raStatus, "Opening microphone…", "active");

  // Meter first: it tells us the browser can hear the mic even if Azure can't be reached.
  raMeter = await createMicMeter({
    onLevel: (level) => {
      raLevel.style.width = Math.round(level * 100) + "%";
      raLevel.classList.toggle("hot", level > 0.08);
      if (level > 0.08 && !raHeardSound) {
        raHeardSound = true;
        raLevelHint.textContent = "hearing you ✓";
        raLevelHint.classList.add("ok");
      }
    },
    onError: (msg) => {
      raTeardown();
      setStatus(raStatus, msg, "bad");
    },
  });
  if (!raRecording || !raMeter) return;   // torn down while awaiting permission

  // 3·2·1 lead-in. The meter is already live, so the reader can confirm the mic
  // works before the clock starts — this is what stops people talking over the
  // connection handshake and losing their opening words.
  const counted = await raRunCountdown(3);
  if (!counted || !raRecording || !raMeter) return;

  raStartedAt = Date.now();
  raTimer.hidden = false;
  raTimerId = setInterval(() => {
    raTimer.textContent = ((Date.now() - raStartedAt) / 1000).toFixed(1) + "s";
  }, 100);

  raMeter.startRecording();   // tape and recognition start together
  raHandle = assessPronunciation(sentenceText.textContent, {
    onSessionStart: () => {
      raPipeline.textContent = "listening — read the sentence now";
      raPipeline.className = "pipeline-state live";
      setStatus(raStatus, "Listening", "active");
    },
    onSpeechStart: () => {
      raPipeline.textContent = "speech detected ✓";
      raPipeline.className = "pipeline-state live";
    },
    onInterim: (text) => {
      raInterim.textContent = text;
    },
    onFlushing: () => {
      raPipeline.textContent = "finishing — waiting for the last words…";
      raPipeline.className = "pipeline-state";
      setStatus(raStatus, "Scoring…", "active");
    },
    onResult: async (r) => {
      // Close the tape before rendering, so word replay has audio to point at.
      raTake = raMeter ? await raMeter.stop() : null;
      raBuffer = null;
      raMeter = null;
      raTeardown();

      // Calibrate the two clocks. Both observers heard the same first syllable:
      // detectOnset says where it sits in our samples, and the first scored
      // word's offset says where Azure thinks it sits. The gap is the constant.
      raAlignSec = 0;
      if (raTake) {
        const firstSpoken = (r.words || []).find(
          (w) => wordDetail(w).ErrorType !== "Omission" && typeof w.Offset === "number"
        );
        if (firstSpoken) {
          const localOnset = detectOnset(raTake.samples, raTake.sampleRate);
          raAlignSec = localOnset - firstSpoken.Offset / TICKS_PER_SEC;
        }
        raPlayAllBtn.hidden = false;
      }

      setStatus(raStatus, "Scored", "good");
      raResults.hidden = false;
      raShowNote(r);
      raOverallScore.textContent = Math.round(r.overall || 0);
      setBar("raAccuracyBar", "raAccuracyVal", r.accuracy);
      setBar("raFluencyBar", "raFluencyVal", r.fluency);
      setBar("raCompletenessBar", "raCompletenessVal", r.completeness);
      // Prosody needs a supported region; hide the row rather than show a fake 0.
      if (typeof r.prosody === "number") {
        raProsodyRow.hidden = false;
        setBar("raProsodyBar", "raProsodyVal", r.prosody);
      } else {
        raProsodyRow.hidden = true;
      }
      renderWords(r.words);
      raLastResult = r;
      raRenderCoach(r, sentenceText.textContent);
    },
    onError: (err) => {
      // If the mic never registered sound, that's the more useful thing to say.
      const msg = raHeardSound
        ? String(err)
        : "No sound reached the mic — check the input device in Windows sound settings, then try again.";
      raTeardown();
      raClearRecording();
      setStatus(raStatus, msg, "bad");
    },
  });
});

// ---- coaching panel ----

const raCoach = document.getElementById("raCoach");
const raCoachHead = document.getElementById("raCoachHead");
const raCoachList = document.getElementById("raCoachList");
const raCoachStrengths = document.getElementById("raCoachStrengths");
const raCoachAi = document.getElementById("raCoachAi");
const raCoachAiBtn = document.getElementById("raCoachAiBtn");
const raCoachAiNote = document.getElementById("raCoachAiNote");
const raCoachAiOut = document.getElementById("raCoachAiOut");

const MAX_COACH_ISSUES = 3;   // a learner can act on three things, not nine
let raLastAnalysis = null;
let raLastResult = null;

/** Find where a word sits in the take, so "hear yours" can replay just it. */
function raWordSlice(word) {
  const match = (raLastResult && raLastResult.words || []).find(
    (w) => w.Word === word && wordDetail(w).ErrorType !== "Omission" && typeof w.Offset === "number"
  );
  if (!match) return null;
  return { start: match.Offset / TICKS_PER_SEC, dur: (match.Duration || 0) / TICKS_PER_SEC };
}

function raRenderCoach(result, referenceText) {
  const analysis = analyzeReading(result, referenceText);
  raLastAnalysis = analysis;
  raCoachHead.textContent = analysis.headline;
  raCoachList.innerHTML = "";

  // Whole-read problems first — no point polishing a /th/ if half the sentence
  // went unread.
  for (const g of analysis.global) {
    const li = document.createElement("li");
    li.className = "coach-item global";
    li.innerHTML =
      `<div class="coach-what"><span class="coach-tag">${g.title}</span> ${g.problem}</div>` +
      `<div class="coach-how">${g.fix}</div>`;
    raCoachList.appendChild(li);
  }

  for (const issue of analysis.issues.slice(0, MAX_COACH_ISSUES)) {
    const li = document.createElement("li");
    li.className = "coach-item " + issue.kind;

    const chips = issue.phonemes
      .filter((p) => p.tip)
      .map((p) => `<span class="coach-ph">${p.tip.label} · ${p.score}</span>`)
      .join("");

    li.innerHTML =
      `<div class="coach-what">` +
      `<span class="coach-word">${issue.word}</span>` +
      (typeof issue.score === "number" ? `<span class="coach-score">${Math.round(issue.score)}/100</span>` : "") +
      ` ${issue.problem}</div>` +
      (chips ? `<div class="coach-phonemes">${chips}</div>` : "") +
      `<div class="coach-how"><b>Try this:</b> ${issue.fix}</div>`;

    const actions = document.createElement("div");
    actions.className = "coach-actions";

    const hear = document.createElement("button");
    hear.className = "chip-btn";
    hear.textContent = "🔊 Hear it correctly";
    hear.addEventListener("click", () => {
      hear.disabled = true;
      speak(issue.word, {
        onDone: () => { hear.disabled = false; },
        onError: () => { hear.disabled = false; },
      });
    });
    actions.appendChild(hear);

    const slice = issue.playable ? raWordSlice(issue.word) : null;
    if (slice && raTake) {
      const mine = document.createElement("button");
      mine.className = "chip-btn";
      mine.textContent = "🎧 Hear yours";
      mine.addEventListener("click", () => playSlice(slice.start, slice.dur));
      actions.appendChild(mine);
    }

    li.appendChild(actions);
    raCoachList.appendChild(li);
  }

  if (analysis.strengths.length) {
    raCoachStrengths.textContent = "✅ " + analysis.strengths.join(" ");
    raCoachStrengths.hidden = false;
  } else {
    raCoachStrengths.hidden = true;
  }

  // The LLM layer is optional; only offer it when the server says a key exists.
  const coachCfg = (window.APP_CONFIG && window.APP_CONFIG.coach) || {};
  raCoachAi.hidden = !coachCfg.enabled;
  raCoachAiOut.hidden = true;
  raCoachAiOut.textContent = "";
  raCoachAiNote.hidden = true;
  raCoachAiBtn.disabled = false;
  raCoachAiBtn.textContent = "🧠 Ask the AI coach for a practice plan";

  raCoach.hidden = false;
}

raCoachAiBtn.addEventListener("click", async () => {
  if (!raLastResult) return;
  raCoachAiBtn.disabled = true;
  raCoachAiBtn.textContent = "Thinking…";
  raCoachAiNote.hidden = true;

  try {
    const res = await fetch("/api/coach", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sentence: sentenceText.textContent,
        heard: raLastResult.recognizedText,
        scores: {
          overall: raLastResult.overall,
          accuracy: raLastResult.accuracy,
          fluency: raLastResult.fluency,
          completeness: raLastResult.completeness,
          prosody: raLastResult.prosody,
        },
        // Only the weak spots — the model doesn't need the clean words.
        issues: (raLastAnalysis ? raLastAnalysis.issues : []).slice(0, 5).map((i) => ({
          word: i.word, score: i.score, kind: i.kind,
          phonemes: i.phonemes.map((p) => ({ symbol: p.symbol, score: p.score })),
        })),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data && data.error ? data.error : "Coach request failed");

    raCoachAiOut.textContent = data.text || "(no advice returned)";
    raCoachAiOut.hidden = false;
    raCoachAiBtn.textContent = "🧠 Ask again";
  } catch (err) {
    raCoachAiNote.textContent = String(err.message || err);
    raCoachAiNote.hidden = false;
    raCoachAiBtn.textContent = "🧠 Try again";
  } finally {
    raCoachAiBtn.disabled = false;
  }
});

/**
 * Say when a score shouldn't be trusted at face value.
 *
 * A partial read still scores, but low — truncating a good read to 60% of its
 * length takes accuracy from 95 to 74 — so an unexplained low number reads as
 * "you pronounced it badly" when it really means "we only heard some of it".
 */
function raShowNote(r) {
  const comp = typeof r.completeness === "number" ? r.completeness : 100;
  if (comp < 60) {
    raNote.textContent =
      `Only about ${Math.round(comp)}% of the sentence was captured, so this score reflects a partial read. ` +
      `Read the whole sentence, then press Done.`;
    raNote.className = "score-note warn";
    raNote.hidden = false;
  } else if (r.aggregated) {
    raNote.textContent =
      `Your read was split into ${r.segmentCount} parts by a long pause; the scores are combined across them.`;
    raNote.className = "score-note info";
    raNote.hidden = false;
  } else {
    raNote.hidden = true;
  }
}

/** Ticks 3·2·1 in the UI. Resolves false if the attempt was cancelled mid-count. */
function raRunCountdown(from) {
  return new Promise((resolve) => {
    let n = from;
    raCountdown.hidden = false;
    raCountdownNum.textContent = n;
    raCountdownNum.classList.add("tick");
    setStatus(raStatus, "Get ready…", "active");

    raCountdownId = setInterval(() => {
      if (!raRecording) {           // stopped or tab switched mid-countdown
        clearInterval(raCountdownId);
        raCountdownId = null;
        raCountdown.hidden = true;
        return resolve(false);
      }
      n -= 1;
      if (n <= 0) {
        clearInterval(raCountdownId);
        raCountdownId = null;
        raCountdown.hidden = true;
        return resolve(true);
      }
      raCountdownNum.textContent = n;
      // Restart the pop animation on each tick.
      raCountdownNum.classList.remove("tick");
      void raCountdownNum.offsetWidth;
      raCountdownNum.classList.add("tick");
    }, 1000);
  });
}

raRetryBtn.addEventListener("click", () => {
  raResults.hidden = true;
  raClearRecording();
  setStatus(raStatus, "Idle", "idle");
  raRecordBtn.click();   // same sentence, straight back into recording
});

// ---------- 2. Picture description ----------

const picMicBtn = document.getElementById("picMicBtn");
const picStatus = document.getElementById("picStatus");
const picTranscript = document.getElementById("picTranscript");
const picStats = document.getElementById("picStats");
const picTime = document.getElementById("picTime");
const picWords = document.getElementById("picWords");
const picWpm = document.getElementById("picWpm");

let picFinalText = "";
let picInterimText = "";
let picStartedAt = null;
let picRecording = false;

function renderPicTranscript() {
  picTranscript.textContent = [picFinalText, picInterimText].filter(Boolean).join(" ");
}

picMicBtn.addEventListener("click", async () => {
  if (!requireConnection()) return;

  if (picRecording) {
    await stopTranscription();
    picRecording = false;
    picMicBtn.classList.remove("recording");
    picMicBtn.textContent = "🎙 Start Speaking";
    setStatus(picStatus, "Stopped", "idle");

    const elapsedSec = picStartedAt ? Math.round((Date.now() - picStartedAt) / 1000) : 0;
    const wordCount = picFinalText.trim() ? picFinalText.trim().split(/\s+/).length : 0;
    const wpm = elapsedSec > 0 ? Math.round((wordCount / elapsedSec) * 60) : 0;
    picStats.hidden = false;
    picTime.textContent = elapsedSec + "s";
    picWords.textContent = wordCount + " words";
    picWpm.textContent = wpm + " wpm";
    return;
  }

  await stopTranscription();
  picFinalText = "";
  picInterimText = "";
  picStartedAt = Date.now();
  picStats.hidden = true;
  renderPicTranscript();

  picRecording = true;
  picMicBtn.classList.add("recording");
  picMicBtn.textContent = "⏹ Stop";
  setStatus(picStatus, "Listening…", "active");

  startTranscription({
    onInterim: (text) => { picInterimText = text; renderPicTranscript(); },
    onFinalSegment: (text) => { picFinalText = (picFinalText + " " + text).trim(); picInterimText = ""; renderPicTranscript(); },
    onError: (err) => { setStatus(picStatus, String(err), "bad"); },
  });
});

// ---------- 3. Verbal Q&A ----------

const qaQuestion = document.getElementById("qaQuestion");
const newQuestionBtn = document.getElementById("newQuestionBtn");
const qaMicBtn = document.getElementById("qaMicBtn");
const qaStatus = document.getElementById("qaStatus");
const qaTranscript = document.getElementById("qaTranscript");
const qaSubmitBtn = document.getElementById("qaSubmitBtn");
const qaResult = document.getElementById("qaResult");
const qaFinalAnswer = document.getElementById("qaFinalAnswer");

let qaFinalText = "";
let qaInterimText = "";
let qaRecording = false;

function renderQaTranscript() {
  qaTranscript.textContent = [qaFinalText, qaInterimText].filter(Boolean).join(" ");
  qaSubmitBtn.disabled = !qaFinalText.trim();
}

newQuestionBtn.addEventListener("click", async () => {
  await stopTranscription();
  qaRecording = false;
  qaMicBtn.classList.remove("recording");
  qaMicBtn.textContent = "🎙 Start Answer";
  questionIndex = (questionIndex + 1) % QUESTIONS.length;
  qaQuestion.textContent = QUESTIONS[questionIndex];
  qaFinalText = "";
  qaInterimText = "";
  renderQaTranscript();
  qaResult.hidden = true;
  setStatus(qaStatus, "Idle", "idle");
});

qaMicBtn.addEventListener("click", async () => {
  if (!requireConnection()) return;

  if (qaRecording) {
    await stopTranscription();
    qaRecording = false;
    qaMicBtn.classList.remove("recording");
    qaMicBtn.textContent = "🎙 Start Answer";
    setStatus(qaStatus, "Stopped", "idle");
    return;
  }

  await stopTranscription();
  qaFinalText = "";
  qaInterimText = "";
  renderQaTranscript();
  qaResult.hidden = true;

  qaRecording = true;
  qaMicBtn.classList.add("recording");
  qaMicBtn.textContent = "⏹ Stop";
  setStatus(qaStatus, "Listening…", "active");

  startTranscription({
    onInterim: (text) => { qaInterimText = text; renderQaTranscript(); },
    onFinalSegment: (text) => { qaFinalText = (qaFinalText + " " + text).trim(); qaInterimText = ""; renderQaTranscript(); },
    onError: (err) => { setStatus(qaStatus, String(err), "bad"); },
  });
});

qaSubmitBtn.addEventListener("click", async () => {
  await stopTranscription();
  qaRecording = false;
  qaMicBtn.classList.remove("recording");
  qaMicBtn.textContent = "🎙 Start Answer";
  setStatus(qaStatus, "Submitted", "good");
  qaFinalAnswer.textContent = qaFinalText.trim();
  qaResult.hidden = false;
});
