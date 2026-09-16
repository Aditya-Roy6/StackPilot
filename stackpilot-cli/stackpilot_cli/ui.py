import sys
from typing import Any, List, Optional
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.text import Text
from rich.markdown import Markdown
from rich.live import Live
from rich.spinner import Spinner

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

console = Console(legacy_windows=False)
err_console = Console(stderr=True, legacy_windows=False)

LOGO = r"""
   _____ _             _    _____  _ _       _   
  / ____| |           | |  |  __ \(_) |     | |  
 | (___ | |_ __ _  ___| | _| |__) |_| | ___ | |_ 
  \___ \| __/ _` |/ __| |/ /  ___/| | |/ _ \| __|
  ____) | || (_| | (__|   <| |    | | | (_) | |_ 
 |_____/ \__\__,_|\___|_|\_\_|    |_|_|\___/ \__|
"""

def print_banner(subtitle: str = "100% Terminal Autonomous QA & Deployment Platform") -> None:
    text = Text(LOGO, style="bold cyan")
    text.append(f"\n {subtitle}\n", style="dim italic")
    console.print(text)

def print_success(msg: str) -> None:
    console.print(f"[bold green]✔[/bold green] {msg}")

def print_error(msg: str) -> None:
    err_console.print(f"[bold red]✖[/bold red] {msg}")

def print_warning(msg: str) -> None:
    console.print(f"[bold yellow]⚠[/bold yellow] {msg}")

def print_info(msg: str) -> None:
    console.print(f"[bold cyan]ℹ[/bold cyan] {msg}")

def print_step(icon: str, title: str, detail: str = "") -> None:
    msg = f"[bold cyan]{icon}[/bold cyan] [bold]{title}[/bold]"
    if detail:
        msg += f" [dim]{detail}[/dim]"
    console.print(msg)

def render_table(title: str, columns: List[str], rows: List[List[Any]]) -> None:
    table = Table(title=title, show_header=True, header_style="bold magenta", border_style="dim")
    for col in columns:
        table.add_column(col)
    for row in rows:
        table.add_row(*[str(c) if c is not None else "" for c in row])
    console.print(table)

def render_panel(content: str, title: Optional[str] = None, border_style: str = "cyan") -> None:
    console.print(Panel(content, title=title, border_style=border_style, expand=False))

def render_markdown(text: str) -> None:
    md = Markdown(text)
    console.print(md)
