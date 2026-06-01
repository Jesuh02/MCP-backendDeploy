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

Uso (una sola vez, requiere Python 3.10+):

    python -m venv .venv
    .\.venv\Scripts\Activate.ps1
    pip install --extra-index-url https://download.pytorch.org/whl/cpu torch==2.4.1+cpu
    pip install "transformers>=4.44" onnx pillow
    python scripts/convert_sign_language_to_onnx.py

NOTAS:
- Se usa torch.onnx.export directamente (no optimum-cli) porque optimum no
  admite image-classification para arquitecturas siglip.
- Se carga AutoImageProcessor (no AutoProcessor) para evitar arrastrar el
  tokenizer SentencePiece de SigLIP que no necesitamos para clasificacion.
"""

from __future__ import annotations

from pathlib import Path

MODEL_ID = "prithivMLmods/Alphabet-Sign-Language-Detection"
OUT_DIR = Path(__file__).resolve().parent.parent / "models" / "sign-language"


def main() -> None:
    import torch
    from transformers import AutoImageProcessor, AutoModelForImageClassification

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # -- 1. Descargar modelo --------------------------------------------------
    print(f"[1/3] Descargando modelo: {MODEL_ID} ...", flush=True)
    image_processor = AutoImageProcessor.from_pretrained(MODEL_ID)
    model = AutoModelForImageClassification.from_pretrained(
        MODEL_ID,
        torch_dtype=torch.float32,
        # "eager" desactiva SDPA/flash-attn que no es trazable con torch.onnx
        attn_implementation="eager",
    )
    model.eval()

    # Detectar tamano de imagen (SiglipImageProcessor)
    img_size = getattr(image_processor, "size", None)
    if isinstance(img_size, dict):
        h = img_size.get("height", img_size.get("shortest_edge", 224))
        w = img_size.get("width", img_size.get("shortest_edge", 224))
    elif isinstance(img_size, int):
        h = w = img_size
    else:
        h = w = 224
    print(f"    Tamano de imagen: {h}x{w}", flush=True)

    # -- 2. Exportar a ONNX ---------------------------------------------------
    # Wrapper que devuelve logits (Tensor plano), no ModelOutput, para que
    # torch.onnx.export pueda trazar la salida correctamente.
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
