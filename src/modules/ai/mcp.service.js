/**
 * MCPDomainService — Caso de uso para el protocolo MCP (Model Context Protocol).
 *
 * Expone herramientas MCP (query_database, get_user_info, get_course_info, etc.)
 * como operaciones de dominio, delegando a los repositorios existentes.
 *
 * NO importa nada de infraestructura.
 */

import { Result } from '../../shared/Result.js';
import { ValidationError, NotFoundError } from '../../shared/errors/index.js';
import { getCurrentTenantId, hasTenantClient, runInTenantContext } from '../../config/tenantRegistry.js';
import { buildEducationalDocx } from './educational-document.builder.js';

const MCP_SUPPLEMENTAL_SUBJECT_TEMPLATES = [
    'Fundamentos y lenguaje profesional',
    'Aplicacion guiada',
    'Resolucion de problemas',
    'Casos complejos',
    'Integracion de competencias',
    'Proyecto profesional',
    'Trabajo autonomo y portafolio',
];

export class MCPDomainService {
    constructor({
            userRepository,
            courseRepository,
            taskRepository,
            submissionRepository,
            notificationService,
            llmPort,
            supabaseService,
            subjectRepository,
            fileStoragePort,
            contentItemRepository,
        }) {
            this.userRepo = userRepository;
            this.courseRepo = courseRepository;
            this.taskRepo = taskRepository;
            this.submissionRepo = submissionRepository;
            this.notificationService = notificationService;
            this.llm = llmPort;
            this.supabase = supabaseService || null;
            this.subjectRepo = subjectRepository || null;
            this.storage = fileStoragePort || null;
            this.contentItemRepo = contentItemRepository || null;
        }
        /**
         * Obtiene el schema de la base de datos.
         * @returns {Promise<Result>}
         */
    async getDatabaseSchema() {
        try {
            if (this.supabase && typeof this.supabase.getDatabaseSchema === 'function') {
                const ddl = await this.supabase.getDatabaseSchema();
                return Result.ok(ddl);
            }
            // Fallback: ejecutar directamente la consulta information_schema
            return Result.fail(new ValidationError('supabaseService no disponible para obtener el esquema'));
        } catch (err) {
            return Result.fail(new ValidationError(`Schema fetch falló: ${err.message}`));
        }
    }

    /**
     * Ejecuta una consulta SQL cruda contra la base de datos.
     * @param {string} query - Sentencia SQL (SELECT/INSERT/UPDATE/DELETE/WITH).
     * @returns {Promise<Result>}
     */
    async executeQuery(query) {
        if (!query || typeof query !== 'string' || !query.trim()) {
            return Result.fail(new ValidationError('query es requerido y debe ser una cadena SQL no vacía'));
        }
        if (!this.supabase || typeof this.supabase.executeRawSQL !== 'function') {
            return Result.fail(new ValidationError('supabaseService no disponible para ejecutar consultas'));
        }
        try {
            const data = await this.supabase.executeRawSQL(query);
            return Result.ok({ query, results: data, rowCount: Array.isArray(data) ? data.length : null });
        } catch (err) {
            return Result.fail(new ValidationError(`Ejecución SQL falló: ${err.message}`));
        }
    }

    /**
     * Obtiene información de un usuario.
     * Normalizes course plans before persistence so direct MCP tool calls create professional structures.
     */
    _normalizeCourseLevel(value) {
        const n = this._normalizeIntentText(value || '');
        if (!n) return '';
        if (/\b(principiante|basico|basic|beginner|inicial)\b/.test(n)) return 'beginner';
        if (/\b(intermedio|intermediate|medio)\b/.test(n)) return 'intermediate';
        if (/\b(avanzado|advanced|experto|profundo|profunda|profundidad|complejo|complejos)\b|buenas practicas/.test(n)) return 'advanced';
        return '';
    }

    _normalizeIntentText(value) {
        return String(value || '')
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .toLowerCase().replace(/\s+/g, ' ').trim();
    }

    _getCoursePlanTargets({ level, durationWeeks }) {
        const normalizedLevel = this._normalizeCourseLevel(level) || 'beginner';
        const duration = Math.max(1, Number(durationWeeks) > 0 ? Math.round(Number(durationWeeks)) : 8);
        const minTopics = Math.max(1, Math.ceil(duration / 2));
        const minSubjects = Math.max(1, Math.ceil(minTopics / 4));
        const evidenceMultiplier = normalizedLevel === 'advanced'
            ? 2.75
            : (normalizedLevel === 'intermediate' ? 2.4 : 2);
        const minTasks = Math.ceil(minTopics * evidenceMultiplier);
        const maxTasksPerTopic = normalizedLevel === 'advanced' ? 6 : (normalizedLevel === 'intermediate' ? 5 : 4);
        return {
            minSubjects,
            minTopics,
            minTasks,
            maxTasksPerTopic,
            evidenceMultiplier,
        };
    }

    _normalizeGeneratedCoursePlan(rawPlan) {
        const source = rawPlan && typeof rawPlan === 'object' ? rawPlan : {};
        const cleanText = (value, fallback = '') => {
            const text = String(value ?? '').replace(/\s+/g, ' ').trim();
            return text || fallback;
        };
        const level = this._normalizeCourseLevel(source.level) || 'beginner';
        const durationWeeks = Number(source.durationWeeks) > 0 ? Math.round(Number(source.durationWeeks)) : 8;
        const title = cleanText(source.title, 'Curso generado con IA');
        const focus = cleanText(source.category || title, title);
        const objective = cleanText(source.description, `desarrollar competencias solidas en ${focus}`);
        const targets = this._getCoursePlanTargets({ level, durationWeeks });

        const subjects = Array.isArray(source.subjects)
            ? source.subjects
                .filter(s => s && typeof s === 'object')
                .map((subject, subjectIndex) => this._normalizePlanSubject(subject, subjectIndex, { focus, objective, durationWeeks, targets }))
                .filter(s => s.name)
            : [];

        while (subjects.length < targets.minSubjects) {
            subjects.push(this._buildSupplementalSubject(subjects.length, { focus, objective, durationWeeks, targets }));
        }

        while (this._countPlanTopics(subjects) < targets.minTopics) {
            const subject = this._findSubjectWithFewestTopics(subjects);
            subject.topics.push(this._buildSupplementalTopic(subject, subject.topics.length, { focus, objective, durationWeeks, targets }));
        }

        this._fitSubjectsToDomainStages(subjects, { focus, objective, durationWeeks, targets });
        this._ensureSpecificTopicTitles(subjects, { focus });
        this._ensureModuleCoherence(subjects, { focus, objective });
        this._ensureModuleTopicCoherence(subjects, { focus, durationWeeks, targets });
        this._reduceTemplateMicroAssessments(subjects, targets);
        if (level !== 'beginner' || durationWeeks >= 8) {
            this._ensureTransversalProjectMilestones(subjects, { durationWeeks, focus, targets });
        }
        this._ensurePlanEvidenceDensity(subjects, { durationWeeks, focus, targets });
        this._limitFormalAssessments(subjects, { durationWeeks, focus });
        this._redistributeTopicDurations(subjects, durationWeeks);
        this._redistributePlanDueWeeks(subjects, durationWeeks);

        return {
            ...source,
            title,
            description: cleanText(source.description, `Curso de ${focus} orientado a ${objective}.`),
            category: cleanText(source.category, 'General'),
            level,
            durationWeeks,
            competencies: this._normalizeStringList(source.competencies, this._buildCompetencies(focus, objective)),
            learningOutcomes: this._normalizeStringList(source.learningOutcomes, this._buildLearningOutcomes(focus, level)),
            workload: this._normalizeWorkload(source.workload, durationWeeks, source.hoursPerWeek),
            subjects,
        };
    }

    _normalizePlanSubject(subject, subjectIndex, context) {
        const cleanText = (value, fallback = '') => String(value ?? '').replace(/\s+/g, ' ').trim() || fallback;
        const normalized = {
            name: cleanText(subject.name, `${MCP_SUPPLEMENTAL_SUBJECT_TEMPLATES[subjectIndex % MCP_SUPPLEMENTAL_SUBJECT_TEMPLATES.length]} de ${context.focus}`),
            description: cleanText(subject.description, `Desarrolla competencias especificas de ${context.focus} alineadas con el objetivo del curso.`),
            competency: cleanText(subject.competency, `Aplicar ${context.focus} para resolver problemas progresivamente mas complejos.`),
            learningOutcomes: this._normalizeStringList(subject.learningOutcomes, [
                `Explicar los conceptos clave de ${context.focus} usados en este modulo.`,
                `Aplicar tecnicas del modulo en una evidencia verificable.`,
            ]),
            integration: cleanText(subject.integration, subjectIndex === 0
                ? 'Establece la base conceptual y practica para los modulos posteriores.'
                : 'Usa aprendizajes previos y prepara una evidencia de mayor complejidad.'),
            topics: [],
        };
        normalized.topics = Array.isArray(subject.topics)
            ? subject.topics
                .filter(t => t && typeof t === 'object')
                .map((topic, topicIndex) => this._normalizePlanTopic(topic, topicIndex, normalized, context))
                .filter(t => t.title)
            : [];
        if (normalized.topics.length === 0) {
            normalized.topics.push(this._buildSupplementalTopic(normalized, 0, context));
        }
        return normalized;
    }

    _normalizePlanTopic(topic, topicIndex, subject, context) {
        const cleanText = (value, fallback = '') => String(value ?? '').replace(/\s+/g, ' ').trim() || fallback;
        const fallbackTitle = this._getDomainTopicTitles(context.focus || subject.name)[topicIndex] || `Bloque ${topicIndex + 1}: ${subject.name}`;
        const rawTitle = cleanText(topic.title || topic.name, fallbackTitle);
        const title = this._isGenericPlanTopicTitle(rawTitle) ? fallbackTitle : rawTitle;
        const contentDescription = cleanText(
            topic.contentDescription,
            `Documento de estudio sobre ${title}: introduce el tema con lenguaje sencillo, define cada concepto sin jerga innecesaria, explica por que importa, muestra ejemplos paso a paso, senala errores comunes, propone practica guiada y conecta el tema con situaciones reales de ${subject.name}.`,
        );
        const normalized = {
            title,
            description: cleanText(topic.description, `Aprende los conceptos de ${subject.name} con explicaciones claras, ejemplos guiados y aplicacion gradual en situaciones reales.`),
            estimatedWeeks: Number(topic.estimatedWeeks) > 0 ? Number(topic.estimatedWeeks) : undefined,
            estimatedHours: Number(topic.estimatedHours) > 0 ? Number(topic.estimatedHours) : undefined,
            independentHours: Number(topic.independentHours) >= 0 ? Number(topic.independentHours) : undefined,
            practicalHours: Number(topic.practicalHours) >= 0 ? Number(topic.practicalHours) : undefined,
            competency: cleanText(topic.competency, `Aplicar ${title} en una situacion profesional verificable.`),
            learningOutcome: cleanText(topic.learningOutcome || topic.learning_outcome, `El estudiante sera capaz de explicar ${title} con sus propias palabras y aplicarlo en una tarea guiada.`),
            prerequisites: this._normalizeStringList(topic.prerequisites, []),
            contentDescription: `${contentDescription} Debe quedar 100% explicativo para aprender: baja el tecnicismo, define la jerga, agrega ejemplos guiados, explica el razonamiento y evita que el archivo sea solo un resumen o una lista.`,
            tasks: [],
        };
        normalized.tasks = Array.isArray(topic.tasks)
            ? topic.tasks
                .filter(t => t && typeof t === 'object')
                .map((task, taskIndex) => this._normalizePlanTask(task, taskIndex, normalized, context))
                .filter(t => t.title)
            : [];
        return normalized;
    }

    _ensureSpecificTopicTitles(subjects, context) {
        const domainTitles = this._getDomainTopicTitles(context.focus);
        const seen = new Set();
        let topicIndex = 0;
        for (const subject of subjects) {
            for (const topic of (subject.topics || [])) {
                const normalized = this._normalizeIntentText(topic.title);
                if (this._isGenericPlanTopicTitle(topic.title) || /^bloque\s+\d+/.test(normalized) || seen.has(normalized)) {
                    topic.title = domainTitles[topicIndex % domainTitles.length];
                    topic.competency = `Aplicar ${topic.title} para resolver un caso profesional del curso.`;
                    topic.learningOutcome = `El estudiante sera capaz de producir una evidencia tecnica basada en ${topic.title}.`;
                }
                seen.add(this._normalizeIntentText(topic.title));
                topicIndex++;
            }
        }
    }

    _fitSubjectsToDomainStages(subjects, context) {
        const stages = this._getDomainModuleStages(context.focus);
        if (!stages.length || !Array.isArray(subjects)) return;
        const duration = Math.max(1, Number(context.durationWeeks) || 8);
        if (duration < 24) return;

        while (subjects.length < stages.length) {
            subjects.push(this._buildSupplementalSubject(subjects.length, context));
        }
        if (subjects.length <= stages.length) return;

        const extras = subjects.splice(stages.length);
        extras.forEach((extra, index) => {
            const target = subjects[index % stages.length];
            if (!Array.isArray(target.topics)) target.topics = [];
            target.topics.push(...(Array.isArray(extra.topics) ? extra.topics : []));
        });
    }

    _ensureModuleCoherence(subjects, context) {
        const stages = this._getDomainModuleStages(context.focus);
        if (!stages.length || !subjects.length) return;
        subjects.forEach((subject, index) => {
            const stage = stages[index % stages.length];
            subject.name = stage.name;
            subject.description = stage.description;
            subject.competency = stage.competency;
            subject.learningOutcomes = stage.learningOutcomes;
            subject.integration = index === 0
                ? 'Establece la base conceptual y practica que se reutiliza durante todo el curso y alimenta el proyecto transversal.'
                : `Integra el modulo anterior y prepara ${stages[Math.min(stages.length - 1, index + 1)]?.name || 'la siguiente etapa'} sin crear un proyecto separado.`;
        });
    }

    _ensureModuleTopicCoherence(subjects, context) {
        const stages = this._getDomainModuleStages(context.focus);
        if (!stages.length || !Array.isArray(subjects)) return;
        const duration = Math.max(1, Number(context.durationWeeks) || 8);
        const targetPerModule = duration >= 24
            ? Math.max(1, Math.ceil((Number(context.targets?.minTopics) || subjects.length) / stages.length))
            : 0;

        subjects.forEach((subject, subjectIndex) => {
            const stage = stages[subjectIndex % stages.length];
            const stageTitles = Array.isArray(stage.topicTitles) ? stage.topicTitles : [];
            if (!stageTitles.length) return;
            if (!Array.isArray(subject.topics)) subject.topics = [];

            while (targetPerModule && subject.topics.length < targetPerModule) {
                subject.topics.push(this._buildSupplementalTopic(subject, subject.topics.length, context));
            }

            const limit = targetPerModule || subject.topics.length;
            subject.topics = subject.topics.slice(0, Math.max(limit, stageTitles.length));
            subject.topics.forEach((topic, topicIndex) => {
                const title = stageTitles[topicIndex % stageTitles.length];
                topic.title = title;
                topic.description = this._buildTopicDescription(title, stage);
                topic.competency = this._buildTopicCompetency(title, stage);
                topic.learningOutcome = this._buildTopicLearningOutcome(title);
                topic.prerequisites = this._buildTopicPrerequisites(subjectIndex, topicIndex, subjects);
                topic.contentDescription = this._buildTopicContentDescription(title);
                topic.tasks = this._buildCoherentTopicTasks(topic, { ...context, subjectIndex, topicIndex });
            });
        });
    }

    _buildTopicDescription(title, stage = {}) {
        const profile = this._getTopicProfile(title);
        if (profile.description) return profile.description;
        return `Bloque del modulo "${stage.name || 'curso'}" que explica ${title} desde sus fundamentos, con ejemplos y aplicaciones progresivas.`;
    }

    _buildTopicCompetency(title, stage = {}) {
        return `Aplicar ${title} en coherencia con la competencia del modulo: ${stage.competency || 'resolver problemas profesionales del curso'}.`;
    }

    _buildTopicLearningOutcome(title) {
        return `Al finalizar este bloque el estudiante sera capaz de explicar ${title} en lenguaje claro, reconocer sus conceptos principales y aplicarlos en una evidencia verificable.`;
    }

    _buildTopicPrerequisites(subjectIndex, topicIndex, subjects) {
        if (subjectIndex === 0 && topicIndex === 0) return ['Algebra lineal basica', 'Probabilidad descriptiva', 'Programacion en Python'];
        const currentSubject = subjects[subjectIndex] || {};
        const previousTopic = topicIndex > 0
            ? currentSubject.topics?.[topicIndex - 1]
            : subjects[subjectIndex - 1]?.topics?.slice(-1)?.[0];
        return previousTopic?.title
            ? [`Dominio practico de ${previousTopic.title}`]
            : ['Fundamentos del modulo anterior'];
    }

    _buildTopicContentDescription(title) {
        const profile = this._getTopicProfile(title);
        const base = profile.contentDescription || `Documento de estudio sobre ${title}.`;
        return `${base} Debe escribirse como material 100% explicativo para aprender: definiciones en palabras simples, explicacion paso a paso, ejemplos guiados, analogias cuando ayuden, practica aplicada, errores frecuentes y criterios de calidad explicados sin jerga innecesaria.`;
    }

    _buildCoherentTopicTasks(topic, context = {}) {
        const templates = this._getTopicEvidenceTemplates(topic.title);
        const count = Math.min(3, Math.max(2, Number(context.targets?.maxTasksPerTopic) ? 2 : 2));
        return templates.slice(0, count).map((template, index) => ({
            title: `${template.label}: ${topic.title}`,
            type: template.type,
            description: template.description(topic.title),
            dueWeek: this._suggestDueWeekByTopic(context.topicIndex || 0, index, context.durationWeeks),
            contentDescription: template.content(topic.title),
        }));
    }

    _getTopicProfile(title) {
        const n = this._normalizeIntentText(title);
        if (/fundamentos de aprendizaje automatico/.test(n)) {
            return {
                description: 'Define problemas predictivos, tipos de aprendizaje, variables, datos, objetivos y criterios basicos para decidir si un caso requiere aprendizaje automatico.',
                contentDescription: 'Documento introductorio con tipos de problemas, ejemplos de clasificacion/regresion, criterios de viabilidad, riesgos comunes y ejercicios de formulacion.',
            };
        }
        if (/preparacion de datos|analisis exploratorio/.test(n)) {
            return {
                description: 'Limpia, explora y documenta conjuntos de datos para detectar calidad, distribuciones, valores atipicos y relaciones relevantes antes del modelado.',
                contentDescription: 'Documento centrado en EDA: calidad de datos, perfiles estadisticos, visualizaciones, tratamiento de faltantes, outliers y bitacora de decisiones.',
            };
        }
        if (/ingenieria y seleccion de caracteristicas/.test(n)) {
            return {
                description: 'Construye, transforma y selecciona caracteristicas relevantes evitando fuga de informacion y mejorando la capacidad predictiva del modelo.',
                contentDescription: 'Documento sobre feature engineering: codificacion, escalado, seleccion, leakage, importancia de variables y validacion de transformaciones.',
            };
        }
        if (/validacion de datos|particion experimental/.test(n)) {
            return {
                description: 'Disena particiones experimentales confiables y valida datos de entrenamiento, prueba y produccion para reducir leakage y sesgos iniciales.',
                contentDescription: 'Documento sobre particion experimental: holdout, estratificacion, particiones temporales, validacion de esquemas, leakage y trazabilidad de datasets.',
            };
        }
        if (/procesamiento de lenguaje natural|nlp/.test(n)) {
            return {
                description: 'Estudia representacion, limpieza, modelado y evaluacion de texto para tareas de clasificacion, extraccion y analisis semantico.',
                contentDescription: 'Documento centrado en NLP: tokenizacion, embeddings, modelos de lenguaje, evaluacion de tareas de texto, errores frecuentes y ejercicios con corpus reales.',
            };
        }
        if (/vision artificial/.test(n)) {
            return {
                description: 'Aborda captura, preprocesamiento, representacion y evaluacion de imagenes para clasificacion, deteccion o segmentacion visual.',
                contentDescription: 'Documento centrado en vision artificial: pipelines de imagen, aumento de datos, CNN/transformers visuales a nivel aplicado, metricas visuales y analisis de errores.',
            };
        }
        if (/clasificacion/.test(n)) {
            return {
                description: 'Entrena y evalua modelos de clasificacion para asignar categorias, analizar matrices de confusion y balancear precision, recall y F1.',
                contentDescription: 'Documento centrado en clasificacion supervisada: regresion logistica como clasificador, k-NN, arboles, metricas de clasificacion, umbrales y tratamiento de clases desbalanceadas.',
            };
        }
        if (/regresion/.test(n)) {
            return {
                description: 'Modela variables continuas, compara errores y analiza supuestos, residuos y sensibilidad de modelos predictivos numericos.',
                contentDescription: 'Documento centrado en regresion: regresion lineal y no lineal, MAE/RMSE/R2, validacion de supuestos, analisis de residuos y comparacion de modelos.',
            };
        }
        if (/validacion rigurosa|generalizacion|sobreajuste|sesgo/.test(n)) {
            return {
                description: 'Profundiza en validacion, generalizacion, metricas, sesgo, varianza, sobreajuste y criterios para confiar en un modelo fuera del conjunto de entrenamiento.',
                contentDescription: 'Documento centrado en evaluacion rigurosa: holdout, cross-validation, leakage, sesgo-varianza, sobreajuste, metricas por tipo de problema e interpretacion de resultados.',
            };
        }
        if (/ajuste de hiperparametros|comparacion de modelos/.test(n)) {
            return {
                description: 'Compara familias de modelos y ajusta hiperparametros con protocolos reproducibles, evitando optimizar contra el conjunto de prueba.',
                contentDescription: 'Documento sobre busqueda de hiperparametros, validacion cruzada, baselines, comparacion justa de modelos y reporte reproducible de resultados.',
            };
        }
        if (/recomendacion/.test(n)) {
            return {
                description: 'Presenta sistemas de recomendacion como caso especial aplicado, con filtrado colaborativo, contenido, ranking y evaluacion offline/online.',
                contentDescription: 'Documento de caso especial sobre recomendadores: matrices usuario-item, similitud, ranking, precision@k, cold start y riesgos de sesgo.',
            };
        }
        if (/series temporales|anomalias/.test(n)) {
            return {
                description: 'Presenta series temporales como caso especial aplicado, con ventanas, tendencia, estacionalidad, pronostico y deteccion de anomalias.',
                contentDescription: 'Documento de caso especial sobre series temporales: particion temporal, features de ventana, backtesting, metricas de pronostico y deteccion de anomalias.',
            };
        }
        if (/registro de experimentos|trazabilidad/.test(n)) {
            return {
                description: 'Registra configuraciones, datos, metricas, artefactos y decisiones para reproducir experimentos y auditar resultados de modelos.',
                contentDescription: 'Documento sobre tracking de experimentos: parametros, metricas, artefactos, bitacoras, comparacion de corridas y criterios de reproducibilidad.',
            };
        }
        if (/versionado de datos|pipelines|modelos/.test(n)) {
            return {
                description: 'Versiona datasets, pipelines y modelos para controlar cambios, recuperar estados y coordinar ciclos de entrenamiento y despliegue.',
                contentDescription: 'Documento sobre versionado en MLOps: datasets, features, pipelines, modelos, artefactos, dependencias y estrategias de rollback.',
            };
        }
        if (/observabilidad|monitoreo|deriva/.test(n)) {
            return {
                description: 'Monitorea rendimiento, calidad de datos, deriva y alertas operativas para detectar degradacion del modelo en produccion.',
                contentDescription: 'Documento sobre observabilidad de modelos: metricas online/offline, deriva de datos y concepto, alertas, dashboards y acciones de mantenimiento.',
            };
        }
        if (/gobernanza|riesgos|metricas de negocio/.test(n)) {
            return {
                description: 'Conecta desempeno tecnico con riesgo, cumplimiento, impacto de negocio y criterios de decision para operar modelos responsablemente.',
                contentDescription: 'Documento sobre gobernanza: riesgos, responsables, aprobaciones, metricas de negocio, documentacion, auditoria y planes de mitigacion.',
            };
        }
        return {};
    }

    _getTopicEvidenceTemplates(title) {
        const n = this._normalizeIntentText(title);
        if (/clasificacion/.test(n)) return [
            { label: 'Laboratorio de clasificacion', type: 'milestone', description: t => `Entrena clasificadores para ${t} y analiza matriz de confusion, precision, recall y F1.`, content: t => `Guia con dataset, preparacion, entrenamiento de clasificadores, analisis de errores y rubrica especifica para ${t}.` },
            { label: 'Informe tecnico de metricas', type: 'assessment', description: t => `Justifica la seleccion del clasificador con metricas de clasificacion y analisis de umbrales.`, content: t => `Plantilla de informe tecnico, criterios de comparacion y ejemplos de interpretacion de metricas para ${t}.` },
        ];
        if (/preparacion de datos|analisis exploratorio/.test(n)) return [
            { label: 'Bitacora de calidad de datos', type: 'milestone', description: t => `Documenta hallazgos de calidad, distribuciones, faltantes y decisiones de limpieza para ${t}.`, content: t => `Guia de EDA con checklist de calidad, visualizaciones requeridas y bitacora de decisiones para ${t}.` },
            { label: 'Informe exploratorio reproducible', type: 'assessment', description: t => `Entrega un notebook o reporte reproducible con conclusiones accionables del analisis exploratorio.`, content: t => `Plantilla de reporte EDA, criterios de reproducibilidad y rubrica de interpretacion para ${t}.` },
        ];
        if (/ingenieria y seleccion de caracteristicas/.test(n)) return [
            { label: 'Laboratorio de caracteristicas', type: 'milestone', description: t => `Construye y compara caracteristicas evitando fuga de informacion.`, content: t => `Guia con transformaciones, seleccion de variables, pruebas de leakage y criterios de mejora para ${t}.` },
            { label: 'Code review de transformaciones', type: 'formative', description: t => `Revisa si las transformaciones son reproducibles, justificadas y seguras para entrenamiento.`, content: t => `Lista de chequeo para revisar pipelines de features y riesgos de leakage en ${t}.` },
        ];
        if (/validacion de datos|particion experimental/.test(n)) return [
            { label: 'Diseno experimental', type: 'milestone', description: t => `Propone particiones y validaciones de datos acordes con el problema.`, content: t => `Guia para holdout, estratificacion, particion temporal, validacion de esquemas y control de leakage en ${t}.` },
            { label: 'Auditoria de particion', type: 'assessment', description: t => `Evalua si una particion experimental sostiene conclusiones confiables.`, content: t => `Rubrica de auditoria para detectar leakage, sesgo de muestreo y fallos de particion en ${t}.` },
        ];
        if (/regresion/.test(n)) return [
            { label: 'Benchmark de regresion', type: 'milestone', description: t => `Compara modelos de regresion con MAE, RMSE y analisis de residuos.`, content: t => `Guia de benchmark con particion de datos, metricas de error y analisis de residuos para ${t}.` },
            { label: 'Code review de pipeline predictivo', type: 'formative', description: t => `Revisa reproducibilidad, limpieza y supuestos de un pipeline de regresion.`, content: t => `Lista de chequeo para revisar codigo, supuestos y decisiones tecnicas en ${t}.` },
        ];
        if (/validacion rigurosa|generalizacion|sobreajuste|sesgo/.test(n)) return [
            { label: 'Auditoria de generalizacion', type: 'assessment', description: t => `Detecta leakage, sobreajuste, sesgo y debilidades de validacion en un experimento.`, content: t => `Guia de auditoria con pruebas de validacion, sesgo-varianza, leakage y seleccion de metricas para ${t}.` },
            { label: 'Debate tecnico de metricas', type: 'milestone', description: t => `Defiende que metrica usar segun el riesgo y el objetivo del problema.`, content: t => `Material para debate con escenarios, tradeoffs de metricas y criterios de decision para ${t}.` },
        ];
        if (/ajuste de hiperparametros|comparacion de modelos/.test(n)) return [
            { label: 'Benchmark de seleccion de modelos', type: 'milestone', description: t => `Compara baselines y modelos ajustados con protocolo reproducible.`, content: t => `Guia de benchmark con grid/random search, validacion cruzada, tabla comparativa y control de prueba para ${t}.` },
            { label: 'Presentacion de tradeoffs', type: 'assessment', description: t => `Defiende la seleccion final considerando desempeno, costo, interpretabilidad y riesgo.`, content: t => `Plantilla de presentacion tecnica y rubrica para justificar decisiones en ${t}.` },
        ];
        if (/vision artificial/.test(n)) return [
            { label: 'Laboratorio de vision artificial', type: 'milestone', description: t => `Construye un pipeline visual y evalua errores de clasificacion, deteccion o segmentacion.`, content: t => `Guia con dataset de imagenes, preprocesamiento, aumento de datos, evaluacion visual y rubrica para ${t}.` },
            { label: 'Analisis de errores visuales', type: 'assessment', description: t => `Presenta fallos del modelo visual y propone mejoras basadas en evidencia.`, content: t => `Plantilla de analisis cualitativo/cuantitativo de errores visuales para ${t}.` },
        ];
        if (/procesamiento de lenguaje natural|nlp/.test(n)) return [
            { label: 'Laboratorio de NLP', type: 'milestone', description: t => `Procesa un corpus textual y evalua una tarea de clasificacion, extraccion o similitud semantica.`, content: t => `Guia con corpus, limpieza de texto, representaciones, entrenamiento y evaluacion de tareas de ${t}.` },
            { label: 'Analisis de articulo de NLP', type: 'formative', description: t => `Relaciona una tecnica de NLP con sus supuestos, limites y riesgos de sesgo.`, content: t => `Lectura guiada, preguntas de analisis tecnico y rubrica breve para ${t}.` },
        ];
        if (/recomendacion/.test(n)) return [
            { label: 'Prototipo de recomendador', type: 'project', description: t => `Implementa un recomendador simple y evalua ranking, cold start y sesgos.`, content: t => `Guia de caso especial con datos usuario-item, baseline, metricas de ranking y riesgos para ${t}.` },
            { label: 'Presentacion de decisiones de ranking', type: 'milestone', description: t => `Explica decisiones de ranking y sus impactos de producto.`, content: t => `Plantilla de presentacion tecnica con criterios de negocio y metricas para ${t}.` },
        ];
        if (/series temporales|anomalias/.test(n)) return [
            { label: 'Backtesting de serie temporal', type: 'milestone', description: t => `Evalua un pronostico o detector de anomalias respetando particion temporal.`, content: t => `Guia de backtesting, ventanas, metricas temporales y analisis de anomalias para ${t}.` },
            { label: 'Informe de riesgo temporal', type: 'assessment', description: t => `Documenta limitaciones de estacionalidad, deriva y horizonte de prediccion.`, content: t => `Plantilla de informe tecnico para riesgos y decisiones en ${t}.` },
        ];
        if (/registro de experimentos|trazabilidad/.test(n)) return [
            { label: 'Bitacora de experimentos', type: 'milestone', description: t => `Registra corridas, parametros, metricas y artefactos comparables.`, content: t => `Guia de tracking con convenciones de nombres, parametros, metricas y artefactos para ${t}.` },
            { label: 'Auditoria de reproducibilidad', type: 'assessment', description: t => `Verifica si un experimento puede reproducirse y auditarse.`, content: t => `Checklist de reproducibilidad, evidencia requerida y rubrica de trazabilidad para ${t}.` },
        ];
        if (/versionado de datos|pipelines|modelos/.test(n)) return [
            { label: 'Practica de versionado MLOps', type: 'milestone', description: t => `Versiona datos, pipeline y modelo con cambios rastreables.`, content: t => `Guia de versionado de datasets, artefactos, pipelines, dependencias y rollback para ${t}.` },
            { label: 'Code review de pipeline', type: 'formative', description: t => `Revisa mantenibilidad, reproducibilidad y riesgos de un pipeline versionado.`, content: t => `Lista de chequeo para revisar estructura, dependencias, artefactos y automatizacion en ${t}.` },
        ];
        if (/observabilidad|monitoreo|deriva/.test(n)) return [
            { label: 'Dashboard de monitoreo', type: 'project', description: t => `Define metricas, alertas y visualizaciones para detectar degradacion.`, content: t => `Guia para disenar dashboard, umbrales, alertas, deriva y acciones operativas en ${t}.` },
            { label: 'Informe de incidente de deriva', type: 'assessment', description: t => `Analiza un caso de deriva y propone acciones de mantenimiento.`, content: t => `Plantilla de postmortem tecnico con sintomas, hipotesis, evidencia y plan de respuesta para ${t}.` },
        ];
        if (/gobernanza|riesgos|metricas de negocio/.test(n)) return [
            { label: 'Matriz de gobernanza y riesgo', type: 'assessment', description: t => `Relaciona riesgos, responsables, controles y metricas de negocio del modelo.`, content: t => `Plantilla de matriz de gobernanza, riesgos, aprobaciones, metricas e indicadores para ${t}.` },
            { label: 'Presentacion ejecutiva de valor', type: 'milestone', description: t => `Comunica impacto, limites y decisiones de operacion del modelo a un publico no tecnico.`, content: t => `Guia de presentacion ejecutiva con narrativa, metricas de negocio, riesgos y recomendaciones para ${t}.` },
        ];
        return [
            { label: 'Laboratorio aplicado', type: 'milestone', description: t => `Aplica ${t} en un caso practico con entregable verificable.`, content: t => `Guia de laboratorio con pasos, criterios de calidad y rubrica para ${t}.` },
            { label: 'Informe tecnico', type: 'assessment', description: t => `Argumenta decisiones, resultados y limites del trabajo realizado en ${t}.`, content: t => `Plantilla de informe tecnico y criterios de evaluacion para ${t}.` },
        ];
    }

    _suggestDueWeekByTopic(topicIndex, taskIndex, durationWeeks) {
        const duration = Math.max(1, Number(durationWeeks) || 8);
        const topicCount = Math.max(1, Math.ceil(duration / 2));
        const week = Math.round(((topicIndex + 1) / topicCount) * duration) + taskIndex;
        return Math.min(duration, Math.max(1, week));
    }

    _getDomainModuleStages(focus) {
        const n = this._normalizeIntentText(focus);
        if (/\b(machine learning|aprendizaje automatico|deep learning|inteligencia artificial|ia|ciencia de datos|data science)\b/.test(n)) {
            return [
                {
                    name: 'Fundamentos y preparacion de datos',
                    description: 'Construye la base conceptual, prepara datos confiables y define criterios de experimentacion para modelos predictivos.',
                    competency: 'Preparar datos y formular problemas de aprendizaje automatico con criterios tecnicos verificables.',
                    learningOutcomes: ['Distinguir tipos de problemas de aprendizaje automatico.', 'Construir conjuntos de datos listos para entrenamiento.'],
                    topicTitles: [
                        'Fundamentos de aprendizaje automatico y tipos de problemas',
                        'Preparacion de datos y analisis exploratorio',
                        'Ingenieria y seleccion de caracteristicas',
                        'Validacion de datos y particion experimental',
                    ],
                },
                {
                    name: 'Modelado supervisado y seleccion de modelos',
                    description: 'Desarrolla modelos de clasificacion, regresion y ensambles con comparacion tecnica de resultados.',
                    competency: 'Entrenar y comparar modelos supervisados adecuados al problema y a los datos disponibles.',
                    learningOutcomes: ['Implementar modelos supervisados base y avanzados.', 'Seleccionar modelos con metricas y validacion reproducibles.'],
                    topicTitles: [
                        'Modelos de clasificacion supervisada',
                        'Modelos de regresion y metricas de error',
                        'Validacion rigurosa, generalizacion, sesgo y sobreajuste',
                        'Ajuste de hiperparametros y comparacion de modelos',
                    ],
                },
                {
                    name: 'Aplicaciones avanzadas de aprendizaje automatico',
                    description: 'Aplica modelos a dominios especializados sin mezclar esta etapa con la operacion del ciclo de vida.',
                    competency: 'Implementar soluciones de aprendizaje automatico en dominios de aplicacion avanzados.',
                    learningOutcomes: ['Resolver casos aplicados de vision artificial y lenguaje natural.', 'Seleccionar enfoques para recomendacion, secuencias y series temporales.'],
                    topicTitles: [
                        'Vision artificial aplicada',
                        'Procesamiento de lenguaje natural',
                        'Caso optativo: sistemas de recomendacion',
                        'Caso optativo: series temporales y deteccion de anomalias',
                    ],
                },
                {
                    name: 'Operacion y gestion de modelos',
                    description: 'Organiza MLOps, versionado, observabilidad, gobernanza y valor de negocio sin repetir preparacion de datos.',
                    competency: 'Operar modelos como productos de datos mantenibles, medibles y gobernados.',
                    learningOutcomes: ['Versionar experimentos y modelos con trazabilidad.', 'Definir monitoreo, gobernanza y metricas de negocio para una solucion predictiva.'],
                    topicTitles: [
                        'Registro de experimentos y trazabilidad',
                        'Versionado de datos, pipelines y modelos',
                        'Observabilidad, monitoreo y deriva',
                        'Gobernanza, riesgos y metricas de negocio',
                    ],
                },
            ];
        }
        if (/\b(programacion|software|python|javascript|web|backend|frontend)\b/.test(n)) {
            return [
                {
                    name: 'Fundamentos del lenguaje y calidad base',
                    description: 'Establece el entorno, las estructuras del lenguaje y practicas basicas de calidad.',
                    competency: 'Construir programas pequenos y correctos usando fundamentos del lenguaje.',
                    learningOutcomes: ['Organizar codigo legible y ejecutable.', 'Resolver problemas basicos con estructuras de datos y control de flujo.'],
                },
                {
                    name: 'Arquitectura, datos e integraciones',
                    description: 'Conecta componentes, datos y servicios con estructuras mantenibles.',
                    competency: 'Integrar datos, APIs y modulos en aplicaciones mantenibles.',
                    learningOutcomes: ['Persistir y consultar datos.', 'Comunicar servicios mediante APIs o modulos bien definidos.'],
                },
                {
                    name: 'Seguridad, pruebas y despliegue',
                    description: 'Fortalece el producto con pruebas, seguridad y despliegue controlado.',
                    competency: 'Validar y publicar aplicaciones con criterios de calidad y seguridad.',
                    learningOutcomes: ['Automatizar pruebas relevantes.', 'Configurar despliegues y manejo de fallos.'],
                },
                {
                    name: 'Operacion y mejora del producto',
                    description: 'Optimiza rendimiento, observabilidad y mantenimiento sin convertir el modulo en proyecto final.',
                    competency: 'Mantener aplicaciones productivas con observabilidad y mejora continua.',
                    learningOutcomes: ['Medir rendimiento y fallos.', 'Documentar decisiones tecnicas defendibles.'],
                },
            ];
        }
        return [];
    }

    _normalizePlanTask(task, taskIndex, topic, context) {
        const cleanText = (value, fallback = '') => String(value ?? '').replace(/\s+/g, ' ').trim() || fallback;
        const dueWeek = Number.isInteger(Number(task.dueWeek)) && Number(task.dueWeek) > 0
            ? Math.min(Number(task.dueWeek), context.durationWeeks)
            : this._suggestDueWeek(taskIndex, context.durationWeeks);
        return {
            title: cleanText(task.title, `Actividad aplicada: ${topic.title}`),
            type: cleanText(task.type, this._inferTaskType(task)),
            description: cleanText(task.description, `Desarrolla una evidencia practica relacionada con ${topic.title}, con entregable verificable y criterios de calidad.`),
            dueWeek,
            contentDescription: cleanText(task.contentDescription, 'Guia explicativa con el proposito de la tarea, instrucciones paso a paso en lenguaje sencillo, ejemplo de entrega, ejercicios preparatorios, criterios de evaluacion explicados y rubrica clara para completar la actividad.'),
        };
    }

    _isGenericPlanTopicTitle(title) {
        const normalized = this._normalizeIntentText(title);
        return /^(casos de uso y criterios de calidad|taller guiado|practica|practica aplicada|proyecto aplicado del modulo|aplicacion practica|conceptos clave|analisis de problemas(?:\s+en\b.*)?|diseno de soluciones(?:\s+en\b.*)?|metodos y herramientas(?:\s+de\b.*)?|integracion profesional|validacion y mejora|definicion del proyecto|implementacion del proyecto|evaluacion del proyecto|presentacion del proyecto|presentacion tecnica de resultados y decisiones)$/.test(normalized);
    }

    _composeSubjectDescription(subject) {
        const parts = [
            subject.description,
            subject.competency ? `Competencia: ${subject.competency}` : '',
            Array.isArray(subject.learningOutcomes) && subject.learningOutcomes.length
                ? `Resultados de aprendizaje: ${subject.learningOutcomes.join('; ')}`
                : '',
            subject.integration ? `Integracion: ${subject.integration}` : '',
        ].filter(Boolean);
        return parts.join('\n\n');
    }

    _composeTopicDescription(topic) {
        const parts = [
            topic.description,
            topic.estimatedWeeks ? `Duracion estimada: ${topic.estimatedWeeks} semana(s).` : '',
            topic.estimatedHours ? `Horas estimadas: ${topic.estimatedHours}.` : '',
            topic.independentHours !== undefined ? `Trabajo autonomo: ${topic.independentHours} hora(s).` : '',
            topic.practicalHours !== undefined ? `Trabajo practico: ${topic.practicalHours} hora(s).` : '',
            Array.isArray(topic.prerequisites) && topic.prerequisites.length
                ? `Prerequisitos: ${topic.prerequisites.join('; ')}`
                : '',
            topic.competency ? `Competencia del bloque: ${topic.competency}` : '',
            topic.learningOutcome ? `Resultado esperado: ${topic.learningOutcome}` : '',
        ].filter(Boolean);
        return parts.join('\n\n');
    }

    _composeTaskDescription(task) {
        const parts = [
            task.type ? `Tipo de evidencia: ${task.type}.` : '',
            task.description,
        ].filter(Boolean);
        return parts.join('\n\n');
    }

    _normalizeStringList(value, fallback = []) {
        const raw = Array.isArray(value) ? value : [];
        const list = raw
            .map(item => String(item ?? '').replace(/\s+/g, ' ').trim())
            .filter(Boolean);
        return list.length ? list : fallback;
    }

    _normalizeWorkload(value, durationWeeks, hoursPerWeek) {
        const duration = Math.max(1, Number(durationWeeks) || 8);
        const weeklyHours = Math.max(4, Number(hoursPerWeek) || 8);
        const totalHours = Math.round(Number(value?.totalHours) > 0 ? Number(value.totalHours) : duration * weeklyHours);
        const practicalHours = Math.round(Number(value?.practicalHours) > 0 ? Number(value.practicalHours) : totalHours * 0.375);
        const guidedHours = Math.round(Number(value?.guidedHours) > 0 ? Number(value.guidedHours) : practicalHours);
        const projectHours = Math.round(Number(value?.projectHours) > 0 ? Number(value.projectHours) : practicalHours);
        const independentHours = Math.round(Number(value?.independentHours) > 0 ? Number(value.independentHours) : Math.max(0, totalHours - practicalHours));
        return { totalHours, guidedHours, independentHours, practicalHours, projectHours };
    }

    _buildCompetencies(focus, objective) {
        return [
            `Interpretar fundamentos de ${focus} para tomar decisiones tecnicas justificadas.`,
            `Aplicar metodos y herramientas de ${focus} en problemas reales o simulados.`,
            `Integrar aprendizajes del curso en una solucion o proyecto defendible.`,
            `Evaluar resultados, riesgos y criterios de calidad relacionados con ${objective}.`,
        ];
    }

    _buildLearningOutcomes(focus, level) {
        const autonomy = level === 'advanced' ? 'con autonomia profesional' : 'con acompanamiento gradual';
        return [
            `Explicar conceptos clave de ${focus} usando lenguaje tecnico adecuado.`,
            `Resolver casos de ${focus} ${autonomy}.`,
            `Construir evidencias progresivas que demuestren dominio practico.`,
            `Presentar un proyecto integrador con criterios de calidad verificables.`,
        ];
    }

    _inferTaskType(task = {}) {
        const text = `${task.title || ''} ${task.description || ''}`.toLowerCase();
        if (/proyecto|fase|prototipo|entrega final|integrador/.test(text)) return 'project';
        if (/parcial|examen|evaluacion|rúbrica|rubrica|portafolio/.test(text)) return 'assessment';
        if (/caso|laboratorio|taller|reto|hito|entrega/.test(text)) return 'milestone';
        return 'formative';
    }

    _reduceTemplateMicroAssessments(subjects, targets = {}) {
        const micro = /\b(lectura|leer|video|recurso|quiz|cuestionario|verificacion)\b/i;
        const evidence = /\b(taller|laboratorio|caso|proyecto|fase|parcial|examen|portafolio|entrega|reto|informe|presentacion)\b/i;
        const maxTasksPerTopic = Math.max(1, Number(targets.maxTasksPerTopic) || 2);
        for (const subject of subjects) {
            for (const topic of (subject.topics || [])) {
                if (!Array.isArray(topic.tasks)) {
                    topic.tasks = [];
                    continue;
                }
                if (topic.tasks.length <= 2) continue;
                const preferred = topic.tasks.filter(task => {
                    const text = `${task.title || ''} ${task.description || ''}`;
                    return evidence.test(text) || !micro.test(text);
                });
                topic.tasks = (preferred.length ? preferred : topic.tasks).slice(0, maxTasksPerTopic);
            }
        }
    }

    _ensureSubjectMilestones(subjects, context) {
        subjects.forEach((subject, index) => {
            const topics = Array.isArray(subject.topics) ? subject.topics : [];
            if (!topics.length) return;
            const hasEvidence = topics.some(topic => Array.isArray(topic.tasks) && topic.tasks.length > 0);
            if (hasEvidence) return;
            const targetTopic = topics[topics.length - 1];
            targetTopic.tasks = [this._buildSupplementalTask(targetTopic, index, context)];
        });
    }

    _ensurePlanEvidenceDensity(subjects, context) {
        const targets = context.targets || {};
        const minTasks = Math.max(0, Number(targets.minTasks) || 0);
        const maxTasksPerTopic = Math.max(2, Number(targets.maxTasksPerTopic) || 4);
        if (!minTasks) return;

        const topics = subjects.flatMap(subject => Array.isArray(subject.topics) ? subject.topics : []);
        if (!topics.length) return;

        const desiredCounts = this._buildEvidenceDistribution(topics.length, minTasks, maxTasksPerTopic);
        for (let topicIndex = 0; topicIndex < topics.length; topicIndex++) {
            const topic = topics[topicIndex];
            if (!Array.isArray(topic.tasks)) topic.tasks = [];
            while (topic.tasks.length < desiredCounts[topicIndex]) {
                topic.tasks.push(this._buildSupplementalTask(topic, topic.tasks.length, { ...context, topicIndex, topicsCount: topics.length }));
            }
        }
    }

    _buildEvidenceDistribution(topicCount, targetTasks, maxTasksPerTopic) {
        const pattern = [2, 3, 2, 2, 3, 4, 2, 3, 4, 3, 2, 3, 3, 2, 4, 2, 3, 2, 4, 3];
        const counts = Array.from({ length: topicCount }, (_, index) => Math.min(maxTasksPerTopic, pattern[index % pattern.length]));
        let total = counts.reduce((sum, count) => sum + count, 0);
        let cursor = topicCount - 1;
        while (total < targetTasks && counts.some(count => count < maxTasksPerTopic)) {
            if (counts[cursor] < maxTasksPerTopic) {
                counts[cursor]++;
                total++;
            }
            cursor = cursor <= 0 ? topicCount - 1 : cursor - 1;
        }
        return counts;
    }

    _buildSupplementalSubject(index, context) {
        const name = `${MCP_SUPPLEMENTAL_SUBJECT_TEMPLATES[index % MCP_SUPPLEMENTAL_SUBJECT_TEMPLATES.length]} de ${context.focus}`;
        return {
            name,
            description: `Materia orientada a convertir el objetivo "${context.objective}" en competencias observables y aplicables.`,
            competency: `Resolver problemas de ${context.focus} con el nivel de autonomia esperado para esta etapa.`,
            learningOutcomes: [
                `Interpretar criterios y conceptos clave de ${context.focus}.`,
                `Construir una evidencia aplicada que demuestre progreso profesional.`,
            ],
            integration: index === 0
                ? 'Construye la base para los siguientes modulos.'
                : 'Integra aprendizajes previos en una evidencia de mayor complejidad.',
            topics: [this._buildSupplementalTopic({ name }, 0, context)],
        };
    }

    _buildSupplementalTopic(subject, index, context) {
        const topicTitles = this._getDomainTopicTitles(context.focus || subject.name);
        const title = topicTitles[index % topicTitles.length];
        return {
            title,
            description: `Tema centrado en aplicar ${subject.name} a problemas reales del curso.`,
            estimatedWeeks: index === 0 ? 1 : 2,
            estimatedHours: (index === 0 ? 1 : 2) * 9,
            independentHours: index === 0 ? 6 : 10,
            practicalHours: index === 0 ? 3 : 8,
            competency: this._buildTopicCompetency(title, subject),
            learningOutcome: this._buildTopicLearningOutcome(title),
            contentDescription: `Documento de estudio 100% explicativo sobre ${title}: explica el tema desde cero, define conceptos en palabras simples, muestra ejemplos paso a paso, incluye practica guiada, errores frecuentes, caso aplicado y recursos sugeridos para seguir aprendiendo.`,
            tasks: [],
        };
    }

    _getDomainTopicTitles(focus) {
        const n = this._normalizeIntentText(focus);
        if (/\b(machine learning|aprendizaje automatico|deep learning|inteligencia artificial|ia|ciencia de datos|data science)\b/.test(n)) {
            return [
                'Fundamentos de aprendizaje automatico y tipos de problemas',
                'Preparacion de datos y analisis exploratorio',
                'Ingenieria y seleccion de caracteristicas',
                'Validacion de datos y particion experimental',
                'Modelos de clasificacion supervisada',
                'Modelos de regresion y metricas de error',
                'Validacion rigurosa, generalizacion, sesgo y sobreajuste',
                'Ajuste de hiperparametros y comparacion de modelos',
                'Vision artificial aplicada',
                'Procesamiento de lenguaje natural',
                'Caso optativo: sistemas de recomendacion',
                'Caso optativo: series temporales y deteccion de anomalias',
                'Registro de experimentos y trazabilidad',
                'Versionado de datos, pipelines y modelos',
                'Observabilidad, monitoreo y deriva',
                'Gobernanza, riesgos y metricas de negocio',
            ];
        }
        if (/\b(programacion|software|python|javascript|web|backend|frontend)\b/.test(n)) {
            return [
                'Fundamentos del lenguaje y entorno de trabajo',
                'Estructuras de datos y control de flujo',
                'Funciones, modulos y organizacion del codigo',
                'Programacion orientada a objetos',
                'Manejo de errores y depuracion',
                'Persistencia de datos y archivos',
                'Pruebas automatizadas y calidad de codigo',
                'APIs y comunicacion entre servicios',
                'Autenticacion y seguridad basica',
                'Arquitectura de aplicaciones mantenibles',
                'Integracion con bases de datos',
                'Despliegue y configuracion de entornos',
                'Observabilidad y manejo de fallos',
                'Optimizacion y rendimiento',
                'Construccion de producto funcional',
                'Documentacion y defensa tecnica',
            ];
        }
        return [
            `Fundamentos conceptuales de ${focus}`,
            `Lenguaje tecnico y criterios de calidad en ${focus}`,
            `Herramientas principales de ${focus}`,
            `Procedimientos aplicados de ${focus}`,
            `Diagnostico de casos en ${focus}`,
            `Modelos y metodos de trabajo en ${focus}`,
            `Toma de decisiones con evidencia en ${focus}`,
            `Practicas guiadas de complejidad media en ${focus}`,
            `Casos profesionales de ${focus}`,
            `Validacion de resultados en ${focus}`,
            `Gestion de riesgos y errores frecuentes en ${focus}`,
            `Integracion de herramientas en ${focus}`,
            `Construccion de una solucion aplicada en ${focus}`,
            `Pruebas aplicadas y ajuste de resultados en ${focus}`,
            `Preparacion de entrega profesional en ${focus}`,
            `Defensa tecnica y comunicacion de resultados en ${focus}`,
        ];
    }

    _buildSupplementalTask(topic, index, context) {
        const templates = this._getTopicEvidenceTemplates(topic.title);
        const template = index < templates.length ? templates[index] : this._getDiverseSupplementalEvidence(index);
        if (template) {
            return {
                title: `${template.label}: ${topic.title}`,
                type: template.type,
                description: template.description(topic.title),
                dueWeek: this._suggestDueWeek(index, context.durationWeeks),
                contentDescription: template.content(topic.title),
            };
        }
        const taskType = this._selectEvidenceTemplate(index, context);
        return {
            title: `${taskType}: ${topic.title}`,
            type: /proyecto|prototipo|version funcional|defensa/i.test(taskType) ? 'project' : (/diagnostico|evaluacion|defensa/i.test(taskType) ? 'assessment' : 'milestone'),
            description: `Evidencia donde el estudiante demuestra dominio practico de ${topic.title} mediante ${taskType.toLowerCase()}.`,
            dueWeek: this._suggestDueWeek(index, context.durationWeeks),
            contentDescription: `Guia de ${taskType.toLowerCase()} con pasos, ejercicios previos, criterios de entrega, recursos sugeridos y rubrica de evaluacion.`,
        };
    }

    _getDiverseSupplementalEvidence(index) {
        const pool = [
            { label: 'Code review tecnico', type: 'formative', description: t => `Revisa reproducibilidad, claridad y riesgos tecnicos de una solucion sobre ${t}.`, content: t => `Lista de chequeo para code review, criterios de mantenibilidad y preguntas de reflexion para ${t}.` },
            { label: 'Benchmark comparativo', type: 'milestone', description: t => `Compara alternativas tecnicas para ${t} con metricas y restricciones claras.`, content: t => `Guia de benchmark con baseline, metricas, tabla comparativa y conclusiones para ${t}.` },
            { label: 'Presentacion tecnica', type: 'assessment', description: t => `Comunica decisiones, resultados y limites de una solucion relacionada con ${t}.`, content: t => `Plantilla de presentacion tecnica, criterios de evaluacion y recomendaciones para defender resultados de ${t}.` },
            { label: 'Analisis de articulo aplicado', type: 'formative', description: t => `Analiza una lectura tecnica y conecta sus aportes con un caso de ${t}.`, content: t => `Guia de lectura, preguntas criticas y rubrica breve para analizar literatura sobre ${t}.` },
        ];
        return pool[index % pool.length];
    }

    _selectEvidenceTemplate(taskIndex, context = {}) {
        const topicIndex = Number(context.topicIndex) || 0;
        const topicsCount = Math.max(1, Number(context.topicsCount) || 1);
        const progress = topicsCount <= 1 ? 1 : topicIndex / (topicsCount - 1);
        if (topicIndex === 0 && taskIndex === 0) return 'Diagnostico inicial';
        if (progress < 0.2) return ['Ejercicio aplicado', 'Laboratorio de datos', 'Mini caso tecnico'][taskIndex % 3];
        if (progress < 0.45) return ['Laboratorio de modelado', 'Caso empresarial guiado', 'Implementacion tecnica', 'Comparacion de resultados'][taskIndex % 4];
        if (progress < 0.7) return ['Caso empresarial', 'Implementacion tecnica del bloque', 'Caso integrador intermedio', 'Revision tecnica aplicada'][taskIndex % 4];
        if (progress < 0.9) return ['Experimento de optimizacion', 'Caso de validacion', 'Despliegue controlado', 'Informe tecnico aplicado'][taskIndex % 4];
        return ['Auditoria tecnica del modelo', 'Sustentacion tecnica', 'Prueba de mantenimiento', 'Informe ejecutivo tecnico'][taskIndex % 4];
    }

    _ensureTransversalProjectMilestones(subjects, context) {
        const allTasks = subjects.flatMap(subject =>
            (subject.topics || []).flatMap(topic => topic.tasks || []),
        );
        const topics = subjects.flatMap(subject => Array.isArray(subject.topics) ? subject.topics : []);
        if (!topics.length) return;
        const duration = Math.max(1, Number(context.durationWeeks) || 8);
        const milestones = [
            { marker: /propuesta del proyecto/i, title: `Propuesta del proyecto transversal: ${context.focus}`, dueWeek: Math.max(1, Math.ceil(duration * 0.125)) },
            { marker: /diseno del proyecto/i, title: `Diseno del proyecto transversal: ${context.focus}`, dueWeek: Math.max(1, Math.ceil(duration * 0.25)) },
            { marker: /prototipo parcial/i, title: `Prototipo parcial del proyecto: ${context.focus}`, dueWeek: Math.max(1, Math.ceil(duration * 0.5)) },
            { marker: /evaluacion intermedia integradora/i, title: `Evaluacion intermedia integradora: ${context.focus}`, dueWeek: Math.max(1, Math.ceil(duration * 0.5)), type: 'assessment' },
            { marker: /version funcional/i, title: `Version funcional del proyecto: ${context.focus}`, dueWeek: Math.max(1, Math.ceil(duration * 0.75)) },
            { marker: /entrega final del proyecto|proyecto final/i, title: `Entrega final del proyecto integrador: ${context.focus}`, dueWeek: duration },
            { marker: /defensa tecnica/i, title: `Defensa tecnica del proyecto: ${context.focus}`, dueWeek: duration },
        ];
        milestones.forEach(milestone => {
            if (allTasks.some(task => milestone.marker.test(String(task.title || '')))) return;
            const topic = topics[Math.min(topics.length - 1, Math.floor((milestone.dueWeek - 1) * topics.length / duration))];
            if (!Array.isArray(topic.tasks)) topic.tasks = [];
            topic.tasks.push({
                title: milestone.title,
                type: milestone.type || 'project',
                description: `Hito transversal donde el estudiante integra lo aprendido hasta la semana ${milestone.dueWeek} en el proyecto del curso.`,
                dueWeek: milestone.dueWeek,
                contentDescription: 'Guia explicativa del hito con proposito, alcance, pasos para desarrollarlo, ejemplo de entrega, criterios de evaluacion explicados, dependencias con modulos previos y recomendaciones de presentacion.',
            });
            allTasks.push(topic.tasks[topic.tasks.length - 1]);
        });
    }

    _limitFormalAssessments(subjects, context) {
        const tasks = subjects.flatMap(subject => (subject.topics || []).flatMap(topic => topic.tasks || []));
        let partialSeen = false;
        for (const task of tasks) {
            const text = `${task.title || ''} ${task.description || ''}`;
            if (/examen|evaluacion intermedia|evaluacion parcial|parcial integrador/i.test(text)) {
                if (partialSeen) {
                    task.title = String(task.title || '').replace(/parcial|examen|evaluacion intermedia/ig, 'Caso integrador');
                    task.type = 'milestone';
                    task.description = 'Caso aplicado que integra aprendizajes mediante una entrega practica acumulativa.';
                } else {
                    partialSeen = true;
                    task.title = `Evaluacion intermedia integradora: ${context.focus}`;
                    task.type = 'assessment';
                }
            }
        }
    }

    _suggestDueWeek(index, durationWeeks) {
        const duration = Math.max(1, Number(durationWeeks) || 8);
        const step = Math.max(1, Math.floor(duration / 10));
        return Math.min(duration, Math.max(1, (index + 1) * step));
    }

    _redistributePlanDueWeeks(subjects, durationWeeks) {
        const duration = Math.max(1, Number(durationWeeks) || 8);
        const topics = subjects.flatMap(subject => Array.isArray(subject.topics) ? subject.topics : []);
        if (!topics.length) return;
        let startWeek = 1;
        topics.forEach(topic => {
            const topicWeeks = Math.max(1, Number(topic.estimatedWeeks) || Math.ceil(duration / topics.length));
            const endWeek = Math.min(duration, startWeek + topicWeeks - 1);
            const tasks = Array.isArray(topic.tasks) ? topic.tasks : [];
            tasks.forEach((task, taskIndex) => {
                const explicitProjectWeek = this._getProjectMilestoneWeek(task, duration);
                if (explicitProjectWeek) {
                    task.dueWeek = explicitProjectWeek;
                    return;
                }
                const slot = tasks.length <= 1 ? 1 : (taskIndex + 1) / tasks.length;
                const suggested = Math.round(startWeek + (endWeek - startWeek) * slot);
                task.dueWeek = Math.min(duration, Math.max(1, suggested));
            });
            startWeek = Math.min(duration, endWeek + 1);
        });
    }

    _getProjectMilestoneWeek(task, duration) {
        const text = this._normalizeIntentText(`${task.title || ''} ${task.description || ''}`);
        if (/diagnostico inicial/.test(text)) return 1;
        if (/propuesta del proyecto/.test(text)) return Math.max(1, Math.ceil(duration * 0.125));
        if (/diseno del proyecto/.test(text)) return Math.max(1, Math.ceil(duration * 0.25));
        if (/evaluacion intermedia|prototipo parcial/.test(text)) return Math.max(1, Math.ceil(duration * 0.5));
        if (/version funcional/.test(text)) return Math.max(1, Math.ceil(duration * 0.75));
        if (/entrega final|proyecto final|defensa tecnica/.test(text)) return duration;
        return null;
    }

    _redistributeTopicDurations(subjects, durationWeeks) {
        const duration = Math.max(1, Number(durationWeeks) || 8);
        const topics = subjects.flatMap(subject => Array.isArray(subject.topics) ? subject.topics : []);
        if (!topics.length || duration < 24) return;

        const baseWeeks = Math.max(1, Math.floor(duration / topics.length));
        let remainingWeeks = Math.max(0, duration - (baseWeeks * topics.length));
        topics.forEach(topic => {
            const extraWeek = remainingWeeks > 0 ? 1 : 0;
            topic.estimatedWeeks = baseWeeks + extraWeek;
            topic.estimatedHours = topic.estimatedWeeks * 8;
            topic.independentHours = Math.round(topic.estimatedHours * 0.625);
            topic.practicalHours = Math.max(0, topic.estimatedHours - topic.independentHours);
            topic.competency = topic.competency || `Aplicar ${topic.title} en una situacion profesional verificable.`;
            topic.learningOutcome = topic.learningOutcome || `El estudiante sera capaz de construir una evidencia tecnica relacionada con ${topic.title}.`;
            remainingWeeks -= extraWeek;
        });
    }

    _countPlanTopics(subjects) {
        return subjects.reduce((total, subject) => total + (Array.isArray(subject.topics) ? subject.topics.length : 0), 0);
    }

    _countPlanTasks(subjects) {
        return subjects.reduce(
            (total, subject) => total + (Array.isArray(subject.topics)
                ? subject.topics.reduce((topicTotal, topic) => topicTotal + (Array.isArray(topic.tasks) ? topic.tasks.length : 0), 0)
                : 0),
            0,
        );
    }

    _findSubjectWithFewestTopics(subjects) {
        return subjects.reduce((selected, subject) => {
            const selectedCount = Array.isArray(selected.topics) ? selected.topics.length : 0;
            const currentCount = Array.isArray(subject.topics) ? subject.topics.length : 0;
            return currentCount < selectedCount ? subject : selected;
        }, subjects[0]);
    }

    /**
     * Obtiene informacion de un usuario.
     * @param {{ userId?: number, username?: string }} params
     * @returns {Promise<Result>}
     */
    async getUserInfo({ userId, username }) {
        try {
            let user;
            if (userId) {
                user = await this.userRepo.findById(userId);
            } else if (username) {
                user = await this.userRepo.findByUsername(username);
            } else {
                return Result.fail(new ValidationError('userId o username es requerido'));
            }

            if (!user) return Result.fail(new NotFoundError('Usuario'));
            return Result.ok(user);
        } catch (err) {
            return Result.fail(new ValidationError(`getUserInfo falló: ${err.message}`));
        }
    }

    /**
     * Obtiene información de un curso.
     * @param {number} courseId
     * @returns {Promise<Result>}
     */
    async getCourseInfo(courseId) {
        if (!courseId) return Result.fail(new ValidationError('courseId es requerido'));

        try {
            const course = await this.courseRepo.findById(courseId);
            if (!course) return Result.fail(new NotFoundError('Curso'));
            return Result.ok(course);
        } catch (err) {
            return Result.fail(new ValidationError(`getCourseInfo falló: ${err.message}`));
        }
    }

    /**
     * Obtiene submissions de una tarea.
     * @param {number} taskId
     * @returns {Promise<Result>}
     */
    async getTaskSubmissions(taskId) {
        if (!taskId) return Result.fail(new ValidationError('taskId es requerido'));

        try {
            const submissions = await this.submissionRepo.findByTaskId(taskId);
            return Result.ok(submissions);
        } catch (err) {
            return Result.fail(new ValidationError(`getTaskSubmissions falló: ${err.message}`));
        }
    }

    /**
     * Crea la estructura completa de un curso (course → subjects → topics → tasks) en la BD.
     * @param {{ plan: Object, userId: number }} params
     * @returns {Promise<Result>}
     */
    async createCourseStructure({ plan, userId }) {
        if (!plan || !plan.title || !Array.isArray(plan.subjects) || plan.subjects.length === 0) {
            return Result.fail(new ValidationError('plan es requerido con title y al menos un subject'));
        }
        if (!userId) {
            return Result.fail(new ValidationError('userId es requerido para crear el curso'));
        }
        if (!this.supabase || typeof this.supabase.executeRawSQL !== 'function') {
            return Result.fail(new ValidationError('supabaseService no disponible para crear el curso'));
        }

        plan = this._normalizeGeneratedCoursePlan(plan);
        const esc = (s) => String(s == null ? '' : s).replace(/'/g, "''");
        const execInsert = async (sql) => {
            const data = await this.supabase.executeRawSQL(sql);
            return Array.isArray(data) ? data[0] : null;
        };

        try {
            const courseRow = await execInsert(
                `INSERT INTO courses (title, description, category, price, is_premium, is_active, creator_user_id)
                 VALUES ('${esc(plan.title)}', '${esc(plan.description)}', '${esc(plan.category || 'General')}', 0, false, true, ${userId})
                 RETURNING id`,
            );
            const courseId = courseRow?.id;
            if (!courseId) throw new Error('No se obtuvo el id del curso recién creado');

            let topicsCreated = 0;
            let tasksCreated = 0;
            const subjectsForThumbnails = [];
            const tasksForGuides = [];

            for (const subject of plan.subjects) {
                const subjectDescription = this._composeSubjectDescription(subject);
                const subjectRow = await execInsert(
                    `INSERT INTO subjects (name, description, course_id, created_by)
                     VALUES ('${esc(subject.name)}', '${esc(subjectDescription)}', ${courseId}, ${userId})
                     RETURNING id`,
                );
                const subjectId = subjectRow?.id;
                if (!subjectId) continue;
                subjectsForThumbnails.push({
                    subjectId,
                    name: subject.name,
                    description: subjectDescription || '',
                });

                for (const topic of (subject.topics || [])) {
                    const topicDescription = this._composeTopicDescription(topic);
                    const topicRow = await execInsert(
                        `INSERT INTO topics (name, description, materia_id, created_by)
                         VALUES ('${esc(topic.title)}', '${esc(topicDescription)}', ${subjectId}, ${userId})
                         RETURNING id`,
                    );
                    const topicId = topicRow?.id;
                    if (!topicId) continue;
                    topicsCreated++;

                    for (const task of (topic.tasks || [])) {
                        const taskDescription = this._composeTaskDescription(task);
                        const dueExpr = task.dueWeek && Number.isInteger(task.dueWeek) && task.dueWeek > 0
                            ? `NOW() + INTERVAL '${task.dueWeek} weeks'`
                            : 'NULL';
                        const taskRow = await execInsert(
                            `INSERT INTO tasks (title, description, topic_id, due_date, created_by)
                             VALUES ('${esc(task.title)}', '${esc(taskDescription)}', ${topicId}, ${dueExpr}, ${userId})
                             RETURNING id`,
                        );
                        if (taskRow?.id) {
                            tasksCreated++;
                            tasksForGuides.push({
                                id: taskRow.id,
                                title: task.title,
                                description: taskDescription || '',
                                contentDescription: task.contentDescription || '',
                                topicName: topic.title,
                                subjectName: subject.name,
                                courseTitle: plan.title,
                            });
                        }
                    }
                }
            }

            this._generateSubjectThumbnailsInBackground({
                courseId,
                courseTitle: plan.title,
                category: plan.category || 'General',
                subjects: subjectsForThumbnails,
            });

            this._generateTaskGuideFilesInBackground({
                courseId,
                tasks: tasksForGuides,
                userId,
            });

            return Result.ok({
                courseId,
                topicsCreated,
                tasksCreated,
                thumbnailsInProgress: Boolean(this.storage && this.storage.isAvailable && this.storage.isAvailable()),
                docsInProgress: Boolean(this.storage && this.storage.isAvailable && this.storage.isAvailable() && this.contentItemRepo),
            });
        } catch (err) {
            return Result.fail(new ValidationError(`createCourseStructure falló: ${err.message}`));
        }
    }

    _safeFileSlug(value, fallback = 'tarea') {
        return String(value || fallback)
            .toLowerCase()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9\s-]/g, '')
            .replace(/\s+/g, '_')
            .slice(0, 60) || fallback;
    }

    /** Genera Word y PDF explicativos por cada tarea sin bloquear la creacion del curso. */
    _generateTaskGuideFilesInBackground({ courseId, tasks, userId }) {
        if (!Array.isArray(tasks) || tasks.length === 0) return;
        if (!this.storage || typeof this.storage.isAvailable !== 'function' || !this.storage.isAvailable()) return;
        if (!this.contentItemRepo || typeof this.contentItemRepo.create !== 'function') {
            console.error('[MCPDomainService] Content item repository unavailable; task guide files cannot be registered.');
            return;
        }
        if (!this.llm || typeof this.llm.chat !== 'function') {
            console.error('[MCPDomainService] LLM port unavailable; task guide files cannot be generated.');
            return;
        }

        const bgTenantId = getCurrentTenantId();
        const runBackground = async () => {
            for (const task of tasks) {
                try {
                    const content = await this._generateTaskGuideContent(task);
                    const guideTitle = `Guia de desarrollo: ${task.title}`;
                    const safeName = this._safeFileSlug(task.title);

                    try {
                        const docBuffer = await this._buildTaskGuideDocx(
                            guideTitle,
                            `${task.topicName} - ${task.subjectName}`,
                            content,
                        );
                        const docKey = `courses/${courseId}/tasks/${task.id}/${Date.now()}_guia_${safeName}.docx`;
                        const docUrl = await this.storage.uploadFile(
                            docBuffer,
                            docKey,
                            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                            docBuffer.length,
                        );
                        await this.contentItemRepo.create({
                            taskId: task.id,
                            title: `${guideTitle} (Word)`,
                            body: docUrl,
                            contentType: 'file',
                            fileUri: docUrl,
                            fileName: `guia_${safeName}.docx`,
                            orderIndex: 0,
                            creatorUsuarioId: userId || null,
                            creatorUsername: null,
                        });
                        console.log(`[MCPDomainService] Task guide Word uploaded: taskId=${task.id}`);
                    } catch (docErr) {
                        console.error(`[MCPDomainService] Task guide Word failed task=${task.id}: ${docErr.message}`);
                    }

                    try {
                        const pdfBuffer = await this._buildTaskGuidePdf(
                            guideTitle,
                            `${task.topicName} - ${task.subjectName}`,
                            content,
                        );
                        const pdfKey = `courses/${courseId}/tasks/${task.id}/${Date.now()}_guia_${safeName}.pdf`;
                        const pdfUrl = await this.storage.uploadFile(pdfBuffer, pdfKey, 'application/pdf', pdfBuffer.length);
                        await this.contentItemRepo.create({
                            taskId: task.id,
                            title: `${guideTitle} (PDF)`,
                            body: pdfUrl,
                            contentType: 'file',
                            fileUri: pdfUrl,
                            fileName: `guia_${safeName}.pdf`,
                            orderIndex: 1,
                            creatorUsuarioId: userId || null,
                            creatorUsername: null,
                        });
                        console.log(`[MCPDomainService] Task guide PDF uploaded: taskId=${task.id}`);
                    } catch (pdfErr) {
                        console.error(`[MCPDomainService] Task guide PDF failed task=${task.id}: ${pdfErr.message}`);
                    }
                } catch (err) {
                    console.error(`[MCPDomainService] Task guide files failed task=${task.id}: ${err.message}`);
                }
            }
        };

        setImmediate(() => {
            const job = (bgTenantId && hasTenantClient(bgTenantId))
                ? runInTenantContext(bgTenantId, runBackground)
                : runBackground();
            Promise.resolve(job).catch(err =>
                console.error(`[MCPDomainService] Task guide files background job failed: ${err?.message || err}`));
        });
    }

    async _generateTaskGuideContent(task) {
        const systemPrompt = [
            'Eres un docente experto en orientar estudiantes sin hacerles la tarea.',
            'Responde UNICAMENTE con contenido en formato Markdown.',
            'El documento debe explicar como abordar la tarea, como organizar el trabajo y como verificar la calidad de la entrega.',
            'PROHIBIDO resolver la tarea: no entregues respuestas finales, resultados calculados, conclusiones listas, codigo completo listo para copiar, ensayos completos, reportes finales ni archivos de entrega terminados.',
            'Usa preguntas guia, plantillas incompletas y micro-ejemplos parciales solo para ensenar el metodo.',
            'Cuando incluyas tablas, usa tablas Markdown validas con encabezado y filas claras para que el archivo Word las convierta en celdas reales.',
        ].join('\n');

        const userPrompt = [
            `Genera una guia de desarrollo para esta tarea: "${task.title}"`,
            `Tema: "${task.topicName}"`,
            `Materia: "${task.subjectName}"`,
            `Curso: "${task.courseTitle}"`,
            task.description ? `Descripcion de la tarea: ${task.description}` : '',
            task.contentDescription ? `La guia debe orientar especificamente sobre: ${task.contentDescription}` : '',
            '',
            'El documento debe incluir:',
            '# 1. Proposito de la Tarea',
            '# 2. Antes de Empezar',
            '# 3. Instrucciones Paso a Paso',
            '# 4. Plantilla de Trabajo No Resuelta',
            '# 5. Errores Comunes y Como Evitarlos',
            '# 6. Criterios de Evaluacion',
            'Incluye una tabla Markdown con criterios, niveles de desempeno y recomendaciones, sin resolver la tarea.',
            '# 7. Preguntas Frecuentes',
            '',
            'No llenes la plantilla ni escribas la entrega final del estudiante.',
        ].filter(Boolean).join('\n');

        const response = await this.llm.chat(systemPrompt, userPrompt, {
            tools: [],
            toolChoice: 'none',
        });
        return response?.content || '';
    }

    async _buildTaskGuideDocx(title, subtitle, markdownContent) {
        return buildEducationalDocx({
            title,
            subtitle,
            markdownContent,
        });
    }

    async _buildTaskGuidePdf(title, subtitle, markdownContent) {
        const { default: PDFDocument } = await import('pdfkit');
        return new Promise((resolve, reject) => {
            const doc = new PDFDocument({ size: 'A4', margin: 50, autoFirstPage: true });
            const chunks = [];
            doc.on('data', c => chunks.push(c));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);

            const W = doc.page.width;
            doc.rect(0, 0, W, 72).fill('#1e3a5f');
            doc.fontSize(19).fillColor('#ffffff').font('Helvetica-Bold')
                .text(String(title || '').slice(0, 90), 50, 14, { width: W - 100, ellipsis: true });
            if (subtitle) {
                doc.fontSize(11).fillColor('#93c5fd').font('Helvetica')
                    .text(String(subtitle).slice(0, 120), 50, 44, { width: W - 100 });
            }

            doc.y = 90;
            for (const rawLine of String(markdownContent || '').split('\n')) {
                if (doc.y > doc.page.height - 70) { doc.addPage(); doc.y = 50; }
                if (rawLine.startsWith('# ')) {
                    doc.moveDown(0.4);
                    doc.fontSize(15).font('Helvetica-Bold').fillColor('#1e3a5f')
                        .text(rawLine.slice(2).trim(), 50, doc.y, { width: W - 100 });
                    doc.moveDown(0.2);
                } else if (rawLine.startsWith('## ')) {
                    doc.moveDown(0.3);
                    doc.fontSize(13).font('Helvetica-Bold').fillColor('#2c5282')
                        .text(rawLine.slice(3).trim(), 50, doc.y, { width: W - 100 });
                    doc.moveDown(0.15);
                } else if (rawLine.startsWith('- ') || rawLine.startsWith('* ')) {
                    doc.fontSize(10.5).font('Helvetica').fillColor('#374151')
                        .text(`- ${rawLine.slice(2).trim()}`, 62, doc.y, { width: W - 112 });
                } else if (/^\d+\.\s/.test(rawLine)) {
                    doc.fontSize(10.5).font('Helvetica').fillColor('#374151')
                        .text(rawLine.trim(), 62, doc.y, { width: W - 112 });
                } else if (rawLine.trim() === '') {
                    doc.moveDown(0.35);
                } else {
                    const clean = rawLine
                        .replace(/\*\*([^*]+)\*\*/g, '$1')
                        .replace(/\*([^*]+)\*/g, '$1')
                        .replace(/`([^`]+)`/g, '$1');
                    doc.fontSize(10.5).font('Helvetica').fillColor('#374151')
                        .text(clean.trim(), 50, doc.y, { width: W - 100 });
                }
            }

            const footerY = doc.page.height - 38;
            doc.rect(0, footerY, W, 38).fill('#dbeafe');
            doc.fontSize(8).fillColor('#4b5563').font('Helvetica')
                .text(`Generado por CourseV - ${new Date().toLocaleDateString('es-CO')}`, 50, footerY + 13, {
                    width: W - 100,
                    align: 'center',
                });

            doc.end();
        });
    }

    /** Genera miniaturas IA para materias sin bloquear la creacion del curso. */
    _generateSubjectThumbnailsInBackground({ courseId, courseTitle, category, subjects }) {
        if (!Array.isArray(subjects) || subjects.length === 0) return;
        if (!this.storage || typeof this.storage.isAvailable !== 'function' || !this.storage.isAvailable()) return;
        if (!this.subjectRepo || typeof this.subjectRepo.update !== 'function') return;

        const bgTenantId = getCurrentTenantId();
        const runBackground = async () => {
            for (const subject of subjects) {
                try {
                    const { buffer, contentType, ext } = await this._generateThumbnailImage(
                        `${subject.name}, ${courseTitle}, ${category}, ${subject.description || 'materia academica educativa'}`,
                    );
                    const key = `courses/${courseId}/subjects/${subject.subjectId}/thumbnail_${Date.now()}.${ext}`;
                    const thumbnailUrl = await this.storage.uploadFile(buffer, key, contentType, buffer.length);
                    await this.subjectRepo.update(subject.subjectId, { thumbnailUrl });
                    console.log(`[MCPDomainService] Subject thumbnail uploaded: subjectId=${subject.subjectId}`);
                } catch (err) {
                    console.error(`[MCPDomainService] Subject thumbnail failed id=${subject.subjectId}: ${err.message}`);
                }
            }
        };

        setImmediate(() => {
            const job = (bgTenantId && hasTenantClient(bgTenantId))
                ? runInTenantContext(bgTenantId, runBackground)
                : runBackground();
            Promise.resolve(job).catch(err =>
                console.error(`[MCPDomainService] Subject thumbnail background job failed: ${err?.message || err}`));
        });
    }

    async _generateThumbnailImage(description) {
        const apiKey = process.env.OPENROUTER_API_KEY;
        if (!apiKey) throw new Error('OPENROUTER_API_KEY not configured for image generation');

        const imageModel = process.env.OPENROUTER_IMAGE_MODEL || 'google/gemini-2.5-flash-image';
        const prompt = [
            `Professional, photorealistic educational subject thumbnail: ${String(description || '').slice(0, 240)}.`,
            'Realistic academic setting, relevant objects for the subject, natural light, high detail,',
            'clean 16:9 composition, no text overlays, no logos, no watermarks.',
        ].join(' ');

        const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': process.env.OPENROUTER_REFERER || process.env.SITE_URL || 'https://coursev.app',
                'X-Title': 'CourseV',
            },
            body: JSON.stringify({
                model: imageModel,
                modalities: ['image', 'text'],
                messages: [{ role: 'user', content: prompt }],
            }),
            signal: AbortSignal.timeout(90_000),
        });
        if (!resp.ok) {
            const msg = await resp.text().catch(() => '');
            throw new Error(`OpenRouter image API ${resp.status}: ${msg.slice(0, 300)}`);
        }

        const json = await resp.json();
        const imageRef = this._extractImageRef(json?.choices?.[0]?.message);
        if (!imageRef) throw new Error(`OpenRouter image generation returned no image for model ${imageModel}`);
        return this._imageRefToBuffer(imageRef);
    }

    _extractImageRef(message) {
        const fromImages = message?.images?.[0]?.image_url?.url;
        if (fromImages) return fromImages;

        if (Array.isArray(message?.content)) {
            for (const block of message.content) {
                if ((block?.type === 'image_url' || block?.type === 'output_image') && block.image_url?.url) return block.image_url.url;
                if (block?.type === 'image' && block.source?.type === 'base64' && block.source?.data) {
                    return `data:${block.source.media_type || 'image/png'};base64,${block.source.data}`;
                }
                if (block?.type === 'image' && block.source?.url) return block.source.url;
                if (block?.inlineData?.data) return `data:${block.inlineData.mimeType || 'image/png'};base64,${block.inlineData.data}`;
                if (block?.data && block?.mimeType) return `data:${block.mimeType};base64,${block.data}`;
            }
        }

        if (typeof message?.content === 'string') {
            const mdImg = message.content.match(/!\[.*?\]\((data:image\/[^)]+)\)/);
            if (mdImg) return mdImg[1];
            const dataUri = message.content.match(/(data:image\/[a-z]+;base64,[A-Za-z0-9+/=]{20,})/);
            if (dataUri) return dataUri[1];
        }

        return '';
    }

    async _imageRefToBuffer(ref) {
        const dataMatch = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(ref);
        if (dataMatch) {
            const contentType = dataMatch[1].toLowerCase();
            const ext = (contentType.split('/')[1] || 'png').replace('jpeg', 'jpg');
            return { buffer: Buffer.from(dataMatch[2], 'base64'), contentType, ext };
        }

        const imgResp = await fetch(ref, { signal: AbortSignal.timeout(30_000) });
        if (!imgResp.ok) throw new Error(`Image download failed: ${imgResp.status}`);
        const contentType = (imgResp.headers.get('content-type') || 'image/png').split(';')[0].toLowerCase();
        const ext = (contentType.split('/')[1] || 'png').replace('jpeg', 'jpg');
        return { buffer: Buffer.from(await imgResp.arrayBuffer()), contentType, ext };
    }

    async sendNotification({ userId, title, message, type }) {
        if (!userId || !title || !message) {
            return Result.fail(new ValidationError('userId, title y message son requeridos'));
        }

        try {
            const result = await this.notificationService.sendNotification({
                userId,
                title,
                message,
                type: type || 'mcp',
            });
            return result; // NotificationDomainService already returns Result
        } catch (err) {
            return Result.fail(new ValidationError(`Notificación MCP falló: ${err.message}`));
        }
    }

    /**
     * Lista de herramientas MCP disponibles.
     * @returns {Object[]}
     */
    getToolsList() {
        return [
            { name: 'query_database', description: 'Execute SQL queries (SELECT, INSERT, UPDATE, DELETE) on the Supabase database', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
            { name: 'get_database_schema', description: 'Get complete database schema', inputSchema: { type: 'object', properties: {} } },
            { name: 'create_course_structure', description: 'Creates a complete course with subjects, topics, and tasks in the database. Use when a user wants to create a new course.', inputSchema: { type: 'object', properties: { plan: { type: 'object', description: 'Course plan object with title, description, category, subjects array' }, userId: { type: 'number', description: 'Creator user ID' } }, required: ['plan', 'userId'] } },
            { name: 'get_user_info', description: 'Get user information', inputSchema: { type: 'object', properties: { userId: { type: 'number' }, username: { type: 'string' } } } },
            { name: 'get_course_info', description: 'Get course information', inputSchema: { type: 'object', properties: { courseId: { type: 'number' } }, required: ['courseId'] } },
            { name: 'get_task_submissions', description: 'Get task submissions', inputSchema: { type: 'object', properties: { taskId: { type: 'number' } }, required: ['taskId'] } },
            { name: 'send_notification', description: 'Send notification to user', inputSchema: { type: 'object', properties: { userId: { type: 'number' }, title: { type: 'string' }, message: { type: 'string' }, type: { type: 'string' } }, required: ['userId', 'title', 'message'] } },
        ];
    }
}
export default MCPDomainService;

