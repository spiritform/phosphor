/**
 * HermesTab — CRT-styled Hermes chat sidebar for ComfyUI
 * Build, modify, and understand workflows through natural language.
 */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ═══════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════
const CFG = {
    ollamaHost: localStorage.getItem("hermes.host") || "http://127.0.0.1:11434",
    model:      localStorage.getItem("hermes.model") || "hermes3:8b",
    keepAlive:  "5m",
    maxToolIter: 4,
};

// ═══════════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════════
const S = {
    history:   [],
    busy:      false,
    open:      false,
    connected: false,
    width: parseInt(localStorage.getItem("hermes.panelWidth")) || 420,
    // DOM refs (set in buildPanel)
    panel: null, log: null, input: null, dot: null, badge: null, toggle: null,
};

// ═══════════════════════════════════════════════════════
//  TOOL DEFINITIONS  (sent to Hermes in system prompt)
// ═══════════════════════════════════════════════════════
const TOOL_DEFS = [
    {
        type: "function",
        function: {
            name: "get_canvas_info",
            description: "Get all nodes on the ComfyUI canvas with their IDs, types, positions, connections, and widget values. Use this to understand the current workflow.",
            parameters: { type: "object", properties: {} }
        }
    },
    {
        type: "function",
        function: {
            name: "search_nodes",
            description: "Search available ComfyUI node types by keyword. Returns matching type names, categories, inputs, and outputs. Use this to find the correct type name before add_node.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Search keyword (e.g. 'checkpoint', 'sampler', 'clip', 'vae', 'lora', 'upscale')" }
                },
                required: ["query"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "get_models",
            description: "List available models installed in ComfyUI (checkpoints, LoRAs, VAEs).",
            parameters: {
                type: "object",
                properties: {
                    type: { type: "string", description: "'checkpoints', 'loras', 'vae', or 'all' (default: 'all')" }
                }
            }
        }
    },
    {
        type: "function",
        function: {
            name: "add_node",
            description: "Add a new node to the canvas. Returns the node's assigned ID and its widgets. Space nodes ~300px apart.",
            parameters: {
                type: "object",
                properties: {
                    type: { type: "string", description: "Exact node type name (e.g. 'CheckpointLoaderSimple', 'KSampler', 'CLIPTextEncode')" },
                    x:    { type: "number", description: "X position on canvas (default 100)" },
                    y:    { type: "number", description: "Y position on canvas (default 100)" }
                },
                required: ["type"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "remove_node",
            description: "Remove a node from the canvas by its ID.",
            parameters: {
                type: "object",
                properties: {
                    node_id: { type: "number", description: "ID of the node to remove" }
                },
                required: ["node_id"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "connect_nodes",
            description: "Wire an output slot of one node to an input slot of another. Slot indices start at 0.",
            parameters: {
                type: "object",
                properties: {
                    from_id:   { type: "number", description: "Source node ID" },
                    from_slot: { type: "number", description: "Output slot index on source" },
                    to_id:     { type: "number", description: "Target node ID" },
                    to_slot:   { type: "number", description: "Input slot index on target" }
                },
                required: ["from_id", "from_slot", "to_id", "to_slot"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "set_widget",
            description: "Set a widget value on a node (text, seed, steps, cfg, sampler_name, scheduler, denoise, ckpt_name, etc).",
            parameters: {
                type: "object",
                properties: {
                    node_id:     { type: "number", description: "Node ID" },
                    widget_name: { type: "string", description: "Widget name" },
                    value:       { description: "New value (string, number, or boolean)" }
                },
                required: ["node_id", "widget_name", "value"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "load_workflow",
            description: "Load a complete workflow JSON onto the canvas, replacing the current graph. Accepts ComfyUI editor-format JSON (with nodes[] and links[] arrays).",
            parameters: {
                type: "object",
                properties: {
                    workflow: { type: "object", description: "Complete workflow JSON in ComfyUI editor format" }
                },
                required: ["workflow"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "load_template",
            description: "Load a built-in workflow template by name. Use list_templates first to see available templates.",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string", description: "Template name (without .json extension)" }
                },
                required: ["name"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "list_templates",
            description: "List available built-in workflow templates.",
            parameters: { type: "object", properties: {} }
        }
    },
    {
        type: "function",
        function: {
            name: "queue_prompt",
            description: "Queue the current workflow for execution (generate output).",
            parameters: { type: "object", properties: {} }
        }
    },
    {
        type: "function",
        function: {
            name: "clear_canvas",
            description: "Remove ALL nodes from the canvas. Ask for confirmation before using.",
            parameters: { type: "object", properties: {} }
        }
    },
    {
        type: "function",
        function: {
            name: "build_workflow",
            description: "Build a COMPLETE workflow on the canvas in one step. Clears canvas first. Use 0-based indices for connections (0=first node, 1=second, etc). PREFERRED way to create workflows.",
            parameters: {
                type: "object",
                properties: {
                    nodes: {
                        type: "array",
                        description: "Nodes in order. Each: {type: 'NodeClassName', widgets: {name: value}}",
                        items: {
                            type: "object",
                            properties: {
                                type: { type: "string", description: "Node class type" },
                                widgets: { type: "object", description: "Widget name:value pairs to set" }
                            },
                            required: ["type"]
                        }
                    },
                    connections: {
                        type: "array",
                        description: "Wiring. from/to = node index (0-based), from_slot = output slot, to_slot = input slot",
                        items: {
                            type: "object",
                            properties: {
                                from: { type: "number" }, from_slot: { type: "number" },
                                to: { type: "number" }, to_slot: { type: "number" }
                            },
                            required: ["from", "from_slot", "to", "to_slot"]
                        }
                    }
                },
                required: ["nodes", "connections"]
            }
        }
    }
];

// ═══════════════════════════════════════════════════════
//  SYSTEM PROMPT
// ═══════════════════════════════════════════════════════
const SYS_PROMPT = `You are a function calling AI model. You are provided with function signatures within <tools></tools> XML tags. You may call one or more functions to assist with the user query. Here are the available tools:
<tools>
${JSON.stringify(TOOL_DEFS)}
</tools>

You are also a ComfyUI workflow assistant. You help users understand, modify, and run workflows.

For each function call return a json object with function name and arguments within <tool_call></tool_call> XML tags:
<tool_call>
{"name": "function_name", "arguments": {"arg1": "value1"}}
</tool_call>

You are a ComfyUI workflow assistant. Act immediately. No apologies. No asking permission. No explaining plans.

When modifying a workflow:
1. Call get_canvas_info to find node IDs
2. Call set_widget to change values
That's it. Two calls max.

Templates: sd15_txt2img, sdxl_txt2img, flux_dev_txt2img, sdxl_img2img, sdxl_inpaint, upscale_4x, animatediff_video, wan_video_t2v
When user wants a workflow, call load_template with the best match immediately.

CLIPTextEncode widget name is "text". KSampler widgets: seed, steps, cfg, sampler_name, scheduler, denoise. CheckpointLoaderSimple widget: ckpt_name.

Only call queue_prompt if user says "run" or "generate". Maximum 1 sentence of text per response.`;

// ═══════════════════════════════════════════════════════
//  STYLES
// ═══════════════════════════════════════════════════════
const STYLES = `
/* ── Panel ── */
#hm-panel {
    position: fixed; top: 0; right: 0;
    padding-top: 34px;
    width: var(--hm-w, 420px); height: 100vh;
    background: #040e0b;
    border-left: 1px solid #1a5a3a;
    box-shadow: -4px 0 24px rgba(51,255,170,0.04);
    z-index: 1000;
    display: flex; flex-direction: column;
    font-family: 'Consolas', 'Menlo', 'Monaco', 'Courier New', monospace;
    font-size: 13px;
    color: #e0fff5;
    transform: translateX(100%);
    transition: transform 0.28s ease;
    overflow: hidden;
}
#hm-panel.open { transform: translateX(0); }

/* Push ComfyUI canvas and menu when open */
body.hm-open .comfyui-menu,
body.hm-open header.comfyui-menu { right: var(--hm-w, 420px) !important; transition: right 0.28s ease; }
body.hm-open #graph-canvas,
body.hm-open .graph-canvas-container,
body.hm-open .litegraph.litegraph-canvas { width: calc(100vw - var(--hm-w, 420px)) !important; transition: width 0.28s ease; }
body.hm-resizing #hm-panel,
body.hm-resizing .comfyui-menu,
body.hm-resizing #graph-canvas,
body.hm-resizing .graph-canvas-container,
body.hm-resizing .litegraph.litegraph-canvas { transition: none !important; }

/* ── Toggle tab ── */
#hm-toggle {
    position: fixed; right: 8px; bottom: 8px;
    background: #0a1f18;
    color: #33ffaa;
    border: 1px solid #1a5a3a;
    border-radius: 6px;
    width: 38px; height: 38px;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; z-index: 999;
    font-family: 'Courier New', monospace;
    font-size: 16px;
    text-shadow: 0 0 8px rgba(51,255,170,0.4);
    transition: all 0.2s;
    user-select: none;
}
#hm-toggle:hover {
    background: #0f2e22;
    text-shadow: 0 0 14px rgba(51,255,170,0.7);
    box-shadow: 0 0 12px rgba(51,255,170,0.2);
}

/* ── Scanlines ── */
#hm-scan {
    position: absolute; inset: 0;
    background: repeating-linear-gradient(
        to bottom, transparent 0px, transparent 2px,
        rgba(0,0,0,0.05) 2px, rgba(0,0,0,0.05) 4px
    );
    pointer-events: none; z-index: 5;
}

/* ── Glow line (left border) ── */
#hm-panel::before {
    content: '';
    position: absolute; left: 0; top: 0;
    width: 1px; height: 100%;
    background: linear-gradient(to bottom,
        transparent 0%, #33ffaa44 20%, #33ffaa88 50%, #33ffaa44 80%, transparent 100%);
    z-index: 6;
}

/* ── Header ── */
#hm-header {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 14px;
    border-bottom: 1px solid #1a5a3a;
    background: #061510;
    flex-shrink: 0;
    position: relative; z-index: 6;
}
.hm-title {
    font-size: 14px; font-weight: bold;
    color: #33ffaa;
    text-shadow: 0 0 10px rgba(51,255,170,0.5), 0 0 20px rgba(51,255,170,0.2);
    flex-grow: 1;
    letter-spacing: 1px;
}
.hm-dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: #553333;
    box-shadow: 0 0 4px #55333388;
    transition: all 0.3s;
    flex-shrink: 0;
}
.hm-dot.on {
    background: #33ff88;
    box-shadow: 0 0 8px #33ff88aa;
}
.hm-model-badge {
    font-size: 10px; color: #aaddcc;
    background: #0a2218;
    padding: 2px 8px;
    border-radius: 3px;
    border: 1px solid #1a4a3a;
}
.hm-hdr-btn {
    background: none; border: none;
    color: #899; cursor: pointer;
    font-size: 15px; padding: 2px 5px;
    font-family: monospace;
    transition: color 0.2s;
}
.hm-hdr-btn:hover { color: #33ffaa; }

/* ── Settings ── */
#hm-settings {
    max-height: 0; overflow: hidden;
    transition: max-height 0.3s ease;
    background: #071612;
    border-bottom: 1px solid transparent;
}
#hm-settings.open {
    max-height: 200px;
    border-bottom-color: #1a5a3a;
}
#hm-settings-inner {
    padding: 10px 14px;
}
.hm-srow {
    display: flex; align-items: center; gap: 8px;
    margin-bottom: 8px;
}
.hm-srow label {
    font-size: 11px; color: #aaddcc; min-width: 46px;
}
.hm-srow input {
    flex: 1; background: #0a1f18; border: 1px solid #1a4a3a;
    color: #c8fff0; font-family: monospace; font-size: 12px;
    padding: 4px 8px; border-radius: 3px; outline: none;
}
.hm-srow input:focus { border-color: #33ffaa; }
.hm-btn {
    background: #0f2e22; border: 1px solid #1a5a3a;
    color: #33ffaa; font-family: monospace; font-size: 11px;
    padding: 4px 14px; border-radius: 3px; cursor: pointer;
    transition: background 0.2s;
}
.hm-btn:hover { background: #1a4a3a; }

/* ── Template bar ── */
#hm-template-bar {
    display: flex; align-items: center; gap: 6px;
    padding: 6px 14px;
    border-bottom: 1px solid #1a5a3a;
    background: #071612;
    flex-shrink: 0;
    position: relative; z-index: 6;
}
#hm-template-select {
    flex: 1;
    background: #0a1f18;
    border: 1px solid #1a4a3a;
    color: #c8fff0;
    font-family: 'Consolas', 'Menlo', monospace;
    font-size: 11px;
    padding: 4px 8px;
    border-radius: 3px;
    outline: none;
    cursor: pointer;
}
#hm-template-select:focus { border-color: #33ffaa; }
#hm-template-select option {
    background: #0a1f18;
    color: #c8fff0;
}

/* ── Log ── */
#hm-log {
    flex: 1; overflow-y: auto; overflow-x: hidden;
    padding: 12px 14px;
    scroll-behavior: smooth;
    position: relative; z-index: 1;
}
#hm-log::-webkit-scrollbar { width: 5px; }
#hm-log::-webkit-scrollbar-track { background: transparent; }
#hm-log::-webkit-scrollbar-thumb { background: #1a5a3a; border-radius: 3px; }

/* ── Messages ── */
.hm-msg {
    margin-bottom: 12px; line-height: 1.55;
    word-wrap: break-word; white-space: pre-wrap;
}
.hm-prefix {
    font-weight: bold; margin-right: 4px;
    display: inline;
}
.hm-body { display: inline; }

.hm-msg-user .hm-prefix { color: #ffee66; }
.hm-msg-user .hm-body   { color: #ffee66; }

.hm-msg-bot .hm-prefix { color: #33ffaa; }
.hm-msg-bot .hm-body   {
    color: #e8fff5;
    text-shadow: 0 0 5px rgba(51,255,170,0.12);
}

.hm-msg-sys {
    color: #7faa99; font-style: italic; font-size: 12px;
    margin-bottom: 8px;
}
.hm-msg-err { color: #ff5555; }
.hm-msg-err .hm-prefix { color: #ff5555; }

/* ── Tool blocks ── */
.hm-tool-block {
    margin: 6px 0; padding: 5px 10px;
    background: #081a14;
    border-left: 2px solid #2288aa;
    font-size: 12px; color: #aaddcc;
    border-radius: 0 4px 4px 0;
}
.hm-tool-block summary {
    color: #44aaff; outline: none;
    cursor: pointer; user-select: none;
    list-style: none;
}
.hm-tool-block summary::-webkit-details-marker { display: none; }
.hm-tool-block summary::before { content: '\\25b8 '; color: #44aaff; }
.hm-tool-block[open] summary::before { content: '\\25be '; }
.hm-tool-result {
    margin-top: 6px; white-space: pre-wrap;
    max-height: 180px; overflow-y: auto;
    font-size: 11px; color: #99ccbb;
    padding: 4px 0;
}
.hm-tool-result::-webkit-scrollbar { width: 4px; }
.hm-tool-result::-webkit-scrollbar-thumb { background: #1a4a3a; border-radius: 2px; }

/* ── Input area ── */
#hm-input-area {
    display: flex; align-items: flex-end;
    padding: 10px 14px;
    border-top: 1px solid #1a5a3a;
    background: #061510;
    flex-shrink: 0;
    position: relative; z-index: 6;
}
.hm-prompt-char {
    color: #33ffaa; font-weight: bold;
    padding: 3px 0; margin-right: 6px;
    text-shadow: 0 0 6px rgba(51,255,170,0.4);
    user-select: none;
}
#hm-input {
    flex: 1; background: transparent; border: none;
    color: #ffee66; font-family: 'Consolas', 'Menlo', 'Monaco', 'Courier New', monospace;
    font-size: 13px; resize: none;
    outline: none; min-height: 20px; max-height: 120px;
    line-height: 1.4;
}
#hm-input::placeholder { color: #558870; }
#hm-input:disabled { opacity: 0.5; }

/* ── Hint ── */
#hm-hint {
    padding: 3px 14px 8px;
    font-size: 10px; color: #5a9980;
    background: #061510;
    flex-shrink: 0;
    position: relative; z-index: 6;
}

/* ── Resize handle ── */
#hm-resize {
    position: absolute; left: -3px; top: 0;
    width: 7px; height: 100%;
    cursor: col-resize; z-index: 10;
}
#hm-resize:hover { background: rgba(51,255,170,0.1); }

/* ── Cursor blink ── */
.hm-cursor .hm-body::after {
    content: '\\2588';
    animation: hm-blink 0.7s step-end infinite;
    color: #33ffaa;
    margin-left: 1px;
}
@keyframes hm-blink { 50% { opacity: 0; } }

/* ── Welcome ASCII ── */
.hm-welcome {
    color: #3a8a6a; font-size: 11px;
    line-height: 1.3; margin-bottom: 10px;
    text-shadow: 0 0 6px rgba(51,255,170,0.15);
}
`;

// ═══════════════════════════════════════════════════════
//  NODE INFO CACHE
// ═══════════════════════════════════════════════════════
let _objInfoCache = null;
async function getObjectInfo() {
    if (!_objInfoCache) {
        try {
            const res = await fetch("/object_info");
            if (res.ok) _objInfoCache = await res.json();
        } catch { /* ignore */ }
    }
    return _objInfoCache;
}

// ═══════════════════════════════════════════════════════
//  TOOL IMPLEMENTATIONS
// ═══════════════════════════════════════════════════════
// Detect API format: top-level keys are node IDs with class_type
function _isApiFormat(data) {
    if (data.nodes && Array.isArray(data.nodes)) return false; // editor format
    const keys = Object.keys(data).filter(k => !k.startsWith("_"));
    return keys.length > 0 && keys.every(k => data[k]?.class_type);
}

// Load API-format workflow onto canvas by creating nodes + wiring
async function _loadApiWorkflow(apiData) {
    app.graph.clear();
    const COL_W = 350, ROW_H = 280, START_X = 60, START_Y = 80, ROWS = 2;
    const nodeMap = {}; // api_id → created LiteGraph node
    const entries = Object.entries(apiData).filter(([k]) => !k.startsWith("_"));
    let i = 0;

    // Create nodes
    for (const [apiId, spec] of entries) {
        const node = LiteGraph.createNode(spec.class_type);
        if (!node) { i++; continue; }
        const col = Math.floor(i / ROWS);
        const row = i % ROWS;
        node.pos = [START_X + col * COL_W, START_Y + row * ROW_H];
        if (spec._meta?.title) node.title = spec._meta.title;
        app.graph.add(node);

        // Set widget values from inputs (non-array values are widgets)
        if (spec.inputs) {
            for (const [name, value] of Object.entries(spec.inputs)) {
                if (Array.isArray(value)) continue; // link, handle later
                const w = node.widgets?.find(wi => wi.name === name);
                if (w) {
                    w.value = value;
                    if (w.callback) w.callback(value);
                }
            }
        }
        nodeMap[apiId] = node;
        i++;
    }

    // Wait for nodes to register
    app.graph.setDirtyCanvas(true, true);
    await new Promise(r => setTimeout(r, 100));

    // Wire connections (array values in inputs are links: [source_id, output_slot])
    let connOk = 0;
    for (const [apiId, spec] of entries) {
        if (!spec.inputs) continue;
        const dst = nodeMap[apiId];
        if (!dst) continue;

        for (const [inputName, value] of Object.entries(spec.inputs)) {
            if (!Array.isArray(value)) continue;
            const [srcApiId, srcSlot] = value;
            const src = nodeMap[String(srcApiId)];
            if (!src) continue;

            // Find the input slot index by name
            const dstSlot = dst.inputs?.findIndex(inp => inp.name === inputName);
            if (dstSlot < 0) continue;

            try {
                src.connect(srcSlot, dst, dstSlot);
                connOk++;
            } catch { /* skip */ }
        }
    }

    app.graph.setDirtyCanvas(true, true);
    return { nodes: Object.keys(nodeMap).length, connections: connOk };
}

// Universal loader — handles both editor and API format
async function _loadWorkflowData(data, label) {
    const tag = label ? `"${label}"` : "Workflow";
    if (_isApiFormat(data)) {
        const result = await _loadApiWorkflow(data);
        return `${tag} loaded (${result.nodes} nodes, ${result.connections} connections)`;
    }
    // Editor format
    await app.loadGraphData(data);
    app.graph.setDirtyCanvas(true, true);
    const count = app.graph._nodes?.length || 0;
    return `${tag} loaded (${count} nodes)`;
}

const TOOL_IMPL = {

    async get_canvas_info() {
        const nodes = app.graph._nodes || [];
        const info = nodes.map(n => ({
            id:      n.id,
            type:    n.type,
            title:   n.title,
            pos:     [Math.round(n.pos[0]), Math.round(n.pos[1])],
            inputs:  n.inputs?.map((inp, i) => ({
                slot: i, name: inp.name, type: inp.type, link: inp.link
            })) || [],
            outputs: n.outputs?.map((out, i) => ({
                slot: i, name: out.name, type: out.type, links: out.links
            })) || [],
            widgets: n.widgets?.map(w => ({
                name: w.name, value: w.value, type: w.type
            })) || [],
        }));
        return JSON.stringify({ count: info.length, nodes: info }, null, 1);
    },

    async search_nodes({ query }) {
        const info = await getObjectInfo();
        if (!info) {
            // Fallback to LiteGraph registered types
            const types = Object.keys(LiteGraph.registered_node_types || {});
            const q = query.toLowerCase();
            const matches = types.filter(t => t.toLowerCase().includes(q)).slice(0, 25);
            return JSON.stringify(matches);
        }
        const q = query.toLowerCase();
        const matches = Object.keys(info)
            .filter(k => k.toLowerCase().includes(q))
            .slice(0, 20)
            .map(k => {
                const n = info[k];
                return {
                    type: k,
                    category: n.category,
                    inputs: Object.keys(n.input?.required || {}),
                    optional_inputs: Object.keys(n.input?.optional || {}),
                    outputs: n.output,
                    output_names: n.output_name,
                };
            });
        return JSON.stringify(matches, null, 1);
    },

    async get_models({ type = "all" } = {}) {
        const info = await getObjectInfo();
        if (!info) return JSON.stringify({ error: "Could not fetch node info" });

        const result = {};
        if (type === "all" || type === "checkpoints") {
            const ckpt = info["CheckpointLoaderSimple"];
            if (ckpt?.input?.required?.ckpt_name)
                result.checkpoints = ckpt.input.required.ckpt_name[0];
        }
        if (type === "all" || type === "loras") {
            const lora = info["LoraLoader"];
            if (lora?.input?.required?.lora_name)
                result.loras = lora.input.required.lora_name[0];
        }
        if (type === "all" || type === "vae") {
            const vae = info["VAELoader"];
            if (vae?.input?.required?.vae_name)
                result.vae = vae.input.required.vae_name[0];
        }
        return JSON.stringify(result, null, 1);
    },

    async add_node({ type, x, y }) {
        const node = LiteGraph.createNode(type);
        if (!node) return `Error: node type "${type}" not found. Use search_nodes to find the correct name.`;
        node.pos = [x ?? 100, y ?? 100];
        app.graph.add(node);
        app.graph.setDirtyCanvas(true, true);
        return JSON.stringify({
            id:      node.id,
            type:    node.type,
            pos:     node.pos,
            widgets: node.widgets?.map(w => ({ name: w.name, type: w.type, value: w.value })) || [],
            inputs:  node.inputs?.map((inp, i) => ({ slot: i, name: inp.name, type: inp.type })) || [],
            outputs: node.outputs?.map((out, i) => ({ slot: i, name: out.name, type: out.type })) || [],
        }, null, 1);
    },

    async remove_node({ node_id }) {
        const node = app.graph.getNodeById(node_id);
        if (!node) return `Error: node ${node_id} not found`;
        app.graph.remove(node);
        app.graph.setDirtyCanvas(true, true);
        return `Removed node ${node_id} (${node.type})`;
    },

    async connect_nodes({ from_id, from_slot, to_id, to_slot }) {
        const src = app.graph.getNodeById(from_id);
        const dst = app.graph.getNodeById(to_id);
        if (!src) return `Error: source node ${from_id} not found`;
        if (!dst) return `Error: target node ${to_id} not found`;
        try {
            src.connect(from_slot, dst, to_slot);
            app.graph.setDirtyCanvas(true, true);
            const outName = src.outputs?.[from_slot]?.name || from_slot;
            const inName  = dst.inputs?.[to_slot]?.name || to_slot;
            return `Connected ${src.type}#${from_id}.${outName} → ${dst.type}#${to_id}.${inName}`;
        } catch (e) {
            return `Error connecting: ${e.message}`;
        }
    },

    async set_widget({ node_id, widget_name, value }) {
        const node = app.graph.getNodeById(node_id);
        if (!node) return `Error: node ${node_id} not found`;
        const w = node.widgets?.find(wi => wi.name === widget_name);
        if (!w) {
            const available = node.widgets?.map(wi => wi.name).join(", ") || "none";
            return `Error: widget "${widget_name}" not found. Available: ${available}`;
        }
        w.value = value;
        if (w.callback) w.callback(value);
        app.graph.setDirtyCanvas(true, true);
        return `Set ${node.type}#${node_id}.${widget_name} = ${JSON.stringify(value)}`;
    },

    async load_workflow({ workflow }) {
        if (!workflow) return "Error: no workflow data provided";
        try {
            const data = typeof workflow === "string" ? JSON.parse(workflow) : workflow;
            return await _loadWorkflowData(data);
        } catch (e) {
            return `Error loading workflow: ${e.message}`;
        }
    },

    async load_template({ name }) {
        try {
            const res = await fetch(`/hermes/workflow/${encodeURIComponent(name)}`);
            if (!res.ok) return `Error: template "${name}" not found`;
            const data = await res.json();
            return await _loadWorkflowData(data, name);
        } catch (e) {
            return `Error: ${e.message}`;
        }
    },

    async list_templates() {
        try {
            const res = await fetch("/hermes/workflows");
            if (!res.ok) return "No templates available";
            const list = await res.json();
            if (list.length === 0) return "No templates found in workflows/ directory";
            return JSON.stringify(list);
        } catch (e) {
            return `Error: ${e.message}`;
        }
    },

    async queue_prompt() {
        try {
            app.queuePrompt(0, 1);
            return "Prompt queued for execution.";
        } catch (e) {
            return `Error: ${e.message}`;
        }
    },

    async clear_canvas() {
        app.graph.clear();
        app.graph.setDirtyCanvas(true, true);
        return "Canvas cleared — all nodes removed.";
    },

    async build_workflow({ nodes = [], connections = [] }) {
        app.graph.clear();

        const created = [];
        const COL_W = 350;
        const ROW_H = 280;
        const START_X = 60;
        const START_Y = 80;
        const errors = [];

        // Layout: left-to-right, 2 rows max per column
        const ROWS = 2;
        for (let i = 0; i < nodes.length; i++) {
            const spec = nodes[i];
            const node = LiteGraph.createNode(spec.type);
            if (!node) {
                errors.push(`Node type "${spec.type}" not found`);
                created.push(null);
                continue;
            }
            const col = Math.floor(i / ROWS);
            const row = i % ROWS;
            node.pos = [START_X + col * COL_W, START_Y + row * ROW_H];

            app.graph.add(node);

            // Set widgets
            if (spec.widgets) {
                for (const [name, value] of Object.entries(spec.widgets)) {
                    const w = node.widgets?.find(wi => wi.name === name);
                    if (w) {
                        w.value = value;
                        if (w.callback) w.callback(value);
                    }
                }
            }
            created.push(node);
        }

        // Let LiteGraph register nodes before wiring
        app.graph.setDirtyCanvas(true, true);
        await new Promise(r => setTimeout(r, 100));

        // Wire connections
        let connOk = 0;
        for (const c of connections) {
            const src = created[c.from];
            const dst = created[c.to];
            if (!src || !dst) {
                errors.push(`Connection skipped: node ${c.from}\u2192${c.to} (missing node)`);
                continue;
            }
            try {
                const link = src.connect(c.from_slot, dst, c.to_slot);
                if (link !== null && link !== false && link !== undefined) {
                    connOk++;
                } else {
                    errors.push(`Wire ${src.type}:${c.from_slot}\u2192${dst.type}:${c.to_slot} returned null (type mismatch?)`);
                }
            } catch (e) {
                errors.push(`Wire ${c.from}:${c.from_slot}\u2192${c.to}:${c.to_slot} failed: ${e.message}`);
            }
        }

        app.graph.setDirtyCanvas(true, true);

        const summary = {
            nodes_created: created.filter(Boolean).length,
            connections_made: connOk,
            node_ids: created.filter(Boolean).map(n => ({ id: n.id, type: n.type })),
        };
        if (errors.length) summary.errors = errors;
        return JSON.stringify(summary, null, 1);
    },
};

// ═══════════════════════════════════════════════════════
//  CHAT ENGINE
// ═══════════════════════════════════════════════════════

async function streamOllama(messages, tools, onToken) {
    const body = {
        model:      CFG.model,
        messages,
        stream:     true,
        keep_alive: CFG.keepAlive,
    };
    if (tools) body.tools = tools;

    const res = await fetch(`${CFG.ollamaHost}/api/chat`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);

    const reader = res.body.getReader();
    const dec    = new TextDecoder();
    let fullText = "", buf = "";
    let toolCalls = [];

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const j = JSON.parse(line);
                if (j.message?.content) {
                    fullText += j.message.content;
                    onToken(j.message.content);
                }
                // Collect native tool calls
                if (j.message?.tool_calls) {
                    toolCalls = toolCalls.concat(j.message.tool_calls);
                }
            } catch { /* partial JSON, skip */ }
        }
    }
    if (buf.trim()) {
        try {
            const j = JSON.parse(buf);
            if (j.message?.content) {
                fullText += j.message.content;
                onToken(j.message.content);
            }
            if (j.message?.tool_calls) {
                toolCalls = toolCalls.concat(j.message.tool_calls);
            }
        } catch { /* ignore */ }
    }
    return { text: fullText, toolCalls };
}

function parseXmlToolCalls(text) {
    const re = /<tool_call>([\s\S]*?)<\/tool_call>/g;
    const calls = [];
    let m;
    while ((m = re.exec(text)) !== null) {
        try { calls.push(JSON.parse(m[1])); }
        catch { /* malformed */ }
    }
    return calls;
}

async function execToolCall(call) {
    const fn = TOOL_IMPL[call.name];
    if (!fn) return `Error: unknown tool "${call.name}"`;
    try {
        return await fn(call.arguments || {});
    } catch (e) {
        return `Error executing ${call.name}: ${e.message}`;
    }
}

// ═══════════════════════════════════════════════════════
//  UI RENDERING
// ═══════════════════════════════════════════════════════

function appendMsg(type, prefix, text) {
    const div = document.createElement("div");
    div.className = `hm-msg hm-msg-${type}`;

    if (prefix) {
        const pre = document.createElement("span");
        pre.className = "hm-prefix";
        pre.textContent = prefix;
        div.appendChild(pre);
    }

    const body = document.createElement("span");
    body.className = "hm-body";
    body.textContent = text || "";
    div.appendChild(body);

    S.log.appendChild(div);
    S.log.scrollTop = S.log.scrollHeight;
    return { div, body };
}

function appendToolBlock(name, args, result) {
    const details = document.createElement("details");
    details.className = "hm-tool-block";

    const summary = document.createElement("summary");
    const argKeys = typeof args === "object" && args
        ? Object.entries(args).map(([k,v]) => {
            const vs = typeof v === "string" ? v : JSON.stringify(v);
            return `${k}=${vs.length > 30 ? vs.slice(0,27) + "..." : vs}`;
          }).join(", ")
        : "";
    summary.textContent = `${name}(${argKeys})`;
    details.appendChild(summary);

    const res = document.createElement("div");
    res.className = "hm-tool-result";
    res.textContent = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    details.appendChild(res);

    S.log.appendChild(details);
    S.log.scrollTop = S.log.scrollHeight;
}

// ═══════════════════════════════════════════════════════
//  SEND / AGENT LOOP
// ═══════════════════════════════════════════════════════

async function handleSend(userText) {
    if (S.busy) return;
    S.busy = true;
    S.input.disabled = true;

    appendMsg("user", "> ", userText);
    S.history.push({ role: "user", content: userText });

    let lastCallSig = "";
    try {
        for (let iter = 0; iter < CFG.maxToolIter; iter++) {
            const msgs = [{ role: "system", content: SYS_PROMPT }, ...S.history];
            const { div: msgDiv, body: bodyEl } = appendMsg("bot", "hermes> ", "");
            msgDiv.classList.add("hm-cursor");

            let result;
            try {
                result = await streamOllama(msgs, null, (token) => {
                    msgDiv.classList.remove("hm-cursor");
                    bodyEl.textContent += token;
                    S.log.scrollTop = S.log.scrollHeight;
                });
            } catch (e) {
                msgDiv.classList.remove("hm-cursor");
                bodyEl.textContent = "";
                appendMsg("err", "! ", `Connection error: ${e.message}`);
                break;
            }

            msgDiv.classList.remove("hm-cursor");

            // Clean any XML tool_call tags from displayed text
            const cleanText = result.text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "").trim();
            bodyEl.textContent = cleanText;

            // Build assistant history entry
            const assistantMsg = { role: "assistant", content: result.text || "" };
            if (result.toolCalls.length > 0) {
                assistantMsg.tool_calls = result.toolCalls;
            }
            S.history.push(assistantMsg);

            // Parse tool calls from XML tags
            let calls = parseXmlToolCalls(result.text);
            // Native tool calls as fallback
            if (calls.length === 0 && result.toolCalls.length > 0) {
                calls = result.toolCalls.map(tc => ({
                    name: tc.function?.name,
                    arguments: typeof tc.function?.arguments === "string"
                        ? JSON.parse(tc.function.arguments)
                        : (tc.function?.arguments || {}),
                }));
            }

            if (calls.length === 0) break;

            // Detect duplicate calls (model repeating itself)
            const callSig = JSON.stringify(calls);
            if (callSig === lastCallSig) {
                appendMsg("sys", "", "Action already completed.");
                break;
            }
            lastCallSig = callSig;

            // Execute each tool and feed results back
            for (const call of calls) {
                const toolResult = await execToolCall(call);
                appendToolBlock(call.name, call.arguments, toolResult);
                S.history.push({ role: "tool", content: String(toolResult) });
            }
        }
    } finally {
        S.busy = false;
        S.input.disabled = false;
        S.input.focus();
    }
}

// ═══════════════════════════════════════════════════════
//  COMMANDS
// ═══════════════════════════════════════════════════════

function handleCommand(text) {
    const parts = text.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();

    switch (cmd) {
        case "/clear":
        case "/reset":
            S.history = [];
            while (S.log.firstChild) S.log.removeChild(S.log.firstChild);
            appendMsg("sys", "", "Chat cleared.");
            break;

        case "/model":
            if (parts[1]) {
                CFG.model = parts.slice(1).join(" ");
                localStorage.setItem("hermes.model", CFG.model);
                S.badge.textContent = CFG.model;
                S.history = [];
                while (S.log.firstChild) S.log.removeChild(S.log.firstChild);
                appendMsg("sys", "", `Model → ${CFG.model}. Chat cleared.`);
            } else {
                appendMsg("sys", "", `Current model: ${CFG.model}`);
            }
            break;

        case "/host":
            if (parts[1]) {
                CFG.ollamaHost = parts[1];
                localStorage.setItem("hermes.host", CFG.ollamaHost);
                appendMsg("sys", "", `Host → ${CFG.ollamaHost}`);
                checkConnection();
            } else {
                appendMsg("sys", "", `Current host: ${CFG.ollamaHost}`);
            }
            break;

        case "/workflow":
            handleSend("Describe the current workflow on the canvas in detail. Use get_canvas_info to inspect it.");
            break;

        case "/help":
            appendMsg("sys", "", [
                "COMMANDS",
                "  /clear       reset chat history",
                "  /model X     switch Ollama model",
                "  /host URL    change Ollama endpoint",
                "  /workflow    describe current canvas",
                "  /help        this message",
                "",
                "TIPS",
                "  \"build a txt2img workflow with SDXL\"",
                "  \"add an upscaler after the output\"",
                "  \"change steps to 30 and cfg to 7\"",
                "  \"what does this workflow do?\"",
                "  \"run it\" → queues the prompt",
                "",
                "SHORTCUTS",
                "  Ctrl+Shift+H  toggle panel",
                "  Enter         send message",
                "  Shift+Enter   new line",
            ].join("\n"));
            break;

        default:
            appendMsg("err", "! ", `Unknown command: ${cmd}. Type /help`);
    }
}

// ═══════════════════════════════════════════════════════
//  CONNECTION CHECK
// ═══════════════════════════════════════════════════════

async function checkConnection() {
    try {
        const res = await fetch(`${CFG.ollamaHost}/api/tags`, { signal: AbortSignal.timeout(3000) });
        S.connected = res.ok;
    } catch {
        S.connected = false;
    }
    if (S.dot) S.dot.classList.toggle("on", S.connected);
    return S.connected;
}

// ═══════════════════════════════════════════════════════
//  BUILD PANEL
// ═══════════════════════════════════════════════════════

function buildPanel() {
    // Inject styles
    const styleEl = document.createElement("style");
    styleEl.textContent = STYLES;
    document.head.appendChild(styleEl);

    // ── Toggle tab ──
    const toggle = document.createElement("div");
    toggle.id = "hm-toggle";
    toggle.textContent = "\u27e8H\u27e9";
    document.body.appendChild(toggle);

    // ── Panel ──
    const panel = document.createElement("div");
    panel.id = "hm-panel";

    // Scanlines overlay
    const scan = document.createElement("div");
    scan.id = "hm-scan";
    panel.appendChild(scan);

    // Resize handle
    const resize = document.createElement("div");
    resize.id = "hm-resize";
    panel.appendChild(resize);

    // ── Header ──
    const header = document.createElement("div");
    header.id = "hm-header";

    const title = document.createElement("span");
    title.className = "hm-title";
    title.textContent = "\u27e8HERMES\u27e9";

    const dot = document.createElement("span");
    dot.className = "hm-dot";

    const badge = document.createElement("span");
    badge.className = "hm-model-badge";
    badge.textContent = CFG.model;

    const settingsBtn = document.createElement("button");
    settingsBtn.className = "hm-hdr-btn";
    settingsBtn.textContent = "\u2699";
    settingsBtn.title = "Settings";

    const clearBtn = document.createElement("button");
    clearBtn.className = "hm-hdr-btn";
    clearBtn.textContent = "\u232b";
    clearBtn.title = "Clear chat";

    const closeBtn = document.createElement("button");
    closeBtn.className = "hm-hdr-btn";
    closeBtn.textContent = "\u2715";
    closeBtn.title = "Close";

    header.append(title, dot, badge, settingsBtn, clearBtn, closeBtn);
    panel.appendChild(header);

    // ── Settings ──
    const settings = document.createElement("div");
    settings.id = "hm-settings";

    const settingsInner = document.createElement("div");
    settingsInner.id = "hm-settings-inner";

    const hostRow = document.createElement("div");
    hostRow.className = "hm-srow";
    const hostLabel = document.createElement("label");
    hostLabel.textContent = "Host:";
    const hostInput = document.createElement("input");
    hostInput.value = CFG.ollamaHost;
    hostRow.append(hostLabel, hostInput);

    const modelRow = document.createElement("div");
    modelRow.className = "hm-srow";
    const modelLabel = document.createElement("label");
    modelLabel.textContent = "Model:";
    const modelInput = document.createElement("input");
    modelInput.value = CFG.model;
    modelRow.append(modelLabel, modelInput);

    const applyRow = document.createElement("div");
    applyRow.className = "hm-srow";
    applyRow.style.justifyContent = "flex-end";
    const applyBtn = document.createElement("button");
    applyBtn.className = "hm-btn";
    applyBtn.textContent = "Apply";
    applyRow.appendChild(applyBtn);

    settingsInner.append(hostRow, modelRow, applyRow);
    settings.appendChild(settingsInner);
    panel.appendChild(settings);

    // ── Template bar ──
    const templateBar = document.createElement("div");
    templateBar.id = "hm-template-bar";

    const templateSelect = document.createElement("select");
    templateSelect.id = "hm-template-select";
    const defaultOpt = document.createElement("option");
    defaultOpt.value = "";
    defaultOpt.textContent = "load template\u2026";
    templateSelect.appendChild(defaultOpt);

    const templateLoadBtn = document.createElement("button");
    templateLoadBtn.className = "hm-btn";
    templateLoadBtn.textContent = "Load";

    const templateSaveBtn = document.createElement("button");
    templateSaveBtn.className = "hm-btn";
    templateSaveBtn.textContent = "Save";
    templateSaveBtn.title = "Save current workflow to templates";

    templateBar.append(templateSelect, templateLoadBtn, templateSaveBtn);
    panel.appendChild(templateBar);

    // Populate templates from backend
    refreshTemplates();

    // Refresh dropdown options
    async function refreshTemplates() {
        while (templateSelect.options.length > 1) templateSelect.remove(1);
        try {
            const res = await fetch("/hermes/workflows");
            if (!res.ok) return;
            const list = await res.json();
            list.forEach(t => {
                const opt = document.createElement("option");
                opt.value = t.name;
                opt.textContent = t.name;
                templateSelect.appendChild(opt);
            });
        } catch { /* ignore */ }
    }

    // Load template on click
    templateLoadBtn.addEventListener("click", async () => {
        const name = templateSelect.value;
        if (!name) return;
        try {
            const res = await fetch(`/hermes/workflow/${encodeURIComponent(name)}`);
            if (!res.ok) { appendMsg("err", "! ", "Template not found"); return; }
            const data = await res.json();
            const result = await _loadWorkflowData(data, name);
            appendMsg("sys", "", result);
            templateSelect.value = "";
        } catch (e) {
            appendMsg("err", "! ", `Error: ${e.message}`);
        }
    });

    // Save current workflow
    templateSaveBtn.addEventListener("click", async () => {
        const name = prompt("Save workflow as:");
        if (!name || !name.trim()) return;
        try {
            const workflow = app.graph.serialize();
            const res = await fetch("/hermes/workflow/save", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: name.trim(), workflow }),
            });
            const data = await res.json();
            if (data.success) {
                appendMsg("sys", "", `Saved workflow: ${data.name}`);
                await refreshTemplates();
                templateSelect.value = data.name;
            } else {
                appendMsg("err", "! ", `Save failed: ${data.error}`);
            }
        } catch (e) {
            appendMsg("err", "! ", `Error: ${e.message}`);
        }
    });

    // ── Log ──
    const log = document.createElement("div");
    log.id = "hm-log";
    panel.appendChild(log);

    // ── Input area ──
    const inputArea = document.createElement("div");
    inputArea.id = "hm-input-area";

    const promptChar = document.createElement("span");
    promptChar.className = "hm-prompt-char";
    promptChar.textContent = ">";

    const input = document.createElement("textarea");
    input.id = "hm-input";
    input.rows = 1;
    input.placeholder = "ask hermes...";
    input.spellcheck = false;

    inputArea.append(promptChar, input);
    panel.appendChild(inputArea);

    // ── Hint ──
    const hint = document.createElement("div");
    hint.id = "hm-hint";
    hint.textContent = "enter send \u00b7 shift+enter newline \u00b7 /help commands \u00b7 ctrl+shift+h toggle";
    panel.appendChild(hint);

    document.body.appendChild(panel);

    // ── Store refs ──
    S.panel  = panel;
    S.log    = log;
    S.input  = input;
    S.dot    = dot;
    S.badge  = badge;
    S.toggle = toggle;

    // ── Set initial width ──
    panel.style.setProperty("--hm-w", S.width + "px");
    document.documentElement.style.setProperty("--hm-w", S.width + "px");

    // ═══════════════════════════════
    //  EVENT LISTENERS
    // ═══════════════════════════════

    // Toggle
    toggle.addEventListener("click", togglePanel);
    closeBtn.addEventListener("click", togglePanel);

    // Send
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            const text = input.value.trim();
            if (!text || S.busy) return;
            input.value = "";
            input.style.height = "auto";
            if (text.startsWith("/")) {
                handleCommand(text);
            } else {
                handleSend(text);
            }
        }
    });

    // Auto-resize textarea
    input.addEventListener("input", () => {
        input.style.height = "auto";
        input.style.height = Math.min(input.scrollHeight, 120) + "px";
    });

    // Settings toggle
    settingsBtn.addEventListener("click", () => {
        settings.classList.toggle("open");
    });

    // Apply settings
    applyBtn.addEventListener("click", () => {
        CFG.ollamaHost = hostInput.value.trim() || CFG.ollamaHost;
        CFG.model = modelInput.value.trim() || CFG.model;
        localStorage.setItem("hermes.host", CFG.ollamaHost);
        localStorage.setItem("hermes.model", CFG.model);
        badge.textContent = CFG.model;
        settings.classList.remove("open");
        checkConnection();
        appendMsg("sys", "", `Config updated \u2192 ${CFG.model} @ ${CFG.ollamaHost}`);
    });

    // Clear chat
    clearBtn.addEventListener("click", () => {
        handleCommand("/clear");
    });

    // Resize drag
    let resizing = false;
    resize.addEventListener("mousedown", (e) => {
        resizing = true;
        e.preventDefault();
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        document.body.classList.add("hm-resizing");
    });
    document.addEventListener("mousemove", (e) => {
        if (!resizing) return;
        const w = Math.max(300, Math.min(800, window.innerWidth - e.clientX));
        panel.style.setProperty("--hm-w", w + "px");
        document.documentElement.style.setProperty("--hm-w", w + "px");
        S.width = w;
    });
    document.addEventListener("mouseup", () => {
        if (!resizing) return;
        resizing = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        document.body.classList.remove("hm-resizing");
        localStorage.setItem("hermes.panelWidth", S.width);
        window.dispatchEvent(new Event("resize"));
    });

    // Global keyboard shortcut
    document.addEventListener("keydown", (e) => {
        if (e.ctrlKey && e.shiftKey && e.key === "H") {
            e.preventDefault();
            togglePanel();
        }
    });

    // Initial connection check
    checkConnection().then(ok => {
        if (ok) {
            appendMsg("sys", "", `connected to ${CFG.model} @ ${CFG.ollamaHost}`);
        } else {
            appendMsg("err", "! ",
                `Cannot reach Ollama at ${CFG.ollamaHost}\nMake sure Ollama is running, or use /host to change endpoint.`
            );
        }
        appendMsg("sys", "", "type /help for commands");
    });
}

// ═══════════════════════════════════════════════════════
//  TOGGLE
// ═══════════════════════════════════════════════════════

function togglePanel() {
    S.open = !S.open;
    S.panel.classList.toggle("open", S.open);
    S.toggle.style.display = S.open ? "none" : "block";
    document.body.classList.toggle("hm-open", S.open);
    document.documentElement.style.setProperty("--hm-w", S.width + "px");
    if (S.open) {
        S.input.focus();
    }
    setTimeout(() => window.dispatchEvent(new Event("resize")), 300);
}

// ═══════════════════════════════════════════════════════
//  REGISTER EXTENSION
// ═══════════════════════════════════════════════════════

app.registerExtension({
    name: "hermes.comfy",

    async setup() {
        buildPanel();
    },

    async nodeCreated(node) {
        // Hide the dummy node's widgets if placed on canvas
        if (node.comfyClass === "HermesTab") {
            if (node.widgets) {
                for (const w of node.widgets) w.hidden = true;
            }
            node.serialize_widgets = false;
        }
    },
});
