<div align="center">

# CourseV Backend
### Hub del Protocolo Model Context (MCP)

[![Node.js](https://img.shields.io/badge/Node.js-43853D?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![DeepSeek](https://img.shields.io/badge/Inteligencia-DeepSeek_V3.2-blue?style=for-the-badge)](https://deepseek.com)
[![Qwen](https://img.shields.io/badge/Embeddings-Qwen3_Embedding_8B-violet?style=for-the-badge)](https://huggingface.co/Qwen)
[![Protocol](https://img.shields.io/badge/Protocolo-MCP-orange?style=for-the-badge)](https://modelcontextprotocol.io)

API • Motor de inteligencia • Despliegue 
</div>


### 🗺️ Diagrama Interactivo Navegable  

<div align="center">
  
**Haz clic en la imagen para explorar el diagrama completo de la arquitectura de forma interactiva** 🔍

[![Arquitectura Completa del Sistema CourseV](https://pub-9f393625246c4018b5613be60b01bda1.r2.dev/data/arquitectura.png)](https://www.mermaidchart.com/app/projects/fa72bcaf-267c-492e-89e6-1c4b155de335/diagrams/2706f980-5691-4b44-bf04-b3dc8d2b97c1/share/invite/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJkb2N1bWVudElEIjoiMjcwNmY5ODAtNTY5MS00YjQ0LWJmMDQtYjNkYzhkMmI5N2MxIiwiYWNjZXNzIjoiVmlldyIsImlhdCI6MTc2ODIxNTAzNX0.A8F-gSi40JQsLKpyzTAnbwtx0rbXWf5i5xnCQ5xjEqQ)

<sub>📐 **Diagrama Interactivo en MermaidChart** — Navega, amplía y explora cada componente de la arquitectura completa: Frontend Android (Kotlin/MVVM), Backend MCP (Node.js/Clean Architecture), Protocolos de Comunicación y Servicios Externos en la Nube</sub>

</div>

## 🔥 Últimas novedades

- **Arquitectura Hexagonal v3.0**: Migración completa a Clean Architecture con contenedor DI, módulos por feature y puertos/adaptadores.
- **WhatsApp Integration**: Canal de comunicación vía Meta WhatsApp Business API con sesiones persistentes y multi-tenant.
- **ICFES Module**: Banco de preguntas oficial con pasajes de lectura, ingesta automatizada y seed scripts.
- **Socket.io en tiempo real**: Salas por curso y por usuario para notificaciones y eventos en vivo.
- **BullMQ Job Queues**: Generación asíncrona de preguntas de refuerzo con endpoint de polling.
- **Outbox + Idempotency**: Patrones de confiabilidad para eventos de dominio y operaciones POST.
- **Circuit Breaker**: Protección automática ante fallos en servicios externos.
- **TTS (Text-to-Speech)**: Síntesis de voz con OpenAI TTS para contenido de audio.
- **DeepSeek-V3.2 + Qwen3 Embedding 8B**: Inferencia pedagógica y embeddings semánticos de alta precisión.
- **Pipeline RAG**: Chunking de PDFs, almacenamiento vectorial en Supabase/pgvector y reranking.

## 🏛️ Arquitectura Hexagonal v3.0

El backend está organizado en tres capas con responsabilidades bien definidas:

### Capa de Bootstrap (`index.js` + `src/config/`)
- [`index.js`](index.js#L1): único punto de entrada — carga env, crea la app, inicia el servidor HTTP y el servidor Socket.io, ejecuta migraciones DDL en background y restaura recordatorios de tareas.
- [`src/config/server.js`](src/config/server.js#L1): monta CORS allowlist, Helmet, middlewares globales, enruta `/api/v1`, configura Idempotency Guard y health checks.
- [`src/config/container.js`](src/config/container.js#L1): contenedor de inyección de dependencias — instancia todos los repositorios, servicios, controladores y adaptadores.
- [`src/config/socketServer.js`](src/config/socketServer.js#L1): servidor Socket.io con salas por curso (`course:{id}`) y por usuario (`user:{id}`).
- [`src/config/tenantRegistry.js`](src/config/tenantRegistry.js#L1): registro multi-tenant con proxy dinámico de repositorios.

### Capa de Dominio / Módulos (`src/modules/`)
Cada módulo es autónomo con su propio servicio de dominio, controlador, rutas e infraestructura:

| Módulo | Descripción |
|---|---|
| `auth` | JWT, refresh tokens, registro público, autenticación cross-tenant |
| `user` / `persona` / `rol` | Gestión de usuarios, perfiles y roles RBAC |
| `course` / `subject` / `topic` | Catálogo educativo jerárquico con guard de curso activo |
| `video` | Subida, procesamiento (FFmpeg), streaming y feed público |
| `task` / `submission` / `grade` | Tareas, entregas, calificaciones y recordatorios programados |
| `content-item` | Ítems de contenido multimedia por tema |
| `progress` | Progreso del estudiante con leaderboard por curso |
| `reinforcement` / `reinforcement-result` | Generación asíncrona de preguntas únicas con BullMQ |
| `chat` | Chat persistente por curso con historial completo |
| `subscription` / `payment` | Suscripciones y pagos con Wompi (webhook incluido) |
| `notification` | Push (FCM), email (Brevo/SMTP) con cola de prioridad |
| `storage` | Almacenamiento en Cloudflare R2 con presigned URLs |
| `tts` | Síntesis de voz (OpenAI TTS) para contenido hablado |
| `whatsapp` | Mensajería WhatsApp vía Meta API, sesiones multi-tenant |
| `icfes` | Banco de preguntas ICFES con pasajes de lectura y simulacros |
| `institucion` | Gestión de instituciones educativas multi-tenant |
| `collaborator` / `like` / `comment` | Interacciones sociales en cursos |
| `period` | Períodos académicos por institución |
| `file-context` | Contexto de archivos para el agente LLM |
| `ai` | Motor de inteligencia: LLM, RAG, MCP, aprendizaje contextual |
| `health` | Health checks públicos y autenticados |
| `app-distribution` | Distribución de builds (APK/IPA) vía GitHub Releases |
| `excel` | Exportación de datos en formato Excel |

### Capa Compartida (`src/shared/`)
Infraestructura transversal reutilizable por todos los módulos:

| Componente | Responsabilidad |
|---|---|
| `database/SupabaseService.js` | Cliente Supabase singleton con health check |
| `database/SupabaseVectorStore.js` | Almacenamiento vectorial pgvector para RAG |
| `database/CachedRepository.js` | Decorador de repositorio con LRU en memoria |
| `cache/CacheAdapter.js` | Cache in-memory con TTL por clave |
| `middleware/AuthMiddleware.js` | Verificación JWT y RBAC con `requireRoles` |
| `middleware/TenantMiddleware.js` | Resolución del tenant desde el token JWT |
| `middleware/GranularRateLimiters.js` | Rate limiting por ruta y por usuario |
| `middleware/IdempotencyMiddleware.js` | Deduplicación de solicitudes POST por `Idempotency-Key` |
| `middleware/ErrorHandler.js` | Manejo centralizado de errores y respuestas HTTP |
| `infrastructure/CircuitBreaker.js` | Protección ante fallos en servicios externos |
| `events/EventBus.js` + `EventSubscriptions.js` | Bus de eventos de dominio (pub/sub interno) |
| `outbox/` | Patrón Outbox para garantía de entrega de eventos |
| `github/GitHubAdapter.js` | Integración con GitHub API (Octokit) |
| `math/` | Utilidades matemáticas para evaluación de ejercicios |
| `validators/` | Validadores compartidos con Zod |

## 🧠 Motor de Inteligencia (`src/modules/ai/`)

### Bucle de refuerzo (Reinforcement Loop)
- Servicio: [`src/modules/reinforcement/reinforcement.service.js`](src/modules/reinforcement/reinforcement.service.js#L1)
- Flujo: solicitud de ejercicios → BullMQ encola el job → `ReinforcementDomainService` recupera historial del usuario → DeepSeek genera preguntas → Qwen filtra duplicados semánticos → resultado disponible por polling.
- Endpoint de polling: `GET /api/v1/reinforcement/poll-generation/:jobId` (no requiere auth).

### Agente LLM + MCP
- [`src/modules/ai/mcp.service.js`](src/modules/ai/mcp.service.js#L1): lógica MCP moderna con protocolo JSON-RPC.
- [`src/modules/ai/llm.service.js`](src/modules/ai/llm.service.js#L1): orquestación de llamadas al LLM con contexto de aprendizaje.
- [`src/modules/ai/learning-context.service.js`](src/modules/ai/learning-context.service.js#L1): construcción del contexto pedagógico personalizado.

### Pipeline RAG
- [`src/modules/ai/rag.service.js`](src/modules/ai/rag.service.js#L1): ingesta de documentos, chunking, generación de embeddings y búsqueda semántica.
- [`src/modules/ai/infrastructure/embedding.service.js`](src/modules/ai/infrastructure/embedding.service.js#L1): embeddings con Qwen3 8B vía OpenRouter.
- [`src/modules/ai/infrastructure/rerank.service.js`](src/modules/ai/infrastructure/rerank.service.js#L1): reranking de resultados para mayor precisión.

### 🛡️ Arquitectura de Pensamiento Único (DeepSeek + Qwen3)

Para garantizar un aprendizaje evolutivo y evitar la fatiga por repetición, el backend actúa como un "Consejo Cognitivo" donde dos modelos de IA colaboran con roles estrictos:

1. **El Arquitecto Creativo (DeepSeek V3.2)**: función puramente pedagógica — analiza el historial del estudiante, detecta brechas de conocimiento y diseña escenarios de refuerzo complejos.

2. **El Juez Semántico (Qwen3 Embedding 8B)**: auditor de calidad y garante de unicidad — transforma cada pregunta en un vector semántico y bloquea cualquier concepto ya cubierto, incluso con palabras distintas.

#### Filtro "Zero-Duplication"
- **Nivel 1 — Validador de Identidad**: redacción no idéntica a ninguna anterior.
- **Nivel 2 — Auditoría Conceptual (Qwen)**: si el *significado* es igual al de una pregunta anterior, se rechaza y DeepSeek debe generar un ángulo completamente distinto.

<div align="center">

**Haz clic en el botón para ver el flujo de decisión de los agentes** 🔍

[![Diagrama de flujo](https://pub-9f393625246c4018b5613be60b01bda1.r2.dev/uploads/Untitled%20diagram-2026-02-07-004641.png)](https://mermaid.ai/app/projects/fa72bcaf-267c-492e-89e6-1c4b155de335/diagrams/a0a51f98-5ba2-4734-b1ec-96e510856661/share/invite/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJkb2N1bWVudElEIjoiYTBhNTFmOTgtNWJhMi00NzM0LWIxZWMtOTZlNTEwODU2NjYxIiwiYWNjZXNzIjoiVmlldyIsImlhdCI6MTc3MDQyNDE0MH0.LA4PARskFVvZR-_MNUT61ENR2HIk1of4w_fxlV29PC0)

<sub>🧠 **Flujo de Pensamiento Único** — Visualiza cómo DeepSeek y Qwen colaboran para garantizar la novedad conceptual en cada pregunta generada.</sub>

</div>

## 📂 Estructura del proyecto

```
mcp-backend-deploy/
├── index.js                          # Bootstrap: crea app, inicia HTTP + Socket.io, migraciones
├── package.json                      # v2.0.0 — ESM, scripts de seed/ingest ICFES
├── Dockerfile / docker-compose.yml
├── start.sh                          # Arranca ambos servidores (API + MCP)
├── src/
│   ├── mcp-http.js                   # Servidor MCP legacy HTTP (compatibilidad Android)
│   ├── mcp-stdio.js                  # Servidor MCP modo stdio (CLI/integración directa)
│   ├── config/
│   │   ├── env.js                    # Carga y validación de variables de entorno
│   │   ├── server.js                 # Express app factory: CORS, Helmet, rutas, middlewares
│   │   ├── container.js              # Contenedor DI — instancia todos los servicios
│   │   ├── socketServer.js           # Socket.io: salas por curso y por usuario
│   │   └── tenantRegistry.js         # Registro multi-tenant dinámico
│   ├── interfaces/
│   │   └── routes/
│   │       └── index.js              # Router central: monta los ~35 módulos bajo /api/v1
│   ├── modules/                      # Un directorio por feature (ver tabla arriba)
│   │   ├── ai/                       # LLM · RAG · MCP · learning-context
│   │   ├── auth/                     # JWT · refresh · registro público
│   │   ├── course/ subject/ topic/   # Catálogo educativo
│   │   ├── reinforcement/            # Preguntas únicas con BullMQ
│   │   ├── chat/                     # Chat persistente por curso
│   │   ├── whatsapp/                 # Meta WhatsApp Business API
│   │   ├── icfes/                    # Banco ICFES oficial
│   │   ├── payment/                  # Wompi + webhook
│   │   ├── notification/             # FCM + Email queue
│   │   ├── storage/                  # Cloudflare R2
│   │   ├── tts/                      # OpenAI Text-to-Speech
│   │   ├── video/                    # FFmpeg · streaming · feed público
│   │   └── ... (20+ módulos más)
│   └── shared/
│       ├── database/                 # Supabase, VectorStore, CachedRepository
│       ├── cache/                    # CacheAdapter in-memory con TTL
│       ├── middleware/               # Auth, Tenant, RateLimit, Idempotency, ErrorHandler
│       ├── infrastructure/           # CircuitBreaker
│       ├── events/                   # EventBus + EventSubscriptions (pub/sub)
│       ├── outbox/                   # Outbox pattern para entrega garantizada
│       ├── github/                   # GitHubAdapter (Octokit)
│       ├── math/                     # Evaluación de expresiones matemáticas
│       └── validators/               # Validadores Zod compartidos
├── mcp-proxy/
│   └── index.js                      # Proxy auxiliar para rutas externas
└── scripts/                          # SQL de migración, seed ICFES, utilidades
```

## 🔌 Endpoints principales (`/api/v1/`)

| Endpoint | Método | Función |
|---|---:|---|
| `/auth/login` | POST | Autenticación con JWT + refresh token |
| `/courses` | GET/POST | Catálogo de cursos (con guard de curso activo) |
| `/reinforcement` | POST | Encola generación asíncrona de preguntas únicas |
| `/reinforcement/poll-generation/:jobId` | GET | Polling de resultado (sin auth) |
| `/chat-messages` | GET/POST | Historial y envío de mensajes por curso |
| `/mcp/message` | POST | Punto de entrada protocolo MCP (JSON-RPC) |
| `/llm/chat` | POST | Chat directo con LLM y contexto pedagógico |
| `/rag/ingest` | POST | Ingesta de documentos al vector store |
| `/rag/query` | POST | Búsqueda semántica RAG |
| `/icfes` | GET/POST | Consulta y gestión del banco ICFES |
| `/whatsapp/webhook` | POST | Webhook de eventos Meta WhatsApp |
| `/payment/webhook` | POST | Webhook de pagos Wompi (sin auth) |
| `/storage/upload` | POST | Subida de archivos a Cloudflare R2 |
| `/tts/synthesize` | POST | Síntesis de texto a voz |
| `/notifications` | GET | Notificaciones del usuario en tiempo real |

Para ver todas las rutas: [src/interfaces/routes/index.js](src/interfaces/routes/index.js#L1).

## 🔴 Tiempo real (Socket.io)

El servidor Socket.io corre en el mismo puerto que la API HTTP (`/socket.io`):

| Evento (cliente → servidor) | Descripción |
|---|---|
| `join:course <courseId>` | Suscribirse a eventos del curso (materias, progreso) |
| `leave:course <courseId>` | Desuscribirse del curso |
| `join:user <userId>` | Recibir notificaciones personales en tiempo real |
| `leave:user <userId>` | Desuscribirse de notificaciones |

| Evento (servidor → cliente) | Descripción |
|---|---|
| `notification:unread_count` | Cantidad de notificaciones no leídas (al conectar) |

## 🛠️ Ejecución local y despliegue

Instalación y ejecución local:

```bash
npm install
npm start          # Inicia API HTTP (index.js) + MCP HTTP (mcp-http.js) en paralelo
npm run start:api  # Solo la API REST
npm run start:mcp  # Solo el servidor MCP
```

Ejecución con Docker:

```bash
docker build -t coursev-backend .
docker run -p 3000:3000 coursev-backend
```

Despliegue sugerido: Railway (recomendado, incluye `railway.json`), Docker en la nube.

## 📌 Archivos clave

- [index.js](index.js#L1): bootstrap — app factory, socket, migraciones.
- [src/config/container.js](src/config/container.js#L1): contenedor DI completo.
- [src/config/server.js](src/config/server.js#L1): Express con CORS, Helmet y rutas.
- [src/interfaces/routes/index.js](src/interfaces/routes/index.js#L1): router central con los ~35 módulos.
- [src/modules/ai/mcp.service.js](src/modules/ai/mcp.service.js#L1): lógica central MCP y agentes.
- [src/modules/ai/rag.service.js](src/modules/ai/rag.service.js#L1): pipeline RAG.
- [src/modules/reinforcement/reinforcement.service.js](src/modules/reinforcement/reinforcement.service.js#L1): motor de preguntas únicas.
- [src/shared/database/SupabaseService.js](src/shared/database/SupabaseService.js#L1): cliente Supabase singleton.
- [src/config/socketServer.js](src/config/socketServer.js#L1): servidor Socket.io.

---

Parte del ecosistema CourseV.
</div>
