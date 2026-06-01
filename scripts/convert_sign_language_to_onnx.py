"""
convert_sign_language_to_onnx.py
================================

Exporta el modelo `prithivMLmods/Alphabet-Sign-Language-Detection` (SigLIP
fine-tuned, sólo distribuido en safetensors) a ONNX en el layout que
`@huggingface/transformers` (Transformers.js v3) espera:

    models/sign-language/
        config.json
        preprocessor_config.json
        onnx/
            model.onnx
            model_quantized.onnx   (opcional, generado por --quantize)

Uso (una sola vez, requiere Python 3.10+):

    python -m venv .venv
    .\\.venv\\Scripts\\Activate.ps1
    pip install -U "optimum[exporters]>=1.21" transformers torch onnx onnxruntime
    python scripts/convert_sign_language_to_onnx.py

Salida: models/sign-language/  (commit a R2 o al repo; ~95 MB)
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

MODEL_ID = "prithivMLmods/Alphabet-Sign-Language-Detection"
OUT_DIR = Path(__file__).resolve().parent.parent / "models" / "sign-language"


def run(cmd: list[str]) -> None:
    print(f"\n>>> {' '.join(cmd)}\n", flush=True)
    subprocess.check_call(cmd)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # 1) Exportar el modelo con optimum-cli (genera config.json,
    #    preprocessor_config.json y model.onnx en OUT_DIR).
    run([
        sys.executable, "-m", "optimum.exporters.onnx",
        "--model", MODEL_ID,
        "--task", "image-classification",
        str(OUT_DIR),
    ])

    # 2) Transformers.js espera el ONNX en subcarpeta `onnx/`.
    onnx_subdir = OUT_DIR / "onnx"
    onnx_subdir.mkdir(exist_ok=True)
    src = OUT_DIR / "model.onnx"
    if src.exists():
        dst = onnx_subdir / "model.onnx"
        if dst.exists():
            dst.unlink()
        shutil.move(str(src), str(dst))
        print(f"Movido: {src.name} -> onnx/{dst.name}")

    # También mover model.onnx_data (pesos externos si el modelo es >2GB,
    # poco probable aquí, pero por consistencia).
    data_src = OUT_DIR / "model.onnx_data"
    if data_src.exists():
        shutil.move(str(data_src), str(onnx_subdir / "model.onnx_data"))

    print(f"\nListo. Modelo exportado a: {OUT_DIR}")
    print("Estructura esperada por Transformers.js:")
    for p in sorted(OUT_DIR.rglob("*")):
        if p.is_file():
            size_mb = p.stat().st_size / (1024 * 1024)
            rel = p.relative_to(OUT_DIR)
            print(f"  {rel}  ({size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
