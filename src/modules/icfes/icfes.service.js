import { Result } from '../../shared/Result.js';

const EXAM_SIZE = 20;
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 min

// Plan pedagógico de dificultad (requirements): 1-3 fácil, 4-10 medio,
// 11-16 escalada, 17-19 estable, 20 reto final.
const DIFFICULTY_PLAN = [
    1, 1, 2,
    2, 3, 2, 3, 3, 2, 3,
    3, 4, 3, 4, 3, 4,
    3, 4, 3,
    5,
];

function clamp01(x) { return Math.max(0, Math.min(1, x)); }

function pickByDifficulty(pool, targetDiff, used) {
    // Devuelve una pregunta del pool que esté en dificultad == target (o lo más cercano).
    const remaining = pool.filter(p => !used.has(p.id));
    if (!remaining.length) return null;
    const score = (p) => Math.abs((p.difficulty ?? 3) - targetDiff);
    remaining.sort((a, b) => score(a) - score(b) || (b.falencia ?? 0) - (a.falencia ?? 0));
    return remaining[0];
}

function selectPedagogicalOrder(candidates) {
    const used = new Set();
    const ordered = [];
    for (const d of DIFFICULTY_PLAN) {
        const q = pickByDifficulty(candidates, d, used);
        if (!q) break;
        used.add(q.id);
        ordered.push(q);
    }
    // Si faltan (banco pequeño), completar con cualquier candidato restante.
    if (ordered.length < EXAM_SIZE) {
        for (const q of candidates) {
            if (ordered.length >= EXAM_SIZE) break;
            if (!used.has(q.id)) { used.add(q.id); ordered.push(q); }
        }
    }
    return ordered.slice(0, EXAM_SIZE);
}

// Convierte fila de BD → DTO del frontend (sin exponer is_correct).
function toClientQuestion(row) {
    const sub = row.icfes_subtopics || {};
    const topic = sub.icfes_topics || {};
    const options = (row.icfes_question_options || [])
        .sort((a, b) => a.label.localeCompare(b.label))
        .map(o => ({ id: o.label, text: o.content }));
    const images = (row.icfes_question_images || [])
        .sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0))
        .map(img => ({
            id: String(img.id), position: img.position, url: img.url,
            alt: img.alt ?? undefined,
        }));
    return {
        id: String(row.id),
        area: null, // rellenado por el servicio con el código
        topic: topic.name ?? null,
        subtopic: sub.name ?? null,
        difficulty: row.difficulty,
        stem: row.stem,
        options,
        images,
    };
}

export class IcfesDomainService {
    constructor({ icfesRepository, logger = console }) {
        this.repo = icfesRepository;
        this.logger = logger;
    }

    async listAreas() {
        const rows = await this.repo.listAreas();
        return Result.ok(rows);
    }

    /**
     * Inicia una sesión de examen para un estudiante en una área ICFES.
     * @param {number} studentId
     * @param {string} areaCode  LC|MAT|SOC|CN|ING
     */
    async startSession(studentId, areaCode) {
        const area = await this.repo.findAreaByCode(String(areaCode || '').toUpperCase());
        if (!area) return Result.fail(`Área ICFES desconocida: ${areaCode}`);

        // Selección adaptativa: pool de ~60, aplicar plan pedagógico.
        const candidates = await this.repo.pickCandidateQuestions(studentId, area.id, 60);
        if (candidates.length < 4) {
            return Result.fail(`No hay preguntas disponibles para ${area.code}. Ejecuta la ingesta.`);
        }
        const picked = selectPedagogicalOrder(candidates);
        const full = await this.repo.getQuestionsFull(picked.map(q => q.id));

        // Ordenar `full` según el plan.
        const byId = new Map(full.map(r => [r.id, r]));
        const ordered = picked.map(p => byId.get(p.id)).filter(Boolean);

        const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
        const session = await this.repo.createSession({
            studentId, areaId: area.id, expiresAt,
        });
        await this.repo.bindSessionQuestions(session.id, ordered.map(q => q.id));

        const dto = {
            id: String(session.id),
            area: area.code,
            createdAt: session.started_at,
            durationSeconds: EXAM_SIZE * 35,
            questions: ordered.map(q => ({ ...toClientQuestion(q), area: area.code })),
        };
        return Result.ok(dto);
    }

    /**
     * Califica la sesión, persiste intentos y devuelve el reporte.
     * @param {number} studentId
     * @param {{ sessionId:string|number, answers:Array<{questionId:string,selected:'A'|'B'|'C'|'D'|null,timeMs:number}> }} input
     */
    async submitSession(studentId, input) {
        const sessionId = Number(input?.sessionId);
        if (!sessionId) return Result.fail('sessionId requerido');
        const session = await this.repo.findSessionForStudent(sessionId, studentId);
        if (!session) return Result.fail('Sesión no encontrada');
        if (session.status === 'completed') return Result.fail('Sesión ya fue calificada');

        const area = (await this.repo.listAreas()).find(a => a.id === session.area_id);

        const questionIds = (input.answers || []).map(a => Number(a.questionId)).filter(Boolean);
        const full = await this.repo.getQuestionsFull(questionIds);
        const byId = new Map(full.map(r => [r.id, r]));

        let correct = 0, incorrect = 0, unanswered = 0;
        const bySubtopic = new Map();
        const attemptRows = [];

        for (const ans of input.answers || []) {
            const qid = Number(ans.questionId);
            const q = byId.get(qid);
            if (!q) continue;

            const options = q.icfes_question_options || [];
            const correctOpt = options.find(o => o.is_correct);
            const selectedOpt = ans.selected
                ? options.find(o => o.label === String(ans.selected).toUpperCase())
                : null;
            const isCorrect = !!selectedOpt && selectedOpt.id === correctOpt?.id;
            const subKey = q.icfes_subtopics?.name || 'Sin clasificar';
            const row = bySubtopic.get(subKey) || { total: 0, correct: 0, time: 0 };
            row.total++;
            row.time += Number(ans.timeMs) || 0;
            if (!ans.selected) unanswered++;
            else if (isCorrect) { correct++; row.correct++; }
            else incorrect++;
            bySubtopic.set(subKey, row);

            attemptRows.push({
                student_id: studentId,
                session_id: sessionId,
                question_id: qid,
                selected_option_id: selectedOpt?.id ?? null,
                is_correct: isCorrect,
                response_time_ms: Math.max(0, Math.min(600000, Number(ans.timeMs) || 0)),
            });
        }

        await this.repo.recordAttempts(attemptRows);

        const total = attemptRows.length || questionIds.length || EXAM_SIZE;
        const grade = total ? +(10 * (correct / total)).toFixed(1) : 0;

        const breakdown = [...bySubtopic.entries()]
            .map(([subtopic, r]) => {
                const accuracy = r.total ? r.correct / r.total : 0;
                const avgTimeSec = r.total ? r.time / r.total / 1000 : 0;
                const tNorm = Math.min(1, avgTimeSec / 60);
                const falenciaScore = clamp01(0.6 * (1 - accuracy) + 0.4 * tNorm);
                const status = falenciaScore > 0.65 ? 'gap' : falenciaScore > 0.4 ? 'risk' : 'strength';
                return { subtopic, total: r.total, correct: r.correct, accuracy, falenciaScore, status };
            })
            .sort((a, b) => b.falenciaScore - a.falenciaScore);

        const recommendations = buildRecommendations(breakdown, area?.code);

        await this.repo.completeSession(sessionId, grade);

        const durationSeconds = Math.round(
            (input.answers || []).reduce((s, a) => s + (Number(a.timeMs) || 0), 0) / 1000,
        );

        const result = {
            id: `res_${sessionId}`,
            sessionId: String(sessionId),
            area: area?.code || null,
            createdAt: new Date().toISOString(),
            total, correct, incorrect, unanswered,
            grade, durationSeconds, breakdown, recommendations,
        };
        return Result.ok(result);
    }

    async getHistory(studentId) {
        const rows = await this.repo.listSessionsByStudent(studentId, 20);
        const mapped = rows.map(s => ({
            id: `res_${s.id}`,
            sessionId: String(s.id),
            area: s.icfes_areas?.code || null,
            createdAt: s.finished_at || s.started_at,
            total: 20,
            correct: Math.round(((Number(s.score) || 0) / 10) * 20),
            incorrect: 0,
            unanswered: 0,
            grade: Number(s.score) || 0,
            durationSeconds: 0,
            breakdown: [],
            recommendations: [],
        }));
        return Result.ok(mapped);
    }
}

function buildRecommendations(bd, areaCode) {
    const gaps = bd.filter(b => b.status === 'gap').slice(0, 3);
    if (!gaps.length) {
        return [
            '¡Excelente desempeño! Mantén el ritmo con sesiones semanales.',
            `Intenta una sesión con dificultad más alta en ${areaCode || 'esta área'}.`,
        ];
    }
    return gaps.map(g =>
        `Refuerza "${g.subtopic}" — ${Math.round(g.accuracy * 100)}% de aciertos. Sugerencia: teoría breve + 5 ejercicios.`,
    );
}

export default IcfesDomainService;
