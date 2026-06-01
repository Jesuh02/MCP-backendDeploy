"""
convert_sign_language_to_onnx.py
================================

Exporta el modelo `prithivMLmods/Alphabet-Sign-Language-Detection` (SigLIP
fine-tuned) a ONNX en el layout que `@huggingface/transformers` v3 espera:

    models/sign-language/
        config.json
        preprocessor_config.json
        onnx/
            model.onnx
"""

from __future__ import annotations

import math
from pathlib import Path

MODEL_ID = "prithivMLmods/Alphabet-Sign-Language-Detection"
OUT_DIR = Path(__file__).resolve().parent.parent / "models" / "sign-language"


def _manual_sdpa(query, key, value, attn_mask=None, dropout_p=0.0,
                 is_causal=False, scale=None, enable_gqa=False):
    """Reimplementacion manual de F.scaled_dot_product_attention.

    PyTorch 2.4 tiene un bug en symbolic_opset14 al exportar SDPA con
    `scale` escalar (TypeError: z_() incompatible arguments). Hacemos la
    operacion con ops basicos para que el exporter ONNX la trace.
    """
    import torch

    if scale is None:
        scale = 1.0 / math.sqrt(query.size(-1))

    # (B, H, Lq, D) x (B, H, D, Lk) -> (B, H, Lq, Lk)
    attn = torch.matmul(query, key.transpose(-2, -1)) * scale

    if is_causal:
        L, S = query.size(-2), key.size(-2)
        causal_mask = torch.ones(L, S, dtype=torch.bool, device=query.device).tril(diagonal=0)
        attn = attn.masked_fill(~causal_mask, float("-inf"))

    if attn_mask is not None:
        if attn_mask.dtype == torch.bool:
            attn = attn.masked_fill(~attn_mask, float("-inf"))
        else:
            attn = attn + attn_mask

    attn = torch.softmax(attn, dim=-1)
    if dropout_p > 0.0:
        attn = torch.nn.functional.dropout(attn, p=dropout_p)
    return torch.matmul(attn, value)


def main() -> None:
    import torch
    import torch.nn.functional as F
    from transformers import AutoImageProcessor, AutoModelForImageClassification

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # -- 1. Descargar modelo --------------------------------------------------
    print(f"[1/3] Descargando modelo: {MODEL_ID} ...", flush=True)
    image_processor = AutoImageProcessor.from_pretrained(MODEL_ID)
    model = AutoModelForImageClassification.from_pretrained(
        MODEL_ID,
        torch_dtype=torch.float32,
        attn_implementation="eager",
    )
    model.eval()

    img_size = getattr(image_processor, "size", None)
    if isinstance(img_size, dict):
        h = img_size.get("height", img_size.get("shortest_edge", 224))
        w = img_size.get("width", img_size.get("shortest_edge", 224))
    elif isinstance(img_size, int):
        h = w = img_size
    else:
        h = w = 224
    print(f"    Tamano de imagen: {h}x{w}", flush=True)

    # -- 2. Parchear SDPA y exportar a ONNX -----------------------------------
    class _Wrapper(torch.nn.Module):
        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, pixel_values):
            return self.m(pixel_values=pixel_values).logits

    onnx_subdir = OUT_DIR / "onnx"
    onnx_subdir.mkdir(exist_ok=True)
    onnx_path = onnx_subdir / "model.onnx"

    dummy = torch.zeros(1, 3, h, w)
    print(f"[2/3] Exportando a ONNX (opset 17) -> {onnx_path} ...", flush=True)

    original_sdpa = F.scaled_dot_product_attention
    F.scaled_dot_product_attention = _manual_sdpa  # type: ignore[assignment]
    try:
        with torch.no_grad():
            torch.onnx.export(
                _Wrapper(model),
                (dummy,),
                str(onnx_path),
                input_names=["pixel_values"],
                output_names=["logits"],
                dynamic_axes={
                    "pixel_values": {0: "batch_size"},
                    "logits": {0: "batch_size"},
                },
                opset_version=17,
                do_constant_folding=True,
            )
    finally:
        F.scaled_dot_product_attention = original_sdpa  # type: ignore[assignment]

    # -- 3. Guardar config y preprocesador ------------------------------------
    print("[3/3] Guardando config.json y preprocessor_config.json ...", flush=True)
    model.config.save_pretrained(str(OUT_DIR))
    image_processor.save_pretrained(str(OUT_DIR))

    print(f"\nListo. Modelo exportado a: {OUT_DIR}")
    for p in sorted(OUT_DIR.rglob("*")):
        if p.is_file():
            size_mb = p.stat().st_size / (1024 * 1024)
            print(f"  {p.relative_to(OUT_DIR)}  ({size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
