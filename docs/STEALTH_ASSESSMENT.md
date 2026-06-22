# Stealth Assessment System (Evaluación Invisible)

> **Paper de referencia:** Stealth Assessment in Digital Games (Valerie Shute, 2011)

## Concepto

El sistema de Evaluación Invisible analiza el comportamiento del estudiante durante los quizzes **sin que este sepa que está siendo evaluado**. Esto elimina el estrés de los exámenes tradicionales y proporciona una "Radiografía de Comprensión" más precisa.

```
┌─────────────────────────────────────────────────────────────┐
│                    FLUJO DEL SISTEMA                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Estudiante hace quiz "sin presión"                         │
│               │                                             │
│               ▼                                             │
│      ┌──────────────────┐                                  │
│      │   IA analiza:    │                                  │
│      │ • Tiempo respuesta│                                  │
│      │ • Patrones error  │                                  │
│      │ • Confianza      │                                  │
│      │ • Cambios mente   │                                  │
│      └──────────────────┘                                  │
│               │                                             │
│               ▼                                             │
│     "Radiografía de Comprensión"                           │
│     (Solo visible para docentes)                           │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Métricas Capturadas (Invisibles al Estudiante)

| Métrica | Descripción | Qué Indica |
|---------|-------------|------------|
| `timeToFirstClick` | Tiempo hasta primera interacción | Velocidad de lectura/procesamiento |
| `timeToSubmit` | Tiempo total hasta enviar | Deliberación vs impulsividad |
| `answerChanges` | Veces que cambió la respuesta | Confianza/inseguridad |
| `changeHistory` | Historial de cambios con timestamps | Patrón de pensamiento |
| `focusLostCount` | Veces que salió de la pregunta | Nivel de distracción |
| `scrollEvents` | Eventos de scroll | Comportamiento de lectura |
| `hintUsed` | Si usó pista | Dependencia de ayudas |

## Patrones de Comportamiento Detectados

```javascript
behavioralPatterns = {
    guessing:       // Respuesta rápida + incorrecta + sin cambios = adivinando
    deliberate:     // Tiempo moderado + correcto = pensamiento deliberado
    struggling:     // Tiempo largo + incorrecto = dificultades
    secondGuessing: // Cambió respuesta + quedó mal = segunda-adivinanza
    distracted:     // Muchas pérdidas de foco = distracción
    hintDependency: // Uso frecuente de pistas = dependencia
}
```

## API Endpoints

### 1. Guardar Datos de Interacción

```http
POST /reinforcement/stealth-assessment
```

**Body:**
```json
{
  "userId": 123,
  "courseId": 456,
  "topicId": 789,
  "taskId": 101,
  "sessionId": "sess_abc123",
  "interactions": [
    {
      "questionId": "q_001",
      "questionType": "multiple_choice",
      "questionCategory": "algebra",
      "difficulty": 3,
      "timeToFirstClick": 2500,
      "timeToSubmit": 15000,
      "answerChanges": 1,
      "changeHistory": [
        { "from": 0, "to": 2, "timestamp": 12000 }
      ],
      "isCorrect": true,
      "hintUsed": false,
      "scrollEvents": 2,
      "focusLostCount": 0
    }
  ]
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "saved": 10,
    "analysis": {
      "comprehensionScore": 72,
      "confidenceIndex": 65,
      "cognitiveProfile": { ... },
      "weakAreas": [...],
      "strongAreas": [...],
      "behavioralPatterns": { ... },
      "recommendations": [...]
    }
  }
}
```

### 2. Obtener Radiografía de Comprensión (Solo Docentes)

```http
GET /reinforcement/stealth-assessment/xray?userId=123&courseId=456
```

**Response:**
```json
{
  "success": true,
  "data": {
    "hasData": true,
    "studentId": 123,
    "courseId": 456,
    "sessionsAnalyzed": 5,

    "overallComprehension": 68,
    "overallConfidence": 62,

    "comprehensionTrend": "improving",
    "confidenceTrend": "stable",

    "consistentWeakAreas": [
      { "category": "fracciones", "occurrences": 4 }
    ],
    "consistentStrongAreas": [
      { "category": "geometria", "occurrences": 5 }
    ],

    "dominantBehavioralPatterns": [
      { "pattern": "deliberate", "totalOccurrences": 35 },
      { "pattern": "secondGuessing", "totalOccurrences": 8 }
    ],

    "currentCognitiveProfile": {
      "learningStyle": "methodical_analytical",
      "masteryLevel": "competent",
      "masteryColor": "#FAB005",
      "stressIndicator": 25,
      "retentionPrediction": 70,
      "needsSupport": false,
      "readyForAdvanced": false
    },

    "recommendations": [
      {
        "priority": "high",
        "type": "focus_areas",
        "message": "Áreas que necesitan refuerzo: fracciones",
        "action": "Dedicar tiempo adicional a estudiar estos temas."
      }
    ],

    "aiInsights": "El estudiante muestra un estilo de aprendizaje metódico..."
  }
}
```

### 3. Analíticas de Curso (Para Docentes)

```http
GET /reinforcement/stealth-assessment/course-analytics?courseId=456
```

**Response:**
```json
{
  "success": true,
  "data": {
    "hasData": true,
    "courseId": 456,
    "totalStudents": 30,
    "totalSessions": 150,

    "avgCourseComprehension": 65,
    "avgCourseConfidence": 58,
    "studentsNeedingSupport": 8,
    "supportPercentage": 27,

    "masteryDistribution": {
      "expert": 3,
      "proficient": 8,
      "competent": 12,
      "developing": 5,
      "novice": 2
    },

    "topCourseWeakAreas": [
      { "category": "fracciones", "studentCount": 15 },
      { "category": "ecuaciones", "studentCount": 10 }
    ],

    "students": [
      { "userId": 123, "avgComprehension": 42, "needsSupport": true },
      { "userId": 124, "avgComprehension": 55, "needsSupport": true }
    ]
  }
}
```

## Scores y Cómo se Calculan

### Comprehension Score (0-100)
```
comprehensionScore =
    (accuracy × 0.40) +           // 40% peso en correctitud
    (confidenceIndex × 0.25) +    // 25% peso en confianza
    (consistencyScore × 0.20) +   // 20% peso en consistencia
    (engagementScore × 0.15)      // 15% peso en engagement
```

### Confidence Index (0-100)
Basado en:
- Tiempo de respuesta (muy rápido = baja confianza)
- Cambios de respuesta (muchos cambios = baja confianza)
- Correctitud (correcto sin cambios = alta confianza)
- Pérdida de foco (mucha distracción = baja confianza)

### Mastery Levels

| Level | Accuracy | Confidence | Color |
|-------|----------|------------|-------|
| expert | ≥90% | ≥75% | #51CF66 (verde) |
| proficient | ≥75% | ≥60% | #339AF0 (azul) |
| competent | ≥60% | ≥45% | #FAB005 (amarillo) |
| developing | ≥40% | - | #FF922B (naranja) |
| novice | <40% | - | #FF6B6B (rojo) |

## Integración en el Cliente (Android/Web)

El cliente debe capturar las métricas mientras el estudiante responde cada pregunta:

```kotlin
// Ejemplo en Android/Kotlin
data class QuestionInteraction(
    val questionId: String,
    val questionType: String,
    val questionCategory: String,
    val difficulty: Int,
    var timeToFirstClick: Long = 0,
    var timeToSubmit: Long = 0,
    var answerChanges: Int = 0,
    var changeHistory: MutableList<AnswerChange> = mutableListOf(),
    var isCorrect: Boolean = false,
    var hintUsed: Boolean = false,
    var scrollEvents: Int = 0,
    var focusLostCount: Int = 0
)

// Al cargar la pregunta
val startTime = System.currentTimeMillis()
var firstClickRecorded = false

// Al primer click en una opción
if (!firstClickRecorded) {
    interaction.timeToFirstClick = System.currentTimeMillis() - startTime
    firstClickRecorded = true
}

// Al cambiar respuesta
interaction.answerChanges++
interaction.changeHistory.add(AnswerChange(
    from = previousAnswer,
    to = newAnswer,
    timestamp = System.currentTimeMillis() - startTime
))

// Al enviar respuesta
interaction.timeToSubmit = System.currentTimeMillis() - startTime
interaction.isCorrect = checkAnswer()

// Al final del quiz, enviar todas las interacciones
api.saveStealthAssessment(sessionId, interactions)
```

## Base de Datos

```sql
-- Interacciones individuales
CREATE TABLE stealth_assessment_interactions (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    course_id BIGINT NOT NULL,
    session_id TEXT NOT NULL,
    question_id TEXT NOT NULL,
    time_to_first_click_ms INTEGER,
    time_to_submit_ms INTEGER,
    answer_changes INTEGER,
    is_correct BOOLEAN,
    ...
);

-- Resúmenes agregados (la "Radiografía")
CREATE TABLE stealth_assessment_summaries (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    course_id BIGINT NOT NULL,
    session_id TEXT NOT NULL,
    comprehension_score INTEGER,
    confidence_index INTEGER,
    cognitive_profile JSONB,
    weak_areas JSONB,
    recommendations JSONB,
    ...
);
```

## Privacidad y Ética

- Los datos de Stealth Assessment **NUNCA** se muestran al estudiante
- Solo docentes y administradores tienen acceso
- El objetivo es **ayudar**, no penalizar
- Las recomendaciones son para mejorar la enseñanza, no para etiquetar estudiantes
- Cumple con principios de evaluación formativa (no sumativa)

## Referencias

- Shute, V. J. (2011). Stealth assessment in computer-based games to support learning. Computer games and instruction, 55(2), 503-524.
- D'Mello, S., & Graesser, A. (2012). Dynamics of affective states during complex learning. Learning and Instruction, 22(2), 145-157.
- Baker, R. S., & Inventado, P. S. (2014). Educational data mining and learning analytics. In Learning analytics (pp. 61-75). Springer.
