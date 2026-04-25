# ICFES Ingest — Pipeline de extracción y carga

Extrae preguntas + imágenes desde los PDFs en `docs/icfes_content/**` y las
inserta en las tablas `icfes_questions / icfes_question_options / icfes_question_images`
siguiendo la arquitectura y el flujo descritos en
[requerimientosicfes](../../docs/icfes_content/2024-2025/requerimientosicfes).

## Arquitectura (hexagonal)

```
scripts/icfes_ingest/
├── domain/
│   ├── models.js          # Entidades puras + invariantes
│   └── ports.js           # Contratos (JSDoc)
├── adapters/
│   ├── folder-catalog.js       # Escaneo docs/icfes_content → PdfSource[]
│   ├── pdf-extractor.js        # pdfjs-dist: texto + imágenes embebidas
│   ├── image-storage.js        # Guarda imágenes (local / CDN-ready)
│   ├── taxonomy-resolver.js    # Mapea (área, stem) → subtopic_id
│   ├── answer-key-json.js      # Clave de respuesta curada (JSON por PDF)
│   ├── answer-key-llm.js       # Fallback: OpenAI infiere con confianza ≥0.8
│   ├── answer-key-chain.js     # Compositor: prueba resolvers en orden
│   └── pg-repository.js        # Inserta en Postgres (transaccional)
└── application/
    ├── ingest-pdf.js      # Caso de uso: un PDF
    └── ingest-library.js  # Caso de uso: librería completa
index.js                   # CLI / composition root
```

Reglas SOLID respetadas:
- **SRP**: cada adapter hace una sola cosa (parsear, guardar imágenes, resolver
  taxonomía, persistir).
- **DIP**: la aplicación depende de contratos (`ports.js`), no de `pg` ni `pdfjs`.
- **OCP**: para mover imágenes a Cloudflare R2 basta con implementar
  `ImageStoragePort` y re-cablear en `index.js`; nada más cambia.

## Instalación de dependencias

```powershell
cd MCP-backendDeploy
npm install pdfjs-dist@^4 pngjs@^7
```

> `pg` y `dotenv` ya están en `package.json`.

## Variables de entorno

```
DATABASE_URL=postgresql://user:pass@host:5432/db         # obligatoria

# Cloudflare R2 — si están las 4, las imágenes se suben automáticamente a R2
R2_ACCOUNT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
R2_ACCESS_KEY_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxx
R2_SECRET_ACCESS_KEY=xxxxxxxxxxxxxxxxxxxxxxxx
R2_BUCKET_NAME=coursev-files                             # opcional (default coursev-files)
R2_PUBLIC_URL=https://pub-xxxxxxxxxxxx.r2.dev            # obligatoria si usas R2
ICFES_R2_PREFIX=icfes                                    # opcional (default icfes)

# Fallback local (si NO hay R2 configurado)
ICFES_IMAGE_BASE_URL=https://cdn.coursev.co/icfes        # opcional (default: file:// local)

# LLM (resolución de respuestas correctas)
OPENAI_API_KEY=sk-...                                    # opcional: habilita resolver LLM
ICFES_ANSWER_MODEL=gpt-4o-mini                           # opcional (default)
ICFES_ANSWER_MIN_CONF=0.8                                # opcional (default 0.8)
```

Forzar el adaptador desde la CLI:

```powershell
node scripts/icfes_ingest/index.js --storage=r2     # obliga a usar R2 (falla si no hay env)
node scripts/icfes_ingest/index.js --storage=local  # obliga a guardar en disco
```

## Resolución de respuestas correctas (clave para falencia_score / IRT)

Los PDFs oficiales ICFES **no** traen la clave. Sin `is_correct` todo el motor
adaptativo queda bloqueado. Este pipeline resuelve la clave con una cadena
ordenada de resolvers:

1. **JSON curado** (`docs/icfes_content/answer-keys/<slug>.json`) — determinista,
   `confidence = 1.0`. Ver [answer-keys/README.md](../../docs/icfes_content/answer-keys/README.md).
2. **LLM (OpenAI)** — solo marca cuando `confidence ≥ ICFES_ANSWER_MIN_CONF`
   (por defecto 0.8). Si la pregunta depende de una imagen que no puede ver,
   el modelo devuelve `confidence` bajo y la pregunta queda sin marcar.
3. **Sin resolución** → queda para revisión manual (ver vista SQL abajo).

Cada marca guarda su procedencia en `icfes_question_options.answer_source`
(`json` | `llm` | `manual`) y `answer_confidence`. Así la capa de IRT puede
filtrar solo datos confiables:

```sql
-- Solo usar preguntas con respuesta de alta confianza para calcular falencia_score.
SELECT * FROM icfes_questions q
JOIN icfes_question_options o ON o.question_id = q.id
WHERE o.is_correct AND coalesce(o.answer_confidence, 0) >= 0.9;
```

Antes de la primera ingesta, aplica la migración de auditoría (idempotente):

```powershell
psql $env:DATABASE_URL -f scripts/migration_icfes_answer_audit.sql
```

## Uso

```powershell
# Ingesta completa (real)
node scripts/icfes_ingest/index.js

# Prueba en seco — no escribe en DB, solo valida extracción
node scripts/icfes_ingest/index.js --dry-run

# Filtrar por área ICFES
node scripts/icfes_ingest/index.js --area=CN

# Filtrar por año
node scripts/icfes_ingest/index.js --year=2023

# Deshabilitar LLM (solo JSON curado)
node scripts/icfes_ingest/index.js --no-llm
```

## Salida

- **DB**: filas en `icfes_questions` (con `source_reference` único tipo
  `2016/fisica/Fisica 2010.pdf#q12p3`), sus 4 opciones en `icfes_question_options`
  y las imágenes asociadas en `icfes_question_images`.
- **Imágenes**: en `data/icfes_images/*.{png,jpg}` (modo local) o subidas a
  Cloudflare R2 cuando configuras las env `R2_*`. Las URLs públicas quedan
  guardadas en `icfes_question_images.url` y son consumidas tal cual por el
  frontend (`IcfesExamView.vue` ya las renderiza por `position: stem |
  option_a..d`).

## Idempotencia

El repositorio usa `source_reference` como clave natural: ejecutar dos veces no
duplica filas.

## Notas del MVP

- **Revisión manual de pendientes**: la vista `v_icfes_questions_pending_review`
  lista las preguntas sin respuesta correcta confirmada. Úsala para curación
  o para dirigir re-ejecuciones con mejores JSON.
- Las **imágenes** se asocian a la pregunta cuyo rango Y las contiene y se
  clasifican como `stem` o `option_a..d` usando la posición Y de cada
  marcador A./B./C./D. Para PDFs sin coordenadas Y de imagen embebida (poco
  común), caen al fallback `stem` de la pregunta más cercana por encima.
- Los **embeddings** (`icfes_question_embeddings`) se generan en un job aparte
  para evitar costos durante la ingesta masiva; implementa el puerto
  `EmbedderPort` y llámalo desde un nuevo caso de uso `GenerateEmbeddings`.
