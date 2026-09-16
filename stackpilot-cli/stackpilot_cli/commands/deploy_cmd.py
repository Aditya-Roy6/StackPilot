from typing import Optional
import typer
from ..ui import console, print_banner, print_success, print_error, print_info, render_table
from ..services.backend_client import BackendClient

app = typer.Typer(help="CI/CD, Builds, and Deployment commands")

@app.command("trigger")
def trigger_deploy_command(
    project_id: str = typer.Argument(..., help="Project ID to deploy"),
    environment_id: Optional[str] = typer.Option(None, "--env-id", "-e", help="Target environment ID"),
    branch: Optional[str] = typer.Option(None, "--branch", "-b", help="Branch name override")
):
    client = BackendClient()
    print_info(f"Triggering build & deployment for project {project_id}...")
    res = client.trigger_build(project_id, environment_id=environment_id, branch=branch)
    if res.get("status") == "ok":
        d = res.get("data", {})
        dep_id = d.get("deployment_id") or d.get("id", "queued")
        print_success(f"Deployment successfully initiated! (Deployment ID: [bold cyan]{dep_id}[/bold cyan])")
        print_info(f"View live build logs via: stackpilot deploy logs {dep_id}")
    else:
        print_error(f"Deployment failed: {res.get('error')}")
        raise typer.Exit(1)

@app.command("list")
def list_deployments_command(
    project_id: str = typer.Argument(..., help="Project ID")
):
    client = BackendClient()
    deployments = client.list_deployments(project_id)
    if not deployments:
        print_info(f"No deployments found for project {project_id}.")
        return

    rows = []
    for d in deployments:
        status = d.get("status", "")
        icon = "🟢" if status in {"running", "deployed", "success"} else ("🟡" if status in {"pending", "queued", "building"} else "🔴")
        rows.append([
            str(d.get("id", ""))[:8] + "...",
            d.get("version", ""),
            d.get("branch", ""),
            f"{icon} {status}",
            d.get("created_at", "")[:19]
        ])
    render_table(f"Deployments for Project {project_id}", ["ID", "Version", "Branch", "Status", "Created"], rows)

@app.command("logs")
def deployment_logs_command(
    deployment_id: str = typer.Argument(..., help="Deployment ID")
):
    client = BackendClient()
    logs = client.get_deployment_logs(deployment_id)
    if logs:
        console.print(f"[bold cyan]Build & Deployment Logs ({deployment_id}):[/bold cyan]\n")
        console.print(logs)
    else:
        print_warning(f"No logs available for deployment {deployment_id}.")
