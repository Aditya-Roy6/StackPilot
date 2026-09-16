from typing import Optional
import typer
from ..ui import console, print_banner, print_success, print_error, print_info, render_table
from ..services.backend_client import BackendClient

app = typer.Typer(help="Kubernetes cluster and node provisioning commands")

@app.command("list")
def list_clusters_command():
    client = BackendClient()
    clusters = client.list_clusters()
    if not clusters:
        print_info("No managed clusters found.")
        return

    rows = []
    for c in clusters:
        rows.append([
            str(c.get("id", ""))[:8] + "...",
            c.get("name", ""),
            c.get("provider", "hetzner"),
            str(c.get("node_count", 1)),
            c.get("status", "active")
        ])
    render_table("Managed Kubernetes Clusters", ["ID", "Cluster Name", "Provider", "Nodes", "Status"], rows)
