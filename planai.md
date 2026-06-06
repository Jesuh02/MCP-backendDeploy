# Flujo: IA generando un curso completo

## Fase 1 — El usuario hace el pedido

El usuario simplemente le dice a la IA algo como:

> *"Crea un curso de Álgebra Lineal para estudiantes de ingeniería, nivel intermedio, 3 meses de duración"*

La IA recoge de ahí: materia, audiencia, nivel, duración, y cualquier detalle extra que el usuario mencione.

---

## Fase 2 — La IA presenta el plan (solo texto, nada en BD todavía)

La IA responde con una **propuesta estructurada** en el chat, algo así:

```
📚 CURSO: Álgebra Lineal para Ingeniería

📌 SUBJECTS (materias):
  1. Vectores y Espacios Vectoriales
  2. Matrices y Transformaciones
  3. Valores y Vectores Propios

    └─ Subject 1 → TOPICS:
         - Operaciones con vectores
         - Producto punto y cruz
         └─ Topic 1 → TASKS:
              - Tarea: Ejercicios vectores básicos (fecha sugerida: semana 2)
              - Tarea: Quiz vectores (con límite de tiempo: 30 min)
```

Todo esto es **solo una propuesta en el mensaje del chat**. No tocó la base de datos aún.

---

## Fase 3 — El usuario negocia con la IA

Aquí viene la parte poderosa. El usuario puede responder en lenguaje natural:

> *"Quita el tema de producto cruz, y agrega un tema de matrices inversas en la subject 2, además la tarea quiz ponla para la semana 3"*

La IA actualiza el plan en el siguiente mensaje mostrando los cambios marcados, como un diff visual:

```
~~- Producto punto y cruz~~        ← eliminado
+ Producto punto solamente         ← ajustado
+ Matrices inversas                ← nuevo en Subject 2
📅 Quiz movido → semana 3
```

Esto puede repetirse **todas las veces que el usuario quiera**. Son solo mensajes de chat, cero escrituras a BD.

---

## Fase 4 — El usuario acepta

Cuando el usuario dice *"perfecto, créalo"* o hace clic en un botón **Confirmar y crear**, la IA ejecuta las inserciones en este orden (porque hay foreign keys que respetar):

```
1. INSERT courses          → obtiene course_id
2. INSERT subjects         → con course_id, obtiene subject_ids
3. INSERT topics           → con course_id + subject_id, obtiene topic_ids
4. INSERT tasks            → con topic_id
5. INSERT content_items    → con topic_id (si hay contenido textual)
```

Luego responde: *"✅ Curso creado. 3 materias, 9 temas, 12 tareas listas."*

---

## Lo clave del diseño

El truco de todo esto es que **la IA mantiene el plan completo en el contexto de la conversación** como un objeto JSON interno que va mutando con cada mensaje, pero el usuario solo ve la versión legible. Solo hasta el `confirm` ese JSON se convierte en llamadas a la API/BD.

Esto evita crear basura en la BD, permite iteración libre, y hace que la experiencia se sienta como hablar con un planeador humano.