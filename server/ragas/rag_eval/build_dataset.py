import json
from pathlib import Path

from ragas import EvaluationDataset, SingleTurnSample

from lev_boots_client import query_lev_boots

GROUND_TRUTH_PATH = Path(__file__).parent.parent / "ground-truth.json"


def build_dataset() -> EvaluationDataset:
    ground_truth = json.loads(GROUND_TRUTH_PATH.read_text())

    samples = []
    for i, item in enumerate(ground_truth, 1):
        print(f"[{i}/{len(ground_truth)}] {item['question']}")
        result = query_lev_boots(item["question"])

        samples.append(
            SingleTurnSample(
                user_input=item["question"],
                retrieved_contexts=[
                    c["chunk_content"] for c in result["retrievedChunks"]
                ],
                response=result["answer"],
                reference=item["answer"],
            )
        )

    return EvaluationDataset(samples=samples)
