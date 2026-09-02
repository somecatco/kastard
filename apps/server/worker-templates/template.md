# Kastard Worker

## What is Kastard?

Kastard is a desktop app for editing ComfyUI workflows locally and running them on remote GPU workers.

[GitHub](https://github.com/ssinss/kastard) | [Docs](https://github.com/ssinss/kastard/blob/main/docs/en/index.mdx) | [Discord](https://discord.gg/Z9eUBVFncN)

## Using this Worker

Connect Kastard to this Worker to run ComfyUI workflows on a remote GPU.

After startup, copy the `Address` and `Authentication code` from the Worker log into
Kastard. The code remains valid for reconnecting until this Worker stops. A running
Worker accepts one Kastard connection at a time.

## Environment variables

- `SSH_PUBLIC_KEY` (optional): Set a public key if you need diagnostic SSH access on the port mapped to internal port 2222.

## CUDA compatibility

- `kastard-worker-cu128` requires a host that supports CUDA 12.8 or later.
- `kastard-worker-cu130` requires a host that supports CUDA 13.0 or later.
