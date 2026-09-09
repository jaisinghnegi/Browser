"""Local text chat. Never receives extension captures or executes model actions."""
from pathlib import Path
from typing import Annotated, Literal

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, Field, model_validator

from server.vlm_client import VlmUnavailable, chat_with_vlm

WEB = Path(__file__).parents[1] / 'web'
SYSTEM = (
    'You are the assistant in the local Privacy Agent application. Answer clearly and helpfully. '
    'This application connects to a local Qwen server. You have no browser control, file access, '
    'or tools in this chat. Do not claim to have performed actions. Browser actions are available '
    'only through the separate privacy extension. Never claim typed chat text was automatically redacted.'
)
CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"


class Message(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    role: Literal['user', 'assistant']
    content: Annotated[str, Field(min_length=1, max_length=4000)]


class ChatRequest(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    messages: Annotated[list[Message], Field(min_length=1, max_length=12)]

    @model_validator(mode='after')
    def bounded_conversation(self):
        if sum(len(m.content) for m in self.messages) > 4000:
            raise ValueError('conversation too long')
        if self.messages[-1].role != 'user':
            raise ValueError('last turn must be user')
        for i, message in enumerate(self.messages):
            if not message.content.strip() or message.role != ('user' if i % 2 == 0 else 'assistant'):
                raise ValueError('invalid conversation order')
        return self


def create_chat_router(base_url: str) -> APIRouter:
    router = APIRouter()

    @router.get('/')
    def chat_page():
        return FileResponse(WEB / 'index.html', headers={'Content-Security-Policy': CSP, 'Cache-Control': 'no-store'})

    @router.get('/app.js')
    def chat_script():
        return FileResponse(WEB / 'app.js', media_type='text/javascript', headers={'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'})

    @router.get('/app.css')
    def chat_style():
        return FileResponse(WEB / 'app.css', media_type='text/css', headers={'Cache-Control': 'no-store'})

    @router.get('/api/models')
    def models():
        return {'models': [{'id': 'qwen-local', 'name': 'Qwen', 'location': 'local'}]}

    @router.post('/api/chat')
    async def chat(body: ChatRequest, request: Request):
        origin = request.headers.get('origin')
        if origin and origin != f'{request.url.scheme}://{request.url.netloc}':
            return JSONResponse(status_code=403, content={'error': 'Origin not allowed'})
        try:
            reply = await chat_with_vlm(
                base_url=base_url, system_prompt=SYSTEM,
                conversation=[m.model_dump() for m in body.messages], max_output_tokens=512,
            )
            if not reply.strip():
                raise VlmUnavailable('empty reply')
        except VlmUnavailable:
            return JSONResponse(status_code=502, content={'error': 'Local model unavailable. Try again shortly.'})
        return {'reply': reply, 'provider': 'qwen-local'}

    return router
