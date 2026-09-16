import json
import os
from pathlib import Path
from typing import Any, Dict, Optional

CONFIG_DIR = Path.home() / ".stackpilot"
CONFIG_FILE = CONFIG_DIR / "config.json"
AUTH_FILE = CONFIG_DIR / "auth.json"

DEFAULT_CONFIG: Dict[str, Any] = {
    "backend_url": "http://localhost:8090",
    "ai_service_url": "http://localhost:8010",
    "browser_stream_url": "http://localhost:8099",
    "frontend_url": "http://localhost:3000",
    "default_profile": "core",
    "timeout_seconds": 60,
    "potato_mode": False
}

def ensure_config_dir() -> Path:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    return CONFIG_DIR

def load_config() -> Dict[str, Any]:
    ensure_config_dir()
    if not CONFIG_FILE.exists():
        save_config(DEFAULT_CONFIG)
        return DEFAULT_CONFIG.copy()
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            merged = DEFAULT_CONFIG.copy()
            merged.update(data)
            return merged
    except Exception:
        return DEFAULT_CONFIG.copy()

def save_config(config: Dict[str, Any]) -> None:
    ensure_config_dir()
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)

def load_auth() -> Optional[Dict[str, Any]]:
    ensure_config_dir()
    if not AUTH_FILE.exists():
        return None
    try:
        with open(AUTH_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None

def save_auth(auth_data: Dict[str, Any]) -> None:
    ensure_config_dir()
    with open(AUTH_FILE, "w", encoding="utf-8") as f:
        json.dump(auth_data, f, indent=2)

def clear_auth() -> None:
    if AUTH_FILE.exists():
        AUTH_FILE.unlink()

def get_auth_token() -> Optional[str]:
    auth = load_auth()
    if auth:
        return auth.get("token")
    return None

def find_service_token() -> Optional[str]:
    token = os.getenv("STACKPILOT_AI_SERVICE_TOKEN")
    if token:
        return token.strip()
    
    cfg = load_config()
    if cfg.get("service_token"):
        return cfg["service_token"].strip()
        
    search_dirs = [
        Path.cwd(),
        Path(__file__).resolve().parent.parent.parent,
        Path.home() / "OneDrive" / "Desktop" / "ALL websites" / "StackPilot",
    ]
    for d in search_dirs:
        env_file = d / ".env"
        if env_file.exists():
            try:
                with open(env_file, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if line.startswith("STACKPILOT_AI_SERVICE_TOKEN="):
                            val = line.split("=", 1)[1].strip().strip('"').strip("'")
                            if val:
                                cfg["service_token"] = val
                                save_config(cfg)
                                return val
            except Exception:
                pass
    return None
