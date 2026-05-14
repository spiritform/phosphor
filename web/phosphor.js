/**
 * Phosphor — CRT-styled AI chat sidebar for ComfyUI
 * Build, modify, and understand workflows through natural language.
 * Provider-agnostic: works with OpenRouter, Ollama, or anything OpenAI-compatible.
 */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ═══════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════
const CFG = {
    provider:    localStorage.getItem("hermes.provider")    || "openrouter",  // "openrouter" | "ollama"
    apiBase:     localStorage.getItem("hermes.apiBase")     || "https://openrouter.ai/api/v1",
    apiKey:      localStorage.getItem("hermes.apiKey")      || "",
    apiModel:    localStorage.getItem("hermes.apiModel")    || localStorage.getItem("hermes.model") || "anthropic/claude-sonnet-4.6",
    ollamaHost:  localStorage.getItem("hermes.ollamaHost")  || "http://127.0.0.1:11434",
    ollamaModel: localStorage.getItem("hermes.ollamaModel") || "hermes3:8b",
    keepAlive:   "5m",
    maxToolIter: 4,
};

function currentModel() {
    return CFG.provider === "ollama" ? CFG.ollamaModel : CFG.apiModel;
}

// ═══════════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════════
const S = {
    history:   [],
    busy:      false,
    open:      false,
    connected: false,
    undoStack: [],   // canvas snapshots taken before each mutating tool call
    width: parseInt(localStorage.getItem("hermes.panelWidth")) || 420,
    // DOM refs (set in buildPanel)
    panel: null, log: null, input: null, provPill: null, badge: null, toggle: null,
};

// Tools that mutate the canvas — we snapshot before each of these runs.
const MUTATING_TOOLS = new Set([
    "add_node", "remove_node", "connect_nodes", "set_widget",
    "set_node_position", "set_node_size", "arrange_grid",
    "normalize_node_widths", "group_nodes",
    "load_workflow", "load_template", "clear_canvas", "build_workflow",
]);
const UNDO_STACK_MAX = 20;

// ═══════════════════════════════════════════════════════
//  TOOL DEFINITIONS  (sent to the model in system prompt)
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
            name: "set_node_position",
            description: "Move a single node to specific x,y coordinates on the canvas.",
            parameters: {
                type: "object",
                properties: {
                    node_id: { type: "number", description: "Node ID" },
                    x:       { type: "number", description: "X position" },
                    y:       { type: "number", description: "Y position" }
                },
                required: ["node_id", "x", "y"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "arrange_grid",
            description: "Auto-arrange ALL nodes on the canvas into a clean grid. Preferred way to tidy up a messy layout — one call does the whole canvas.",
            parameters: {
                type: "object",
                properties: {
                    columns:   { type: "number", description: "Number of columns (default 4)" },
                    spacing_x: { type: "number", description: "Horizontal spacing in px (default 350)" },
                    spacing_y: { type: "number", description: "Vertical spacing in px (default 280)" },
                    start_x:   { type: "number", description: "Starting X coordinate (default 60)" },
                    start_y:   { type: "number", description: "Starting Y coordinate (default 80)" }
                }
            }
        }
    },
    {
        type: "function",
        function: {
            name: "set_node_size",
            description: "Resize a single node. Pass width and/or height in pixels.",
            parameters: {
                type: "object",
                properties: {
                    node_id: { type: "number", description: "Node ID" },
                    width:   { type: "number", description: "New width in px" },
                    height:  { type: "number", description: "New height in px" }
                },
                required: ["node_id"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "normalize_node_widths",
            description: "Make every node on the canvas the same width. If `width` is omitted, uses the widest existing node so nothing gets clipped.",
            parameters: {
                type: "object",
                properties: {
                    width: { type: "number", description: "Target width in px (optional — defaults to widest existing node)" }
                }
            }
        }
    },
    {
        type: "function",
        function: {
            name: "group_nodes",
            description: "Wrap a set of nodes in a labeled ComfyUI group (a colored frame with a title). If node_ids is omitted, groups ALL nodes on the canvas.",
            parameters: {
                type: "object",
                properties: {
                    node_ids: { type: "array", items: { type: "number" }, description: "Optional list of node IDs to include. Omit to group everything on the canvas." },
                    title:    { type: "string", description: "Label shown at the top of the group (default \"Group\")" },
                    color:    { type: "string", description: "CSS color for the group frame (e.g. \"#3a5a3a\")" }
                }
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
            name: "undo",
            description: "Revert the last canvas-changing operation. Use this if the user says undo, revert, go back, or asks to take back the last change.",
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

═══ HARD RULES ═══

1. NEVER call queue_prompt unless the user uses one of these EXACT words: "run", "generate", "execute", "go", "queue".
   Words like "build", "create", "make", "load", "set up", "give me" do NOT mean run. Stop after loading.

2. NEVER claim a workflow "is running" or "started" or "generating". If you call queue_prompt, the only acceptable confirmation is "Queued." — anything else is a lie.

3. When loading a template that references a specific checkpoint file (e.g. sd_xl_base_1.0.safetensors), warn the user one line: "Note: needs <filename> — install via Manager if missing." Do NOT call queue_prompt.

═══ WORKFLOW PATTERNS ═══

The CURRENT CANVAS state is provided to you below (node IDs, types, widgets, and current values).
USE THOSE IDS DIRECTLY. You do NOT need to call get_canvas_info for routine widget edits —
the info you need is already in this prompt.

To change a widget: ONE call. set_widget(node_id=<from canvas above>, widget_name=..., value=...).
NEVER ask the user for a node ID — find it in the canvas snapshot.

Templates: sd15_txt2img, sdxl_txt2img, flux_dev_txt2img, sdxl_img2img, sdxl_inpaint, upscale_4x, animatediff_video, wan_video_t2v
When user wants a workflow, call load_template with the best match. STOP. Do not run it.

CLIPTextEncode widget name is "text". KSampler widgets: seed, steps, cfg, sampler_name, scheduler, denoise. CheckpointLoaderSimple widget: ckpt_name.

Maximum 1 sentence of text per response.`;

// ═══════════════════════════════════════════════════════
//  STYLES
// ═══════════════════════════════════════════════════════
const STYLES = `
/* ── Panel ── */
#hm-panel {
    position: fixed; top: var(--hm-top, 70px); right: 0;
    width: var(--hm-w, 420px); height: calc(100vh - var(--hm-top, 70px));
    background: rgba(4, 14, 11, 0.32);
    backdrop-filter: blur(22px) saturate(170%);
    -webkit-backdrop-filter: blur(22px) saturate(170%);
    border-left: 1px solid rgba(51, 255, 170, 0.28);
    border-top: 1px solid rgba(51, 255, 170, 0.18);
    box-shadow: -4px 0 32px rgba(51,255,170,0.08), inset 1px 0 0 rgba(51,255,170,0.06);
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

/* Panel sits below the top toolbar (no longer overlapping it) and floats above the canvas. */
body.hm-resizing #hm-panel { transition: none !important; }

/* ── Toggle tab ── */
#hm-toggle {
    position: fixed; right: 16px; bottom: 16px;
    background: #0a1f18;
    border: 1px solid #1a5a3a;
    border-radius: 6px;
    width: 38px; height: 38px;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; z-index: 99999;
    transition: all 0.2s;
    user-select: none;
}
#hm-toggle::before {
    content: '';
    display: block;
    width: 14px; height: 14px;
    border-radius: 50%;
    background: radial-gradient(circle at 35% 35%, #88ffcc 0%, #33ffaa 50%, #1a7a55 100%);
    box-shadow: 0 0 10px rgba(51,255,170,0.7), 0 0 18px rgba(51,255,170,0.3);
    transition: all 0.2s;
}
#hm-toggle:hover {
    background: #0f2e22;
    box-shadow: 0 0 12px rgba(51,255,170,0.25);
}
#hm-toggle:hover::before {
    box-shadow: 0 0 14px rgba(51,255,170,0.9), 0 0 24px rgba(51,255,170,0.5);
}

/* ── Scanlines ── */
#hm-scan {
    position: absolute; inset: 0;
    background: repeating-linear-gradient(
        to bottom, transparent 0px, transparent 2px,
        rgba(0,0,0,0.025) 2px, rgba(0,0,0,0.025) 4px
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
    border-bottom: 1px solid rgba(51, 255, 170, 0.18);
    background: rgba(6, 21, 16, 0.32);
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
/* Provider+model label, plain text (no pill/box). Same monospace as the panel. */
.hm-prov-label {
    font-size: 11px;
    color: #886655;
    transition: color 0.2s, text-shadow 0.2s;
    display: inline-flex;
    align-items: baseline;
}
.hm-prov-word {
    cursor: pointer;
    user-select: none;
    transition: color 0.15s, text-shadow 0.15s;
}
.hm-prov-word:hover {
    text-shadow: 0 0 6px rgba(51,255,170,0.5);
}
.hm-prov-sep { color: #4a7a6a; }
.hm-prov-model { color: inherit; opacity: 0.85; }
/* Color the whole label green when connected (replaces old dot indicator) */
.hm-prov-word.connected,
.hm-prov-word.connected ~ .hm-prov-model { color: #33ffaa; }
.hm-prov-word.connected ~ .hm-prov-sep { color: #2a8a6a; }
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
    background: rgba(7, 22, 18, 0.55);
    border-bottom: 1px solid transparent;
}
#hm-settings.open {
    max-height: 400px;
    border-bottom-color: rgba(51, 255, 170, 0.18);
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
.hm-srow input, .hm-srow select {
    flex: 1; background: #0a1f18; border: 1px solid #1a4a3a;
    color: #c8fff0; font-family: monospace; font-size: 12px;
    padding: 4px 8px; border-radius: 3px; outline: none;
}
.hm-srow input:focus, .hm-srow select:focus { border-color: #33ffaa; }
.hm-srow select option { background: #0a1f18; color: #c8fff0; }
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
    border-bottom: 1px solid rgba(51, 255, 170, 0.18);
    background: rgba(7, 22, 18, 0.28);
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

/* ── Tool blocks (low-key code-log style) ── */
.hm-tool-block {
    margin: 1px 0; padding: 1px 8px;
    background: transparent;
    border-left: 1px solid rgba(51, 255, 170, 0.18);
    font-size: 11px;
    color: rgba(122, 200, 165, 0.55);
    border-radius: 0;
    opacity: 0.7;
    transition: opacity 0.15s, border-color 0.15s;
}
/* Group consecutive tool blocks visually tighter */
.hm-tool-block + .hm-tool-block { margin-top: 0; }
.hm-tool-block:hover {
    opacity: 1;
    border-left-color: rgba(51, 255, 170, 0.5);
}
.hm-tool-block summary {
    color: rgba(122, 200, 165, 0.7); outline: none;
    cursor: pointer; user-select: none;
    list-style: none;
    font-family: 'Consolas', 'Menlo', monospace;
}
.hm-tool-block summary::-webkit-details-marker { display: none; }
.hm-tool-block summary::before { content: '\\203a '; color: rgba(51,255,170,0.4); }
.hm-tool-block[open] summary::before { content: '\\25be '; color: rgba(51,255,170,0.7); }
.hm-tool-block[open] { opacity: 1; }
.hm-tool-result {
    margin-top: 4px; white-space: pre-wrap;
    max-height: 180px; overflow-y: auto;
    font-size: 11px; color: rgba(153, 204, 187, 0.7);
    padding: 4px 0 4px 8px;
    border-top: 1px dotted rgba(51, 255, 170, 0.08);
}
.hm-tool-result::-webkit-scrollbar { width: 4px; }
.hm-tool-result::-webkit-scrollbar-thumb { background: #1a4a3a; border-radius: 2px; }

/* ── Input area ── */
#hm-input-area {
    display: flex; align-items: flex-end;
    padding: 10px 14px;
    border-top: 1px solid rgba(51, 255, 170, 0.18);
    background: rgba(6, 21, 16, 0.32);
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

/* Inline clear button next to the textarea (moved out of header) */
.hm-input-clear {
    background: none;
    border: none;
    color: rgba(122, 200, 165, 0.4);
    cursor: pointer;
    font-family: monospace;
    font-size: 14px;
    padding: 4px 6px;
    margin-left: 4px;
    align-self: center;
    transition: color 0.15s, text-shadow 0.15s;
    user-select: none;
}
.hm-input-clear:hover {
    color: #33ffaa;
    text-shadow: 0 0 8px rgba(51,255,170,0.5);
}

/* ── Hint ── */
#hm-hint {
    padding: 3px 14px 8px;
    font-size: 10px; color: #5a9980;
    background: rgba(6, 21, 16, 0.32);
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

    async set_node_position({ node_id, x, y }) {
        const node = app.graph.getNodeById(node_id);
        if (!node) return `Error: node ${node_id} not found`;
        node.pos = [x, y];
        app.graph.setDirtyCanvas(true, true);
        return `Moved ${node.type}#${node_id} → (${x}, ${y})`;
    },

    async arrange_grid({ columns = 4, spacing_x = 350, spacing_y = 280, start_x = 60, start_y = 80 } = {}) {
        const nodes = app.graph._nodes || [];
        if (nodes.length === 0) return "Canvas is empty — nothing to arrange.";
        nodes.forEach((node, i) => {
            const col = i % columns;
            const row = Math.floor(i / columns);
            node.pos = [start_x + col * spacing_x, start_y + row * spacing_y];
        });
        app.graph.setDirtyCanvas(true, true);
        return `Arranged ${nodes.length} nodes in a ${columns}-column grid.`;
    },

    async set_node_size({ node_id, width, height }) {
        const node = app.graph.getNodeById(node_id);
        if (!node) return `Error: node ${node_id} not found`;
        if (!node.size) node.size = [200, 100];
        if (width  != null) node.size[0] = width;
        if (height != null) node.size[1] = height;
        app.graph.setDirtyCanvas(true, true);
        return `Resized ${node.type}#${node_id} to (${node.size[0]}, ${node.size[1]})`;
    },

    async normalize_node_widths({ width } = {}) {
        const nodes = app.graph._nodes || [];
        if (nodes.length === 0) return "Canvas is empty.";
        const targetWidth = width != null
            ? width
            : Math.max(...nodes.map(n => (n.size && n.size[0]) || 200));
        nodes.forEach(n => {
            if (!n.size) n.size = [targetWidth, 100];
            else n.size[0] = targetWidth;
        });
        app.graph.setDirtyCanvas(true, true);
        return `Set all ${nodes.length} nodes to width ${targetWidth}px.`;
    },

    async group_nodes({ node_ids, title = "Group", color = "#3a5a3a" } = {}) {
        let nodes;
        if (Array.isArray(node_ids) && node_ids.length > 0) {
            nodes = node_ids.map(id => app.graph.getNodeById(id)).filter(Boolean);
        } else {
            nodes = (app.graph._nodes || []).slice();
        }
        if (nodes.length === 0) return "No nodes to group.";

        // Compute bounding box, with padding + extra top for the group title bar
        const PAD = 20;
        const TITLE_BAR = 30;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const n of nodes) {
            const [x, y] = n.pos || [0, 0];
            const [w, h] = n.size || [200, 100];
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x + w > maxX) maxX = x + w;
            if (y + h > maxY) maxY = y + h;
        }
        minX -= PAD; minY -= PAD + TITLE_BAR;
        maxX += PAD; maxY += PAD;

        if (!LiteGraph.LGraphGroup) {
            return "Error: this ComfyUI version does not expose LGraphGroup.";
        }
        const group = new LiteGraph.LGraphGroup();
        group.title = title;
        if (group.color !== undefined) group.color = color;
        group.bounding = [minX, minY, maxX - minX, maxY - minY];
        app.graph.add(group);
        app.graph.setDirtyCanvas(true, true);
        return `Created group "${title}" around ${nodes.length} nodes.`;
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
            const res = await fetch(`/phosphor/workflow/${encodeURIComponent(name)}`);
            if (!res.ok) return `Error: template "${name}" not found`;
            const data = await res.json();
            return await _loadWorkflowData(data, name);
        } catch (e) {
            return `Error: ${e.message}`;
        }
    },

    async list_templates() {
        try {
            const res = await fetch("/phosphor/workflows");
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

    async undo() {
        if (S.undoStack.length === 0) {
            return "Nothing to undo.";
        }
        const snapshot = S.undoStack.pop();
        try {
            await app.loadGraphData(snapshot);
            app.graph.setDirtyCanvas(true, true);
            return `Reverted (${S.undoStack.length} undo${S.undoStack.length === 1 ? "" : "s"} left).`;
        } catch (e) {
            return `Error during undo: ${e.message}`;
        }
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
//  CANVAS SNAPSHOT (auto-injected into system message)
// ═══════════════════════════════════════════════════════
// Saves the model a get_canvas_info round-trip on every request
// — huge win for smaller models that flake on chaining.

function getCanvasSnapshot() {
    const nodes = app.graph?._nodes || [];
    if (nodes.length === 0) {
        return "═══ CURRENT CANVAS ═══\n(empty — no nodes on canvas)";
    }
    const lines = nodes.map(n => {
        const widgets = (n.widgets || [])
            .map(w => {
                let v = w.value;
                if (typeof v === "string" && v.length > 80) v = v.slice(0, 77) + "...";
                return `${w.name}=${JSON.stringify(v)}`;
            })
            .join(", ");
        const title = n.title && n.title !== n.type ? ` "${n.title}"` : "";
        return `#${n.id} ${n.type}${title}${widgets ? " | " + widgets : ""}`;
    });
    return `═══ CURRENT CANVAS (${nodes.length} nodes) ═══\n${lines.join("\n")}`;
}

// ═══════════════════════════════════════════════════════
//  CHAT ENGINE
// ═══════════════════════════════════════════════════════

async function streamChat(messages, tools, onToken) {
    return CFG.provider === "ollama"
        ? streamOllama(messages, tools, onToken)
        : streamOpenRouter(messages, tools, onToken);
}

async function streamOpenRouter(messages, _tools, onToken) {
    if (!CFG.apiKey) {
        throw new Error("No API key set. Open settings (⚙) and paste your OpenRouter key.");
    }

    const body = {
        model:    CFG.apiModel,
        messages,
        stream:   true,
    };

    const res = await fetch(`${CFG.apiBase}/chat/completions`, {
        method: "POST",
        headers: {
            "Content-Type":  "application/json",
            "Authorization": `Bearer ${CFG.apiKey}`,
            "HTTP-Referer":  location.origin,
            "X-Title":       "Phosphor",
        },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`HTTP ${res.status}: ${err.slice(0, 200)}`);
    }

    const reader = res.body.getReader();
    const dec    = new TextDecoder();
    let fullText = "", buf = "";
    const toolCalls = [];

    const processLine = (line) => {
        if (!line.startsWith("data:")) return;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") return;
        try {
            const j = JSON.parse(data);
            const delta = j.choices?.[0]?.delta;
            if (delta?.content) {
                fullText += delta.content;
                onToken(delta.content);
            }
        } catch { /* partial / non-JSON SSE event */ }
    };

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) processLine(line);
    }
    if (buf.trim()) processLine(buf);
    return { text: fullText, toolCalls };
}

async function streamOllama(messages, tools, onToken) {
    const body = {
        model:      CFG.ollamaModel,
        messages,
        stream:     true,
        keep_alive: CFG.keepAlive,
        options:    { temperature: 0.2 },
    };
    if (tools) body.tools = tools;

    const res = await fetch(`${CFG.ollamaHost}/api/chat`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);

    const reader = res.body.getReader();
    const dec    = new TextDecoder();
    let fullText = "", buf = "";
    let toolCalls = [];

    const processLine = (line) => {
        if (!line.trim()) return;
        try {
            const j = JSON.parse(line);
            if (j.message?.content) {
                fullText += j.message.content;
                onToken(j.message.content);
            }
            if (j.message?.tool_calls) {
                toolCalls = toolCalls.concat(j.message.tool_calls);
            }
        } catch { /* partial JSON */ }
    };

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) processLine(line);
    }
    if (buf.trim()) processLine(buf);
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
    // Snapshot the canvas before any mutating tool — gives us undo.
    if (MUTATING_TOOLS.has(call.name)) {
        try {
            S.undoStack.push(app.graph.serialize());
            if (S.undoStack.length > UNDO_STACK_MAX) S.undoStack.shift();
        } catch { /* serialize failed — skip, not critical */ }
    }
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
            // Auto-inject canvas state so the model can skip get_canvas_info
            // and call set_widget directly with known node IDs.
            const sysContent = SYS_PROMPT + "\n\n" + getCanvasSnapshot();
            const msgs = [{ role: "system", content: sysContent }, ...S.history];
            const { div: msgDiv, body: bodyEl } = appendMsg("bot", "phosphor>", "");
            msgDiv.classList.add("hm-cursor");

            let result;
            try {
                // Pass tool defs only to local Ollama (it uses them natively).
                // OpenRouter path already gets them via the XML system prompt.
                const toolsForCall = CFG.provider === "ollama" ? TOOL_DEFS : null;
                result = await streamChat(msgs, toolsForCall, (token) => {
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
            if (cleanText) {
                bodyEl.textContent = cleanText;
            } else {
                // No prose content — model only emitted tool calls. Drop the empty "hermes>" line.
                msgDiv.remove();
            }

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

            // Execute each tool and feed results back as user messages
            // (avoids the OpenAI requirement for tool_call_id/call_id on `role: tool` messages,
            //  since we use XML <tool_call> blocks rather than native function calling)
            for (const call of calls) {
                const toolResult = await execToolCall(call);
                appendToolBlock(call.name, call.arguments, toolResult);
                S.history.push({
                    role: "user",
                    content: `<tool_response name="${call.name}">\n${String(toolResult)}\n</tool_response>`,
                });
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

        case "/base":
            if (parts[1]) {
                CFG.apiBase = parts[1];
                localStorage.setItem("hermes.apiBase", CFG.apiBase);
                appendMsg("sys", "", `API base → ${CFG.apiBase}`);
                checkConnection();
            } else {
                appendMsg("sys", "", `Current API base: ${CFG.apiBase}`);
            }
            break;

        case "/key":
            if (parts[1]) {
                CFG.apiKey = parts.slice(1).join(" ");
                localStorage.setItem("hermes.apiKey", CFG.apiKey);
                appendMsg("sys", "", `API key set (${CFG.apiKey.length} chars)`);
                checkConnection();
            } else {
                appendMsg("sys", "", CFG.apiKey ? `API key: ${CFG.apiKey.slice(0,7)}...${CFG.apiKey.slice(-4)}` : "No API key set");
            }
            break;

        case "/workflow":
            handleSend("Describe the current workflow on the canvas in detail. Use get_canvas_info to inspect it.");
            break;

        case "/undo":
            execToolCall({ name: "undo", arguments: {} }).then(result => {
                appendMsg("sys", "", result);
            });
            break;

        case "/help":
            appendMsg("sys", "", [
                "COMMANDS",
                "  /clear       reset chat history",
                "  /undo        revert last canvas change",
                "  /model X     switch model (e.g. anthropic/claude-sonnet-4.6)",
                "  /key X       set API key",
                "  /base URL    change API base URL",
                "  /workflow    describe current canvas",
                "  /help        this message",
                "",
                "TIPS",
                "  \"load the sdxl template\"",
                "  \"change steps to 30, cfg to 7\"",
                "  \"change prompt to a neon city at night\"",
                "  \"switch the checkpoint to flux-dev\"",
                "  \"arrange the nodes in a grid\"",
                "  \"undo that\" → revert last change",
                "  \"what does this workflow do?\"",
                "  \"run it\" → queues the prompt",
                "",
                "PROVIDER",
                "  click  Local / API  in header to toggle",
                "  click  ⚙           to set key, base, model",
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
    if (CFG.provider === "ollama") {
        try {
            const res = await fetch(`${CFG.ollamaHost}/api/tags`, { signal: AbortSignal.timeout(3000) });
            S.connected = res.ok;
        } catch {
            S.connected = false;
        }
    } else {
        if (!CFG.apiKey) {
            S.connected = false;
        } else {
            try {
                const res = await fetch(`${CFG.apiBase}/models`, {
                    headers: { "Authorization": `Bearer ${CFG.apiKey}` },
                    signal:  AbortSignal.timeout(5000),
                });
                S.connected = res.ok;
            } catch {
                S.connected = false;
            }
        }
    }
    if (S.provPill) S.provPill.classList.toggle("connected", S.connected);
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
    // Icon is drawn purely via CSS (#hm-toggle::before) \u2014 no font dependency.
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
    title.textContent = "\u25cf PHOSPHOR";

    // Combined provider/model label: "Local : qwen2.5:14b"
    // Clicking the provider word toggles API ↔ LOCAL. Color reflects connection.
    const provInfo = document.createElement("span");
    provInfo.className = "hm-prov-label";

    const provWord = document.createElement("span");
    provWord.className = "hm-prov-word";
    provWord.textContent = CFG.provider === "ollama" ? "Local" : "API";
    provWord.title = "Click to toggle API ↔ LOCAL";

    const provSep = document.createElement("span");
    provSep.className = "hm-prov-sep";
    provSep.textContent = " : ";

    const modelText = document.createElement("span");
    modelText.className = "hm-prov-model";
    modelText.textContent = currentModel();

    provInfo.append(provWord, provSep, modelText);

    // Compatibility aliases so existing code that references provPill / badge keeps working.
    const provPill = provWord;
    const badge = modelText;

    const settingsBtn = document.createElement("button");
    settingsBtn.className = "hm-hdr-btn";
    settingsBtn.textContent = "\u2699";
    settingsBtn.title = "Settings";

    const closeBtn = document.createElement("button");
    closeBtn.className = "hm-hdr-btn";
    closeBtn.textContent = "\u2715";
    closeBtn.title = "Close";

    header.append(title, provInfo, settingsBtn, closeBtn);
    panel.appendChild(header);

    // ── Settings ──
    const settings = document.createElement("div");
    settings.id = "hm-settings";

    const settingsInner = document.createElement("div");
    settingsInner.id = "hm-settings-inner";

    // ── Provider toggle ──
    const provRow = document.createElement("div");
    provRow.className = "hm-srow";
    const provLabel = document.createElement("label");
    provLabel.textContent = "Mode:";
    const provInput = document.createElement("select");
    for (const [v, t] of [["openrouter", "API (OpenRouter)"], ["ollama", "Local (Ollama)"]]) {
        const opt = document.createElement("option");
        opt.value = v; opt.textContent = t;
        if (v === CFG.provider) opt.selected = true;
        provInput.appendChild(opt);
    }
    provRow.append(provLabel, provInput);

    // ── API-mode rows ──
    const keyRow = document.createElement("div");
    keyRow.className = "hm-srow";
    const keyLabel = document.createElement("label");
    keyLabel.textContent = "Key:";
    const keyInput = document.createElement("input");
    keyInput.type = "password";
    keyInput.value = CFG.apiKey;
    keyInput.placeholder = "sk-or-v1-...";
    keyRow.append(keyLabel, keyInput);

    const baseRow = document.createElement("div");
    baseRow.className = "hm-srow";
    const baseLabel = document.createElement("label");
    baseLabel.textContent = "Base:";
    const baseInput = document.createElement("input");
    baseInput.value = CFG.apiBase;
    baseRow.append(baseLabel, baseInput);

    // ── Local-mode row ──
    const hostRow = document.createElement("div");
    hostRow.className = "hm-srow";
    const hostLabel = document.createElement("label");
    hostLabel.textContent = "Host:";
    const hostInput = document.createElement("input");
    hostInput.value = CFG.ollamaHost;
    hostInput.placeholder = "http://127.0.0.1:11434";
    hostRow.append(hostLabel, hostInput);

    // ── Model rows (one per provider, only the active one is shown) ──
    const API_PRESETS = [
        { id: "anthropic/claude-sonnet-4.6",          label: "Claude Sonnet 4.6  (top tool-caller)" },
        { id: "anthropic/claude-opus-4.6",            label: "Claude Opus 4.6  (smartest)" },
        { id: "anthropic/claude-haiku-4.5",           label: "Claude Haiku 4.5  (cheapest)" },
        { id: "nousresearch/hermes-4-405b",           label: "Hermes 4 405B  (Nous flagship)" },
        { id: "nousresearch/hermes-4-70b",            label: "Hermes 4 70B  (Nous)" },
        { id: "openai/gpt-5",                         label: "GPT-5" },
        { id: "openai/gpt-5-mini",                    label: "GPT-5 mini" },
        { id: "google/gemini-2.5-pro",                label: "Gemini 2.5 Pro" },
        { id: "meta-llama/llama-3.3-70b-instruct",    label: "Llama 3.3 70B" },
        { id: "qwen/qwen-2.5-72b-instruct",           label: "Qwen 2.5 72B" },
    ];
    const OLLAMA_PRESETS = [
        { id: "hermes3:8b",      label: "Hermes 3 8B" },
        { id: "hermes3:70b",     label: "Hermes 3 70B" },
        { id: "llama3.2",        label: "Llama 3.2" },
        { id: "llama3.2:3b",     label: "Llama 3.2 3B" },
        { id: "qwen2.5",         label: "Qwen 2.5" },
        { id: "qwen2.5-coder",   label: "Qwen 2.5 Coder" },
        { id: "mistral",         label: "Mistral" },
        { id: "phi4",            label: "Phi 4" },
    ];

    const buildModelSelect = (presets, currentValue) => {
        const sel = document.createElement("select");
        let found = false;
        for (const m of presets) {
            const opt = document.createElement("option");
            opt.value = m.id; opt.textContent = m.label;
            if (m.id === currentValue) { opt.selected = true; found = true; }
            sel.appendChild(opt);
        }
        if (!found && currentValue) {
            const opt = document.createElement("option");
            opt.value = currentValue;
            opt.textContent = `${currentValue}  (custom)`;
            opt.selected = true;
            sel.appendChild(opt);
        }
        return sel;
    };

    const apiModelRow = document.createElement("div");
    apiModelRow.className = "hm-srow";
    const apiModelLabel = document.createElement("label");
    apiModelLabel.textContent = "Model:";
    const apiModelInput = buildModelSelect(API_PRESETS, CFG.apiModel);
    apiModelRow.append(apiModelLabel, apiModelInput);

    const ollamaModelRow = document.createElement("div");
    ollamaModelRow.className = "hm-srow";
    const ollamaModelLabel = document.createElement("label");
    ollamaModelLabel.textContent = "Model:";
    const ollamaModelInput = buildModelSelect(OLLAMA_PRESETS, CFG.ollamaModel);
    ollamaModelRow.append(ollamaModelLabel, ollamaModelInput);

    // Live-refresh ollama models from /api/tags so the dropdown reflects
    // what's actually installed (not a hardcoded list).
    const refreshOllamaModels = async () => {
        try {
            const res = await fetch(`${hostInput.value.trim() || CFG.ollamaHost}/api/tags`, {
                signal: AbortSignal.timeout(3000),
            });
            if (!res.ok) return;
            const data = await res.json();
            const installed = (data.models || []).map(m => ({
                id: m.name,
                label: `${m.name}  (${(m.size / 1e9).toFixed(1)} GB)`,
            }));
            if (installed.length === 0) return;
            const prev = ollamaModelInput.value;
            ollamaModelInput.innerHTML = "";
            let found = false;
            for (const m of installed) {
                const opt = document.createElement("option");
                opt.value = m.id; opt.textContent = m.label;
                if (m.id === prev) { opt.selected = true; found = true; }
                ollamaModelInput.appendChild(opt);
            }
            if (!found && prev) {
                const opt = document.createElement("option");
                opt.value = prev; opt.textContent = `${prev}  (not installed)`;
                opt.selected = true;
                ollamaModelInput.appendChild(opt);
            }
        } catch { /* ollama unreachable — keep hardcoded presets */ }
    };
    refreshOllamaModels();

    const applyRow = document.createElement("div");
    applyRow.className = "hm-srow";
    applyRow.style.justifyContent = "flex-end";
    const applyBtn = document.createElement("button");
    applyBtn.className = "hm-btn";
    applyBtn.textContent = "Apply";
    applyRow.appendChild(applyBtn);

    settingsInner.append(provRow, keyRow, baseRow, hostRow, apiModelRow, ollamaModelRow, applyRow);

    // Show/hide rows based on selected provider
    const syncProviderRows = () => {
        const p = provInput.value;
        keyRow.style.display         = p === "openrouter" ? "" : "none";
        baseRow.style.display        = p === "openrouter" ? "" : "none";
        apiModelRow.style.display    = p === "openrouter" ? "" : "none";
        hostRow.style.display        = p === "ollama"     ? "" : "none";
        ollamaModelRow.style.display = p === "ollama"     ? "" : "none";
        if (p === "ollama") refreshOllamaModels();
    };
    syncProviderRows();
    provInput.addEventListener("change", syncProviderRows);
    hostInput.addEventListener("change", refreshOllamaModels);
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
            const res = await fetch("/phosphor/workflows");
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
            const res = await fetch(`/phosphor/workflow/${encodeURIComponent(name)}`);
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
            const res = await fetch("/phosphor/workflow/save", {
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
    input.placeholder = "ask phosphor...";
    input.spellcheck = false;

    const clearBtn = document.createElement("button");
    clearBtn.className = "hm-input-clear";
    clearBtn.textContent = "⌫";
    clearBtn.title = "Clear chat";

    inputArea.append(promptChar, input, clearBtn);
    panel.appendChild(inputArea);

    // ── Hint ──
    const hint = document.createElement("div");
    hint.id = "hm-hint";
    hint.textContent = "enter send \u00b7 shift+enter newline \u00b7 /help commands \u00b7 ctrl+shift+h toggle";
    panel.appendChild(hint);

    document.body.appendChild(panel);

    // ── Store refs ──
    S.panel    = panel;
    S.log      = log;
    S.input    = input;
    S.provPill = provPill;
    S.badge    = badge;
    S.toggle   = toggle;

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
        CFG.provider    = provInput.value;
        CFG.apiKey      = keyInput.value.trim();
        CFG.apiBase     = baseInput.value.trim() || CFG.apiBase;
        CFG.apiModel    = apiModelInput.value.trim() || CFG.apiModel;
        CFG.ollamaHost  = hostInput.value.trim() || CFG.ollamaHost;
        CFG.ollamaModel = ollamaModelInput.value.trim() || CFG.ollamaModel;
        localStorage.setItem("hermes.provider",    CFG.provider);
        localStorage.setItem("hermes.apiKey",      CFG.apiKey);
        localStorage.setItem("hermes.apiBase",     CFG.apiBase);
        localStorage.setItem("hermes.apiModel",    CFG.apiModel);
        localStorage.setItem("hermes.ollamaHost",  CFG.ollamaHost);
        localStorage.setItem("hermes.ollamaModel", CFG.ollamaModel);
        badge.textContent = currentModel();
        provPill.textContent = CFG.provider === "ollama" ? "Local" : "API";
        settings.classList.remove("open");
        checkConnection();
        const endpoint = CFG.provider === "ollama" ? CFG.ollamaHost : CFG.apiBase;
        appendMsg("sys", "", `Config updated \u2192 ${currentModel()} @ ${endpoint}`);
    });

    // Clear chat
    clearBtn.addEventListener("click", () => {
        handleCommand("/clear");
    });

    // Provider pill toggle
    provPill.addEventListener("click", () => {
        CFG.provider = CFG.provider === "ollama" ? "openrouter" : "ollama";
        localStorage.setItem("hermes.provider", CFG.provider);
        provPill.textContent = CFG.provider === "ollama" ? "Local" : "API";
        provInput.value = CFG.provider;
        syncProviderRows();
        badge.textContent = currentModel();
        const endpoint = CFG.provider === "ollama" ? CFG.ollamaHost : CFG.apiBase;
        appendMsg("sys", "", `Switched to ${CFG.provider === "ollama" ? "LOCAL" : "API"} → ${currentModel()} @ ${endpoint}`);
        checkConnection();
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
        const endpoint = CFG.provider === "ollama" ? CFG.ollamaHost : CFG.apiBase;
        const tag = CFG.provider === "ollama" ? "LOCAL" : "API";
        if (ok) {
            appendMsg("sys", "", `[${tag}] connected to ${currentModel()} @ ${endpoint}`);
        } else if (CFG.provider === "openrouter" && !CFG.apiKey) {
            appendMsg("err", "! ",
                `No API key set.\nClick ⚙ to open settings and paste your OpenRouter key,\nor toggle to LOCAL via the API/LOCAL pill.`
            );
        } else {
            appendMsg("err", "! ",
                `Cannot reach ${endpoint}\nCheck settings (⚙) or toggle provider via the API/LOCAL pill.`
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
    S.toggle.style.display = S.open ? "none" : "flex";
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
    name: "phosphor.comfy",

    async setup() {
        buildPanel();
    },

    async nodeCreated(node) {
        // Hide the dummy node's widgets if placed on canvas
        if (node.comfyClass === "Phosphor") {
            if (node.widgets) {
                for (const w of node.widgets) w.hidden = true;
            }
            node.serialize_widgets = false;
        }
    },
});
