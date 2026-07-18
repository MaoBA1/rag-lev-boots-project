import requests

ASK_EVAL_URL = "http://localhost:3000/api/ask_eval"


def query_lev_boots(question: str) -> dict:
    """
    Send a question to the Lev-Boots RAG system's eval endpoint and return
    the generated answer along with the chunks retrieval used to produce it.

    Returns: {"answer": str, "retrievedChunks": [{"source", "source_id", "chunk_content"}, ...]}
    """
    response = requests.post(ASK_EVAL_URL, json={"userQuestion": question})
    response.raise_for_status()
    return response.json()
