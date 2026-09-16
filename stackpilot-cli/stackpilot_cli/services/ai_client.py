import json
import uuid
from typing import Any, AsyncIterator, Dict, Generator, List, Optional
import requests
from ..config import load_config, find_service_token

class AIClient:
    def __init__(self, base_url: Optional[str] = None, timeout: int = 60):
        cfg = load_config()
        self.base_url = (base_url or cfg.get("ai_service_url", "http://localhost:8010")).rstrip("/")
        self.timeout = timeout
        self.service_token = find_service_token()

    def _headers(self, accept: str = "application/json") -> Dict[str, str]:
        headers = {"Content-Type": "application/json", "Accept": accept}
        if self.service_token:
            headers["X-StackPilot-Service-Token"] = self.service_token
        return headers

    def check_health(self) -> Dict[str, Any]:
        try:
            r = requests.get(f"{self.base_url}/health", timeout=5)
            if r.status_code == 200:
                return {"status": "ok", "data": r.json()}
            return {"status": "error", "error": f"HTTP {r.status_code}"}
        except Exception as e:
            return {"status": "error", "error": str(e)}

    def list_models(self) -> List[Dict[str, Any]]:
        try:
            r = requests.get(f"{self.base_url}/models", headers=self._headers(), timeout=10)
            if r.status_code == 200:
                data = r.json()
                if isinstance(data, list):
                    return data
                return data.get("models", [])
            return []
        except Exception:
            return []

    def stop_agent(self, session_id: str = "default") -> bool:
        try:
            r = requests.post(f"{self.base_url}/chat/agent/stop", json={"session_id": session_id}, headers=self._headers(), timeout=5)
            return r.status_code == 200
        except Exception:
            return False

    def stream_chat(
        self,
        message: str,
        custom_url: Optional[str] = None,
        history: Optional[List[Dict[str, str]]] = None,
        model: Optional[str] = None,
        session_id: Optional[str] = None,
        workflow_type: str = "agent_chat"
    ) -> Generator[Dict[str, Any], None, None]:
        session_id = session_id or str(uuid.uuid4())
        payload = {
            "message": message,
            "custom_url": custom_url,
            "session_id": session_id,
            "history": history or [],
            "workflow_type": workflow_type,
            "model": model
        }

        try:
            with requests.post(
                f"{self.base_url}/chat/agent/stream",
                json=payload,
                stream=True,
                headers=self._headers(accept="text/event-stream"),
                timeout=self.timeout
            ) as resp:
                if resp.status_code != 200:
                    yield {"type": "error", "error": f"AI service returned HTTP {resp.status_code}: {resp.text}"}
                    return

                for line in resp.iter_lines(decode_unicode=True):
                    if not line:
                        continue
                    if line.startswith("data:"):
                        raw_json = line[5:].strip()
                        if not raw_json:
                            continue
                        try:
                            ev = json.loads(raw_json)
                            yield ev
                        except Exception:
                            pass
        except Exception as e:
            yield {"type": "error", "error": str(e)}
