# Kastard Domain Glossary

This glossary provides concise definitions for using terms consistently in Kastard development.

## Editor

The application component used to edit ComfyUI workflows, distinct from the Worker that executes them.

Use Kastard as the product name in the application UI. Use Editor when referring to the component in code, technical documentation, development discussions, and build or release metadata.

Public visibility does not determine terminology: developer and release surfaces may use Editor even when publicly accessible.

## Worker

The server that the Editor connects to in order to execute ComfyUI work on a remote GPU. It manages the ComfyUI runtime environment and executes workflows.
