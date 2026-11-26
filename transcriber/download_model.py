"""
Download Sota-ASR-Khmer-26M-ONNX into ./model. Run once.

The repository requires a Hugging Face access token. Put it in a .env file
(project root or this folder) or set it as an environment variable:

    HF_TOKEN=hf_xxxxxxxxxxxxxxxxx

Get a token at https://huggingface.co/settings/tokens and accept the model's
terms on its page first. Never commit your token.
"""
import os
import sys
from pathlib import Path

from huggingface_hub import snapshot_download

HERE = Path(__file__).resolve().parent
REPO = "muyleanging/Sota-ASR-Khmer-26M-ONNX"
FILES = ["encoder.int8.onnx", "decoder.int8.onnx", "tokens.json", "words_km.txt",
         "sota_infer.py", "sota_subs.py", "README.md", "LICENSE"]


def read_token() -> str | None:
    if os.getenv("HF_TOKEN"):
        return os.environ["HF_TOKEN"].strip()
    for env in (HERE / ".env", HERE.parent / ".env"):
        if env.exists():
            for line in env.read_text(encoding="utf-8").splitlines():
                key, _, value = line.strip().partition("=")
                if key.strip() == "HF_TOKEN" and value.strip():
                    return value.strip().strip('"').strip("'")
    return None


def main() -> None:
    token = read_token()
    if not token:
        sys.exit("HF_TOKEN not found. Add HF_TOKEN=hf_... to the .env file in the project root "
                 "(see .env.example), then run this again.")
    target = HERE / "model"
    try:
        snapshot_download(REPO, local_dir=target, token=token, allow_patterns=FILES)
    except Exception as exc:  # noqa: BLE001
        sys.exit(f"Download failed: {type(exc).__name__}: {exc}\n"
                 "Check that your token is valid and that you accepted the model's terms on Hugging Face.")
    print(f"Model saved to {target}")
    print("License: personal use, evaluation and research only - see model/LICENSE.")


if __name__ == "__main__":
    main()
