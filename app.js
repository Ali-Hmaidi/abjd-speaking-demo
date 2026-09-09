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

let raRecording = false;
let raHandle = null;   // in-flight assessment
let raMeter = null;    // mic level meter
let raTimerId = null;
let raStartedAt = null;
let raHeardSound = false;

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
  raRecordBtn.disabled = false;
  raRecordBtn.classList.remove("recording");
  raRecordBtn.textContent = "🎙 Record";
  raMonitor.hidden = true;
  raTimer.hidden = true;
  raInterim.textContent = "";
  raLevel.style.width = "0%";
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

function renderWords(words) {
  if (!words.length) {
    raWordRender.textContent = "(word-level detail unavailable for this result)";
    return;
  }
  raWordRender.innerHTML = words
    .map((w) => {
      const errType = w.PronunciationAssessment && w.PronunciationAssessment.ErrorType;
      const cls = ERROR_CLASS[errType] || "correct";
      return `<span class="word ${cls}">${w.Word}</span>`;
    })
    .join(" ");
}

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
  raRecordBtn.classList.add("recording");
  raRecordBtn.textContent = "⏹ Done reading";
  raMonitor.hidden = false;
  raInterim.textContent = "";
  raPipeline.textContent = "connecting…";
  raPipeline.className = "pipeline-state";
  raLevelHint.textContent = "waiting for sound…";
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
  if (!raRecording) return;          // torn down while awaiting permission
  if (!raMeter) return;

  raStartedAt = Date.now();
  raTimer.hidden = false;
  raTimerId = setInterval(() => {
    raTimer.textContent = ((Date.now() - raStartedAt) / 1000).toFixed(1) + "s";
  }, 100);

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
    onResult: (r) => {
      raTeardown();
      setStatus(raStatus, "Scored", "good");

      raResults.hidden = false;
      raOverallScore.textContent = Math.round(r.overall || 0);
      setBar("raAccuracyBar", "raAccuracyVal", r.accuracy);
      setBar("raFluencyBar", "raFluencyVal", r.fluency);
      setBar("raCompletenessBar", "raCompletenessVal", r.completeness);
      renderWords(r.words);
    },
    onError: (err) => {
      // If the mic never registered sound, that's the more useful thing to say.
      const msg = raHeardSound
        ? String(err)
        : "No sound reached the mic — check the input device in Windows sound settings, then try again.";
      raTeardown();
      setStatus(raStatus, msg, "bad");
    },
  });
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
