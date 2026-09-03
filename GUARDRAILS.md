# Kastard Product & Architecture Guardrails

Ensure that implementation does not violate the following requirements.

- The state of a remote execution node must be visible locally.
- Model synchronization
  - Use official source URLs to benefit from caching and global download performance.
  - Provide a remote synchronization option for each model. Download only selected models to their designated locations.
- Remote execution must work even when local prerequisites are unavailable. For example, a model may exist only on the remote Worker.
- Content uploaded locally must work when executed remotely.
- The Editor wraps Comfy in Electron. Do not fork Comfy.
- Remote execution results must also appear locally with the same output.
- Assume execution on RunPod. The RunPod image includes the required backend functionality.
- The RunPod Worker image owns pinned CUDA, Python, and PyTorch runtimes. Do not synchronize the local runtimes used by the Editor to the remote Worker.
- Assume that users start the Worker themselves. The Editor only connects to its address.
- Make Comfy execution and Kastard execution clearly distinguishable.
- Clearly show the current connection and synchronization states.
- Kastard may run independently without using an existing Comfy installation.
- The Editor uses one Worker at a time as its default connection model. This defines the default UX and operating model; it does not require the Worker to technically prevent multiple Editors from connecting concurrently.
- The Editor must not reconnect to the previous Worker automatically on startup. The user initiates a new connection through Connect.
- Make user-visible information, such as error messages and model names, selectable and copyable whenever practical. Buttons are excluded.
- Minimize total synchronization time whenever practical.
- Preserve as much of the Comfy user experience as possible.
