// coach.js — turns Azure's phoneme scores into advice a learner can act on.
//
// Azure says a word scored 41. It doesn't say the /th/ was the problem, or what
// to do with your tongue. This maps its phoneme symbols (ARPAbet-style, as
// returned for en-US) onto concrete articulation instructions, picks the
// weakest sounds in the read, and orders them worst-first.
//
// This runs locally with no API key. The optional LLM layer in app.js adds a
// narrative on top; it does not replace this.

const PHONEME_TIPS = {
  // --- consonants learners most often miss ---
  th: { label: "th (as in “think”)", fix: "Put your tongue tip lightly between your teeth and blow. No voice — it should be a soft hiss.", confusedWith: "Usually comes out as “s”, “t” or “f”." },
  dh: { label: "th (as in “this”)", fix: "Tongue tip between your teeth, but switch your voice on — you should feel your throat buzz.", confusedWith: "Usually comes out as “d” or “z”." },
  r:  { label: "r", fix: "Curl your tongue back without touching the roof of your mouth, and round your lips slightly.", confusedWith: "Often swapped with “l”, or rolled." },
  l:  { label: "l", fix: "Press your tongue tip firmly on the ridge just behind your top teeth, and let the sound flow around it.", confusedWith: "Often swapped with “r”." },
  v:  { label: "v", fix: "Rest your top teeth on your bottom lip and buzz — voice on, not a puff of air.", confusedWith: "Often comes out as “w” or “f”." },
  f:  { label: "f", fix: "Top teeth on your bottom lip, push air through. No voice.", confusedWith: "Sometimes comes out as “p”." },
  w:  { label: "w", fix: "Round your lips tightly, then release into the vowel. Your teeth should not touch your lip.", confusedWith: "Often comes out as “v”." },
  s:  { label: "s", fix: "Tongue close to the ridge behind your top teeth, thin stream of air. No voice.", confusedWith: "Sometimes comes out as “sh” or “z”." },
  z:  { label: "z", fix: "Same tongue position as “s”, but with your voice on so it buzzes.", confusedWith: "Often devoiced into “s”." },
  sh: { label: "sh", fix: "Pull your tongue back a little from the “s” position and round your lips.", confusedWith: "Sometimes comes out as “s” or “ch”." },
  zh: { label: "zh (as in “measure”)", fix: "Like “sh”, but with your voice on.", confusedWith: "Often comes out as “sh” or “j”." },
  ch: { label: "ch", fix: "Start with your tongue as if for “t”, then release straight into “sh”. One sharp burst.", confusedWith: "Sometimes comes out as “sh”." },
  jh: { label: "j (as in “jump”)", fix: "Like “ch” but voiced — start at “d” and release into “zh”.", confusedWith: "Sometimes comes out as “ch” or “y”." },
  ng: { label: "ng (as in “sing”)", fix: "Raise the back of your tongue to the soft palate and send the sound through your nose. Don't add a hard “g” at the end.", confusedWith: "Often becomes “n” or “n-g”." },
  n:  { label: "n", fix: "Tongue tip on the ridge behind your top teeth, sound through your nose.", confusedWith: "" },
  m:  { label: "m", fix: "Lips closed, sound through your nose.", confusedWith: "" },
  hh: { label: "h", fix: "A gentle breath out — no friction in the throat.", confusedWith: "Sometimes dropped entirely." },
  h:  { label: "h", fix: "A gentle breath out — no friction in the throat.", confusedWith: "Sometimes dropped entirely." },
  y:  { label: "y (as in “yes”)", fix: "Tongue high and forward, then glide into the vowel.", confusedWith: "" },
  p:  { label: "p", fix: "Close your lips fully, build pressure, release with a puff of air.", confusedWith: "Often too soft, sounding like “b”." },
  b:  { label: "b", fix: "Close your lips fully and release with your voice on, no puff of air.", confusedWith: "Often hardens into “p”." },
  t:  { label: "t", fix: "Tongue tip on the ridge behind your top teeth, release sharply with air.", confusedWith: "Often too soft, sounding like “d”." },
  d:  { label: "d", fix: "Same position as “t”, but voiced and without the puff of air.", confusedWith: "Often hardens into “t”." },
  k:  { label: "k", fix: "Back of the tongue against the soft palate, release with a puff of air.", confusedWith: "Often too soft, sounding like “g”." },
  g:  { label: "g", fix: "Same position as “k”, but with your voice on.", confusedWith: "Often hardens into “k”." },

  // --- vowels ---
  iy: { label: "ee (as in “see”)", fix: "Hold it long, spread your lips like a smile, tongue high and forward.", confusedWith: "Often shortened into the “i” of “sit”." },
  ih: { label: "i (as in “sit”)", fix: "Keep it short and relaxed — jaw slightly lower than for “see”.", confusedWith: "Often stretched into the “ee” of “seat”." },
  eh: { label: "e (as in “bed”)", fix: "Open your jaw a little, tongue mid and forward.", confusedWith: "Often confused with the “a” of “bad”." },
  ae: { label: "a (as in “cat”)", fix: "Drop your jaw lower than for “bed” and keep the tongue forward.", confusedWith: "Often confused with the “e” of “bet”." },
  aa: { label: "ah (as in “father”)", fix: "Open your mouth wide, tongue low and back.", confusedWith: "" },
  ah: { label: "u (as in “cup”)", fix: "Short and relaxed, mouth barely moving — the neutral English vowel.", confusedWith: "Often over-pronounced." },
  ax: { label: "uh (unstressed)", fix: "This is an unstressed vowel — make it short and weak. Rushing it is correct.", confusedWith: "Often given too much weight." },
  ao: { label: "aw (as in “thought”)", fix: "Round your lips and keep the tongue low and back.", confusedWith: "" },
  uh: { label: "u (as in “book”)", fix: "Short, lips lightly rounded, tongue high and back.", confusedWith: "Often stretched into the “oo” of “boot”." },
  uw: { label: "oo (as in “blue”)", fix: "Long, with your lips pushed forward and tightly rounded.", confusedWith: "Often shortened into the “u” of “book”." },
  er: { label: "er (as in “bird”)", fix: "Curl your tongue back through the whole vowel — it is coloured by the “r” from the start.", confusedWith: "Often flattened into “uh”." },
  ey: { label: "ay (as in “day”)", fix: "Glide from “e” up into “ee” — it is two sounds, not one.", confusedWith: "Often flattened into a single “e”." },
  ay: { label: "i (as in “my”)", fix: "Glide from an open “ah” up into “ee”.", confusedWith: "Often cut short." },
  ow: { label: "oh (as in “go”)", fix: "Glide from “o” into “oo”, rounding your lips as you go.", confusedWith: "Often flattened into a single “o”." },
  aw: { label: "ow (as in “now”)", fix: "Glide from an open “ah” into “oo”.", confusedWith: "" },
  oy: { label: "oy (as in “boy”)", fix: "Glide from a rounded “aw” into “ee”.", confusedWith: "" },
};

/** Word-level detail is nested over the SDK and flat over REST; accept either. */
function coachWordDetail(w) {
  return w.PronunciationAssessment || w;
}

function tipFor(symbol) {
  if (!symbol) return null;
  const key = String(symbol).toLowerCase().replace(/[0-9]/g, ""); // strip stress digits
  return PHONEME_TIPS[key] || null;
}

const WORD_TROUBLE = 75;     // below this, a word is worth talking about
const PHONEME_TROUBLE = 70;  // below this, a sound is the likely culprit

/**
 * Build an ordered, actionable critique of one read.
 *
 * Returns { issues, strengths, headline } where each issue is something the
 * learner can actually do differently on the next attempt.
 */
function analyzeReading(result, referenceText) {
  const words = result.words || [];
  const issues = [];

  for (const w of words) {
    const d = coachWordDetail(w);
    const score = typeof d.AccuracyScore === "number" ? d.AccuracyScore : null;

    if (d.ErrorType === "Omission") {
      issues.push({
        kind: "omission",
        word: w.Word,
        score: 0,
        severity: 100,
        problem: `You skipped “${w.Word}”.`,
        fix: "Slow down and make sure every word gets said — a missed word costs more than a mispronounced one.",
        phonemes: [],
        playable: false,
      });
      continue;
    }

    if (d.ErrorType === "Insertion") {
      issues.push({
        kind: "insertion",
        word: w.Word,
        score: score,
        severity: 55,
        problem: `You added “${w.Word}”, which isn't in the sentence.`,
        fix: "Read only what's on the page — extra filler words lower the score.",
        phonemes: [],
        playable: true,
      });
      continue;
    }

    const isBad = d.ErrorType === "Mispronunciation" || (score !== null && score < WORD_TROUBLE);
    if (!isBad) continue;

    // Blame the specific sounds, worst first.
    const weak = (w.Phonemes || [])
      .filter((p) => typeof p.AccuracyScore === "number" && p.AccuracyScore < PHONEME_TROUBLE)
      .sort((a, b) => a.AccuracyScore - b.AccuracyScore)
      .slice(0, 2);

    const named = weak.map((p) => ({ symbol: p.Phoneme, score: Math.round(p.AccuracyScore), tip: tipFor(p.Phoneme) }));
    const withTips = named.filter((p) => p.tip);

    let problem, fix;
    if (withTips.length) {
      const list = withTips.map((p) => `“${p.tip.label}” (${p.score}/100)`).join(" and ");
      problem = `In “${w.Word}”, the weak sound${withTips.length > 1 ? "s were" : " was"} ${list}.`;
      fix = withTips.map((p) => p.tip.fix).join(" ");
      const confusions = withTips.map((p) => p.tip.confusedWith).filter(Boolean);
      if (confusions.length) fix += " " + confusions[0];
    } else {
      problem = `“${w.Word}” scored ${score === null ? "low" : Math.round(score) + "/100"}.`;
      fix = "Play your recording against “Hear it” and copy the rhythm and vowel length.";
    }

    issues.push({
      kind: "mispronunciation",
      word: w.Word,
      score: score,
      severity: score === null ? 60 : 100 - score,
      problem,
      fix,
      phonemes: named,
      playable: true,
    });
  }

  issues.sort((a, b) => b.severity - a.severity);

  // Whole-read observations, which word scores alone don't capture.
  const global = [];
  const completeness = result.completeness;
  const fluency = result.fluency;
  const prosody = result.prosody;

  if (typeof completeness === "number" && completeness < 80) {
    global.push({
      kind: "completeness",
      title: "You didn't read the whole sentence",
      problem: `Only about ${Math.round(completeness)}% of the sentence was matched.`,
      fix: "Read every word to the end, then press Done. A partial read scores far lower than a slow one.",
    });
  }
  if (typeof fluency === "number" && fluency < 75) {
    global.push({
      kind: "fluency",
      title: "Your delivery was choppy",
      problem: `Fluency scored ${Math.round(fluency)}/100 — long gaps or restarts between words.`,
      fix: "Read the sentence silently first, then say it in one continuous flow. Slower but smoother scores higher than fast with pauses.",
    });
  }
  if (typeof prosody === "number" && prosody < 75) {
    global.push({
      kind: "prosody",
      title: "Your intonation was flat",
      problem: `Prosody scored ${Math.round(prosody)}/100.`,
      fix: "Stress the content words (nouns, verbs) and let your pitch fall at the full stop. Listen to “Hear it” and copy the melody.",
    });
  }

  // Say what went right, so the panel isn't only criticism.
  const strengths = [];
  const clean = words.filter((w) => {
    const d = coachWordDetail(w);
    return d.ErrorType === "None" && typeof d.AccuracyScore === "number" && d.AccuracyScore >= 90;
  });
  if (clean.length) strengths.push(`${clean.length} of ${words.length} words were pronounced cleanly.`);
  if (typeof fluency === "number" && fluency >= 90) strengths.push("Your pacing was smooth and natural.");
  if (typeof prosody === "number" && prosody >= 85) strengths.push("Your intonation sounded natural.");
  if (typeof completeness === "number" && completeness >= 100) strengths.push("You read every word of the sentence.");

  let headline;
  if (!issues.length && !global.length) headline = "Nothing to fix — that was a clean read.";
  else if (global.length && !issues.length) headline = global[0].title + ".";
  else if (issues.length === 1) headline = `One sound to work on: ${issues[0].word}.`;
  else headline = `${Math.min(issues.length, 3)} things to work on, starting with “${issues[0].word}”.`;

  return { headline, issues, global, strengths };
}
