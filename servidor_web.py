#!/usr/bin/env python3
"""Versión web del agente de ventas: API en FastAPI + frontend estático."""

import argparse
import asyncio
from contextlib import asynccontextmanager
import json
import os

from copilot import CopilotClient
from copilot.session import PermissionHandler
from copilot.session_events import SessionEventType
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from agente_ventas import DB_PATH, ROOT, SYSTEM_PROMPT, get_api_key, query_sales


STATIC_DIR = ROOT / "static"
DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash"
MODEL = os.environ.get("MODELO", DEFAULT_MODEL)
RESPONSE_TIMEOUT = 300.0


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    session_id: str | None = None


class AgentState:
    """Cliente Copilot compartido y sesiones abiertas desde el navegador."""

    def __init__(self) -> None:
        self.client: CopilotClient | None = None
        self.sessions: dict[str, object] = {}
        self.locks: dict[str, asyncio.Lock] = {}

    async def start(self) -> None:
        self.client = CopilotClient(
            mode="empty",
            working_directory=str(ROOT),
            base_directory=str(ROOT / ".copilot-state"),
        )
        await self.client.start()

    async def stop(self) -> None:
        for session in self.sessions.values():
            try:
                await session.disconnect()
            except Exception:
                pass
        self.sessions.clear()
        if self.client:
            await self.client.stop()

    async def get_or_create(self, session_id: str | None):
        if session_id and session_id in self.sessions:
            return self.sessions[session_id]
        session = await self.client.create_session(
            on_permission_request=PermissionHandler.approve_all,
            model=MODEL,
            provider={
                "type": "openai",
                "base_url": "https://openrouter.ai/api/v1",
                "wire_api": "responses",
                "api_key": get_api_key(),
            },
            streaming=True,
            tools=[query_sales],
            available_tools=["custom:query_sales"],
            system_message={"mode": "replace", "content": SYSTEM_PROMPT},
        )
        self.sessions[session.session_id] = session
        self.locks[session.session_id] = asyncio.Lock()
        return session

    async def close(self, session_id: str) -> bool:
        session = self.sessions.pop(session_id, None)
        self.locks.pop(session_id, None)
        if session is None:
            return False
        await session.disconnect()
        return True


state = AgentState()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if not DB_PATH.is_file():
        raise FileNotFoundError(f"No existe la base de datos: {DB_PATH}")
    await state.start()
    try:
        yield
    finally:
        await state.stop()


app = FastAPI(title="Agente de ventas", lifespan=lifespan)


def sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@app.get("/api/estado")
async def estado() -> dict:
    try:
        get_api_key()
        has_key = True
    except RuntimeError:
        has_key = False
    return {"modelo": MODEL, "api_key": has_key, "base_datos": DB_PATH.is_file()}


@app.post("/api/chat")
async def chat(request: ChatRequest) -> StreamingResponse:
    try:
        session = await state.get_or_create(request.session_id)
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    lock = state.locks[session.session_id]
    if lock.locked():
        raise HTTPException(status_code=409, detail="La sesión ya está respondiendo otra pregunta")

    async def stream():
        async with lock:
            yield sse("session", {"id": session.session_id})
            loop = asyncio.get_running_loop()
            queue: asyncio.Queue = asyncio.Queue()

            def on_event(event):
                loop.call_soon_threadsafe(queue.put_nowait, event)

            unsubscribe = session.on(on_event)
            task = asyncio.create_task(
                session.send_and_wait(request.message.strip(), timeout=RESPONSE_TIMEOUT)
            )
            task.add_done_callback(lambda _t: loop.call_soon_threadsafe(queue.put_nowait, None))
            finished = False
            try:
                while (event := await queue.get()) is not None:
                    if event.type == SessionEventType.ASSISTANT_MESSAGE_DELTA:
                        if event.data.delta_content:
                            yield sse("delta", {"text": event.data.delta_content})
                    elif event.type == SessionEventType.TOOL_EXECUTION_START:
                        args = event.data.arguments or {}
                        if isinstance(args, str):
                            try:
                                args = json.loads(args)
                            except ValueError:
                                args = {"sql": args}
                        yield sse("tool", {"name": event.data.tool_name, "sql": args.get("sql", "")})
                    elif event.type == SessionEventType.SESSION_ERROR:
                        yield sse("error", {"message": str(event.data)})
                try:
                    if task.result() is None:
                        yield sse("error", {"message": "El agente terminó sin responder"})
                except Exception as exc:
                    yield sse("error", {"message": str(exc) or exc.__class__.__name__})
                yield sse("done", {})
                finished = True
            finally:
                unsubscribe()
                if not finished:
                    # El navegador cortó la conexión: cancelamos la respuesta en curso.
                    task.cancel()
                    try:
                        await session.abort()
                    except Exception:
                        pass

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.delete("/api/sesiones/{session_id}")
async def cerrar_sesion(session_id: str) -> dict:
    return {"cerrada": await state.close(session_id)}


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


if __name__ == "__main__":
    import uvicorn

    parser = argparse.ArgumentParser(description="Interfaz web del agente de ventas")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--puerto", type=int, default=8000)
    parser.add_argument("--modelo", default=MODEL, help="Modelo de OpenRouter")
    args = parser.parse_args()
    MODEL = args.modelo
    uvicorn.run(app, host=args.host, port=args.puerto)
