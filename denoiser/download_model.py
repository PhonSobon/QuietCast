"""Download NVIDIA NemotronLabs RE-USE (code + weights) into ./model. Run once."""
from pathlib import Path

from huggingface_hub import snapshot_download

target = Path(__file__).resolve().parent / "model"
snapshot_download(
    "nvidia/NVIDIA-NemotronLabs-RE-USE",
    local_dir=target,
    allow_patterns=["models/*", "utils/*", "config.json", "model.safetensors", "LICENSE", "README.md",
                    "noisy_audio/*", "long_noisy_audio/*"],
)
print(f"Model saved to {target}")
