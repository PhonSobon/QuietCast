# Third-party notices

This project's own source code is released under the MIT License (see `LICENSE`).
It uses the following third-party work, which keeps its own license.

## NVIDIA NemotronLabs RE-USE (speech-enhancement model)

- Source: https://huggingface.co/nvidia/NVIDIA-NemotronLabs-RE-USE
- Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
- License: **OpenMDW License Agreement v1.1 (OpenMDW-1.1)**
- Used by: `denoiser/`

The model weights and model code are **not** included in this repository. They are downloaded
to `denoiser/model/` by `denoiser/download_model.py` (or `start.ps1`), together with NVIDIA's
`LICENSE` file. If you redistribute the model (for example inside a Docker image built from
`denoiser/Dockerfile`), you must comply with the OpenMDW-1.1 terms and include that license.

Papers:
- Fu et al., 2026, "Rethinking Training Targets, Architectures and Data Quality for Universal Speech Enhancement", arXiv:2603.02641
- Fu et al., 2026, "One Model, Many Latencies: Universal Speech Enhancement for Diverse Real-Time Applications", arXiv:2606.25621

## Sota (សោតៈ) Khmer speech recognition: Sota-ASR-Khmer-26M-ONNX

- Source: https://huggingface.co/muyleanging/Sota-ASR-Khmer-26M-ONNX
- Copyright (c) 2026 Ing Muyleang. All rights reserved.
- License: **preview license**. You may download and run the model for **personal use, evaluation
  and research**. Do **not** redistribute the weights or use them in commercial products without
  written permission from the author. A final license may be published later.
- Used by: `transcriber/` (the service imports the repository's own `sota_infer.py` / `sota_subs.py`
  from the downloaded model folder)

The model is **not** included in this repository and must not be committed. Each user downloads
it to `transcriber/model/` with their own Hugging Face token (`HF_TOKEN`) via
`transcriber/download_model.py`. Do not bake it into Docker images you publish.

## Mamba

`denoiser/mamba_cpu.py` is an independent CPU re-implementation of the Mamba (v1) block from
"Mamba: Linear-Time Sequence Modeling with Selective State Spaces" (Gu & Dao, 2023;
https://github.com/state-spaces/mamba, Apache-2.0). Its parameter layout matches `mamba_ssm.Mamba`
so that the RE-USE checkpoint can be loaded without the CUDA-only `mamba_ssm` package.

## Other dependencies

Next.js, React, Tailwind CSS, FastAPI, PyTorch, Numba, ONNX Runtime, soxr, ffmpeg and the other packages listed in
`frontend/package.json`, `backend/requirements.txt` and `denoiser/requirements.txt` are used
under their respective licenses. ffmpeg is called as an external program and is not bundled.
