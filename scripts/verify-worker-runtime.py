import hashlib
import importlib
import json
import platform
import subprocess
import sys
from pathlib import Path
from typing import Any


def require_string(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value:
        raise SystemExit(f"Worker runtime manifest is missing {name}.")
    return value


def main() -> None:
    if len(sys.argv) != 4:
        raise SystemExit(
            "Usage: verify-worker-runtime.py <profile> <manifest> <lock>"
        )

    profile, manifest_argument, lock_argument = sys.argv[1:]
    manifest_path = Path(manifest_argument)
    lock_path = Path(lock_argument)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    if require_string(manifest.get("profile"), "profile") != profile:
        raise SystemExit(f"Worker runtime manifest does not describe {profile}.")

    dependency_lock = manifest.get("dependencyLock")
    if not isinstance(dependency_lock, dict):
        raise SystemExit("Worker runtime manifest is missing dependencyLock.")
    expected_lock_sha = require_string(
        dependency_lock.get("sha256"), "dependencyLock.sha256"
    )
    if hashlib.sha256(lock_path.read_bytes()).hexdigest() != expected_lock_sha:
        raise SystemExit("Worker runtime lock does not match its manifest.")

    compute_backend = manifest.get("computeBackend", "cuda")
    if compute_backend not in ("cpu", "cuda"):
        raise SystemExit("Worker runtime manifest has an invalid computeBackend.")

    cuda_version = manifest.get("cudaVersion")
    if compute_backend == "cpu":
        if cuda_version is not None:
            raise SystemExit("CPU Worker runtime must set cudaVersion to null.")
    else:
        cuda_version = require_string(cuda_version, "cudaVersion")
        nvcc = subprocess.run(
            ["nvcc", "--version"], capture_output=True, text=True, check=False
        )
        if nvcc.returncode != 0 or f"release {cuda_version}," not in nvcc.stdout:
            raise SystemExit(f"Worker base image does not provide CUDA {cuda_version}.")

    uv = subprocess.run(["uv", "--version"], capture_output=True, text=True, check=False)
    uv_version = require_string(manifest.get("uvVersion"), "uvVersion")
    if uv.returncode != 0 or uv.stdout.split()[1:2] != [uv_version]:
        raise SystemExit(f"Worker image does not provide uv {uv_version}.")

    for module_name in (
        "accelerate",
        "color_matcher",
        "cv2",
        "imageio",
        "imageio_ffmpeg",
    ):
        importlib.import_module(module_name)
    torch = importlib.import_module("torch")
    torchaudio = importlib.import_module("torchaudio")
    torchvision = importlib.import_module("torchvision")

    versions = {
        "Python": (platform.python_version(), "pythonVersion"),
        "PyTorch": (torch.__version__, "torchVersion"),
        "torchvision": (torchvision.__version__, "torchvisionVersion"),
        "torchaudio": (torchaudio.__version__, "torchaudioVersion"),
    }
    for name, (actual, manifest_key) in versions.items():
        expected = require_string(manifest.get(manifest_key), manifest_key)
        if actual != expected:
            raise SystemExit(f"{name} is {actual!r}; expected {expected!r}.")

    if compute_backend == "cpu":
        if torch.version.cuda is not None or torch.cuda.is_available():
            raise SystemExit("CPU Worker runtime unexpectedly provides CUDA.")
    elif torch.version.cuda != cuda_version:
        raise SystemExit(
            f"PyTorch CUDA is {torch.version.cuda!r}; expected {cuda_version!r}."
        )


if __name__ == "__main__":
    main()
