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
    return { stop() {} };
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

  return {
    stop() {
      if (raf) cancelAnimationFrame(raf);
      stream.getTracks().forEach((t) => t.stop());
      if (ctx.state !== "closed") ctx.close().catch(() => {});
    },
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
function assessPronunciation(referenceText, { onSessionStart, onSpeechStart, onInterim, onResult, onError } = {}) {
  requireConfig();
  const audioConfig = SpeechSDK.AudioConfig.fromDefaultMicrophoneInput();
  const pronunciationConfig = new SpeechSDK.PronunciationAssessmentConfig(
    referenceText,
    SpeechSDK.PronunciationAssessmentGradingSystem.HundredMark,
    SpeechSDK.PronunciationAssessmentGranularity.Phoneme,
    true // enableMiscue — also flags omitted/inserted words, not just mispronounced ones
  );

  const recognizer = new SpeechSDK.SpeechRecognizer(speechConfig, audioConfig);
  // Don't end the phrase on a short mid-sentence breath.
  recognizer.properties.setProperty(
    SpeechSDK.PropertyId.Speech_SegmentationSilenceTimeoutMs, "1500"
  );
  pronunciationConfig.applyTo(recognizer);

  let settled = false;

  const teardown = () => {
    if (activeAssessment && activeAssessment.recognizer === recognizer) activeAssessment = null;
    recognizer.stopContinuousRecognitionAsync(
      () => recognizer.close(),
      () => recognizer.close()
    );
  };

  recognizer.sessionStarted = () => { onSessionStart && onSessionStart(); };
  recognizer.speechStartDetected = () => { onSpeechStart && onSpeechStart(); };
  recognizer.recognizing = (_s, e) => { onInterim && onInterim(e.result.text); };

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

    settled = true;
    teardown();
    onResult && onResult({
      recognizedText: e.result.text,
      overall: assessment.pronunciationScore,
      accuracy: assessment.accuracyScore,
      fluency: assessment.fluencyScore,
      completeness: assessment.completenessScore,
      words,
    });
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
    /** Learner pressed Stop. If nothing scored yet, say so rather than hanging. */
    stop() {
      if (settled) return;
      settled = true;
      teardown();
      onError && onError("Stopped before Azure returned a score — try again and read the whole sentence.");
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
