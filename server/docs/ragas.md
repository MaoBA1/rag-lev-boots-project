# RAGAS — Evaluating the RAG System's Quality, Explained From Scratch

This document explains the RAGAS evaluation system built on top of the RAG pipeline:
what RAGAS is (and what our simplified version deliberately isn't), how the
ground-truth dataset was built and validated, how the judge is designed, and a real
investigation into a hallucination the eval surfaced. It's written for a reader with
no prior background — every concept is built up before it's used.

It covers **evaluation only**. Loading data is documented in
[`load-data.md`](./load-data.md); asking questions is documented in
[`ask.md`](./ask.md). This system evaluates the `ask()` pipeline from the outside —
it doesn't change how `ask()` itself works.

---

## Part 1 — What RAGAS actually is, and what we built instead

**RAGAS** (Retrieval-Augmented Generation Assessment) is an evaluation methodology
for RAG systems. The real, full version (a Python library) computes several
independent metrics per question — faithfulness (are the answer's claims actually
backed by the retrieved context?), answer relevancy, context precision, context
recall, and answer correctness. Answer correctness specifically works by breaking
the generated answer into individual claims, classifying each as a true/false
positive/negative against the ground truth, computing something like an F1 score,
and blending it with embedding-based semantic similarity. None of this is a single
LLM call asking "how similar are these two answers" — it's a decomposed, structured
pipeline.

The exercise's own `EXTRA_CHALLENGES.md` offers two paths: build the real thing in
Python, or build a much simpler Node.js version — write 10 ground-truth Q&A pairs,
run each through the RAG system, and **ask an LLM to score the generated answer
against the ground truth on a scale of 1–10**, then average the scores. This
document covers that second, simplified path ("Option 1"). It is explicitly *not*
real RAGAS's claim-decomposition approach — it's a single LLM call per question that
acts as a judge, which is a real design tradeoff, not a mistake: it's much less
work to build, at the cost of being less rigorous and more prone to per-run scoring
noise.

**A key architectural point, easy to get wrong at first:** RAGAS does **not** run on
real user requests. It is a completely separate, standalone script, decoupled from
the Express app, run manually whenever the developer wants to check quality. A real
user's question has no known "correct answer" to score against — RAGAS only works
because the 10 ground-truth questions have pre-validated correct answers. The
production `/api/ask` path is untouched by any of this.

---

## Part 2 — Building and validating the ground-truth dataset

### 2.1 Getting the source material into a reviewable form

To hand-write 10 trustworthy ground-truth Q&A pairs, the actual source material
needed to be reviewable outside the database. Two throwaway scripts were written for
this (`server/scripts/dumpSourceText.ts`, `server/scripts/dumpPdfText.ts`) that reuse
the existing loaders (`loadArticles`, `loadSlackMessages`, `loadPdfs`) to dump raw
text to local files — `articles_dump/`, `slack_dump/` (one file per thread,
chronologically ordered — the loader already does this), and `pdf_text_dump/`. These
are gitignored; they're prep material, not a deliverable.

The 41 Slack thread files were additionally concatenated into one
`slack_dump_combined.txt` file (also gitignored) with `===== THREAD: <id> =====`
headers, to make it feasible to hand the whole Slack corpus to an LLM chat in one
piece.

### 2.2 Generating candidate Q&A pairs

The 3 PDFs, 5 articles, and the combined Slack file were given to a Gemini chat with
instructions to produce 10 question/answer pairs, each backed by direct quotes from
the source material — specifically so the quotes could be independently checked
against the real files rather than trusting the LLM's answers at face value.

### 2.3 Independent validation — a real cross-check, not a rubber stamp

Every one of the 10 Q&A pairs was checked by grepping the actual dumped source files
for each quoted sentence, and by re-reading the surrounding context to confirm the
synthesized answer wasn't misrepresenting what the quote actually said. Result: **7
of 10 were accurate as generated.** Three had real problems, found and fixed:

- **Q3 (TRAS trigger conditions)** — the supporting quote was accurate, but the
  answer's prose mischaracterized the source's actual logic. The real rule (White
  Paper, Section 3.2) is *(any 2 of 3 sensors fail) OR (tilt exceeds 35°)* — a
  conditional with a shared "2-of-3" clause. The original answer described it as
  three fully independent standalone triggers (tilt, OR power failure alone, OR
  biometric cessation alone), which is not what the source says. Corrected with
  additional quotes from the Research Paper confirming the same 35° threshold and
  0.5 m/s descent rate.

- **Q8 (acoustic mitigation)** — the answer conflated two unrelated numbers. The
  White Paper is explicit: 95 dB → 52 dB, a "measured 45% reduction in decibel
  output" (a ~43 dB absolute drop). The original answer parenthetically added
  "(approximately an 8 dB reduction)" — a number that doesn't belong to that figure
  at all. It was pulled from an unrelated, informal Slack message (thread `m0064`)
  about a *different*, earlier prototype composite-housing test. Corrected to
  explicitly distinguish the two, citing an additional OpEd quote confirming the
  real 45%/52 dB figures.

- **Q10 (Orion Distribution Center efficiency)** — "up to 12-20 meters high" merged
  two different studies into what read like one range: the White Paper's Orion case
  study says "up to 20 meters," while "12 meters" comes from a separate forklift
  benchmark test described in `warehousing.md`. Corrected to explicitly attribute
  each number to its own study instead of implying a continuous range.

The final, corrected dataset lives in `server/ragas/ground-truth.json` — 10 items,
each `{question, answer, supportingQuotes}`. This file is **static**: it's written
once, checked into git as a real deliverable, and the eval script never modifies it.

---

## Part 3 — Architecture

```
server/ragas/
  ground-truth.json   — static, 10 validated Q&A pairs, committed to git
  judge.ts            — the LLM-as-judge: prompt + scoring call
  ragasEval.ts         — the orchestrator script
  logs/                — one JSON file per eval run, committed to git
```

None of this lives inside the Express app or touches its request/response cycle.
`ragasEval.ts` is run manually (`npx tsx ragas/ragasEval.ts <run-label>`), and it
calls straight into the same `ask()` function from `ragService.ts` that a real user's
request would hit — no HTTP layer involved, just a direct in-process function call.

### 3.1 The eval flow, per question

```
for each of the 10 ground-truth questions:
  1. generatedAnswer = await ask(question)          — the real production pipeline
  2. { score, justification } = await judgeAnswer(   — a SEPARATE LLM call
       question, groundTruthAnswer, supportingQuotes, generatedAnswer
     )
  3. push { question, groundTruthAnswer, generatedAnswer, evaluationScore: score,
            justificationForScore: justification }

quality = average(evaluationScore) * 10   — scaled to /100, see §3.3
print results, write logs/<run-label>.json
```

### 3.2 The judge's design

The judge is deliberately built beyond the doc's literal minimal spec, in three
specific ways, each a considered tradeoff rather than an accident:

- **It sees the supporting quotes, not just the two answers.** The doc's version
  only compares generated vs. ground-truth text. Since the quotes were already
  sitting in `ground-truth.json` from the validation pass, they're injected into
  the judge's prompt as fact-check material — closer in spirit to real RAGAS's
  faithfulness check, at the cost of a bigger prompt and more judge complexity than
  the doc asked for.
- **A banded 1–10 rubric, not a bare "score similarity" instruction** — explicit
  anchors (10 = fully correct; 7-9 = correct but different wording or a minor
  omission; 4-6 = partially correct, missing a significant fact; 1-3 = wrong or
  off-topic) so the score means roughly the same thing across different questions
  and different runs, instead of being whatever a vague prompt happens to produce.
- **Structured output**: the judge is called with Ollama's `format: "json"` mode and
  required to return `{"score": <1-10>, "justification": "<one sentence>"}`. The
  justification is stored per-question in the log — useful for understanding *why*
  a score is low without re-reading every answer by hand.

### 3.3 Why `quality` is scaled ×10

The doc says scores are 1–10 per question, but also says "above 80 is good, above 90
is excellent" — which only makes sense on a 0–100 scale. Averaging ten 1–10 scores
directly caps out at 10, not 100. `ragasEval.ts` resolves this by computing the
average of the 1–10 scores and multiplying by 10, so `quality` lands on the same
0–100 scale the doc's thresholds assume.

### 3.4 Model separation — judge vs. generator

`ollamaService.ts` now exposes two separate model constants and lets any
`generateAnswer` call override which model it targets:

```ts
export const GENERATION_MODEL = 'llama3.2';   // production ask() generation
export const JUDGE_MODEL = 'qwen2.5:7b';       // eval-only, judge.ts
```

This wasn't the first configuration tried — see Part 4.

### 3.5 Log format

Each run writes `server/ragas/logs/<run-label>.json`:

```json
{
  "timestamp": "...",
  "groundTruthEval": [
    {
      "question": "...",
      "groundTruthAnswer": "...",
      "generatedAnswer": "...",
      "evaluationScore": 7,
      "justificationForScore": "..."
    }
  ],
  "quality": 77.0
}
```

Each entry is **self-contained** — it carries its own copy of the question and
ground-truth answer rather than just an index into `ground-truth.json`. This means
a log file remains fully interpretable in isolation even if the ground-truth file
were ever edited later. The filename itself is the run's identifying metadata (e.g.
`01-ragas-baseline.json`), and both `ground-truth.json` and `logs/` are committed
to git — unlike the throwaway source dumps from §2.1, these are the actual
deliverable evidence of the exercise.

---

## Part 4 — Model selection: two iterations, and why

### 4.1 First attempt: `llama3.2:1b` as generator, `llama3.2` (3B) as judge

The original plan was to keep `llama3.2` (3B) as judge (the strongest model already
in use) and swap production generation to a smaller model, to keep judge and
generator meaningfully different and to explore a "lighter" generation tier. The
machine (Apple M4, 16GB RAM, 10 cores) has plenty of headroom for much larger models
than any of this, so `llama3.2:1b` was chosen for its clean compatibility (same
model family, no unusual output format) over `deepseek-r1:1.5b` (a reasoning model
that emits raw `<think>` traces by default, which would need to be stripped before
use).

Result: **42.0/100.** Three questions (Q2, Q4, Q5) returned the LLM's own instructed
fallback — "I don't have enough information in the knowledge base to answer that
question" — despite retrieval succeeding (confirmed by the fact that this exact
phrasing is the *LLM's own* fallback string from the system prompt, distinct from
the *pre-LLM* threshold short-circuit message used when retrieval itself finds
nothing). In other words: relevant chunks were retrieved and handed to the model,
and the 1B model still declined to answer rather than attempting synthesis. This
was a genuine, informative finding — `llama3.2:1b` is too weak to reliably use
multi-chunk retrieved context — but not a usable baseline for the actual production
configuration, so this run was discarded rather than kept as `01`.

### 4.2 Second attempt: flip it — `llama3.2` (3B) as generator, a stronger model as judge

Given the hardware headroom, the better use of "the strongest available model" is as
the *generator* (since that's what real users actually experience), with an even
stronger, separate model reserved for judging — maximizing separation between the
system under test and the thing measuring it (avoiding self-grading bias) while
keeping production quality high. `llama3.2:1b` was removed; **`qwen2.5:7b`** (~4.7GB)
was pulled as judge — a meaningful step up from 3B, chosen partly for its strong,
reliable structured/JSON output, while staying comfortably within the 16GB budget.

Result: **75.0/100**, later **77.0/100** after the temperature change below. This is
the configuration documented as the actual baseline.

---

## Part 5 — Reliability: temperature and why it matters here

### 5.1 The non-determinism problem

Rerunning the eval with zero code changes produced a different score (75.0 → 77.0
between two otherwise-identical runs). The cause: LLM generation is normally
**sampled**, not deterministic — at each token, the model doesn't always pick the
single most likely continuation, it samples from a probability distribution
(controlled by a `temperature` setting). This affects both calls in the eval: the
generator producing the answer, and the judge scoring it. Neither is a perfectly
stable measurement instrument by default.

This isn't unique to the eval script — it's a property of the actual product too. A
real user asking the same question twice could get differently-worded (hopefully
equally correct) answers.

### 5.2 The fix: temperature = 0 everywhere

`generateAnswer` in `ollamaService.ts` now defaults `temperature` to `0` (passed
through to Ollama's `options.temperature`), applied uniformly to both the production
generation call and the judge call, since neither call site overrides it. Rerunning
after this change produced **77.0/100** — close to the prior 75.0, confirming the
change meaningfully tightened variance without needing to change anything else.

What this does and doesn't buy: temperature 0 makes each model strongly favor its
single highest-confidence continuation at each step, which sharply reduces (but does
not perfectly eliminate — execution-order effects can still cause tiny differences)
run-to-run variance. It does **not** make the RAG system itself more accurate — it
makes *measuring* its accuracy more trustworthy. The eval's realistic strength,
even with this fix, is catching **large** quality swings (e.g. 75 → 40 after a bad
change); a 3-5 point difference between two runs is still within plausible noise
and shouldn't be over-interpreted as a real regression or improvement on its own.

---

## Part 6 — The Q5 Hallucination Investigation

### 6.1 What was observed

Question 5 — "How did engineers resolve the extreme 'Aetheric Hum' during early
high-energy Project Daedalus trials?" — scored **2/10** on both the 75.0 and 77.0
runs, with the generated answer claiming engineers used "ceramic dampeners" and
"tightened SCA coupling rigidity." Neither claim appears anywhere in the validated
source material — the real answer (per `ground-truth.json`) is that the breakthrough
was an accidental discovery of a precisely modulated, low-amplitude current cycle in
the Stabilized Coil Array (SCA), achieving the effect through resonance rather than
brute-force power. Getting the *same* fabricated details at temperature 0 (not just
similar-but-different wrong answers) was the signal that this was a systematic
failure, not sampling noise — worth investigating rather than dismissing.

### 6.2 The investigation

Temporary retrieval logging was added to `retrieveRelevantChunks` in
`ragService.ts` (selecting the actual cosine distance alongside each chunk, not just
`source`/`source_id`/`chunk_content`) to see exactly what context Q5 actually
received. The initial hypothesis was a retrieval/chunking gap — that the chunk
containing the real explanation simply never made it into the top-5 results.

The data disproved that hypothesis. The top-5 retrieved chunks for Q5 included two
chunks from the Research Paper's Section 1.5 (ranked #2 and #4 by distance). Chunk
index 2 of that document — one of the retrieved chunks — contains, in full:

> "...The Core Breakthrough. The ultimate breakthrough was an accidental discovery
> during the spectral analysis of a transient field collapse: a specific, precisely
> modulated, low-amplitude current cycle in the SCA could sustain the LGR effect
> without requiring the previously calculated brute-force energy. This indicated
> that the repulsive field was achieved through resonance and perturbation of the
> quantum vacuum, rather than simple energy delivery..."

That is exactly the correct answer, verbatim, sitting inside the context that was
handed to the model.

A second possible cause was also checked and ruled out: silent context-window
truncation. `ollama ps`, queried while a live request was in flight, showed
`llama3.2` running with a **4096-token** runtime context window (not the 131072
tokens the model architecture supports — Ollama's own runtime default, since
nothing in this codebase sets `num_ctx`). The actual assembled Q5 prompt was
measured directly: ~7,386 characters, ~1,041 words, roughly **1,850 tokens** —
comfortably under half the available window even accounting for the question and
generated output sharing the same budget. Nothing was silently cut off.

### 6.3 Conclusion: a generation failure, not a retrieval failure

Retrieval worked correctly. Nothing filtered the chunk out. Nothing truncated it
away. The model was given the right information, with room to spare, and still
fabricated a different, wrong answer instead of using it. A plausible contributing
factor: the correct chunk was ranked **#4 of 5** in the assembled context (chunks
are ordered by distance, and this wasn't the closest match), placing it in the
middle of the prompt rather than at the start or end. "Lost in the middle" — reduced
model attention to information buried mid-context versus at the edges — is a
documented weakness, more pronounced in smaller models. A 3B model juggling five
dense technical chunks plausibly deprioritized this one.

### 6.4 Attempted fix: citation-forcing + structured output — tried, and reverted

The most directly relevant mitigation for a confirmed generation-level problem is
**forcing inline citations** — requiring the model to state which numbered context
chunk backs each claim, on the theory that this would either force genuine
engagement with the correct chunk's content or produce a more overtly checkable
failure (a fabricated citation) instead of free-form invented prose.

**Design.** Rather than putting citation markers inside the user-visible answer text
(which would conflict with the existing "don't mention chunks, answer naturally"
rule and change what end users see), the model was switched to structured JSON
output via Ollama's `format: "json"` mode — the same mechanism already used for the
judge: `{"answer": "...", "citedChunks": [...]}`. `ask()` parses this and returns
only the `answer` field, so the API contract, the controller, the UI, and the eval
script all stay completely unchanged — only `ragService.ts` internals (the prompt
text and the `ask()` function body) were touched. The system prompt was also
strengthened: every specific number, percentage, or named mechanism must be
explicitly traceable to a numbered chunk, or omitted rather than invented.

**Result: it didn't fix Q5, and it cost points elsewhere.** Q5 still scored 2/10,
still fabricating "ceramic dampeners" and "60%." Inspecting the raw structured
output was diagnostic: the model returned `"citedChunks": [1]` — chunk [1] is the
Slack message that merely reports the *existence* of the Aetheric Hum problem
("Investigating reports of 'Aetheric Hum'..."), not the chunk containing the actual
resolution (chunk [2], the Research Paper excerpt from §6.2). The model complied
with the output format and produced a citation, but the citation wasn't the product
of real verification — it picked the most lexically obvious match (the chunk that
literally contains the phrase "Aetheric Hum") rather than checking whether that
chunk actually supports the specific claim being made. Citation-forcing produced a
structurally valid citation without a *reliable* one.

Re-running the full 10-question eval confirmed a **net regression**: 77.0 → 73.0.
Q1 and Q3 improved (7→9 each), but Q2, Q6, Q7, and Q10 all dropped (8→7, 10→7, 9→7,
9→7) — and the judge's justifications for those drops were consistently about
*omitted* correct details ("lacks context about the specific target profile,"
"missing 'localized thermal runaway'," "does not mention the separate warehouse
benchmark test"). The "leave it out rather than inventing something plausible"
instruction appears to have made the model measurably more conservative across the
board — trading away some willingness to state true, correct details, in exchange
for a fabrication reduction that didn't materialize on the one case it targeted.

**Decision: reverted.** Both the prompt changes and the JSON/`citedChunks`
mechanism in `ragService.ts` were rolled back to the original plain-text-answer
version, confirmed by re-running the eval and getting back the original 77.0/100
with identical per-question scores and justifications. This is treated as a
legitimate, informative negative result, not a failed session — the eval caught a
real regression from a real code change, which is exactly the job it exists to do.
Q5 remains an open, documented limitation; see Part 7.

---

## Part 7 — Known limitations / not yet handled

- **Single-run scores are noisy even at temperature 0.** Treat a few-point
  difference between runs as within plausible measurement noise, not a confirmed
  regression or improvement — see §5.2.
- **The judge itself is not perfectly reliable.** In the 77.0 run, Q1's generated
  answer correctly restated "8-hour (480 minutes)" — the same figure in two units —
  and the judge docked a point for it anyway, treating an equivalent restatement as
  an inaccuracy. Judge scores are a strong signal, not ground truth themselves.
- **The judge checks correctness against the ground truth, not faithfulness against
  the retrieved context.** A subtler hallucination — mostly right, plus one
  fabricated detail that doesn't contradict the ground truth's overall gist — could
  plausibly still score well under this design. Q5's hallucination was severe enough
  to also fail the correctness check, but that won't catch every case. This is the
  real RAGAS `faithfulness` metric's job specifically, and it's out of scope for
  this simplified version by design (see Part 1).
- **This is Option 1 of two possible paths.** A second implementation using the real
  Python `ragas` library is planned as a separate branch. `ground-truth.json`
  (question + ground-truth answer) is directly reusable for that path; the
  `supportingQuotes` field is not a substitute for what real RAGAS calls
  "retrieved contexts" (the actual chunks retrieval returns per question at eval
  time, not hand-picked source citations) — that would need to be captured
  separately if/when that path is built.
- **Q5 remains unfixed.** Citation-forcing plus a strengthened grounding instruction
  was implemented, tested, and reverted (§6.4) — it didn't fix this case and cost
  ~4 points elsewhere by making the model more conservative in general. This appears
  to be a genuine capability ceiling for `llama3.2` (3B) on this specific question,
  not something reachable by further prompt engineering alone. The untried options
  from that discussion — a stronger generation model, or a two-step
  extract-then-generate prompt — were deliberately parked, not ruled out for good.
