"""Private Dify adapter. PowerContext is the only authoritative game-state store."""
import asyncio
from contextlib import asynccontextmanager
import hashlib
import hmac
import json
import os
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field, ConfigDict
from powercontext.builtin.artifacts.memory import MemoryEntryInput
from powercontext.builtin.persistence.sqlite import SQLiteConfig
from powercontext.builtin.runtime import BuiltinConfig, RememberMemoryRequest, open_builtin_runtime
from powercontext.builtin.scope import ScopeDraft

from game import fresh_state, resolve


class Player(BaseModel):
    model_config = ConfigDict(extra="forbid")
    player: str = Field(min_length=1, max_length=200)


class Commit(Player):
    revision: int = Field(ge=0)
    action: str = Field(min_length=1, max_length=2000)
    state: dict


def create_app(directory=None, token=None):
    data = Path(directory or os.environ.get("MIDNIGHT_DATA", "./data")).resolve()
    key = token or os.environ.get("MIDNIGHT_TOKEN", "")
    if len(key) < 24:
        raise ValueError("Set MIDNIGHT_TOKEN to a random secret of at least 24 characters")

    @asynccontextmanager
    async def lifespan(app):
        data.mkdir(parents=True, exist_ok=True)
        config = BuiltinConfig(database=SQLiteConfig(url=f"sqlite+aiosqlite:///{data / 'runtime.db'}"))
        async with open_builtin_runtime(config, scheduler_path=data / "scheduler.db") as runtime:
            app.state.runtime = runtime
            # One bounded critical section for this single-worker demo; database revisions
            # additionally protect writes. This lock contains no player or story cache.
            app.state.lock = asyncio.Lock()
            yield

    app = FastAPI(title="午夜失物招领处 · PowerContext", lifespan=lifespan)

    async def authorize(authorization: str = Header(default="")):
        if not hmac.compare_digest(authorization, "Bearer " + key):
            raise HTTPException(401, "Invalid service token")

    async def read(player):
        identity = hashlib.sha256(("midnight-v1:" + player).encode()).hexdigest()
        scope = await app.state.runtime.scopes.create(ScopeDraft(
            title="Midnight player " + identity[:12], summary="午夜失物招领处的玩家状态与历史收据",
            idempotency_key="midnight:" + identity,
        ))
        page = await app.state.runtime.memory.for_scope(scope.scope_id).list()
        records = [r for r in page.entries if r.entry.kind == "midnight-state"]
        latest = max(records, key=lambda r: r.entry.created_in_revision) if records else None
        state = json.loads(latest.entry.text)["state"] if latest else fresh_state()
        revision = page.memory_ref.revision if page.memory_ref else 0
        return scope.scope_id, revision, state, latest

    @app.get("/health")
    async def health():
        return {"status": "ok", "storage": "PowerContext SQLite", "schema": "midnight.v1"}

    @app.post("/recall", dependencies=[Depends(authorize)])
    async def recall(request: Player):
        async with app.state.lock:
            scope, revision, state, record = await read(request.player)
            return {"scope_id": scope, "revision": revision, "state": state,
                    "citation": record.citation.model_dump(mode="json") if record else None}

    @app.post("/commit", dependencies=[Depends(authorize)])
    async def commit(request: Commit):
        async with app.state.lock:
            scope, revision, state, record = await read(request.player)
            # A retry is only accepted while its result is still the current head.
            if record:
                previous = json.loads(record.entry.text)
                if (previous.get("base_revision") == request.revision
                        and previous.get("action") == request.action and state == request.state):
                    return {"saved": True, "revision": revision, "replayed": True}
            if revision != request.revision:
                raise HTTPException(409, "State changed; send your choice again")
            expected = resolve(state, request.action)
            if expected["state"] != request.state:
                raise HTTPException(422, "State does not match the game rules")
            if not expected["changed"]:
                return {"saved": True, "revision": revision, "replayed": False}
            if revision >= 120:
                raise HTTPException(409, "Demo limit reached; use a new API user to start another archive")
            payload = json.dumps({"state": request.state, "action": request.action,
                                  "base_revision": revision}, ensure_ascii=False, separators=(",", ":"))
            result = await app.state.runtime.memory.for_scope(scope).remember(RememberMemoryRequest(
                entries=(MemoryEntryInput(kind="midnight-state", text=payload),),
                expected_revision=revision if revision else None,
            ))
            return {"saved": True, "revision": result.memory_ref.revision, "replayed": False}

    return app
