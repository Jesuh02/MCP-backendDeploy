#!/usr/bin/env bash
# Script portable para ejecutar Graphify en cualquier repositorio.
# Utiliza un único entorno centralizado en ~/.graphify-env para ahorrar espacio en disco.
# Todos los resultados se almacenan en 'graphify-out/' (ignorado por Git).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CENTRAL_VENV="$HOME/.graphify-env"
CENTRAL_BIN="$CENTRAL_VENV/bin/graphify"

# 1. Resolver ejecutable: usar comando global si existe, o el entorno central
if command -v graphify &>/dev/null; then
    GRAPHIFY_EXEC="graphify"
elif [ -x "$CENTRAL_BIN" ]; then
    GRAPHIFY_EXEC="$CENTRAL_BIN"
else
    echo "=========================================================="
    echo " Entorno central de Graphify no detectado (~/.graphify-env)."
    echo " Creando entorno central único e instalando dependencias..."
    echo "=========================================================="
    python3 -m venv "$CENTRAL_VENV"
    "$CENTRAL_VENV/bin/pip" install --quiet graphifyy
    mkdir -p "$HOME/.local/bin"
    ln -sf "$CENTRAL_BIN" "$HOME/.local/bin/graphify"
    GRAPHIFY_EXEC="$CENTRAL_BIN"
    echo "✅ Entorno central configurado exitosamente en $CENTRAL_VENV"
fi

# 2. Asegurar que .gitignore incluya la carpeta de salida generada
GITIGNORE="$PROJECT_ROOT/.gitignore"
if [ -f "$GITIGNORE" ]; then
    if ! grep -q "graphify-out/" "$GITIGNORE" 2>/dev/null; then
        echo -e "\n# Graphify (Knowledge graph outputs)\ngraphify-out/" >> "$GITIGNORE"
        echo "ℹ️ Se añadió automáticamente 'graphify-out/' a tu .gitignore"
    fi
fi

# 3. Asegurar regla automática para que la IA consulte Graphify por sí sola
AGENTS_RULES_DIR="$PROJECT_ROOT/.agents/rules"
RULE_FILE="$AGENTS_RULES_DIR/graphify.md"
if [ ! -f "$RULE_FILE" ]; then
    mkdir -p "$AGENTS_RULES_DIR"
    cat << 'EOF' > "$RULE_FILE"
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
EOF
    echo "ℹ️ Regla de IA configurada en .agents/rules/graphify.md (la IA consultará el grafo automáticamente)"
fi

# 4. Si no se pasan argumentos, corre la extracción de código AST por defecto
if [ "$#" -eq 0 ]; then
    echo "=========================================================="
    echo " Ejecutando Graphify: Análisis de código AST (Local/Gratuito)"
    echo " Directorio destino: $PROJECT_ROOT/graphify-out/"
    echo "=========================================================="
    "$GRAPHIFY_EXEC" extract "$PROJECT_ROOT" --code-only --out "$PROJECT_ROOT"
    
    echo ""
    echo "=========================================================="
    echo " Generando visor interactivo HTML (graph.html)..."
    echo "=========================================================="
    (cd "$PROJECT_ROOT" && "$GRAPHIFY_EXEC" export html)
    
    echo ""
    echo "✅ Análisis completado. Puedes abrir en tu navegador:"
    echo "   file://$PROJECT_ROOT/graphify-out/graph.html"
else
    # Si se pasan argumentos adicionales (ej: query, export, tree, etc.)
    "$GRAPHIFY_EXEC" "$@"
fi
