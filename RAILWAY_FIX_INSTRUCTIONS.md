# 🚨 INSTRUCCIONES CRÍTICAS PARA ARREGLAR EL DESPLIEGUE EN RAILWAY

El error "Stopping Container" ocurre porque Railway detecta que la aplicación no está respondiendo correctamente en el puerto asignado. Para solucionarlo, **DEBES** seguir estos pasos manuales:

## 1. Limpiar Variables en Railway (IMPORTANTE)
Railway inyecta automáticamente el puerto. Si tú defines la variable `PORT`, causas un conflicto.

1. Ve al **Dashboard de Railway** (https://railway.app).
2. Selecciona tu proyecto -> Selecciona el servicio del backend.
3. Ve a la pestaña **Variables**.
4. Busca la variable llamada `PORT`.
5. **🗑️ ELIMÍNALA**. (Haz clic en el icono de basura).
6. Railway reiniciará el despliegue automáticamente.

## 2. Subir los Cambios
He modificado el código para que sea más robusto y muestre diagnósticos. Debes subir estos cambios a GitHub para que Railway los detecte.

Ejecuta en tu terminal:

```bash
cd distribucion_de_contexto/MCP-backendDeploy
git add .
git commit -m "Fix: Add debug logs and remove conflicts"
git push origin main
```

## 3. Verificar
Una vez desplegado, revisa los logs en Railway. Deberías ver algo como:

```
🚀 INICIANDO SERVIDOR - DIAGNÓSTICO DE ARRANQUE
📌 PORT (env): 6543  <-- (O cualquier número que Railway asigne)
...
✅ Server successfully bound to port 6543
```

Si ves esto, tu servidor está funcionando.

## 4. Sobre "Backend solo cuando lo usen"
Si quieres que el servidor se apague cuando no se usa para ahorrar dinero/créditos:
1. En Railway, ve a **Settings** (Configuración) del servicio.
2. Busca la sección **App Sleeping** (si tu plan lo permite).
3. Actívalo.
   - **Nota:** Si activas esto, la primera petición después de un tiempo tardará unos 10-20 segundos en responder mientras el servidor "despierta".

## 5. Acceso desde cualquier dispositivo
Ya he configurado `ALLOWED_ORIGINS: "*"` y el servidor escucha en `0.0.0.0`.
Para conectar tu app móvil, usa la URL pública que te da Railway (ej: `https://tu-proyecto.up.railway.app`). NO uses `localhost` ni IPs locales (192.168.x.x) en la app móvil si estás usando el backend de Railway.
