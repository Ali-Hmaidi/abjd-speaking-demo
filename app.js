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
const raAudio = document.getElementById("raAudio");
const phonemeTip = document.getElementById("phonemeTip");

let raRecording = false;
let raHandle = null;   // in-flight assessment
let raMeter = null;    // mic level meter + tape
let raTimerId = null;
let raStartedAt = null;
let raHeardSound = false;
let raCountdownId = null;
let raAudioUrl = null;      // object URL of the last take
let raAlignSec = 0;         // recording-clock ≈ azure-clock offset, seconds
let raFirstSoundAt = null;  // wall-clock ms when the mic first heard the learner
let raSpeechStartSec = null;// where Azure says speech began, seconds into its stream
let raStopWordPlayback = null;

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
  if (raStopWordPlayback) raStopWordPlayback();
  raAudio.pause();
  raAudio.removeAttribute("src");
  if (raAudioUrl) URL.revokeObjectURL(raAudioUrl);
  raAudioUrl = null;
  raAlignSec = 0;
  raFirstSoundAt = null;
  raSpeechStartSec = null;
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
    const playable = raAudioUrl && d.ErrorType !== "Omission" && typeof w.Offset === "number";
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

/** Play just [start, start+dur] of the take, using the calibrated alignment. */
function playSlice(startSec, durSec) {
  if (!raAudioUrl) return;
  if (raStopWordPlayback) raStopWordPlayback();

  const from = Math.max(0, startSec + raAlignSec);
  raAudio.currentTime = from;
  const play = raAudio.play();
  if (play && play.catch) play.catch(() => {});

  const stopAt = from + durSec + 0.06; // a hair of tail so the word isn't clipped
  const watch = setInterval(() => {
    if (raAudio.currentTime >= stopAt || raAudio.paused) stop();
  }, 20);
  function stop() {
    clearInterval(watch);
    raAudio.pause();
    raStopWordPlayback = null;
  }
  raStopWordPlayback = stop;
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
  if (!raAudioUrl) return;
  if (raStopWordPlayback) raStopWordPlayback();
  raAudio.currentTime = 0;
  const play = raAudio.play();
  if (play && play.catch) play.catch(() => {});
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
        raFirstSoundAt = Date.now();
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
    onSpeechStart: (offsetTicks) => {
      raPipeline.textContent = "speech detected ✓";
      raPipeline.className = "pipeline-state live";
      if (typeof offsetTicks === "number") raSpeechStartSec = offsetTicks / TICKS_PER_SEC;
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
      const recStartedAt = raMeter ? raMeter.recordingStartedAt : null;
      raAudioUrl = raMeter ? await raMeter.stop() : null;
      raMeter = null;
      raTeardown();

      // Calibrate Azure's stream clock against our recording clock: both saw the
      // same speech onset, so the gap between them is the constant to subtract.
      raAlignSec = 0;
      if (raAudioUrl && raFirstSoundAt && recStartedAt && raSpeechStartSec !== null) {
        const localOnset = (raFirstSoundAt - recStartedAt) / 1000;
        raAlignSec = localOnset - raSpeechStartSec;
      }
      if (raAudioUrl) {
        raAudio.src = raAudioUrl;
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
