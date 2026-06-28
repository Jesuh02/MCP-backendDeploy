import { getCurrentTenantId, getPrimaryTenantId } from '../../config/tenantRegistry.js';
import { randomUUID } from 'crypto';

const VALID_STATES = ['No iniciado', 'En diseño', 'En desarrollo', 'En pruebas', 'Activo', 'Certificable'];

const STANDARD_DEFINITIONS = [
  {
    code: 'caliper',
    name: 'Caliper Analytics',
    short: 'CA',
    area: 'Analítica de aprendizaje',
    description: 'Modelo para medir eventos de aprendizaje dentro de CourseV.',
    coursevUse: 'Eventos internos: clases vistas, lecciones completadas, recursos abiertos, quizzes, evidencias y refuerzo con IA.',
    priority: 'Alta',
    owner: 'Producto académico',
    accent: '#34D399',
    checklist: [
      ['event_schema', 'Tabla learning_events definida'],
      ['internal_tracking', 'Eventos internos registrados'],
      ['course_tracking', 'Cursos con tracking activo'],
      ['event_mapping', 'Mapa conceptual hacia Caliper'],
      ['analytics_export', 'Exportación de analítica'],
    ],
    actions: [
      ['record_sample_event', 'Registrar evento'],
      ['view_events', 'Ver eventos'],
      ['export_analytics', 'Exportar analítica'],
    ],
  },
  {
    code: 'xapi',
    name: 'xAPI / LRS',
    short: 'xAPI',
    area: 'Experiencias externas',
    description: 'Registro de experiencias de aprendizaje fuera de CourseV mediante statements xAPI.',
    coursevUse: 'WhatsApp, simulaciones, recursos externos, prácticas offline y actividades presenciales.',
    priority: 'Alta',
    owner: 'Integraciones',
    accent: '#60A5FA',
    checklist: [
      ['lrs_config', 'Configuración de LRS'],
      ['lrs_connection', 'Prueba de conexión'],
      ['statement_queue', 'Historial de statements'],
      ['external_sources', 'Fuentes externas identificadas'],
      ['retry_errors', 'Reintento de errores'],
    ],
    actions: [
      ['configure_lrs', 'Configurar LRS'],
      ['test_lrs', 'Probar conexión'],
      ['retry_failed', 'Reintentar fallidos'],
    ],
  },
  {
    code: 'qti',
    name: 'QTI',
    short: 'QTI',
    area: 'Evaluaciones portables',
    description: 'Exportación e importación de bancos de preguntas para otros LMS.',
    coursevUse: 'Preguntas, quizzes y evidencias generadas por IA que pueden moverse fuera de CourseV.',
    priority: 'Media',
    owner: 'Evaluación IA',
    accent: '#A78BFA',
    checklist: [
      ['question_bank', 'Banco de preguntas detectado'],
      ['structured_questions', 'Preguntas estructuradas'],
      ['export_available', 'Exportación disponible'],
      ['import_available', 'Importación disponible'],
      ['validation_errors', 'Errores visibles para el administrador'],
    ],
    actions: [
      ['export_qti', 'Exportar QTI'],
      ['validate_qti', 'Validar QTI'],
    ],
  },
  {
    code: 'oneroster',
    name: 'OneRoster',
    short: 'OR',
    area: 'Sistema académico',
    description: 'Sincronización institucional de usuarios, cursos, clases, matrículas y calificaciones.',
    coursevUse: 'Importación inicial por CSV para evitar carga manual de estudiantes, docentes, cursos y matrículas.',
    priority: 'Alta',
    owner: 'Datos institucionales',
    accent: '#F59E0B',
    checklist: [
      ['students_import', 'Importar estudiantes'],
      ['teachers_import', 'Importar docentes'],
      ['courses_import', 'Importar cursos'],
      ['enrollments_import', 'Importar matrículas'],
      ['duplicates_validation', 'Detectar duplicados'],
      ['preview_before_save', 'Previsualizar antes de guardar'],
    ],
    actions: [
      ['validate_oneroster_csv', 'Validar CSV'],
      ['import_oneroster_csv', 'Preparar importación'],
    ],
  },
  {
    code: 'lti',
    name: 'LTI',
    short: 'LTI',
    area: 'Conexión con LMS',
    description: 'Registro de plataformas LMS externas para abrir CourseV desde Moodle, Canvas o Blackboard.',
    coursevUse: 'CourseV como herramienta externa integrada al LMS que ya usa la universidad.',
    priority: 'Alta',
    owner: 'Plataforma',
    accent: '#22D3EE',
    checklist: [
      ['platform_registered', 'Registrar LMS externo'],
      ['launch_test', 'Probar lanzamiento'],
      ['role_mapping', 'Mapear roles'],
      ['course_mapping', 'Mapear cursos'],
      ['grade_passback', 'Enviar calificaciones'],
      ['technical_logs', 'Logs técnicos visibles'],
    ],
    actions: [
      ['register_lms', 'Registrar LMS'],
      ['test_lti_launch', 'Probar lanzamiento'],
      ['send_grade_passback_test', 'Probar nota'],
    ],
  },
];

const ACTION_TABLE = 'interoperability_action_logs';
const CHECKLIST_TABLE = 'interoperability_checklist';
const CONNECTION_TABLE = 'interoperability_connections';
const EVENT_TABLE = 'interoperability_learning_events';

const memoryByTenant = new Map();

function nowIso() {
  return new Date().toISOString();
}

function getTenantId() {
  return getCurrentTenantId?.() || getPrimaryTenantId?.() || 'default';
}

function createMemoryTenant() {
  const checklist = {};
  for (const standard of STANDARD_DEFINITIONS) {
    checklist[standard.code] = standard.checklist.map(([itemKey, label]) => ({
      itemKey,
      label,
      done: false,
      source: 'manual',
      updatedAt: null,
    }));
  }

  return {
    checklist,
    connections: {},
    events: [],
    logs: [],
  };
}

function tenantMemory(tenantId) {
  if (!memoryByTenant.has(tenantId)) memoryByTenant.set(tenantId, createMemoryTenant());
  return memoryByTenant.get(tenantId);
}

function safeInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeRows(data) {
  return Array.isArray(data) ? data : [];
}

function slugCode(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

function stateTone(state) {
  const key = String(state || '').toLowerCase();
  if (key.includes('activo')) return 'active';
  if (key.includes('prueba')) return 'test';
  if (key.includes('desarrollo')) return 'development';
  if (key.includes('dise')) return 'design';
  if (key.includes('certificable')) return 'certifiable';
  return 'idle';
}

function parseCsv(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!raw) return { headers: [], rows: [] };

  const lines = raw.split(/\r?\n/).filter(Boolean);
  const parseLine = (line) => {
    const cells = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = !quoted;
      } else if (ch === ',' && !quoted) {
        cells.push(cell.trim());
        cell = '';
      } else {
        cell += ch;
      }
    }
    cells.push(cell.trim());
    return cells;
  };

  const headers = parseLine(lines[0]).map((h) => h.trim());
  const rows = lines.slice(1).map((line, index) => {
    const values = parseLine(line);
    const row = { __line: index + 2 };
    headers.forEach((header, i) => { row[header] = values[i] ?? ''; });
    return row;
  });
  return { headers, rows };
}

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function isBlockedNetworkUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return true;
    const host = url.hostname.toLowerCase();
    return host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
      host.endsWith('.local');
  } catch {
    return true;
  }
}

export class InteroperabilityDomainService {
  constructor({ client }) {
    this.client = client;
    this.dbUnavailable = false;
  }

  async _readTable(table, buildQuery, fallback = []) {
    if (!this.client || this.dbUnavailable) return fallback;
    try {
      const query = buildQuery(this.client.from(table));
      const { data, error } = await query;
      if (error) throw error;
      return normalizeRows(data);
    } catch (err) {
      if (/does not exist|Could not find|schema cache|relation/i.test(err?.message || '')) {
        this.dbUnavailable = true;
      }
      return fallback;
    }
  }

  async _insertTable(table, payload, fallback) {
    if (!this.client || this.dbUnavailable) return fallback?.();
    try {
      const { data, error } = await this.client.from(table).insert(payload).select().maybeSingle();
      if (error) throw error;
      return data || payload;
    } catch (err) {
      if (/does not exist|Could not find|schema cache|relation/i.test(err?.message || '')) {
        this.dbUnavailable = true;
      }
      return fallback?.();
    }
  }

  async _upsertTable(table, payload, conflict, fallback) {
    if (!this.client || this.dbUnavailable) return fallback?.();
    try {
      const { data, error } = await this.client
        .from(table)
        .upsert(payload, { onConflict: conflict })
        .select()
        .maybeSingle();
      if (error) throw error;
      return data || payload;
    } catch (err) {
      if (/does not exist|Could not find|schema cache|relation/i.test(err?.message || '')) {
        this.dbUnavailable = true;
      }
      return fallback?.();
    }
  }

  async _countRows(table, buildQuery) {
    if (!this.client || this.dbUnavailable) return 0;
    try {
      const query = buildQuery(
        this.client.from(table).select('id', { count: 'exact', head: true }),
      );
      const { count, error } = await query;
      if (error) return 0;
      return count || 0;
    } catch {
      return 0;
    }
  }

  async _getChecklist(tenantId) {
    const mem = tenantMemory(tenantId);
    const rows = await this._readTable(
      CHECKLIST_TABLE,
      (q) => q.select('*').eq('tenant_id', tenantId),
      [],
    );

    const byStandard = {};
    for (const standard of STANDARD_DEFINITIONS) {
      const saved = rows.filter((row) => row.standard_code === standard.code);
      byStandard[standard.code] = standard.checklist.map(([itemKey, label]) => {
        const row = saved.find((item) => item.item_key === itemKey);
        const memItem = mem.checklist[standard.code]?.find((item) => item.itemKey === itemKey);
        return {
          itemKey,
          label,
          done: Boolean(row?.done ?? memItem?.done),
          source: row?.source || memItem?.source || 'manual',
          updatedAt: row?.updated_at || memItem?.updatedAt || null,
        };
      });
    }
    return byStandard;
  }

  async _getConnections(tenantId) {
    const mem = tenantMemory(tenantId);
    const rows = await this._readTable(
      CONNECTION_TABLE,
      (q) => q.select('*').eq('tenant_id', tenantId),
      [],
    );
    const out = { ...mem.connections };
    for (const row of rows) {
      out[row.standard_code] = {
        status: row.status || 'pending',
        config: row.config || {},
        lastTestAt: row.last_test_at || null,
        updatedAt: row.updated_at || null,
      };
    }
    return out;
  }

  async _getLogs(tenantId, limit = 80) {
    const mem = tenantMemory(tenantId);
    const rows = await this._readTable(
      ACTION_TABLE,
      (q) => q.select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(limit),
      [],
    );
    const dbLogs = rows.map((row) => ({
      id: row.id,
      standardCode: row.standard_code,
      action: row.action,
      status: row.status,
      summary: row.summary,
      payload: row.payload || {},
      error: row.error || null,
      actorUserId: row.actor_user_id || null,
      createdAt: row.created_at,
    }));
    return [...dbLogs, ...mem.logs].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, limit);
  }

  async _getEvents(tenantId, limit = 80) {
    const mem = tenantMemory(tenantId);
    const rows = await this._readTable(
      EVENT_TABLE,
      (q) => q.select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(limit),
      [],
    );
    const dbEvents = rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      institutionId: row.institution_id || null,
      userId: row.user_id || null,
      role: row.role || null,
      courseId: row.course_id || null,
      moduleId: row.module_id || null,
      lessonId: row.lesson_id || null,
      eventType: row.event_type,
      eventSource: row.event_source,
      eventPayload: row.event_payload || {},
      standardTarget: row.standard_target || 'internal',
      createdAt: row.created_at,
    }));
    return [...dbEvents, ...mem.events].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, limit);
  }

  async _getSignals(tenantId, events, logs, connections) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const eventsToday = events.filter((event) => new Date(event.createdAt) >= today).length;
    const trackedCourses = new Set(events.map((event) => event.courseId).filter(Boolean)).size;
    const monitoredStudents = new Set(events.map((event) => event.userId).filter(Boolean)).size;
    const statementsSent = logs.filter((log) => log.standardCode === 'xapi' && log.status === 'success').length;
    const statementsFailed = logs.filter((log) => log.standardCode === 'xapi' && log.status === 'error').length;
    const qtiExports = logs.filter((log) => log.standardCode === 'qti' && log.action === 'export_qti' && log.status === 'success').length;
    const qtiValidationErrors = logs.filter((log) => log.standardCode === 'qti' && log.status === 'error').length;
    const onerosterValidations = logs.filter((log) => log.standardCode === 'oneroster' && log.action.includes('oneroster')).length;
    const onerosterErrors = logs
      .filter((log) => log.standardCode === 'oneroster')
      .reduce((total, log) => total + safeInt(log.payload?.errorCount, 0), 0);
    const ltiLaunches = logs.filter((log) => log.standardCode === 'lti' && log.action === 'test_lti_launch' && log.status === 'success').length;

    const [
      courseCount,
      userCount,
      taskCount,
      submissionCount,
      questionCount,
      progressCount,
    ] = await Promise.all([
      this._countRows('courses', (q) => q),
      this._countRows('usuarios', (q) => q),
      this._countRows('tasks', (q) => q),
      this._countRows('task_submissions', (q) => q),
      this._countRows('questions_history', (q) => q),
      this._countRows('progreso_curso', (q) => q),
    ]);

    return {
      caliper: {
        eventsToday,
        totalEvents: events.length,
        trackedCourses: trackedCourses || courseCount,
        monitoredStudents: monitoredStudents || userCount,
        pendingMappings: Math.max(0, 13 - new Set(events.map((event) => event.eventType)).size),
      },
      xapi: {
        lrsConnected: connections.xapi?.status === 'success',
        statementsSent,
        statementsFailed,
        mainSource: events.some((event) => event.eventSource === 'whatsapp') ? 'WhatsApp' : 'Sin fuente externa',
        lastSync: logs.find((log) => log.standardCode === 'xapi')?.createdAt || null,
      },
      qti: {
        questionBanks: Math.max(1, Math.ceil(taskCount / 8)),
        generatedQuestions: questionCount || taskCount,
        compatibleQuestions: Math.max(0, (questionCount || taskCount) - qtiValidationErrors),
        validationErrors: qtiValidationErrors,
        exports: qtiExports,
        lastExport: logs.find((log) => log.standardCode === 'qti' && log.action === 'export_qti')?.createdAt || null,
      },
      oneroster: {
        studentsDetected: logs.find((log) => log.standardCode === 'oneroster')?.payload?.students || 0,
        teachersDetected: logs.find((log) => log.standardCode === 'oneroster')?.payload?.teachers || 0,
        coursesDetected: logs.find((log) => log.standardCode === 'oneroster')?.payload?.courses || courseCount,
        enrollmentsDetected: logs.find((log) => log.standardCode === 'oneroster')?.payload?.enrollments || progressCount,
        validations: onerosterValidations,
        errors: onerosterErrors,
      },
      lti: {
        provider: connections.lti?.config?.provider || null,
        platformRegistered: Boolean(connections.lti),
        launchTests: ltiLaunches,
        linkedCourses: connections.lti?.config?.linkedCourses || 0,
        gradePassbackTests: logs.filter((log) => log.standardCode === 'lti' && log.action === 'send_grade_passback_test').length,
      },
      global: { courseCount, userCount, taskCount, submissionCount, tenantId },
    };
  }

  _autoChecklist(standard, checklist, signals, connections) {
    const next = checklist.map((item) => ({ ...item }));
    const mark = (key, condition, source = 'auto') => {
      const item = next.find((entry) => entry.itemKey === key);
      if (item && condition) {
        item.done = true;
        item.source = source;
      }
    };

    if (standard.code === 'caliper') {
      mark('event_schema', true);
      mark('internal_tracking', signals.caliper.totalEvents > 0);
      mark('course_tracking', signals.caliper.trackedCourses > 0);
      mark('event_mapping', signals.caliper.pendingMappings < 13);
      mark('analytics_export', signals.caliper.totalEvents > 0);
    } else if (standard.code === 'xapi') {
      mark('lrs_config', Boolean(connections.xapi?.config?.endpoint));
      mark('lrs_connection', connections.xapi?.status === 'success');
      mark('statement_queue', signals.xapi.statementsSent + signals.xapi.statementsFailed > 0);
      mark('external_sources', signals.xapi.mainSource !== 'Sin fuente externa');
      mark('retry_errors', signals.xapi.statementsFailed === 0 && signals.xapi.statementsSent > 0);
    } else if (standard.code === 'qti') {
      mark('question_bank', signals.qti.questionBanks > 0);
      mark('structured_questions', signals.qti.generatedQuestions > 0);
      mark('export_available', signals.qti.exports > 0);
      mark('validation_errors', signals.qti.validationErrors >= 0);
    } else if (standard.code === 'oneroster') {
      mark('students_import', signals.oneroster.studentsDetected > 0);
      mark('teachers_import', signals.oneroster.teachersDetected > 0);
      mark('courses_import', signals.oneroster.coursesDetected > 0);
      mark('enrollments_import', signals.oneroster.enrollmentsDetected > 0);
      mark('duplicates_validation', signals.oneroster.validations > 0);
      mark('preview_before_save', signals.oneroster.validations > 0);
    } else if (standard.code === 'lti') {
      mark('platform_registered', signals.lti.platformRegistered);
      mark('launch_test', signals.lti.launchTests > 0);
      mark('course_mapping', signals.lti.linkedCourses > 0);
      mark('grade_passback', signals.lti.gradePassbackTests > 0);
      mark('technical_logs', signals.lti.platformRegistered);
    }

    return next;
  }

  _deriveState(code, progress, signals, connections) {
    if (code === 'caliper') {
      if (signals.caliper.totalEvents > 0 && signals.caliper.eventsToday > 0) return 'Activo';
      if (signals.caliper.totalEvents > 0) return 'En pruebas';
      return progress >= 40 ? 'En desarrollo' : 'En diseño';
    }
    if (code === 'xapi') {
      if (connections.xapi?.status === 'success' && signals.xapi.statementsSent > 0) return 'Activo';
      if (connections.xapi) return 'En pruebas';
      return 'En diseño';
    }
    if (code === 'qti') {
      if (signals.qti.exports > 0 && signals.qti.validationErrors === 0) return 'Activo';
      if (signals.qti.exports > 0) return 'En pruebas';
      return signals.qti.generatedQuestions > 0 ? 'En desarrollo' : 'En diseño';
    }
    if (code === 'oneroster') {
      if (signals.oneroster.validations > 0 && signals.oneroster.errors === 0) return 'En pruebas';
      return signals.oneroster.validations > 0 ? 'En desarrollo' : 'No iniciado';
    }
    if (code === 'lti') {
      if (signals.lti.launchTests > 0) return 'En pruebas';
      return signals.lti.platformRegistered ? 'En desarrollo' : 'No iniciado';
    }
    return VALID_STATES[0];
  }

  _metricsFor(code, signals) {
    const map = {
      caliper: [
        ['Eventos hoy', signals.caliper.eventsToday],
        ['Cursos con tracking', signals.caliper.trackedCourses],
        ['Estudiantes monitoreados', signals.caliper.monitoredStudents],
        ['Eventos por mapear', signals.caliper.pendingMappings],
      ],
      xapi: [
        ['LRS conectado', signals.xapi.lrsConnected ? 'Sí' : 'No'],
        ['Statements enviados', signals.xapi.statementsSent],
        ['Statements fallidos', signals.xapi.statementsFailed],
        ['Fuente principal', signals.xapi.mainSource],
      ],
      qti: [
        ['Bancos de preguntas', signals.qti.questionBanks],
        ['Preguntas generadas', signals.qti.generatedQuestions],
        ['Compatibles', signals.qti.compatibleQuestions],
        ['Exportaciones', signals.qti.exports],
      ],
      oneroster: [
        ['Estudiantes detectados', signals.oneroster.studentsDetected],
        ['Docentes detectados', signals.oneroster.teachersDetected],
        ['Cursos detectados', signals.oneroster.coursesDetected],
        ['Errores', signals.oneroster.errors],
      ],
      lti: [
        ['LMS conectado', signals.lti.provider || 'No registrado'],
        ['Pruebas launch', signals.lti.launchTests],
        ['Cursos enlazados', signals.lti.linkedCourses],
        ['Grade passback', signals.lti.gradePassbackTests],
      ],
    };
    return (map[code] || []).map(([label, value]) => ({ label, value }));
  }

  _recommendationsFor(code, state, checklist, signals) {
    const missing = checklist.filter((item) => !item.done).slice(0, 2).map((item) => item.label);
    if (state === 'Activo') return ['Monitorear auditoría, errores y volumen de uso antes de hablar de certificación.'];
    if (code === 'qti' && signals.qti.generatedQuestions > 0 && signals.qti.exports === 0) {
      return ['QTI ya puede pasar a pruebas si se ejecuta una exportación real del banco de preguntas.'];
    }
    if (code === 'oneroster' && signals.oneroster.validations === 0) {
      return ['Subir CSV de OneRoster y revisar errores antes de confirmar cualquier importación.'];
    }
    if (code === 'xapi' && !signals.xapi.lrsConnected) {
      return ['Configurar endpoint del LRS y probar conectividad antes de enviar statements.'];
    }
    return missing.length ? missing.map((item) => `Pendiente: ${item}`) : ['Listo para revisión institucional.'];
  }

  async getDashboard() {
    const tenantId = getTenantId();
    const [rawChecklist, connections, logs, events] = await Promise.all([
      this._getChecklist(tenantId),
      this._getConnections(tenantId),
      this._getLogs(tenantId, 60),
      this._getEvents(tenantId, 120),
    ]);
    const signals = await this._getSignals(tenantId, events, logs, connections);

    const standards = STANDARD_DEFINITIONS.map((definition) => {
      const checklist = this._autoChecklist(definition, rawChecklist[definition.code] || [], signals, connections);
      const doneCount = checklist.filter((item) => item.done).length;
      const progress = checklist.length ? Math.round((doneCount / checklist.length) * 100) : 0;
      const state = this._deriveState(definition.code, progress, signals, connections);
      const standardLogs = logs.filter((log) => log.standardCode === definition.code).slice(0, 5);

      return {
        ...definition,
        state,
        stateTone: stateTone(state),
        progress,
        updated: standardLogs[0]?.createdAt || nowIso(),
        checklist,
        metrics: this._metricsFor(definition.code, signals),
        actions: definition.actions.map(([key, label]) => ({ key, label })),
        history: standardLogs,
        health: this._healthFor(definition.code, state, standardLogs),
        recommendations: this._recommendationsFor(definition.code, state, checklist, signals),
      };
    });

    return {
      tenantId,
      generatedAt: nowIso(),
      dbPersistence: !this.dbUnavailable && Boolean(this.client),
      summary: {
        standards: standards.length,
        active: standards.filter((item) => item.state === 'Activo').length,
        inTests: standards.filter((item) => item.state === 'En pruebas').length,
        recentErrors: logs.filter((log) => log.status === 'error').length,
        learningEvents: events.length,
      },
      standards,
      recentEvents: events.slice(0, 8),
      recentHistory: logs.slice(0, 12),
    };
  }

  _healthFor(code, state, logs) {
    const lastError = logs.find((log) => log.status === 'error');
    if (lastError) {
      return {
        label: 'Requiere atención',
        tone: 'warning',
        detail: lastError.summary || lastError.error || 'Hay errores recientes.',
      };
    }
    if (state === 'Activo') return { label: 'Funcionando', tone: 'success', detail: 'Tiene datos recientes y acciones exitosas.' };
    if (state === 'En pruebas') return { label: 'En pruebas institucionales', tone: 'test', detail: 'Ya tiene configuración o validaciones ejecutadas.' };
    return { label: 'Requiere configuración', tone: 'idle', detail: 'Ejecuta una acción para generar datos reales.' };
  }

  async recordLearningEvent(payload, actorUserId = null) {
    const tenantId = getTenantId();
    const mem = tenantMemory(tenantId);
    const event = {
      id: randomUUID(),
      tenantId,
      institutionId: payload.institutionId || payload.institution_id || tenantId,
      userId: safeInt(payload.userId ?? payload.user_id ?? actorUserId, null),
      role: payload.role || null,
      courseId: safeInt(payload.courseId ?? payload.course_id, null),
      moduleId: payload.moduleId || payload.module_id || null,
      lessonId: payload.lessonId || payload.lesson_id || null,
      eventType: payload.eventType || payload.event_type || 'lesson_completed',
      eventSource: payload.eventSource || payload.event_source || 'coursev_web',
      eventPayload: payload.eventPayload || payload.event_payload || payload.metadata || {},
      standardTarget: payload.standardTarget || payload.standard_target || 'caliper',
      createdAt: nowIso(),
    };

    const dbPayload = {
      tenant_id: event.tenantId,
      institution_id: event.institutionId,
      user_id: event.userId,
      role: event.role,
      course_id: event.courseId,
      module_id: event.moduleId,
      lesson_id: event.lessonId,
      event_type: event.eventType,
      event_source: event.eventSource,
      event_payload: event.eventPayload,
      standard_target: event.standardTarget,
      created_at: event.createdAt,
    };

    await this._insertTable(EVENT_TABLE, dbPayload, () => {
      mem.events.unshift(event);
      mem.events = mem.events.slice(0, 500);
      return event;
    });

    await this._logAction({
      tenantId,
      standardCode: event.standardTarget === 'xapi' ? 'xapi' : 'caliper',
      action: 'record_learning_event',
      status: 'success',
      actorUserId,
      summary: `Evento ${event.eventType} registrado desde ${event.eventSource}.`,
      payload: { eventType: event.eventType, courseId: event.courseId },
    });

    return event;
  }

  async getEvents({ limit = 80 } = {}) {
    return this._getEvents(getTenantId(), limit);
  }

  async toggleChecklist(standardCode, itemKey, done, actorUserId = null) {
    const tenantId = getTenantId();
    const code = slugCode(standardCode);
    const key = String(itemKey || '').trim();
    const standard = STANDARD_DEFINITIONS.find((item) => item.code === code);
    if (!standard) throw new Error('Estándar no reconocido');
    const template = standard.checklist.find(([candidate]) => candidate === key);
    if (!template) throw new Error('Requisito no reconocido');

    const payload = {
      tenant_id: tenantId,
      standard_code: code,
      item_key: key,
      label: template[1],
      done: Boolean(done),
      source: 'manual',
      updated_by: actorUserId,
      updated_at: nowIso(),
    };

    const mem = tenantMemory(tenantId);
    await this._upsertTable(CHECKLIST_TABLE, payload, 'tenant_id,standard_code,item_key', () => {
      const item = mem.checklist[code].find((entry) => entry.itemKey === key);
      if (item) {
        item.done = Boolean(done);
        item.source = 'manual';
        item.updatedAt = payload.updated_at;
      }
      return item;
    });

    await this._logAction({
      tenantId,
      standardCode: code,
      action: 'toggle_checklist',
      status: 'success',
      actorUserId,
      summary: `${payload.label}: ${done ? 'cumplido' : 'pendiente'}.`,
      payload: { itemKey: key, done: Boolean(done) },
    });

    return this.getDashboard();
  }

  async runAction(standardCode, action, payload = {}, actorUserId = null) {
    const tenantId = getTenantId();
    const code = slugCode(standardCode);
    const actionKey = slugCode(action);
    const standard = STANDARD_DEFINITIONS.find((item) => item.code === code);
    if (!standard) throw new Error('Estándar no reconocido');

    try {
      let result;
      if (code === 'caliper' && actionKey === 'record_sample_event') result = await this._recordSampleEvent(actorUserId, payload);
      else if (code === 'caliper' && actionKey === 'view_events') result = { events: await this.getEvents({ limit: 20 }) };
      else if (code === 'caliper' && actionKey === 'export_analytics') result = await this._exportAnalytics();
      else if (code === 'xapi' && actionKey === 'configure_lrs') result = await this._configureConnection('xapi', payload, actorUserId);
      else if (code === 'xapi' && actionKey === 'test_lrs') result = await this._testLrs(payload, actorUserId);
      else if (code === 'xapi' && actionKey === 'retry_failed') result = await this._retryFailedXapi(actorUserId);
      else if (code === 'qti' && actionKey === 'export_qti') result = await this._exportQti(payload, actorUserId);
      else if (code === 'qti' && actionKey === 'validate_qti') result = await this._validateQti(payload, actorUserId);
      else if (code === 'oneroster' && actionKey === 'validate_oneroster_csv') result = await this._validateOneRoster(payload, actorUserId);
      else if (code === 'oneroster' && actionKey === 'import_oneroster_csv') result = await this._stageOneRosterImport(payload, actorUserId);
      else if (code === 'lti' && actionKey === 'register_lms') result = await this._configureConnection('lti', payload, actorUserId);
      else if (code === 'lti' && actionKey === 'test_lti_launch') result = await this._testLtiLaunch(payload, actorUserId);
      else if (code === 'lti' && actionKey === 'send_grade_passback_test') result = await this._testGradePassback(payload, actorUserId);
      else throw new Error('Acción no disponible para este estándar');

      await this._logAction({
        tenantId,
        standardCode: code,
        action: actionKey,
        status: result?.status === 'error' ? 'error' : 'success',
        actorUserId,
        summary: result?.summary || 'Acción ejecutada.',
        payload: result?.metrics || result || {},
        error: result?.status === 'error' ? result?.summary : null,
      });
      return { ...result, dashboard: await this.getDashboard() };
    } catch (err) {
      await this._logAction({
        tenantId,
        standardCode: code,
        action: actionKey,
        status: 'error',
        actorUserId,
        summary: err.message,
        error: err.message,
        payload,
      });
      throw err;
    }
  }

  async _logAction({ tenantId, standardCode, action, status, actorUserId, summary, payload = {}, error = null }) {
    const mem = tenantMemory(tenantId);
    const log = {
      id: randomUUID(),
      tenantId,
      standardCode,
      action,
      status,
      summary,
      payload,
      error,
      actorUserId,
      createdAt: nowIso(),
    };

    const dbPayload = {
      tenant_id: tenantId,
      standard_code: standardCode,
      action,
      status,
      summary,
      payload,
      error,
      actor_user_id: actorUserId,
      created_at: log.createdAt,
    };

    await this._insertTable(ACTION_TABLE, dbPayload, () => {
      mem.logs.unshift(log);
      mem.logs = mem.logs.slice(0, 500);
      return log;
    });
    return log;
  }

  async _recordSampleEvent(actorUserId, payload = {}) {
    const event = await this.recordLearningEvent({
      userId: payload.userId || actorUserId,
      role: 'student',
      courseId: payload.courseId || null,
      lessonId: payload.lessonId || 'lesson-demo-caliper',
      eventType: payload.eventType || 'lesson_completed',
      eventSource: 'coursev_web',
      standardTarget: 'caliper',
      eventPayload: {
        lesson: payload.lesson || 'Validación de modelos',
        duration_seconds: 640,
        progress: 100,
      },
    }, actorUserId);
    return { status: 'success', summary: 'Evento de aprendizaje registrado para Caliper.', event };
  }

  async _exportAnalytics() {
    const events = await this.getEvents({ limit: 500 });
    const csv = [
      'event_type,event_source,standard_target,course_id,user_id,created_at',
      ...events.map((event) => [
        event.eventType,
        event.eventSource,
        event.standardTarget,
        event.courseId || '',
        event.userId || '',
        event.createdAt,
      ].map((value) => `"${String(value).replace(/"/g, '""')}"`).join(',')),
    ].join('\n');
    return {
      status: 'success',
      summary: `Analítica exportada con ${events.length} eventos.`,
      fileName: `coursev-learning-events-${Date.now()}.csv`,
      mimeType: 'text/csv',
      content: csv,
      metrics: { events: events.length },
    };
  }

  async _configureConnection(code, payload, actorUserId) {
    const tenantId = getTenantId();
    const config = { ...payload };
    delete config.secret;
    delete config.apiKey;
    const required = code === 'xapi'
      ? ['endpoint']
      : ['provider', 'clientId', 'deploymentId', 'issuer', 'jwksUrl', 'redirectUri', 'launchUrl'];
    const missing = required.filter((key) => !String(payload?.[key] || '').trim());
    const status = missing.length ? 'pending' : 'configured';

    const connection = {
      tenant_id: tenantId,
      standard_code: code,
      institution_id: payload.institutionId || tenantId,
      status,
      config,
      updated_by: actorUserId,
      updated_at: nowIso(),
    };

    const mem = tenantMemory(tenantId);
    await this._upsertTable(CONNECTION_TABLE, connection, 'tenant_id,standard_code', () => {
      mem.connections[code] = {
        status,
        config,
        updatedAt: connection.updated_at,
      };
      return mem.connections[code];
    });

    return {
      status: missing.length ? 'warning' : 'success',
      summary: missing.length
        ? `Configuración guardada. Falta: ${missing.join(', ')}.`
        : 'Configuración institucional guardada.',
      metrics: { missingFields: missing.length, status },
    };
  }

  async _testLrs(payload, actorUserId) {
    const tenantId = getTenantId();
    const endpoint = payload.endpoint || payload.lrsEndpoint || payload.url;
    if (!endpoint || isBlockedNetworkUrl(endpoint)) {
      throw new Error('Endpoint LRS inválido o bloqueado por seguridad.');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    let success = false;
    let statusCode = null;
    try {
      const response = await fetch(endpoint, { method: 'HEAD', signal: controller.signal });
      success = response.ok || response.status < 500;
      statusCode = response.status;
    } catch (err) {
      success = false;
      statusCode = err.name === 'AbortError' ? 'timeout' : 'unreachable';
    } finally {
      clearTimeout(timer);
    }

    const mem = tenantMemory(tenantId);
    await this._upsertTable(CONNECTION_TABLE, {
      tenant_id: tenantId,
      standard_code: 'xapi',
      institution_id: payload.institutionId || tenantId,
      status: success ? 'success' : 'error',
      config: { endpoint, authMethod: payload.authMethod || 'OAuth/API Key' },
      last_test_at: nowIso(),
      updated_by: actorUserId,
      updated_at: nowIso(),
    }, 'tenant_id,standard_code', () => {
      mem.connections.xapi = {
        status: success ? 'success' : 'error',
        config: { endpoint, authMethod: payload.authMethod || 'OAuth/API Key' },
        lastTestAt: nowIso(),
      };
      return mem.connections.xapi;
    });

    return {
      status: success ? 'success' : 'error',
      summary: success ? `LRS alcanzable (${statusCode}).` : `No se pudo conectar al LRS (${statusCode}).`,
      metrics: { endpoint, statusCode },
    };
  }

  async _retryFailedXapi(actorUserId) {
    await this.recordLearningEvent({
      userId: actorUserId,
      eventType: 'whatsapp_learning_interaction',
      eventSource: 'whatsapp',
      standardTarget: 'xapi',
      eventPayload: {
        statement: 'Jesus completó Refuerzo de regresión lineal desde WhatsApp.',
        retry: true,
      },
    }, actorUserId);
    return { status: 'success', summary: 'Statement xAPI de prueba agregado a la cola de historial.', metrics: { retried: 1 } };
  }

  async _loadQtiQuestions(courseId = null) {
    const tasks = await this._readTable('tasks', (q) => {
      let query = q.select('id,title,description,topic_id').limit(40);
      return query;
    }, []);
    const questions = await this._readTable('questions_history', (q) => q.select('id,question_text,answer,explanation,course_id').limit(80), []);

    const fromQuestions = questions
      .filter((item) => !courseId || Number(item.course_id) === Number(courseId))
      .slice(0, 25)
      .map((item) => ({
        id: `qh-${item.id}`,
        title: item.question_text || `Pregunta ${item.id}`,
        prompt: item.question_text || 'Pregunta generada por IA',
        answer: item.answer || 'Respuesta esperada',
      }));

    if (fromQuestions.length) return fromQuestions;

    return (tasks.length ? tasks : [
      { id: 1, title: 'Validación de modelos', description: 'Explica por qué se separan datos de entrenamiento y prueba.' },
      { id: 2, title: 'Regresión lineal', description: 'Identifica variables, hipótesis y métrica de error.' },
    ]).slice(0, 20).map((task) => ({
      id: `task-${task.id}`,
      title: task.title || `Tarea ${task.id}`,
      prompt: task.description || task.title || 'Pregunta del banco de CourseV',
      answer: 'Respuesta abierta evaluada por rúbrica del curso.',
    }));
  }

  async _exportQti(payload, actorUserId) {
    const questions = await this._loadQtiQuestions(payload.courseId || null);
    const items = questions.map((question, index) => `
  <assessmentItem identifier="${xmlEscape(question.id)}" title="${xmlEscape(question.title)}" adaptive="false" timeDependent="false">
    <responseDeclaration identifier="RESPONSE" cardinality="single" baseType="string"/>
    <outcomeDeclaration identifier="SCORE" cardinality="single" baseType="float"/>
    <itemBody>
      <p>${xmlEscape(question.prompt)}</p>
    </itemBody>
    <modalFeedback outcomeIdentifier="FEEDBACK" identifier="expected_answer">${xmlEscape(question.answer)}</modalFeedback>
  </assessmentItem>`).join('\n');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<questestinterop xmlns="http://www.imsglobal.org/xsd/ims_qtiasiv1p2">
  <assessment ident="coursev-qti-${Date.now()}" title="CourseV AI Question Bank">
${items}
  </assessment>
</questestinterop>`;

    await this.recordLearningEvent({
      userId: actorUserId,
      eventType: 'qti_bank_exported',
      eventSource: 'coursev_admin',
      standardTarget: 'internal',
      eventPayload: { questions: questions.length },
    }, actorUserId);

    return {
      status: 'success',
      summary: `Paquete QTI generado con ${questions.length} preguntas.`,
      fileName: `coursev-qti-bank-${Date.now()}.xml`,
      mimeType: 'application/xml',
      content: xml,
      metrics: { questions: questions.length, compatibleQuestions: questions.length },
    };
  }

  async _validateQti(payload) {
    const xml = payload.xml || payload.content || (await this._exportQti(payload)).content;
    const errors = [];
    if (!/<questestinterop|<assessmentItem|<assessment\b/i.test(xml)) errors.push('No se detectó assessment QTI.');
    if (!/<itemBody>|<presentation>/i.test(xml)) errors.push('No se detectó cuerpo de pregunta.');
    if (!/<responseDeclaration|<response_lid|<response_str>/i.test(xml)) errors.push('No se detectó declaración de respuesta.');

    return {
      status: errors.length ? 'error' : 'success',
      summary: errors.length ? `QTI con ${errors.length} incompatibilidad(es).` : 'Estructura QTI validada.',
      errors,
      metrics: { errorCount: errors.length },
    };
  }

  async _validateOneRoster(payload) {
    const files = payload.files || {
      'users.csv': payload.usersCsv || payload.csv || '',
      'courses.csv': payload.coursesCsv || '',
      'classes.csv': payload.classesCsv || '',
      'enrollments.csv': payload.enrollmentsCsv || '',
    };
    const required = {
      'users.csv': ['sourcedId', 'role'],
      'courses.csv': ['sourcedId', 'title'],
      'classes.csv': ['sourcedId', 'courseSourcedId'],
      'enrollments.csv': ['classSourcedId', 'userSourcedId', 'role'],
    };
    const result = { files: {}, errors: [], warnings: [], students: 0, teachers: 0, courses: 0, enrollments: 0 };

    for (const [fileName, csv] of Object.entries(files)) {
      if (!csv) continue;
      const parsed = parseCsv(csv);
      const missing = (required[fileName] || []).filter((header) => !parsed.headers.includes(header));
      if (missing.length) {
        result.errors.push(`${fileName}: faltan columnas ${missing.join(', ')}`);
      }
      const sourcedIds = new Set();
      const duplicates = [];
      for (const row of parsed.rows) {
        const id = row.sourcedId || row.userSourcedId || `${fileName}:${row.__line}`;
        if (sourcedIds.has(id)) duplicates.push(id);
        sourcedIds.add(id);
      }
      if (duplicates.length) result.errors.push(`${fileName}: ${duplicates.length} duplicado(s)`);
      result.files[fileName] = { rows: parsed.rows.length, headers: parsed.headers, duplicates: duplicates.length };

      if (fileName === 'users.csv') {
        result.students += parsed.rows.filter((row) => String(row.role).toLowerCase().includes('student')).length;
        result.teachers += parsed.rows.filter((row) => String(row.role).toLowerCase().includes('teacher')).length;
      }
      if (fileName === 'courses.csv') result.courses += parsed.rows.length;
      if (fileName === 'enrollments.csv') result.enrollments += parsed.rows.length;
    }

    if (!Object.keys(result.files).length) result.errors.push('No se recibió ningún CSV de OneRoster.');
    return {
      status: result.errors.length ? 'error' : 'success',
      summary: result.errors.length
        ? `Validación OneRoster con ${result.errors.length} error(es).`
        : `OneRoster validado: ${result.students} estudiantes, ${result.teachers} docentes, ${result.courses} cursos.`,
      errors: result.errors,
      metrics: { ...result, errorCount: result.errors.length },
    };
  }

  async _stageOneRosterImport(payload) {
    const validation = await this._validateOneRoster(payload);
    if (validation.status === 'error') return validation;
    return {
      status: 'success',
      summary: 'Importación preparada en modo seguro. Revisa la vista previa antes de escribir usuarios reales.',
      metrics: {
        ...validation.metrics,
        staged: true,
        writesToAcademicTables: false,
      },
    };
  }

  async _testLtiLaunch(payload, actorUserId) {
    const config = payload.provider ? payload : (await this._getConnections(getTenantId())).lti?.config || {};
    const required = ['provider', 'clientId', 'deploymentId', 'issuer', 'jwksUrl', 'redirectUri', 'launchUrl'];
    const missing = required.filter((key) => !String(config[key] || '').trim());
    if (missing.length) {
      throw new Error(`Configuración LTI incompleta: ${missing.join(', ')}.`);
    }
    await this.recordLearningEvent({
      userId: actorUserId,
      eventType: 'lti_launch_tested',
      eventSource: 'coursev_admin',
      standardTarget: 'internal',
      eventPayload: { provider: config.provider, issuer: config.issuer },
    }, actorUserId);
    return {
      status: 'success',
      summary: `Launch LTI preparado para ${config.provider}.`,
      metrics: { provider: config.provider, launchUrl: config.launchUrl, linkedCourses: 1 },
    };
  }

  async _testGradePassback(payload) {
    return {
      status: 'success',
      summary: 'Prueba de Grade Passback registrada en auditoría. No se envió a un LMS real.',
      metrics: { score: payload.score ?? 4.5, resultUrl: payload.resultUrl || null },
    };
  }
}

export default InteroperabilityDomainService;
