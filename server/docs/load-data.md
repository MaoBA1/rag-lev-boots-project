# Load Data — Design & Flow

This document explains how `loadAllData()` populates the `knowledge_base` table: the
architecture, the chunking algorithm, why each source is handled the way it is, and
how we guarantee that re-running data loading never produces duplicate rows.

It covers the **loading** side only. `ask()` (retrieval + answer generation) is a
separate, not-yet-implemented piece and is out of scope here.

---

## 1. Architecture

```
loadAllData()
  ├─ pdfLoader.loadPdfs()          ─┐
  ├─ articleLoader.loadArticles()  ─┼─▶ LoadedDoc[]  ──▶ knowledgeBaseStore.storeAllDocs()
  └─ slackLoader.loadSlackMessages()┘
```

**Principle: loaders only fetch and normalize, they never chunk.**

Each loader (`services/loaders/*.ts`) knows *only* how to get raw text out of one
source and return it as:

```ts
interface LoadedDoc {
  source: 'pdf' | 'article' | 'slack';
  source_id: string;
  text: string;
}
```

Chunking, embedding, dedup-checking, and inserting into Postgres all happen in one
shared pipeline (`knowledgeBaseStore.ts`), regardless of which source the text came
from.

**Why split it this way:** the three sources have completely different fetch
mechanics (local file + PDF parsing, HTTP fetch of markdown, paginated + rate-limited
API), but once you have raw text, turning it into stored, embedded chunks is
identical work. Splitting along "what's actually different" avoids duplicating the
chunk/embed/store logic three times, and keeps each loader trivial to read in
isolation.

---

## 2. Chunking algorithm

### 2.1 The core packer: `packIntoChunks(units, min = 200, max = 400)`

All three sources ultimately feed a list of text **units** into the same function
(`services/chunking/packIntoChunks.ts`). A unit is source-dependent (see §3), but the
packing algorithm doesn't care what a unit represents — only that it shouldn't be
split arbitrarily.

Algorithm, walking units in order with a running word buffer:

1. Append the unit's words to the buffer.
2. If the buffer now exceeds `max` (400) words, slice off 400-word chunks
   repeatedly until what's left is ≤ 400. (Handles a single long unit that alone
   blows past the max — e.g. a 1000-word paragraph becomes 400 + 400 + 200.)
3. After processing a unit, if the buffer has reached `min` (200) words, emit it as
   a chunk and reset the buffer. If it's still under 200, **don't** emit — keep
   accumulating with the next unit's words instead of leaving a too-small,
   low-signal chunk standing alone.
4. At the very end of a document, emit whatever's left in the buffer even if it's
   under 200 — there's nothing left to merge it with.

Result: every chunk is 200–400 words, except possibly the very last chunk of a
document.

**Why min 200 / max 400 / merge-forward instead of fixed-size windows:** a pure
fixed-size window (e.g. every chunk = exactly 400 words) would frequently cut a
chunk mid-unit — mixing the tail of one topic with the head of an unrelated one,
which dilutes the chunk's embedding and hurts retrieval precision. Respecting unit
boundaries keeps each chunk topically coherent. The 200-word floor exists so we
don't end up with many near-empty, low-signal chunks (e.g. a single short paragraph
or a two-word list item) that embed poorly and rarely surface as useful search
results.

### 2.2 Units are source-dependent, not one-size-fits-all

`knowledgeBaseStore.ts` picks a "unit splitter" per source before calling
`packIntoChunks`:

| source    | splitter                | unit        |
|-----------|--------------------------|-------------|
| `article` | `splitIntoParagraphs`    | paragraph   |
| `pdf`     | `splitIntoSentences`     | sentence    |
| `slack`   | `splitIntoMessages`      | message     |

**Why not the same unit everywhere:** the whole point of unit-based (vs. fixed
window) chunking is that a unit boundary should represent a real semantic boundary.
That signal is only reliable where the source actually gives it to us — see §3 for
why each source got the unit it did.

---

## 3. Loader-by-loader flow

### 3.1 `articleLoader.ts` — markdown articles

**Flow:**
1. Build 5 URLs from the known article IDs (`military-deployment-report`,
   `urban-commuting`, `hover-polo`, `warehousing`, `consumer-safety`) against the
   gist base URL.
2. `fetch()` each URL, read the raw markdown text.
3. Return `{ source: 'article', source_id: <article-id>, text: <raw markdown> }` per
   article.

**Unit = paragraph**, via `splitIntoParagraphs`:
- Split on blank lines (`\n\s*\n+`) — markdown's real, author-intended paragraph
  boundary.
- If a blank-line-separated block turns out to be a markdown list (every line
  starts with `-`, `*`, `+`, or `N.`), split it further into one unit per list item,
  instead of treating the whole list as one paragraph.

**Why paragraph, not sentence or fixed window:** markdown source has genuine
blank-line paragraph breaks — real, author-intended topic boundaries, free of
charge. Throwing that away in favor of sentence-level accumulation would let a
chunk blend the tail of one paragraph with the unrelated start of the next, which
is exactly the coherence problem unit-based chunking exists to avoid. List items get
their own unit for the same reason a header does implicitly (see below) — each
bullet is typically its own small idea, not a continuation of the previous one.

### 3.2 `pdfLoader.ts` — the 3 local PDFs

**Flow:**
1. Read all `.pdf` filenames from `server/knowledge_pdfs/`.
2. For each, read the file and run it through `pdf-parse` (pinned to **v1.1.1** —
   see callout below).
3. `source_id` = filename without the `.pdf` extension.
4. Return `{ source: 'pdf', source_id, text }` per file.

**Unit = sentence**, via `splitIntoSentences`, **not paragraph**. This is a
deliberate deviation from the article loader, and the reason is empirical, not
aesthetic:

> We ran `pdf-parse` on all 3 PDFs and inspected the raw output before deciding
> anything. Findings:
> - Every line break in the extracted text is a single `\n` — mid-sentence
>   word-wraps, real paragraph transitions, and section headers are all
>   **indistinguishable** from each other in the output.
> - The only double-newline (`\n\n`) in each file's output corresponds exactly to
>   page boundaries (count of `\n\n` == `numpages` in all 3 files) — and it lands
>   **mid-word/mid-sentence** (e.g. `"were no \n\nlonger bound by"`,
>   `"peak at 180∘C \n\ncoil temperatures"`). It's a pagination artifact from how
>   `pdf-parse` joins per-page text, not a semantic marker.
>
> Conclusion: there is no usable "blank line = paragraph break" signal in PDF text
> extracted this way. PDF is a layout format, not a semantic one — it stores visual
> line positions, not "this is a paragraph" metadata, so `pdf-parse` can't recover
> real paragraph boundaries even in principle without much heavier per-glyph
> position analysis.

Given that, sentence boundaries (`.`, `!`, `?`) are the most reliable semantic unit
we can actually detect from this data — unambiguous from punctuation, unlike
paragraphs. `splitIntoSentences`:
1. Collapses all whitespace/newlines to single spaces first (safe: since we don't
   rely on paragraph structure for PDFs, a page-break newline landing between two
   words just becomes a normal space, doing no harm).
2. Walks the text and cuts a sentence at `.`/`!`/`?` when followed by whitespace and
   an uppercase letter or digit (or end of string) — with a guard against splitting
   on decimal numbers (`3.5`) by requiring a digit on both sides of a `.` to *not*
   count as a boundary.

This is a heuristic, not a full NLP sentence tokenizer — acceptable here since the
alternative (guessing at paragraph boundaries from an unreliable page-break
artifact) would have been worse, not better.

**`pdf-parse` version callout:** `npm install pdf-parse` pulls **v2.4.5** by
default, which is a ground-up rewrite with a class-based API (`PDFParse`), not the
simple function-based API most docs (including the README's link) describe. We
pinned `pdf-parse@1.1.1` explicitly in `package.json` to get the classic
`pdfParse(buffer) → { text, numpages }` API. It's CommonJS-only with no ESM default
export, so it's loaded via `createRequire(import.meta.url)` rather than a normal
`import`.

### 3.3 `slackLoader.ts` — the paginated Slack API

**Flow:**
1. For each of the 3 channels (`lab-notes`, `engineering`, `offtopic`), fetch page 1
   to learn `total` and `limit`, compute `totalPages = ceil(total / limit)`, then
   fetch the remaining pages sequentially.
2. Flatten all messages from all 3 channels into one array.
3. Group messages by `thread_ts` into a `Map<threadTs, SlackMessage[]>`.
4. Within each thread, sort messages chronologically by `ts` and join them into one
   text blob, one message per line, formatted as `"{user} ({role}): {text}"`.
5. Return `{ source: 'slack', source_id: <thread_ts>, text }` per thread.

**`source_id` = `thread_ts` (the thread's root message id), not the channel.**

We inspected the actual API response shape before deciding this:

```json
{
  "channel": "lab-notes", "page": 1, "limit": 10, "total": 71,
  "items": [
    { "id": "m0004", "channel": "lab-notes", "user": "Sinai", "role": "scientist",
      "ts": "2025-10-01T09:05:41Z", "text": "...", "thread_ts": "m0004" }
  ]
}
```

- Messages are short (~20–50 words) — far under our 200-word chunk floor, so a
  single message can never stand alone as a chunk; grouping is mandatory.
- We considered grouping by **channel** (flatten the whole channel's history as one
  document) vs. by **thread** (each conversation as its own document), and chose
  thread: a thread is a coherent conversation about one thing (verified — e.g.
  thread `m0018` in `lab-notes` is a single multi-reply exchange about one shielding
  problem), which is exactly the kind of real semantic boundary paragraph/sentence
  splitting was chosen for in the other two loaders. Grouping by channel instead
  would reintroduce the "adjacent-but-unrelated content glued together" problem we
  specifically avoided elsewhere.
- We verified `thread_ts` values are safe to use directly (unprefixed by channel):
  pulled and cross-checked all 181 messages across all 3 channels and found threads
  occasionally get replies from a **different** channel than the thread started in
  (3 of 181 messages — e.g. a `lab-notes` message replying into an `engineering`
  thread). Since message `id`s are globally unique across channels, namespacing
  `source_id` as `` `${channel}:${thread_ts}` `` would have **incorrectly split**
  such a thread into two separate documents depending on which channel each reply
  happened to land in. Using the raw `thread_ts` avoids that bug entirely.

**Unit = message**, via `splitIntoMessages` (splits the joined text back into
one unit per `\n`-delimited line). Each message is kept whole — never split
mid-message — for the same coherence reason units exist everywhere else.

**Pagination & rate limiting:** the API is genuinely rate-limited (confirmed: hit a
real `429 {"error":"Rate limit exceeded, try later"}` after only ~3 rapid
sequential page requests during testing — not just a theoretical README warning).
`fetchPage()` retries up to 8 times with linearly increasing backoff
(`1000ms * attempt`) on a 429, and `fetchChannelMessages()` also paces normal
requests with a fixed 350ms delay between pages to avoid triggering the limit in
the first place. "No more pages" is detected cleanly: requesting past the last page
returns HTTP 200 with `items: []`, but we avoid relying on that and instead compute
`totalPages` upfront from `total`/`limit` on the first page's response.

**Why include `user` and `role` in the stored text:** including speaker attribution
(`"Sinai (scientist): ..."`) gives the LLM useful grounding context at answer time
(e.g. distinguishing an engineer's claim from a safety officer's concern) at
essentially no cost, since it's already in the API response.

---

## 4. Storage pipeline (`knowledgeBaseStore.ts`)

For each `LoadedDoc`:

1. Pick the splitter for `doc.source`, split `doc.text` into units, run
   `packIntoChunks(units)` → final list of chunk strings, indexed 0..N-1.
2. **Dedup pre-check:** one query —
   `SELECT chunk_index FROM knowledge_base WHERE source = ? AND source_id = ?` —
   builds a `Set<number>` of chunk indices already stored for this `source_id`.
3. For each chunk index not already in that set: embed the chunk text via Ollama
   (`nomic-embed-text`, 768 dimensions) and insert it.
4. Every insert uses
   `INSERT ... ON CONFLICT (source, source_id, chunk_index) DO NOTHING`.

### 4.1 How duplicates are actually prevented (two layers)

- **The real guarantee — a DB constraint.** A unique composite index on
  `(source, source_id, chunk_index)` (migration
  `20260710234131-add-unique-chunk-index.cjs`) is enforced by Postgres itself. It
  holds regardless of application bugs, crashes mid-run, or two `loadAllData` calls
  overlapping. `ON CONFLICT DO NOTHING` means a would-be duplicate insert is
  silently skipped rather than erroring.
- **The efficiency layer — the pre-check in step 2 above.** The DB constraint alone
  would stop duplicate *rows*, but wouldn't stop us from wastefully re-calling the
  embedding model for content we already have embedded. The pre-check means a
  second `loadAllData` run costs almost nothing: no re-fetched-and-re-embedded
  content, and it also means a run that crashed halfway through a `source_id`
  resumes correctly next time (only the missing chunk indices get processed).

**Verified in testing:** first run loaded 87 rows (41 slack, 23 pdf, 23 article,
zero duplicate `(source, source_id, chunk_index)` triples). A second `load_data`
call completed in ~17s (vs. several minutes for the first run) and logged
`0 newly stored, N already existed` for every single source — confirming both that
nothing gets re-embedded and that the row count stays at 87.

**Known non-goal:** this only guarantees no duplicates for *identical* re-runs. If
the chunking logic itself changes later (e.g. different min/max thresholds), a
re-run can produce a different number of chunks for the same `source_id`, and old
rows from the previous chunking scheme won't be automatically cleaned up — that's a
deliberate scope cut, not an oversight.

### 4.2 Why raw SQL instead of the Sequelize model for embeddings

The `knowledge_base.embeddings_768` column is a native pgvector `vector(768)`
column (see the original migration), not a plain Postgres array — even though the
Sequelize model (`models/KnowledgeBase.ts`) declares it as
`DataTypes.ARRAY(DataTypes.REAL)` for lack of a native Sequelize pgvector type. The
`pg` driver's array serialization (`{1,2,3}`) is not the same wire format pgvector
expects (`[1,2,3]`), so inserting through `KnowledgeBase.create(...)` risked a type
mismatch. We verified the correct approach directly against the live DB before
building the pipeline: pass the embedding as a bracketed string literal and cast it
explicitly —

```sql
INSERT INTO knowledge_base (..., embeddings_768) VALUES (..., :embedding::vector)
```

— via `sequelize.query(...)` with parameter replacements, bypassing the ORM's
typed insert path entirely for this column.

---

## 5. Embedding model

`services/ollamaService.ts` calls a local Ollama instance
(`http://localhost:11434` by default, overridable via `OLLAMA_BASE_URL`) using
`nomic-embed-text` for `embedText()`. This was chosen over the README's suggested
Gemini API specifically to avoid external API rate limits during heavy embedding
load — Ollama runs locally with no per-request quota. `nomic-embed-text`'s default
output is 768 dimensions, which is why `embeddings_768` (not `embeddings_1536`) is
the column used throughout this project.
