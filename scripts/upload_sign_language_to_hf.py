"""
upload_sign_language_to_hf.py
=============================

Sube los artefactos ONNX generados por convert_sign_language_to_onnx.py
a un repo de modelos de HuggingFace para que el backend (Railway/Docker)
los pueda descargar en runtime vía @huggingface/transformers.

Requisitos:
    pip install huggingface_hub

Login (una vez):
    huggingface-cli login        # pega un token con permiso "Write"
        — o —
    export HF_TOKEN=hf_xxx       # token con permiso "Write"

Uso:
    python scripts/upload_sign_language_to_hf.py <usuario>/<repo>
    # ejemplo: python scripts/upload_sign_language_to_hf.py yasuyk/Alphabet-Sign-Language-ONNX

Luego en Railway define:
    SIGN_LANGUAGE_HF_REPO=yasuyk/Alphabet-Sign-Language-ONNX
    HF_API_TOKEN=hf_xxx   (solo si el repo es privado)

Nota de arquitectura:
    Este repo de HuggingFace contiene solo el clasificador ONNX de imagen
    estatica para alfabeto ASL A-Z. La deteccion profesional de palabras,
    frases y oraciones ASL en ingles se hace en runtime con
    smart-recognizer.js + sign-language-vlm.js sobre clips temporales.
    No subas este artefacto como si fuera un modelo word-level completo.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODEL_DIR = ROOT / "models" / "sign-language"


def main() -> None:
    if len(sys.argv) != 2:
        print("Uso: python scripts/upload_sign_language_to_hf.py <usuario>/<repo>")
        sys.exit(1)

    repo_id = sys.argv[1]

    required = ["config.json", "preprocessor_config.json", "onnx/model.onnx"]
    for rel in required:
        p = MODEL_DIR / rel
        if not p.exists():
            print(f"ERROR: falta {p}. Ejecuta primero convert_sign_language_to_onnx.py")
            sys.exit(1)

    try:
        from huggingface_hub import HfApi, create_repo
    except ImportError:
        print("Falta huggingface_hub. Instala con:  pip install huggingface_hub")
        sys.exit(1)

    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN")

    print(f"Creando repo (si no existe): {repo_id}")
    create_repo(repo_id, repo_type="model", exist_ok=True, private=False, token=token)

    api = HfApi(token=token)
    print(f"Subiendo {MODEL_DIR} -> {repo_id} ...")
    api.upload_folder(
        folder_path=str(MODEL_DIR),
        repo_id=repo_id,
        repo_type="model",
        commit_message="Add ONNX export of Alphabet-Sign-Language-Detection",
        ignore_patterns=["README.md", "*.md"],
    )

    print("\nListo. Variables de entorno para Railway:")
    print(f"  SIGN_LANGUAGE_HF_REPO={repo_id}")
    print("  HF_API_TOKEN=hf_xxx   (solo si el repo es privado)")


if __name__ == "__main__":
    main()
