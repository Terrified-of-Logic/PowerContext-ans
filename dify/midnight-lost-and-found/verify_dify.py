"""Run the published Chatflow via Dify API and retain a credential-free transcript."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import uuid
import httpx


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://localhost/v1")
    parser.add_argument("--output", default="evidence/local-dify-run.json")
    args = parser.parse_args()
    key = os.environ.get("DIFY_APP_KEY")
    if not key:
        parser.error("Set DIFY_APP_KEY to the published application's API key")
    player = "midnight-review-" + uuid.uuid4().hex[:12]
    transcript = []
    conversation = ""
    with httpx.Client(timeout=180) as client:
        for index, query in enumerate(("开门", "1", "3", "1", "你好，我又来了，还记得我上次处理了什么吗？")):
            # The fifth call deliberately starts a NEW Dify conversation with the SAME user.
            if index == 4:
                conversation = ""
            response = client.post(args.base_url.rstrip("/") + "/chat-messages",
                headers={"Authorization": "Bearer " + key},
                json={"inputs": {}, "query": query, "response_mode": "blocking",
                      "conversation_id": conversation, "user": player})
            response.raise_for_status()
            result = response.json()
            if not result.get("answer"):
                raise RuntimeError("Dify returned no answer")
            conversation = result["conversation_id"]
            transcript.append({"query": query, "conversation_id": conversation, "answer": result["answer"]})
            print(query + "\n" + result["answer"] + "\n")
    if transcript[0]["conversation_id"] == transcript[-1]["conversation_id"]:
        raise RuntimeError("Dify did not create a new conversation")
    if "伞" not in transcript[-1]["answer"]:
        raise RuntimeError("Cross-conversation answer did not mention the previous umbrella")
    path = Path(args.output)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"executed_at": datetime.now(timezone.utc).isoformat(),
        "user": player, "transcript": transcript}, ensure_ascii=False, indent=2), encoding="utf-8")
    print("Saved " + str(path))


if __name__ == "__main__":
    main()
