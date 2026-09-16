import time
import uuid
import webbrowser
from typing import Any, Dict, List, Optional
import typer
from rich.live import Live
from rich.table import Table
from rich.markdown import Markdown
from rich.panel import Panel
from ..ui import console, print_banner, print_info, print_success, print_error, print_warning, render_table, print_step
from ..services.ai_client import AIClient

def run_test(
    url: str = typer.Argument(..., help="The target URL to test (e.g. https://example.com or http://localhost:3000)"),
    depth: int = typer.Option(2, "--depth", "-d", help="Max crawl depth for subpages"),
    model: Optional[str] = typer.Option(None, "--model", "-m", help="AI Model override"),
    session_id: Optional[str] = typer.Option(None, "--session-id", "-s", help="Custom session ID"),
    open_browser: bool = typer.Option(False, "--open", "-o", help="Automatically open web playback and AI canvas in default browser")
):
    print_banner(f"Autonomous Browser QA Testing")
    
    if not url.startswith("http://") and not url.startswith("https://"):
        url = "https://" + url

    print_step("🌐", "Target Website", url)
    print_step("🤖", "Autonomous Mode", f"APV Navigation Crawler (Depth: {depth})")

    client = AIClient(timeout=300)
    health = client.check_health()
    if health.get("status") != "ok":
        print_error(f"AI Service is unreachable at {client.base_url}. Ensure StackPilot is running (stackpilot up).")
        raise typer.Exit(1)

    sess_id = session_id or f"cli-qa-{int(time.time())}"
    playback_url = f"http://localhost:3000/dashboard/ai?session={sess_id}&browser=true"
    test_prompt = (
        f"Perform an exhaustive autonomous QA audit of the website at {url}. "
        f"Discover interactive elements, click navigation cards, fill out and submit any forms, "
        f"explore subpages up to depth {depth}, monitor console errors, and verify responsiveness."
    )

    console.print("\n[bold cyan]─── Live Action & Perception Stream ──────────────────────────────────────────[/bold cyan]\n")
    
    start_time = time.time()
    passed_cases = 0
    failed_cases = 0
    total_actions = 0
    console_errors = 0
    final_markdown_report = ""

    for ev in client.stream_chat(
        message=test_prompt,
        custom_url=url,
        model=model,
        session_id=sess_id,
        workflow_type="browser_test"
    ):
        ev_type = ev.get("type")
        if ev_type == "tool_call":
            total_actions += 1
            name = ev.get("name", "")
            args = ev.get("arguments", {})
            if name == "browser_open_live_session":
                print_step("🚀", "Launching Browser Session", args.get("url", url))
            elif name == "browser_interact":
                action = args.get("action", "interact")
                target = args.get("label") or args.get("element_id") or args.get("text") or "element"
                if action == "click":
                    print_step("🖱️", f"Clicked [{target}]")
                elif action == "type":
                    txt = args.get('text', '')
                    print_step("⌨️", f'Typed "{txt}" into [{target}]')
                elif action == "scroll":
                    print_step("📜", f"Scrolled page (delta: {args.get('delta_y', 300)}px)")
                else:
                    print_step("⚡", f"Action {action} on [{target}]")
            else:
                print_step("🔧", f"Tool {name}", str(args)[:60])

        elif ev_type == "tool_result":
            res = ev.get("result", {})
            if isinstance(res, dict):
                if res.get("status") in {"passed", "ok", "success"}:
                    passed_cases += 1
                elif res.get("status") == "failed":
                    failed_cases += 1
                if res.get("console_errors_count", 0) > 0:
                    console_errors += res["console_errors_count"]
                    print_warning(f"Detected {res['console_errors_count']} browser console error(s)")

        elif ev_type == "error":
            print_error(f"Execution Error: {ev.get('error', '')}")
            break

        elif ev_type == "done":
            final_markdown_report = ev.get("content", "")
            break

    elapsed = time.time() - start_time
    console.print("\n[bold cyan]─── Test Run Complete ────────────────────────────────────────────────────────[/bold cyan]\n")

    # 1. Print Comprehensive Markdown Report first (if available) so it doesn't push the summary table away
    if final_markdown_report:
        console.print("\n[bold magenta]📋 Comprehensive Audit Report:[/bold magenta]\n")
        console.print(Markdown(final_markdown_report))
        console.print("")

    # 2. Render Final Scorecard Table at the very bottom
    summary_rows = [
        ["Target URL", url],
        ["Duration", f"{elapsed:.1f} seconds"],
        ["Actions Dispatched", str(total_actions)],
        ["Verified Steps Passed", f"✅ {passed_cases}" if passed_cases > 0 else "0"],
        ["Failed Actions", f"❌ {failed_cases}" if failed_cases > 0 else "✅ 0"],
        ["Console Errors Caught", f"⚠️ {console_errors}" if console_errors > 0 else "✅ 0"],
        ["Session ID", sess_id],
        ["Web Playback URL", playback_url]
    ]
    render_table("QA Audit Scorecard", ["Metric", "Value"], summary_rows)

    # 3. Print clickable Web Playback Panel
    console.print(
        Panel.fit(
            f"[bold green]▶ Live Canvas & Playback Available:[/bold green]\n"
            f"[bold cyan underline]{playback_url}[/bold cyan underline]\n\n"
            f"[dim]Tip: Open this link in your browser to view the 60 FPS live canvas, inspect scrubber replay, and review actions.[/dim]",
            title="[bold yellow]🌐 Web Playback Link[/bold yellow]",
            border_style="cyan"
        )
    )

    if open_browser:
        print_info(f"Opening web playback in default browser...")
        webbrowser.open(playback_url)
