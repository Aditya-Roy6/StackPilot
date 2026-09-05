from typing import Any, Dict, List
import httpx
import os

AGENT_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_deployment_status",
            "description": "Get the current status, runtime URL, image, and health of a deployment",
            "parameters": {
                "type": "object",
                "properties": {
                    "deployment_id": {"type": "string", "description": "UUID of the deployment"}
                },
                "required": ["deployment_id"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_deployment_logs",
            "description": "Retrieve build or runtime logs for a deployment",
            "parameters": {
                "type": "object",
                "properties": {
                    "deployment_id": {"type": "string", "description": "UUID of the deployment"},
                    "log_type": {"type": "string", "enum": ["build", "runtime"], "description": "Type of logs"}
                },
                "required": ["deployment_id", "log_type"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "trigger_build",
            "description": "Queue a new build for a deployment",
            "parameters": {
                "type": "object",
                "properties": {
                    "deployment_id": {"type": "string", "description": "UUID of the deployment"}
                },
                "required": ["deployment_id"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "repair_deployment",
            "description": "Analyze and auto-fix a deployment's build or runtime issues. Use this when the user asks to fix an issue.",
            "parameters": {
                "type": "object",
                "properties": {
                    "deployment_id": {"type": "string", "description": "UUID of the deployment"},
                    "problem_description": {"type": "string", "description": "User's description of what's wrong"}
                },
                "required": ["deployment_id", "problem_description"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "list_deployments",
            "description": "List all deployments with their current status and runtime URLs",
            "parameters": {"type": "object", "properties": {}}
        }
    },
    {
        "type": "function",
        "function": {
            "name": "list_projects",
            "description": "List all projects the user owns",
            "parameters": {"type": "object", "properties": {}}
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_deployment_metrics",
            "description": "Get CPU, memory, and network metrics for a deployment",
            "parameters": {
                "type": "object",
                "properties": {
                    "deployment_id": {"type": "string", "description": "UUID of the deployment"}
                },
                "required": ["deployment_id"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "scale_deployment",
            "description": "Scale a deployment to a specified number of replicas",
            "parameters": {
                "type": "object",
                "properties": {
                    "deployment_id": {"type": "string", "description": "UUID of the deployment"},
                    "replicas": {"type": "integer", "description": "Target replica count (0-50)"}
                },
                "required": ["deployment_id", "replicas"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_kubernetes_events",
            "description": "Get Kubernetes events for a deployment to diagnose crash loops",
            "parameters": {
                "type": "object",
                "properties": {
                    "deployment_id": {"type": "string", "description": "UUID of the deployment"}
                },
                "required": ["deployment_id"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "workspace_list_files",
            "description": "List files and directories in a project or deployment source workspace. Use this to explore the project structure, locate configs, and inspect codebase layout before answering questions or making edits.",
            "parameters": {
                "type": "object",
                "properties": {
                    "deployment_id": {"type": "string", "description": "UUID of the deployment (optional if project_id is provided)"},
                    "project_id": {"type": "string", "description": "UUID of the project (optional if deployment_id is provided)"},
                    "path": {"type": "string", "description": "Relative subdirectory path to list (default: root)"}
                }
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "workspace_read_file",
            "description": "Read the contents of a file in a project or deployment source workspace. Use this to inspect code, package.json, Dockerfile, configs, etc.",
            "parameters": {
                "type": "object",
                "properties": {
                    "deployment_id": {"type": "string", "description": "UUID of the deployment (optional if project_id is provided)"},
                    "project_id": {"type": "string", "description": "UUID of the project (optional if deployment_id is provided)"},
                    "file_path": {"type": "string", "description": "Relative path to the file within the source directory"}
                },
                "required": ["file_path"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "workspace_write_file",
            "description": "Create or overwrite a file in a project or deployment source workspace. Use this for creating new files or complete rewrites.",
            "parameters": {
                "type": "object",
                "properties": {
                    "deployment_id": {"type": "string", "description": "UUID of the deployment (optional if project_id is provided)"},
                    "project_id": {"type": "string", "description": "UUID of the project (optional if deployment_id is provided)"},
                    "file_path": {"type": "string", "description": "Relative path for the file within the source directory"},
                    "content": {"type": "string", "description": "The full content to write to the file"}
                },
                "required": ["file_path", "content"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "workspace_edit_file",
            "description": "Perform a surgical find-and-replace edit in a project or deployment source file. Use this for targeted code fixes.",
            "parameters": {
                "type": "object",
                "properties": {
                    "deployment_id": {"type": "string", "description": "UUID of the deployment (optional if project_id is provided)"},
                    "project_id": {"type": "string", "description": "UUID of the project (optional if deployment_id is provided)"},
                    "file_path": {"type": "string", "description": "Relative path to the file within the source directory"},
                    "target": {"type": "string", "description": "The exact text to find in the file"},
                    "replacement": {"type": "string", "description": "The text to replace the target with"}
                },
                "required": ["file_path", "target", "replacement"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "workspace_trigger_rebuild",
            "description": "Trigger a rebuild of a deployment from its modified source files without re-cloning from git. Use this after making file edits to apply fixes.",
            "parameters": {
                "type": "object",
                "properties": {
                    "deployment_id": {"type": "string", "description": "UUID of the deployment"}
                },
                "required": ["deployment_id"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "wait_for_deployment",
            "description": "Wait and poll for a deployment rebuild or startup to finish. Blocks until the deployment reaches 'running' or 'failed', or until timeout. Use this immediately after calling workspace_trigger_rebuild so you can verify that the deployment is actually live and running before giving your final report.",
            "parameters": {
                "type": "object",
                "properties": {
                    "deployment_id": {"type": "string", "description": "UUID of the deployment to wait for"},
                    "timeout_seconds": {"type": "integer", "description": "Maximum seconds to wait (10 to 180, default 90)"}
                },
                "required": ["deployment_id"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "terminal_run_command",
            "description": "Execute a terminal command directly in the project or deployment workspace according to the OS (PowerShell is the active execution shell). Use PowerShell cmdlets or cross-platform utilities (e.g. 'Get-Content package.json', 'cat package.json', 'Select-String', 'Get-ChildItem', 'npm test', 'node -v', 'git status'). Returns stdout, stderr, exit_code, and shell.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "The PowerShell/terminal command to execute in the workspace"},
                    "deployment_id": {"type": "string", "description": "UUID of the deployment (optional if project_id is provided)"},
                    "project_id": {"type": "string", "description": "UUID of the project (optional if deployment_id is provided)"}
                },
                "required": ["command"]
            }
        }
    }
]

async def execute_tool_call(tool_name: str, arguments: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    """Execute a tool by calling the C++ backend."""
    if tool_name in {"list_functions", "list_tools", "get_tools"}:
        return {"tools": [t["function"]["name"] for t in AGENT_TOOLS]}

    backend_url = os.getenv("STACKPILOT_INTERNAL_API", "http://backend:8090").rstrip("/")
    token = os.getenv("STACKPILOT_AI_SERVICE_TOKEN", "").strip()
    
    headers = {"Content-Type": "application/json"}
    if token:
        headers["X-StackPilot-Service-Token"] = token
        
    payload = {
        "tool_name": tool_name,
        "arguments": arguments,
        "user_id": user_id
    }
    
    try:
        async with httpx.AsyncClient(timeout=180.0) as client:
            resp = await client.post(f"{backend_url}/api/v1/ai/tools/execute", json=payload, headers=headers)
            resp.raise_for_status()
            resp_json = resp.json()
            if isinstance(resp_json, dict) and resp_json.get("status") in {"written", "edited"}:
                resp_json["next_step_hint"] = "File changes applied to workspace. You can now call workspace_trigger_rebuild with deployment_id to rebuild, or synthesize your final diagnosis and report to the user."
            elif isinstance(resp_json, dict) and resp_json.get("status") == "rebuild_queued":
                resp_json["next_step_hint"] = "Rebuild has been queued. You MUST now call wait_for_deployment with deployment_id to wait for the build to complete and verify it reaches running status."
            return resp_json
    except Exception as e:
        return {"error": f"Tool execution failed: {str(e)}"}
