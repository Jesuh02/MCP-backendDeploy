-- ============================================================================
-- MIGRACIÓN: Persistencia completa de chats por cuenta (estilo WhatsApp)
-- ============================================================================
-- Nuevas columnas para almacenar TODOS los datos del mensaje:
--   - excel_url: links de Excel generados
--   - attached_file_url/name/type: archivos adjuntos
--   - sender_avatar: avatar del remitente
-- Nuevos índices para consulta eficiente por usuario + origen (tipo de chat)
-- ============================================================================

ALTER TABLE public.chat_messages
  ADD COLUMN IF NOT EXISTS excel_url text,
  ADD COLUMN IF NOT EXISTS attached_file_url text,
  ADD COLUMN IF NOT EXISTS attached_file_name text,
  ADD COLUMN IF NOT EXISTS attached_file_type text,
  ADD COLUMN IF NOT EXISTS sender_avatar text;

-- Índice compuesto para cargar chats por cuenta + tipo de chat (como WhatsApp)
CREATE INDEX IF NOT EXISTS idx_chat_messages_user_origin
  ON public.chat_messages (usuario_id, origin);

-- Índice compuesto para session + timestamp (ordenamiento eficiente)
CREATE INDEX IF NOT EXISTS idx_chat_messages_session_ts
  ON public.chat_messages (session_id, "timestamp");
