#!/bin/bash
# Deploy phosphor to ComfyUI custom_nodes
SRC="/c/AI/claude/phosphor"
DST="/c/AI/comfy/ComfyUI/custom_nodes/phosphor"
OLD_DST="/c/AI/comfy/ComfyUI/custom_nodes/hermestab"

echo "Deploying phosphor..."
# Clean up old hermestab folder if it still exists from before the rename
[ -d "$OLD_DST" ] && rm -rf "$OLD_DST" && echo "Removed legacy custom_nodes/hermestab"
rm -rf "$DST"
cp -r "$SRC" "$DST"
echo "Done. Restart ComfyUI (Python class renamed) then Ctrl+Shift+R the browser tab."
