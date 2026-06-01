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

IMPORTANTE: Transformers.js v3.x NO registra siglip en el pipeline
`image-classification` (solo en `zero-shot-image-classification`). Como
nuestra exportacion ONNX es un grafo plano (pixel_values -> logits) y la
clasificacion es estructuralmente identica a un ViT, reetiquetamos el
config como `vit` despues de exportar.
"""

from __future__ import annotations

import json
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


def _patch_configs_for_transformers_js() -> None:
    """Reescribe config.json y preprocessor_config.json para que Transformers.js
    cargue el modelo como ViT (compatible con el pipeline image-classification).

    El grafo ONNX exportado es agnostico: solo recibe pixel_values y produce
    logits, exactamente igual que ViTForImageClassification.
    """
    cfg_path = OUT_DIR / "config.json"
    pre_path = OUT_DIR / "preprocessor_config.json"

    # --- config.json --------------------------------------------------------
    with cfg_path.open("r", encoding="utf-8") as f:
        cfg = json.load(f)

    # SigLIP guarda parametros de vision dentro de vision_config; los promovemos
    # al nivel superior porque el ViTConfig de transformers.js los lee de ahi.
    vision = cfg.get("vision_config", {})

    new_cfg = {
        "model_type": "vit",
        "architectures": ["ViTForImageClassification"],
        "id2label": cfg.get("id2label", {}),
        "label2id": cfg.get("label2id", {}),
        "num_labels": len(cfg.get("id2label", {})) or cfg.get("num_labels", 0),
        # Campos de ViT (los lee transformers.js para metadatos, no para
        # reconstruir el grafo, ya que ya tenemos el ONNX).
        "hidden_size": vision.get("hidden_size", cfg.get("hidden_size", 768)),
        "num_hidden_layers": vision.get("num_hidden_layers", cfg.get("num_hidden_layers", 12)),
        "num_attention_heads": vision.get("num_attention_heads", cfg.get("num_attention_heads", 12)),
        "intermediate_size": vision.get("intermediate_size", cfg.get("intermediate_size", 3072)),
        "image_size": vision.get("image_size", cfg.get("image_size", 224)),
        "patch_size": vision.get("patch_size", cfg.get("patch_size", 16)),
        "num_channels": vision.get("num_channels", 3),
        "transformers_version": cfg.get("transformers_version", "4.44.0"),
    }
    with cfg_path.open("w", encoding="utf-8") as f:
        json.dump(new_cfg, f, indent=2)
    print(f"    config.json reescrito como model_type=vit ({new_cfg['num_labels']} labels)")

    # --- preprocessor_config.json ------------------------------------------
    with pre_path.open("r", encoding="utf-8") as f:
        pre = json.load(f)

    # SigLIP usa media/std = 0.5; ViTImageProcessor usa por defecto los mismos
    # valores y la misma logica (resize + rescale + normalize). Solo cambiamos
    # el nombre del processor para que transformers.js lo encuentre.
    pre["image_processor_type"] = "ViTImageProcessor"
    pre.setdefault("do_resize", True)
    pre.setdefault("do_rescale", True)
    pre.setdefault("do_normalize", True)
    pre.setdefault("rescale_factor", 1 / 255)
    pre.setdefault("image_mean", [0.5, 0.5, 0.5])
    pre.setdefault("image_std", [0.5, 0.5, 0.5])
    pre.setdefault("resample", 2)  # BILINEAR
    if "size" not in pre:
        pre["size"] = {"height": 224, "width": 224}
    with pre_path.open("w", encoding="utf-8") as f:
        json.dump(pre, f, indent=2)
    print(f"    preprocessor_config.json reescrito como ViTImageProcessor")


def main() -> None:
    import torch
    import torch.nn.functional as F
    from transformers import AutoImageProcessor, AutoModelForImageClassification

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    print(f"[1/4] Descargando modelo: {MODEL_ID} ...", flush=True)
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
    print(f"[2/4] Exportando a ONNX (opset 17) -> {onnx_path} ...", flush=True)

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

    print("[3/4] Guardando config.json y preprocessor_config.json ...", flush=True)
    model.config.save_pretrained(str(OUT_DIR))
    image_processor.save_pretrained(str(OUT_DIR))

    print("[4/4] Reescribiendo configs para Transformers.js (model_type=vit) ...", flush=True)
    _patch_configs_for_transformers_js()

    print(f"\nListo. Modelo exportado a: {OUT_DIR}")
    for p in sorted(OUT_DIR.rglob("*")):
        if p.is_file():
            size_mb = p.stat().st_size / (1024 * 1024)
            print(f"  {p.relative_to(OUT_DIR)}  ({size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
