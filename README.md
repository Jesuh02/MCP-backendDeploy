<div align="center">

# CourseV Backend
### Hub del Protocolo Model Context (MCP)

[![Node.js](https://img.shields.io/badge/Node.js-43853D?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![DeepSeek](https://img.shields.io/badge/Inteligencia-DeepSeek_V3.2-blue?style=for-the-badge)](https://deepseek.com)
[![Protocol](https://img.shields.io/badge/Protocolo-MCP-orange?style=for-the-badge)](https://modelcontextprotocol.io)

API • Motor de inteligencia • Despliegue 
</div>


### 🗺️ Diagrama Interactivo Navegable (Estilo Lucidchart)

<div align="center">
  
**Haz clic en la imagen para explorar el diagrama completo de la arquitectura de forma interactiva** 🔍

[![Arquitectura Completa del Sistema CourseV](https://pub-9f393625246c4018b5613be60b01bda1.r2.dev/data/arquitectura.png)](https://www.mermaidchart.com/app/projects/fa72bcaf-267c-492e-89e6-1c4b155de335/diagrams/2706f980-5691-4b44-bf04-b3dc8d2b97c1/share/invite/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJkb2N1bWVudElEIjoiMjcwNmY5ODAtNTY5MS00YjQ0LWJmMDQtYjNkYzhkMmI5N2MxIiwiYWNjZXNzIjoiVmlldyIsImlhdCI6MTc2ODIxNTAzNX0.A8F-gSi40JQsLKpyzTAnbwtx0rbXWf5i5xnCQ5xjEqQ)

<sub>📐 **Diagrama Interactivo en MermaidChart** — Navega, amplía y explora cada componente de la arquitectura completa: Frontend Android (Kotlin/MVVM), Backend MCP (Node.js/Clean Architecture), Protocolos de Comunicación y Servicios Externos en la Nube</sub>

</div>

## 🔥 Últimas novedades

- **DeepSeek-V3.2**: Migración completa — inferencia más rápida y mejor lógica SQL.
- **Pipeline RAG**: Soporta chunking de PDFs y almacenamiento vectorial en Supabase/pgvector.
- **Text-to-SQL con autocorrección**: Mayor robustez frente a errores de esquema.

## 🧠 Resumen del motor de inteligencia

Este microservicio actúa como el "cerebro" del ecosistema CourseV. No sólo reenvía prompts: administra contexto, historial y agentes (Text-to-SQL, RAG, Grader).

### Bucle de refuerzo (Reinforcement Loop)
- Archivo principal: [src/domain/services/MCPService.js](src/domain/services/MCPService.js#L1)
- `index.js` funciona como rastreador de historial y control de repetición.
- Flujo: el fragmento de aprendizaje solicita ejercicios → el backend recupera el historial del usuario → el LLM genera preguntas semánticamente distintas.

### Agente analista (Text-to-SQL)
- Componente: `DatabaseQueryFragment` dentro de `MCPService`.
- Flujo: texto natural → obtención del esquema en vivo → DeepSeek genera SQL → capa de autocorrección reintenta ante errores.

### Agente evaluador (RAG / Grader)
- Integración: embeddings, búsqueda vectorial y comparación con rúbricas almacenadas en la base vectorial (Supabase).
- Resultado: feedback detallado y puntuado por ítem.

## 📂 Estructura del proyecto (resumen práctico)

```
MCP-backendDeploy/
├── index.js                     # Entrada principal y rastreador de historial
├── package.json
├── Dockerfile
├── docker-compose.yml
├── src/
│   ├── mcp-http.js
│   ├── mcp-stdio.js
│   ├── config/env.js
│   ├── domain/
│   │   ├── interfaces/
│   │   │   ├── IDocumentProcessor.js
│   │   │   ├── IEmbeddingProvider.js
│   │   │   └── IVectorStore.js
│   │   └── services/
│   │       ├── DocumentProcessor.js
│   │       ├── MCPService.js      # Lógica central (DeepSeek, agentes)
│   │       └── RAGService.js
│   └── infrastructure/
│       ├── ai/EmbeddingService.js
│       ├── ai/LLMService.js
│       ├── database/SupabaseService.js
│       └── ... (logger, middleware, servicios)
├── mcp-proxy/                    # Proxy y rutas auxiliares
│   └── index.js
├── scripts/                      # SQL y utilidades de DB
└── README.md
```

> Notas rápidas: la carpeta `src/infrastructure` contiene proveedores (Supabase, R2, GitHub, etc.). Las rutas de la API están en `src/interfaces/routes`.

## 🔌 Endpoints principales (ejemplos)

| Endpoint | Método | Función |
|---|---:|---|
| `/api/reinforcement` | POST | Genera preguntas únicas de refuerzo (por usuario/tema).
| `/api/sql/query` | POST | Texto natural → SQL ejecutable (con ciclo de autocorrección).
| `/mcp/message` | POST | Punto de entrada para integración MCP (mensajería/CLI).
| `/api/rag/ingest` | POST | Ingesta de documentos para pipeline RAG/vector store.

Para ver todas las rutas, revisa: [src/interfaces/routes](src/interfaces/routes#L1).

## 🛠️ Ejecución local y despliegue

Instalación y ejecución local:

```bash
npm install
npm start
```

Ejecución con Docker:

```bash
docker build -t coursev-backend .
docker run -p 3000:3000 coursev-backend
```

Despliegue sugerido: Railway, AWS Lambda o contenedor Docker en la nube.

## 📌 Archivos importantes

- [index.js](index.js#L1): punto de entrada y manejo de historial.
- [src/domain/services/MCPService.js](src/domain/services/MCPService.js#L1): lógica central de agentes y DeepSeek.
- [src/infrastructure/database/SupabaseService.js](src/infrastructure/database/SupabaseService.js#L1): conexión y almacenamiento vectorial.
- [mcp-proxy/index.js](mcp-proxy/index.js#L1): proxy y utilidades para rutas externas.

---

Parte del ecosistema CourseV — si quieres, puedo:

- Traducir al español los comentarios internos en `MCPService.js`.
- Generar un resumen de endpoints con ejemplos `curl`.
- Preparar un `docker-compose` mínimo para desarrollo.

Indica qué prefieres y lo implemento.
</div>
