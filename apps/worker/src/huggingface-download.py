import json
import sys
from pathlib import Path

from huggingface_hub import hf_hub_download
from tqdm.auto import tqdm


class DownloadProgress(tqdm):
    def __init__(self, *args, **kwargs) -> None:
        name = kwargs.pop("name", "") or ""
        self._report = not name.endswith(".transfer")
        self._reported = -1
        kwargs["disable"] = False
        super().__init__(*args, **kwargs)
        self._emit()

    def display(self, msg=None, pos=None) -> None:
        pass

    def update(self, amount=1):
        displayed = super().update(amount)
        if displayed:
            self._emit()
        return displayed

    def close(self) -> None:
        self._emit()
        super().close()

    def _emit(self) -> None:
        downloaded = int(self.n)
        if self._report and downloaded != self._reported:
            self._reported = downloaded
            print(
                json.dumps({"downloadedBytes": downloaded}),
                file=sys.stderr,
                flush=True,
            )


def main() -> None:
    request = json.load(sys.stdin)
    path = hf_hub_download(
        repo_id=request["repoId"],
        revision=request["revision"],
        filename=request["filename"],
        local_dir=request["directory"],
        token=request["token"],
        tqdm_class=DownloadProgress,
    )
    resolved = Path(path).resolve(strict=True)
    if not resolved.is_file():
        raise RuntimeError("Hugging Face returned an invalid model file.")
    print(json.dumps({"path": str(resolved)}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        response = getattr(error, "response", None)
        status = getattr(response, "status_code", None)
        payload = {"error": {"message": f"{type(error).__name__}: {error}"}}
        if isinstance(status, int):
            payload["error"]["status"] = status
        print(json.dumps(payload))
        raise SystemExit(1) from None
