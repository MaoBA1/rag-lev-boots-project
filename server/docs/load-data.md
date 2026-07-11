# Load Data — Step-by-Step Flow & Design

This document explains, in the order it actually happens, everything that occurs
when the knowledge base gets populated — from an HTTP request all the way down to
rows sitting in Postgres. It's written for a reader who may not be familiar with
embeddings, chunking, or RAG systems in general; every concept is introduced before
it's used.

It covers **loading** only. Retrieval and answer generation (`ask()`) is a separate
document: [`ask.md`](./ask.md).

---

## 0. Two concepts you need before any of this makes sense

**Chunk.** LLMs and search systems work better over small, focused pieces of text
than over whole documents. So instead of storing "the entire OpEd PDF" as one
blob, we cut every source into many smaller pieces — "chunks" — each roughly
200–400 words, and store each chunk as its own row. Later, at question time, we
search over these chunks individually, not whole documents.

**Embedding.** An embedding is a list of numbers (a vector) that represents the
*meaning* of a piece of text, produced by a machine learning model. Texts with
similar meaning produce vectors that are numerically close to each other; unrelated
texts produce vectors that are far apart. Once you have embeddings, "find text
similar to this text" becomes a numerical problem ("find nearby vectors") instead
of a linguistic one. We use a local model called `nomic-embed-text` (via
[Ollama](https://ollama.com), running on `localhost:11434`) to turn each chunk into
a 768-number vector. Full detail on searching over these vectors is in
[`ask.md`](./ask.md) — this document only covers *creating and storing* them.

---

## 1. The end-to-end sequence

This is what happens, in order, from the moment a `POST /api/load_data` request
arrives to the moment the `knowledge_base` table reflects it:

```
1. HTTP request → ragController.loadData() → ragService.loadAllData()
2. loadAllData() runs 3 loaders concurrently:
     pdfLoader.loadPdfs()          — reads 3 local PDF files
     articleLoader.loadArticles()  — fetches 5 markdown articles over HTTP
     slackLoader.loadSlackMessages() — paginates a rate-limited Slack-like API
   Each returns a list of { source, source_id, text } — call it a "LoadedDoc"
3. All LoadedDocs from all 3 loaders are combined into one array and passed to
   knowledgeBaseStore.storeAllDocs()
4. storeAllDocs() processes each LoadedDoc one at a time (not concurrently):
     a. pick the right unit-splitter for this doc's source
     b. split the doc's text into units, then pack units into 200-400 word chunks
     c. check which chunk indices already exist in the DB for this doc (skip re-work)
     d. for every chunk not already stored: embed it, insert it
5. Response returns to the caller once every doc has been processed
```

The rest of this document walks through each of these steps in more depth, in the
same order.

---

## 2. Step 2 — the three loaders (fetch & normalize only)

**Principle: a loader's only job is "get me clean raw text out of one source." It
never chunks, embeds, or touches the database.** All three loaders return the same
shape:

```ts
interface LoadedDoc {
  source: 'pdf' | 'article' | 'slack';
  source_id: string;
  text: string;
}
```

Why split the codebase this way: the three sources have completely different fetch
mechanics (local file + PDF parsing, plain HTTP fetch, paginated + rate-limited
API), but once you have raw text, turning it into stored, embedded chunks is
identical work regardless of where the text came from. Keeping "fetching" and
"chunk/embed/store" as separate concerns means that work never gets duplicated
three times, and each loader is trivial to read in isolation.

They run **concurrently** (`Promise.all` in `loadAllData`) because they're
independent network/file operations with no shared state — no reason to wait for
one before starting the next.

### 2.1 `pdfLoader.ts` — the 3 local PDFs

1. Reads every `.pdf` filename from `server/knowledge_pdfs/`.
2. For each file: reads it, runs it through `pdf-parse` to extract plain text.
3. `source_id` = the filename without `.pdf` (e.g. `"OpEd - A Revolution at Our Feet"`).
4. Returns one `LoadedDoc` per file, `source: 'pdf'`.

**A version pitfall worth knowing about:** running `npm install pdf-parse` pulls
**v2.4.5** by default — a ground-up rewrite with a different, class-based API
(`PDFParse`), not the simple function you'd expect from most docs/tutorials. We
pinned `pdf-parse@1.1.1` explicitly in `package.json` to get the classic
`pdfParse(buffer) → { text, numpages }` function. It's CommonJS-only with no ESM
default export, so it's loaded via `createRequire(import.meta.url)` instead of a
normal `import`.

### 2.2 `articleLoader.ts` — the 5 markdown articles

1. Builds 5 URLs from the known article IDs (`military-deployment-report`,
   `urban-commuting`, `hover-polo`, `warehousing`, `consumer-safety`) against the
   gist base URL given in the README.
2. Fetches each URL, reads the raw markdown text.
3. Returns one `LoadedDoc` per article, `source: 'article'`, `source_id` = the
   article's id.

### 2.3 `slackLoader.ts` — the paginated, rate-limited API

This one is more involved, so its own numbered sequence:

1. For each of the 3 channels (`lab-notes`, `engineering`, `offtopic`): fetch page
   1, read `total` and `limit` from the response, compute
   `totalPages = ceil(total / limit)`, then fetch the remaining pages one at a
   time.
2. Flatten every message from all 3 channels into one array.
3. Group messages by `thread_ts` (see callout below for why this isn't simply "by
   channel").
4. Within each thread, sort messages chronologically and join them into one text
   blob, one message per line, formatted `"{user} ({role}): {text}"`.
5. Return one `LoadedDoc` per thread, `source: 'slack'`, `source_id` = the
   thread's id (`thread_ts`).

> **Why group by thread, not by channel?** We inspected the actual API response
> before deciding. Each message looks like:
> ```json
> { "id": "m0004", "channel": "lab-notes", "user": "Sinai", "role": "scientist",
>   "ts": "2025-10-01T09:05:41Z", "text": "...", "thread_ts": "m0004" }
> ```
> Messages are short (~20-50 words) — far under our 200-word chunk minimum, so
> grouping several together is mandatory. A *thread* is a coherent conversation
> about one specific thing (verified directly — e.g. thread `m0018` in `lab-notes`
> is a single multi-reply exchange about one shielding problem), which is exactly
> the kind of real semantic boundary we want a chunk to respect (see §3). Grouping
> by channel instead would glue together many unrelated conversations, hurting
> chunk quality the same way an arbitrary fixed-size window would.
>
> **Why `source_id = thread_ts` and not `` `${channel}:${thread_ts}` ``?** We
> pulled and cross-checked all 181 messages across all 3 channels and found that
> replies occasionally cross-post into a **different channel's** thread (3 of 181
> messages — e.g. a `lab-notes` message replying into an `engineering` thread).
> Since message `id`s are globally unique across channels anyway, prefixing
> `source_id` with the reply's own channel would have **incorrectly split** such a
> thread into two separate documents depending on which channel each reply
> happened to land in. Using the raw `thread_ts` avoids that bug.

> **Rate limiting is real, not just a README warning.** During testing we
> triggered an actual `429 {"error":"Rate limit exceeded, try later"}` after only
> ~3 rapid sequential page requests. `fetchPage()` retries up to 8 times with
> linearly increasing backoff (`1000ms * attempt`) on a 429, and normal requests
> are paced with a fixed 350ms delay between pages to avoid triggering the limit
> in the first place. "No more pages" is detected by computing `totalPages`
> upfront from the first page's `total`/`limit`, rather than probing until an
> empty page comes back.

---

## 3. Step 4 — chunking (splitting text into 200-400 word pieces)

### 3.1 The shared packer: `packIntoChunks(units, min = 200, max = 400)`

All three sources ultimately feed a list of text **units** into the same function
(`services/chunking/packIntoChunks.ts`). A "unit" means something different per
source (a paragraph, a sentence, or a chat message — see §3.2), but the packing
algorithm itself doesn't care what a unit represents, only that it shouldn't be
split apart carelessly.

Walking units in order, with a running word buffer:

1. Append the unit's words to the buffer.
2. If the buffer now exceeds 400 words, slice off 400-word chunks repeatedly until
   what's left is ≤ 400. (Handles one oversized unit alone blowing past the max —
   e.g. a 1000-word paragraph becomes 400 + 400 + 200.)
3. After processing a unit, if the buffer has reached 200 words, emit it as a
   chunk and reset. If it's still under 200, keep accumulating with the next
   unit's words instead of leaving a tiny, low-signal chunk standing alone.
4. At the very end of a document, emit whatever's left in the buffer even if it's
   under 200 — nothing left to merge it with.

Result: every chunk is 200-400 words, except possibly the last chunk of a
document.

> **Why not just cut every 400 words, ignoring unit boundaries?** A pure fixed-size
> window would frequently cut a chunk mid-unit, mixing the tail of one topic with
> the head of an unrelated one. That dilutes the chunk's embedding (the vector ends
> up representing an average of two different things) and hurts retrieval quality.
> Respecting unit boundaries keeps each chunk topically coherent. The 200-word
> floor exists so we don't end up with many near-empty, low-signal chunks (a
> single short paragraph, a two-word list item) that embed poorly and rarely
> surface as useful search results.

### 3.2 Units are source-dependent

| source    | splitter file            | unit        |
|-----------|---------------------------|-------------|
| `article` | `splitIntoParagraphs.ts`  | paragraph   |
| `pdf`     | `splitIntoSentences.ts`   | sentence    |
| `slack`   | `splitIntoMessages.ts`    | message     |

The whole point of unit-based chunking is that a unit boundary should represent a
real semantic boundary. That signal is only reliable where the source actually
gives it to us:

- **Articles → paragraph.** Markdown source has genuine blank-line paragraph
  breaks — real, author-intended topic boundaries, free of charge.
  `splitIntoParagraphs` splits on blank lines, and additionally splits markdown
  list blocks into one unit per list item (each bullet is typically its own small
  idea, not a continuation of the previous one).

- **PDF → sentence, not paragraph.** This is a deliberate deviation, and the
  reason is empirical: we ran `pdf-parse` on all 3 PDFs and inspected the raw
  output before deciding anything. Findings:
  - Every line break in the extracted text is a single `\n` — mid-sentence
    word-wraps, real paragraph transitions, and section headers are all
    **indistinguishable** from each other.
  - The only double-newline (`\n\n`) in each file corresponds exactly to page
    boundaries (its count equals `numpages` in every file) — and it lands
    **mid-word/mid-sentence** (e.g. `"were no \n\nlonger bound by"`). It's a
    pagination artifact from how `pdf-parse` joins per-page text, not a semantic
    marker.

  Conclusion: there's no usable "blank line = paragraph break" signal in this
  data — PDF is a layout format, not a semantic one. Sentence boundaries
  (`.`/`!`/`?`) are the most reliable unit we can actually detect from
  punctuation. `splitIntoSentences` first collapses all whitespace to single
  spaces (safe, since a page-break newline landing between two words just becomes
  a normal space), then walks the text cutting at `.`/`!`/`?` followed by
  whitespace + an uppercase letter/digit, with a guard against splitting decimal
  numbers like `3.5`.

- **Slack → message.** Each line of the joined thread text (see §2.3) is one
  message; `splitIntoMessages` just splits on `\n`. Messages are kept whole —
  never split mid-message — same coherence reasoning as the other two.

---

## 4. Step 4(c-d) — dedup check, embedding, and storage (`knowledgeBaseStore.ts`)

For each `LoadedDoc`, after chunking (§3):

1. **Dedup pre-check** — one query:
   `SELECT chunk_index FROM knowledge_base WHERE source = ? AND source_id = ?`
   builds a `Set<number>` of chunk indices already stored for this document.
2. For every chunk index **not** already in that set: embed the chunk text via
   Ollama (`nomic-embed-text`, 768 numbers) and insert the row.
3. Every insert uses
   `INSERT ... ON CONFLICT (source, source_id, chunk_index) DO NOTHING`.

### 4.1 How duplicates are actually prevented — two layers

**Layer 1 — the real guarantee, a database constraint.** Migration
[`20260710234131-add-unique-chunk-index.cjs`](../migrations/20260710234131-add-unique-chunk-index.cjs)
— **written for this project, not part of the original scaffold** — adds:

```sql
CREATE UNIQUE INDEX knowledge_base_source_source_id_chunk_index_idx
ON knowledge_base (source, source_id, chunk_index);
```

This tells Postgres itself: never allow two rows with the same
`(source, source_id, chunk_index)` triple to exist, full stop — no matter what the
application code does, whether it has a bug, crashes mid-run, or two
`loadAllData` calls happen to overlap. Combined with `ON CONFLICT ... DO NOTHING`
on every insert, a would-be duplicate is silently skipped rather than causing an
error.

**Layer 2 — the efficiency layer, the pre-check in step 1 above.** The DB
constraint alone would stop duplicate *rows*, but wouldn't stop us from
wastefully re-calling the embedding model for content we already have embedded.
The pre-check means a second `loadAllData` run costs almost nothing: nothing gets
re-embedded, and a run that crashed halfway through a document resumes correctly
next time (only the missing chunk indices get processed).

**Verified in testing:** first run loaded 87 rows (41 slack, 23 pdf, 23 article),
zero duplicate triples. A second `load_data` call completed in ~17s (vs. several
minutes for the first run) and logged `0 newly stored, N already existed` for
every single source.

> **Known non-goal:** this only guarantees no duplicates for *identical* re-runs.
> If the chunking logic itself changes later (e.g. different min/max thresholds),
> a re-run can produce a different number of chunks for the same `source_id`, and
> old rows from the previous chunking scheme won't be automatically cleaned up —
> a deliberate scope cut, not an oversight.

### 4.2 Why raw SQL instead of the Sequelize model, for this one column

`knowledge_base.embeddings_768` is a native pgvector `vector(768)` column (see the
scaffolded migration `20250927100126-create-embeddings-table.cjs`), not a plain
Postgres array — even though the Sequelize model
(`models/KnowledgeBase.ts`) declares it as `DataTypes.ARRAY(DataTypes.REAL)`, for
lack of a native Sequelize pgvector type. The `pg` driver's array serialization
(`{1,2,3}`) is not the wire format pgvector expects (`[1,2,3]`), so inserting
through `KnowledgeBase.create(...)` risked a type mismatch. We verified the
correct approach directly against the live DB before building the pipeline: pass
the embedding as a bracketed string and cast it explicitly —

```sql
INSERT INTO knowledge_base (..., embeddings_768) VALUES (..., :embedding::vector)
```

— via `sequelize.query(...)` with parameter replacements, bypassing the ORM's
typed insert path for this column specifically.

---

## 5. Every migration this project added, and what it's for

The scaffolded project came with two migrations
(`20250927100114-enable-pgvector-extension.cjs`,
`20250927100126-create-embeddings-table.cjs`) that create the `pgvector` extension
and the `knowledge_base` table with two ivfflat vector indexes. Everything below
was written during this project:

- **`20260710234131-add-unique-chunk-index.cjs`** — described fully in §4.1 above.
  Adds the unique `(source, source_id, chunk_index)` index that makes duplicate
  prevention an actual database-enforced guarantee rather than an assumption
  about application logic being bug-free.

- **`20260711113247-drop-ivfflat-768-index.cjs`** — drops one of the two
  vector indexes that shipped with the scaffold. This one isn't about loading
  data, it's about correctly *searching* it afterward — full explanation,
  including the investigation that found the index was silently returning wrong
  (empty) results, lives in [`ask.md`](./ask.md#the-broken-index-investigation).
