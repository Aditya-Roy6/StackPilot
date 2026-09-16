from typing import Optional
import typer
from rich.prompt import Prompt
from ..ui import console, print_banner, print_success, print_error, print_info, render_table
from ..services.backend_client import BackendClient

app = typer.Typer(help="Authentication commands (login, register, me, logout)")

@app.command("login")
def login_command(
    email: Optional[str] = typer.Option(None, "--email", "-e", help="User email"),
    password: Optional[str] = typer.Option(None, "--password", "-p", help="User password")
):
    print_banner("User Authentication")
    user_email = email or Prompt.ask("Enter email")
    user_pass = password or Prompt.ask("Enter password", password=True)

    client = BackendClient()
    res = client.login(user_email, user_pass)
    if res.get("status") == "ok":
        print_success(f"Successfully authenticated as [bold cyan]{user_email}[/bold cyan]!")
    else:
        print_error(f"Login failed: {res.get('error')}")
        raise typer.Exit(1)

@app.command("register")
def register_command(
    email: Optional[str] = typer.Option(None, "--email", "-e"),
    password: Optional[str] = typer.Option(None, "--password", "-p"),
    name: Optional[str] = typer.Option(None, "--name", "-n")
):
    print_banner("Account Registration")
    user_name = name or Prompt.ask("Enter full name", default="")
    user_email = email or Prompt.ask("Enter email")
    user_pass = password or Prompt.ask("Enter password", password=True)

    client = BackendClient()
    res = client.register(user_email, user_pass, user_name)
    if res.get("status") == "ok":
        print_success(f"Account created and logged in as [bold cyan]{user_email}[/bold cyan]!")
    else:
        print_error(f"Registration failed: {res.get('error')}")
        raise typer.Exit(1)

@app.command("me")
def me_command():
    client = BackendClient()
    res = client.me()
    if res.get("status") == "ok":
        user = res.get("data", {}).get("user", res.get("data", {}))
        rows = [
            ["User ID", str(user.get("id", ""))],
            ["Email", str(user.get("email", ""))],
            ["Name", str(user.get("name", ""))],
            ["Role", str(user.get("role", "user"))],
        ]
        render_table("Current Authenticated User", ["Attribute", "Value"], rows)
    else:
        print_warning("You are not currently logged in. Run: stackpilot auth login")

@app.command("logout")
def logout_command():
    client = BackendClient()
    client.logout()
    print_success("Logged out successfully.")
