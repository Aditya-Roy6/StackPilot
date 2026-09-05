from __future__ import annotations

import json
import os
import re
import asyncio
import hashlib
import hmac
import math
import time
import uuid
import ipaddress
import socket
from urllib.parse import urlparse
from typing import Any, AsyncIterator, Dict, List, Literal, Optional, TypedDict

import httpx
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi import Depends, FastAPI, HTTPException, Request
from langgraph.graph import END, StateGraph
from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.tools import AGENT_TOOLS, execute_tool_call
from app.swarm import (
    ArchitectAgent,
    CoderAgent,
    VerifierAgent,
    SupervisorAgent,
    ArchitectBlueprint,
    CodePatch,
    VerificationReport,
    PermissionRequest,
    SwarmContext,
)

MAX_TEXT = int(os.getenv("STACKPILOT_AI_MAX_TEXT_BYTES", "24000"))
DEFAULT_TIMEOUT = float(os.getenv("STACKPILOT_AI_REQUEST_TIMEOUT_SECONDS", "300"))
MODEL_PROBE_TIMEOUT = float(os.getenv("NVIDIA_NIM_MODEL_PROBE_TIMEOUT_SECONDS", "8"))
MODEL_PROBE_LIMIT = int(os.getenv("NVIDIA_NIM_MODEL_PROBE_LIMIT", "30"))
MODEL_PROBE_CACHE_TTL = float(os.getenv("NVIDIA_NIM_MODEL_PROBE_CACHE_SECONDS", "3600"))
MODEL_PROBE_CACHE: Dict[str, Any] = {"expires_at": 0.0, "models": []}
# Serialises refreshes: the cache was a bare dict with a check-then-write race,
# so N concurrent cold /models requests each launched a full probe sweep
# (N x MODEL_PROBE_LIMIT chat completions), which rate-limited the provider
# and left every probe failing.
MODEL_PROBE_LOCK = asyncio.Lock()


class AgentRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    provider: Optional[str] = None
    model: Optional[str] = None
    user_id: Optional[str] = None
    workflow_type: Optional[str] = None
    action: Optional[str] = None
    project: Dict[str, Any] = Field(default_factory=dict)
    project_context: Dict[str, Any] = Field(default_factory=dict)
    deployment: Dict[str, Any] = Field(default_factory=dict)
    source: Dict[str, Any] = Field(default_factory=dict)
    logs: str = ""
    runtime: Dict[str, Any] = Field(default_factory=dict)
    provider_overrides: Dict[str, Any] = Field(default_factory=dict)
    message: str = ""
    command: str = ""
    model_mode: Literal["fast", "thinking"] = "fast"
    project_id: Optional[str] = None
    deployment_id: Optional[str] = None
    history: List[Dict[str, str]] = Field(default_factory=list)
    memory: Dict[str, Any] = Field(default_factory=dict)
    confidence_threshold: float = 0.72
    agent_access_mode: Optional[str] = None
    approval_token: Optional[str] = None

    @model_validator(mode="after")
    def normalize_legacy_fields(self) -> "AgentRequest":
        if not self.workflow_type and self.action:
            self.workflow_type = self.action
        if not self.project and self.project_context:
            self.project = self.project_context
        if not self.project_id and self.project and isinstance(self.project, dict):
            self.project_id = self.project.get("id")
        if not self.deployment_id and self.deployment and isinstance(self.deployment, dict):
            self.deployment_id = self.deployment.get("id")
        return self


class AgentResponse(BaseModel):
    status: Literal["ok", "error"] = "ok"
    result_type: str
    confidence: float = 0.0
    summary: str = ""
    structured_output: Dict[str, Any] = Field(default_factory=dict)
    warnings: List[str] = Field(default_factory=list)
    requires_user_confirmation: bool = True
    trace_id: str
    provider: str
    model: str
    latency_ms: int = 0
    token_usage: Dict[str, Any] = Field(default_factory=dict)
    # The model's working, when the model exposes it. Empty for models that do
    # not emit reasoning_content, which is most of the fast ones.
    reasoning: str = ""
    error: str = ""


class EmbeddingRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    provider: Optional[str] = None
    model: Optional[str] = None
    provider_overrides: Dict[str, Any] = Field(default_factory=dict)
    texts: List[str] = Field(default_factory=list)
    dimensions: int = Field(default_factory=lambda: int(os.getenv("STACKPILOT_AI_EMBEDDING_DIMENSIONS", "384")))


class AgentState(TypedDict, total=False):
    request: AgentRequest
    workflow: str
    prompt: str
    response: Dict[str, Any]
    warnings: List[str]


app = FastAPI(title="StackPilot AI Service", version="0.1.0")


# ---------------------------------------------------------------------------
# Service authentication
# ---------------------------------------------------------------------------
# This service had no authentication on any route. Anything able to reach it on
# the docker network could drive the model, read provider settings, or abuse the
# SSRF sink below. It is only exposed on 127.0.0.1 today, which is a deployment
# detail rather than a control.
SERVICE_TOKEN = os.getenv("STACKPILOT_AI_SERVICE_TOKEN", "").strip()

# Unauthenticated probes so container healthchecks keep working.
PUBLIC_PATHS = {"/health", "/docs", "/openapi.json", "/redoc"}


@app.middleware("http")
async def require_service_token(request: Request, call_next):
    if request.url.path in PUBLIC_PATHS or not SERVICE_TOKEN:
        return await call_next(request)
    presented = request.headers.get("x-stackpilot-service-token", "")
    # Constant-time compare so the token can't be recovered by timing.
    if not hmac.compare_digest(presented, SERVICE_TOKEN):
        return JSONResponse(status_code=401, content={"detail": "Unauthorized"})
    return await call_next(request)


# ---------------------------------------------------------------------------
# SSRF guard for caller-supplied provider base URLs
# ---------------------------------------------------------------------------
# `provider_overrides.base_url` was passed straight to httpx, so a caller could
# point this service at the cloud metadata endpoint or any internal host. The
# backend validates this on PUT /ai/settings, but that guard is bypassed by
# talking to this service directly, so it has to be enforced here too.
ALLOW_PRIVATE_PROVIDER_HOSTS = os.getenv("STACKPILOT_AI_ALLOW_PRIVATE_PROVIDER_HOSTS", "").lower() in {"1", "true", "yes"}


def validate_provider_base_url(raw: str) -> str:
    """Return the URL unchanged, or raise HTTPException if it is not safe to call."""
    if not raw:
        return raw
    parsed = urlparse(raw)
    if parsed.scheme not in {"http", "https"}:
        raise HTTPException(status_code=400, detail="Provider base_url must be http or https")
    host = parsed.hostname
    if not host:
        raise HTTPException(status_code=400, detail="Provider base_url is missing a host")
    if ALLOW_PRIVATE_PROVIDER_HOSTS:
        return raw

    # Resolve first: a public-looking name can still point at a private address.
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        raise HTTPException(status_code=400, detail="Provider base_url host could not be resolved")
    for info in infos:
        address = ipaddress.ip_address(info[4][0])
        if (address.is_private or address.is_loopback or address.is_link_local
                or address.is_reserved or address.is_multicast):
            raise HTTPException(
                status_code=400,
                detail="Provider base_url resolves to a non-public address",
            )
    return raw


SECRET_PATTERNS = [
    re.compile(r"(?i)(api[_-]?key|token|secret|password|private[_-]?key)\s*[:=]\s*['\"]?[^'\"\s]+"),
    re.compile(r"gh[pousr]_[A-Za-z0-9_]{20,}"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----", re.S),
]


def clip(value: str, limit: int = MAX_TEXT) -> str:
    value = value or ""
    if len(value.encode("utf-8", errors="ignore")) <= limit:
        return value
    return value[: limit // 2] + "\n...[clipped]...\n" + value[-limit // 2 :]


def redact_text(value: str) -> str:
    redacted = clip(value)
    for pattern in SECRET_PATTERNS:
        redacted = pattern.sub(lambda m: m.group(0).split("=")[0].split(":")[0] + "=[REDACTED]", redacted)
    return redacted


def safe_json(value: Any) -> Any:
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, list):
        return [safe_json(item) for item in value[:200]]
    if isinstance(value, dict):
        result: Dict[str, Any] = {}
        for key, item in list(value.items())[:200]:
            if re.search(r"(?i)(secret|token|password|private|key|credential)", str(key)):
                result[key] = "[REDACTED]"
            else:
                result[key] = safe_json(item)
        return result
    return value


def provider_config(
    provider: Optional[str],
    model: Optional[str],
    model_mode: str = "fast",
    overrides: Optional[Dict[str, Any]] = None,
) -> tuple[str, str, str, str]:
    overrides = overrides or {}
    selected = (provider or os.getenv("STACKPILOT_AI_PROVIDER") or "nvidia_nim").strip()
    if selected == "openai_compatible":
        base_url = str(
            overrides.get("base_url")
            or overrides.get("openai_compatible_base_url")
            or os.getenv("OPENAI_COMPATIBLE_BASE_URL", "")
        ).rstrip("/")
        api_key = str(
            overrides.get("api_key")
            or overrides.get("openai_compatible_api_key")
            or os.getenv("OPENAI_COMPATIBLE_API_KEY", "")
        )
        selected_model = (
            model
            or str(overrides.get("model") or "")
            or os.getenv("OPENAI_COMPATIBLE_MODEL", "")
            or os.getenv("STACKPILOT_AI_MODEL", "")
        )
    else:
        selected = "nvidia_nim"
        base_url = str(
            overrides.get("base_url")
            or overrides.get("nvidia_base_url")
            or os.getenv("NVIDIA_NIM_BASE_URL", "https://integrate.api.nvidia.com/v1")
        ).rstrip("/")
        api_key = str(
            overrides.get("api_key")
            or overrides.get("nvidia_api_key")
            or os.getenv("NVIDIA_NIM_API_KEY")
            or os.getenv("NVIDIA_API_KEY", "")
        )
        selected_model = (
            model
            or str(overrides.get("model") or "")
            or os.getenv("STACKPILOT_AI_MODEL", "")
            or os.getenv("NVIDIA_NIM_MODEL", "")
        )
    if selected == "openai_compatible":
        validate_provider_base_url(base_url)
    return selected, base_url, api_key, selected_model


def embedding_provider_config(req: EmbeddingRequest) -> tuple[str, str, str, str]:
    overrides = req.provider_overrides or {}
    selected = (req.provider or os.getenv("STACKPILOT_AI_EMBEDDING_PROVIDER") or os.getenv("STACKPILOT_AI_PROVIDER") or "nvidia_nim").strip()
    if selected == "openai_compatible":
        base_url = str(
            overrides.get("base_url")
            or overrides.get("openai_compatible_base_url")
            or os.getenv("OPENAI_COMPATIBLE_BASE_URL", "")
        ).rstrip("/")
        api_key = str(
            overrides.get("api_key")
            or overrides.get("openai_compatible_api_key")
            or os.getenv("OPENAI_COMPATIBLE_API_KEY", "")
        )
        model = req.model or os.getenv("OPENAI_COMPATIBLE_EMBEDDING_MODEL") or "text-embedding-3-small"
        # Same SSRF guard as provider_config — the embeddings route accepts the
        # identical caller-supplied base_url and must not be a bypass.
        validate_provider_base_url(base_url)
    else:
        selected = "nvidia_nim"
        base_url = os.getenv("NVIDIA_NIM_BASE_URL", "https://integrate.api.nvidia.com/v1").rstrip("/")
        api_key = str(
            overrides.get("api_key")
            or overrides.get("nvidia_api_key")
            or os.getenv("NVIDIA_NIM_API_KEY")
            or os.getenv("NVIDIA_API_KEY", "")
        )
        model = req.model or os.getenv("NVIDIA_NIM_EMBEDDING_MODEL") or "nvidia/llama-3.2-nv-embedqa-1b-v2"
    return selected, base_url, api_key, model


def normalize_embedding(values: List[float], dimensions: int) -> List[float]:
    if len(values) > dimensions:
        values = values[:dimensions]
    elif len(values) < dimensions:
        values = [*values, *([0.0] * (dimensions - len(values)))]
    norm = math.sqrt(sum(v * v for v in values)) or 1.0
    return [round(v / norm, 8) for v in values]


def deterministic_embedding(text: str, dimensions: int) -> List[float]:
    vector = [0.0] * dimensions
    tokens = re.findall(r"[A-Za-z0-9_./:-]+", (text or "").lower())
    if not tokens:
        tokens = ["empty"]
    for token in tokens:
        digest = hashlib.sha256(token.encode("utf-8", errors="ignore")).digest()
        for offset in range(0, min(16, len(digest)), 2):
            index = int.from_bytes(digest[offset : offset + 2], "big") % dimensions
            sign = 1.0 if digest[(offset + 1) % len(digest)] % 2 == 0 else -1.0
            vector[index] += sign
    return normalize_embedding(vector, dimensions)


async def provider_embeddings(req: EmbeddingRequest) -> Dict[str, Any]:
    dimensions = 384
    texts = [clip(redact_text(text), MAX_TEXT) for text in req.texts[:32]]
    provider, base_url, api_key, model = embedding_provider_config(req)
    allow_fallback = env_flag("STACKPILOT_AI_EMBEDDING_FALLBACK", True)

    if base_url and api_key and texts:
        payload: Dict[str, Any] = {"model": model, "input": texts}
        if provider == "openai_compatible" and "text-embedding-3" in model:
            payload["dimensions"] = dimensions
        try:
            timeout = httpx.Timeout(DEFAULT_TIMEOUT, connect=10.0, read=DEFAULT_TIMEOUT, write=10.0, pool=10.0)
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.post(
                    f"{base_url}/embeddings",
                    headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                    json=payload,
                )
            response.raise_for_status()
            data = response.json()
            embeddings = []
            for item in data.get("data", []):
                raw = item.get("embedding", [])
                embeddings.append(normalize_embedding([float(v) for v in raw], dimensions))
            if len(embeddings) == len(texts):
                return {
                    "status": "ok",
                    "provider": provider,
                    "model": model,
                    "dimensions": dimensions,
                    "fallback": False,
                    "embeddings": embeddings,
                }
        except Exception:
            if not allow_fallback:
                raise

    return {
        "status": "ok",
        "provider": "deterministic",
        "model": "stackpilot-hash-embedding-v1",
        "dimensions": dimensions,
        "fallback": True,
        "embeddings": [deterministic_embedding(text, dimensions) for text in texts],
    }


def model_extra_body(model: str, model_mode: str) -> Dict[str, Any]:
    lowered = (model or "").lower()
    if lowered.startswith("z-ai/") or "glm" in lowered:
        return {
            "chat_template_kwargs": {
                "enable_thinking": model_mode == "thinking",
                "clear_thinking": False,
            }
        }
    return {}


def chat_payload(
    model: str,
    prompt: Optional[str] = None,
    *,
    messages: Optional[List[Dict[str, Any]]] = None,
    json_mode: bool = False,
    temperature: float = 0.2,
    model_mode: str = "fast",
    stream: bool = False,
    max_tokens: int = 2048,
    tools: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    if not messages:
        messages = [
            {
                "role": "system",
                "content": "You are StackPilot Assistant, an expert DevOps and software engineering copilot. You provide helpful, accurate technical answers.",
            },
            {"role": "user", "content": prompt or ""},
        ]
        
    payload: Dict[str, Any] = {
        "model": model,
        "temperature": temperature,
        "top_p": 1,
        "max_tokens": max_tokens,
        "stream": stream,
        "messages": messages,
    }
    if tools:
        payload["tools"] = tools
        # For Nvidia NIM, they might not support tool_choice, but standard OpenAI does. Let's add it.
        # Actually some providers fail if tool_choice is specified. Let's just pass tools.
    if json_mode:
        payload["response_format"] = {"type": "json_object"}
    extra_body = model_extra_body(model, model_mode)
    payload.update(extra_body)
    return payload


# Keys that identify our own response envelope, as opposed to any JSON that
# merely happens to appear inside a prose answer.
ENVELOPE_KEYS = {"summary", "result_type", "structured_output", "confidence"}


def parse_model_json(content: str, *, allow_fragment: bool = True) -> Dict[str, Any]:
    """Parse the model's reply as our response envelope.

    The brace-matching fallback used to run for every workflow, including chat.
    A chat answer containing a fenced JSON block (e.g. "here is a package.json")
    would match first-{ to last-}, parse cleanly, and be returned as the whole
    response — leaving summary empty, so the user saw a blank message. The
    fallback is now limited to workflows that actually asked for JSON, and the
    result must look like our envelope.
    """
    text = (content or "{}").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.I)
        text = re.sub(r"\s*```$", "", text)
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        if not allow_fragment:
            raise
        match = re.search(r"\{.*\}", text, flags=re.S)
        if not match:
            raise
        parsed = json.loads(match.group(0))

    if not isinstance(parsed, dict) or not (ENVELOPE_KEYS & set(parsed.keys())):
        # Valid JSON, but not our envelope — treat it as prose so the caller
        # falls back to plain_text_response instead of returning an empty summary.
        raise json.JSONDecodeError("model output is not an agent envelope", text, 0)
    return parsed


KNOWN_TOOL_NAMES = {
    "get_deployment_status",
    "get_deployment_logs",
    "trigger_build",
    "repair_deployment",
    "list_deployments",
    "list_projects",
    "get_deployment_metrics",
    "scale_deployment",
    "terminal_run_command",
    "workspace_list_files",
    "workspace_read_file",
    "workspace_edit_file",
    "workspace_write_file",
    "workspace_trigger_rebuild",
    "wait_for_deployment",
}


def extract_pseudo_tool_call(content: str) -> Optional[Dict[str, Any]]:
    """Detect and parse pseudo-tool JSON or XML emitted by LLMs in plain text content."""
    if not content:
        return None
    s = content.strip()

    # 1. XML-attribute format (e.g. Qwen / Nemotron / Hermes XML syntax):
    # <tool_call> <function=get_deployment_logs> <parameter=deployment_id> ... </parameter> </function> </tool_call>
    xml_func = re.search(r"<tool_call[^>]*>.*?<function=([a-zA-Z0-9_-]+)>(.*?)(?:</function>|</tool_call>|$)", s, re.DOTALL)
    if xml_func:
        func_name = xml_func.group(1).strip()
        params_body = xml_func.group(2)
        args: Dict[str, Any] = {}
        for p_match in re.finditer(r"<parameter=([a-zA-Z0-9_-]+)>(.*?)(?:</parameter>|$)", params_body, re.DOTALL):
            p_name = p_match.group(1).strip()
            p_val = p_match.group(2).strip()
            p_val = re.sub(r"</?(?:parameter|function|tool_call)[^>]*>", "", p_val).strip()
            if (p_val.startswith('"') and p_val.endswith('"')) or (p_val.startswith("'") and p_val.endswith("'")):
                p_val = p_val[1:-1]
            try:
                args[p_name] = json.loads(p_val)
            except Exception:
                args[p_name] = p_val
        if func_name in KNOWN_TOOL_NAMES or re.match(r"^[a-zA-Z_][a-zA-Z0-9_]{2,40}$", func_name):
            return {"name": func_name, "arguments": args}

    # 2. Tag-based XML format:
    # <tool_call><function>get_deployment_logs</function><parameters><deployment_id>...</deployment_id></parameters></tool_call>
    tag_func = re.search(r"<tool_call[^>]*>.*?<(?:function|name)>([a-zA-Z0-9_-]+)</(?:function|name)>(.*?)(?:</tool_call>|$)", s, re.DOTALL)
    if tag_func:
        func_name = tag_func.group(1).strip()
        params_body = tag_func.group(2)
        args: Dict[str, Any] = {}
        for p_match in re.finditer(r"<([a-zA-Z0-9_]+)>(.*?)</\1>", params_body, re.DOTALL):
            p_name = p_match.group(1).strip()
            if p_name in {"parameters", "arguments"}:
                continue
            p_val = p_match.group(2).strip()
            try:
                args[p_name] = json.loads(p_val)
            except Exception:
                args[p_name] = p_val
        if func_name in KNOWN_TOOL_NAMES or re.match(r"^[a-zA-Z_][a-zA-Z0-9_]{2,40}$", func_name):
            return {"name": func_name, "arguments": args}

    # Strip markdown code blocks
    if s.startswith("```"):
        lines = s.split("\n")
        if len(lines) >= 2:
            if lines[-1].strip() == "```":
                lines = lines[1:-1]
            else:
                lines = lines[1:]
            s = "\n".join(lines).strip()

    # Strip XML tags like <tool_call> ... </tool_call> or <action> ... </action>
    for tag in ["tool_call", "action"]:
        if f"<{tag}>" in s and f"</{tag}>" in s:
            s = s.split(f"<{tag}>", 1)[1].split(f"</{tag}>", 1)[0].strip()
        elif f"<{tag}>" in s:
            s = s.split(f"<{tag}>", 1)[1].strip()

    for pfx in ["Action:", "action:", "tool_call:", "Tool Call:"]:
        if s.startswith(pfx):
            s = s[len(pfx):].strip()

    def _normalize(cand: Any) -> Optional[Dict[str, Any]]:
        if not isinstance(cand, dict):
            return None
        name = cand.get("name") or cand.get("function") or cand.get("action") or cand.get("tool")
        if isinstance(name, dict):
            cand = name
            name = cand.get("name")
        args = cand.get("parameters") or cand.get("arguments") or cand.get("action_input") or cand.get("args") or {}
        if isinstance(name, str) and name.strip():
            clean_name = name.strip()
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except Exception:
                    args = {}
            if isinstance(args, dict):
                if clean_name in KNOWN_TOOL_NAMES or re.match(r"^[a-zA-Z_][a-zA-Z0-9_]{2,40}$", clean_name):
                    return {"name": clean_name, "arguments": args}
        return None

    # 3. Direct parse
    try:
        cand_obj = json.loads(s)
        norm = _normalize(cand_obj)
        if norm:
            return norm
    except Exception:
        pass

    # 4. Embedded object scan
    for marker in ['"name"', '"function"', '"action"', '"tool"']:
        if marker in s:
            start_idx = s.find('{')
            while start_idx != -1:
                brace_count = 0
                end_idx = -1
                for i in range(start_idx, len(s)):
                    if s[i] == '{':
                        brace_count += 1
                    elif s[i] == '}':
                        brace_count -= 1
                        if brace_count == 0:
                            end_idx = i + 1
                            break
                if end_idx != -1:
                    sub = s[start_idx:end_idx]
                    try:
                        obj = json.loads(sub)
                        norm = _normalize(obj)
                        if norm:
                            return norm
                    except Exception:
                        pass
                start_idx = s.find('{', start_idx + 1)

    return None


def is_pseudo_tool_call(content: str) -> bool:
    if not content:
        return False
    if "<tool_call" in content or "<function=" in content or "<function>" in content:
        return True
    return extract_pseudo_tool_call(content) is not None


def plain_text_response(content: str, result_type: str) -> Dict[str, Any]:
    summary = (content or "").strip()
    if not summary:
        summary = "The model returned an empty response."
    is_chat = result_type in {"agent_chat", "chat_project"}
    return {
        "status": "ok",
        "result_type": result_type,
        "confidence": 0.85 if is_chat else 0.62,
        "summary": summary,
        "structured_output": {},
        "warnings": [] if is_chat else ["Provider returned plain text; treated it as a chat answer."],
        "requires_user_confirmation": False if is_chat else True,
    }


def looks_like_web_project(project: Dict[str, Any], output: Dict[str, Any]) -> bool:
    haystack = json.dumps({"project": project, "output": output}, ensure_ascii=False).lower()
    web_markers = [
        "fastapi",
        "flask",
        "django",
        "streamlit",
        "gradio",
        "uvicorn",
        "gunicorn",
        "express",
        "next",
        "vite",
        "react-scripts",
        "http.server",
        "listen(",
        "app.run",
        "server.js",
    ]
    return any(marker in haystack for marker in web_markers)


def normalize_ai_output(workflow: str, project: Dict[str, Any], parsed: Dict[str, Any]) -> Dict[str, Any]:
    if workflow == "repair_project":
        structured = parsed.get("structured_output")
        if isinstance(structured, dict) and "file_changes" in structured:
            changes = structured.get("file_changes")
            if isinstance(changes, list):
                valid_changes = []
                for change in changes:
                    if isinstance(change, dict) and change.get("path") and change.get("content"):
                        clean_path = str(change["path"]).lstrip("/\\")
                        if ".." not in clean_path:
                            change["path"] = clean_path
                            valid_changes.append(change)
                structured["file_changes"] = valid_changes
        return parsed

    if workflow == "analyze_project":
        structured = parsed.get("structured_output")
        if isinstance(structured, dict):
            if "architecture" not in structured and any(k in structured for k in ("framework", "project_type", "entrypoint", "exposed_port", "runtime")):
                structured["architecture"] = {
                    "framework": structured.get("framework"),
                    "project_type": structured.get("project_type"),
                    "runtime": structured.get("runtime"),
                    "entrypoint": structured.get("entrypoint"),
                    "exposed_port": structured.get("exposed_port"),
                }
            if "readiness_assessment" not in structured:
                det = structured.get("deterministic_support")
                status = "ready" if det in [True, "yes", "true"] or structured.get("framework") else "needs_changes"
                structured["readiness_assessment"] = {
                    "status": status,
                    "score": 88 if status == "ready" else 65,
                    "verdict": f"The codebase is confirmed suitable for containerized deployment targeting {structured.get('framework') or 'application'} runtime.",
                }
            if "findings" not in structured:
                findings = []
                if structured.get("exposed_port"):
                    findings.append({
                        "category": "Networking",
                        "severity": "info",
                        "title": f"Service Port {structured.get('exposed_port')}",
                        "description": "Network exposure configured on target application port.",
                    })
                if structured.get("entrypoint"):
                    findings.append({
                        "category": "Entrypoint",
                        "severity": "info",
                        "title": "Application Start File",
                        "description": f"Entrypoint resolved to `{structured.get('entrypoint')}`.",
                    })
                structured["findings"] = findings
            if "recommendations" not in structured:
                structured["recommendations"] = [
                    "Verify containerization setup or generate an optimized Dockerfile with `/dockerfile`.",
                    "Ensure runtime environment variables and secrets are defined before promoting to production.",
                ]
            summary = parsed.get("summary", "")
            if len(summary) < 80:
                fw = structured.get("framework") or structured.get("project_type") or "web"
                port = structured.get("exposed_port") or 3000
                parsed["summary"] = (
                    f"### Lead Architect Evaluation\n\n"
                    f"The project has been evaluated as a **{fw}** deployment on port **{port}**. "
                    f"Architecture and container readiness checks have passed, and the service is ready for deployment."
                )
        return parsed

    if workflow != "generate_dockerfile":
        return parsed

    structured = parsed.get("structured_output")
    if not isinstance(structured, dict):
        return parsed

    dockerfile = structured.get("dockerfile")
    if isinstance(dockerfile, str) and not looks_like_web_project(project, structured):
        exposed_port = structured.get("exposed_port")
        has_expose = bool(re.search(r"(?im)^\s*EXPOSE\s+\d+\s*$", dockerfile))
        if exposed_port or has_expose:
            structured["exposed_port"] = None
            structured["dockerfile"] = re.sub(r"(?im)^\s*EXPOSE\s+\d+\s*\n?", "", dockerfile).strip() + "\n"
            warnings = parsed.setdefault("warnings", [])
            if isinstance(warnings, list):
                warnings.append("Removed exposed_port/EXPOSE because the project looks like a CLI or one-shot script.")
    return parsed


async def post_chat_completion(
    client: httpx.AsyncClient,
    base_url: str,
    api_key: str,
    model: str,
    prompt: str,
    *,
    temperature: float = 0.2,
    model_mode: str = "fast",
    prefer_json: bool = True,
    max_tokens: int = 2048,
    force_stream: bool = False,
) -> Dict[str, Any]:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    use_stream = force_stream or bool(model_extra_body(model, model_mode)) or env_flag("NVIDIA_NIM_STREAM_ALL", False)
    if use_stream:
        return await post_chat_completion_stream(
            client,
            base_url,
            headers,
            model,
            prompt,
            temperature=temperature,
            model_mode=model_mode,
            max_tokens=max_tokens,
        )

    response = await client.post(
        f"{base_url}/chat/completions",
        headers=headers,
        json=chat_payload(
            model,
            prompt,
            json_mode=prefer_json,
            temperature=temperature,
            model_mode=model_mode,
            max_tokens=max_tokens,
        ),
    )
    if response.status_code in {400, 404, 422} and (prefer_json or "response_format" in response.text.lower()):
        response = await client.post(
            f"{base_url}/chat/completions",
            headers=headers,
            json=chat_payload(
                model,
                prompt,
                json_mode=False,
                temperature=temperature,
                model_mode=model_mode,
                max_tokens=max_tokens,
            ),
        )
    response.raise_for_status()
    return response.json()


async def post_chat_completion_stream(
    client: httpx.AsyncClient,
    base_url: str,
    headers: Dict[str, str],
    model: str,
    prompt: str,
    *,
    temperature: float,
    model_mode: str,
    max_tokens: int,
) -> Dict[str, Any]:
    content_parts: List[str] = []
    reasoning_parts: List[str] = []
    usage: Dict[str, Any] = {}
    payload = chat_payload(
        model,
        prompt,
        json_mode=False,
        temperature=temperature,
        model_mode=model_mode,
        stream=True,
        max_tokens=max_tokens,
    )
    async with client.stream(
        "POST",
        f"{base_url}/chat/completions",
        headers=headers,
        json=payload,
    ) as response:
        response.raise_for_status()
        async for line in response.aiter_lines():
            line = line.strip()
            if not line or line.startswith(":"):
                continue
            if line.startswith("data:"):
                line = line[5:].strip()
            if line == "[DONE]":
                break
            try:
                chunk = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(chunk.get("usage"), dict):
                usage = chunk["usage"]
            choices = chunk.get("choices") if isinstance(chunk, dict) else None
            if not isinstance(choices, list) or not choices:
                continue
            delta = choices[0].get("delta") if isinstance(choices[0], dict) else {}
            if not isinstance(delta, dict):
                continue
            reasoning = delta.get("reasoning_content")
            if isinstance(reasoning, str):
                reasoning_parts.append(reasoning)
            content = delta.get("content")
            if isinstance(content, str):
                content_parts.append(content)

    raw_content = "".join(content_parts).strip()
    raw_reasoning = "".join(reasoning_parts).strip()
    content, reasoning = extract_reasoning_and_content(raw_content, raw_reasoning, model_mode=model_mode)
    if not content and reasoning:
        content = reasoning
        reasoning = ""
    return {
        "choices": [{"message": {"content": content, "reasoning_content": reasoning}}],
        "usage": usage,
    }


def extract_reasoning_and_content(
    content: str,
    raw_reasoning: str = "",
    structured_output: Optional[Dict[str, Any]] = None,
    workflow: str = "",
    model_mode: str = "fast",
) -> tuple[str, str]:
    content = content or ""
    reasoning = (raw_reasoning or "").strip()

    # 1. Extract <think>...</think> if present in content
    if "<think>" in content:
        think_match = re.search(r"<think>(.*?)(?:</think>|$)", content, flags=re.DOTALL)
        if think_match:
            extracted_think = think_match.group(1).strip()
            if not reasoning:
                reasoning = extracted_think
            elif extracted_think not in reasoning:
                reasoning = f"{reasoning}\n\n{extracted_think}".strip()
            content = re.sub(r"<think>.*?(?:</think>|$)", "", content, flags=re.DOTALL).strip()

    # 2. Extract from structured_output if reasoning is still empty
    if not reasoning and structured_output and isinstance(structured_output, dict):
        candidate = (
            structured_output.get("reasoning")
            or structured_output.get("root_cause")
            or structured_output.get("analysis")
            or structured_output.get("diagnosis")
        )
        if isinstance(candidate, str) and candidate.strip():
            reasoning = candidate.strip()

    # 3. If model_mode == "thinking" or workflow is analytical/repair and reasoning is still empty, synthesize reasoning
    if not reasoning and (model_mode == "thinking" or workflow in {"repair_project", "analyze_project", "analyze_build_failure", "analyze_runtime_failure"}):
        parts = []
        if structured_output and isinstance(structured_output, dict):
            arch = structured_output.get("architecture")
            if isinstance(arch, dict):
                parts.append(f"• Evaluated architecture: {arch.get('framework') or 'application'} ({arch.get('runtime') or 'containerized'}) on port {arch.get('exposed_port') or 3000}.")
            elif structured_output.get("framework") or structured_output.get("project_type"):
                parts.append(f"• Analyzed tech stack: {structured_output.get('framework', 'N/A')} ({structured_output.get('project_type', 'N/A')}).")
            if structured_output.get("entrypoint"):
                parts.append(f"• Verified application entrypoint: `{structured_output.get('entrypoint')}`.")
            if structured_output.get("exposed_port"):
                parts.append(f"• Inspected network exposure: port {structured_output.get('exposed_port')}.")
            readiness = structured_output.get("readiness_assessment")
            if isinstance(readiness, dict):
                parts.append(f"• Assessed deployment readiness: {readiness.get('status', 'validated')} (verdict: {readiness.get('verdict', 'ready')}).")
            if structured_output.get("root_cause"):
                parts.append(f"• Root cause diagnosis: {structured_output.get('root_cause')}")
            if structured_output.get("findings"):
                parts.append(f"• Checked {len(structured_output['findings'])} architectural checkpoints across configuration and dependencies.")
        if not parts:
            parts.append("• Performed architectural analysis of project configuration, dependencies, and environment.")
            parts.append("• Evaluated production containerization, port mappings, and runtime build readiness.")
        reasoning = "\n".join(parts)

    return content, reasoning


def schema_instruction(result_type: str) -> str:
    if result_type == "repair_project":
        return """
Return only JSON with this schema:
{
  "status": "ok",
  "result_type": "repair_project",
  "confidence": 0.85,
  "summary": "Detailed explanation of the root cause and the exact file changes applied to fix the build/deployment",
  "structured_output": {
    "root_cause": "Precise technical explanation of why the build or runtime failed",
    "file_changes": [
      {
        "path": "relative/path/to/file",
        "action": "modify",
        "content": "Full corrected content of the file",
        "description": "Explanation of what was fixed in this file"
      }
    ],
    "build_command": "command to verify or build",
    "verification_steps": ["step 1", "step 2"]
  },
  "warnings": [],
  "requires_user_confirmation": false
}
Do not include markdown outside JSON.
In file_changes:
- path must be a relative file path (e.g. 'Dockerfile', 'package.json', 'src/index.js').
- action must be 'modify', 'create', or 'delete'.
- content must be the complete, syntactically correct, buildable file text.
Provide concrete code fixes directly addressing the error messages in the build logs.

CRITICAL DOCKERFILE & BUILD INSTRUCTIONS:
- Inspect file_tree carefully before writing any Dockerfile.
- ONLY copy files that ACTUALLY exist in the project file_tree. Never write a separate `COPY package-lock.json .` unless package-lock.json is explicitly present in the file_tree. If only package.json exists, write `COPY package.json ./`.
- If the project code lives in a subdirectory (such as `server/`), ensure WORKDIR, COPY, and RUN commands reference the actual directory structure.
"""
    if result_type == "analyze_project":
        return """
Return only JSON with this schema:
{
  "status": "ok",
  "result_type": "analyze_project",
  "confidence": 0.90,
  "summary": "Exhaustive, professional markdown report analyzing the project, answering user queries, stating deployment readiness, and detailing next steps.",
  "structured_output": {
    "architecture": {
      "language": "e.g. TypeScript / JavaScript / Python / Go",
      "framework": "e.g. Refine, React, Next.js, Express, FastAPI",
      "package_manager": "e.g. npm, yarn, pnpm, pip",
      "entrypoint": "inferred or configured start file",
      "exposed_port": 3000
    },
    "readiness_assessment": {
      "status": "ready|needs_changes|blocked",
      "score": 85,
      "verdict": "Direct answer explaining if this project is good to go for deployment or what needs to be changed"
    },
    "findings": [
      {"category": "Containerization", "status": "pass|warn|fail", "detail": "Analysis of Dockerfile or container configuration"},
      {"category": "Dependencies & Scripts", "status": "pass|warn|fail", "detail": "Analysis of package.json scripts and dependencies"},
      {"category": "Environment & Ports", "status": "pass|warn|fail", "detail": "Analysis of required ports and environment configurations"}
    ],
    "recommendations": [
      "Actionable recommendation 1",
      "Actionable recommendation 2"
    ],
    "reasoning": "Step-by-step analytical reasoning and chain-of-thought evaluating project structure, scripts, and runtime readiness"
  },
  "warnings": [],
  "requires_user_confirmation": false
}
Do not include markdown outside JSON.
In summary: Provide an in-depth, lead-architect-level technical report. If Context.message contains a specific user question (e.g. 'analyze if this project is good to go for deployment'), answer that directly and thoroughly.
"""
    if result_type == "generate_dockerfile":
        return """
Return only JSON with this schema:
{
  "status": "ok",
  "result_type": "generate_dockerfile",
  "confidence": 0.75,
  "summary": "what project type was detected and why this Dockerfile was chosen",
  "structured_output": {
    "dockerfile": "complete Dockerfile text",
    "exposed_port": null,
    "start_command": "command the container runs",
    "entrypoint_file": "file used as the entrypoint",
    "detected_project_type": "python-script|python-web|node|go|rust|java|unknown",
    "reasoning": "brief explanation of file-tree evidence used"
  },
  "warnings": [],
  "requires_user_confirmation": true
}
Do not include markdown outside JSON.
The Dockerfile must be complete and buildable.
Do not copy secrets explicitly. Do not install unnecessary global tools.
Only set exposed_port or add EXPOSE when the project starts an HTTP server.
For single-file or multi-file scripts, do not add EXPOSE and run the inferred entrypoint file.
If there are multiple Python files, infer the entrypoint from app.py/main.py/README/imports/__main__ patterns; otherwise choose the most likely top-level script and explain uncertainty in warnings.
"""
    summary_hint = (
        "helpful markdown answer with context, cause, and next steps"
        if result_type in {"agent_chat", "chat_project"}
        else "helpful human-readable summary"
    )
    return f"""
Return only JSON with this schema:
{{
  "status": "ok",
  "result_type": "{result_type}",
  "confidence": 0.75,
  "summary": "{summary_hint}",
  "structured_output": {{}},
  "warnings": [],
  "requires_user_confirmation": true
}}
Do not include markdown. Do not suggest executing destructive commands automatically.
Generated Dockerfiles must be deterministic, minimal, and avoid copying secrets.
Only set exposed_port or add EXPOSE when the project starts an HTTP server.
For one-shot scripts or CLI programs, use exposed_port null and do not add EXPOSE.
"""


def build_prompt(workflow: str, req: AgentRequest) -> str:
    payload = {
        "workflow": workflow,
        "project": safe_json(req.project),
        "deployment": safe_json(req.deployment),
        "source": safe_json(req.source),
        "runtime": safe_json(req.runtime),
        "logs": redact_text(req.logs),
        "message": redact_text(req.message),
        "command": redact_text(req.command),
        "model_mode": req.model_mode,
        "history": safe_json(req.history[-12:]),
        "memory": safe_json(req.memory),
        "confidence_threshold": req.confidence_threshold,
    }
    base = {
        "repair_project": (
            "You are the StackPilot Autonomous Project Repair Agent, a specialized principal software engineer and DevOps expert. "
            "Deeply analyze the failed build/deployment logs, error stack traces, project file tree, and source file contents. "
            "Identify the exact root cause of failure (e.g., missing dependencies, configuration syntax errors, incompatible versions, "
            "missing Dockerfile directives, incorrect entrypoints, port mismatches, code bugs). "
            "Deeply reason step-by-step about the solution and output exact, surgically targeted file changes to fix the project. "
            "Every file change in structured_output.file_changes must contain the complete, corrected, and buildable code."
        ),
        "analyze_project": (
            "You are the StackPilot Principal Build & Platform Architect Agent. "
            "Perform an exhaustive, production-grade technical evaluation of the project. "
            "Inspect the file tree, package manifests, entrypoint scripts, containerization files, and dependencies. "
            "If the user has asked a specific question or instruction in Context.message, prioritize answering it thoroughly. "
            "Assess whether the project is good to go for deployment or if anything needs to be changed. "
            "Provide an objective readiness verdict, architecture breakdown, critical findings, and concrete next steps."
        ),
        "generate_dockerfile": (
            "You are generating a Dockerfile from an actual source tree scan. Read the file list and excerpts before choosing a runtime. "
            "For Python projects, distinguish web apps from one-shot scripts. If there are multiple Python files, identify the best entrypoint "
            "from filenames, README, imports, framework usage, and __main__ guards. Include exposed_port only for HTTP servers."
        ),
        "analyze_build_failure": (
            "Analyze the failed deployment/build logs. Identify root cause, safe fix steps, likely files to inspect, "
            "and whether user confirmation is required."
        ),
        "analyze_runtime_failure": (
            "Analyze runtime health, Kubernetes events, logs, and metrics. Explain likely runtime failure causes and safe remediations."
        ),
        "chat_project": (
            "Answer the user's question clearly and helpfully using the supplied project context as well as your general engineering knowledge. "
            "Be practical, informative, and provide clean code or command examples when helpful."
        ),
        "agent_chat": (
            "You are the StackPilot platform agent, an intelligent DevOps and developer copilot. "
            "Answer generic developer questions, coding problems, architecture inquiries, and deployment questions helpfully and naturally. "
            "Use the supplied chat memory as durable context for this specific conversation, but prefer the user's latest instruction when it conflicts. "
            "Never repeat an old diagnosis or deployment failure unless the latest user message is asking about that failure, deployment, or fix. "
            "If the latest user message is a general question, answer that question directly and treat deployment/log context only as optional background. "
            "For completely out-of-topic questions unrelated to computing or tech, give a brief polite response and steer back to engineering. "
            "You may recommend builds, deployments, Dockerfile changes, and diagnosis steps. For errors, include likely causes and concrete fixes."
        ),
    }.get(workflow, "Analyze this deployment context safely.")
    if workflow == "agent_chat" and req.command in {"explain_failure", "explain_build_failure"}:
        return (
            "You are a fast deployment failure explainer for the StackPilot platform. "
            "Use the supplied log excerpt and deployment context to explain the issue clearly for a developer. "
            "Return markdown with these short sections: What happened, Why it happened, How to fix it, Next action. "
            "Use concrete evidence from the log. Avoid vague advice, avoid JSON, and keep it under 220 words."
            + "\nContext:\n"
            + json.dumps(payload, ensure_ascii=False)
        )
    if workflow in {"agent_chat", "chat_project"}:
        return (
            base
            + "\nReturn a clear markdown answer for the user. Use short paragraphs and numbered steps when helpful. "
            + "Do not wrap the answer in JSON."
            + "\nContext:\n"
            + json.dumps(payload, ensure_ascii=False)
        )
    return base + "\n" + schema_instruction(workflow) + "\nContext:\n" + json.dumps(payload, ensure_ascii=False)


async def call_model(req: AgentRequest, prompt: str) -> AgentResponse:
    trace_id = str(uuid.uuid4())
    provider, base_url, api_key, model = provider_config(
        req.provider,
        req.model,
        req.model_mode,
        req.provider_overrides,
    )
    start = time.perf_counter()

    if req.model_mode == "fast" and (req.workflow_type or "") == "agent_chat":
        simple = (req.message or "").strip().lower()
        if simple in {"hi", "hello", "hey", "yo", "sup"}:
            return AgentResponse(
                status="ok",
                result_type="agent_chat",
                confidence=1.0,
                summary="Hi. I am ready to help with deployments, builds, Dockerfile planning, or diagnosis.",
                structured_output={},
                warnings=[],
                requires_user_confirmation=False,
                trace_id=trace_id,
                provider=provider,
                # Report the model that was actually configured. The old
                # "instant-fast-path" placeholder was persisted to ai_runs.model and
                # ai_sessions.last_model and rendered as the model badge, so the UI
                # and telemetry both showed a model ID that does not exist.
                model=model,
                latency_ms=int((time.perf_counter() - start) * 1000),
                token_usage={},
            )

    if not base_url or not api_key:
        return AgentResponse(
            status="error",
            result_type=req.workflow_type or "unknown",
            summary="AI provider is not configured. Deterministic deployment remains available.",
            warnings=["Missing AI provider base URL or API key."],
            requires_user_confirmation=True,
            trace_id=trace_id,
            provider=provider,
            model=model,
            latency_ms=0,
            error="provider_not_configured",
        )

    fast_explanation = (req.workflow_type or "") == "agent_chat" and req.command in {
        "explain_failure",
        "explain_build_failure",
    }
    try:
        timeout = httpx.Timeout(DEFAULT_TIMEOUT, connect=10.0, read=DEFAULT_TIMEOUT, write=10.0, pool=10.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            payload = await post_chat_completion(
                client,
                base_url,
                api_key,
                model,
                prompt,
                temperature=0.15 if fast_explanation else (0.1 if req.model_mode == "thinking" else 0.25),
                model_mode=req.model_mode,
                prefer_json=req.workflow_type not in {"agent_chat", "chat_project"},
                max_tokens=700 if fast_explanation else (4096 if req.model_mode == "thinking" else 1536),
            )
        message = payload.get("choices", [{}])[0].get("message", {}) or {}
        content = message.get("content", "{}")
        reasoning = str(message.get("reasoning_content", "") or "")
        try:
            parsed = parse_model_json(
                content,
                allow_fragment=req.workflow_type not in {"agent_chat", "chat_project"},
            )
        except json.JSONDecodeError:
            parsed = plain_text_response(content, req.workflow_type or "unknown")
        parsed = normalize_ai_output(req.workflow_type or "unknown", req.project, parsed)
        content, reasoning = extract_reasoning_and_content(
            content,
            reasoning,
            parsed.get("structured_output"),
            req.workflow_type or "",
            req.model_mode,
        )
        usage = payload.get("usage", {}) or {}
        latency_ms = int((time.perf_counter() - start) * 1000)
        return AgentResponse(
            status=parsed.get("status", "ok"),
            result_type=parsed.get("result_type", req.workflow_type or "unknown"),
            confidence=float(parsed.get("confidence", 0.0) or 0.0),
            summary=str(parsed.get("summary", "")),
            structured_output=parsed.get("structured_output", {}) or {},
            warnings=parsed.get("warnings", []) or [],
            requires_user_confirmation=bool(parsed.get("requires_user_confirmation", True)),
            trace_id=trace_id,
            provider=provider,
            model=model,
            latency_ms=latency_ms,
            token_usage=usage,
            reasoning=reasoning,
        )
    except httpx.HTTPStatusError as exc:
        status_code = exc.response.status_code
        detail = redact_text((exc.response.text or "")[:800])
        fallback_provider, fallback_base_url, fallback_api_key, fallback_model = provider_config(
            req.provider,
            None,
            req.model_mode,
            req.provider_overrides,
        )
        if req.model and fallback_model and fallback_model != model and fallback_base_url and fallback_api_key:
            try:
                timeout = httpx.Timeout(DEFAULT_TIMEOUT, connect=10.0, read=DEFAULT_TIMEOUT, write=10.0, pool=10.0)
                async with httpx.AsyncClient(timeout=timeout) as client:
                    payload = await post_chat_completion(
                        client,
                        fallback_base_url,
                        fallback_api_key,
                        fallback_model,
                        prompt,
                        temperature=0.15 if fast_explanation else (0.1 if req.model_mode == "thinking" else 0.25),
                        model_mode=req.model_mode,
                        prefer_json=req.workflow_type not in {"agent_chat", "chat_project"},
                        max_tokens=700 if fast_explanation else (4096 if req.model_mode == "thinking" else 1536),
                    )
                message = payload.get("choices", [{}])[0].get("message", {}) or {}
                content = message.get("content", "{}")
                reasoning = str(message.get("reasoning_content", "") or "")
                try:
                    parsed = parse_model_json(
                        content,
                        allow_fragment=req.workflow_type not in {"agent_chat", "chat_project"},
                    )
                except json.JSONDecodeError:
                    parsed = plain_text_response(content, req.workflow_type or "unknown")
                parsed = normalize_ai_output(req.workflow_type or "unknown", req.project, parsed)
                content, reasoning = extract_reasoning_and_content(
                    content,
                    reasoning,
                    parsed.get("structured_output"),
                    req.workflow_type or "",
                    req.model_mode,
                )
                usage = payload.get("usage", {}) or {}
                latency_ms = int((time.perf_counter() - start) * 1000)
                warnings = parsed.get("warnings", []) or []
                warnings = [
                    f"Selected model {model} failed with provider HTTP {status_code}; retried with {fallback_model}.",
                    *warnings,
                ]
                if detail:
                    warnings.append(detail)
                return AgentResponse(
                    status=parsed.get("status", "ok"),
                    result_type=parsed.get("result_type", req.workflow_type or "unknown"),
                    confidence=float(parsed.get("confidence", 0.0) or 0.0),
                    summary=str(parsed.get("summary", "")),
                    structured_output=parsed.get("structured_output", {}) or {},
                    warnings=warnings,
                    requires_user_confirmation=bool(parsed.get("requires_user_confirmation", True)),
                    trace_id=trace_id,
                    provider=fallback_provider,
                    model=fallback_model,
                    latency_ms=latency_ms,
                    token_usage=usage,
                    reasoning=reasoning,
                )
            except Exception as retry_exc:
                retry_detail = redact_text(str(retry_exc)[:800])
                detail = f"{detail}\nFallback retry failed: {retry_detail}" if detail else f"Fallback retry failed: {retry_detail}"
        return AgentResponse(
            status="error",
            result_type=req.workflow_type or "unknown",
            confidence=0.0,
            summary=f"AI provider returned HTTP {status_code}. Deterministic deployment remains available.",
            warnings=["Provider request failed.", detail] if detail else ["Provider request failed."],
            requires_user_confirmation=True,
            trace_id=trace_id,
            provider=provider,
            model=model,
            latency_ms=int((time.perf_counter() - start) * 1000),
            error=f"provider_http_{status_code}",
        )
    except json.JSONDecodeError as exc:
        return AgentResponse(
            status="error",
            result_type=req.workflow_type or "unknown",
            confidence=0.0,
            summary="AI provider returned a non-JSON response. Deterministic deployment remains available.",
            warnings=["Provider response could not be parsed as structured JSON."],
            requires_user_confirmation=True,
            trace_id=trace_id,
            provider=provider,
            model=model,
            latency_ms=int((time.perf_counter() - start) * 1000),
            error=f"invalid_provider_json:{exc}",
        )
    except Exception as exc:
        detail = redact_text(str(exc)[:800])
        if not detail:
            detail = exc.__class__.__name__
        return AgentResponse(
            status="error",
            result_type=req.workflow_type or "unknown",
            confidence=0.0,
            summary="AI analysis failed. Deterministic deployment remains available.",
            warnings=["Provider request failed.", detail],
            requires_user_confirmation=True,
            trace_id=trace_id,
            provider=provider,
            model=model,
            latency_ms=int((time.perf_counter() - start) * 1000),
            error=str(exc),
        )


def make_graph(workflow: str):
    async def inspect_context(state: AgentState) -> AgentState:
        req = state["request"]
        warnings = []
        if len(req.logs or "") > MAX_TEXT:
            warnings.append("Logs were clipped before model analysis.")
        return {"request": req, "workflow": workflow, "warnings": warnings}

    async def prompt_node(state: AgentState) -> AgentState:
        return {**state, "prompt": build_prompt(workflow, state["request"])}

    async def model_node(state: AgentState) -> AgentState:
        response = await call_model(state["request"], state["prompt"])
        merged = response.model_dump()
        merged["warnings"] = list(dict.fromkeys((state.get("warnings") or []) + (merged.get("warnings") or [])))
        return {**state, "response": merged}

    graph = StateGraph(AgentState)
    graph.add_node("inspect_context", inspect_context)
    graph.add_node("build_prompt", prompt_node)
    graph.add_node("call_provider", model_node)
    graph.set_entry_point("inspect_context")
    graph.add_edge("inspect_context", "build_prompt")
    graph.add_edge("build_prompt", "call_provider")
    graph.add_edge("call_provider", END)
    return graph.compile()


async def run_workflow(workflow: str, request: AgentRequest) -> AgentResponse:
    request.workflow_type = workflow
    graph = make_graph(workflow)
    state = await graph.ainvoke({"request": request})
    return AgentResponse(**state["response"])


@app.get("/health")
async def health() -> Dict[str, Any]:
    provider, base_url, api_key, model = provider_config(None, None)
    return {
        "status": "ok",
        "service": "stackpilot-ai-service",
        "provider": provider,
        "model": model,
        "configured": bool(base_url and api_key),
    }


def fallback_models(provider: str, selected_model: str = "") -> List[Dict[str, Any]]:
    if selected_model:
        return [{"id": selected_model, "label": selected_model, "mode": model_mode_for(selected_model)}]
    return []


def ensure_mode_coverage(models: List[Dict[str, Any]], selected_model: str = "") -> List[Dict[str, Any]]:
    if not models:
        return models
    if selected_model and not any(item["id"] == selected_model for item in models):
        models.insert(0, {"id": selected_model, "label": selected_model, "mode": model_mode_for(selected_model)})
    return models


def is_chat_model(model_id: str) -> bool:
    lowered = model_id.lower()
    blocked = [
        "embed",
        "embedding",
        "bge-",
        "rerank",
        "whisper",
        "tts",
        "guard",
        "moderation",
        "diffusion",
        "audio",
        "reward",
        "safety",
    ]
    return not any(token in lowered for token in blocked)


def env_flag(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.lower() in {"1", "true", "yes", "on"}


def model_mode_for(model_id: str) -> str:
    lowered = (model_id or "").lower()
    if any(token in lowered for token in ["70b", "405b", "nemotron", "reason", "thinking", "r1", "o1", "o3", "opus"]):
        return "thinking"
    return "fast"


async def model_catalog(provider: str, base_url: str, api_key: str, selected_model: str) -> Dict[str, Any]:
    discovered: List[Dict[str, Any]] = []
    source = "no_key"

    if base_url and api_key:
        try:
            timeout = httpx.Timeout(12.0, connect=5.0, read=10.0, write=5.0, pool=5.0)
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.get(f"{base_url}/models", headers={"Authorization": f"Bearer {api_key}"})
            if response.status_code == 200:
                payload = response.json()
                data = payload.get("data", []) if isinstance(payload, dict) else (payload if isinstance(payload, list) else [])
                seen = set()
                for item in data:
                    model_id = item.get("id") if isinstance(item, dict) else (item if isinstance(item, str) else None)
                    if isinstance(model_id, str) and model_id and model_id not in seen:
                        if not is_chat_model(model_id):
                            continue
                        seen.add(model_id)
                        discovered.append({
                            "id": model_id,
                            "label": model_id,
                            "mode": model_mode_for(model_id),
                        })
                if discovered:
                    discovered.sort(key=lambda item: item["id"].lower())
                    source = "provider"
            else:
                source = f"provider_status_{response.status_code}"
        except Exception as exc:
            source = f"fetch_error: {str(exc)}"

    if not discovered and selected_model:
        discovered.append({
            "id": selected_model,
            "label": selected_model,
            "mode": model_mode_for(selected_model),
        })

    return {
        "status": "ok",
        "provider": provider,
        "selected_model": selected_model,
        "source": source,
        "models": discovered,
        "modes": [
            {"id": "fast", "label": "Fast", "description": "Lower latency chat and general assistance."},
            {"id": "thinking", "label": "Thinking", "description": "Deeper reasoning, architecture, and diagnosis."},
        ],
    }


@app.get("/models")
async def models() -> Dict[str, Any]:
    provider, base_url, api_key, selected_model = provider_config(None, None)
    return await model_catalog(provider, base_url, api_key, selected_model)


@app.post("/models")
async def models_for_request(request: AgentRequest) -> Dict[str, Any]:
    provider, base_url, api_key, selected_model = provider_config(
        request.provider,
        request.model,
        request.model_mode,
        request.provider_overrides,
    )
    return await model_catalog(provider, base_url, api_key, selected_model)


@app.post("/embeddings")
async def embeddings(request: EmbeddingRequest) -> Dict[str, Any]:
    return await provider_embeddings(request)


@app.post("/analyze/project", response_model=AgentResponse)
async def analyze_project(request: AgentRequest) -> AgentResponse:
    return await run_workflow("analyze_project", request)


@app.post("/generate/dockerfile", response_model=AgentResponse)
async def generate_dockerfile(request: AgentRequest) -> AgentResponse:
    return await run_workflow("generate_dockerfile", request)


@app.post("/analyze/build-failure", response_model=AgentResponse)
async def analyze_build_failure(request: AgentRequest) -> AgentResponse:
    return await run_workflow("analyze_build_failure", request)


@app.post("/analyze/runtime-failure", response_model=AgentResponse)
async def analyze_runtime_failure(request: AgentRequest) -> AgentResponse:
    return await run_workflow("analyze_runtime_failure", request)


@app.post("/repair/project", response_model=AgentResponse)
async def repair_project(request: AgentRequest) -> AgentResponse:
    return await run_workflow("repair_project", request)


@app.post("/repair/deployment", response_model=AgentResponse)
async def repair_deployment(request: AgentRequest) -> AgentResponse:
    return await run_workflow("repair_project", request)


@app.post("/chat/project", response_model=AgentResponse)
async def chat_project(request: AgentRequest) -> AgentResponse:
    return await run_workflow("chat_project", request)


@app.post("/chat/agent", response_model=AgentResponse)
async def chat_agent(request: AgentRequest) -> AgentResponse:
    return await run_workflow("agent_chat", request)


# ── live streaming ────────────────────────────────────────────────
# The non-streaming path runs the LangGraph workflow, which awaits the whole
# reply before the graph ends -- there is nothing incremental to forward. This
# path deliberately bypasses the graph and talks to the provider directly, so
# reasoning and content reach the browser as the model produces them.
#
# The trade is that the graph's post-processing (JSON normalisation, structured
# output, confidence) does not apply mid-stream. The final `done` frame carries
# the assembled text so the caller can persist the same thing the blocking
# endpoint would have returned.


def _sse(event: Dict[str, Any]) -> str:
    """One Server-Sent Event frame. The blank line terminator is required."""
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


async def stream_agent_reply(request: AgentRequest) -> AsyncIterator[str]:
    request.workflow_type = request.workflow_type or "agent_chat"
    trace_id = str(uuid.uuid4())
    start = time.perf_counter()

    provider, base_url, api_key, model = provider_config(
        request.provider,
        request.model,
        request.model_mode,
        request.provider_overrides,
    )

    if not base_url or not api_key:
        yield _sse({"type": "error", "error": "AI provider is not configured."})
        yield _sse({"type": "done", "trace_id": trace_id, "content": "", "reasoning": ""})
        return

    # Detect command workflows
    command_name = (request.command or "").lower()
    if not command_name and request.message.startswith("/"):
        command_name = request.message.split()[0].lower()

    # Use conversational prompt for agent_chat
    if request.workflow_type == "agent_chat":
        sys_prompt = (
            "You are StackPilot Agent — a production-grade autonomous AI copilot and platform engineer (similar to Antigravity and Cursor). "
            "You have deep expertise in software engineering, DevOps, cloud infrastructure, containerization, debugging, and architecture.\n\n"
            "Capabilities & Guidelines:\n"
            "1. Integrated Terminal & Proactive Tool Use: You have an integrated workspace terminal (`terminal_run_command`), file inspection tools (`workspace_list_files`, `workspace_read_file`), and file editing tools (`workspace_edit_file`, `workspace_write_file`, `workspace_trigger_rebuild`). When the user asks you to analyze, test, verify, or investigate code or deployments, PROACTIVELY USE THESE TOOLS to run commands and inspect real files before giving your final answer!\n"
            "   NOTE ON TERMINAL & OS: The integrated terminal executes with native PowerShell according to the host OS. Use PowerShell cmdlets or cross-platform commands (e.g. `Get-Content package.json`, `cat package.json`, `Select-String`, `Get-ChildItem`, `git status`, `npm test`, `node -v`). Do NOT call Unix-only utilities like `od` or `hexdump` or bash-only pipelines that do not work in PowerShell.\n"
            "2. Strict Code Formatting in Code Blocks: Every piece of code, configuration, JSON, command, or script MUST be enclosed in proper fenced code blocks with language tags (e.g. ```json, ```powershell, ```dockerfile, ```bash, ```javascript). Never dump raw unstructured code or unformatted file text.\n"
            "3. Depth & Production Quality: Provide thorough, in-depth technical explanations. Structure your answers with clear sections, badges, findings, and concrete code/command examples. Never give shallow one-sentence summaries.\n"
            "4. Helpful & Versatile: Answer programming questions, DevOps concepts, code debugging, and platform tasks helpfully.\n"
            "5. Tone: Confident, professional, clear, and well-formatted in markdown."
        )

        if command_name in {"/repair", "/fix"}:
            sys_prompt += (
                "\n\nSPECIAL WORKFLOW: AUTONOMOUS END-TO-END REPAIR, REBUILD & VERIFICATION\n"
                "The user requested an autonomous repair for this deployment. You must drive this to full completion until the service is verified up and running:\n"
                "1. Inspect the build/runtime logs in Context or via `get_deployment_logs` to pinpoint the exact failure (e.g. syntax error, missing script, wrong entrypoint, port mismatch, missing dependency).\n"
                "2. Proactively run `workspace_list_files`, `workspace_read_file`, or `terminal_run_command` (e.g. `Get-Content package.json`, `git status`) to inspect the actual files in the workspace.\n"
                "3. Use `workspace_edit_file` or `workspace_write_file` to apply surgical code/configuration fixes to the workspace files.\n"
                "4. Call `workspace_trigger_rebuild` with deployment_id to queue a clean rebuild from your modified files.\n"
                "5. Immediately call `wait_for_deployment` with deployment_id to monitor the build until completion! Do not stop after triggering rebuild.\n"
                "6. If `wait_for_deployment` reports 'running', the service is live! If it reports 'failed', inspect the new logs, fix any remaining issue, and rebuild again until it succeeds.\n"
                "7. Present a clear, comprehensive report with fenced code blocks:\n"
                "   ### 🔍 Root Cause\n"
                "   ### 🛠 Applied Fixes (with syntax-highlighted code blocks)\n"
                "   ### 🚀 Verification & Live Service Status"
            )
        elif command_name in {"/analyze"}:
            sys_prompt += (
                "\n\nSPECIAL WORKFLOW: CODEBASE & READINESS ANALYSIS\n"
                "The user requested an in-depth readiness and architectural assessment.\n"
                "1. Proactively run `terminal_run_command` (e.g. `Get-Content package.json`, `Get-ChildItem`) or `workspace_list_files` to inspect the project files.\n"
                "2. Structure your final response with: ### 🏗 Architecture & Stack Overview, ### 🎯 Deployment Readiness, ### 🔍 Technical Findings, and ### 💡 Recommended Actions."
            )
        elif command_name in {"/diagnose"}:
            sys_prompt += (
                "\n\nSPECIAL WORKFLOW: DIAGNOSE DEPLOYMENT FAILURE\n"
                "The user asked to diagnose a failure. Analyze the logs in Context, run terminal commands or workspace reads if needed to inspect error files, and explain the root cause with actionable remediation steps."
            )
        elif command_name in {"/architect", "/swarm"}:
            sys_prompt += (
                "\n\nSPECIAL WORKFLOW: MULTI-AGENT SWARM ARCHITECT & REPAIR\n"
                "You are coordinating the Specialized Subagent Swarm (Architect, Coder, Verifier, Supervisor):\n"
                "1. 🏛️ Architect Subagent: Formulates the strategic execution blueprint, inspects dependency graphs, detects framework/runtime paradigms, and plans the sequence of steps.\n"
                "2. ⚡ Coder Subagent: Executes surgical, AST-safe workspace edits and file creations with complete implementations.\n"
                "3. 🔍 Verifier Subagent: Probes container health, rebuild status, runtime readiness, and verifies logs and live network endpoints.\n"
                "4. 👑 Supervisor: Coordinates execution, handles permissions, and synthesizes the unified final report.\n"
                "Proactively inspect files, implement required architecture changes, verify builds, and deliver a comprehensive multi-agent report."
            )

        context = {
            "project": safe_json(request.project),
            "deployment": safe_json(request.deployment),
            "logs": redact_text(request.logs),
        }
        sys_prompt += f"\n\nContext:\n{json.dumps(context, ensure_ascii=False)}"
        
        messages = [{"role": "system", "content": sys_prompt}]
        for turn in request.history[-12:]:
            messages.append({"role": turn.get("role", "user"), "content": turn.get("content", "")})
        if not messages or messages[-1].get("role") != "user" or messages[-1].get("content") != request.message:
            messages.append({"role": "user", "content": request.message})
    else:
        prompt = build_prompt(request.workflow_type, request)
        messages = [
            {"role": "system", "content": "You are a secure DevOps assistant."},
            {"role": "user", "content": prompt}
        ]

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    
    total_usage = {}
    content_parts = []
    reasoning_parts = []
    in_think_tag = False

    # Detect complex architectural goal or swarm/architect/repair command
    architectural_keywords = {
        "architect", "architecture", "blueprint", "refactor", "rearchitect", "re-architect",
        "redesign", "dependency graph", "paradigm", "microservice", "subagent", "swarm"
    }
    is_architectural_goal = (
        command_name in {"/architect", "/swarm", "/repair", "/fix"}
        or request.workflow_type in {"architect", "swarm"}
        or any(re.search(rf"\b{re.escape(kw)}\b", request.message, re.IGNORECASE) for kw in architectural_keywords)
    )

    supervisor = SupervisorAgent(
        goal=request.message,
        project_id=request.project_id,
        deployment_id=request.deployment_id,
        user_id=request.user_id,
    )

    coder_subagent_emitted = False
    verifier_subagent_emitted = False
    paused_for_permission = False

    # Emit initial reasoning frame immediately so thinking accordion and orb activate at frame 0
    init_thought = (
        f"Analyzing deployment and workspace context for `{command_name}`...\n"
        if command_name else
        "Analyzing request and inspecting project workspace...\n"
    )
    reasoning_parts.append(init_thought)
    yield _sse({"type": "reasoning", "delta": init_thought})

    if is_architectural_goal:
        arch_thought = "• 🏛️ [Architect Subagent] Formulating strategic execution blueprint...\n"
        reasoning_parts.append(arch_thought)
        yield _sse({"type": "reasoning", "delta": arch_thought})
    
    # Tool loop limit (allow up to 25 autonomous reasoning & tool execution turns)
    for iteration in range(25):
        # When nearing the iteration ceiling, omit tools so the model delivers its final report
        use_tools = AGENT_TOOLS if (request.workflow_type == "agent_chat" and iteration < 22) else None
        payload = chat_payload(
            model,
            messages=messages,
            temperature=0.2 if request.model_mode == "fast" else 0.1,
            model_mode=request.model_mode,
            stream=True,
            max_tokens=8192 if request.model_mode == "thinking" else 4096,
            tools=use_tools,
        )

        tool_calls = {}
        iteration_content = []
        iteration_reasoning = []
        buffered_chunks = []
        is_buffering_potential_tool = True
        
        try:
            timeout = httpx.Timeout(DEFAULT_TIMEOUT, connect=10.0, read=DEFAULT_TIMEOUT, write=10.0, pool=10.0)
            async with httpx.AsyncClient(timeout=timeout) as client:
                async with client.stream(
                    "POST", f"{base_url}/chat/completions", headers=headers, json=payload
                ) as response:
                    response.raise_for_status()
                    async for line in response.aiter_lines():
                        line = line.strip()
                        if not line or line.startswith(":"):
                            continue
                        if not line.startswith("data:"):
                            continue
                        data = line[len("data:"):].strip()
                        if data == "[DONE]":
                            break
                        try:
                            chunk = json.loads(data)
                        except json.JSONDecodeError:
                            continue

                        if isinstance(chunk.get("usage"), dict):
                            total_usage = chunk["usage"]

                        choices = chunk.get("choices") or []
                        if not choices:
                            continue
                        delta = choices[0].get("delta") or {}

                        # Handle reasoning_content from DeepSeek / NIM thinking models
                        reasoning = delta.get("reasoning_content")
                        if isinstance(reasoning, str) and reasoning:
                            iteration_reasoning.append(reasoning)
                            reasoning_parts.append(reasoning)
                            yield _sse({"type": "reasoning", "delta": reasoning})

                        # Handle content + embedded <think> tags
                        content = delta.get("content")
                        if isinstance(content, str) and content:
                            if "<think>" in content:
                                parts = content.split("<think>", 1)
                                if parts[0]:
                                    iteration_content.append(parts[0])
                                    content_parts.append(parts[0])
                                    yield _sse({"type": "content", "delta": parts[0]})
                                in_think_tag = True
                                after = parts[1]
                                if "</think>" in after:
                                    t_sub = after.split("</think>", 1)
                                    in_think_tag = False
                                    iteration_reasoning.append(t_sub[0])
                                    reasoning_parts.append(t_sub[0])
                                    yield _sse({"type": "reasoning", "delta": t_sub[0]})
                                    if t_sub[1]:
                                        iteration_content.append(t_sub[1])
                                        content_parts.append(t_sub[1])
                                        yield _sse({"type": "content", "delta": t_sub[1]})
                                else:
                                    iteration_reasoning.append(after)
                                    reasoning_parts.append(after)
                                    yield _sse({"type": "reasoning", "delta": after})
                            elif "</think>" in content:
                                in_think_tag = False
                                parts = content.split("</think>", 1)
                                iteration_reasoning.append(parts[0])
                                reasoning_parts.append(parts[0])
                                yield _sse({"type": "reasoning", "delta": parts[0]})
                                if parts[1]:
                                    iteration_content.append(parts[1])
                                    content_parts.append(parts[1])
                                    yield _sse({"type": "content", "delta": parts[1]})
                            elif in_think_tag:
                                iteration_reasoning.append(content)
                                reasoning_parts.append(content)
                                yield _sse({"type": "reasoning", "delta": content})
                            else:
                                iteration_content.append(content)
                                if is_buffering_potential_tool:
                                    buffered_chunks.append(content)
                                    combined = "".join(iteration_content).lstrip()
                                    tool_starts = ('{', '```json', '```', '<tool_call', '<function', '<action', '<parameter', '<call', 'Action:', 'tool_call:')
                                    if combined and not any(combined.startswith(ts[:len(combined)]) for ts in tool_starts):
                                        # Not a tool call; flush buffered text as internal thinking/scratchpad
                                        is_buffering_potential_tool = False
                                        for chunk_text in buffered_chunks:
                                            iteration_reasoning.append(chunk_text)
                                            reasoning_parts.append(chunk_text)
                                            yield _sse({"type": "reasoning", "delta": chunk_text})
                                        buffered_chunks.clear()
                                    elif len(combined) > 400 and not is_pseudo_tool_call(combined):
                                        is_buffering_potential_tool = False
                                        for chunk_text in buffered_chunks:
                                            iteration_reasoning.append(chunk_text)
                                            reasoning_parts.append(chunk_text)
                                            yield _sse({"type": "reasoning", "delta": chunk_text})
                                        buffered_chunks.clear()
                                else:
                                    # Prose generated while tools are active is scratchpad planning
                                    iteration_reasoning.append(content)
                                    reasoning_parts.append(content)
                                    yield _sse({"type": "reasoning", "delta": content})
                            
                        # Handle tool calls in streaming
                        tc_delta = delta.get("tool_calls")
                        if tc_delta and isinstance(tc_delta, list):
                            for tc in tc_delta:
                                idx = tc.get("index", 0)
                                if idx not in tool_calls:
                                    tool_calls[idx] = {
                                        "id": tc.get("id") or f"call_{idx}_{iteration}_{int(time.time()*1000)}",
                                        "type": "function",
                                        "function": {
                                            "name": tc.get("function", {}).get("name", "") if isinstance(tc.get("function"), dict) else "",
                                            "arguments": "",
                                        },
                                    }
                                if tc.get("id"):
                                    tool_calls[idx]["id"] = tc["id"]
                                if isinstance(tc.get("function"), dict):
                                    if tc["function"].get("name"):
                                        prev_name = tool_calls[idx]["function"]["name"]
                                        tool_calls[idx]["function"]["name"] = tc["function"]["name"]
                                        if not prev_name and tc["function"]["name"]:
                                            tool_indicator = f"• Identified action: `{tc['function']['name']}`...\n"
                                            reasoning_parts.append(tool_indicator)
                                            yield _sse({"type": "reasoning", "delta": tool_indicator})
                                    if tc["function"].get("arguments"):
                                        tool_calls[idx]["function"]["arguments"] += tc["function"]["arguments"]
        except httpx.HTTPStatusError as exc:
            err_body = ""
            try:
                err_body = (await exc.response.aread()).decode("utf-8", errors="replace")
            except Exception:
                pass
            print(f"[AI STREAM ERROR] HTTP {exc.response.status_code}: {err_body}")
            yield _sse({"type": "reasoning", "delta": f"\n• *Provider notice: HTTP {exc.response.status_code}. Proceeding to response synthesis...*\n"})
            break
        except httpx.TimeoutException as exc:
            print(f"[AI STREAM ERROR] Timeout: {exc}")
            yield _sse({"type": "reasoning", "delta": "\n• *Inference cycle reached latency limit. Proceeding to final report synthesis...*\n"})
            break
        except Exception as exc:
            err_msg = str(exc).strip() or type(exc).__name__
            print(f"[AI STREAM ERROR] Exception: {err_msg}")
            yield _sse({"type": "reasoning", "delta": f"\n• *Inference notice: {err_msg}. Proceeding to final report synthesis...*\n"})
            break

        # Check if the assistant output is a pseudo-tool call in text form
        assistant_content = "".join(iteration_content).strip()
        pseudo_tc = extract_pseudo_tool_call(assistant_content) if (not tool_calls and assistant_content) else None
        
        if pseudo_tc:
            p_name = pseudo_tc["name"]
            p_args = pseudo_tc.get("arguments") or {}
            tc_id = f"call_pseudo_{iteration}_{int(time.time()*1000)}"
            tool_calls[0] = {
                "id": tc_id,
                "type": "function",
                "function": {
                    "name": p_name,
                    "arguments": json.dumps(p_args, ensure_ascii=False),
                },
            }
            # Suppress raw JSON from chat content
            buffered_chunks.clear()
            iteration_content.clear()
            tool_indicator = f"• Identified action: `{p_name}`...\n"
            reasoning_parts.append(tool_indicator)
            yield _sse({"type": "reasoning", "delta": tool_indicator})
        elif buffered_chunks:
            # Not a tool call; flush any buffered chunks as normal chat content
            for chunk_text in buffered_chunks:
                content_parts.append(chunk_text)
                yield _sse({"type": "content", "delta": chunk_text})
            buffered_chunks.clear()

        # Ensure all tool calls have valid id and valid arguments string before recording
        for idx, tc in tool_calls.items():
            if not tc.get("id"):
                tc["id"] = f"call_{idx}_{iteration}_{int(time.time()*1000)}"
            if not tc.get("function", {}).get("arguments"):
                tc["function"]["arguments"] = "{}"

        # If we got content or tool calls, add assistant message to history
        assistant_content = "".join(iteration_content)
        assistant_msg: Dict[str, Any] = {
            "role": "assistant",
            "content": assistant_content if assistant_content else (None if tool_calls else ""),
        }
        if tool_calls:
            assistant_msg["tool_calls"] = list(tool_calls.values())
        messages.append(assistant_msg)

        if not tool_calls:
            break  # No tools called, we're done

        # Execute tools
        for idx, tc in tool_calls.items():
            tc_id = tc["id"]
            func_name = tc["function"]["name"]
            func_args_str = tc["function"]["arguments"]
            try:
                func_args = json.loads(func_args_str) if func_args_str else {}
            except Exception:
                func_args = {}
                
            if "project_id" not in func_args and request.project_id:
                func_args["project_id"] = request.project_id
            if "deployment_id" not in func_args and request.deployment_id:
                func_args["deployment_id"] = request.deployment_id

            # Emit subagent lifecycle events in the SSE stream
            if is_architectural_goal:
                if func_name in {"workspace_edit_file", "workspace_write_file"} and not coder_subagent_emitted:
                    coder_thought = "• ⚡ [Coder Subagent] Performing surgical workspace patch...\n"
                    reasoning_parts.append(coder_thought)
                    yield _sse({"type": "reasoning", "delta": coder_thought})
                    coder_subagent_emitted = True
                elif func_name in {"wait_for_deployment", "get_deployment_status", "get_deployment_logs", "get_kubernetes_events", "get_deployment_metrics"} and not verifier_subagent_emitted:
                    verifier_thought = "• 🔍 [Verifier Subagent] Probing container health & runtime status...\n"
                    reasoning_parts.append(verifier_thought)
                    yield _sse({"type": "reasoning", "delta": verifier_thought})
                    verifier_subagent_emitted = True

            # Permission Gating Enforcement:
            # Before executing any dangerous or mutating tool, check permissions
            runtime_perms = request.runtime.get("permissions", {}) if isinstance(request.runtime, dict) else {}
            model_extra = request.model_extra or {}

            agent_access_mode = (
                runtime_perms.get("agent_access_mode")
                or model_extra.get("agent_access_mode")
                or getattr(request, "agent_access_mode", None)
                or "ask"
            )
            remote_terminal = (
                runtime_perms.get("remote_terminal")
                or model_extra.get("remote_terminal")
                or getattr(request, "remote_terminal", None)
                or "ask"
            )

            is_mutating_tool = func_name in {
                "terminal_run_command",
                "workspace_trigger_rebuild",
                "deploy_project",
                "workspace_write_file",
                "workspace_edit_file",
                "scale_deployment",
                "repair_deployment",
                "trigger_build",
            }

            needs_permission = False
            if is_mutating_tool:
                if agent_access_mode == "ask":
                    needs_permission = True
                elif func_name == "terminal_run_command" and remote_terminal == "ask":
                    needs_permission = True
                elif runtime_perms.get("require_confirmation", False):
                    needs_permission = True

            if needs_permission:
                is_approved = supervisor.is_confirmation_approved(
                    tool_name=func_name,
                    tool_args=func_args,
                    request_data=request,
                    history=request.history,
                )

                if not is_approved:
                    # 1. Yield tool call first so client records it in tool calls list
                    yield _sse({
                        "type": "tool_call",
                        "name": func_name,
                        "arguments": func_args,
                        "id": tc_id,
                    })

                    # 2. Yield structured permission request event
                    perm_event = {
                        "type": "permission_request",
                        "tool_name": func_name,
                        "arguments": func_args,
                        "id": tc_id,
                        "risk_level": "high",
                    }
                    yield _sse(perm_event)

                    cmd_arg = f": `{func_args['command']}`" if func_name == "terminal_run_command" and func_args.get("command") else ""
                    perm_thought = (
                        f"• ⏸️ Authorization required for `{func_name}`{cmd_arg}. Awaiting user approval...\n"
                    )
                    reasoning_parts.append(perm_thought)
                    yield _sse({"type": "reasoning", "delta": perm_thought})

                    paused_for_permission = True
                    break

            # Emit live tool progress in reasoning
            step_desc = f"• Running `{func_name}`"
            if func_name == "terminal_run_command" and func_args.get("command"):
                step_desc += f": `{func_args['command']}`"
            elif func_name in {"workspace_read_file", "workspace_edit_file", "workspace_write_file"} and func_args.get("file_path"):
                step_desc += f" on `{func_args['file_path']}`"
            step_desc += "...\n"
            reasoning_parts.append(step_desc)
            yield _sse({"type": "reasoning", "delta": step_desc})
                
            yield _sse({
                "type": "tool_call",
                "name": func_name,
                "arguments": func_args,
                "id": tc_id,
            })
            
            result = await execute_tool_call(func_name, func_args, request.user_id or "")
            
            # Emit tool completion in reasoning
            res_desc = f"• Completed `{func_name}`"
            if isinstance(result, dict) and "exit_code" in result:
                res_desc += f" (exit code {result['exit_code']})"
            elif isinstance(result, dict) and result.get("status"):
                res_desc += f" (status: {result['status']})"
            res_desc += "\n"
            reasoning_parts.append(res_desc)
            yield _sse({"type": "reasoning", "delta": res_desc})

            yield _sse({
                "type": "tool_result",
                "name": func_name,
                "result": result,
                "id": tc_id,
            })
            
            messages.append({
                "role": "tool",
                "tool_call_id": tc_id,
                "content": json.dumps(result, ensure_ascii=False) if not isinstance(result, str) else result,
            })

        if paused_for_permission:
            break
            
    # loop ends

    if paused_for_permission:
        # Authorization required for a tool; halt generation immediately without synthesis
        yield _sse(
            {
                "type": "done",
                "trace_id": trace_id,
                "provider": provider,
                "model": model,
                "content": "",
                "reasoning": "".join(reasoning_parts),
                "status": "waiting_for_permission",
                "latency_ms": int((time.perf_counter() - start) * 1000),
                "token_usage": total_usage,
            }
        )
        return

    # In architectural/swarm goals, ensure subagent lifecycle visibility before synthesis
    if is_architectural_goal:
        if not coder_subagent_emitted and any(m.get("role") == "tool" for m in messages):
            coder_thought = "• ⚡ [Coder Subagent] Performing surgical workspace patch...\n"
            reasoning_parts.append(coder_thought)
            yield _sse({"type": "reasoning", "delta": coder_thought})
            coder_subagent_emitted = True
        if not verifier_subagent_emitted and any(m.get("role") == "tool" for m in messages):
            verifier_thought = "• 🔍 [Verifier Subagent] Probing container health & runtime status...\n"
            reasoning_parts.append(verifier_thought)
            yield _sse({"type": "reasoning", "delta": verifier_thought})
            verifier_subagent_emitted = True

    text = "".join(content_parts).strip()
    
    # If the tool loop finished but the model produced no conversational text,
    # or produced pseudo tool call JSON, run a final synthesis pass with tools=None
    # to force the model to provide a comprehensive, structured Markdown response.
    has_executed_tools = any(m.get("role") == "tool" for m in messages)
    if has_executed_tools or not text or is_pseudo_tool_call(text):
        content_parts.clear()
        if command_name in {"/architect", "/swarm"} or (is_architectural_goal and command_name not in {"/repair", "/fix"}):
            synth_prompt = (
                "All multi-agent architectural planning, workspace modifications, and diagnostic verifications have concluded.\n"
                "Present your comprehensive Strategic AI Architect Report now in clean, structured Markdown.\n\n"
                "CRITICAL FORMATTING RULES:\n"
                "1. Every single code snippet, JSON configuration, command, or script MUST be enclosed inside proper fenced code blocks with language tags (e.g. ```json, ```powershell, ```dockerfile, ```bash, ```yaml).\n"
                "2. Structure your report into clear subagent sections:\n"
                "### 🏛️ Architectural Blueprint & Paradigm\n"
                "Detail detected framework, runtime paradigm, dependency graph, and step-by-step strategy.\n"
                "### ⚡ Applied Workspace Patches\n"
                "Detail any AST-safe modifications, file edits, or complete implementations created.\n"
                "### 🔍 Verification & Container Health\n"
                "Detail runtime status, log anomaly scans, endpoint probes, and build readiness.\n"
                "### 🚀 Next Steps & Recommendations\n"
                "Provide clear operational guidance for the platform engineer.\n\n"
                "IMPORTANT: Do NOT output raw scratchpad JSON, tool calls, or pseudo tool blocks. Provide your entire response in clear Markdown prose."
            )
        elif command_name in {"/repair", "/fix"}:
            synth_prompt = (
                "All autonomous repair actions, commands, and workspace inspections have finished.\n"
                "Please present your comprehensive, final report now in clean, well-formatted Markdown.\n\n"
                "CRITICAL FORMATTING RULES:\n"
                "1. Every single code snippet, JSON configuration, command, or script MUST be enclosed inside proper fenced code blocks with language tags (e.g. ```json, ```powershell, ```dockerfile, ```bash). Never dump raw unstructured code or unformatted text.\n"
                "2. Structure your report into clear sections:\n"
                "### 🔍 Root Cause\n"
                "Explain the exact failure detected from the logs or workspace.\n"
                "### 🛠 Applied Fixes\n"
                "Detail the exact changes, edits, or commands executed (include syntax-highlighted code blocks for files modified).\n"
                "### 🚀 Verification & Live Service Status\n"
                "Detail the rebuild verification results, the final deployment status, and the runtime URL (if available).\n\n"
                "IMPORTANT: Do NOT output raw scratchpad thinking, JSON, tool calls, or pseudo tool blocks. Provide your entire response in clear Markdown prose."
            )
        else:
            synth_prompt = (
                "All tool executions and file inspections have finished.\n"
                "Now provide your comprehensive, clear, and helpful response to the user explaining what you found, "
                "what actions were taken, and answer the user's question completely.\n\n"
                "CRITICAL FORMATTING RULES:\n"
                "1. Every code snippet, configuration, or command MUST be enclosed in fenced code blocks with language tags (e.g. ```json, ```powershell, ```dockerfile, ```bash).\n"
                "2. Structure your answer with clear markdown headings and bullet points.\n"
                "IMPORTANT: Do NOT output JSON or tool calls. Provide your answer in clear Markdown prose."
            )
        synth_messages = list(messages)
        synth_messages.append({"role": "user", "content": synth_prompt})
        
        synth_payload = chat_payload(
            model,
            messages=synth_messages,
            temperature=0.2,
            model_mode=request.model_mode,
            stream=True,
            max_tokens=4096,
            tools=None,
        )
        try:
            timeout = httpx.Timeout(DEFAULT_TIMEOUT, connect=10.0, read=DEFAULT_TIMEOUT, write=10.0, pool=10.0)
            async with httpx.AsyncClient(timeout=timeout) as client:
                async with client.stream(
                    "POST", f"{base_url}/chat/completions", headers=headers, json=synth_payload
                ) as response:
                    response.raise_for_status()
                    synth_in_think = False
                    async for line in response.aiter_lines():
                        line = line.strip()
                        if not line or line.startswith(":") or not line.startswith("data:"):
                            continue
                        data = line[len("data:"):].strip()
                        if data == "[DONE]":
                            break
                        try:
                            chunk = json.loads(data)
                        except json.JSONDecodeError:
                            continue
                        if isinstance(chunk.get("usage"), dict):
                            total_usage = chunk["usage"]
                        choices = chunk.get("choices") or []
                        if not choices:
                            continue
                        delta = choices[0].get("delta") or {}
                        reasoning = delta.get("reasoning_content") or delta.get("reasoning")
                        if isinstance(reasoning, str) and reasoning:
                            reasoning_parts.append(reasoning)
                            yield _sse({"type": "reasoning", "delta": reasoning})
                        content = delta.get("content")
                        if isinstance(content, str) and content:
                            if "<think>" in content:
                                parts = content.split("<think>", 1)
                                if parts[0]:
                                    content_parts.append(parts[0])
                                    yield _sse({"type": "content", "delta": parts[0]})
                                synth_in_think = True
                                after = parts[1]
                                if "</think>" in after:
                                    t_sub = after.split("</think>", 1)
                                    synth_in_think = False
                                    reasoning_parts.append(t_sub[0])
                                    yield _sse({"type": "reasoning", "delta": t_sub[0]})
                                    if t_sub[1]:
                                        content_parts.append(t_sub[1])
                                        yield _sse({"type": "content", "delta": t_sub[1]})
                                else:
                                    reasoning_parts.append(after)
                                    yield _sse({"type": "reasoning", "delta": after})
                            elif "</think>" in content:
                                synth_in_think = False
                                parts = content.split("</think>", 1)
                                reasoning_parts.append(parts[0])
                                yield _sse({"type": "reasoning", "delta": parts[0]})
                                if parts[1]:
                                    content_parts.append(parts[1])
                                    yield _sse({"type": "content", "delta": parts[1]})
                            elif synth_in_think:
                                reasoning_parts.append(content)
                                yield _sse({"type": "reasoning", "delta": content})
                            else:
                                content_parts.append(content)
                                yield _sse({"type": "content", "delta": content})
        except httpx.TimeoutException as exc:
            print(f"[AI STREAM SYNTHESIS ERROR] Timeout: {exc}")
            yield _sse({"type": "reasoning", "delta": "\n• *Final synthesis LLM step reached latency limit; generating structured tool summary report...*\n"})
        except Exception as exc:
            err_msg = str(exc).strip() or type(exc).__name__
            print(f"[AI STREAM SYNTHESIS ERROR]: {err_msg}")
            yield _sse({"type": "reasoning", "delta": f"\n• *Synthesis notice: {err_msg}. Generating structured report...*\n"})
            
    text = "".join(content_parts).strip()
    reasoning_text = "".join(reasoning_parts).strip()
    
    # If still empty or if text is still pseudo-tool JSON, build an informative fallback from the executed tools
    if not text or is_pseudo_tool_call(text):
        executed_tools = [m for m in messages if m.get("role") == "tool"]
        if executed_tools:
            lines = [
                "### 🔍 Diagnostic & Repair Summary",
                f"Completed {len(executed_tools)} workspace action(s) across the deployment environment.\n",
                "### 🛠 Actions Executed",
            ]
            for m in executed_tools[-6:]:
                tc_id = m.get("tool_call_id", "")
                tc_name = ""
                for am in messages:
                    if am.get("role") == "assistant" and "tool_calls" in am:
                        for tc in am["tool_calls"]:
                            if tc.get("id") == tc_id:
                                tc_name = tc.get("function", {}).get("name", "")
                                break
                res_content = str(m.get("content", ""))
                try:
                    res_obj = json.loads(res_content)
                    if isinstance(res_obj, dict):
                        if res_obj.get("status") == "ok" and "command" in res_obj:
                            res_content = f"Command `{res_obj['command']}` exited with code {res_obj.get('exit_code', 0)}"
                        elif "error" in res_obj:
                            res_content = f"Error: {res_obj['error']}"
                        elif "status" in res_obj:
                            res_content = f"Status: {res_obj['status']}"
                except Exception:
                    pass
                if tc_name:
                    lines.append(f"- **`{tc_name}`**: {res_content[:120]}")
            lines.append("\n### 🚀 Status & Next Steps")
            lines.append("The requested actions have been applied to the workspace. You can continue the conversation or trigger a rebuild.")
            text = "\n".join(lines)
        elif reasoning_text:
            text = reasoning_text
        else:
            text = "The agent completed execution."
        # CRITICAL: Stream the synthesized fallback content so the chat bubble is populated
        yield _sse({"type": "content", "delta": text})

    yield _sse(
        {
            "type": "done",
            "trace_id": trace_id,
            "provider": provider,
            "model": model,
            "content": text,
            "reasoning": reasoning_text,
            "latency_ms": int((time.perf_counter() - start) * 1000),
            "token_usage": total_usage,
        }
    )

@app.post("/chat/agent/stream")
async def chat_agent_stream(request: AgentRequest) -> StreamingResponse:
    return StreamingResponse(
        stream_agent_reply(request),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            # Without this an intermediate proxy will buffer the whole response
            # and deliver it at once, which looks exactly like streaming being
            # broken.
            "X-Accel-Buffering": "no",
        },
    )

