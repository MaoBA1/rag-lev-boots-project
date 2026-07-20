# MCP Server — Exposing the RAG System as Tools, Explained From Scratch

This document covers `server/mcp/` — an MCP (Model Context Protocol) server that
exposes the existing Lev-Boots RAG system as three callable tools for any
MCP-compatible client (the official Inspector, Claude Desktop, Claude Code, or any
other agent that speaks the protocol). It's written the same way as the other docs
in this project: built up from first principles, with the real bugs and design
decisions narrated, not just the end state.

This branch (`mcp`) is a sibling of `gatekeeper` and both RAGAS branches, branched
independently from `main`. It shares nothing with any of them.

---

## Part 1 — What MCP is, and what this project exposes

MCP is a protocol that lets an LLM client discover and call tools exposed by a
separate, local server process — the same underlying idea as a plugin system, but
standardized so any MCP-compatible client can talk to any MCP-compatible server
without custom integration work per pairing. The value proposition specific to this
project: an LLM like Claude has no built-in knowledge of Lev-Boots, its knowledge
base, or this specific Postgres table — MCP is the mechanism that lets it reach out
and use that data on its own, deciding when a tool call is actually needed based on
the user's question, without the developer having to hard-code that logic.

Three tools were built, all thin wrappers around the *existing* RAG system rather
than new logic:

- **`rag_search`** — ask a question, get a grounded answer (wraps `ask()`).
- **`list_knowledge_sources`** — list every PDF and article available (new
  `listKnowledgeSources()` method).
- **`read_source`** — get the raw text of one specific PDF or article by name (new
  `readSource()` method).

---

## Part 2 — Architecture: why tools call the service layer directly, not HTTP

`server/mcp/server.ts` is a separate **entry point** within the same codebase, not
a separate deployed service. It uses `StdioServerTransport` — meaning an MCP client
spawns it as a subprocess and communicates over stdin/stdout, not over HTTP. Since
it lives inside the same `server/` project as `ragService.ts`, its tools import and
call the service layer directly (`import { ask } from '../../services/ragService'`)
rather than making HTTP requests to the Express app's `/api/ask` endpoint.

This was a deliberate change from how `rag_search` was originally scaffolded (see
Part 3.1) — the practical benefit: the MCP server is fully self-sufficient. It
doesn't need the Express server (`server/server.ts`) running at all, only the
database and Ollama need to be reachable. One consequence worth knowing: the MCP
server never calls `initializeDB()` (the migration runner) — it assumes the
`knowledge_base` table already exists, since only the main Express server's own
startup path runs migrations.

```
server/mcp/
  server.ts              — entry point, registers all 3 tools, connects stdio transport
  tools/
    ragSearch.ts          — wraps ask()
    listKnowledgeSources.ts — wraps listKnowledgeSources()
    readSource.ts          — wraps readSource()
```

---

## Part 3 — The three tools, and the real bugs found in the process

### 3.1 `rag_search` — found already scaffolded, with real bugs to fix

This tool was found already partially written, apparently scaffolded from a
generic MCP tutorial template, with several concrete issues:

- **Missing dependencies.** `@modelcontextprotocol/sdk`, `zod` were imported but
  never installed — not present in `server/package.json` at all. Installed via
  `npm install @modelcontextprotocol/sdk zod` (this project has a single root-level
  `package-lock.json`, not a separate one under `server/`, so that's what actually
  changed on disk).
- **A missing URL scheme.** The original implementation called
  `fetch('localhost:3000/api/ask', ...)` — no `http://` prefix. Node's `fetch`
  requires an absolute URL; this would throw immediately, not silently misbehave.
- **Leftover tutorial naming.** The `McpServer` was named `'joke-server'` and the
  tool's `title` was `'Tell joke'` — clear leftovers from whatever "tell a joke"
  MCP SDK example this was scaffolded from. Renamed to `'lev-boot-mcp'` and
  `'Rag Search'`. The `description` field, by contrast, was already genuinely
  customized to describe the Lev-Boots use case (later shortened for concision —
  see below).
- **An unused `axios` import** in the original single-file version (the tool
  callback was originally written directly in `server.ts`, then moved into its own
  `tools/ragSearch.ts` file, carrying the unused import along).
- **No TypeScript type annotation** on the `question` parameter (implicitly `any`).

**The fix that addressed several of these at once**: rather than patch the HTTP
call, `ragSearch.ts` was rewritten to import and call `ask()` directly (Part 2).
This eliminated the missing-`http://` bug entirely (no URL left to get wrong) and
made the unused `axios` import moot (removed, not installed).

**A TypeScript concept worth recording**: adding `question: string` to the
parameter list is the basic annotation syntax. A less obvious issue also came up:
`{ type: 'text', text: answer }` on its own gets typed by TypeScript as
`{ type: string, text: string }` — the literal `'text'` gets *widened* to the
general `string` type. The MCP SDK's types require the exact literal `"text"`
specifically, since it's used to discriminate between different kinds of content
blocks (text vs. image, etc. - a discriminated union). Writing `'text' as const`
tells TypeScript "keep this as the literal value, don't widen it" — needed in all
three tool files, anywhere a content block is returned.

**Final description**, shortened after an initial version was judged too long:
*"Answer a question about Lev-Boots using the internal knowledge base (PDFs,
articles, Slack discussions). Grounded in retrieved content only; says so if
nothing relevant is found."*

### 3.2 `list_knowledge_sources` — built from scratch, then narrowed to exclude Slack

New `listKnowledgeSources()` method on `ragService.ts`. Loops over the source
types defined in a new `server/config/constants.ts` (`DATA_SOURCES`), and for each
one queries `knowledge_base` for **distinct `source_id` values** (one entry per
unique document, not per stored chunk-row — a single PDF currently has 7 chunk
rows, but should appear once in this list). Result is an object keyed by source
type, each holding an array of `{type, name}` entries:

```json
{
  "pdf": [{"type": "pdf", "name": "OpEd - A Revolution at Our Feet"}, ...],
  "article": [{"type": "article", "name": "hover-polo"}, ...]
}
```

Originally implemented covering all three source types (including Slack), then
**narrowed to exclude Slack** by explicit decision — the tool now only lists PDF
and article sources. `constants.ts` (added independently, containing several other
constants like `ARTICLE_IDS`, `GIST_BASE_URL`, `PDF_FILES` not otherwise wired up
yet) was not otherwise touched or used to refactor existing loader code, to keep
this change scoped to exactly what was asked.

### 3.3 `read_source` — new loader methods, plus an auto-detect design

Requirement: given a `sourceName` (PDF filename or article ID) and an optional
`sourceType`, return that one source's raw text — without loading and filtering
through *every* source first, which the existing `loadPdfs()`/`loadArticles()`
would require.

**New, single-item loader methods**, reusing the same fetch/read logic already in
each loader, just scoped to one item:
- `pdfLoader.ts`: `loadPdfByFilename(filename)` — reads and parses one PDF file
  directly (no directory scan).
- `articleLoader.ts`: `loadArticleById(articleId)` — looks up the article's
  position in the local `ARTICLE_IDS` list (needed to construct its gist URL, which
  is index-based: `article-{index+1}_{id}.md`) and fetches just that one file.
  `ARTICLE_IDS` was exported from this file (previously module-private) so
  `ragService.ts` could reuse it for auto-detection.

**New orchestrator** in `ragService.ts` — `readSource(sourceName, sourceType?)`:
if `sourceType` is explicitly given, dispatches directly. If omitted, **auto-detects**:
checks `sourceName` against the known `ARTICLE_IDS` list first (a cheap, in-memory
check with no I/O), and only falls back to treating it as a PDF filename if that
check misses. This ordering was deliberate — articles come from a small, fixed,
known list, so checking that first avoids an unnecessary disk read attempt when the
name is clearly an article, and vice versa avoids a wasted network fetch attempt
when it's clearly a PDF.

Verified directly (not just type-checked): auto-detected article lookup,
auto-detected PDF lookup, explicit `sourceType: 'pdf'`, and a not-found case
(correctly throws `ENOENT`, which the tool wrapper catches and turns into a clean
error message rather than crashing the server).

---

## Part 4 — Testing: the Inspector, then Claude Desktop

### 4.1 MCP Inspector

Run via `npx @modelcontextprotocol/inspector`, from `server/` specifically — not
`server/mcp` — since the Inspector spawns the actual MCP server as a subprocess
using a relative command/args pair, and that needs to resolve against a working
directory where the path to `mcp/server.ts` makes sense.

**A real bug hit immediately**: the Inspector's connection form ships with a
default placeholder command, `mcp-server-everything` (a generic reference/example
MCP server from the SDK's own docs) — not this project's server. Left unchanged,
it fails with `Error: spawn mcp-server-everything ENOENT`, since nothing by that
name is installed. Fixed by explicitly setting Command to `npx` and Arguments to
`tsx mcp/server.ts` in the connection form.

**Environment variables** are entered directly in the Inspector's UI rather than
relying on `.env` auto-loading via `dotenv` — confirmed necessary by inspecting the
Inspector's own connection request logs, which showed only shell-inherited vars
(`HOME`, `PATH`, `SHELL`, etc.) with no `DATABASE_URL` present. Required:
`DATABASE_URL` (the server throws immediately on startup without it — see
`config/database.ts`). `OLLAMA_BASE_URL` is optional, only relevant if Ollama runs
somewhere other than the default `http://localhost:11434`.

Once both were fixed, all three tools were exercised successfully through the
Inspector's UI.

### 4.2 Claude Desktop

Claude Desktop reads its MCP server list from
`~/Library/Application Support/Claude/claude_desktop_config.json` — an existing
file already containing unrelated app preferences (cowork settings, sidebar mode,
etc.), so the fix was to add a new `mcpServers` key to the existing object, not
replace the file.

**Absolute paths were used deliberately**, unlike the Inspector setup: the
Inspector's relative-path approach worked because it was launched from a known
directory (`server/`), but Claude Desktop spawns configured servers itself with an
unknown working directory, so relative paths aren't reliable there. Configured:

```json
"lev-boot-mcp": {
  "command": "npx",
  "args": ["tsx", "/absolute/path/to/server/mcp/server.ts"],
  "env": { "DATABASE_URL": "..." }
}
```

**A required step easy to miss**: Claude Desktop only picks up config changes on a
full quit-and-reopen, not just closing the window.

Verified working end to end with both example prompts from the test plan — a
direct question (routes to `rag_search` alone) and a request requiring Claude to
first discover available sources and then read one (`list_knowledge_sources` +
`read_source` together, with Claude doing the summarization itself afterward) —
confirming tool composition across multiple calls works, not just single
isolated tool invocations.

---

## Part 5 — Known limitations / not yet done

- **`idempotentHint: true` on `rag_search` isn't strictly guaranteed.** Unlike
  `ragas-option-1`'s branch, this branch's `ollamaService.ts` doesn't set
  `temperature: 0` on generation calls, so repeated identical questions aren't
  guaranteed to produce identical answers. The hint is a reasonable simplification
  for an MCP client's purposes, not a hard correctness guarantee.
- **Slack is excluded from `list_knowledge_sources` and `read_source` by design**
  (Part 3.2) — no current tool exposes Slack thread content directly; only
  `rag_search` can surface Slack-derived information, indirectly, as part of a
  grounded answer.
- **`node_modules/.bin/tsx` doesn't exist directly** in `server/`, yet `npx tsx`
  resolves and runs correctly regardless (likely via npx's own package cache) —
  unexplained, but confirmed harmless in practice across both the Inspector and
  Claude Desktop setups.
- **`constants.ts`'s other exports are unused.** Only `DATA_SOURCES` is actually
  used (by `listKnowledgeSources`); `GEMINI_MODEL`, `LLM_CONFIG`,
  `PROCESSING_CONFIG`, `PDF_FILES`, and the duplicate `GIST_BASE_URL`/`ARTICLE_IDS`
  (already independently defined inside `articleLoader.ts`) aren't wired up
  anywhere yet — left as-is since consolidating that duplication wasn't part of
  this task.
