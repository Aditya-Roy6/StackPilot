import json
import os
import platform
import shutil
import subprocess
from pathlib import Path
from typing import Dict, List, Optional, Tuple

def get_workspace_root() -> Path:
    # First check current directory for docker-compose.yml
    cwd = Path.cwd()
    if (cwd / "docker-compose.yml").exists():
        return cwd
    # Check parent directory of stackpilot-cli
    parent = Path(__file__).resolve().parent.parent.parent.parent
    if (parent / "docker-compose.yml").exists():
        return parent
    return cwd

def is_docker_installed() -> bool:
    return shutil.which("docker") is not None

def is_docker_running() -> bool:
    if not is_docker_installed():
        return False
    try:
        res = subprocess.run(
            ["docker", "info"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5
        )
        return res.returncode == 0
    except Exception:
        return False

def get_docker_version() -> Optional[str]:
    if not is_docker_installed():
        return None
    try:
        res = subprocess.run(
            ["docker", "--version"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=5
        )
        return res.stdout.strip()
    except Exception:
        return None

def install_docker_hint() -> str:
    system = platform.system().lower()
    if system == "windows":
        return "Install Docker Desktop via: winget install -e --id Docker.DockerDesktop"
    elif system == "darwin":
        return "Install Docker Desktop via: brew install --cask docker"
    else:
        return "Install Docker via: curl -fsSL https://get.docker.com | sh"

def run_compose_up(profile: str = "core", detach: bool = True, build: bool = False) -> Tuple[bool, str]:
    root = get_workspace_root()
    cmd = ["docker", "compose"]
    if profile and profile != "all":
        cmd.extend(["--profile", profile])
    cmd.append("up")
    if detach:
        cmd.append("-d")
    if build:
        cmd.append("--build")
    try:
        res = subprocess.run(cmd, cwd=root, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        return res.returncode == 0, res.stdout
    except Exception as e:
        return False, str(e)

def run_compose_down(volumes: bool = False) -> Tuple[bool, str]:
    root = get_workspace_root()
    cmd = ["docker", "compose", "down"]
    if volumes:
        cmd.append("-v")
    try:
        res = subprocess.run(cmd, cwd=root, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        return res.returncode == 0, res.stdout
    except Exception as e:
        return False, str(e)

def get_container_status() -> List[Dict[str, str]]:
    if not is_docker_running():
        return []
    try:
        res = subprocess.run(
            ["docker", "ps", "-a", "--filter", "name=stackpilot", "--format", "{{json .}}"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=10
        )
        containers = []
        for line in res.stdout.strip().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                data = json.loads(line)
                containers.append({
                    "name": data.get("Names", ""),
                    "image": data.get("Image", ""),
                    "status": data.get("Status", ""),
                    "state": data.get("State", ""),
                    "ports": data.get("Ports", "")
                })
            except Exception:
                pass
        return containers
    except Exception:
        return []

def stream_service_logs(service: Optional[str] = None, follow: bool = True) -> None:
    root = get_workspace_root()
    cmd = ["docker", "compose", "logs"]
    if follow:
        cmd.append("-f")
    if service:
        cmd.append(service)
    try:
        subprocess.run(cmd, cwd=root)
    except KeyboardInterrupt:
        pass
