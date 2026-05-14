# Phosphor — Tool & Feature Inventory

A reference for everything the sidebar can do. Tools are callable by the AI; system features describe how the sidebar itself behaves.

---

## Tools (callable by the AI)

### Inspection (read-only)
| Tool | Description |
|---|---|
| `get_canvas_info()` | List every node, widget, connection (mostly redundant now since canvas state auto-injects on every request). |
| `search_nodes(query)` | Find node types by keyword. |
| `get_models(type?)` | List installed checkpoints, LoRAs, VAEs. |
| `list_templates()` | Show saved workflow templates in `workflows/`. |

### Canvas mutation
| Tool | Description |
|---|---|
| `add_node(type, x?, y?)` | Drop a new node onto the canvas. |
| `remove_node(node_id)` | Delete a node. |
| `connect_nodes(from_id, from_slot, to_id, to_slot)` | Wire an output → an input. |
| `set_widget(node_id, widget_name, value)` | Change a widget value (steps, prompt, seed, etc.). |
| `clear_canvas()` | Wipe everything. |
| `build_workflow(nodes, connections)` | Build an entire workflow in one call. |

### Layout
| Tool | Description |
|---|---|
| `set_node_position(node_id, x, y)` | Move one node to specific coords. |
| `arrange_grid(columns?, spacing_x?, spacing_y?, start_x?, start_y?)` | Auto-tidy the whole canvas into a grid. |
| `set_node_size(node_id, width?, height?)` | Resize one node. |
| `normalize_node_widths(width?)` | Make every node the same width. Defaults to the widest existing node. |
| `group_nodes(node_ids?, title?, color?)` | Wrap nodes in a labeled, colored group frame. Groups everything if `node_ids` omitted. |

### Templates / workflows
| Tool | Description |
|---|---|
| `load_template(name)` | Load a built-in template (sdxl_txt2img, flux_dev_txt2img, etc.). |
| `load_workflow(workflow)` | Load arbitrary workflow JSON onto the canvas. |

### Execution
| Tool | Description |
|---|---|
| `queue_prompt()` | Run the current workflow. Only triggers on the user words: *run*, *generate*, *execute*, *go*, *queue*. |

### Meta
| Tool | Description |
|---|---|
| `undo()` | Revert the last canvas change. Up to 20 levels of history. |

---

## UI / System features

These aren't tools the AI calls — they describe how the sidebar itself works.

### Visual
- **Glass-morphism panel** — semi-transparent background with backdrop blur so the canvas shows through.
- **CRT scanlines** overlay + glowing green left edge.
- **Panel sits below the top toolbar** (`--hm-top: 70px`) so ComfyUI's Run button is never obscured.
- **Bottom-right toggle dot** — CSS-drawn glowing green LED in a bezel; click to open/close. `Ctrl+Shift+H` is the keyboard equivalent.

### Provider system
- **Local ↔ API toggle** — click the `Local` / `API` word in the header to switch providers.
- **Color = connection status** — header text glows green when the provider is reachable, dim red-brown when not.
- **Two backends supported out of the box**:
  - **OpenRouter** (any OpenAI-compatible base URL) — uses XML `<tool_call>` format.
  - **Ollama** — uses native function calling via the `tools` API parameter; auto-fetches your installed model list from `/api/tags`.
- **Per-provider settings persist separately** — switching providers doesn't lose the other's config.

### Prompting / brain
- **Canvas state auto-injects** into every system prompt, so the model can skip a `get_canvas_info` round-trip and call `set_widget` directly with known node IDs. Big win for smaller local models.
- **Provider-aware system prompt** — XML tool format for API, plain instructions for Ollama native.
- **Lower temperature (0.2) for Ollama** — improves format adherence on smaller models.

### Reliability
- **Snapshot-based undo** — every mutating tool serializes the canvas before running. Stack capped at 20 entries.
- **Quiet tool log** — tool calls render as faded inline code (`› set_widget(node_id=8, ...)`); only prose responses get a `phosphor>` header.
- **Empty assistant turns are dropped** — no blank `phosphor>` lines between tool calls.

### Slash commands
| Command | Description |
|---|---|
| `/clear`, `/reset` | Reset chat history. |
| `/undo` | Revert last canvas change (direct, no AI involved). |
| `/model <id>` | Switch model (e.g. `anthropic/claude-sonnet-4.6`). |
| `/key <key>` | Set API key. |
| `/base <url>` | Change API base URL. |
| `/workflow` | Ask the AI to describe the current canvas. |
| `/help` | Show in-panel help. |

### Persistence (localStorage keys, all `hermes.*` for legacy reasons)
| Key | Purpose |
|---|---|
| `hermes.provider` | `openrouter` or `ollama` |
| `hermes.apiBase` | OpenAI-compatible base URL |
| `hermes.apiKey` | API key |
| `hermes.apiModel` | Model ID for API mode |
| `hermes.ollamaHost` | Ollama base URL |
| `hermes.ollamaModel` | Model ID for local mode |
| `hermes.panelWidth` | Width of the side panel in px |

---

## How to extend

Add a new tool in three places:

1. **`TOOL_DEFS`** in `web/phosphor.js` — JSON schema definition the model sees.
2. **`TOOL_IMPL`** in the same file — async function that does the work.
3. **`MUTATING_TOOLS`** set — add the name here if the tool changes the canvas (this makes undo work for it).

That's it. The AI will discover the new tool automatically; no fine-tuning or training needed.
