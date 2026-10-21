"""Select source-backed decision cards without treating them as media observations."""
import argparse
import json
import re
from pathlib import Path

def select(data, query="", card_ids=(), limit=6):
    requested = set(card_ids)
    if requested:
        unknown = requested - {c["card_id"] for c in data["cards"]}
        if unknown:
            raise ValueError("Unknown card IDs: " + ", ".join(sorted(unknown)))
        selected = [c for c in data["cards"] if c["card_id"] in requested]
    else:
        terms = [x.casefold() for x in re.split(r"[,，;；\s]+", query) if x]
        ranked = []
        for c in data["cards"]:
            tags = [x.casefold() for x in c["tags"]]
            score = sum(2 for t in tags if t in query.casefold())
            score += sum(1 for t in terms if t in " ".join(tags))
            if score:
                ranked.append((score, c["card_id"], c))
        selected = [c for _, _, c in sorted(ranked, key=lambda x: (-x[0], x[1]))[:limit]]
    ids = {sid for c in selected for sid in c["source_ids"]}
    return {"schema_version": 1, "query": query,
            "card_ids": [c["card_id"] for c in selected], "cards": selected,
            "sources": [s for s in data["sources"] if s["source_id"] in ids],
            "is_current_media_evidence": False, "artistic_approval": False,
            "status": "method_excerpt_only" if selected else "no_method_match"}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cards", type=Path, required=True,
                        help="Explicit decision-card JSON; private research cards are not bundled.")
    parser.add_argument("--query", default="")
    parser.add_argument("--card", action="append", default=[])
    parser.add_argument("--limit", type=int, default=6)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    if not args.query and not args.card:
        parser.error("Provide --query or --card.")
    if args.limit < 1:
        parser.error("--limit must be positive.")
    data = json.loads(args.cards.read_text(encoding="utf-8-sig"))
    result = select(data, args.query, args.card, args.limit)
    text = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(text, encoding="utf-8")
        print(json.dumps({"path": str(args.out), "card_ids": result["card_ids"]},
                         ensure_ascii=False))
    else:
        print(text, end="")
if __name__ == "__main__":
    main()

