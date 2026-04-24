# Claves de respuesta ICFES

Una carpeta con un archivo JSON por PDF. Es el **origen de verdad** que
alimenta `is_correct` antes del fallback por LLM.

## Convención de nombres

`<reference>.json`, donde `<reference>` es la ruta relativa dentro de
`docs/icfes_content/` con `/` y espacios reemplazados por `_`.

Ejemplos:

| PDF original                                        | Archivo aquí                              |
|-----------------------------------------------------|-------------------------------------------|
| `2016/fisica/Fisica 2010.pdf`                       | `2016_fisica_Fisica_2010.pdf.json`        |
| `2024-2025/matematicas/Matematicas.pdf`             | `2024-2025_matematicas_Matematicas.pdf.json` |
| `2023/naturales/Naturale.pdf`                       | `2023_naturales_Naturale.pdf.json`        |

## Formato

```json
{
  "1": "A",
  "2": "C",
  "3": "B",
  "4": "D"
}
```

La clave es el número de pregunta (tal como aparece impreso en el PDF) y el
valor es la letra correcta (`A`–`D`).

> **Importante**: la clave JSON debe ser el **número puro** (`"12"`, no
> `"Pregunta 12"` ni `"12."`). Al cargar el archivo, el resolver valida esto
> estrictamente y **emite un warning ruidoso** si encuentra claves no numéricas
> o letras fuera de `A|B|C|D`. Sin warning no se mantienen fallos silenciosos
> que caigan al LLM sin que nadie se entere.

Log de ejemplo cuando todo está bien:

```
[icfes] answer-key 2016_fisica_Fisica_2010.pdf.json: 30 respuestas cargadas
```

Log cuando hay errores (el archivo se ignora por completo):

```
[icfes] answer-key 2016_fisica_Fisica_2010.pdf.json: 2 errores → clave "Pregunta 12" no es entero; valor "E" en pregunta 18 no es A|B|C|D
```

## Cómo se usa

- El ingest intenta primero esta ruta (determinista, confianza 1.0).
- Si no existe el archivo o falta el número, cae al LLM (confianza ≥ 0.8).
- Si ambos fallan, la pregunta se guarda sin opción correcta y aparece en
  `v_icfes_questions_pending_review` para curación manual.
