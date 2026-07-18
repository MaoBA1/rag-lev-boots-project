# RAGAS Option 2 — Real `ragas` Library, Explained From Scratch

This document covers the second RAGAS implementation path: using the real Python
`ragas` library's decomposed metrics (faithfulness, context precision, context
recall, answer relevancy, answer correctness) instead of the single hand-rolled
LLM-judge built for Option 1. It's written the same way as the other docs in this
folder — built up from first principles, with the real investigations narrated, not
just the conclusions.

This branch (`ragas-option-2`) is a **sibling** of `ragas-option-1`, not built on
top of it — both branch independently from `main`. Only the validated
`ground-truth.json` was carried over (copied via `git checkout ragas-option-1 --
server/ragas/ground-truth.json`, which pulls just that file's content without
dragging in Option 1's Node-specific judge code or commit history). Nothing else
from Option 1 exists on this branch.

**Status as of this document**: implementation is complete and verified piece by
piece (every step below was tested against the real system before moving on), but
the full 10-question, 5-metric run was manually stopped before completion, so this
document is a record of the *build* — the decisions, the bugs found and fixed, the
architecture — not a record of final scores. That's the next step after this.

---

## Part 1 — Real RAGAS vs. Option 1, and why this needed real verification

Before writing any code, real time was spent understanding what the five actual
`ragas` metrics compute, mechanically, since Option 1's single "LLM scores 1-10
similarity" judge is a deliberate simplification of this, not a smaller version of
the same thing:

- **Faithfulness** — decomposes the generated answer into atomic claims (one LLM
  call), then checks each claim yes/no against the *retrieved context* (a second
  LLM call) — score = supported claims / total claims. Needs no ground truth at
  all; it's a pure hallucination detector.
- **Answer relevancy** — generates several synthetic "reverse-engineered"
  questions from the answer, embeds them, and averages their cosine similarity
  against the real question's embedding. An embedding-similarity metric, not an
  LLM-judgment one.
- **Context precision** — an LLM judges each retrieved chunk yes/no for relevance,
  then combines those judgments via **Average Precision** (a classic
  information-retrieval formula): precision-so-far is computed at each rank
  position, but only positions that are themselves relevant get averaged in — so
  relevant chunks ranked *early* score much higher than the same chunks ranked
  late, even with an identical hit count.
- **Context recall** — the ground-truth answer gets decomposed into claims, and
  each one is checked against the *retrieved context* — recall = ground-truth
  claims found in what was retrieved / total ground-truth claims. The claims come
  from the ground truth; what's being evaluated for adequacy is retrieval.
- **Answer correctness** — a weighted blend of two sub-scores: a factual F1 score
  (generated-answer claims vs. ground-truth claims, bucketed into
  true/false-positive/negative) and whole-answer embedding cosine similarity.

The key structural difference from Option 1: none of these ask an LLM to hold a
complex holistic judgment in its head and output one number. Each decomposes the
task into small, checkable sub-judgments (is this one claim supported? is this one
chunk relevant?) and aggregates with plain arithmetic, which is far more reliable
than a single vague "rate this 1-10" prompt. Real RAGAS also never collapses these
into one combined score — it reports all 5 separately, per question, by design,
since a single blended number would hide exactly the kind of diagnosis that matters
(e.g. high context recall + low faithfulness tells you retrieval worked but
generation hallucinated — a real, specific finding from Option 1's Q5
investigation, which is precisely what this metric split is built to surface
automatically instead of requiring manual debugging).

---

## Part 2 — Environment setup: two real bugs, unrelated to this project's code

### 2.1 The `langchain-community` / Vertex AI import break

`uvx ragas quickstart rag_eval` failed immediately with
`ModuleNotFoundError: No module named 'langchain_community.chat_models.vertexai'`.
Root cause, confirmed via a real GitHub issue search and by reading the installed
package metadata directly: `ragas` 0.4.3 declares `Requires-Dist: langchain-community`
with **no version ceiling**, so any fresh install grabs the latest
(`langchain-community` 0.4.2) — which has since removed its old inline Vertex AI
integration (migrated to a separate `langchain-google-vertexai` package as part of
`langchain-community` being deprecated/sunset). `ragas` 0.4.3's own code still
hard-imports the old, now-deleted path.

**Fix**: pin `langchain-community<0.4` alongside `ragas`. Two different fixes were
needed at two different points, because they're two separate install processes:

- For the one-off scaffolding command: `uvx --with "langchain-community<0.4" --from ragas ragas quickstart rag_eval`
- For the *generated project itself* (its own `pyproject.toml`/`uv.lock`, resolved
  independently by `uv sync`): `uv add "langchain-community<0.4"` run inside
  `rag_eval/`, which persists the constraint properly (the `--with` flag only
  affects the single `uvx` invocation it's attached to, it doesn't carry into
  files the scaffolding command generates).

### 2.2 Disk space exhaustion mid-install

`uv sync` failed on `pyarrow` with `No space left on device`. The disk was at 99%
capacity, 287MB free. Fixed by clearing the `uv` package cache (3.3GB, safe —
just forces re-downloads later) and removing two Ollama models unused anywhere in
this project (`deepseek-r1:1.5b`, `gemma3:270m` — both were candidates considered
and rejected during Option 1's model-selection process, sitting unused since).
Freed ~4.7GB total.

---

## Part 3 — Replacing the scaffold's demo, not adapting it

The generated `rag.py`/`evals.py` were deleted, not modified. Investigation (by
reading the installed library's actual source, not assuming) showed the scaffold's
default demo uses `DiscreteMetric` — a generic, build-your-own categorical judge
(you supply a prompt and allowed output values; conceptually similar to Option 1's
hand-rolled `judge.ts`) — run via a decorator-based `@experiment()`/`Dataset`
framework. This is architecturally unrelated to the five real metrics
(`faithfulness`, `context_precision`, etc., confirmed to exist as separate,
pre-built classes in the same `ragas.metrics` module, unused by the scaffold's
default). Since the whole point of Option 2 was the real decomposed methodology,
keeping the demo's mechanism and incrementally editing it made no sense — it's a
genuinely different usage pattern (`evaluate(dataset, metrics=[...])`), not an
extension of the scaffold's.

Also confirmed while investigating: the toy demo's own placeholder content was
internally inconsistent by design (a pun) — `DOCUMENTS` in `rag.py` were about
*Indian classical music ragas*, while `evals.py`'s sample questions asked about the
*`ragas` software library* — meaning the demo's own retrieval could never have
found a correct answer even before any of this project's changes. Confirmed this
by running the toy demo once (before deleting it): all 3 sample questions correctly
scored "fail," and the generated answers correctly said "I don't have this
information" rather than hallucinating — a nice real-world confirmation that the
underlying generation model (`llama3.2`) behaves properly when genuinely irrelevant
context is retrieved, a useful contrast to Option 1's Q5 hallucination (where the
*correct* context *was* retrieved and the model still fabricated an answer anyway).

---

## Part 4 — Architecture

```
server/ragas/
  ground-truth.json      — copied from ragas-option-1, static, unchanged
  rag_eval/
    lev_boots_client.py  — Step 3: thin HTTP client → your real /api/ask_eval
    build_dataset.py     — Step 4: assembles the real EvaluationDataset
    ollama_clients.py    — Step 6: LLM + embeddings clients for ragas's own metric calls
    evals.py             — Step 7: the orchestrator, runs evaluate() and reports
```

### 4.1 Node side: a new eval-only endpoint, not a change to production behavior

`ask()`'s return value was never `{answer, retrievedChunks}` before this branch —
production `/api/ask` only ever returned the final answer text, discarding the
retrieved chunks after building the prompt. But 3 of the 5 real metrics
(faithfulness, context precision, context recall) specifically need to know what
was *actually retrieved*, not the ground truth — without exposing this, only
answer_relevancy and answer_correctness would be computable at all.

Two options were considered: extend `/api/ask` directly, or add a separate
eval-only endpoint. **Chose the separate endpoint** (`POST /api/ask_eval`), to keep
production's response contract completely untouched.

Implementation, in `ragService.ts`:

```ts
export const askWithContext = async (userQuestion: string): Promise<AskResult> => {
  // ...identical retrieval + generation logic...
  return { answer, retrievedChunks: chunks };
};

export const ask = async (userQuestion: string): Promise<string> => {
  const { answer } = await askWithContext(userQuestion);
  return answer;
};
```

`ask()` now calls `askWithContext()` internally rather than duplicating the
retrieval/generation logic — zero behavior change, verified live: `/api/ask` still
returns exactly `{answer}` with nothing extra, `/api/ask_eval` returns
`{answer, retrievedChunks}` with the real chunks (source, source_id, chunk_content)
that produced that answer. `ragController.ts` gained `askQuestionEval`;
`ragRoutes.ts` gained the route. All three changes tested against a live running
server before moving on, not assumed to be correct from reading the code alone.

### 4.2 Step 3's client is not the Python equivalent of `ollamaService.ts`

Worth stating explicitly since it was a real point of confusion during the build:
`lev_boots_client.py` talks to *your own Express app* (`/api/ask_eval`) as a black
box — it never touches Ollama, embeddings, or retrieval directly. It's functionally
equivalent to what the React frontend does when it calls `/api/ask` — a thin outside
consumer, not a low-level model client. The actual Python-side equivalent of
`ollamaService.ts` is a separate piece, described in §4.4.

```python
def query_lev_boots(question: str) -> dict:
    response = requests.post(ASK_EVAL_URL, json={"userQuestion": question})
    response.raise_for_status()
    return response.json()
```

Verified live against the real server with a real ground-truth question before
moving on.

### 4.3 The real, current `ragas` dataset schema — verified, not assumed

The `evaluate()` function's own docstring shows a stale example
(`['question', 'ground_truth', 'answer', 'contexts']`) that doesn't match the
actual current schema class (`SingleTurnSample`, what `EvaluationDataset` is really
built from) — even the library's own documentation had drifted from its own
current code. Confirmed the real field names by reading `dataset_schema.py`
directly:

```
user_input:          str        # the question
retrieved_contexts:  List[str]  # chunk_content strings only, no metadata
response:            str        # the generated answer
reference:           str        # the ground-truth answer
```

`build_dataset.py` reads the 10 items from `ground-truth.json`, calls
`query_lev_boots()` for each one (so `response`/`retrieved_contexts` reflect the
system's real, live behavior at run time, not something canned), and pairs that
with `user_input`/`reference` from the static file — building one `SingleTurnSample`
per question. Verified live: all 10 questions processed correctly, all four fields
populated as expected.

### 4.4 `ollama_clients.py` — the real Python-side equivalent of `ollamaService.ts`

This is the piece that lets `ragas`'s own internal metric computations (claim
decomposition, verification, embedding similarity) talk to Ollama — separate from
and unrelated to Step 3's client. Configured via an OpenAI-compatible client
pointed at `http://localhost:11434/v1` (Ollama mimics OpenAI's API shape
specifically so tools built for OpenAI work against it unmodified), wrapped by
`ragas`'s own `llm_factory`/`embedding_factory` helpers:

```python
judge_llm = llm_factory("qwen2.5:7b", client=openai_client)
embeddings = embedding_factory("openai", model="nomic-embed-text", client=openai_client)
```

Two real, verified bugs were found and fixed here — see Part 5.

### 4.5 The five real metrics — verified pre-built instances, not manual construction

Confirmed via source that all five ship as ready-to-use singleton instances,
requiring no manual construction:

```python
from ragas.metrics import faithfulness, context_precision, context_recall, answer_relevancy, answer_correctness
```

Confirmed specifically that `context_precision` is literally `ContextPrecision`,
which is `LLMContextPrecisionWithReference` with no changes — the reference-based
variant, correct given we have both ground truth and retrieved context available.
Same for `context_recall` → `LLMContextRecall`.

### 4.6 Results format — JSON, not CSV

`EvaluationResult` (what `evaluate()` returns) supports `to_csv()`, `to_jsonl()`,
and the underlying `to_pandas()` DataFrame. CSV was rejected: `retrieved_contexts`
is a list of strings, which CSV can only represent by flattening into one awkward
string cell. Chose full JSON (via `df.to_dict(orient="records")` plus a `json.dump`)
over JSONL for consistency with Option 1's log style — one file,
`evals/results.json`, shaped as `{timestamp, perQuestion: [...], averages: {...}}`,
matching Option 1's self-contained-per-run philosophy: each `perQuestion` row
carries its own question/response/reference/contexts, not just an index back into
`ground-truth.json`.

---

## Part 5 — Real bugs found in `ragas` 0.4.3 itself, fixed via source inspection

### 5.1 Legacy vs. modern embeddings method names

First real run of `answer_relevancy` failed:
`AttributeError: 'OpenAIEmbeddings' object has no attribute 'embed_query'`. The
modern `embedding_factory(...)` output only exposes `embed_text`/`embed_texts`, but
some metrics' internal code — confirmed by reading `_answer_relevance.py` and
`_answer_correctness.py` — still call the older method names (`embed_query`,
`embed_documents`), a genuine gap in this version of the library between its
"modern" and "legacy" interfaces (the deprecation warnings point toward using the
modern one, but not every metric's implementation has been updated to call it).

A tempting alternative — forcing the legacy interface via
`embedding_factory(..., interface="legacy")` — was tried and rejected: it routes
through `langchain_openai`'s embeddings wrapper, which uses OpenAI's real
tokenizer (`tiktoken`) internally to pre-process text before sending it, and
Ollama's embeddings endpoint doesn't accept pre-tokenized input
(`BadRequestError: invalid input type`). Verified directly rather than assumed.

**Fix**: alias the missing legacy names onto the working modern methods, since both
do the identical thing (embed one string / a list of strings):

```python
embeddings.embed_query = embeddings.embed_text
embeddings.embed_documents = embeddings.embed_texts
```

### 5.2 Some metrics call async-named methods regardless of client type

After the above fix, `answer_correctness` still failed differently:
`TypeError: Cannot use aembed_text() with a synchronous client.` — its internal
code calls the *async-named* method (`aembed_text`) even when the underlying
client is fundamentally synchronous, while `answer_relevancy` (also an embeddings
metric) calls the sync-named one. Two different metrics in the same library
version use inconsistent naming conventions internally, independent of actual
client capability.

**Fix**: alias the async-named variants too, as thin coroutine shims that just call
through to the working synchronous method — no real concurrency, purely a
naming-compatibility patch:

```python
async def _aembed_text(text):
    return embeddings.embed_text(text)

embeddings.aembed_text = _aembed_text
embeddings.aembed_query = _aembed_text
# ...and the plural/batch equivalents
```

All 5 metrics confirmed working together after this, on a hand-built single-sample
dataset, before trusting them against the real 10-question run.

---

## Part 6 — The memory crash: async concurrency, diagnosed properly

### 6.1 What happened

The first full real run (sync client) was manually stopped for taking too long —
correctly so, since 10 questions × 5 metrics × multiple sub-calls per metric adds
up to 50+ sequential LLM/embedding calls with a sync client, each fully blocking.
Switched to `AsyncOpenAI` to let calls overlap. A 1-row smoke test succeeded. The
real 10-question run then triggered a **macOS system-level "out of application
memory"** warning, with the terminal showing many `Job[N]` entries timing out
concurrently (1, 4, 5, 6, 9, 10, 11, 14...).

### 6.2 Root cause, confirmed via source

`ragas`'s `RunConfig` defaults `max_workers=16` — up to 16 individual
metric-computation jobs are allowed in flight (actively holding an open connection,
waiting for a response) simultaneously. With 50+ total jobs across the run, the
executor fires the first 16 nearly at once. Combined with everything else already
running on the machine (several GB across other open applications, confirmed via
the Force Quit dialog), plus Ollama needing to hold multiple concurrent model
contexts in memory at once, the system ran out of memory.

**A real correction made mid-investigation**: the initial plan was "revert to sync
client" as the fix. Reading `executor.py` directly showed this wouldn't actually
have solved it — the executor dispatches work as `coroutines` with a bounded
`max_workers` pool with no branching found for sync vs. async client types,
meaning it likely wraps even synchronous calls into the same coroutine-scheduling
mechanism and would still attempt up to 16 concurrent Ollama requests regardless
of client type. The actual load-bearing fix is capping `max_workers` directly, not
the sync/async client choice.

**Final decision**: did both, for different reasons — reverted to the sync
`OpenAI` client (simplicity, avoids depending on async-specific behavior we don't
need), **and** explicitly capped concurrency:

```python
result = evaluate(..., run_config=RunConfig(max_workers=2))
```

Confirmed via a fresh 1-row, all-5-metrics smoke test that the combination (sync
client + `max_workers=2` + the aliasing fixes from Part 5) works correctly before
handing off the real run.

### 6.3 A related, separately verified finding: async concurrency genuinely helps, when bounded

Before any of the crash investigation, a deliberate empirical test was run
(3 sequential requests vs. 3 concurrent requests to Ollama) specifically to check
an earlier unverified assumption — that "Ollama is the bottleneck regardless of
Python's concurrency choice." That assumption was wrong: sequential took 4.51s,
concurrent took 2.99s (~34% faster), proving Ollama does process overlapping
requests with real parallelism, not strict serialization. The eventual decision to
use `max_workers=2` (rather than reverting all the way to zero-concurrency
sequential execution) was made with this in mind — 2 is close to the scale that
was actually verified safe, not an arbitrary number.

---

## Part 7 — A known, accepted quality tradeoff: `answer_relevancy` and `n=1`

During the real run: `LLM returned 1 generations instead of requested 3. Proceeding
with 1 generations.` Real OpenAI's API supports requesting multiple independent
sampled completions from one call (`n=3`), which `answer_relevancy` uses internally
to generate its 3 synthetic reverse-engineered questions in a single request.
Ollama's OpenAI-compatible endpoint doesn't support `n>1` — it always returns
exactly one completion regardless of what's requested. `ragas` detects the
mismatch and falls back gracefully rather than failing.

**Accepted as a known limitation, not fixed**: `answer_relevancy` runs with reduced
statistical robustness (averaging over 1 synthetic question instead of 3) for
every question in this setup. Fixing it properly would mean patching `ragas`'s
internals to fire 3 separate single-completion requests instead of relying on
`n=3` — judged not worth the effort for this exercise. This is a genuine
consequence of running against Ollama instead of real OpenAI, not a bug in this
project's own code.

---

## Part 8 — Known limitations / not yet done

- **No final scores yet.** The real 10-question, 5-metric run was stopped
  mid-execution (to write this document) before completing — this document
  captures the build, not results. Next step: let the real run finish and record
  the actual per-metric scores, same as Option 1's baseline log.
- **`answer_relevancy` has reduced robustness** due to Ollama's lack of `n>1`
  support (Part 7) — accepted, not fixed.
- **`max_workers=2` makes the run slow**, closer to sequential than the executor's
  default — a deliberate safety-over-speed tradeoff after the memory crash (Part
  6), not the fastest configuration possible.
- **The embeddings method-aliasing (Part 5) is a compatibility patch for `ragas`
  0.4.3 specifically** — future library versions may fix this properly, at which
  point the aliasing in `ollama_clients.py` would become unnecessary (harmless to
  leave, but worth revisiting if the library gets upgraded later).
- **`ground-truth.json`'s `supportingQuotes` field is unused in this path.** Unlike
  Option 1's judge, which was deliberately given the quotes as extra grounding
  context, real RAGAS's metrics use the actual live-retrieved context instead —
  exactly the gap flagged back in Option 1's own documentation as the reason
  `supportingQuotes` wouldn't be a direct substitute for what real RAGAS calls
  "retrieved contexts."
