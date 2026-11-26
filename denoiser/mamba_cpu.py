"""
CPU implementation of the Mamba (v1) block, as a drop-in replacement for
`mamba_ssm.Mamba`, whose fused kernels require CUDA.

Parameter names and shapes match mamba_ssm exactly, so NVIDIA's RE-USE
checkpoint loads unchanged. The projections run as PyTorch matmuls (oneDNN/MKL);
everything else runs in two fused, multi-threaded Numba kernels:

  1. causal depthwise conv1d + SiLU
  2. selective scan + D skip + SiLU(z) gate

Math follows mamba_ssm's reference implementation (selective_scan_ref):
    delta = softplus(dt + dt_bias)
    h_t   = exp(delta_t * A) * h_{t-1} + delta_t * B_t * u_t
    y_t   = <h_t, C_t> + D * u_t
    out   = y * silu(z)

Performance notes:
  * Inner loops run over the channel axis so they map onto SIMD lanes.
  * exp() is a polynomial approximation (rel. error ~2e-6) because math.exp is a scalar
    libm call when Numba has no SVML (the default for pip installs).
  * Everything stays float32; a stray float64 halves the SIMD width.
  * Kernels read the projection outputs in place (no slicing copies).
"""
import math
import sys
import types

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from numba import njit, prange

_LOG2E = np.float32(1.4426950408889634)
_C1, _C2, _C3 = np.float32(0.6931471805599453), np.float32(0.2402265069591007), np.float32(0.05550410866482158)
_C4, _C5, _C6 = np.float32(0.009618129107628477), np.float32(0.0013333558146428443), np.float32(0.00015403530393381606)
_ONE = np.float32(1.0)


@njit(inline="always", fastmath=True)
def _fexp(x):  # pragma: no cover - compiled
    """exp(x) = 2^k * 2^f, |f| <= 0.5, degree-6 polynomial for 2^f."""
    x = min(max(x, np.float32(-87.0)), np.float32(88.0))
    y = x * _LOG2E
    k = np.float32(np.floor(y + np.float32(0.5)))
    f = y - k
    p = _C6
    p = p * f + _C5
    p = p * f + _C4
    p = p * f + _C3
    p = p * f + _C2
    p = p * f + _C1
    p = p * f + _ONE
    return p * np.int32((np.int32(k) + np.int32(127)) << np.int32(23)).view(np.float32)


@njit(inline="always", fastmath=True)
def _softplus(v):  # pragma: no cover - compiled
    """softplus(v) = max(v, 0) + log1p(exp(-|v|)), vectorizable.
    log1p(e) for e in (0, 1] uses 2*atanh(s), s = e / (2 + e) <= 1/3 (abs error < 1e-6)."""
    e = _fexp(-abs(v))
    s = e / (np.float32(2.0) + e)
    s2 = s * s
    p = np.float32(1.0 / 9.0)
    p = p * s2 + np.float32(1.0 / 7.0)
    p = p * s2 + np.float32(1.0 / 5.0)
    p = p * s2 + np.float32(1.0 / 3.0)
    p = p * s2 + _ONE
    return max(v, np.float32(0.0)) + np.float32(2.0) * s * p


@njit(parallel=True, fastmath=True, cache=True)
def _conv_silu(xz, w_t, bias, u):  # pragma: no cover - compiled
    """
    Causal depthwise conv1d over time + SiLU.
    xz   : [S, L, 2*Di]  (x is the first Di channels)
    w_t  : [K, Di]       conv weight, transposed
    bias : [Di]
    u    : [S, L, Di]    output
    """
    S, L, _ = xz.shape
    K, Di = w_t.shape
    for s in prange(S):
        acc = np.empty(Di, dtype=np.float32)
        for t in range(L):
            for d in range(Di):
                acc[d] = bias[d]
            for k in range(K):
                tt = t - (K - 1) + k
                if tt >= 0:
                    for d in range(Di):
                        acc[d] += w_t[k, d] * xz[s, tt, d]
            for d in range(Di):
                a = acc[d]
                u[s, t, d] = a / (_ONE + _fexp(-a))


@njit(parallel=True, fastmath=True, cache=True)
def _selective_scan(u, dt, xz, xdbl, r, A_T, Dskip, dt_bias, out):  # pragma: no cover - compiled
    """
    u, dt : [S, L, Di]
    xz    : [S, L, 2*Di]     z = xz[..., Di:]
    xdbl  : [S, L, R + 2N]   B = xdbl[..., R:R+N], C = xdbl[..., R+N:]
    A_T   : [N, Di]          (negative: -exp(A_log), transposed)
    Dskip, dt_bias : [Di]
    out   : [S, L, Di]
    """
    S, L, Di = u.shape
    N = A_T.shape[0]
    for s in prange(S):
        h = np.zeros((N, Di), dtype=np.float32)
        delta = np.empty(Di, dtype=np.float32)
        dx = np.empty(Di, dtype=np.float32)
        acc = np.empty(Di, dtype=np.float32)
        for t in range(L):
            for d in range(Di):
                delta[d] = _softplus(dt[s, t, d] + dt_bias[d])
                dx[d] = delta[d] * u[s, t, d]
                acc[d] = Dskip[d] * u[s, t, d]
            for n in range(N):
                b = xdbl[s, t, r + n]
                c = xdbl[s, t, r + N + n]
                for d in range(Di):
                    hn = _fexp(delta[d] * A_T[n, d]) * h[n, d] + dx[d] * b
                    h[n, d] = hn
                    acc[d] += hn * c
            for d in range(Di):
                zz = xz[s, t, Di + d]
                out[s, t, d] = acc[d] * (zz / (_ONE + _fexp(-zz)))


class Mamba(nn.Module):
    """Same constructor and parameters as mamba_ssm.modules.mamba_simple.Mamba."""

    def __init__(self, d_model, d_state=16, d_conv=4, expand=2, dt_rank="auto",
                 conv_bias=True, bias=False, **_unused):
        super().__init__()
        self.d_model = d_model
        self.d_state = d_state
        self.d_conv = d_conv
        self.d_inner = int(expand * d_model)
        self.dt_rank = math.ceil(d_model / 16) if dt_rank == "auto" else dt_rank

        self.in_proj = nn.Linear(d_model, self.d_inner * 2, bias=bias)
        self.conv1d = nn.Conv1d(self.d_inner, self.d_inner, kernel_size=d_conv,
                                groups=self.d_inner, padding=d_conv - 1, bias=conv_bias)
        self.x_proj = nn.Linear(self.d_inner, self.dt_rank + d_state * 2, bias=False)
        self.dt_proj = nn.Linear(self.dt_rank, self.d_inner, bias=True)
        self.A_log = nn.Parameter(torch.zeros(self.d_inner, d_state))
        self.D = nn.Parameter(torch.ones(self.d_inner))
        self.out_proj = nn.Linear(self.d_inner, d_model, bias=bias)
        self._consts = None

    def _constants(self):
        """Derived weights in kernel layout (computed once; inference only)."""
        if self._consts is None:
            c = lambda t: np.ascontiguousarray(t.detach().float().numpy())  # noqa: E731
            conv_b = self.conv1d.bias if self.conv1d.bias is not None else torch.zeros(self.d_inner)
            self._consts = (
                c(self.conv1d.weight[:, 0, :].t()),      # [K, Di]
                c(conv_b),
                c(-torch.exp(self.A_log).t()),           # [N, Di]
                c(self.D),
                c(self.dt_proj.bias),
            )
        return self._consts

    @torch.inference_mode()
    def forward(self, hidden_states: torch.Tensor) -> torch.Tensor:
        """hidden_states: [B, L, d_model] -> [B, L, d_model]"""
        w_t, conv_b, A_T, Dskip, dt_bias = self._constants()
        xz = self.in_proj(hidden_states.contiguous()).contiguous()   # [B, L, 2*Di]
        B, L, _ = xz.shape
        xz_np = xz.numpy()

        u = np.empty((B, L, self.d_inner), dtype=np.float32)
        _conv_silu(xz_np, w_t, conv_b, u)
        u_t = torch.from_numpy(u)

        x_dbl = self.x_proj(u_t).contiguous()                        # [B, L, R + 2N]
        dt = F.linear(x_dbl[..., : self.dt_rank], self.dt_proj.weight).contiguous()  # bias added in the scan

        out = np.empty_like(u)
        _selective_scan(u, dt.numpy(), xz_np, x_dbl.numpy(), self.dt_rank, A_T, Dskip, dt_bias, out)
        return self.out_proj(torch.from_numpy(out))


def install_shim() -> None:
    """Make `from mamba_ssm import Mamba` resolve to this CPU implementation."""
    mod = types.ModuleType("mamba_ssm")
    mod.Mamba = Mamba
    sys.modules["mamba_ssm"] = mod


# ---------------------------------------------------------------- reference & self-test

def selective_scan_reference(u, dt, z, Bm, Cm, A, Dskip, dt_bias):
    """Plain PyTorch selective scan (slow), following mamba_ssm.selective_scan_ref."""
    delta = F.softplus(dt + dt_bias)                          # [S, L, Di]
    S, L, Di = u.shape
    h = torch.zeros(S, Di, A.shape[1])
    ys = []
    for t in range(L):
        dA = torch.exp(delta[:, t, :, None] * A)              # [S, Di, N]
        h = dA * h + (delta[:, t, :, None] * u[:, t, :, None]) * Bm[:, t, None, :]
        ys.append((h * Cm[:, t, None, :]).sum(-1))
    y = torch.stack(ys, 1) + u * Dskip
    return y * F.silu(z)


def mamba_reference_forward(m: Mamba, hs: torch.Tensor) -> torch.Tensor:
    """Plain PyTorch Mamba forward (mamba_ssm's non-fused path)."""
    L = hs.shape[1]
    xz = m.in_proj(hs)
    x, z = xz.chunk(2, dim=-1)
    x = F.silu(m.conv1d(x.transpose(1, 2))[..., :L]).transpose(1, 2)
    x_dbl = m.x_proj(x)
    dt, Bm, Cm = torch.split(x_dbl, [m.dt_rank, m.d_state, m.d_state], dim=-1)
    dt = F.linear(dt, m.dt_proj.weight)
    y = selective_scan_reference(x, dt, z, Bm, Cm, -torch.exp(m.A_log), m.D, m.dt_proj.bias)
    return m.out_proj(y)


if __name__ == "__main__":
    torch.manual_seed(0)
    m = Mamba(d_model=64, d_state=16, d_conv=4, expand=4).eval()
    with torch.no_grad():  # realistic, non-trivial parameters
        for p in m.parameters():
            p.copy_(torch.randn_like(p) * 0.3)
        m.A_log.copy_(torch.log(torch.rand_like(m.A_log) * 15 + 0.5))
    hs = torch.randn(3, 41, 64)
    with torch.no_grad():
        ref = mamba_reference_forward(m, hs)
    out = m(hs)
    err = (out - ref).abs().max().item()
    scale = ref.abs().max().item()
    print(f"Mamba forward: max abs error {err:.2e} (output scale {scale:.2f})")
    assert err < 1e-3 * max(1.0, scale), err
    print("OK")
