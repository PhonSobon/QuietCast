# Contributing

Thanks for your interest in improving QuietCast! Bug reports, ideas and pull requests are welcome.

## Getting started

1. Fork the repository and clone your fork.
2. Follow **Run it** in `README.md` to start the frontend, the backend and (optionally) the AI denoiser.
3. Create a branch: `git checkout -b feature/my-change`.

## Before opening a pull request

Run the same checks as CI:

```bash
# frontend
cd frontend && npm ci && npm run typecheck && npm run build

# backend
cd backend && pip install -r requirements.txt -r requirements-dev.txt && pytest

# denoiser (CPU kernel self-test)
cd denoiser && python mamba_cpu.py
```

- Keep pull requests focused: one feature or fix per PR.
- Describe what changed and how you tested it. Screenshots help for UI changes.
- Don't commit recordings, `.env` files, virtual environments or the downloaded model (`denoiser/model/`).

## Reporting bugs

Please open an issue with your OS, browser and version, what you did, what you expected, and what
happened. Include console or server logs if you have them.

## License

By contributing, you agree that your contributions are licensed under the MIT License (see `LICENSE`).
