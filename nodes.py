"""Phosphor - CRT-styled AI chat sidebar for ComfyUI workflow building."""

import json
import pathlib
from aiohttp import web
from server import PromptServer

WORKFLOWS_DIR = pathlib.Path(__file__).parent / "workflows"

# Serve built-in workflow templates

@PromptServer.instance.routes.get("/phosphor/workflows")
async def list_workflows(request):
    files = []
    if WORKFLOWS_DIR.exists():
        for f in sorted(WORKFLOWS_DIR.glob("*.json")):
            files.append({"name": f.stem, "size": f.stat().st_size})
    return web.json_response(files)


@PromptServer.instance.routes.get("/phosphor/workflow/{name}")
async def get_workflow(request):
    name = request.match_info["name"]
    path = WORKFLOWS_DIR / f"{name}.json"
    if not path.exists():
        return web.json_response({"error": "not found"}, status=404)
    data = json.loads(path.read_text(encoding="utf-8"))
    return web.json_response(data)


@PromptServer.instance.routes.post("/phosphor/workflow/save")
async def save_workflow(request):
    try:
        data = await request.json()
        name = data.get("name", "").strip()
        workflow = data.get("workflow")
        if not name:
            return web.json_response({"error": "name required"}, status=400)
        if not workflow:
            return web.json_response({"error": "workflow required"}, status=400)
        safe = "".join(c if c.isalnum() or c in "-_ " else "" for c in name).strip()
        safe = safe.replace(" ", "_")
        if not safe:
            return web.json_response({"error": "invalid name"}, status=400)
        WORKFLOWS_DIR.mkdir(parents=True, exist_ok=True)
        path = WORKFLOWS_DIR / f"{safe}.json"
        path.write_text(json.dumps(workflow, indent=2), encoding="utf-8")
        return web.json_response({"success": True, "name": safe})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@PromptServer.instance.routes.delete("/phosphor/workflow/{name}")
async def delete_workflow(request):
    name = request.match_info["name"]
    path = WORKFLOWS_DIR / f"{name}.json"
    if not path.exists():
        return web.json_response({"error": "not found"}, status=404)
    path.unlink()
    return web.json_response({"success": True})


# Minimal node (ComfyUI requires at least one for extension loading)

class Phosphor:
    @classmethod
    def INPUT_TYPES(cls):
        return {"optional": {}}

    RETURN_TYPES = ()
    FUNCTION = "noop"
    CATEGORY = "phosphor"
    OUTPUT_NODE = True

    def noop(self):
        return ()


NODE_CLASS_MAPPINGS = {"Phosphor": Phosphor}
NODE_DISPLAY_NAME_MAPPINGS = {"Phosphor": "Phosphor Chat"}
