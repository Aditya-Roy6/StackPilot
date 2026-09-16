"""
StackPilot Pushdown Navigation Automaton (PNA) & 4-Tier Backtracking Engine
Provides hierarchical navigation state management, deep subpage exploration,
modal containment, cyclical trap detection, and 4-tier escalation backtracking.
"""

from dataclasses import dataclass, field
import logging
import time
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

logger = logging.getLogger("stackpilot.navigation_pda")


@dataclass
class NavigationFrame:
    url: str
    title: str = ""
    archetype: str = "unknown"
    parent_url: str = ""
    trigger_label: str = ""
    trigger_element_id: Optional[int] = None
    scroll_x: int = 0
    scroll_y: int = 0
    is_modal: bool = False
    modal_selector: str = ""
    depth: int = 0
    timestamp: float = field(default_factory=time.time)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "url": self.url,
            "title": self.title,
            "archetype": self.archetype,
            "parent_url": self.parent_url,
            "trigger_label": self.trigger_label,
            "trigger_element_id": self.trigger_element_id,
            "scroll_y": self.scroll_y,
            "is_modal": self.is_modal,
            "depth": self.depth,
        }


class AntiTrapDetector:
    """
    Detects cyclical loops, oscillation (A -> B -> A -> B), and trapped modals
    to prevent the autonomous agent from wasting steps in infinite loops.
    """

    def __init__(self, window_size: int = 10):
        self.window_size = window_size
        self.history: List[str] = []
        self._action_history: List[str] = []

    def record(self, url: str, action_sig: str = "") -> Tuple[bool, str]:
        """
        Records a navigation transition.
        Returns (is_trapped: bool, trap_reason: str).
        """
        if not url:
            return False, ""

        clean = url.rstrip("/").lower()
        self.history.append(clean)
        if action_sig:
            self._action_history.append(action_sig)

        if len(self.history) > self.window_size:
            self.history.pop(0)
        if len(self._action_history) > self.window_size:
            self._action_history.pop(0)

        # 1. Immediate Ping-Pong Oscillation Check: A -> B -> A -> B
        if len(self.history) >= 4:
            if self.history[-1] == self.history[-3] and self.history[-2] == self.history[-4] and self.history[-1] != self.history[-2]:
                return True, f"Ping-pong navigation loop detected between '{self.history[-1]}' and '{self.history[-2]}'"

        # 2. Repeated visits without state progress
        if len(self.history) >= 5:
            counts = self.history.count(clean)
            if counts >= 4:
                return True, f"Stuck on route '{clean}' ({counts} visits in last {len(self.history)} steps)"

        # 3. Action repetition trap
        if len(self._action_history) >= 4:
            last_action = self._action_history[-1]
            if all(a == last_action for a in self._action_history[-4:]):
                return True, f"Repeated action trap detected: '{last_action}' fired 4 times continuously"

        return False, ""

    def reset(self):
        self.history.clear()
        self._action_history.clear()


class PushdownNavigationAutomaton:
    """
    Pushdown Automaton (PDA) that maintains an explicit hierarchical stack of
    navigation contexts, ensuring proper depth-first traversal of cards, modals,
    and subpages with deterministic 4-tier backtracking.
    """

    def __init__(self, root_url: str = ""):
        self.root_url = root_url
        self.stack: List[NavigationFrame] = []
        self.trap_detector = AntiTrapDetector()
        self.backtrack_history: List[Dict[str, Any]] = []

    @property
    def depth(self) -> int:
        return len(self.stack)

    def current_frame(self) -> Optional[NavigationFrame]:
        return self.stack[-1] if self.stack else None

    def push(
        self,
        url: str,
        title: str = "",
        archetype: str = "unknown",
        parent_url: str = "",
        trigger_label: str = "",
        trigger_element_id: Optional[int] = None,
        scroll_x: int = 0,
        scroll_y: int = 0,
        is_modal: bool = False,
        modal_selector: str = "",
    ) -> NavigationFrame:
        """Pushes a new navigation frame onto the exploration stack."""
        depth = len(self.stack) + 1
        frame = NavigationFrame(
            url=url,
            title=title,
            archetype=archetype,
            parent_url=parent_url or (self.stack[-1].url if self.stack else self.root_url),
            trigger_label=trigger_label,
            trigger_element_id=trigger_element_id,
            scroll_x=scroll_x,
            scroll_y=scroll_y,
            is_modal=is_modal,
            modal_selector=modal_selector,
            depth=depth,
        )
        self.stack.append(frame)
        logger.debug(f"PNA: Pushed frame depth={depth} url='{url}' (archetype={archetype})")
        return frame

    def pop(self) -> Optional[NavigationFrame]:
        """Pops the top frame upon returning to parent context."""
        if self.stack:
            popped = self.stack.pop()
            logger.debug(f"PNA: Popped frame depth={popped.depth} url='{popped.url}'")
            return popped
        return None

    def can_backtrack(self) -> bool:
        """Returns True if there is an ancestor navigation frame to return to."""
        return len(self.stack) >= 2 or (len(self.stack) == 1 and bool(self.stack[0].parent_url))

    async def backtrack_to_parent(
        self,
        session: Any,
        fallback_parent_url: str = "",
    ) -> Dict[str, Any]:
        """
        Executes 4-Tier Escalation Backtracking to return safely to the parent context:
        - Tier 1: Modal/Overlay Dismissal (Escape key, close button, backdrop)
        - Tier 2: History Back (window.history.back via CDP)
        - Tier 3: In-page Breadcrumb / Nav Link
        - Tier 4: Direct Fallback Navigation (deterministic route navigation)
        """
        top_frame = self.current_frame()
        target_parent = fallback_parent_url
        if not target_parent and top_frame:
            target_parent = top_frame.parent_url
        if not target_parent and len(self.stack) >= 2:
            target_parent = self.stack[-2].url
        if not target_parent:
            target_parent = self.root_url or session.current_url

        target_norm = target_parent.rstrip("/").lower()
        current_pre = (session.current_url or "").rstrip("/").lower()

        logger.info(f"PNA Backtrack initiated: from '{current_pre}' -> target '{target_norm}'")

        # ─── TIER 1: Modal / Drawer Dismissal ───
        if top_frame and top_frame.is_modal:
            logger.info("PNA Tier 1: Attempting modal/overlay dismissal...")
            dismissed = await session.dismiss_active_modal()
            if dismissed:
                self.pop()
                record = {"tier": 1, "method": "modal_dismiss", "success": True, "target_url": target_parent}
                self.backtrack_history.append(record)
                return record

        # Check if an in-page modal is actively blocking the viewport
        try:
            modal_check = await session.evaluate("""(() => {
                const modal = document.querySelector('[role="dialog"], dialog[open], .modal.show, [aria-modal="true"], .overlay-active');
                return Boolean(modal && window.getComputedStyle(modal).display !== 'none');
            })()""")
            if modal_check:
                logger.info("PNA Tier 1: Active modal detected on page. Dismissing...")
                await session.dismiss_active_modal()
                if top_frame and top_frame.is_modal:
                    self.pop()
                    return {"tier": 1, "method": "active_modal_dismiss", "success": True, "target_url": target_parent}
        except Exception:
            pass

        # ─── TIER 2: History Back Navigation ───
        logger.info("PNA Tier 2: Executing window.history.back()...")
        try:
            await session.send_command("Runtime.evaluate", {"expression": "window.history.back();"})
            await session.wait_for_quiescence(network_idle_ms=250, dom_quiet_ms=100, scroll_quiet_ms=80, max_timeout_s=3.0)
            await session.extract_interactive_tree()
            current_post = (session.current_url or "").rstrip("/").lower()
            if current_post != current_pre and (current_post == target_norm or target_norm in current_post or len(self.stack) > 1):
                self.pop()
                record = {"tier": 2, "method": "history_back", "success": True, "target_url": current_post}
                self.backtrack_history.append(record)
                return record
        except Exception as e:
            logger.debug(f"PNA Tier 2 notice: {e}")

        # ─── TIER 3: Breadcrumb / Section Link Navigation ───
        logger.info("PNA Tier 3: Checking breadcrumb and navigation trail...")
        try:
            target_path = urlparse(target_parent).path.rstrip("/") or "/"
            breadcrumb_click = await session.evaluate(f"""(() => {{
                const crumbs = Array.from(document.querySelectorAll('nav[aria-label*="breadcrumb" i] a, .breadcrumb a, ol.breadcrumb li a, [class*="breadcrumb"] a, a[class*="back"]'));
                for (const a of crumbs) {{
                    const href = (a.getAttribute('href') || '').toLowerCase();
                    if (href === '{target_path}' || href.endsWith('{target_path}') || (a.innerText || '').toLowerCase().includes('back')) {{
                        a.click();
                        return true;
                    }}
                }}
                return false;
            }})()""")
            if breadcrumb_click:
                await session.wait_for_quiescence(network_idle_ms=250, dom_quiet_ms=100, max_timeout_s=3.0)
                await session.extract_interactive_tree()
                current_post = (session.current_url or "").rstrip("/").lower()
                if current_post != current_pre:
                    self.pop()
                    record = {"tier": 3, "method": "breadcrumb_click", "success": True, "target_url": current_post}
                    self.backtrack_history.append(record)
                    return record
        except Exception as e:
            logger.debug(f"PNA Tier 3 notice: {e}")

        # ─── TIER 4: Direct Route Fallback Navigation ───
        logger.info(f"PNA Tier 4: Direct fallback route navigation to '{target_parent}'...")
        try:
            await session.navigate(target_parent)
            await session.wait_for_quiescence(network_idle_ms=300, dom_quiet_ms=120, max_timeout_s=4.0)
            await session.extract_interactive_tree()
            self.pop()
            record = {"tier": 4, "method": "direct_navigate", "success": True, "target_url": target_parent}
            self.backtrack_history.append(record)
            return record
        except Exception as e:
            logger.error(f"PNA Tier 4 direct navigation failed: {e}")
            return {"tier": 4, "method": "direct_navigate", "success": False, "error": str(e)}

    def get_stack_summary(self) -> List[Dict[str, Any]]:
        return [frame.to_dict() for frame in self.stack]
