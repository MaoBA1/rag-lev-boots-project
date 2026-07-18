from openai import OpenAI
from ragas.embeddings import embedding_factory
from ragas.llms import llm_factory

OLLAMA_BASE_URL = "http://localhost:11434/v1"

openai_client = OpenAI(
    api_key="ollama",  # Ollama doesn't require a real key
    base_url=OLLAMA_BASE_URL,
)

# Judge model for all ragas metric LLM calls (claim decomposition, verification, etc.)
judge_llm = llm_factory("qwen2.5:7b", client=openai_client)

# Embeddings for answer_relevancy and answer_correctness' semantic similarity half
embeddings = embedding_factory("openai", model="nomic-embed-text", client=openai_client)

# Different ragas metrics call different, inconsistent embedding method names
# internally - some sync-style (embed_query, embed_documents), some
# async-style (aembed_text, aembed_query, aembed_documents) - regardless of
# whether the underlying client is actually sync or async. Since we
# deliberately use a sync client, alias every variant to the same underlying
# sync calls; the async-named ones are thin coroutine shims that just call
# through synchronously - no real concurrency happens, which is exactly what
# we want given the max_workers cap below.
embeddings.embed_query = embeddings.embed_text
embeddings.embed_documents = embeddings.embed_texts


async def _aembed_text(text):
    return embeddings.embed_text(text)


async def _aembed_texts(texts):
    return embeddings.embed_texts(texts)


embeddings.aembed_text = _aembed_text
embeddings.aembed_texts = _aembed_texts
embeddings.aembed_query = _aembed_text
embeddings.aembed_documents = _aembed_texts
