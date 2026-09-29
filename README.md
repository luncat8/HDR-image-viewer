## browser based offline image viewer, vanilla js page

because all have browser this looks like most reliable solution, until XNview implement it,

- `index.html` — plain `<img>` viewer, the browser composites HDR natively.
- `gpu.html` — WebGPU f16 canvas viewer with an SDR → HDR range expander (levels, exposure, highlights on a histogram); already-HDR images (PQ, HLG, gain map) are detected and shown natively with a headroom control.
