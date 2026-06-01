# Sign Language Model (ONNX)

Este directorio aloja la versión ONNX de
[`prithivMLmods/Alphabet-Sign-Language-Detection`](https://huggingface.co/prithivMLmods/Alphabet-Sign-Language-Detection),
usada en tiempo real por el endpoint `POST /api/v1/sign-language/infer`.

## ¿Por qué local?

El modelo **no está desplegado en ningún Inference Provider de HuggingFace**, así
que la antigua URL `api-inference.huggingface.co/...` devuelve 410 Gone. Lo
servimos in-process con [Transformers.js](https://huggingface.co/docs/transformers.js)
sobre `onnxruntime-node`.

## Cómo generar los archivos

```powershell
# Una sola vez, requiere Python 3.10+
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -U "optimum[exporters]>=1.21" transformers torch onnx onnxruntime
python scripts/convert_sign_language_to_onnx.py
```

Se generará la siguiente estructura (~95 MB):

```
models/sign-language/
    config.json
    preprocessor_config.json
    onnx/
        model.onnx
```

## Despliegue

Estos archivos son pesados; **no se versionan en git**. Para producción:

1. Súbelos a R2/S3 (`coursev-models/sign-language/...`) o
2. Inclúyelos en la imagen Docker en el paso de build.

El backend los busca en `process.env.SIGN_LANGUAGE_MODEL_DIR`
(por defecto `<repo>/models/sign-language`).
