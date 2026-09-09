// speech.js — thin wrapper around the Azure Speech SDK for JS.
// The SDK is loaded globally as `SpeechSDK` by the <script> tag in index.html.

let speechConfig = null;
let activeRecognizer = null;   // continuous transcription (tabs 2 & 3)
let activeAssessment = null;   // read-aloud assessment (tab 1)

function isSdkLoaded() {
  return typeof SpeechSDK !== "undefined";
}

function configureSpeech(key, region) {
  if (!isSdkLoaded()) {
    throw new Error("Azure Speech SDK failed to load — check your internet connection and reload.");
  }
  speechConfig = SpeechSDK.SpeechConfig.fromSubscription(key, region);
  speechConfig.speechRecognitionLanguage = "en-US";
}

function isConfigured() {
  return !!speechConfig;
}

function requireConfig() {
  if (!speechConfig) {
    throw new Error("Enter your Azure Speech key and region, then click Connect.");
  }
}

/**
 * Live microphone level meter.
 *
 * Opens its own getUserMedia stream purely for visualisation — the Speech SDK
 * opens its own separately. Two readers of one mic is fine in Chrome, and it
 * means the meter proves the *browser* can hear you even when the Azure
 * connection is the thing that's broken.
 *
 * onLevel receives 0..1 (smoothed RMS) about 60x/second.
 */
async function createMicMeter({ onLevel, onError } = {}) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    onError && onError(
      err && err.name === "NotAllowedError"
        ? "Microphone permission denied — click the icon in the address bar and allow the mic."
        : "No microphone found. Check your input device and reload."
    );
    return null;
  }

  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  // Autoplay policy can leave the context suspended until a user gesture.
  if (ctx.state === "suspended") { try { await ctx.resume(); } catch (_e) {} }

  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.6;
  source.connect(analyser);

  const buf = new Float32Array(analyser.fftSize);
  let raf = null;
  let smoothed = 0;

  const tick = () => {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    // Speech RMS sits well below 1.0; scale so normal talking fills the bar.
    const level = Math.min(1, rms * 6);
    smoothed = Math.max(level, smoothed * 0.85);
    onLevel && onLevel(smoothed);
    raf = requestAnimationFrame(tick);
  };
  tick();

  // Tape of the take, captured as raw PCM rather than through MediaRecorder.
  //
  // A MediaRecorder webm blob carries no seek index, so <audio>.currentTime
  // lands wherever the container's cluster boundaries happen to fall — fine for
  // playing a whole take, useless for "play me the third word". Raw samples let
  // playback start on an exact sample.
  const CAPTURE_BUFFER = 4096;
  const capture = ctx.createScriptProcessor(CAPTURE_BUFFER, 1, 1);
  // A ScriptProcessor only runs while connected to the graph, but routing the
  // mic to the speakers would howl — so the sink is a muted gain node.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(capture);
  capture.connect(mute);
  mute.connect(ctx.destination);

  let taping = false;
  let pcm = [];
  let taped = 0;

  capture.onaudioprocess = (e) => {
    if (!taping) return;
    // The event buffer is recycled by the engine, so keep a copy.
    const block = new Float32Array(e.inputBuffer.getChannelData(0));
    pcm.push(block);
    taped += block.length;
  };

  return {
    /** Start taping. Called as recognition starts, so the two clocks run together. */
    startRecording() {
      pcm = [];
      taped = 0;
      taping = true;
    },

    /** Stops metering and taping. Resolves to { samples, sampleRate }, or null. */
    stop() {
      if (raf) cancelAnimationFrame(raf);
      raf = null;
      taping = false;

      const sampleRate = ctx.sampleRate;
      let samples = null;
      if (taped) {
        samples = new Float32Array(taped);
        let at = 0;
        for (const block of pcm) { samples.set(block, at); at += block.length; }
      }
      pcm = [];

      capture.onaudioprocess = null;
      try { source.disconnect(); capture.disconnect(); mute.disconnect(); } catch (_e) {}
      stream.getTracks().forEach((t) => t.stop());
      if (ctx.state !== "closed") ctx.close().catch(() => {});

      return Promise.resolve(samples ? { samples, sampleRate } : null);
    },
  };
}

/**
 * Where speech actually starts in a take, in seconds.
 *
 * Measured off the recorded samples after the fact, not off the live meter —
 * the meter's value is deliberately smoothed for a calm-looking bar, which lags
 * the true onset by enough to smear word replay. Energy is compared against the
 * take's own peak, so it adapts to a quiet mic instead of using a fixed floor.
 */
function detectOnset(samples, sampleRate) {
  const win = Math.max(1, Math.round(sampleRate * 0.01)); // 10ms windows
  const windows = Math.floor(samples.length / win);
  if (!windows) return 0;

  const rms = new Float32Array(windows);
  let peak = 0;
  for (let w = 0; w < windows; w++) {
    let sum = 0;
    const base = w * win;
    for (let i = 0; i < win; i++) { const v = samples[base + i]; sum += v * v; }
    rms[w] = Math.sqrt(sum / win);
    if (rms[w] > peak) peak = rms[w];
  }
  if (peak <= 0) return 0;

  const threshold = Math.max(peak * 0.12, 0.004);
  // Require two consecutive loud windows so a click or lip smack isn't the onset.
  for (let w = 0; w < windows - 1; w++) {
    if (rms[w] >= threshold && rms[w + 1] >= threshold) return (w * win) / sampleRate;
  }
  return 0;
}

// How long a silence ends a phrase. Long enough that a reader drawing breath
// mid-sentence doesn't get their read chopped into separately-scored fragments.
const SEGMENTATION_SILENCE_MS = 3000;
// After asking Azure to stop, how long to wait for the trailing segment.
const FLUSH_GRACE_MS = 400;
const FLUSH_TIMEOUT_MS = 5000;

/** Word-level detail is nested over the SDK and flat over REST; accept either. */
function wordScores(w) {
  return w.PronunciationAssessment || w;
}

/**
 * Combine the segments of one read into a single score.
 *
 * A clean read is one segment, and then Azure's own numbers are used verbatim —
 * no arithmetic of ours in the common path. Only a read Azure chose to split
 * gets recombined, weighting each part by how long it actually was, so a
 * two-word tail can't count as much as the body of the sentence.
 */
function aggregateSegments(segments, referenceText) {
  if (segments.length === 1) {
    return Object.assign({}, segments[0], {
      recognizedText: segments[0].text,
      segmentCount: 1,
      aggregated: false,
    });
  }

  const words = segments.reduce((all, s) => all.concat(s.words), []);
  const spoken = words.filter((w) => {
    const d = wordScores(w);
    return d.ErrorType !== "Omission" && typeof d.AccuracyScore === "number";
  });

  // Accuracy: weight each word by how long it took to say.
  let accNum = 0, accDen = 0;
  for (const w of spoken) {
    const weight = Math.max(w.Duration || 0, 1);
    accNum += wordScores(w).AccuracyScore * weight;
    accDen += weight;
  }
  const accuracy = accDen ? accNum / accDen : null;

  // Completeness: measured against the sentence they were asked to read.
  const refWords = referenceText.split(/\s+/).filter(Boolean).length;
  const matched = words.filter((w) => {
    const e = wordScores(w).ErrorType;
    return e !== "Omission" && e !== "Insertion";
  }).length;
  const completeness = refWords ? Math.min(100, (matched / refWords) * 100) : null;

  // Fluency and prosody are per-segment judgements; weight by segment length.
  const weighted = (pick) => {
    let num = 0, den = 0;
    for (const s of segments) {
      const v = pick(s);
      if (typeof v === "number") {
        const weight = Math.max(s.durationTicks || 0, 1);
        num += v * weight;
        den += weight;
      }
    }
    return den ? num / den : null;
  };
  const fluency = weighted((s) => s.fluency);
  const prosody = weighted((s) => s.prosody);

  // Azure's own weighting when prosody is enabled; matches its PronScore on
  // single-segment results, so a stitched read stays on the same scale.
  const part = (v, w) => (typeof v === "number" ? v * w : 0);
  const overall =
    part(accuracy, 0.4) + part(fluency, 0.2) + part(completeness, 0.2) + part(prosody, 0.2);

  return {
    recognizedText: segments.map((s) => s.text).join(" "),
    overall,
    accuracy,
    fluency,
    completeness,
    prosody,
    words,
    segmentCount: segments.length,
    aggregated: true,
  };
}

/** Turn an SDK cancellation into something a human can act on. */
function describeCancellation(e) {
  const code = e && e.errorCode;
  const detail = (e && e.errorDetails) || "";
  const C = SpeechSDK.CancellationErrorCode;
  if (code === C.ConnectionFailure || /1006|websocket/i.test(detail)) {
    return "Couldn't reach Azure (WebSocket failed). Check the region in .env and your network.";
  }
  if (code === C.AuthenticationFailure) {
    return "Azure rejected the key — check AZURE_SPEECH_KEY in .env.";
  }
  if (code === C.Forbidden) {
    return "Key is valid but not authorised for Speech here, or the free quota is used up.";
  }
  return detail || "Recognition was canceled.";
}

/**
 * Continuous live transcription — used by Picture Description and Verbal Q&A.
 * Only one continuous recognizer runs at a time; starting a new one stops the previous.
 */
function startTranscription({ onInterim, onFinalSegment, onError } = {}) {
  requireConfig();
  const audioConfig = SpeechSDK.AudioConfig.fromDefaultMicrophoneInput();
  const recognizer = new SpeechSDK.SpeechRecognizer(speechConfig, audioConfig);

  recognizer.recognizing = (_s, e) => {
    if (onInterim) onInterim(e.result.text);
  };
  recognizer.recognized = (_s, e) => {
    if (e.result.reason === SpeechSDK.ResultReason.RecognizedSpeech && e.result.text) {
      if (onFinalSegment) onFinalSegment(e.result.text);
    }
  };
  recognizer.canceled = (_s, e) => {
    if (onError) onError(describeCancellation(e));
  };

  recognizer.startContinuousRecognitionAsync(
    () => {},
    (err) => onError && onError(err)
  );

  activeRecognizer = recognizer;
  return recognizer;
}

function stopTranscription() {
  return new Promise((resolve) => {
    if (!activeRecognizer) return resolve();
    const rec = activeRecognizer;
    activeRecognizer = null;
    rec.stopContinuousRecognitionAsync(
      () => { rec.close(); resolve(); },
      () => { rec.close(); resolve(); }
    );
  });
}

/**
 * Read-aloud pronunciation assessment.
 *
 * Uses *continuous* recognition rather than recognizeOnceAsync. recognizeOnce
 * gives up after ~5s of leading silence and ends at the first pause, which is
 * why this tab failed intermittently while the other two were fine. Here the
 * learner controls when they are done, and a mid-sentence breath is harmless.
 *
 * Callbacks fire in this order: onSessionStart -> onSpeechStart -> onInterim* -> onResult.
 */
function assessPronunciation(referenceText, { onSessionStart, onSpeechStart, onInterim, onSegment, onFlushing, onResult, onError } = {}) {
  requireConfig();
  const audioConfig = SpeechSDK.AudioConfig.fromDefaultMicrophoneInput();
  const pronunciationConfig = new SpeechSDK.PronunciationAssessmentConfig(
    referenceText,
    SpeechSDK.PronunciationAssessmentGradingSystem.HundredMark,
    SpeechSDK.PronunciationAssessmentGranularity.Phoneme,
    true // enableMiscue — also flags omitted/inserted words, not just mispronounced ones
  );
  // Intonation / stress / rhythm grading. Verified available in uaenorth.
  pronunciationConfig.enableProsodyAssessment = true;

  const recognizer = new SpeechSDK.SpeechRecognizer(speechConfig, audioConfig);
  // Hold the phrase together across mid-sentence breaths. Scoring a fragment is
  // the single biggest source of score noise: truncating a good read to 60% of
  // its length drops accuracy from 95 to 74, so splitting must be rare.
  recognizer.properties.setProperty(
    SpeechSDK.PropertyId.Speech_SegmentationSilenceTimeoutMs, String(SEGMENTATION_SILENCE_MS)
  );
  pronunciationConfig.applyTo(recognizer);

  const segments = [];
  let settled = false;
  let stopping = false;
  let graceTimer = null;

  const teardown = () => {
    if (activeAssessment && activeAssessment.recognizer === recognizer) activeAssessment = null;
    if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
    recognizer.stopContinuousRecognitionAsync(
      () => recognizer.close(),
      () => recognizer.close()
    );
  };

  /** Every segment is in; combine and hand back one score. */
  const finalize = () => {
    if (settled) return;
    settled = true;
    teardown();
    if (!segments.length) {
      onError && onError("Stopped before Azure scored anything — try again and read the whole sentence.");
      return;
    }
    onResult && onResult(aggregateSegments(segments, referenceText));
  };

  recognizer.sessionStarted = () => { onSessionStart && onSessionStart(); };
  // e.offset is where Azure heard speech begin, in 100ns ticks from stream start.
  // The caller uses it to line Azure's word offsets up with our local recording.
  recognizer.speechStartDetected = (_s, e) => {
    onSpeechStart && onSpeechStart(e && typeof e.offset === "number" ? e.offset : null);
  };
  recognizer.recognizing = (_s, e) => { onInterim && onInterim(e.result.text); };

  // Collect every segment. Settling on the first one scores only the words
  // spoken before the reader's first pause, which is what made the number jump
  // around between attempts.
  recognizer.recognized = (_s, e) => {
    if (settled) return;
    if (e.result.reason !== SpeechSDK.ResultReason.RecognizedSpeech || !e.result.text) return;

    const assessment = SpeechSDK.PronunciationAssessmentResult.fromResult(e.result);
    let words = [];
    try {
      const rawJson = e.result.properties.getProperty(
        SpeechSDK.PropertyId.SpeechServiceResponse_JsonResult
      );
      const parsed = JSON.parse(rawJson);
      words = (parsed.NBest && parsed.NBest[0] && parsed.NBest[0].Words) || [];
    } catch (_e) {
      words = []; // word-level detail is a bonus, not required for the headline scores
    }

    segments.push({
      text: e.result.text,
      overall: assessment.pronunciationScore,
      accuracy: assessment.accuracyScore,
      fluency: assessment.fluencyScore,
      completeness: assessment.completenessScore,
      prosody: assessment.prosodyScore,
      durationTicks: typeof e.result.duration === "number" ? e.result.duration : 0,
      words,
    });
    onSegment && onSegment(segments.length);

    // This was the flush we asked for when the learner pressed Done.
    if (stopping) finalize();
  };

  recognizer.canceled = (_s, e) => {
    if (settled) return;
    settled = true;
    teardown();
    onError && onError(describeCancellation(e));
  };

  recognizer.startContinuousRecognitionAsync(
    () => {},
    (err) => {
      if (settled) return;
      settled = true;
      teardown();
      onError && onError(err);
    }
  );

  const handle = {
    recognizer,
    /**
     * Learner pressed Done. Azure may still be holding the tail of the sentence,
     * so ask it to flush and wait briefly for that last segment rather than
     * throwing away the end of the read.
     */
    stop() {
      if (settled || stopping) return;
      stopping = true;
      onFlushing && onFlushing();
      recognizer.stopContinuousRecognitionAsync(
        () => { if (!settled) graceTimer = setTimeout(finalize, FLUSH_GRACE_MS); },
        () => finalize()
      );
      // Backstop in case the flush never produces a final segment.
      graceTimer = setTimeout(finalize, FLUSH_TIMEOUT_MS);
    },
  };
  activeAssessment = handle;
  return handle;
}

/** Abandon a read-aloud attempt in flight (tab switch, new sentence). Silent — no error callback. */
function stopAssessment() {
  if (!activeAssessment) return;
  const rec = activeAssessment.recognizer;
  activeAssessment = null;
  rec.recognized = () => {};
  rec.canceled = () => {};
  rec.stopContinuousRecognitionAsync(() => rec.close(), () => rec.close());
}

/** Stop everything holding the mic, whichever tab owns it. */
async function stopAllRecognition() {
  stopAssessment();
  await stopTranscription();
}

/** Text-to-speech playback — used for "Hear it" on the read-aloud reference sentence. */
function speak(text, { onDone, onError } = {}) {
  requireConfig();
  const synthesizer = new SpeechSDK.SpeechSynthesizer(speechConfig);
  synthesizer.speakTextAsync(
    text,
    () => { synthesizer.close(); onDone && onDone(); },
    (err) => { synthesizer.close(); onError && onError(err); }
  );
}
