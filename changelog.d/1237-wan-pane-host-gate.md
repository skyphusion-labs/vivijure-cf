### fix(cast): hide the Wan LoRA pane on a host without the Wan train endpoint

The cast page showed the Wan LoRA pane whenever the `alibaba-wan-lora` door was installed, so a host without `RUNPOD_WAN_TRAIN_ENDPOINT_ID` offered a button that could only end in the 501. `GET /api/cast` now also returns `wan_lora_trainable` (a boolean; the endpoint id is never returned), and the pane shows only when the door is installed and that field is `true`. A missing field, a failed request or a failed registry load keeps the pane hidden.
