1. El usuario define el curso

El usuario dice:

Quiero crear un curso de Machine Learning.

2. El chatbot recopila la información necesaria

Antes de generar el curso, el chatbot debe preguntar:

¿Cuál es el objetivo del curso?
¿Cuál es el nivel de dificultad? (Principiante, Intermedio, Avanzado)
¿Cuánto tiempo durará? (4 semanas, 8 semanas, 16 semanas, etc.)
¿Cuántas horas por semana estudiará el estudiante?
¿Qué perfil tiene el estudiante?

Ejemplo:

Objetivo: Formar desarrolladores capaces de crear modelos predictivos.

Nivel: Intermedio.

Duración: 12 semanas.

Dedicación: 6 horas semanales.

¿Qué hace el chatbot con esa información?

El chatbot no inventa materias ni temas al azar.

Utiliza tres variables principales:

A. Nivel

El nivel determina la profundidad.

Principiante

Conceptos básicos.
Poca teoría.
Ejemplos sencillos.
Menos materias.

Intermedio

Fundamentos + aplicación práctica.
Casos reales.
Más temas por materia.

Avanzado

Teoría profunda.
Optimización.
Casos complejos.
Proyectos grandes.
B. Objetivo

El objetivo determina qué materias son necesarias.

Ejemplo:

Objetivo:

Crear aplicaciones web.

Materias necesarias:

HTML y CSS
JavaScript
Backend
Bases de datos
Despliegue

Objetivo:

Convertirse en analista de datos.

Materias necesarias:

Estadística
Python
Visualización
Machine Learning
Proyecto aplicado

El objetivo es quien realmente define las materias.

C. Duración

La duración determina la cantidad de contenido.

Ejemplo:

Curso de 4 semanas

2 a 4 materias.
3 a 5 temas por materia.

Curso de 12 semanas

4 a 8 materias.
5 a 8 temas por materia.

Curso de 24 semanas

8 a 12 materias.
6 a 10 temas por materia.



Regla de generación

El chatbot debería seguir esta lógica:

Objetivo
↓
Competencias necesarias
↓
Materias
↓
Temas
↓
Contenido de estudio
↓
Tareas prácticas
Ejemplo completo

Usuario:

Quiero crear un curso de Python.

Chatbot:

¿Cuál es el objetivo?
¿Cuál es el nivel?
¿Cuánto durará?

Usuario:

Objetivo: Desarrollar aplicaciones con Python.

Nivel: Principiante.

Duración: 8 semanas.

Chatbot:

Curso Python para Desarrollo de Aplicaciones

Materia 1: Fundamentos de Python

Variables
Tipos de datos
Operadores
Condicionales
Bucles

Materia 2: Estructuras de Datos

Listas
Tuplas
Diccionarios
Conjuntos

Materia 3: Funciones y Módulos

Funciones
Parámetros
Módulos
Paquetes

Materia 4: Proyecto Aplicado

Diseño
Implementación
Pruebas

Cada tema tendría:

Tema
├── Contenido de estudio
└── Tarea práctica

La lógica profesional es:

Nivel = profundidad
Objetivo = materias necesarias
Duración = cantidad de materias y temas
Materia = conjunto de competencias
Tema = unidad de aprendizaje
Contenido = material de estudio
Tarea = aplicación práctica del tema