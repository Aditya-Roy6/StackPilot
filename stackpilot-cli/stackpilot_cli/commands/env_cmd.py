from typing import Optional
import typer
from ..ui import console, print_banner, print_success, print_error, print_info, render_table
from ..services.backend_client import BackendClient

app = typer.Typer(help="Project environment management (list, inspect, branch mapping)")

@app.command("list")
def list_environments_command(
    project_id: str = typer.Argument(..., help="Project ID")
):
    client = BackendClient()
    envs = client.list_environments(project_id)
    if not envs:
        print_info(f"No environments found for project {project_id}.")
        return

    rows = []
    for e in envs:
        rows.append([
            str(e.get("id", ""))[:8] + "...",
            e.get("name", ""),
            e.get("branch", ""),
            "✅ Yes" if e.get("auto_deploy") else "❌ No",
            "🔒 Required" if e.get("require_ci") else "⚪ Optional",
            e.get("current_runtime_url") or "Not deployed"
        ])
    render_table(f"Environments for Project {project_id}", ["ID", "Environment", "Branch", "Auto Deploy", "CI Gated", "Runtime URL"], rows)
