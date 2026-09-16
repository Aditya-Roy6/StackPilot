from typing import Optional
import typer
from rich.prompt import Prompt, Confirm
from ..ui import console, print_banner, print_success, print_error, print_warning, print_info, render_table
from ..services.backend_client import BackendClient

app = typer.Typer(help="Project management commands (list, create, delete)")

@app.command("list")
def list_projects_command():
    client = BackendClient()
    projects = client.list_projects()
    if not projects:
        print_info("No projects found. Create one using: stackpilot project create <name>")
        return

    rows = []
    for p in projects:
        rows.append([
            str(p.get("id", ""))[:8] + "...",
            p.get("name", ""),
            p.get("repo_url", "None"),
            p.get("default_branch", "main"),
            str(p.get("status", "active"))
        ])
    render_table("StackPilot Projects", ["ID", "Project Name", "Repository", "Branch", "Status"], rows)

@app.command("create")
def create_project_command(
    name: str = typer.Argument(..., help="Project name"),
    repo: Optional[str] = typer.Option("", "--repo", "-r", help="Git repository URL"),
    branch: Optional[str] = typer.Option("main", "--branch", "-b", help="Default branch")
):
    client = BackendClient()
    res = client.create_project(name=name, repo_url=repo or "", branch=branch or "main")
    if res.get("status") == "ok":
        p = res.get("data", {})
        print_success(f"Project '[bold cyan]{name}[/bold cyan]' created successfully (ID: {p.get('id')})!")
    else:
        print_error(f"Failed to create project: {res.get('error')}")
        raise typer.Exit(1)

@app.command("delete")
def delete_project_command(
    project_id: str = typer.Argument(..., help="Project ID to delete"),
    force: bool = typer.Option(False, "--force", "-f", help="Skip confirmation")
):
    if not force:
        confirm = Confirm.ask(f"Are you sure you want to permanently delete project {project_id}?", default=False)
        if not confirm:
            print_info("Operation cancelled.")
            return

    client = BackendClient()
    if client.delete_project(project_id):
        print_success(f"Project {project_id} deleted.")
    else:
        print_error(f"Failed to delete project {project_id}.")
        raise typer.Exit(1)
