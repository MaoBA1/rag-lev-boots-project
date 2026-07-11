# Ask — Semantic Search & Answer Generation, Explained From Scratch

This document explains how `ask(userQuestion)` turns a user's question into a
grounded answer: what "semantic search" actually means, how it's implemented here,
a real bug we found and fixed in the process, and the exact design of the
retrieval + generation pipeline. It's written for a reader with no prior
background in embeddings or RAG systems — every concept is built up from first
principles before it's used.

It covers **retrieval and generation**. Getting the data into the database in the
first place is a separate document: [`load-data.md`](./load-data.md).

---

## Part 1 — The concepts, from scratch

### What is an embedding?

An embedding model turns a piece of text into a list of numbers — a vector. For
this project, that's 768 numbers per chunk of text (`nomic-embed-text`, running
locally via [Ollama](https://ollama.com)). What makes this useful is not the
numbers themselves, but a property the model is trained to have: **texts with
similar meaning produce vectors that are numerically close together, and
unrelated texts produce vectors that are far apart.**

Concretely, you can picture each 768-number vector as a single point in a
768-dimensional space (impossible to draw, but the 2D/3D intuition transfers).
"What is the Aetheric Field Generator?" and a chunk of text that actually explains
the Aetheric Field Generator will land near each other in that space. "What is the
capital of France?" will land somewhere far away from anything in a knowledge base
about levitation boots.

This is the entire trick that makes the rest of this document possible: **"find
text relevant to this question" becomes "find nearby points in vector space,"**
a purely numerical problem, once everything is embedded.

### What is semantic search / similarity search?

Traditional keyword search looks for literal word overlap. Semantic search looks
for *meaning* overlap, using embeddings: embed the search query the same way you
embedded your documents, then find which stored vectors are closest to the query
vector. A question can retrieve a relevant chunk even if they don't share a single
word in common, as long as the model judges them to be about the same thing.

### How do you measure "close"?

You need a concrete way to compare two vectors. This project uses **cosine
distance**: it measures the *angle* between two vectors, ignoring their length —
two vectors pointing in nearly the same direction are "close," regardless of
magnitude. It ranges from 0 (identical direction — as close as possible) to 2
(pointing in opposite directions).

This wasn't actually a choice we made freely — it was already baked into the
database schema before this project started. The scaffolded migration
(`20250927100126-create-embeddings-table.cjs`) built its indexes with
`vector_cosine_ops`, which commits the schema to cosine distance. Postgres's
`pgvector` extension exposes this as the `<=>` operator: `a <=> b` returns the
cosine distance between vectors `a` and `b`. We verified this hands-on early in
this project — comparing an identical vector to itself returned `distance: 0`,
confirming both the operator and our understanding of it.

### Why does retrieval need a "top-k" and how does the database actually search?

A `SELECT ... ORDER BY embeddings_768 <=> :question LIMIT k` query asks Postgres
for the `k` closest rows to the question vector. Without any index, Postgres has
no choice but to compute the distance between the query vector and **every row**
in the table, keep a running list of the k smallest, and return those — a
"sequential scan." This is exact (guaranteed correct) but gets slow as a table
grows into the millions of rows, since every single row must be visited.

Databases solve this at scale with **approximate nearest-neighbor (ANN)
indexes** — structures that pre-organize the vectors so a query can skip most of
the table instead of visiting every row, trading a small amount of accuracy for a
lot of speed. `pgvector` supports one such structure, **IVFFlat**: at index-build
time, it clusters all existing vectors into some number of buckets (`lists`) based
on which vectors are naturally near each other, and picks a representative
"center" for each bucket. At query time, it compares the query vector against just
the bucket centers, picks the closest bucket(s) (by default, just **one** — a
setting called `probes` controls how many), and only scans rows inside those
buckets.

This is the mechanism at the center of a real bug we found in this project — see
[The Broken Index Investigation](#the-broken-index-investigation) below.

---

## The Broken Index Investigation

The scaffolded project's migration created an IVFFlat index on `embeddings_768`
the moment the table was created — **before any data existed**. That's the origin
of a genuine, silent-failure bug we found while testing early retrieval queries.

### How we found it

While probing retrieval with real questions against our (already correctly
loaded, 87-row) `knowledge_base`, two clearly on-topic questions —
`"What is the Aetheric Field Generator?"` and `"What is hover-polo?"` — came back
with **zero results**, on a table with 87 rows and no `WHERE` clause that should
exclude anything. That's impossible for a healthy `ORDER BY ... LIMIT k` query, so
we investigated rather than assumed it meant "no relevant data."

We tested the identical query, identical question vector, one way with the index
enabled (the default) and one way with it forcibly disabled
(`SET enable_indexscan = off; SET enable_bitmapscan = off;`, which forces a
sequential scan):

```
WITH index (default):            []
WITHOUT index (forced seq scan): [
  { source: 'pdf', source_id: 'Research Paper - Gravitational Reversal Physics', distance: 0.366 },
  { source: 'pdf', source_id: 'White Paper - ...', distance: 0.367 },
  { source: 'pdf', source_id: 'Research Paper - Gravitational Reversal Physics', distance: 0.371 }
]
```

This confirmed the index itself was the problem, not the data or the query.

### Why it happened

IVFFlat's bucket centers are computed once, at `CREATE INDEX` time, from whatever
data exists in the table **at that instant**. They are not automatically
recomputed as rows get inserted afterward — new rows just get assigned to
whichever existing bucket center they land closest to. In this project's
migration history, `CREATE INDEX ... USING ivfflat` ran in the very same migration
that created the (then-empty) `knowledge_base` table, months before `loadAllData`
existed as working code to populate it. So the 100 bucket centers were computed
from **zero data** — there was nothing to cluster. `pgvector`'s own documentation
explicitly warns about this: load your data *first*, then build an IVFFlat index,
precisely to avoid this failure mode.

The practical effect: with default `probes = 1`, a query only checks the single
"closest-looking" bucket — and because that bucket's definition was based on
nothing, for some questions the one bucket it happened to pick genuinely contained
none of the real, relevant rows. The correct answer was sitting in a different
bucket that never got checked. Not "less accurate" — for those specific questions,
the search returned **nothing** instead of the correct answer, silently, with no
error.

### The fix, in two steps

**Step 1 — we first tried `REINDEX`,** which recomputes the bucket centers using
whatever data currently exists (`REINDEX INDEX knowledge_base_768_cosine_idx`).
This did fix the "wrong bucket → zero results" problem — post-reindex, the two
previously-broken questions returned their correct top match. But it exposed a
second, related problem: `LIMIT 3` queries were now returning only **1 row**
instead of 3. With `lists = 100` but only 87 total rows in the table, most buckets
hold 0 or 1 row — so even a *correctly* computed single bucket often just doesn't
contain enough candidates to satisfy the requested `LIMIT`, with `probes` still
defaulting to 1. `lists = 100` was sized for a dataset far larger than what this
project actually has (`pgvector`'s own sizing guidance is roughly
`lists ≈ rows / 1000` for smaller tables).

**Step 2 — given that, we chose to drop the index entirely** rather than tune
`lists`/`probes` further, via a project-written migration:
[`20260711113247-drop-ivfflat-768-index.cjs`](../migrations/20260711113247-drop-ivfflat-768-index.cjs) —
not part of the original scaffold:

```sql
-- up:
DROP INDEX IF EXISTS knowledge_base_768_cosine_idx;

-- down (reversible):
CREATE INDEX knowledge_base_768_cosine_idx
ON knowledge_base USING ivfflat (embeddings_768 vector_cosine_ops)
WITH (lists = 100);
```

With no index, every `<=>` query against `embeddings_768` is now an honest,
exhaustive sequential scan — slower in theory, but at 87 rows the difference from
an index is imperceptible, and it's simply *correct*, with no risk of an
unlucky-bucket false negative. We re-verified both previously-broken questions
returned their full, correct top-3 afterward. This should be revisited (rebuild an
index, ideally after tuning `lists` to the real row count, or reconsidering at a
larger scale) if the table ever grows enough that a full scan becomes genuinely
slow — not before.

> Note: `knowledge_base_1536_cosine_idx` (the sibling index on the unused
> `embeddings_1536` column) was left in place. It has the exact same
> empty-table-origin problem, but since that column has zero rows ever written to
> it (this project uses 768 dimensions only — see `load-data.md`), it's inert
> rather than actively wrong. Worth dropping too if that column is ever used.

---

## Part 3 — The `ask()` design

### 3.1 The hybrid grounding problem

A pure `ORDER BY ... LIMIT k` query always returns exactly k rows, no matter how
irrelevant they are — ask "What is the capital of France?" against a levitation
boots knowledge base, and you'll still get back the k *least bad* levitation-boot
chunks. If those get handed to an LLM with "answer from this context," a model can
still hallucinate an answer, or answer despite the context being useless. Two
independent mechanisms guard against this, each covering a different failure
mode:

1. **A distance threshold** — a cheap, deterministic pre-filter. If nothing
   retrieved is even plausibly relevant, don't call the LLM at all; return a fixed
   "no data" message. Zero cost, zero hallucination risk, for the "nothing here is
   even close" case.
2. **An instruction inside the LLM prompt** — for the harder case: retrieved
   content that's topically related but doesn't actually answer the specific
   question asked. No distance number can catch this; it requires real
   understanding, which only the LLM can provide, so we explicitly instruct it to
   say so rather than guess.

### 3.2 Picking the threshold — from real data, not a guess

Cosine distance doesn't have a universal "good" cutoff — it depends on the
embedding model and the shape of this specific corpus. We measured it directly:
embedded a set of on-topic, intentionally-ambiguous ("borderline"), and
clearly-off-topic questions against the real (post-fix) 87-row `knowledge_base`,
and looked at each question's closest-match distance.

| group | questions | min-distance range | avg |
|---|---|---|---|
| **on-topic** — known to be directly covered | 6 | 0.2654 – 0.3663 | 0.3168 |
| **borderline** — deliberately ambiguous, no known ground truth | 2 | 0.3804 – 0.4450 | 0.4127 |
| **off-topic** — known to be unrelated | 6 | 0.4775 – 0.6164 | 0.5446 |

The "borderline" pair (`"How do wheeled vehicles compare to other forms of
personal transportation?"`, `"What safety regulations exist for personal
transportation devices in general?"`) were chosen specifically because we didn't
know the right answer in advance — they're phrased generically rather than
mentioning lev-boots, while the actual corpus likely discusses lev-boots in
comparison to cars/bikes as background context. That ambiguity is the point: their
distance scores tell us how the embedding model treats genuinely gray-area
questions, which is the real input needed to place a threshold that will face
real, imperfectly-phrased user questions.

Two clean gaps appear: on-topic tops out at 0.3663 before borderline starts at
0.3804 (~0.014 gap); borderline tops out at 0.4450 before off-topic starts at
0.4775 (~0.033 gap, wider and more reliable). **We set the threshold at the wider
gap: 0.46** (`(0.4450 + 0.4775) / 2 ≈ 0.461`) — deliberately the *permissive*
choice between the two gaps. This means both on-topic and borderline questions
reach the LLM and get a real chance at an answer; only the clearly-unrelated
questions get short-circuited before that. The reasoning ties directly back to
§3.1: the threshold's only job is "is there anything worth showing the model," not
"is this definitely answerable" — that second judgment belongs to the LLM, which
has actual understanding to bring to genuinely ambiguous cases, and cutting them
off early would deny it that chance.

### 3.3 The full sequence

```
ask(userQuestion)
  1. embed userQuestion via Ollama (nomic-embed-text, same model used when loading)
       → questionVector (768 numbers)

  2. similarity search:
       SELECT source, source_id, chunk_content
       FROM knowledge_base
       WHERE embeddings_768 <=> questionVector < 0.46
       ORDER BY embeddings_768 <=> questionVector
       LIMIT 5
       → 0 to 5 rows, closest first (see note below on why WHERE + ORDER BY
         combine cleanly here)

  3. if 0 rows returned:
       → return a fixed string immediately, no LLM call:
         "I don't have any information about that in the Lev-Boots knowledge base."

  4. else:
       → build two messages and call llama3.2 via Ollama's /api/chat:
           - system message: instructions + the retrieved chunks (§3.4)
           - user message: the raw userQuestion, unmodified
       → return the model's response as the answer
```

> **Why `WHERE ... < 0.46` combined with `ORDER BY` just works, with no special
> "check only the closest one" logic needed:** since results are sorted by
> distance ascending, filtering every row by the same threshold and keeping the
> sorted top-k are actually the same operation — the `WHERE` clause simply drops
> the failing tail of an already-sorted list. "0 rows passed" and "the closest row
> alone failed" are consequently the same condition, with no extra code required
> to distinguish them.

**Why the LLM call uses `/api/chat` and not `/api/generate`:** Ollama's
`/api/generate` endpoint only accepts one flat `prompt` string — there's no notion
of separate "system instructions" vs. "user question." `/api/chat` accepts a
`messages: [{ role, content }]` array with distinct `system` and `user` roles,
which is what lets us cleanly separate "here are your instructions and the
retrieved material" from "here is literally what the user asked," rather than
concatenating everything into one string.

### 3.4 The system prompt

Built fresh per request, with the retrieved chunks interpolated in:

```
You are a knowledge assistant for Lev-Boots, a personal gravity-reversal levitation
device. Answer the user's question using ONLY the context chunks provided below,
which were retrieved from an internal knowledge base (technical PDFs, published
articles, and internal team Slack discussions).

Rules:
- Base your answer strictly on the provided context. Do not use any outside
  knowledge, assumptions, or general knowledge about physics, levitation
  technology, or similar products.
- If the provided context does not contain enough information to answer the
  question, respond with exactly: "I don't have enough information in the
  knowledge base to answer that question." Do not guess, speculate, or partially
  answer from incomplete context.
- Be concise and factual. Do not mention "the context," "chunks," or that you were
  given retrieved material - just answer naturally, as if this is what you know.

Context:
[1] (source: pdf, id: "White Paper - The Development of Localized Gravity Reversal Technology")
<chunk_content>

[2] (source: article, id: hover-polo)
<chunk_content>
...
```

Two deliberate choices worth calling out:

- The model is told to use the **exact same wording**
  (`"I don't have enough information in the knowledge base to answer that
  question."`) as its own fallback, distinct from — but consistent in tone with —
  the pre-LLM fallback string from step 3 above
  (`"I don't have any information about that in the Lev-Boots knowledge base."`).
  Two different code paths trigger these two messages (one skips the LLM entirely,
  one is the LLM's own judgment), but a user shouldn't be able to tell that from
  the wording — both should read as one consistent voice.
- The model is told **not** to reference "the context" or "chunks" explicitly, so
  answers read naturally rather than sounding like a search-result summary.

---

## Part 4 — Verification

All 14 test questions from §3.2's investigation were run against the live
`POST /api/ask` endpoint end-to-end (embedding → retrieval → generation, exactly
as a real user request would flow):

- **6/6 on-topic** questions got specific, accurate, grounded answers (e.g. "What
  is the maximum sustained levitation time of the LV-1 prototype?" correctly
  answered "4.5 minutes at an altitude of 2 meters"), each taking ~5-6 seconds
  (embed + retrieve + generate).
- **2/2 borderline** questions correctly reached the LLM (passed the 0.46
  threshold, ~3-4 seconds) and the model correctly judged it couldn't answer them,
  responding with its instructed fallback phrase.
- **6/6 off-topic** questions were correctly short-circuited before ever reaching
  the LLM (~100ms each — just the embedding call), returning the fixed fallback
  string.

This confirms both halves of the hybrid design (§3.1) are doing their intended,
distinct jobs.

---

## Part 5 — Known limitations / not yet handled

- **No index on `embeddings_768`** (Part 2) — fine at the current scale (87 rows),
  should be revisited if the table grows significantly.
- **Error handling is generic.** If Ollama or the database is unreachable during
  `ask()`, the request fails and the controller returns a generic
  `"Something went wrong, please try again later."` to the user — there's no
  retry, partial-degradation, or specific diagnosis of *which* dependency failed.
- **The threshold (0.46) is calibrated to this specific corpus and embedding
  model.** If the knowledge base's content domain changes significantly, or the
  embedding model changes, this number would need to be re-derived the same way
  (§3.2), not assumed to still be correct.
