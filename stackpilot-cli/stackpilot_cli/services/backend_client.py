from typing import Any, Dict, List, Optional
import requests
from ..config import load_config, get_auth_token, save_auth, clear_auth

class BackendClient:
    def __init__(self, base_url: Optional[str] = None):
        cfg = load_config()
        self.base_url = (base_url or cfg.get("backend_url", "http://localhost:8090")).rstrip("/")

    def _headers(self) -> Dict[str, str]:
        headers = {"Content-Type": "application/json"}
        token = get_auth_token()
        if token:
            headers["Authorization"] = f"Bearer {token}"
        return headers

    def check_health(self) -> Dict[str, Any]:
        try:
            r = requests.get(f"{self.base_url}/api/v1/health", timeout=5)
            if r.status_code == 200:
                return {"status": "ok", "data": r.json()}
            return {"status": "error", "error": f"HTTP {r.status_code}"}
        except Exception as e:
            return {"status": "error", "error": str(e)}

    # ─── Auth ─────────────────────────────────────────
    def login(self, email: str, password: str) -> Dict[str, Any]:
        try:
            r = requests.post(
                f"{self.base_url}/api/v1/auth/login",
                json={"email": email, "password": password},
                headers={"Content-Type": "application/json"},
                timeout=10
            )
            if r.status_code == 200:
                data = r.json()
                token = data.get("token") or data.get("access_token")
                save_auth({
                    "token": token,
                    "user": data.get("user", {}),
                    "email": email
                })
                return {"status": "ok", "data": data}
            return {"status": "error", "error": r.text}
        except Exception as e:
            return {"status": "error", "error": str(e)}

    def register(self, email: str, password: str, name: str = "") -> Dict[str, Any]:
        try:
            r = requests.post(
                f"{self.base_url}/api/v1/auth/register",
                json={"email": email, "password": password, "name": name},
                headers={"Content-Type": "application/json"},
                timeout=10
            )
            if r.status_code in {200, 201}:
                data = r.json()
                token = data.get("token") or data.get("access_token")
                if token:
                    save_auth({"token": token, "user": data.get("user", {}), "email": email})
                return {"status": "ok", "data": data}
            return {"status": "error", "error": r.text}
        except Exception as e:
            return {"status": "error", "error": str(e)}

    def me(self) -> Dict[str, Any]:
        try:
            r = requests.get(f"{self.base_url}/api/v1/auth/me", headers=self._headers(), timeout=5)
            if r.status_code == 200:
                return {"status": "ok", "data": r.json()}
            return {"status": "error", "error": f"HTTP {r.status_code}"}
        except Exception as e:
            return {"status": "error", "error": str(e)}

    def logout(self) -> None:
        try:
            requests.post(f"{self.base_url}/api/v1/auth/logout", headers=self._headers(), timeout=5)
        except Exception:
            pass
        clear_auth()

    # ─── Projects ─────────────────────────────────────
    def list_projects(self) -> List[Dict[str, Any]]:
        try:
            r = requests.get(f"{self.base_url}/api/v1/projects", headers=self._headers(), timeout=10)
            if r.status_code == 200:
                data = r.json()
                if isinstance(data, list):
                    return data
                return data.get("projects", [])
            return []
        except Exception:
            return []

    def create_project(self, name: str, repo_url: str = "", branch: str = "main") -> Dict[str, Any]:
        try:
            payload = {"name": name, "repo_url": repo_url, "default_branch": branch}
            r = requests.post(f"{self.base_url}/api/v1/projects", json=payload, headers=self._headers(), timeout=10)
            if r.status_code in {200, 201}:
                return {"status": "ok", "data": r.json()}
            return {"status": "error", "error": r.text}
        except Exception as e:
            return {"status": "error", "error": str(e)}

    def delete_project(self, project_id: str) -> bool:
        try:
            r = requests.delete(f"{self.base_url}/api/v1/projects/{project_id}", headers=self._headers(), timeout=10)
            return r.status_code in {200, 204}
        except Exception:
            return False

    # ─── Environments ─────────────────────────────────
    def list_environments(self, project_id: str) -> List[Dict[str, Any]]:
        try:
            r = requests.get(f"{self.base_url}/api/v1/projects/{project_id}/environments", headers=self._headers(), timeout=10)
            if r.status_code == 200:
                data = r.json()
                if isinstance(data, list):
                    return data
                return data.get("environments", [])
            return []
        except Exception:
            return []

    # ─── Deployments & Builds ─────────────────────────
    def list_deployments(self, project_id: str) -> List[Dict[str, Any]]:
        try:
            r = requests.get(f"{self.base_url}/api/v1/projects/{project_id}/deployments", headers=self._headers(), timeout=10)
            if r.status_code == 200:
                data = r.json()
                if isinstance(data, list):
                    return data
                return data.get("deployments", [])
            return []
        except Exception:
            return []

    def trigger_build(self, project_id: str, environment_id: Optional[str] = None, branch: Optional[str] = None) -> Dict[str, Any]:
        try:
            payload: Dict[str, Any] = {}
            if environment_id:
                payload["environment_id"] = environment_id
            if branch:
                payload["branch"] = branch
            r = requests.post(f"{self.base_url}/api/v1/projects/{project_id}/build", json=payload, headers=self._headers(), timeout=15)
            if r.status_code in {200, 201, 202}:
                return {"status": "ok", "data": r.json()}
            return {"status": "error", "error": r.text}
        except Exception as e:
            return {"status": "error", "error": str(e)}

    def get_deployment_logs(self, deployment_id: str) -> str:
        try:
            r = requests.get(f"{self.base_url}/api/v1/deployments/{deployment_id}/logs", headers=self._headers(), timeout=10)
            if r.status_code == 200:
                data = r.json()
                return data.get("logs", "")
            return ""
        except Exception:
            return ""

    # ─── Clusters ─────────────────────────────────────
    def list_clusters(self) -> List[Dict[str, Any]]:
        try:
            r = requests.get(f"{self.base_url}/api/v1/clusters", headers=self._headers(), timeout=10)
            if r.status_code == 200:
                data = r.json()
                if isinstance(data, list):
                    return data
                return data.get("clusters", [])
            return []
        except Exception:
            return []
