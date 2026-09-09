# Abjad Speaking Tasks — Demo

A standalone, single-page demo of three speaking-task component ideas for
English books, built on Azure Speech. No backend, no build step — everything
runs in the browser and talks to Azure directly. Built to show before
committing to building this into the real pipeline/backend/frontend.

## What's in it

| Tab | What it shows | Real or placeholder |
| --- | --- | --- |
| Read-Aloud Scoring | Student reads a sentence; Azure's Pronunciation Assessment scores accuracy/fluency/completeness and colors each word | Real Azure call |
| Picture Description | Free-form spoken response to a picture, live transcript | Real Azure call (transcription only, no grading) |
| Verbal Q&A | Answer a question aloud, transcript shown | Real Azure transcription; the "AI feedback" box is a **placeholder** — grading a free answer needs an LLM call through our backend, which is next if this is approved |

## 1. Get an Azure Speech key

1. Azure Portal → Create a resource → **Speech** (Cognitive Services).
2. Free tier (`F0`) is enough for a demo.
3. Once created, open **Keys and Endpoint** — copy **Key 1** and the **Region**
   (e.g. `eastus`).

## 2. Put the key in `.env`

```
AZURE_SPEECH_KEY=your-key-here
AZURE_SPEECH_REGION=israelcentral
```

`.env` is gitignored. **Region must be Azure's short code** — `israelcentral`,
not `israel`. The SDK builds its endpoint hostname straight from that string,
so a wrong code fails as a WebSocket connection error.

## 3. Run it

Mic access requires a secure context, so `file://` won't work. Use the bundled
server (no dependencies, reads `.env`):

```bash
node server.js
```

Then open `http://localhost:8000` in **Chrome** (best mic/WebSocket support).
Editing `.env` doesn't need a restart — just reload the page.

## 4. Use it

1. The page connects automatically from `.env`; the key box is hidden.
2. Allow microphone access when the browser prompts.
3. Try each tab.

Note: any browser-side Speech SDK call needs the key in the browser — `.env`
keeps it out of git and out of the UI, but it is still served to the page. Fine
for a local demo; production would mint short-lived tokens from the backend.

## Notes for the presentation

- This proves out the **hardest part** (real-time recognition + pronunciation
  scoring) with the actual API we'd use — not a mockup.
- If approved, the real build splits roughly as discussed with the team:
  frontend owns mic capture and UI, we own the STT/scoring endpoint and any
  LLM-graded feedback (like the Q&A placeholder above).
- Nothing here touches the real Abjad pipeline, database, or repos.
