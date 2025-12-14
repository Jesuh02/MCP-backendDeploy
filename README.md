# Microservicio: Distribución de Contexto para Granite/Ollama

Este microservicio en Node.js permite dividir o resumir el contexto de prompts enviados al modelo Granite/Ollama, asegurando que no se exceda el límite de 4096 tokens.

## ¿Cómo funciona?
- Recibe un prompt completo desde la app móvil (por ejemplo, desde `AIAnalysisService.kt`).
- Si el prompt supera los 4096 tokens:
  - Recorta y resume el contenido, manteniendo lo más relevante.
  - Envía el prompt ajustado al modelo Ollama.
- Devuelve la respuesta al cliente.

## Uso
1. Instala las dependencias:
   ```bash
   npm install
   ```
2. Inicia el microservicio:
   ```bash
   npm start
   ```
3. Realiza una petición POST a `/procesar-prompt` con el siguiente JSON:
   ```json
   {
     "prompt": "<PROMPT_COMPLETO>",
     "ollamaUrl": "http://localhost:11435" // URL de tu servidor Ollama
   }
   ```

## Ejemplo de integración con la app móvil
En `AIAnalysisService.kt`, cuando el prompt sea muy grande, envíalo a este microservicio antes de llamar a Ollama.

## Notas de red y prueba desde Android

- El microservicio en `index.js` está configurado para escuchar en `0.0.0.0` por defecto, lo que permite conexiones desde otros dispositivos en la misma red local.
- Desde un dispositivo Android físico en la misma Wi‑Fi, use la IP LAN del host (ejemplo en este repo: `http://192.168.1.158:3001/`).
- Si pruebas en el emulador de Android (Android Studio), use `http://10.0.2.2:3001/` para alcanzar el host.
- Si el teléfono no puede conectarse, verifique Windows Defender Firewall o reglas de red que permitan tráfico entrante en los puertos 3001 (microservicio) y 11435 (Ollama).

Comandos rápidos para verificar desde el host:
```
curl http://192.168.1.158:3001/
curl http://192.168.1.158:11435/
```

---

## 🔌 MCP (Model Context Protocol) para Visual Studio Code

Este microservicio incluye un servidor MCP que permite a Visual Studio Code (u otros clientes MCP) conectarse y consultar la base de datos de TareaMov directamente desde el editor.

### Configuración en VS Code

1. **Abre la configuración MCP** en tu workspace:
   - Crea o edita el archivo `.vscode/mcp.json` en tu proyecto

2. **Agrega la configuración del servidor**:
   ```json
   {
     "servers": {
       "tareamov-mcp-server": {
         "type": "sse",
         "url": "https://mcp-backenddeploy-production.up.railway.app/mcp/sse",
         "headers": {
           "X-API-Key": "tareamov-mcp-api-key-2025-secure"
         }
       }
     },
     "inputs": []
   }
   ```

3. **Reinicia VS Code** para que detecte el nuevo servidor MCP

### Herramientas Disponibles

Una vez conectado, tendrás acceso a las siguientes herramientas MCP:

| Herramienta | Descripción |
|-------------|-------------|
| `query_database` | Ejecuta consultas SQL o en lenguaje natural sobre la base de datos de TareaMov |
| `get_database_schema` | Obtiene el esquema completo de la base de datos con todas las tablas y columnas |
| `get_user_info` | Obtiene información detallada de un usuario específico |
| `get_course_info` | Obtiene información de un curso incluyendo videos y tareas |
| `get_task_submissions` | Obtiene todas las entregas de una tarea específica |
| `send_notification` | Envía notificaciones push y email a un usuario |

### Ejemplos de Uso

Desde el chat de GitHub Copilot en VS Code, puedes hacer preguntas como:

```
# Consultar usuarios
@tareamov-mcp-server query_database ¿Cuántos usuarios hay?

# Obtener esquema
@tareamov-mcp-server get_database_schema

# Consulta SQL directa
@tareamov-mcp-server query_database SELECT * FROM courses LIMIT 5
```

### Endpoints del Servidor MCP

| Endpoint | Método | Descripción |
|----------|--------|-------------|
| `/mcp/sse` | GET | Conexión SSE para clientes MCP (VS Code) |
| `/mcp/message` | POST | Recibe mensajes JSON-RPC del cliente |
| `/mcp` | POST | Endpoint unificado para llamadas directas |

### Probar la Conexión

Puedes probar que el servidor MCP está funcionando con este comando:

```powershell
Invoke-RestMethod -Uri "https://mcp-backenddeploy-production.up.railway.app/mcp" `
  -Method POST `
  -ContentType "application/json" `
  -Headers @{"X-API-Key"="tareamov-mcp-api-key-2025-secure"} `
  -Body '{"jsonrpc": "2.0", "method": "tools/list", "params": {}, "id": 1}'
```

O con curl:
```bash
curl -X POST "https://mcp-backenddeploy-production.up.railway.app/mcp" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: tareamov-mcp-api-key-2025-secure" \
  -d '{"jsonrpc": "2.0", "method": "initialize", "params": {}, "id": 1}'
```

---

**Autor:** GitHub Copilot
