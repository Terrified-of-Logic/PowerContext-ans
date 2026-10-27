"""Real HTTP/PowerContext restart check; does not impersonate a Dify platform run."""
from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import time
import uuid

import httpx
import yaml

ROOT = Path(__file__).resolve().parent


@contextmanager
def server(data, token):
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    env = dict(os.environ, MIDNIGHT_TOKEN=token, MIDNIGHT_DATA=str(data), PYTHONUTF8="1")
    with (data / "server.log").open("a", encoding="utf-8") as log:
        process = subprocess.Popen([sys.executable, "-m", "uvicorn", "service:create_app", "--factory",
            "--host", "127.0.0.1", "--port", str(port)], cwd=ROOT, env=env,
            stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        try:
            with httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=30, trust_env=False) as client:
                for _ in range(100):
                    if process.poll() is not None:
                        raise RuntimeError("Service exited; inspect " + str(data / "server.log"))
                    try:
                        if client.get("/health").status_code == 200:
                            break
                    except httpx.ConnectError:
                        pass
                    time.sleep(0.2)
                else:
                    raise RuntimeError("Service did not become ready")
                yield process.pid, client
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


def main():
    data = ROOT / (".test-tmp-local-" + uuid.uuid4().hex[:8])
    data.mkdir()
    token = secrets.token_urlsafe(32)
    headers = {"Authorization": "Bearer " + token}
    dsl = yaml.safe_load((ROOT / "midnight-rules.yml").read_text(encoding="utf-8"))
    nodes = {node["id"]: node["data"] for node in dsl["workflow"]["graph"]["nodes"]}

    def code(name, **args):
        ns = {}
        exec(compile(nodes[name]["code"], name, "exec"), ns)
        return ns["main"](**args)

    evidence = {"executed_at": datetime.now(timezone.utc).isoformat(),
                "kind": "local HTTP + exported code nodes + real PowerContext; no Dify platform execution",
                "transcript": []}
    with server(data, token) as (pid, client):
        evidence["first_pid"] = pid
        for action in ("开门", "1", "3", "1"):
            encoded = code("request", player="review-player")
            read = client.post("/recall", content=encoded["body"], headers=headers)
            rules = code("rules", body=read.text, status=read.status_code, player="review-player", action=action)
            saved = client.post("/commit", content=rules["commit_body"], headers=headers)
            output = code("render", body=saved.text, status=saved.status_code, scene=rules["scene"],
                          choices=rules["choices"], narrative=rules["scene"])
            evidence["transcript"].append({"input": action, "answer": output["answer"], "write": saved.json()})
        before = client.post("/recall", json={"player": "review-player"}, headers=headers).json()
    with server(data, token) as (pid, client):
        after = client.post("/recall", json={"player": "review-player"}, headers=headers).json()
        other = client.post("/recall", json={"player": "another-player"}, headers=headers).json()
        assert before == after and after["state"]["stage"] == "ended"
        assert other["state"]["receipts"] == []
        assert after["citation"]
        evidence.update(second_pid=pid, after_restart=after, isolation_passed=True, restart_passed=True)
    path = ROOT / "evidence" / "powercontext-local.json"
    path.parent.mkdir(exist_ok=True)
    path.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
    print("PASS: HTTP gameplay, separate-process restart, player isolation; evidence/powercontext-local.json")


if __name__ == "__main__":
    main()
