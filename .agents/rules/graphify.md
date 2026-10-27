---
trigger: always_on
description: Consult the graphify knowledge graph at graphify-out/ for codebase and architecture questions.
---

## graphify (Knowledge Graph)

Este proyecto cuenta con un grafo de conocimiento generado en `graphify-out/`.

Reglas para el asistente:
- Para preguntas sobre arquitectura, dependencias o ubicación de funciones/clases, si `graphify-out/graph.json` existe, consulta primero el grafo antes de hacer lecturas masivas o búsquedas ciegas de archivos.
- Puedes usar `./scripts/graphify.sh query "<pregunta o símbolo>"` o inspeccionar el grafo para obtener el subgrafo de dependencias exacto.
- Al modificar código relevante en la sesión, recuerda actualizar el grafo con `./scripts/graphify.sh` (extracción local AST rápida y gratuita).
