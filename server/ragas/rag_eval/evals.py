import json
from datetime import datetime, timezone

from ragas import evaluate
from ragas.metrics import (
    answer_correctness,
    answer_relevancy,
    context_precision,
    context_recall,
    faithfulness,
)
from ragas.run_config import RunConfig

from build_dataset import build_dataset
from ollama_clients import embeddings, judge_llm

METRICS = [faithfulness, context_precision, context_recall, answer_relevancy, answer_correctness]


def main():
    print("Building dataset (querying the real Lev-Boots system for each question)...")
    dataset = build_dataset()

    print("\nRunning ragas evaluation (5 metrics)...")
    result = evaluate(
        dataset=dataset,
        metrics=METRICS,
        llm=judge_llm,
        embeddings=embeddings,
        run_config=RunConfig(max_workers=2),
    )

    df = result.to_pandas()

    print("\nPer-question results:")
    print(df.to_string())

    metric_names = [m.name for m in METRICS if m.name in df.columns]

    print("\nAverage per metric:")
    averages = {}
    for name in metric_names:
        averages[name] = df[name].mean()
        print(f"  {name}: {averages[name]:.3f}")

    output = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "perQuestion": df.to_dict(orient="records"),
        "averages": averages,
    }

    json_path = "evals/results.json"
    with open(json_path, "w") as f:
        json.dump(output, f, indent=2, default=str)
    print(f"\nResults saved to {json_path}")


if __name__ == "__main__":
    main()
