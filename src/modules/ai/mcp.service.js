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

        this._ensureSpecificTopicTitles(subjects, { focus });
        this._reduceTemplateMicroAssessments(subjects, targets);
        this._ensureSubjectMilestones(subjects, { durationWeeks, focus, targets });
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
        const normalized = {
            title: this._isGenericPlanTopicTitle(rawTitle) ? fallbackTitle : rawTitle,
            description: cleanText(topic.description, `Estudia conceptos y metodos necesarios para aplicar ${subject.name} en situaciones reales.`),
            estimatedWeeks: Number(topic.estimatedWeeks) > 0 ? Number(topic.estimatedWeeks) : undefined,
            contentDescription: cleanText(topic.contentDescription, `Documento de estudio con conceptos clave, ejemplos guiados, ejercicios progresivos, caso aplicado, laboratorio o practica reflexiva, criterios de evaluacion y recursos de profundizacion sobre ${subject.name}.`),
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
                }
                seen.add(this._normalizeIntentText(topic.title));
                topicIndex++;
            }
        }
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
            contentDescription: cleanText(task.contentDescription, 'Guia con instrucciones, ejercicios preparatorios, caso o laboratorio base, criterios de evaluacion, recursos y rubrica para completar la actividad.'),
        };
    }

    _isGenericPlanTopicTitle(title) {
        const normalized = this._normalizeIntentText(title);
        return /^(casos de uso y criterios de calidad|taller guiado|practica|practica aplicada|proyecto aplicado del modulo|aplicacion practica|conceptos clave|analisis de problemas|diseno de soluciones|metodos y herramientas|integracion profesional|validacion y mejora)$/.test(normalized);
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
        const weeklyHours = Math.max(4, Number(hoursPerWeek) || 6);
        const totalHours = Math.round(Number(value?.totalHours) > 0 ? Number(value.totalHours) : duration * weeklyHours);
        const guidedHours = Math.round(Number(value?.guidedHours) > 0 ? Number(value.guidedHours) : totalHours * 0.35);
        const projectHours = Math.round(Number(value?.projectHours) > 0 ? Number(value.projectHours) : totalHours * 0.25);
        const independentHours = Math.max(0, totalHours - guidedHours - projectHours);
        return { totalHours, guidedHours, independentHours, projectHours };
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
        const pattern = [2, 2, 2, 3, 2, 3, 3, 2, 2, 3, 3, 3, 2, 3, 4, 4, 2, 3, 3, 4];
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
            contentDescription: `Documento de estudio con explicaciones, ejemplos, ejercicios guiados, caso aplicado, laboratorio o practica reflexiva, criterios de evaluacion y recursos sugeridos para ${title}.`,
            tasks: [],
        };
    }

    _getDomainTopicTitles(focus) {
        const n = this._normalizeIntentText(focus);
        if (/\b(machine learning|aprendizaje automatico|deep learning|inteligencia artificial|ia|ciencia de datos|data science)\b/.test(n)) {
            return [
                'Fundamentos de aprendizaje supervisado y no supervisado',
                'Preparacion de datos y analisis exploratorio',
                'Algoritmos de clasificacion',
                'Modelos de regresion y metricas de error',
                'Seleccion de caracteristicas y reduccion de dimensionalidad',
                'Validacion cruzada y control de sobreajuste',
                'Pipelines de entrenamiento reproducibles',
                'Modelos basados en arboles y ensambles',
                'Introduccion a redes neuronales',
                'Ajuste de hiperparametros y comparacion de modelos',
                'Interpretabilidad, sesgos y explicabilidad',
                'Despliegue basico de modelos predictivos',
                'Monitoreo de modelos y deriva de datos',
                'MLOps introductorio y versionado de experimentos',
                'Construccion de producto de datos',
                'Presentacion tecnica de resultados y decisiones',
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
            `Mejora iterativa de la solucion en ${focus}`,
            `Preparacion de entrega profesional en ${focus}`,
            `Defensa tecnica y comunicacion de resultados en ${focus}`,
        ];
    }

    _buildSupplementalTask(topic, index, context) {
        const taskType = this._selectEvidenceTemplate(index, context);
        return {
            title: `${taskType}: ${topic.title}`,
            type: /proyecto|prototipo|version funcional|defensa/i.test(taskType) ? 'project' : (/diagnostico|evaluacion|defensa/i.test(taskType) ? 'assessment' : 'milestone'),
            description: `Evidencia donde el estudiante demuestra dominio practico de ${topic.title} mediante ${taskType.toLowerCase()}.`,
            dueWeek: this._suggestDueWeek(index, context.durationWeeks),
            contentDescription: `Guia de ${taskType.toLowerCase()} con pasos, ejercicios previos, criterios de entrega, recursos sugeridos y rubrica de evaluacion.`,
        };
    }

    _selectEvidenceTemplate(taskIndex, context = {}) {
        const topicIndex = Number(context.topicIndex) || 0;
        const topicsCount = Math.max(1, Number(context.topicsCount) || 1);
        const progress = topicsCount <= 1 ? 1 : topicIndex / (topicsCount - 1);
        if (topicIndex === 0 && taskIndex === 0) return 'Diagnostico inicial';
        if (progress < 0.2) return ['Ejercicio guiado', 'Laboratorio dirigido', 'Ficha de idea aplicada'][taskIndex % 3];
        if (progress < 0.45) return ['Laboratorio dirigido', 'Caso contextualizado', 'Plan de aplicacion', 'Bitacora tecnica'][taskIndex % 4];
        if (progress < 0.7) return ['Caso empresarial', 'Implementacion tecnica del bloque', 'Evaluacion intermedia', 'Revision tecnica aplicada'][taskIndex % 4];
        if (progress < 0.9) return ['Validacion funcional', 'Caso de validacion', 'Mejora iterativa', 'Informe tecnico aplicado'][taskIndex % 4];
        return ['Entrega profesional del bloque', 'Sustentacion tecnica', 'Retrospectiva profesional', 'Plan de mejora'][taskIndex % 4];
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
                type: 'project',
                description: `Hito transversal donde el estudiante integra lo aprendido hasta la semana ${milestone.dueWeek} en el proyecto del curso.`,
                dueWeek: milestone.dueWeek,
                contentDescription: 'Guia del hito con alcance, entregables, criterios de evaluacion, dependencias con modulos previos y recomendaciones de presentacion.',
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
                        if (taskRow?.id) tasksCreated++;
                    }
                }
            }

            this._generateSubjectThumbnailsInBackground({
                courseId,
                courseTitle: plan.title,
                category: plan.category || 'General',
                subjects: subjectsForThumbnails,
            });

            return Result.ok({
                courseId,
                topicsCreated,
                tasksCreated,
                thumbnailsInProgress: Boolean(this.storage && this.storage.isAvailable && this.storage.isAvailable()),
            });
        } catch (err) {
            return Result.fail(new ValidationError(`createCourseStructure falló: ${err.message}`));
        }
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

