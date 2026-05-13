#!/bin/bash
# Deploy hermestab to ComfyUI custom_nodes
SRC="/c/AI/claude/hermestab"
DST="/c/AI/comfy/ComfyUI/custom_nodes/hermestab"

echo "Deploying hermestab..."
rm -rf "$DST"
cp -r "$SRC" "$DST"
echo "Done. Refresh ComfyUI browser tab (Ctrl+Shift+R)."
