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

**Autor:** GitHub Copilot
