# Gatekeeper — Filtering Non-Informative Data, Explained From Scratch

This document covers the Gatekeeper bonus from `EXTRA_CHALLENGES.md`: a filtering
step that runs before embedding, dropping low-value content before it ever reaches
the knowledge base. It's written the same way as the other docs in this project —
built up from first principles, with the real design conversation narrated,
including the directions that were tried and walked back, and *why*, not just the
final state.

This branch (`gatekeeper`) is a sibling of both RAGAS branches, branched
independently from `main` — it shares nothing with either RAGAS implementation,
since it lives entirely inside the existing `loadAllData` pipeline, not as a
separate script.

---

## Part 1 — What the Gatekeeper is, and where it lives

Per the doc: right now, everything gets embedded and stored unconditionally — a
Slack message like "lol" or "any updates?" adds no value, but nothing currently
stops it from being embedded and searched over like any other content. The
Gatekeeper is a classification step that runs *before* embedding, asking an LLM
whether a piece of content is actually informative, and only storing the pieces
that are.

Architecturally, this is much simpler than either RAGAS implementation: it's not a
separate script or a new endpoint, it lives entirely inside the existing
`loadAllData` → `storeAllDocs` → `storeDoc` pipeline, in `knowledgeBaseStore.ts`,
as one more step per chunk before the embed-and-insert step.

---

## Part 2 — Granularity: unit-level, not chunk-level

The first real design decision: should filtering happen on raw units (individual
Slack messages, before packing into chunks) or on already-packed chunks (after
`packIntoChunks`)?

Chunk-level filtering is closer to the doc's literal wording ("pass 'informative'
*chunks*") and simpler to bolt on, but it has a real contamination problem: a
packed chunk mixes several messages together, so a single "lol" sitting inside an
otherwise-substantive chunk could bias the judge either way — reject the whole
chunk despite real content being in it, or accept the whole chunk while the noise
just sits there unfiltered, diluted but still present. Cleaning a chunk after the
fact (stripping just the noisy piece back out) would require re-processing work
that unit-level filtering avoids by construction.

**Decided: unit-level.** Filter before packing, so a single "lol" message can be
dropped without affecting anything else in its thread — the packer would then only
ever see the units that survived filtering.

---

## Part 3 — Scope: Slack-only → all sources → back to Slack-only

This went through two full reversals, and both were driven by genuine new
information, not indecision.

**Round 1 — Slack-only.** The doc's own example (noise like "lol") is a Slack
phenomenon. PDFs and articles are curated, published documents — a sentence from a
research paper or a paragraph from an article is essentially never going to be
genuine throwaway noise the way a chat message can be. Applying unit-level
filtering to all three sources would mean many classifier calls spent on content
that's already almost guaranteed to pass, for comparatively little benefit.

**Round 2 — expanded to all sources.** The batching redesign in Part 4 below
(judging all of a chunk's units in one call, rather than one call per raw unit)
substantially reduced the cost argument — going from one call per unit to one call
per chunk cut the total call count roughly 4x. With volume less of a concern, and
since the underlying `packIntoChunks` return-type change was going to touch all
three sources' call sites regardless, extending to all sources seemed like a small
incremental cost for a small incremental benefit (PDFs/articles aren't
*guaranteed* noise-free either — a bare section header or citation line could
plausibly get caught too).

**Round 3 — reverted back to Slack-only.** This reversal happened for an entirely
different reason than the original volume concern — see Part 5. Once it became
clear that reusing the new unit-preserving packer for PDFs/articles could produce
very large, poorly-focused chunks (a real, documented ~1000-word article
paragraph becoming one single oversized chunk instead of several focused ones),
the actual cost of "extend to all sources" turned out to be much higher than
originally assumed — not in LLM call volume, but in embedding quality. That
changed the calculus back: the original Round-1 reasoning (PDFs/articles are
curated, don't need judging) was sound on its own terms all along; the only reason
it was overridden was "the packer change is happening anyway, so why not" — and
once that packer change turned out to need to be source-specific anyway, that
justification for going universal quietly stopped applying too.

**Final: Slack-only**, using two separate packing functions — see Part 5.

---

## Part 4 — Batching: one call per chunk, not one per unit

Rather than sending each unit to the judge in isolation, all of one chunk's units
are sent together in a single call, and the judge returns a verdict for each one.
This solves two problems at once:

- **Context**: a short reply like "Confirmed" reads as noise in isolation, but
  might be significant if it's affirming a specific technical claim made in a
  neighboring message. Judging units within their real neighborhood (rather than
  totally isolated) lets the judge use that context correctly, without
  reintroducing the whole-chunk contamination problem from Part 2 — the *judgment*
  uses context, but the *unit boundary* stays exactly where it was, so a
  significant message doesn't drag an insignificant neighbor along with it or vice
  versa.
- **Cost**: one call per chunk (41 for the Slack corpus) instead of one per raw
  unit (181 messages) — a meaningful reduction, relevant again once the "all
  sources" question came up in Part 3.

**Output schema — index, not echoed text.** The original idea was
`{unit, significant}` per item — having the judge echo back the unit's text
alongside its verdict. Rejected: LLMs don't reliably reproduce text *verbatim*
when asked to echo it (a fixed typo, normalized whitespace), and matching a
returned string back against the original unit list by exact equality would break
the moment that happened. Switched to `{index, significant}` instead — the units
are numbered in the prompt, and the judge references them by number, avoiding
fragile text-matching entirely. This is the same pattern already used successfully
elsewhere in this project (numbered context chunks `[1]`, `[2]` in the RAG prompt).

---

## Part 5 — The `packIntoChunks` redesign, the conflict it created, and the resolution

### 5.1 Why the return type needed to change

The original `packIntoChunks` returned `string[]` — chunks already joined into
one blob, with unit boundaries discarded. For the Gatekeeper to judge individual
units within a chunk, something needs to preserve which units compose each chunk.
The chosen approach: change the return type to `string[][]` — one array of
constituent unit strings per chunk, never joined — rather than trying to
reconstruct unit boundaries after the fact from an already-joined string (which
would need a fragile delimiter scheme, risky if a unit's own text ever contained
it).

### 5.2 The conflict this created with `max`

The original algorithm enforced the 400-word `max` by **slicing a unit's words**
whenever the running buffer exceeded it — including mid-unit, splitting a single
unit's own words across two different chunks (the documented behavior: a
1000-word paragraph becomes 400+400+200). That's fundamentally incompatible with
clean unit-tracking: a chunk can't cleanly "be composed of these whole units" if
the algorithm that built it was willing to cut straight through the middle of one.

Concretely traced through: buffer at 150 words (under `min=200`, hasn't closed),
next unit is 300 words. The original algorithm pushes all 300 words in
unconditionally, then slices the combined 450-word buffer into a 400-word chunk
(the 150 old words plus the *first* 250 words of the new unit, glued together at
an arbitrary word-count mark unrelated to any real boundary) — leaving the *last*
50 words of that same unit dangling into whatever chunk comes next. That single
unit ends up split across two different chunks, and two unrelated units end up
merged inside one.

Once units must stay whole (a hard requirement for the redesign to mean
anything), there's a genuine three-way conflict when a buffer under `min` meets a
large incoming unit: keep the unit whole (violates `max`), split the unit
(violates the whole point of this redesign), or flush the under-sized buffer early
to make room (violates `min`, recreating exactly the near-empty-chunk problem
`min` exists to prevent). No ordering of these three constraints can always be
satisfied simultaneously once slicing is off the table.

**Initial resolution**: let `max` flex — accept that a chunk may occasionally
exceed 400 words rather than break a unit or violate `min`. This meant `max` no
longer did anything functionally, so it was removed from `packIntoChunks`'s
signature rather than left as a parameter that silently did nothing.

### 5.3 Why that resolution wasn't actually safe for every source

Under the new rule, a chunk's maximum size is bounded by roughly `200 (whatever
was already buffered, always under min) + (the size of whichever single unit
finally pushed it over)`. For Slack, this is a non-issue — messages are
documented at ~20-50 words each (`load-data.md`), so this scenario essentially
never arises. For PDF sentences, also essentially never an issue. But for
**article paragraphs**, this isn't hypothetical: the exact ~1000-word paragraph
referenced in `load-data.md`'s original "400+400+200" example genuinely exists in
the real source articles. Under the new algorithm, that same paragraph becomes
**one single ~1000+ word chunk** instead of three focused ones.

That's a real embedding-quality regression, not just a technicality: compressing
a very long chunk into one embedding vector tends to blur/dilute its semantic
signal compared to several smaller, focused embeddings. The original mechanical
slicing was worse for unit-boundary cleanliness, but it was *better* at keeping
every chunk in a bounded, focused size range — a real tradeoff the "let max flex"
fix was quietly making worse specifically for articles, the one source where it
was most likely to matter.

One considered alternative was pushing the size limit further upstream — teaching
`splitIntoParagraphs` to fall back to sentence-splitting for any individual
paragraph that comes out unusually large, so `packIntoChunks` would never
encounter a pathologically oversized unit in the first place. Rejected as
unnecessary once the scope decision below made it moot.

### 5.4 Final resolution: two separate packing functions, split by source

Given article/PDF content doesn't need Gatekeeper filtering at all (Part 3's final
scope decision), there's no actual need for those two sources to use the new
unit-preserving packer in the first place. Restoring the original `packIntoChunks`
(strict `min`/`max` via slicing, `string[]`) for PDF and article eliminates the
size-explosion problem entirely — that paragraph goes back to being cleanly sliced
into 400+400+200 as it always was, since nothing needs to inspect its unit
boundaries anymore.

A second, new function — `packIntoReversibleChunks` — keeps the `min`-only,
whole-units-preserved, `string[][]` behavior, but is only ever called for Slack,
where the "chunk exceeds a typical size" scenario the new algorithm allows for
essentially never triggers in practice (messages are too short). Two small,
focused functions instead of one trying to serve two incompatible needs — matches
how the rest of this codebase is already structured (one file per concern in
`services/chunking/`).

```
server/services/chunking/
  packIntoChunks.ts            — original: string[], strict min/max via slicing
                                  (PDF, article)
  packIntoReversibleChunks.ts  — new: string[][], min-only, whole units preserved
                                  (Slack only)
```

`knowledgeBaseStore.ts`'s `storeDoc` branches by source: Slack goes through
`packIntoReversibleChunks` + the Gatekeeper (a chunk's stored content is `null` if
every unit in it was filtered out, and that index is skipped rather than stored
empty); PDF and article go through the original `packIntoChunks` directly, joined
straight to `chunk_content` exactly as before, with the Gatekeeper never invoked
for those two sources at all. Chunk indices stay stable in both paths (they're the
packer's original output position, unaffected by filtering), so the existing
dedup mechanism (`getExistingChunkIndices`) continues to work unchanged.

---

## Part 6 — The prompt

```
You are a data-quality classifier for a Lev-Boots knowledge base. You will be
given a numbered list of messages that together make up one chunk of a Slack
conversation thread. For each message, decide whether it is significant: does it
contain concrete, verifiable information about Lev-Boots (a specific technical
detail, measurement, decision, finding, or safety-relevant fact) that would be
useful to someone searching a knowledge base about Lev-Boots?

Use the surrounding messages as context - a short or otherwise ambiguous message
is significant if it depends on or reinforces a specific claim made nearby, but
not significant if it carries no informational content of its own even in
context.

Rules:
- NOT significant: greetings, social acknowledgments, pure status-check questions
  with no information of their own, or off-topic chatter unrelated to Lev-Boots.
- Significant: any message stating a concrete fact, number, decision, or finding
  about Lev-Boots technology, engineering, or safety - even if brief.
- Judge every message independently, but let the surrounding messages inform your
  judgment of each one.

Respond with ONLY a JSON object in this exact shape, no other text, with one
entry per message listed below:
{"verdicts": [{"index": <message number>, "significant": <true or false>}, ...]}

Messages:
[1] ...
```

This was originally written in a source-agnostic way (mentioning "a Slack
conversation, a technical paper, or a published article") back when the scope
still included all three sources. Once scope reverted to Slack-only (Part 3,
round 3), the prompt was simplified back to Slack-specific wording — including
dropping a "structural text like section headers" example that only made sense
for PDF/article content — to keep the prompt honest about what it actually judges,
rather than leaving generalized language describing cases the judge will never
actually see.

The output schema itself also changed once, after the first real test run
surfaced a real bug — see Part 8.

The domain-specific criteria (concrete Lev-Boots facts vs. social/status noise)
come directly from the doc's own example and what's been directly observed in this
corpus across earlier investigation (this project's own RAGAS work read through
large portions of the real Slack corpus while validating ground-truth Q&A pairs).

**Judge model: `qwen2.5:7b`**, not `llama3.2`. A false-positive filtering mistake
here permanently drops real Lev-Boots knowledge from the corpus — a more
consequential failure mode than a single RAG answer being slightly off — so the
stronger, already-proven-reliable model (used as the judge in both RAGAS
implementations) was chosen over the weaker production generator.

---

## Part 7 — Rejection logging

Per the doc's requirement ("track rejections in logs so you can debug what's being
filtered"): a single continuous, append-only log at
`server/gatekeeper_rejections.json`. Each entry:

```json
{ "timestamp": "...", "source": "slack", "source_id": "m0018", "unit": "..." }
```

Chosen as a single growing file rather than per-run timestamped files (unlike the
RAGAS logs): this runs as part of normal `loadAllData` operation, not a series of
discrete, comparable checkpoint runs — it's closer to an ordinary operational log
than to an evaluation artifact. `source` was added to the originally-agreed shape
(`{timestamp, source_id, unit}`) during the "all sources" phase of Part 3 and kept
even after reverting to Slack-only, since it costs nothing and makes each entry
fully self-describing without needing to cross-reference anything else.

---

## Part 8 — First real run: a bug, and the results

Before this could be tested, the existing `knowledge_base` table (87 rows, from
before this branch existed) had to be cleared — the dedup mechanism means a fresh
`loadAllData` run would otherwise skip everything regardless of the Gatekeeper.

### 8.1 A real bug: the judge didn't return the array shape it was asked for

The first real run crashed on the very first Slack thread:
`TypeError: verdicts.filter is not a function`. Reproduced directly against
`qwen2.5:7b` to see the actual raw output: instead of the requested JSON array
(`[{"index": 1, "significant": true}, ...]`), the model returned a **single bare
object** — `{"index": 1, "significant": true}` — silently ignoring the other
messages in the chunk entirely.

This is a known category of limitation with Ollama's `format: "json"` mode: it
guarantees syntactically valid JSON, but not that it matches any particular
*shape* — a model can satisfy "valid JSON" while still not producing the
structure the prompt asked for. Verified empirically that wrapping the array in a
named object key fixed it reliably: `{"verdicts": [{"index": 1, ...}, {"index": 2,
...}, {"index": 3, ...}]}` — a top-level object is a more common training pattern
for structured output than a top-level array, and this matches something already
observed working reliably elsewhere in this project (the RAGAS-adjacent citation
experiment's `{"answer": ..., "citedChunks": [...]}` shape). The prompt and
parsing code were both updated to this schema (Part 6).

### 8.2 Results

Final `knowledge_base` state: **86 rows** (23 pdf + 23 article + 40 slack, down
from the original 87) — PDF and article counts unchanged, exactly as expected
since the Gatekeeper never touches them.

- **One entire Slack thread was dropped**: `m0045` — five messages, all Friday-
  afternoon banter ("Almost weekend! Thank goodness...", "Half-day today...",
  talk of custom boot skins and a "$20 million" market aside), with zero
  technical content start to finish. This is exactly the failure mode the doc
  describes.
- **76 individual messages were trimmed** from otherwise-kept threads (logged in
  `gatekeeper_rejections.json`). Spot-checking a sample: the large majority are
  unambiguously correct rejections — lunch/food chat, memes, weekend plans,
  personal soreness complaints.
- **A real, honest quality pattern in the rejections, not hidden**: a handful of
  filtered messages actually contain a genuine number or fact, just wrapped in
  casual phrasing — e.g. *"Nice! 5.1 minutes is a 13% gain over the original 4.5m
  mark, just through software. Impressive."* and *"Primary battery temp
  stabilizing at 40C during short 4.5m bursts."* both got rejected despite
  containing real figures. The judge appears to weight conversational tone
  ("Nice!", "Impressive") fairly heavily, sometimes over an embedded fact. These
  are genuinely borderline calls rather than clear errors, and the same
  underlying facts (the LV-1's 4.5-minute limit, for instance) are stated more
  plainly elsewhere in the corpus already — but it's a real, worth-knowing
  limitation of the current prompt rather than a perfect result.

---

## Part 9 — Known limitations / not yet done

- **The prompt weights tone over content in some borderline cases** (Part 8.2) —
  not fixed, since the underlying facts in the affected messages are generally
  redundant with content stated elsewhere in the corpus, but a real limitation of
  the current rubric worth revisiting if precision here matters more later.
- **The "extremely small post-filter chunk" edge case is accepted, not handled.**
  If a thread is mostly noise and only one short message survives filtering, the
  resulting chunk could be genuinely tiny — closer to the actual near-empty-chunk
  problem `min` exists to prevent, not just moderately smaller. Noted as a rare
  tail case during design, deliberately not solved now.
- **PDF/article content is never judged at all**, by design (Part 3) — if that
  assumption ever turns out to be wrong (some genuinely low-value content slips
  into a curated source), there's no mechanism here to catch it.
