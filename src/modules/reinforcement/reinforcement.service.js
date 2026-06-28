/**
 * ReinforcementDomainService — Manages reinforcement question sessions/history.
 * 
 * Uses MCPService for full persistence with:
 *   - SHA-256 hash deduplication
 *   - Embedding generation for semantic uniqueness
 *   - question_sessions + questions_history + question_options tables
 */
import { Result } from '../../shared/Result.js';
import { ForbiddenError } from '../../shared/errors/index.js';
import { QuizMathValidator } from '../../shared/math/QuizMathValidator.js';
import { OrderingQuestionValidator } from '../../shared/math/OrderingQuestionValidator.js';
import { AnswerVerificationGate } from '../../shared/math/AnswerVerificationGate.js';
import { ValidationPipeline } from '../../shared/math/ValidationPipeline.js';
import { MCPService } from '../ai/mcp-legacy.service.js';
import { RAGService } from '../ai/rag-legacy.service.js';
import { SupabaseService } from '../../shared/database/SupabaseService.js';
import { R2StorageAdapter } from '../storage/infrastructure/r2.storage.adapter.js';
import { QuestionCacheService } from './question-cache.service.js';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
let pdfParse;
try { pdfParse = require('pdf-parse'); } catch (_) { pdfParse = null; }
let mammoth;
try { mammoth = require('mammoth'); } catch (_) { mammoth = null; }
let JSZip;
try { JSZip = require('jszip'); } catch (_) { JSZip = null; }

// ─── Semaphore: máximo de llamadas LLM simultáneas en todo el proceso ───────
const MAX_CONCURRENT_LLM = 3;
let _activeLlmCalls = 0;
const _llmQueue = [];

async function withLlmSlot(fn) {
    if (_activeLlmCalls < MAX_CONCURRENT_LLM) {
        _activeLlmCalls++;
        try { return await fn(); } finally { _activeLlmCalls--; _drainLlmQueue(); }
    }
    // Encolar y esperar slot libre
    return new Promise((resolve, reject) => {
        _llmQueue.push(async () => {
            _activeLlmCalls++;
            try { resolve(await fn()); } catch (e) { reject(e); } finally { _activeLlmCalls--; _drainLlmQueue(); }
        });
    });
}
function _drainLlmQueue() {
    if (_llmQueue.length > 0 && _activeLlmCalls < MAX_CONCURRENT_LLM) {
        const next = _llmQueue.shift();
        next();
    }
}

export class ReinforcementDomainService {
    constructor({ reinforcementRepository, llmPort = null, learningContextService = null, subjectRepository = null, collaboratorRepository = null }) {
        this.reinforcementRepo = reinforcementRepository;
        this.llmPort = llmPort;
        this.learningContextService = learningContextService;
        this.subjectRepo = subjectRepository;
        this.collaboratorRepo = collaboratorRepository;
        this.REQUIRED_QUESTION_COUNT = 10;
        this.questionCache = QuestionCacheService.getInstance();
        // In-flight promises: evita llamadas LLM duplicadas para la misma clave
        this._inFlight = new Map();
        this._coachLlmUnavailableUntil = 0;
    }

    /** Setter for late injection (avoids circular constructor deps) */
    setLearningContextService(svc) {
        this.learningContextService = svc;
    }

    _normalizeRoleIds(roles = []) {
        return [...new Set((roles || [])
            .map(role => Number(role?.id ?? role))
            .filter(roleId => Number.isInteger(roleId) && roleId > 0))];
    }

    _uniquePositiveIntegers(values = []) {
        return [...new Set((values || [])
            .map(value => Number(value))
            .filter(value => Number.isInteger(value) && value > 0))];
    }

    _isAdminRole(roleIds) {
        return roleIds.includes(3) || roleIds.includes(4);
    }

    _isTeacherRole(roleIds) {
        return roleIds.includes(2);
    }

    async _getTeacherSubjectLinks(supabase, requesterId, courseId = null) {
        const numericRequesterId = Number(requesterId);
        if (!Number.isInteger(numericRequesterId) || numericRequesterId <= 0) {
            return { subjectIds: [], courseIds: [], subjects: [], courses: [] };
        }

        const { data: collaboratorRows, error: collaboratorError } = await supabase.client
            .from('subject_collaborators')
            .select('subject_id')
            .eq('user_id', numericRequesterId);

        if (collaboratorError) throw new Error(collaboratorError.message);

        const invitedSubjectIds = this._uniquePositiveIntegers((collaboratorRows || []).map(row => row.subject_id));
        if (invitedSubjectIds.length === 0) {
            return { subjectIds: [], courseIds: [], subjects: [], courses: [] };
        }

        let subjectQuery = supabase.client
            .from('subjects')
            .select('id, name, course_id')
            .in('id', invitedSubjectIds);

        const numericCourseId = Number(courseId);
        if (Number.isInteger(numericCourseId) && numericCourseId > 0) {
            subjectQuery = subjectQuery.eq('course_id', numericCourseId);
        }

        const { data: subjectRows, error: subjectsError } = await subjectQuery;
        if (subjectsError) throw new Error(subjectsError.message);

        const subjects = (subjectRows || [])
            .map(subject => ({
                id: Number(subject.id),
                name: subject.name || `Materia #${subject.id}`,
                courseId: Number(subject.course_id),
            }))
            .filter(subject => Number.isInteger(subject.id) && subject.id > 0 && Number.isInteger(subject.courseId) && subject.courseId > 0);

        const courseIds = this._uniquePositiveIntegers(subjects.map(subject => subject.courseId));
        let courses = [];
        if (courseIds.length > 0) {
            const { data: courseRows, error: coursesError } = await supabase.client
                .from('courses')
                .select('id, title')
                .in('id', courseIds);
            if (coursesError) throw new Error(coursesError.message);
            courses = (courseRows || [])
                .map(course => ({
                    id: Number(course.id),
                    title: course.title || `Curso #${course.id}`,
                }))
                .filter(course => Number.isInteger(course.id) && course.id > 0);
        }

        return {
            subjectIds: this._uniquePositiveIntegers(subjects.map(subject => subject.id)),
            courseIds,
            subjects,
            courses,
        };
    }

    async _getCourseSubjectIds(supabase, courseId) {
        const { data, error } = await supabase.client
            .from('subjects')
            .select('id')
            .eq('course_id', courseId);

        if (error) throw new Error(error.message);
        return this._uniquePositiveIntegers((data || []).map(row => row.id));
    }

    async _getTopicTaskScope(supabase, courseId, subjectIds = null) {
        const scopedSubjectIds = Array.isArray(subjectIds) && subjectIds.length > 0
            ? this._uniquePositiveIntegers(subjectIds)
            : await this._getCourseSubjectIds(supabase, courseId);

        if (scopedSubjectIds.length === 0) {
            return { subjectIds: [], topicIds: [], taskIds: [] };
        }

        const inList = `(${scopedSubjectIds.join(',')})`;
        const { data: topicRows, error: topicsError } = await supabase.client
            .from('topics')
            .select('id, materia_id, subject_id')
            .or(`materia_id.in.${inList},subject_id.in.${inList}`);

        if (topicsError) throw new Error(topicsError.message);

        const topicIds = this._uniquePositiveIntegers((topicRows || []).map(row => row.id));
        if (topicIds.length === 0) {
            return { subjectIds: scopedSubjectIds, topicIds: [], taskIds: [] };
        }

        const { data: taskRows, error: tasksError } = await supabase.client
            .from('tasks')
            .select('id, topic_id')
            .in('topic_id', topicIds);

        if (tasksError) throw new Error(tasksError.message);

        return {
            subjectIds: scopedSubjectIds,
            topicIds,
            taskIds: this._uniquePositiveIntegers((taskRows || []).map(row => row.id)),
        };
    }

    async _getRegisteredStudentIdsForSubjects(supabase, courseId, subjectIds) {
        const scopedSubjectIds = this._uniquePositiveIntegers(subjectIds);
        if (scopedSubjectIds.length === 0) return new Set();

        let query = supabase.client
            .from('progreso_materia')
            .select('usuario_estudiante')
            .in('materia_id', scopedSubjectIds);

        const numericCourseId = Number(courseId);
        if (Number.isInteger(numericCourseId) && numericCourseId > 0) {
            query = query.eq('curso_id', numericCourseId);
        }

        const { data, error } = await query;
        if (error) throw new Error(error.message);

        return new Set(this._uniquePositiveIntegers((data || []).map(row => row.usuario_estudiante)));
    }

    async _getGradedStudentIdsForTasks(supabase, taskIds) {
        const scopedTaskIds = this._uniquePositiveIntegers(taskIds);
        if (scopedTaskIds.length === 0) return new Set();

        const { data, error } = await supabase.client
            .from('task_submissions')
            .select('student_id, task_id, grade')
            .in('task_id', scopedTaskIds)
            .not('grade', 'is', null);

        if (error) throw new Error(error.message);

        return new Set(this._uniquePositiveIntegers((data || []).map(row => row.student_id)));
    }

    async getCognitiveAccess(requesterId, requesterRoles = []) {
        try {
            const roleIds = this._normalizeRoleIds(requesterRoles);
            if (this._isAdminRole(roleIds)) {
                return Result.ok({
                    canView: true,
                    scope: 'all',
                    courseIds: [],
                    subjectIds: [],
                    courses: [],
                    subjects: [],
                });
            }

            if (!this._isTeacherRole(roleIds)) {
                return Result.ok({
                    canView: false,
                    scope: 'none',
                    courseIds: [],
                    subjectIds: [],
                    courses: [],
                    subjects: [],
                });
            }

            const supabase = SupabaseService.getInstance();
            const links = await this._getTeacherSubjectLinks(supabase, requesterId);
            return Result.ok({
                canView: links.subjectIds.length > 0,
                scope: links.subjectIds.length > 0 ? 'subject_collaborator' : 'none',
                ...links,
            });
        } catch (error) {
            console.error('[CognitiveAnalytics] Access error:', error.message);
            return Result.fail(error.message);
        }
    }

    // ─── Cognitive Analytics Dashboard ────────────────────────────────────────────

    /**
     * Gets comprehensive cognitive analytics for all students in a course.
     * Returns student profiles with learning patterns, performance trends, and cognitive insights.
     */
    async getCognitiveAnalytics(courseId, options = {}) {
        try {
            const { limit = 50, offset = 0, sortBy = 'recent_activity', requesterId = null, requesterRoles = [] } = options;
            const roleIds = this._normalizeRoleIds(requesterRoles);
            const isAdmin = this._isAdminRole(roleIds);
            const isTeacher = this._isTeacherRole(roleIds);

            if (!isAdmin && !isTeacher) {
                return Result.fail(new ForbiddenError('No tienes permiso para ver el gemelo cognitivo'));
            }

            const supabase = SupabaseService.getInstance();
            let allowedSubjectIds = null;
            if (!isAdmin) {
                const links = await this._getTeacherSubjectLinks(supabase, requesterId, courseId);
                allowedSubjectIds = links.subjectIds;
                if (allowedSubjectIds.length === 0) {
                    return Result.ok({ students: [], totalStudents: 0, courseStats: null });
                }
            }

            // For admins: Get ALL reinforcement results without scope filtering
            // For teachers: Filter by their subjects
            let topicIdSet = new Set();
            let taskIdSet = new Set();
            let gradedStudentIds = new Set();
            let registeredStudentIds = null;

            if (!isAdmin) {
                // Teacher flow: strict filtering by their subjects
                const scope = await this._getTopicTaskScope(supabase, courseId, allowedSubjectIds);
                if (scope.topicIds.length === 0) {
                    return Result.ok({ students: [], totalStudents: 0, courseStats: null });
                }
                topicIdSet = new Set(scope.topicIds);
                taskIdSet = new Set(scope.taskIds);
                registeredStudentIds = await this._getRegisteredStudentIdsForSubjects(supabase, courseId, scope.subjectIds);
            }

            // 1. Get all reinforcement results for the course
            const { data: resultsData, error: resultsError } = await supabase.client
                .from('reinforcement_results')
                .select(`
                    id,
                    user_id,
                    total_questions,
                    correct_answers,
                    incorrect_answers,
                    grade,
                    difficulty,
                    duration_seconds,
                    created_at,
                    topic_id,
                    task_id
                `)
                .eq('course_id', courseId)
                .order('created_at', { ascending: false });

            if (resultsError) {
                console.error('[CognitiveAnalytics] Error fetching results:', resultsError.message);
                return Result.fail(resultsError.message);
            }

            if (!resultsData || resultsData.length === 0) {
                return Result.ok({ students: [], totalStudents: 0, courseStats: null });
            }

            const eligibleResults = resultsData.filter(result => {
                const userId = Number(result.user_id);
                const topicId = Number(result.topic_id);
                const taskId = Number(result.task_id);

                // Basic validation
                if (!Number.isInteger(userId) || userId <= 0) return false;

                // For admins: include ALL students who have reinforced
                if (isAdmin) {
                    return true;
                }

                // For teachers: filter by their subjects and registered students
                if (!Number.isInteger(topicId) || topicId <= 0 || !topicIdSet.has(topicId)) return false;
                if (Number.isInteger(taskId) && taskId > 0 && taskIdSet.size > 0 && !taskIdSet.has(taskId)) return false;
                if (registeredStudentIds && registeredStudentIds.size > 0 && !registeredStudentIds.has(userId)) return false;
                return true;
            });

            if (eligibleResults.length === 0) {
                return Result.ok({ students: [], totalStudents: 0, courseStats: null });
            }

            // 2. Group results by user
            const userResultsMap = new Map();
            for (const result of eligibleResults) {
                if (!userResultsMap.has(result.user_id)) {
                    userResultsMap.set(result.user_id, []);
                }
                userResultsMap.get(result.user_id).push(result);
            }

            // 3. Get user details for all users
            const userIds = Array.from(userResultsMap.keys());
            const { data: usersData, error: usersError } = await supabase.client
                .from('usuarios')
                .select(`
                    id,
                    username,
                    email,
                    avatar,
                    persona_id,
                    personas (
                        nombres,
                        apellidos
                    )
                `)
                .in('id', userIds);

            if (usersError) {
                console.error('[CognitiveAnalytics] Error fetching users:', usersError.message);
            }

            const usersMap = new Map();
            for (const user of usersData || []) {
                usersMap.set(user.id, user);
            }

            // 4. Build cognitive profiles for each student
            const studentProfiles = [];
            for (const [userId, results] of userResultsMap) {
                const user = usersMap.get(userId);
                if (!user) continue;

                const profile = this._buildCognitiveProfile(user, results);
                studentProfiles.push(profile);
            }

            // 5. Sort profiles
            if (sortBy === 'recent_activity') {
                studentProfiles.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));
            } else if (sortBy === 'performance') {
                studentProfiles.sort((a, b) => b.performance.accuracy - a.performance.accuracy);
            } else if (sortBy === 'sessions') {
                studentProfiles.sort((a, b) => b.performance.totalSessions - a.performance.totalSessions);
            } else if (sortBy === 'improvement') {
                studentProfiles.sort((a, b) => b.cognitiveInsights.improvementRate - a.cognitiveInsights.improvementRate);
            }

            // 6. Apply pagination
            const paginatedProfiles = studentProfiles.slice(offset, offset + limit);

            // 7. Calculate course-level stats
            const courseStats = this._calculateCourseStats(studentProfiles);

            return Result.ok({
                students: paginatedProfiles,
                totalStudents: studentProfiles.length,
                courseStats,
            });
        } catch (error) {
            console.error('[CognitiveAnalytics] Error:', error.message);
            return Result.fail(error.message);
        }
    }

    /**
     * Builds a cognitive profile for a student based on their reinforcement history.
     */
    _buildCognitiveProfile(user, results) {
        const sortedResults = [...results].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

        // Basic stats
        const totalSessions = results.length;
        const totalQuestions = results.reduce((sum, r) => sum + (r.total_questions || 0), 0);
        const totalCorrect = results.reduce((sum, r) => sum + (r.correct_answers || 0), 0);
        const totalIncorrect = results.reduce((sum, r) => sum + (r.incorrect_answers || 0), 0);
        const totalDuration = results.reduce((sum, r) => sum + (r.duration_seconds || 0), 0);
        const accuracy = totalQuestions > 0 ? Math.round((totalCorrect / totalQuestions) * 100) : 0;

        // Calculate grades in chronological order so recent-vs-previous trends are real.
        const grades = sortedResults.map(r => parseFloat(r.grade || 0)).filter(g => !isNaN(g));
        const avgGrade = grades.length > 0
            ? Math.round(grades.reduce((a, b) => a + b, 0) / grades.length * 10) / 10
            : 0;

        // Performance trend (comparing recent 5 vs previous 5)
        let trend = 'stable';
        let improvementRate = 0;
        if (grades.length >= 6) {
            const recentGrades = grades.slice(-5);
            const previousGrades = grades.slice(-10, -5);
            const recentAvg = recentGrades.reduce((a, b) => a + b, 0) / recentGrades.length;
            const previousAvg = previousGrades.reduce((a, b) => a + b, 0) / previousGrades.length;
            improvementRate = Math.round((recentAvg - previousAvg) * 10) / 10;

            if (improvementRate > 0.5) trend = 'improving';
            else if (improvementRate < -0.5) trend = 'declining';
        }

        // Skill level
        let skillLevel = 'beginner';
        let skillColor = '#FF6B6B';
        if (accuracy >= 85) { skillLevel = 'advanced'; skillColor = '#51CF66'; }
        else if (accuracy >= 70) { skillLevel = 'intermediate'; skillColor = '#339AF0'; }
        else if (accuracy >= 50) { skillLevel = 'developing'; skillColor = '#FAB005'; }

        // Study patterns
        const studyHours = sortedResults.map(r => new Date(r.created_at).getHours());
        const hourCounts = {};
        studyHours.forEach(h => { hourCounts[h] = (hourCounts[h] || 0) + 1; });
        const preferredHour = Object.entries(hourCounts)
            .sort((a, b) => b[1] - a[1])[0]?.[0] || null;

        // Difficulty preference
        const difficultyStats = {};
        results.forEach(r => {
            const diff = r.difficulty || 'HARD';
            if (!difficultyStats[diff]) difficultyStats[diff] = { total: 0, correct: 0 };
            difficultyStats[diff].total += r.total_questions || 0;
            difficultyStats[diff].correct += r.correct_answers || 0;
        });

        // Average response time per question
        const avgTimePerQuestion = totalQuestions > 0
            ? Math.round(totalDuration / totalQuestions)
            : 0;

        const errorRate = totalQuestions > 0
            ? Math.round((totalIncorrect / totalQuestions) * 100)
            : 0;

        const preferredDifficulty = Object.entries(difficultyStats)
            .sort((a, b) => b[1].total - a[1].total)[0]?.[0] || null;

        // Consistency score (standard deviation of grades)
        let consistency = 100;
        if (grades.length >= 3) {
            const mean = grades.reduce((a, b) => a + b, 0) / grades.length;
            const variance = grades.reduce((sum, g) => sum + Math.pow(g - mean, 2), 0) / grades.length;
            const stdDev = Math.sqrt(variance);
            consistency = Math.max(0, Math.round(100 - stdDev * 2));
        }

        // Engagement score
        const daysSinceLastActivity = Math.floor(
            (Date.now() - new Date(results[0]?.created_at || Date.now()).getTime()) / (1000 * 60 * 60 * 24)
        );
        let engagementLevel = 'high';
        if (daysSinceLastActivity > 14) engagementLevel = 'low';
        else if (daysSinceLastActivity > 7) engagementLevel = 'medium';

        const lateSessions = studyHours.filter(h => h >= 21 || h < 6).length;
        const lateSessionRatio = studyHours.length > 0 ? lateSessions / studyHours.length : 0;
        const fatigueRiskScore = Math.min(100, Math.round(
            (lateSessionRatio * 42) +
            (avgTimePerQuestion > 75 ? 28 : avgTimePerQuestion > 45 ? 16 : 4) +
            (trend === 'declining' ? 22 : trend === 'stable' ? 8 : 0) +
            (errorRate > 45 ? 16 : errorRate > 30 ? 8 : 0)
        ));
        const fatigueLevel = fatigueRiskScore >= 68 ? 'high' : fatigueRiskScore >= 38 ? 'medium' : 'low';

        let performanceStatus = 'steady';
        if (accuracy >= 80 && avgGrade >= 8 && trend !== 'declining') {
            performanceStatus = 'strong';
        } else if (accuracy < 60 || avgGrade < 6 || trend === 'declining') {
            performanceStatus = 'needs_support';
        }

        const recommendedAction = this._buildCognitiveRecommendation({
            performanceStatus,
            fatigueLevel,
            preferredHour: preferredHour ? parseInt(preferredHour) : null,
            preferredDifficulty,
            avgTimePerQuestion,
            errorRate,
        });

        // Build history for chart (last 10 sessions)
        const recentHistory = sortedResults.slice(-10).map(r => ({
            date: r.created_at,
            grade: parseFloat(r.grade || 0),
            accuracy: r.total_questions > 0
                ? Math.round((r.correct_answers / r.total_questions) * 100)
                : 0,
            questions: r.total_questions || 0,
        }));

        return {
            id: user.id,
            username: user.username,
            email: user.email,
            avatar: user.avatar,
            fullName: user.personas
                ? `${user.personas.nombres || ''} ${user.personas.apellidos || ''}`.trim()
                : user.username,
            firstName: user.personas?.nombres || user.username,
            lastName: user.personas?.apellidos || '',

            // Performance metrics
            performance: {
                accuracy,
                avgGrade,
                totalQuestions,
                totalCorrect,
                totalIncorrect,
                totalSessions,
                totalDuration,
                avgTimePerQuestion,
            },

            // Cognitive insights
            cognitiveInsights: {
                skillLevel,
                skillColor,
                trend,
                improvementRate,
                consistency,
                engagementLevel,
                preferredStudyHour: preferredHour ? parseInt(preferredHour) : null,
                difficultyStats,
                errorRate,
                preferredDifficulty,
                fatigueRiskScore,
                fatigueLevel,
                performanceStatus,
                recommendedAction,
            },

            // Activity data
            lastActivity: results[0]?.created_at || null,
            daysSinceLastActivity,
            recentHistory,

            // Metadata
            firstSession: sortedResults[0]?.created_at || null,
        };
    }

    _buildCognitiveRecommendation({
        performanceStatus,
        fatigueLevel,
        preferredHour,
        preferredDifficulty,
        avgTimePerQuestion,
        errorRate,
    }) {
        const hourText = Number.isInteger(preferredHour)
            ? `${String(preferredHour).padStart(2, '0')}:00`
            : 'su horario de mayor actividad';
        const difficultyText = preferredDifficulty ? String(preferredDifficulty).toLowerCase() : 'su nivel actual';

        if (performanceStatus === 'strong') {
            return `Va bien: mantener retos ${difficultyText} cerca de ${hourText} y subir complejidad de forma gradual.`;
        }

        if (fatigueLevel === 'high') {
            return `Riesgo de fatiga: dividir sesiones, bajar carga textual y reforzar con ejemplos visuales cerca de ${hourText}.`;
        }

        if (errorRate >= 45) {
            return `Necesita apoyo: revisar patrones de error antes de aumentar dificultad y usar retroalimentacion paso a paso.`;
        }

        if (avgTimePerQuestion >= 75) {
            return `Respuesta lenta: priorizar ejercicios cortos, pistas tempranas y pausas entre bloques.`;
        }

        return `En progreso: mantener practica guiada en ${difficultyText} y observar la proxima tendencia.`;
    }

    /**
     * Calculates course-level statistics from all student profiles.
     */
    _calculateCourseStats(profiles) {
        if (profiles.length === 0) return null;

        const totalStudents = profiles.length;
        const avgAccuracy = Math.round(
            profiles.reduce((sum, p) => sum + p.performance.accuracy, 0) / totalStudents
        );
        const avgGrade = Math.round(
            profiles.reduce((sum, p) => sum + p.performance.avgGrade, 0) / totalStudents * 10
        ) / 10;

        const skillDistribution = {
            advanced: profiles.filter(p => p.cognitiveInsights.skillLevel === 'advanced').length,
            intermediate: profiles.filter(p => p.cognitiveInsights.skillLevel === 'intermediate').length,
            developing: profiles.filter(p => p.cognitiveInsights.skillLevel === 'developing').length,
            beginner: profiles.filter(p => p.cognitiveInsights.skillLevel === 'beginner').length,
        };

        const trendDistribution = {
            improving: profiles.filter(p => p.cognitiveInsights.trend === 'improving').length,
            stable: profiles.filter(p => p.cognitiveInsights.trend === 'stable').length,
            declining: profiles.filter(p => p.cognitiveInsights.trend === 'declining').length,
        };

        const engagementDistribution = {
            high: profiles.filter(p => p.cognitiveInsights.engagementLevel === 'high').length,
            medium: profiles.filter(p => p.cognitiveInsights.engagementLevel === 'medium').length,
            low: profiles.filter(p => p.cognitiveInsights.engagementLevel === 'low').length,
        };

        const performanceStatusDistribution = {
            strong: profiles.filter(p => p.cognitiveInsights.performanceStatus === 'strong').length,
            steady: profiles.filter(p => p.cognitiveInsights.performanceStatus === 'steady').length,
            needs_support: profiles.filter(p => p.cognitiveInsights.performanceStatus === 'needs_support').length,
        };

        const fatigueDistribution = {
            high: profiles.filter(p => p.cognitiveInsights.fatigueLevel === 'high').length,
            medium: profiles.filter(p => p.cognitiveInsights.fatigueLevel === 'medium').length,
            low: profiles.filter(p => p.cognitiveInsights.fatigueLevel === 'low').length,
        };

        const totalQuestions = profiles.reduce((sum, p) => sum + p.performance.totalQuestions, 0);
        const totalSessions = profiles.reduce((sum, p) => sum + p.performance.totalSessions, 0);

        return {
            totalStudents,
            avgAccuracy,
            avgGrade,
            totalQuestions,
            totalSessions,
            skillDistribution,
            trendDistribution,
            engagementDistribution,
            performanceStatusDistribution,
            fatigueDistribution,
        };
    }

    logQuestionBatch(label, questions, context = {}) {
        if (!Array.isArray(questions)) {
            console.log(`[ReinforcementDomainService] ${label}: questions payload is not an array`);
            return;
        }

        const contextSummary = Object.entries(context)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => `${key}=${value ?? 'null'}`)
            .join(', ');

        console.log(
            `🧠 [ReinforcementDomainService] ${label}: totalQuestions=${questions.length}` +
            `${contextSummary ? `, ${contextSummary}` : ''}`
        );

        questions.forEach((item, questionIndex) => {
            const questionText = String(item?.question || '').trim() || '(sin texto de pregunta)';
            const type = String(item?.type || 'multiple_choice').trim().toLowerCase();

            console.log(`   Q${questionIndex + 1}: ${questionText}`);

            if (type === 'fill_in_blank') {
                const correctAnswer = String(item?.correctAnswer || item?.correct_answer || '').trim();
                const hint = String(item?.hint || '').trim();
                console.log(`      [fill_in_blank] respuesta="${correctAnswer}"${hint ? `, pista="${hint}"` : ''}`);
                return;
            }

            if (type === 'ordering') {
                const items = Array.isArray(item?.items) ? item.items : [];
                const correctOrder = Array.isArray(item?.correctOrder) ? item.correctOrder : [];
                console.log(`      [ordering] items=${items.length}, correctOrder=[${correctOrder.join(',')}]`);
                items.forEach((it, idx) => {
                    console.log(`        (${idx}) ${String(it || '').trim()}`);
                });
                return;
            }

            // multiple_choice
            const options = Array.isArray(item?.options) ? item.options : [];
            const correctIndex = Number.isInteger(item?.correctIndex) ? item.correctIndex : null;

            if (options.length === 0) {
                console.log(`      [${type}] opciones: (sin opciones)`);
                return;
            }

            options.forEach((option, optionIndex) => {
                const marker = correctIndex === optionIndex ? '[correcta]' : '[opcion]';
                console.log(`      ${marker} (${optionIndex}) ${String(option || '').trim()}`);
            });
        });
    }

    /**
     * Ensure content for a task/topic is ingested into RAG (rag_documents).
     * If missing, fetches from content_items and ingests.
     */
    async ensureContentIngested(courseId, taskId, topicId = null) {
        try {
            const ragService = new RAGService();
            const supabase = SupabaseService.getInstance();
            
            // ⛔ NO hacer check a nivel task — si un content_item fue ingresado
            // pero se agregó otro archivo después, el check task-level bloquearía
            // la ingesta del nuevo archivo. ingestDocument() verifica por contentItemId.

            console.log(`📝 [ReinforcementService] Checking RAG ingestion for Task ${taskId}. Fetching content_items...`);

            // 2. Fetch source content from content_items
            // Also fetch items linked to the topic (not just task) so ALL relevant files are ingested
            let queryBuilder = supabase.client
                .from('content_items')
                .select('*');
            
            if (taskId && topicId) {
                // Fetch items for BOTH task AND topic
                queryBuilder = queryBuilder.or(`task_id.eq.${taskId},topic_id.eq.${topicId}`);
            } else if (taskId) {
                queryBuilder = queryBuilder.eq('task_id', taskId);
            } else if (topicId) {
                queryBuilder = queryBuilder.eq('topic_id', topicId);
            }

            const { data: items, error } = await queryBuilder;

            if (error) throw error;

            if (!items || items.length === 0) {
                return Result.ok({ message: 'No content_items found for this task/topic', ingested: false });
            }

            let ingestedCount = 0;
            let r2Service = null;

            // 3. Ingest each item (handles both plain text and URL-based content)
            for (const item of items) {
                const body = (item.body || '').trim();
                const fileName = item.title || `content_${item.id}`;
                const isUrl = body.startsWith('http://') || body.startsWith('https://');
                const effectiveTopicId = topicId || item.topic_id;
                let textToIngest = null;

                if (!body || body.length < 10) continue;

                if (isUrl) {
                    // Download file content from URL
                    try {
                        if (!r2Service) r2Service = new R2StorageAdapter();
                        const fileData = await r2Service.getSubmissionFileContent(body, fileName);
                        if (!fileData || !fileData.content) {
                            console.warn(`[ReinforcementService] No content from download: ${fileName}`);
                            continue;
                        }

                        // Derive actual filename from URL path (item.title may lack extension)
                        let urlFileName = fileName;
                        try {
                            const urlPath = new URL(body).pathname;
                            const urlBase = decodeURIComponent(urlPath.split('/').pop() || '');
                            if (urlBase && urlBase.includes('.')) urlFileName = urlBase;
                        } catch (_) { /* keep original fileName */ }

                        const nameLower = (urlFileName || fileName).toLowerCase();
                        const ctLower = (fileData.contentType || '').toLowerCase();
                        const isPdf = nameLower.endsWith('.pdf') || ctLower.includes('pdf');
                        const isDocx = nameLower.endsWith('.docx') || nameLower.endsWith('.doc') ||
                            ctLower.includes('wordprocessingml') ||
                            ctLower.includes('openxmlformats') ||
                            ctLower.includes('msword');

                        const isPptx = nameLower.endsWith('.pptx') || nameLower.endsWith('.ppt') ||
                            ctLower.includes('presentationml') || ctLower.includes('powerpoint');

                        // Magic-byte detection: if content is binary, check ZIP header (docx/xlsx/pptx are ZIP)
                        const isDocxFinal = isDocx || (
                            fileData.buffer &&
                            fileData.buffer[0] === 0x50 && fileData.buffer[1] === 0x4B &&
                            fileData.buffer[2] === 0x03 && fileData.buffer[3] === 0x04 &&
                            !nameLower.endsWith('.xlsx') && !nameLower.endsWith('.pptx')
                        );

                        if (isPdf && pdfParse) {
                            try {
                                const pdfBuffer = fileData.buffer || Buffer.from(fileData.content, fileData.isBase64 ? 'base64' : 'utf-8');
                                const pdfData = await pdfParse(pdfBuffer);
                                textToIngest = pdfData.text;
                                if (!textToIngest || textToIngest.trim().length < 50) textToIngest = null;
                            } catch (pdfErr) {
                                console.warn(`[ReinforcementService] PDF parse error for ${fileName}: ${pdfErr.message}`);
                            }
                        } else if (isPptx && JSZip) {
                            try {
                                const buffer = fileData.buffer || Buffer.from(fileData.content, fileData.isBase64 ? 'base64' : 'binary');
                                const zip = await JSZip.loadAsync(buffer);
                                const slideEntries = Object.keys(zip.files)
                                    .filter(name => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
                                    .sort((a, b) => {
                                        const numA = parseInt(a.match(/(\d+)/)?.[1] || '0', 10);
                                        const numB = parseInt(b.match(/(\d+)/)?.[1] || '0', 10);
                                        return numA - numB;
                                    });
                                const slideTexts = [];
                                for (const entry of slideEntries) {
                                    const xml = await zip.files[entry].async('text');
                                    const matches = xml.match(/<a:t[^>]*>([^<]*)<\/a:t>/g) || [];
                                    const texts = matches.map(m => m.replace(/<[^>]+>/g, '').trim()).filter(Boolean);
                                    if (texts.length > 0) slideTexts.push(texts.join(' '));
                                }
                                textToIngest = slideTexts.join('\n\n');
                                if (!textToIngest || textToIngest.trim().length < 50) textToIngest = null;
                                console.log(`[ReinforcementService] PPTX extracted ${textToIngest?.length ?? 0} chars from "${urlFileName}"`);
                            } catch (pptxErr) {
                                console.warn(`[ReinforcementService] PPTX parse error for ${fileName}: ${pptxErr.message}`);
                            }
                        } else if (isDocxFinal && mammoth) {
                            try {
                                const buffer = fileData.buffer || Buffer.from(fileData.content, fileData.isBase64 ? 'base64' : 'binary');
                                const docxResult = await mammoth.extractRawText({ buffer });
                                textToIngest = docxResult.value;
                                if (!textToIngest || textToIngest.trim().length < 50) textToIngest = null;
                                console.log(`[ReinforcementService] DOCX extracted ${textToIngest?.length ?? 0} chars from "${urlFileName}"`);
                            } catch (docxErr) {
                                console.warn(`[ReinforcementService] DOCX parse error for ${fileName}: ${docxErr.message}`);
                            }
                        } else if (!fileData.isBase64) {
                            // Safety guard: reject content that looks like binary garbage
                            const sample = (fileData.content || '').substring(0, 500);
                            const controlChars = (sample.match(/[\x00-\x08\x0E-\x1F\x7F]/g) || []).length;
                            if (controlChars > sample.length * 0.05) {
                                console.warn(`[ReinforcementService] Skipping binary content disguised as text: ${urlFileName} (${controlChars} control chars)`);
                                continue;
                            }
                            textToIngest = fileData.content;
                        }
                    } catch (dlErr) {
                        console.warn(`[ReinforcementService] Download error for ${fileName}: ${dlErr.message}`);
                    }
                } else {
                    // Body is plain text content — guard against binary/Office XML garbage
                    if (this._looksLikeBinaryOrOfficeXml(body)) {
                        console.warn(`[ReinforcementService] Skipping binary/Office-XML body for content_item ${item.id} (${fileName})`);
                    } else {
                        textToIngest = body;
                    }
                }

                if (textToIngest && textToIngest.length >= 50) {
                    console.log(`💾 Ingesting content_item ${item.id} (${fileName}) into RAG...`);

                    await ragService.ingestDocument(textToIngest, {
                        courseId: courseId,
                        taskId: taskId,
                        topicId: effectiveTopicId,
                        contentItemId: item.id,
                        fileName,
                        fileType: 'txt'
                    });
                    ingestedCount++;
                }
            }

            return Result.ok({ 
                success: true, 
                message: `Ingested ${ingestedCount} content items into RAG`, 
                ingested: true,
                count: ingestedCount 
            });

        } catch (error) {
            console.error('[ReinforcementService] Ingestion error:', error);
            // Non-blocking failure, return fail result but don't crash
            return Result.fail(error);
        }
    }

    /**
     * Save a full question session with uniqueness validation.
     * Delegates to MCPService.saveReinforcementHistory() which handles:
     *   - Session creation in question_sessions
     *   - Hash + semantic dedup in questions_history  
     *   - Option embedding storage in question_options
     */
    async saveSession(data) {
        const { userId, courseId, topicId, taskId, questions } = data;

        // Parse questions if they come as a string
        let parsedQuestions = questions;
        if (typeof questions === 'string') {
            try {
                parsedQuestions = JSON.parse(questions);
            } catch (e) {
                console.warn('[ReinforcementDomainService] Failed to parse questions string:', e.message);
                parsedQuestions = [];
            }
        }

        this.logQuestionBatch('respuestas mostradas en ReinforcementLearningScreen.kt', parsedQuestions, {
            userId,
            courseId,
            topicId,
            taskId,
        });

        // If we have questions, use MCPService for full embedding + uniqueness flow
        if (Array.isArray(parsedQuestions) && parsedQuestions.length > 0) {
            try {
                const mcpService = new MCPService();
                const saveResult = await mcpService.saveReinforcementHistory(
                    userId,
                    courseId,
                    parsedQuestions,
                    topicId || null,
                    taskId || null
                );

                const savedCount = saveResult?.savedCount || 0;
                const cumulativeCount = saveResult?.cumulativeCount || savedCount;
                const requiredCount = saveResult?.requiredCount || this.REQUIRED_QUESTION_COUNT;
                const isComplete = cumulativeCount >= requiredCount;

                let accumulatedQuestions = [];
                try {
                    const allHistory = await mcpService.getReinforcementHistory(userId, courseId, topicId, taskId);
                    accumulatedQuestions = (allHistory || []).map(h => ({
                        question: h.question || '',
                        options: h.options || [],
                        correctIndex: h.answer_index ?? 0,
                        explanation: h.explanation || '',
                    }));
                } catch (_) { /* non-blocking */ }

                if (saveResult && isComplete) {
                    const finalQuestions = accumulatedQuestions.slice(0, requiredCount);
                    console.log(`✅ [ReinforcementDomainService] ACUMULACIÓN COMPLETA: ${cumulativeCount}/${requiredCount} preguntas únicas. savedThisBatch=${savedCount}, duplicates=${parsedQuestions.length - savedCount}`);
                    this.logQuestionBatch(
                        `LOTE COMPLETO — ${finalQuestions.length} preguntas únicas acumuladas`,
                        finalQuestions,
                        { userId, courseId, topicId, taskId }
                    );
                    return Result.ok({
                        success: true,
                        savedCount,
                        cumulativeCount,
                        duplicateCount: (parsedQuestions.length - savedCount),
                        totalSubmitted: parsedQuestions.length,
                        requiredCount,
                        accumulatedQuestions: finalQuestions,
                        message: `Lote completo: ${cumulativeCount} preguntas únicas acumuladas`
                    });
                } else {
                    const shortfall = Math.max(requiredCount - cumulativeCount, 0);
                    console.log(`🔄 [ReinforcementDomainService] ACUMULACIÓN PARCIAL: ${savedCount} nuevas guardadas, ${cumulativeCount}/${requiredCount} acumuladas. Faltan ${shortfall}. duplicates=${parsedQuestions.length - savedCount}`);
                    return Result.ok({
                        success: false,
                        savedCount,
                        cumulativeCount,
                        duplicateCount: (parsedQuestions.length - savedCount),
                        totalSubmitted: parsedQuestions.length,
                        requiredCount,
                        shortfall: Math.max(requiredCount - cumulativeCount, 0),
                        allDuplicates: savedCount === 0,
                        needsRegeneration: true,
                        existingQuestions: accumulatedQuestions,
                        message: `Guardadas ${savedCount} este ciclo, ${cumulativeCount}/${requiredCount} acumuladas. Faltan ${Math.max(requiredCount - cumulativeCount, 0)}.`
                    });
                }
            } catch (e) {
                console.error('[ReinforcementDomainService] MCPService save error:', e.message);
                // Fallback: create session only
                const session = await this.reinforcementRepo.saveSession({ userId, courseId, topicId, taskId });
                return Result.ok({ ...session, savedCount: 0, message: 'Session created, questions save failed' });
            }
        }

        // No questions provided — just create session
        const session = await this.reinforcementRepo.saveSession({ userId, courseId, topicId, taskId });
        return Result.ok(session);
    }

    /**
     * Get existing questions for a user+course filtered by topic/task.
     * Returns full question objects (text, options, correctIndex, explanation)
     * so the client can use them for deduplication before generating new ones.
     */
    async getExistingQuestions(userId, courseId, topicId = null, taskId = null) {
        try {
            const mcpService = new MCPService();
            const history = await mcpService.getReinforcementHistory(userId, courseId, topicId, taskId);

            if (!Array.isArray(history) || history.length === 0) {
                console.log(
                    `🧠 [ReinforcementDomainService] getExistingQuestions: totalQuestions=0, userId=${userId}, courseId=${courseId}, topicId=${topicId ?? 'null'}, taskId=${taskId ?? 'null'}`
                );
                return Result.ok({ questions: [], count: 0 });
            }

            // Return structured question objects for client-side dedup
            const questions = history.map(h => ({
                question: h.question || '',
                options: h.options || [],
                correctIndex: h.answer_index ?? 0,
                explanation: h.explanation || '',
            }));

            this.logQuestionBatch('getExistingQuestions returning questions', questions, {
                userId,
                courseId,
                topicId,
                taskId,
            });

            return Result.ok({ questions, count: questions.length });
        } catch (error) {
            console.error('[ReinforcementDomainService] getExistingQuestions error:', error.message);
            return Result.ok({ questions: [], count: 0 });
        }
    }

    /**
     * Retrieve all raw text content from rag_documents for a task/topic/course.
     * Used by the client to build RAG-grounded prompts that prevent hallucination.
     * @param {number} courseId
     * @param {number|null} topicId
     * @param {number|null} taskId
     * @returns {Promise<Result>} { content: string, chunks: number, files: string[] }
     */
    async getRagContent(courseId, topicId = null, taskId = null) {
        try {
            const ragService = new RAGService();
            const filter = { courseId };
            if (topicId) filter.topicId = topicId;
            if (taskId) filter.taskId = taskId;

            const result = await ragService.getRagContent(filter);
            return Result.ok(result);
        } catch (error) {
            console.error('[ReinforcementDomainService] getRagContent error:', error.message);
            return Result.ok({ content: '', chunks: 0, files: [] });
        }
    }

    async coachConversation({ userId = null, courseId, topicId = null, taskId = null, difficulty = 'HARD', message, history = [], conversational = true, voiceMode = false, personality = 'playful_critic' }) {
        try {
            if (!this.llmPort || !this.learningContextService) {
                return Result.fail('LLM or LearningContextService not available for reinforcement coach');
            }

            const rawMessage = String(message || '').trim();
            const isVoiceStarter = rawMessage === '__VOICE_START__';

            const contextResult = await this.learningContextService.buildLearningContext({
                courseId,
                topicId,
                taskId,
                userId,
                query: isVoiceStarter ? null : rawMessage,
                retrievalMode: 'hybrid',
            });

            if (contextResult.isFail()) {
                return Result.fail(contextResult.getError());
            }

            const ctx = contextResult.getValue();
            const topicName = ctx.topic?.name || '';
            const taskName = ctx.task?.title || '';
            const ragContent = String(ctx.ragContent || '').slice(0, 14000);
            const contextBlock = this._buildContextBlock(
                topicName,
                ctx.topic?.description,
                taskName,
                ctx.task?.description,
                ragContent,
                ctx.ragFiles || []
            );

            const compactHistory = this._compactCoachHistory(history);
            const systemPrompt = this._buildCoachSystemPrompt(difficulty, isVoiceStarter, { conversational, voiceMode, personality });
            const userPrompt = this._buildCoachUserPrompt({
                contextBlock,
                message: rawMessage,
                history: compactHistory,
                topicName,
                taskName,
                isVoiceStarter,
                voiceMode,
            });

            let parsed;
            let fallbackMode = false;
            let providerError = null;
            try {
                if (Date.now() < this._coachLlmUnavailableUntil) {
                    throw new Error('Coach LLM temporarily disabled after provider authentication/balance failure');
                }
                const response = await withLlmSlot(() =>
                    this.llmPort.chat(systemPrompt, userPrompt, {
                        temperature: 0.55,
                        maxTokens: 1600,
                    })
                );
                parsed = this._parseCoachResponse(response?.content || '');
            } catch (llmError) {
                providerError = llmError?.message || 'LLM provider unavailable';
                fallbackMode = true;
                if (this._isProviderConfigOrBillingError(providerError)) {
                    this._coachLlmUnavailableUntil = Date.now() + 5 * 60 * 1000;
                }
                console.warn('[ReinforcementService] coachConversation LLM unavailable; using local fallback:', providerError);
                parsed = this._buildCoachFallbackResponse({
                    isVoiceStarter,
                    message: rawMessage,
                    history: compactHistory,
                    topicName,
                    topicDesc: ctx.topic?.description,
                    taskName,
                    taskDesc: ctx.task?.description,
                    ragContent,
                });
            }
            const sourceFiles = Array.isArray(ctx.ragFiles) ? ctx.ragFiles.slice(0, 5) : [];

            return Result.ok({
                ...parsed,
                fallbackMode,
                providerError: fallbackMode ? providerError : undefined,
                sourceFiles,
                context: {
                    topicName,
                    taskName,
                    ragChunks: ctx.ragChunks || 0,
                    retrievalMode: ctx.retrievalMode || 'hybrid',
                    contentItems: ctx.contentItems?.length || 0,
                },
            });
        } catch (error) {
            console.error('[ReinforcementService] coachConversation error:', error.message);
            return Result.fail(error.message || 'Coach conversation failed');
        }
    }

    _isProviderConfigOrBillingError(message = '') {
        return /(401|402|authentication|unauthorized|user not found|insufficient balance|api key|invalid key|billing|saldo|balance|circuit)/i.test(String(message || ''));
    }

    _buildCoachFallbackResponse({
        isVoiceStarter = false,
        message = '',
        history = [],
        topicName = '',
        topicDesc = '',
        taskName = '',
        taskDesc = '',
        ragContent = '',
    } = {}) {
        const subject = [topicName, taskName].filter(Boolean).join(' / ') || 'este tema';
        const seed = this._pickCoachFallbackSeed({ topicName, topicDesc, taskName, taskDesc, ragContent });
        const previousQuestion = [...history].reverse().find(item => item.question)?.question || '';

        const playfulStarters = [
            '¡Hola! Vamos a aprender algo cool hoy.',
            '¡Buenas! Listo para activar esas neuronas?',
            '¡Ey! Preparate que vamos a pensar un poco.',
            '¡Hola! Modo aprendizaje activado.',
        ];

        if (isVoiceStarter) {
            return {
                stance: 'partial',
                reply: playfulStarters[Math.floor(Math.random() * playfulStarters.length)],
                critique: '',
                question: this._sanitizeOpenCoachQuestion(
                    `Empecemos facil: que es ${subject} segun tu? Explicamelo como si yo no supiera nada.`,
                    `Que entiendes de ${subject} con tus palabras?`
                ),
                confidence: 0.25,
            };
        }

        const normalizedMessage = String(message || '').trim();
        const shortAnswer = normalizedMessage
            ? this._shortenFallbackText(normalizedMessage, 180)
            : 'lo que acabas de decir';

        const playfulReplies = [
            `Mmm, veo por donde vas con eso de "${shortAnswer}", pero creo que hay algo que se te esta escapando.`,
            `Interesante lo que dices sobre "${shortAnswer}". No esta mal, pero le falta un poquito mas.`,
            `Ok, entiendo tu punto sobre "${shortAnswer}". Pero dejame preguntarte algo para que lo pienses mejor.`,
            `Vas bien encaminado con eso de "${shortAnswer}", aunque hay un detalle que podrias pulir.`,
        ];

        const playfulCritiques = [
            `Lo que mencionas tiene sentido, pero seria mas fuerte si lo conectas con un ejemplo concreto de ${subject}.`,
            `Tu idea va por buen camino. El tema es: ¿como lo aplicarias en una situacion real?`,
            `Eso que dices es un buen inicio. Ahora, ¿podrias explicar por que funciona asi?`,
        ];

        return {
            stance: 'partial',
            reply: playfulReplies[Math.floor(Math.random() * playfulReplies.length)],
            critique: playfulCritiques[Math.floor(Math.random() * playfulCritiques.length)],
            question: this._sanitizeOpenCoachQuestion(
                `Dame un ejemplo de la vida real donde veas esto de ${subject} en accion. ¿Donde lo usarias?`,
                `¿Podrias darme un ejemplo practico de esto?`
            ),
            confidence: 0.25,
        };
    }

    _pickCoachFallbackSeed({ topicName = '', topicDesc = '', taskName = '', taskDesc = '', ragContent = '' } = {}) {
        const seeds = this._extractFallbackQuestionSeeds({ topicName, topicDesc, taskName, taskDesc, ragContent });
        return this._shortenFallbackText(seeds[0] || taskDesc || topicDesc || taskName || topicName || 'el material del curso', 150);
    }

    _compactCoachHistory(history = []) {
        return (Array.isArray(history) ? history : [])
            .slice(-8)
            .map(item => ({
                role: item.role === 'assistant' ? 'assistant' : 'user',
                content: String(item.content || '').slice(0, 1000),
                stance: item.stance ? String(item.stance).slice(0, 24) : undefined,
                question: item.question ? String(item.question).slice(0, 500) : undefined,
            }))
            .filter(item => item.content.trim().length > 0);
    }

    _buildCoachSystemPrompt(difficulty = 'HARD', isVoiceStarter = false, options = {}) {
        const { conversational = true, voiceMode = false, personality = 'playful_critic' } = options;

        const personalityGuide = {
            playful_critic: `Tu personalidad: eres como ese amigo listo que te ayuda a estudiar pero con humor. Puedes bromear cuando te equivocas ("Uy, casi... pero no, jaja"), pero siempre explicando bien por que esta mal. Eres sarcastico pero carinoso, como un hermano mayor que quiere que aprendas de verdad. NUNCA insultas ni humillas, solo te burlas suavemente de la IDEA, no de la persona.`,
            strict: `Tu personalidad: eres exigente pero justo. Corriges directamente cuando hay errores pero siempre explicas el por que. No haces chistes pero tampoco eres frio.`,
            friendly: `Tu personalidad: eres super amigable y motivador. Celebras los aciertos y cuando hay errores, los conviertes en oportunidades de aprendizaje sin drama.`,
        };

        const voiceModeGuide = voiceMode
            ? `MODO VOZ ACTIVADO:
- Habla como si estuvieras en persona, de forma natural y fluida.
- Usa frases cortas y directas, faciles de escuchar.
- Evita listas largas o explicaciones muy tecnicas.
- Si el estudiante dice "repiteme" o "no entendi", reformula tu respuesta de forma mas simple.
- Tus respuestas deben sonar como una conversacion real, no como un texto escrito.`
            : '';

        const conversationalGuide = conversational
            ? `MODO CONVERSACIONAL:
- NO uses preguntas de opcion multiple. Prohibido A/B/C/D, "elige", "selecciona", "cual de las siguientes".
- Habla de forma natural, como un tutor en persona.
- Usa ejemplos de la vida real para explicar conceptos tecnicos.
- Si el estudiante usa terminos incorrectos, primero reconoce lo que quiso decir y luego corrige.
- Evita jerga tecnica innecesaria. Si usas un termino tecnico, explicalo con palabras simples.`
            : '';

        return `Eres un tutor de refuerzo academico en espanol, especializado en hacer que el aprendizaje sea INTERACTIVO y DIVERTIDO.

${personalityGuide[personality] || personalityGuide.playful_critic}

${voiceModeGuide}

${conversationalGuide}

REGLAS DE ORO:
1. SIEMPRE RESPONDE a lo que dice el estudiante. No ignores su respuesta.
2. Si se equivoca, EXPLICA por que esta mal de forma clara y con ejemplos simples.
3. Si acierta (aunque sea parcialmente), RECONOCELO antes de profundizar.
4. Usa analogias de la vida cotidiana: "Es como cuando...", "Imaginate que..."
5. Haz UNA sola pregunta al final, clara y directa. Nada de opciones A/B/C/D.
6. Si el tema es tecnico (programacion, matematicas, etc.), explicalo como si fuera para alguien de 15 anos.
7. ${isVoiceStarter ? 'INICIO DE SESION: Saluda brevemente con humor y haz tu primera pregunta sobre el tema.' : 'EVALUANDO RESPUESTA: Analiza lo que dijo, corrige si es necesario, y deja una pregunta que lo haga pensar.'}

EJEMPLOS DE RESPUESTAS BUENAS:
- "Mmm casi, pero te falta un pedacito importante. Una variable no es solo un nombre, es como una caja donde guardas cosas. ¿Que tipo de cosas crees que puedes guardar ahi?"
- "¡Eso! Vas por buen camino. Pero ojo, cuando dices 'guardar datos', ¿que pasa si quieres cambiar lo que esta guardado?"
- "Jaja no, pero me gusto el intento. Mira, un bucle for es como cuando tienes que hacer la misma tarea 10 veces seguidas. ¿Se te ocurre un ejemplo de la vida real?"

EJEMPLOS DE RESPUESTAS MALAS (NO HACER):
- "Selecciona la opcion correcta: A) esto B) aquello C) otro"
- Ignorar completamente lo que dijo el estudiante
- Respuestas larguisimas y tecnicas que nadie entiende
- Ser condescendiente o hacer sentir mal al estudiante

Nivel de exigencia: ${String(difficulty || 'HARD').toUpperCase()}

Devuelve SOLO JSON valido:
{
  "stance": "incorrect" | "partial" | "reasonable",
  "reply": "tu respuesta conversacional, natural, como hablando",
  "critique": "si hay error, explica por que de forma clara y con ejemplo",
  "question": "UNA pregunta abierta, directa, sin opciones",
  "confidence": 0.0
}`;
    }

    _buildCoachUserPrompt({ contextBlock, message, history, topicName, taskName, isVoiceStarter = false, voiceMode = false }) {
        const historyBlock = history.length
            ? history.map(item => `${item.role.toUpperCase()}: ${item.content}${item.question ? `\nPREGUNTA_PREVIA: ${item.question}` : ''}`).join('\n\n')
            : 'Sin historial previo.';

        return `${contextBlock || 'No hay material RAG disponible. Usa solo tema/tarea si existen y reconoce limites.'}

CONTEXTO DE SESION:
Tema: ${topicName || 'No especificado'}
Tarea: ${taskName || 'No especificada'}

HISTORIAL RECIENTE:
${historyBlock}

${isVoiceStarter ? 'MODO: INICIO DE CONVERSACION POR VOZ' : `LO QUE DIJO EL ESTUDIANTE:\n"${String(message || '').trim()}"`}

TU TAREA AHORA:
${isVoiceStarter
    ? `Saluda de forma breve y amigable (1-2 frases con algo de humor).
Luego haz UNA pregunta sobre el tema que invite al estudiante a explicar con sus propias palabras.
En "critique" deja vacio porque aun no ha respondido nada.
Ejemplo: "Buenas! Listo para aprender? Empecemos con algo basico: segun tu, que es ${topicName || 'este concepto'} y para que sirve?"`
    : `1. PRIMERO: Lee bien lo que dijo el estudiante y RESPONDE a eso especificamente.
2. Si hay errores: Explica de forma clara y simple por que esta mal, con un ejemplo de la vida real.
3. Si hay aciertos: Reconocelos brevemente antes de profundizar.
4. SIEMPRE termina con UNA pregunta que lo haga pensar mas sobre el tema.
5. Habla como si estuvieras conversando en persona, no como un libro.`}

IMPORTANTE:
- NUNCA ignores lo que dijo el estudiante
- NUNCA uses opciones A/B/C/D
- USA ejemplos de la vida real para explicar
- Si el estudiante no entiende, explicalo de otra forma mas simple`;
    }

    _isMultipleChoiceText(text = '') {
        const value = String(text || '');
        return /(^|\n)\s*[A-D]\s*[\).:-]/i.test(value) ||
            /\b(opcion|opción)\s+[A-D]\b/i.test(value) ||
            /\b[A-D]\s*[\).:-]\s+\S/i.test(value) ||
            /\b(cual|cu[aá]l)\s+de\s+las\s+siguientes\b/i.test(value) ||
            /\b(elige|selecciona|escoge)\s+(la\s+)?(opcion|opción|respuesta)\b/i.test(value);
    }

    _sanitizeCoachText(text = '', fallback = '') {
        const cleaned = String(text || '')
            .replace(/```[\s\S]*?```/g, ' ')
            .split(/\n+/)
            .filter(line => !this._isMultipleChoiceText(line))
            .join(' ')
            .replace(/\b(opcion|opción)\s+[A-D]\b/gi, '')
            .replace(/\s+/g, ' ')
            .trim();
        return cleaned || fallback;
    }

    _sanitizeOpenCoachQuestion(question = '', fallback = '') {
        let cleaned = this._sanitizeCoachText(question, '')
            .replace(/^(pregunta|ahora dime|dime|responde)\s*[:.-]\s*/i, '')
            .trim();
        if (!cleaned || this._isMultipleChoiceText(cleaned)) cleaned = fallback;
        return String(cleaned || fallback || 'Que entiendes del tema y que ejemplo concreto puedes dar?')
            .replace(/\s+/g, ' ')
            .slice(0, 600);
    }

    _parseCoachResponse(content) {
        const raw = String(content || '').trim();
        const fallback = {
            stance: 'incorrect',
            reply: 'Tu postura necesita mas soporte. Suena decidida, pero una idea con casco no sustituye evidencia.',
            critique: 'No pude estructurar la respuesta del modelo, asi que no la tomo como veredicto confiable.',
            question: 'Que entiendes del tema con tus palabras y que parte del material sostiene esa idea?',
            confidence: 0.35,
        };

        const start = raw.indexOf('{');
        const end = raw.lastIndexOf('}');
        if (start === -1 || end === -1 || start >= end) {
            return {
                ...fallback,
                reply: this._sanitizeCoachText(raw, fallback.reply).slice(0, 1200),
                question: this._sanitizeOpenCoachQuestion('', fallback.question),
            };
        }

        try {
            const parsed = JSON.parse(raw.substring(start, end + 1));
            const allowed = new Set(['incorrect', 'partial', 'reasonable']);
            const stance = allowed.has(parsed.stance) ? parsed.stance : 'incorrect';
            return {
                stance,
                reply: this._sanitizeCoachText(parsed.reply, fallback.reply).slice(0, 1200),
                critique: this._sanitizeCoachText(parsed.critique, fallback.critique).slice(0, 1200),
                question: this._sanitizeOpenCoachQuestion(parsed.question, fallback.question),
                confidence: Number.isFinite(Number(parsed.confidence)) ? Math.max(0, Math.min(1, Number(parsed.confidence))) : 0.5,
            };
        } catch (_) {
            return {
                ...fallback,
                reply: this._sanitizeCoachText(raw, fallback.reply).slice(0, 1200),
                question: this._sanitizeOpenCoachQuestion('', fallback.question),
            };
        }
    }

    /**
     * Get cached questions if available (instant response).
     */
    async getCachedQuestions(userId, courseId, topicId, taskId, difficulty) {
        const cached = this.questionCache.get(userId, courseId, topicId, taskId, difficulty);
        if (cached && cached.length > 0) {
            console.log(`⚡ [ReinforcementService] Cache HIT: ${cached.length} questions for user=${userId}, course=${courseId}, topic=${topicId}, task=${taskId}, diff=${difficulty}`);
            return Result.ok({
                questions: cached,
                count: cached.length,
                source: 'cache',
                generating: false,
            });
        }
        const isGenerating = this.questionCache.isGenerating(userId, courseId, topicId, taskId, difficulty);
        console.log(`💨 [ReinforcementService] Cache MISS for user=${userId}, course=${courseId}, topic=${topicId}, task=${taskId}. generating=${isGenerating}`);
        return Result.ok({
            questions: [],
            count: 0,
            source: 'none',
            generating: isGenerating,
        });
    }

    /**
     * Prefetch: start generating questions in background and cache them.
     * Returns immediately (fire-and-forget). The client polls /cached-questions.
     */
    async prefetchQuestions(userId, courseId, topicId, taskId, difficulty) {
        if (!this.llmPort || !this.learningContextService) {
            console.warn('[ReinforcementService] prefetch skipped: llmPort or learningContextService not available');
            return Result.ok({ status: 'skipped', reason: 'dependencies_unavailable' });
        }

        // Already cached or generating?
        const existing = this.questionCache.get(userId, courseId, topicId, taskId, difficulty);
        if (existing && existing.length > 0) {
            return Result.ok({ status: 'already_cached', count: existing.length });
        }
        if (this.questionCache.isGenerating(userId, courseId, topicId, taskId, difficulty)) {
            return Result.ok({ status: 'already_generating' });
        }

        // Fire-and-forget background generation
        this._generateAndCache(userId, courseId, topicId, taskId, difficulty).catch(err => {
            console.error('[ReinforcementService] Background prefetch error:', err.message);
        });

        return Result.ok({ status: 'started' });
    }

    /**
     * Generate questions server-side in a single call:
     * 1. Fetch learning context
     * 2. Build prompt & call LLM
     * 3. Return questions immediately
     * 4. Save with embeddings in background (non-blocking)
     */
    async generateQuestions(userId, courseId, topicId, taskId, difficulty, targetCount = 10, forceFresh = false) {
        // 1. Check cache first unless the caller explicitly forces a new generation.
        if (forceFresh) {
            this.questionCache.delete(userId, courseId, topicId, taskId, difficulty);
        } else {
            const cached = this.questionCache.get(userId, courseId, topicId, taskId, difficulty);
            if (cached && cached.length > 0) {
                console.log(`⚡ [ReinforcementService] generateQuestions: serving ${cached.length} from cache`);
                this.questionCache.delete(userId, courseId, topicId, taskId, difficulty);
                this._backgroundSave(userId, courseId, topicId, taskId, cached).catch(() => {});
                return Result.ok({ questions: cached, count: cached.length, source: 'cache' });
            }
        }

        if (!this.learningContextService) {
            return Result.fail('LearningContextService not available for server-side generation');
        }

        // 2. Dedup: si ya hay un LLM call en vuelo para esta misma clave, reutilizar
        const flightKey = `${userId}:${courseId}:${topicId || 0}:${taskId || 0}:${(difficulty || 'HARD').toUpperCase()}`;
        if (!forceFresh && this._inFlight.has(flightKey)) {
            console.log(`🔄 [ReinforcementService] Reusing in-flight LLM call for key=${flightKey}`);
            try {
                const questions = await this._inFlight.get(flightKey);
                return Result.ok({ questions, count: questions.length, source: 'llm_shared' });
            } catch (error) {
                return Result.fail(error.message || 'Question generation failed');
            }
        }

        // 3. Nueva llamada: registrar en _inFlight y limitar con semáforo global
        const generationPromise = withLlmSlot(() =>
            this._generateQuestionsInternal(userId, courseId, topicId, taskId, difficulty, targetCount)
        );
        this._inFlight.set(flightKey, generationPromise);

        try {
            const questions = await generationPromise;
            if (!questions || questions.length === 0) {
                return Result.ok({ questions: [], count: 0, source: 'llm', message: 'LLM returned no valid questions' });
            }
            // ✅ Always return whatever was generated — clients do padding/retry on their side.
            // Never discard questions just because count < MIN_QUESTIONS_FOR_UI.
            if (questions.length < 8) {
                console.warn(`⚠️ [ReinforcementService] Only ${questions.length} questions generated (below ideal 8). Returning anyway — clients will pad.`);
            }
            const hasFallbackQuestions = questions.some(q => q?._fallback);
            const source = hasFallbackQuestions
                ? (questions.every(q => q?._fallback) ? 'local_fallback' : 'llm_with_local_fallback')
                : 'llm';
            console.log(`\n═══ preguntas enviadas al cliente (${questions.length}) ═══`);
            questions.forEach((q, i) => console.log(`  [${i + 1}] type=${q.type} | ${q.question?.substring(0, 100)}`));
            console.log(`═══════════════════════════════════════════════════\n`);
            this._backgroundSave(userId, courseId, topicId, taskId, questions).catch(() => {});
            return Result.ok({ questions, count: questions.length, source });
        } catch (error) {
            console.error('[ReinforcementService] generateQuestions error:', error.message);
            return Result.fail(error.message || 'Question generation failed');
        } finally {
            this._inFlight.delete(flightKey);
        }
    }

    /**
     * @private Generate questions and store in cache.
     */
    async _generateAndCache(userId, courseId, topicId, taskId, difficulty) {
        this.questionCache.markGenerating(userId, courseId, topicId, taskId, difficulty);
        try {
            const questions = await withLlmSlot(() =>
                this._generateQuestionsInternal(userId, courseId, topicId, taskId, difficulty, this.REQUIRED_QUESTION_COUNT)
            );
            if (questions && questions.length > 0) {
                this.questionCache.set(userId, courseId, topicId, taskId, difficulty, questions);
                console.log(`✅ [ReinforcementService] Prefetch complete: ${questions.length} questions cached`);
            }
        } finally {
            this.questionCache.clearGenerating(userId, courseId, topicId, taskId, difficulty);
        }
    }

    /**
     * @private Core question generation logic (context + LLM call).
     * Iterates until accumulating exactly targetCount valid unique questions.
     */
    async _generateQuestionsInternal(userId, courseId, topicId, taskId, difficulty, targetCount) {
        const startMs = Date.now();
        const MAX_ITERATIONS = 8;
        const MIN_ACCEPTABLE = Math.max(targetCount - 2, 1); // Accept minimum targetCount-2 (e.g. 8 of 10)

        // Step 1: Get learning context (parallel DB queries + RAG)
        const contextResult = await this.learningContextService.buildLearningContext({
            courseId, topicId, taskId, userId,
            query: null,
            retrievalMode: 'hybrid',
        });

        if (contextResult.isFail()) {
            throw new Error('Failed to build learning context: ' + contextResult.getError());
        }

        const ctx = contextResult.getValue();
        const topicName = ctx.topic?.name || '';
        const taskName = ctx.task?.title || '';
        const ragContent = ctx.ragContent || '';
        const existingQuestions = (ctx.existingQuestions || []).map(q => q.question || '');

        console.log(`📚 [ReinforcementService] Context built in ${Date.now() - startMs}ms: topic='${topicName}', task='${taskName}', ragChunks=${ctx.ragChunks || 0}, existingQ=${existingQuestions.length}`);

        // Step 2: Build shared context
        const contextBlock = this._buildContextBlock(topicName, ctx.topic?.description, taskName, ctx.task?.description, ragContent, ctx.ragFiles || []);
        const diffLabel = (difficulty || 'HARD').toUpperCase();

        // Step 2b: Detect domain to enforce topic boundary and prevent cross-domain contamination
        // (moved BEFORE systemPrompt so we can pass domain to it)
        const domain = this._inferDomain(topicName, taskName, ragContent);

        // isMathContent is the single gate that decides whether math exercises are allowed.
        // Math is ONLY permitted when: domain is explicitly MATH/PHYSICS/CHEMISTRY/ACCOUNTING,
        // OR domain is GENERAL but the title/RAG content explicitly mentions math topics.
        const MATH_ADJACENT_DOMAINS = ['MATH', 'PHYSICS', 'CHEMISTRY', 'ACCOUNTING'];
        const isMathContent = MATH_ADJACENT_DOMAINS.includes(domain) ||
            (domain === 'GENERAL' && this._isMathContent(topicName, taskName, ragContent));

        const systemPrompt = this._buildSystemPrompt(diffLabel, targetCount, domain, isMathContent);

        const domainLockBlock = this._buildDomainLockBlock(domain, topicName, taskName);
        console.log(`🎯 [ReinforcementService] Detected domain: ${domain}, isMathContent=${isMathContent} (topic='${topicName}', task='${taskName}')`);

        const topicHint = topicName
            ? `El tema es "${topicName}"${taskName ? ` y la tarea es "${taskName}"` : ''}. Dominio detectado: ${domain}. TODOS los ejercicios son EXCLUSIVAMENTE de ese dominio. Lleva el dominio a su EXPRESIÓN MÁS COMPLEJA Y AVANZADA.\n\n${domainLockBlock}`
            : `\n${domainLockBlock}`;

        // Complexity enforcement added to the user prompt for HARD difficulty
        const isMathDomain = domain === 'MATH';
        const antiMathBlock = !isMathContent
            ? `\n\n🚫🚫🚫 PROHIBICIÓN ABSOLUTA DE MATEMÁTICAS 🚫🚫🚫\nEl dominio detectado es ${domain}. Este tema NO es de matemáticas.\nPROHIBIDO TOTAL generar ejercicios de: cálculo aritmético, álgebra, ecuaciones, fracciones, series, integrales, derivadas, sumas de números, geometría, trigonometría, o CUALQUIER problema numérico/matemático puro.\nSi el material menciona un número o dato numérico como contexto, NO lo conviertas en un problema matemático.\nTODOS los ejercicios deben evaluar la COMPRENSIÓN DEL CONTENIDO del tema "${topicName}"${taskName ? ` y la tarea "${taskName}"` : ''}, NO habilidades matemáticas.\n🚫🚫🚫 FIN PROHIBICIÓN DE MATEMÁTICAS 🚫🚫🚫`
            : '';

        const hardEnforcement = diffLabel === 'HARD'
            ? `\n\n⚠️⚠️⚠️ NIVEL HARD — COMPLEJIDAD MÁXIMA NO NEGOCIABLE ⚠️⚠️⚠️\n\nPASO 1: El dominio YA FUE DETERMINADO: ${domain}. NO cambies de dominio.\nPASO 2: Lleva ese dominio a su EXPRESIÓN PRÁCTICA MÁS AVANZADA Y COMPLEJA posible.\nPASO 3: Genera CADA ejercicio al nivel que desafiaría a un profesional o estudiante avanzado del dominio ${domain}.\n\nREGLAS INQUEBRANTABLES PARA DOMINIO ${domain}:\n${isMathDomain ? '- SUMAS: genera sumas de 7+ dígitos (ej: 1,023,232 + 12,213,456 + 987,654 = ___), sumas encadenadas de 4+ operandos, sumas con decimales extensos, sumatorias Σ, sumas de matrices, series aritméticas/geométricas. NUNCA sumas de 1-3 dígitos. NUNCA algoritmos de programación (Kahan, etc.).' : ''}\n${isMathDomain ? '- ÁLGEBRA: ecuaciones cuadráticas, sistemas de ecuaciones, derivadas, integrales definidas. NUNCA ecuaciones lineales de un solo paso.' : ''}\n${domain === 'SQL' ? '- JOINs múltiples (≥2 tablas), subconsultas correlacionadas, funciones de ventana (OVER, PARTITION BY, RANK, ROW_NUMBER), CTEs (WITH), GROUP BY con HAVING. NUNCA SELECT simple sin JOIN.' : ''}\n${domain === 'PROGRAMMING' ? '- Algoritmos con análisis de complejidad O(n log n), recursión con memoización, programación dinámica, grafos. NUNCA sintaxis básica ni Hello World.' : ''}\n${!isMathContent && domain !== 'SQL' && domain !== 'PROGRAMMING' ? `- DOMINIO ${domain}: Genera ejercicios que evalúen EXCLUSIVAMENTE conocimientos de ${domain}. PROHIBIDO incluir problemas matemáticos puros, cálculos aritméticos, ecuaciones o fórmulas que no pertenezcan directamente a ${domain}.` : ''}\n- CUALQUIER DOMINIO: identifica el concepto central y llévalo a su versión más compleja y profesional.\n${antiMathBlock}\n\nTEST DE COMPLEJIDAD: Si un ejercicio se resuelve en <30 segundos de pensamiento activo → DESCÁRTALO y genera uno más complejo.`
            : (antiMathBlock || '');

        if (!this.llmPort) {
            const fallbackQuestions = this._buildLocalFallbackQuestions({
                targetCount,
                topicName,
                taskName,
                topicDesc: ctx.topic?.description,
                taskDesc: ctx.task?.description,
                ragContent,
                diffLabel,
                domain,
            });
            console.warn(`[ReinforcementService] LLM port unavailable; returning ${fallbackQuestions.length} local fallback questions.`);
            return fallbackQuestions;
        }

        // Accumulate unique questions across iterations
        const accumulated = [];
        const allExcludedTexts = [...existingQuestions];

        let consecutiveZero = 0; // Track consecutive iterations yielding 0 new questions
        let llmUnavailable = false;
        const rememberLlmFailures = (results, stage) => {
            const failures = results.filter(resp => resp.status === 'rejected');
            if (failures.length !== results.length) return;
            const sample = failures
                .map(resp => resp.reason?.message || String(resp.reason || 'LLM request failed'))
                .filter(Boolean)
                .slice(0, 2)
                .join(' | ');
            console.warn(`[ReinforcementService] All LLM calls failed during ${stage}; switching to local fallback. ${sample}`);
            llmUnavailable = true;
        };

        // ── PARALLEL FIRST BATCH ─────────────────────────────────────────────────
        // On iteration 0: fire 2 concurrent LLM calls to frontload generation speed.
        // Each call asks for (targetCount + 3) questions; after filtering we usually
        // reach targetCount in a single round, skipping all subsequent iterations.
        const buildUserPrompt = (exclusionBlock, reqCount) =>
            `${contextBlock}\n${exclusionBlock}\n\n${topicHint}${hardEnforcement}\n\n═══ INSTRUCCIÓN PRINCIPAL ═══\nANTES de generar cualquier ejercicio, ANALIZA el material de referencia proporcionado e identifica:\n1. La TEMÁTICA PRINCIPAL del contenido (ej: historia, biología, programación, idiomas, etc.)\n2. Los CONCEPTOS CLAVE que el estudiante debe dominar\n3. Los EJEMPLOS y DATOS específicos del material\n\nLuego genera EXACTAMENTE ${reqCount} ejercicios de evaluación que cubran EXCLUSIVAMENTE esa temática.\n${!isMathContent ? 'PROHIBIDO: ejercicios de cálculo, aritmética, sumas, ecuaciones o cualquier problema matemático puro. ' : ''}OBLIGATORIO: MEZCLA los tipos (multiple_choice, fill_in_blank, ordering) — incluye EJERCICIOS PRÁCTICOS donde el estudiante demuestre comprensión profunda del material. Cada ejercicio debe exigir razonamiento genuino acorde al nivel ${diffLabel}.\nFormato: JSON array. Tu ÚNICA salida debe ser el JSON array, sin texto adicional.`;

        const callLLM = (temperature, reqCount, exclusionBlock) =>
            this.llmPort.chat(systemPrompt, buildUserPrompt(exclusionBlock, reqCount), {
                temperature,
                maxTokens: 8000,
            });

        const applyFilters = (rawQuestions, excluded) => {
            const deduped = this._localDedup(rawQuestions, excluded);
            // Cross-domain math rejection: applies to ALL difficulties when topic is not math
            const crossFiltered = !isMathContent ? deduped.filter(q => {
                const text = (q.question || '').toLowerCase();
                const answer = String(q.correct_answer || q.correctAnswer || '').toLowerCase();
                const pureMathSignals = [
                    /\b\d+\s*[+\-*\/×÷]\s*\d+/,                                  // any arithmetic: "234 + 567", "12 × 3"
                    /calcula\b/i,                                                   // "calcula..." anything
                    /resuelve\s+(la\s+)?ecuaci[oó]n/i,                              // "resuelve la ecuación..."
                    /cu[aá]nto\s+(es|da|resulta|vale|suman|suma)/i,                 // "cuánto es/da/suman..."
                    /\b(sen|cos|tan|log|ln|sqrt|∫|∑|π|√)\b/i,                      // trig/calc symbols
                    /\bx\s*[\^²³]\s*[+\-]\s*\d/,                                   // polynomial: "x² + 3"
                    /\b\d+\s*\/\s*\d+\s*[+\-]\s*\d+\s*\/\s*\d+/,                  // fractions: "3/8 + 1/9"
                    /serie\s+(geom[eé]trica|aritm[eé]tica)/i,                       // "serie geométrica"
                    /sistema\s+de\s+ecuaciones/i,                                   // "sistema de ecuaciones"
                    /\b(matriz|matrices|determinante)\b/i,                           // matrices
                    /sumatoria|sumatorio|∑/i,                                        // summation
                    /\b(suma|resta|multiplica|divide)\s+(los|las|estos|estas)?\s*\d/i, // "suma los números..."
                    /resultado\s+de\s+(\d|la\s+operaci)/i,                           // "resultado de 234..."
                    /operaci[oó]n\s+(aritm[eé]tica|matem[aá]tica)/i,                // "operación aritmética"
                ];
                // Also check: if the answer is purely numeric and the question asks to compute
                const isNumericAnswer = /^-?\d+([.,]\d+)?$/.test(answer.trim());
                const asksToCompute = /\b(calcula|resuelve|halla|encuentra|determina)\b.*\d/i.test(text);

                if (pureMathSignals.some(r => r.test(text)) || (isNumericAnswer && asksToCompute)) {
                    console.warn(`[ReinforcementService] Cross-domain math rejected (${diffLabel}): "${text.substring(0, 80)}..."`);
                    return false;
                }
                return true;
            }) : deduped;
            return diffLabel === 'HARD' ? crossFiltered.filter(q => {
                const trivial = this._isExerciseTrivialForHard(q, domain, isMathContent);
                if (trivial) console.warn(`[ReinforcementService] HARD filter rejected: "${q.question.substring(0, 80)}..."`);
                return !trivial;
            }) : crossFiltered;
        };

        // Parallel first batch: 2 concurrent calls, each asking for targetCount+3
        {
            const firstExclusionList = allExcludedTexts.slice(-50);
            const firstExclusionBlock = firstExclusionList.length > 0
                ? `\nPREGUNTAS YA EXISTENTES (NO REPETIR):\n${firstExclusionList.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n`
                : '';
            const firstReqCount = Math.min(targetCount + 5, 15);

            const batchStart = Date.now();
            const [resp1, resp2, resp3] = await Promise.allSettled([
                callLLM(0.4, firstReqCount, firstExclusionBlock),
                callLLM(0.55, firstReqCount, firstExclusionBlock),
                callLLM(0.7, firstReqCount, firstExclusionBlock),
            ]);
            console.log(`🤖 [ReinforcementService] Parallel first batch (3 calls) in ${Date.now() - batchStart}ms`);
            rememberLlmFailures([resp1, resp2, resp3], 'first batch');

            const firstResults = [resp1, resp2, resp3];
            if (firstResults.every(resp => resp.status === 'rejected')) {
                const reasons = firstResults
                    .map(resp => resp.reason?.message || String(resp.reason || 'unknown error'))
                    .join(' | ');
                if (/authentication|user not found|circuit breaker|no hay proveedor|llm disabled|unauthorized/i.test(reasons)) {
                    llmUnavailable = true;
                    console.warn(`[ReinforcementService] LLM unavailable after first batch; skipping fill retries: ${reasons}`);
                }
            }

            for (const resp of firstResults) {
                if (resp.status !== 'fulfilled') continue;
                const qs = this._parseQuestionsJson(resp.value?.content || '');
                const filtered = applyFilters(qs, allExcludedTexts);
                for (const q of filtered) {
                    if (accumulated.length >= targetCount) break;
                    accumulated.push(q);
                    allExcludedTexts.push(q.question);
                }
            }
            console.log(`🔄 [ReinforcementService] After parallel batch: accumulated=${accumulated.length}/${targetCount}`);
        }

        // ── PARALLEL FILL-UP ITERATIONS ─────────────────────────────────────────
        // Fire 2 concurrent LLM calls per iteration (like the first batch) to
        // cut wall-clock time roughly in half versus sequential single calls.
        // Only run if parallel batch didn't reach targetCount.
        for (let iteration = 0; iteration < MAX_ITERATIONS && accumulated.length < targetCount; iteration++) {
            if (llmUnavailable && accumulated.length === 0) break;
            const remaining = targetCount - accumulated.length;

            // Stop early only if we meet MIN_ACCEPTABLE AND iterations are clearly unproductive
            if (accumulated.length >= MIN_ACCEPTABLE && consecutiveZero >= 2) {
                console.log(`✅ [ReinforcementService] Stopping early: ${accumulated.length}/${targetCount} (>= min ${MIN_ACCEPTABLE}) after ${consecutiveZero} empty iterations`);
                break;
            }

            // Build exclusion block
            const exclusionList = allExcludedTexts.slice(-50);
            const existingBlock = exclusionList.length > 0
                ? `\nPREGUNTAS YA EXISTENTES (NO REPETIR):\n${exclusionList.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n`
                : '';

            // Request 2× the shortfall (min 8) to compensate for filtering losses
            const requestCount = Math.min(Math.max(remaining * 2 + 3, 8), 15);

            // Fire 2 parallel LLM calls with slightly different temperatures
            const baseTemp = Math.min(0.45 + (iteration * 0.15), 0.9);
            const temp2 = Math.min(baseTemp + 0.1, 0.95);
            const llmStartMs = Date.now();

            const fillResults = await Promise.allSettled([
                callLLM(baseTemp, requestCount, existingBlock),
                callLLM(temp2, requestCount, existingBlock),
            ]);
            console.log(`🤖 [ReinforcementService] Parallel fill batch in ${Date.now() - llmStartMs}ms (fill iteration ${iteration + 1})`);
            rememberLlmFailures(fillResults, `fill iteration ${iteration + 1}`);

            const prevAccumulated = accumulated.length;
            let anyParsed = false;

            for (const resp of fillResults) {
                if (accumulated.length >= targetCount) break;
                if (resp.status !== 'fulfilled') continue;
                const content = resp.value?.content || '';
                const questions = this._parseQuestionsJson(content);
                if (questions.length > 0) anyParsed = true;

                const filtered = applyFilters(questions, allExcludedTexts);
                for (const q of filtered) {
                    if (accumulated.length >= targetCount) break;
                    accumulated.push(q);
                    allExcludedTexts.push(q.question);
                }
            }

            const newlyAdded = accumulated.length - prevAccumulated;
            console.log(`🔄 [ReinforcementService] Fill it.${iteration + 1}: newlyAdded=${newlyAdded}, accumulated=${accumulated.length}/${targetCount}`);

            consecutiveZero = newlyAdded === 0 ? consecutiveZero + 1 : 0;
            if (llmUnavailable && accumulated.length === 0) break;
        }

        if (accumulated.length < targetCount) {
            const fallbackQuestions = this._buildDeterministicFallbackQuestions({
                targetCount: targetCount - accumulated.length,
                topicName,
                topicDesc: ctx.topic?.description,
                taskName,
                taskDesc: ctx.task?.description,
                ragContent,
                existingTexts: allExcludedTexts,
                difficulty: diffLabel,
                domain,
            });

            for (const q of fallbackQuestions) {
                if (accumulated.length >= targetCount) break;
                accumulated.push(q);
                allExcludedTexts.push(q.question);
            }

            if (fallbackQuestions.length > 0) {
                console.warn(`[ReinforcementService] Local fallback added ${fallbackQuestions.length} questions; accumulated=${accumulated.length}/${targetCount}`);
            }
        }

        if (accumulated.length < MIN_ACCEPTABLE) {
            const beforeFallback = accumulated.length;
            const fallbackQuestions = this._buildLocalFallbackQuestions({
                targetCount,
                topicName,
                taskName,
                topicDesc: ctx.topic?.description,
                taskDesc: ctx.task?.description,
                ragContent,
                diffLabel,
                domain,
            });
            const seenFallbackTexts = new Set(
                allExcludedTexts.map(text => String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim())
            );
            for (const q of fallbackQuestions) {
                if (accumulated.length >= targetCount) break;
                const key = String(q.question || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
                if (!key || seenFallbackTexts.has(key)) continue;
                seenFallbackTexts.add(key);
                accumulated.push(q);
                allExcludedTexts.push(q.question);
            }
            console.warn(`[ReinforcementService] Added ${accumulated.length - beforeFallback} local fallback questions after LLM produced ${beforeFallback}/${targetCount}.`);
        }

        console.log(`✅ [ReinforcementService] Final: ${accumulated.length}/${targetCount} unique questions (min acceptable: ${MIN_ACCEPTABLE}, total ${Date.now() - startMs}ms)`);

        // Log questions that will be shown in the UI
        console.log(`\n═══ preguntas mostradas en la interfaz (${accumulated.length}) ═══`);
        this.logQuestionBatch('preguntas mostradas en la interfaz', accumulated, {
            userId, courseId, topicId, taskId, difficulty: diffLabel,
            totalGenerated: accumulated.length,
            targetCount,
            minAcceptable: MIN_ACCEPTABLE,
            elapsedMs: Date.now() - startMs,
        });
        console.log(`═══════════════════════════════════════════════════\n`);

        if (accumulated.length < MIN_ACCEPTABLE) {
            console.warn(`⚠️ [ReinforcementService] WARNING: Only ${accumulated.length} questions generated (minimum acceptable: ${MIN_ACCEPTABLE}). Returning anyway — clients will pad with fallback.`);
        }

        return accumulated.slice(0, targetCount);
    }

    /** @private Build the context text block for the prompt */
    _buildContextBlock(topicName, topicDesc, taskName, taskDesc, ragContent, ragFiles) {
        let block = '';
        if (topicName) {
            block += `TEMA: ${topicName}\n`;
            if (topicDesc) block += `Descripción: ${topicDesc}\n`;
        }
        if (taskName) {
            block += `TAREA: ${taskName}\n`;
            if (taskDesc) block += `Descripción: ${taskDesc}\n`;
        }
        if (ragContent) {
            block += `\n═══ MATERIAL DE REFERENCIA VERIFICADO ═══\n${ragContent}\n═══════════════════════════════════════\n`;
            if (ragFiles.length > 0) block += `Archivos fuente: ${ragFiles.join(', ')}\n`;
        }
        return block;
    }

    /** @private Build usable questions when every LLM provider fails. */
    _buildDeterministicFallbackQuestions({
        targetCount = 10,
        topicName = '',
        topicDesc = '',
        taskName = '',
        taskDesc = '',
        ragContent = '',
        existingTexts = [],
        difficulty = 'HARD',
        domain = 'GENERAL',
    } = {}) {
        const desired = Math.max(Number(targetCount) || 0, 0);
        if (desired <= 0) return [];

        const domainLabels = {
            MATH: 'matematicas',
            SQL: 'bases de datos',
            PROGRAMMING: 'programacion',
            PHYSICS: 'fisica',
            CHEMISTRY: 'quimica',
            LANGUAGE: 'lenguaje',
            HISTORY: 'historia',
            ACCOUNTING: 'contabilidad',
            BIOLOGY: 'biologia',
            GENERAL: 'el contenido',
        };
        const domainLabel = domainLabels[domain] || 'el contenido';
        const contextLabel = [topicName, taskName].filter(Boolean).join(' / ') || domainLabel;
        const seeds = this._extractFallbackQuestionSeeds({ topicName, topicDesc, taskName, taskDesc, ragContent });
        const usedTexts = [...existingTexts];
        const questions = [];

        const baseOptions = [
            'Relacionarlo con el objetivo de la tarea y respaldarlo con evidencia del material.',
            'Tratarlo como dato aislado sin conectarlo con el objetivo de la tarea.',
            'Cambiarlo por una idea externa que no aparece sustentada en el material.',
            'Memorizarlo de forma literal sin explicar su funcion dentro del tema.',
        ];

        const maxAttempts = Math.max(desired * 8, 16);
        for (let attempt = 0; questions.length < desired && attempt < maxAttempts; attempt++) {
            const seed = this._shortenFallbackText(seeds[attempt % seeds.length] || contextLabel, 150);
            const promptTemplates = [
                `Caso ${attempt + 1}: segun el material, que accion demuestra mejor comprension de ${domainLabel} a partir de "${seed}"?`,
                `Caso ${attempt + 1}: al trabajar ${contextLabel}, cual es el uso mas adecuado del fragmento "${seed}"?`,
                `Caso ${attempt + 1}: que criterio permite aplicar correctamente esta idea del material: "${seed}"?`,
                `Caso ${attempt + 1}: cual decision mantiene la respuesta mas alineada con el material sobre ${contextLabel}?`,
            ];
            const questionText = promptTemplates[attempt % promptTemplates.length];
            const rotateBy = attempt % baseOptions.length;
            const options = baseOptions.slice(rotateBy).concat(baseOptions.slice(0, rotateBy));
            const correctIndex = (baseOptions.length - rotateBy) % baseOptions.length;
            const normalized = this._normalizeQuestion({
                type: 'multiple_choice',
                question: questionText,
                options,
                correctIndex,
                explanation: `La opcion correcta mantiene la respuesta anclada al material de ${contextLabel} y exige justificarla con evidencia, no con datos externos.`,
            });

            if (!normalized) continue;
            if (difficulty === 'HARD' && this._isExerciseTrivialForHard(normalized, domain, false)) {
                normalized.question = `Caso avanzado ${attempt + 1}: ${normalized.question}`;
            }

            const unique = this._localDedup([normalized], usedTexts);
            if (unique.length === 0) continue;
            questions.push(unique[0]);
            usedTexts.push(unique[0].question);
        }

        return questions;
    }

    /** @private Extract compact, material-grounded snippets for local fallback questions. */
    _extractFallbackQuestionSeeds({ topicName = '', topicDesc = '', taskName = '', taskDesc = '', ragContent = '' } = {}) {
        const source = [ragContent, taskDesc, topicDesc, taskName, topicName].filter(Boolean).join('\n');
        const fallbackTopic = topicName || taskName || 'el contenido del curso';
        const candidates = source
            .replace(/\r/g, ' ')
            .split(/[.!?]\s+|\n+/)
            .map(text => this._cleanFallbackSeed(text))
            .filter(text => text.length >= 35 && text.length <= 260)
            .filter(text => !/^(tema|tarea|descripcion|material de referencia|archivos fuente)\b/i.test(text))
            .filter(text => !/^[-=]{3,}$/.test(text));

        const unique = [];
        const seen = new Set();
        for (const candidate of candidates) {
            const key = candidate.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
            if (!key || seen.has(key)) continue;
            seen.add(key);
            unique.push(candidate);
            if (unique.length >= 16) break;
        }

        const defaults = [
            `El tema central es ${fallbackTopic} y debe conectarse con la tarea activa.`,
            `La respuesta debe usar evidencia del material antes de formular una conclusion.`,
            `El estudiante debe distinguir ideas del material frente a afirmaciones externas.`,
            `La aplicacion correcta exige explicar la relacion entre concepto, tarea y contexto.`,
        ];

        return unique.length > 0 ? unique.concat(defaults) : defaults;
    }

    /** @private */
    _cleanFallbackSeed(text) {
        return String(text || '')
            .replace(/[`*_#>]+/g, ' ')
            .replace(/[{}\[\]()]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    /** @private */
    _shortenFallbackText(text, maxLength = 150) {
        const cleaned = this._cleanFallbackSeed(text);
        if (cleaned.length <= maxLength) return cleaned;
        const cut = cleaned.slice(0, maxLength);
        const lastSpace = cut.lastIndexOf(' ');
        const end = lastSpace > Math.floor(maxLength * 0.55) ? lastSpace : maxLength;
        return `${cut.slice(0, end).trim()}...`;
    }

    /**
     * Infers the primary domain from topic/task name and RAG content.
     * Returns a normalized domain key used for domain-lock enforcement.
     * @private
     */
    _inferDomain(topicName = '', taskName = '', ragContent = '') {
        // Topic/task name is the STRONGEST signal — weight it much higher than RAG
        const topicText = `${topicName} ${taskName}`.toLowerCase();
        // RAG content may contain off-topic examples; only use first 1500 chars as weak signal
        const ragSample = ragContent.substring(0, 1500).toLowerCase();

        const DOMAIN_KEYWORDS = {
            MATH: {
                strong: ['suma', 'sumas', 'adición', 'sustracción', 'resta', 'multiplicación', 'división',
                    'aritmética', 'álgebra', 'cálculo', 'calculo', 'ecuación', 'ecuaciones', 'matemática',
                    'matemáticas', 'trigonometría', 'geometría', 'fracción', 'decimal', 'porcentaje',
                    'integral', 'derivada', 'límite', 'serie', 'sumatoria', 'logaritmo', 'exponente',
                    'polinomio', 'matriz', 'vector', 'probabilidad', 'estadística', 'binomial',
                    'problema matemático', 'problemas matemáticos'],
                // IMPORTANT: removed generic words (resolver, resultado, calcular, operación) that
                // caused false MATH classification for non-math topics like "Resolver problemas de..."
                weak: ['número', 'números'],
            },
            SQL: {
                strong: ['sql', 'select', 'query', 'base de datos', 'database', 'postgresql', 'mysql',
                    'supabase', 'joins', 'subconsulta', 'stored procedure', 'trigger', 'índice', 'índices'],
                weak: ['tabla', 'tablas', 'consulta', 'registro', 'campo'],
            },
            PROGRAMMING: {
                strong: ['programación', 'programming', 'algoritmo', 'algoritmos', 'javascript', 'python',
                    'java', 'typescript', 'c++', 'c#', 'kotlin', 'swift', 'react', 'vue', 'angular',
                    'api', 'frontend', 'backend', 'fullstack', 'recursión', 'poo', 'oop', 'clase',
                    'función', 'variable', 'estructura de datos', 'grafo', 'árbol binario'],
                weak: ['código', 'función', 'objeto', 'método', 'loop', 'ciclo'],
            },
            PHYSICS: {
                strong: ['física', 'physics', 'fuerza', 'energía', 'velocidad', 'aceleración', 'mecánica',
                    'termodinámica', 'óptica', 'electromagnetismo', 'ondas', 'newton', 'joule', 'watt'],
                weak: ['masa', 'tiempo', 'distancia', 'potencia'],
            },
            CHEMISTRY: {
                strong: ['química', 'chemistry', 'reacción', 'mol', 'átomo', 'molécula', 'concentración',
                    'ph', 'oxidación', 'reducción', 'estequiometría', 'enlace', 'tabla periódica'],
                weak: ['elemento', 'compuesto', 'mezcla', 'solución'],
            },
            LANGUAGE: {
                strong: ['inglés', 'español', 'francés', 'alemán', 'idioma', 'gramática', 'vocabulario',
                    'conjugación', 'sintaxis', 'semántica', 'escritura', 'comprensión lectora', 'redacción',
                    'ortografía', 'puntuación', 'subjuntivo', 'condicional'],
                weak: ['verbo', 'sustantivo', 'adjetivo', 'adverbio', 'preposición'],
            },
            HISTORY: {
                strong: ['historia', 'history', 'guerra', 'revolución', 'siglo', 'época', 'civilización',
                    'independencia', 'colonización', 'monarquía', 'república', 'imperio', 'tratado',
                    'movimiento social', 'dictadura'],
                weak: ['año', 'período', 'personaje', 'país', 'evento'],
            },
            ACCOUNTING: {
                strong: ['contabilidad', 'accounting', 'balance', 'debe', 'haber', 'activo', 'pasivo',
                    'patrimonio', 'asiento', 'estado financiero', 'flujo de caja', 'depreciación',
                    'amortización', 'auditoría', 'finanzas', 'presupuesto', 'tributación'],
                weak: ['cuenta', 'ingreso', 'egreso', 'gasto', 'capital'],
            },
            BIOLOGY: {
                strong: ['biología', 'biology', 'célula', 'adn', 'proteína', 'genética', 'evolución',
                    'ecosistema', 'mitosis', 'meiosis', 'fotosíntesis', 'respiración celular', 'tejido'],
                weak: ['organismo', 'especie', 'gen', 'cromosoma'],
            },
        };

        const scores = {};
        for (const [domain, kw] of Object.entries(DOMAIN_KEYWORDS)) {
            let score = 0;
            // Strong match in topic name → very high weight (10 pts each)
            score += kw.strong.filter(k => topicText.includes(k)).length * 10;
            // Weak match in topic name → medium weight (4 pts each)
            score += kw.weak.filter(k => topicText.includes(k)).length * 4;
            // Strong match in RAG sample → low weight (1 pt each)
            score += kw.strong.filter(k => ragSample.includes(k)).length * 1;
            scores[domain] = score;
        }

        const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
        const [bestDomain, bestScore] = sorted[0];
        const [secondDomain, secondScore] = sorted[1] || ['GENERAL', 0];

        if (bestScore === 0) return 'GENERAL';

        // MATH requires stronger evidence: must come from topic/task title (≥10 pts)
        // or have significant RAG evidence (≥6 pts) AND a clear gap over 2nd domain.
        // This prevents accidental MATH classification from generic words in RAG content.
        if (bestDomain === 'MATH') {
            const hasTopicSignal = bestScore >= 10; // At least 1 strong keyword in title
            const hasStrongRagSignal = bestScore >= 6 && (bestScore - secondScore) >= 3;
            if (!hasTopicSignal && !hasStrongRagSignal) return 'GENERAL';
        }

        return bestScore >= 4 ? bestDomain : 'GENERAL';
    }

    /**
     * Builds a hard domain-lock instruction block that prohibits off-domain questions.
     * @private
     */
    _buildDomainLockBlock(domain, topicName, taskName) {
        const DOMAIN_LABELS = {
            MATH: 'MATEMÁTICAS / ARITMÉTICA',
            SQL: 'SQL / BASES DE DATOS',
            PROGRAMMING: 'PROGRAMACIÓN / ALGORITMOS',
            PHYSICS: 'FÍSICA',
            CHEMISTRY: 'QUÍMICA',
            LANGUAGE: 'IDIOMAS / LENGUAJE',
            HISTORY: 'HISTORIA / CIENCIAS SOCIALES',
            ACCOUNTING: 'CONTABILIDAD / FINANZAS',
            BIOLOGY: 'BIOLOGÍA / CIENCIAS NATURALES',
            GENERAL: 'CONOCIMIENTO GENERAL (según el material)',
        };

        const FORBIDDEN_DOMAINS = {
            MATH: 'SQL, programación (Python/JS/Java/etc.), algoritmos de software, bases de datos, historia, idiomas. ESPECIALMENTE prohibido: algoritmos como Kahan, búsqueda binaria, QuickSort, BFS, DFS o cualquier pseudocódigo de programación.',
            SQL: 'matemáticas puras, física, química, historia, idiomas, código de programación que no sea SQL',
            PROGRAMMING: 'historia, idiomas básicos, ciencias puras sin relación al código',
            PHYSICS: 'programación, SQL, historia, idiomas, contabilidad, biología',
            CHEMISTRY: 'programación, SQL, historia, idiomas, matemáticas sin relación a la química',
            LANGUAGE: 'programación, SQL, matemáticas, física, química, biología',
            HISTORY: 'programación, SQL, matemáticas, física, química, biología',
            ACCOUNTING: 'programación, física, química, historia, idiomas',
            BIOLOGY: 'programación, SQL, historia, idiomas, contabilidad',
            GENERAL: '(ningún dominio específico prohibido — sigue el tema del material)',
        };

        const label = DOMAIN_LABELS[domain] || domain;
        const forbidden = FORBIDDEN_DOMAINS[domain] || '';
        const topicCtx = topicName ? `"${topicName}"${taskName ? ` → Tarea: "${taskName}"` : ''}` : '(ver material adjunto)';

        return `
🔒🔒🔒 BLOQUEO ABSOLUTO DE DOMINIO — REGLA NO NEGOCIABLE 🔒🔒🔒

El material de estudio pertenece EXCLUSIVAMENTE al dominio: ██ ${label} ██
Tema activo: ${topicCtx}

▶ TODOS los ejercicios deben pertenecer al dominio: ${label}
▶ PROHIBICIÓN TOTAL de ejercicios sobre: ${forbidden}

⚠️ ADVERTENCIA CRÍTICA: Si el material de referencia contiene ejemplos de ${forbidden} como contexto o analogía, IGNÓRALOS completamente para la generación de ejercicios. Solo genera ejercicios del dominio ${label}.

VERIFICACIÓN OBLIGATORIA antes de cada ejercicio:
  → Pregunta: "¿Este ejercicio es sobre ${label}?"
  → Si la respuesta es NO → DESCARTA el ejercicio y genera uno correcto del dominio ${label}.
  → Si el ejercicio menciona código, algoritmos de software, SQL, o lenguajes de programación y el dominio es MATH → DESCARTA y reemplaza.

🔒🔒🔒 FIN BLOQUEO DE DOMINIO 🔒🔒🔒`.trim();
    }

    /** @private Build system prompt based on difficulty and domain */
    _buildSystemPrompt(difficulty, targetCount, domain = 'GENERAL', isMathContent = false) {
        const groundingRule = `REGLA: Basa los ejercicios EXCLUSIVAMENTE en el material proporcionado. NO inventes información.`;

        // Domain-specific complexity rules conditioned on difficulty
        // GENERAL only gets math rules when the content has been explicitly identified as math
        const MATH_DOMAINS = ['MATH', 'PHYSICS', 'CHEMISTRY', 'ACCOUNTING'];
        const isMathRelevant = MATH_DOMAINS.includes(domain) || (domain === 'GENERAL' && isMathContent);

        // Anti-math preamble for non-math domains — injected into ALL difficulty levels
        const thematicPreamble = !isMathRelevant ? `
═══ REGLA TEMÁTICA OBLIGATORIA (TODAS LAS DIFICULTADES) ═══
Este material NO es de matemáticas (dominio: ${domain}).
PROHIBIDO generar ejercicios de: sumas, restas, multiplicaciones, divisiones,
ecuaciones, fracciones, series, integrales, derivadas, álgebra, geometría,
trigonometría, o CUALQUIER problema de cálculo numérico/aritmético.
Los ejercicios deben evaluar EXCLUSIVAMENTE la comprensión, análisis y
aplicación del contenido temático del material proporcionado.
Si el material contiene datos numéricos (fechas, cantidades, estadísticas),
úsalos como CONTEXTO informativo, NO como problemas matemáticos a resolver.
═══════════════════════════════════════════════════════════
` : '';

        const difficultyInstructions = {
            EASY: `NIVEL INTRODUCTORIO: ejercicios de comprensión y práctica básica sobre el CONTENIDO del material. Preguntas conceptuales, de definición, identificación y comprensión. Usa "¿Por qué?", "¿Para qué?", "¿Qué pasaría si...?" para preguntas; ejercicios directos y sencillos sobre la temática del material.${thematicPreamble}`,
            INTERMEDIATE: `NIVEL INTERMEDIO: ejercicios de análisis y aplicación sobre el CONTENIDO del material. Escenarios prácticos multi-paso, resolución de problemas contextualizados DENTRO del dominio ${domain}. El estudiante debe ANALIZAR, DECIDIR y APLICAR conocimientos en situaciones con 2-3 variables o pasos de razonamiento.${thematicPreamble}`,
            HARD: `NIVEL EXPERTO — COMPLEJIDAD MÁXIMA ABSOLUTA (NO NEGOCIABLE):

══ PASO 0 OBLIGATORIO: ANÁLISIS DE DOMINIO ══
ANTES de generar cualquier ejercicio:
1. Identifica el DOMINIO CENTRAL del material (matemáticas, SQL, programación, física, idiomas, contabilidad, etc.)
2. Identifica los CONCEPTOS MÁS AVANZADOS presentes en el material
3. Lleva esos conceptos a su EXPRESIÓN PRÁCTICA MÁS COMPLEJA posible
TODOS los ejercicios deben estar al nivel de complejidad máxima de ese dominio.

══ REGLA ABSOLUTA: CERO EJERCICIOS TRIVIALES ══
Si un ejercicio puede resolverse en menos de 30 segundos de pensamiento activo → DESCÁRTALO.
Si un ejercicio involucra solo UNA operación, UN paso, o UNA consulta simple → es INACEPTABLE.
CADA ejercicio HARD debe requerir MÍNIMO 3 pasos de razonamiento encadenados.

REGLAS POR DOMINIO (OBLIGATORIAS):
- MATEMÁTICAS: Usa números GRANDES y operaciones COMPUESTAS. Si el tema es sumas, genera sumas de 7+ dígitos (ej: 1023232 + 12213123), sumas encadenadas de 4+ números, sumas con decimales extensos, sumatorias con notación Σ, sumas de series geométricas/aritméticas, sumas de matrices. PROHIBIDO: sumas de 1-3 dígitos como "24+18" o "234+567". Para álgebra: sistemas de ecuaciones, ecuaciones cuadráticas, derivadas, integrales. PROHIBIDO: ecuaciones lineales de un paso.
- SQL/BASES DE DATOS: JOINs múltiples (≥2 tablas), subconsultas correlacionadas, funciones de ventana (OVER, PARTITION BY, RANK, ROW_NUMBER, LAG, LEAD), CTEs (WITH/WITH RECURSIVE), GROUP BY con HAVING, CASE WHEN anidados. PROHIBIDO: SELECT simple, WHERE sin JOIN, consultas de una sola tabla.
- PROGRAMACIÓN: Algoritmos con análisis de complejidad O(n log n), recursión con memoización, programación dinámica, grafos (BFS/DFS/Dijkstra), patrones de diseño, concurrencia. PROHIBIDO: sintaxis básica, Hello World, bucles for simples, console.log.
- FÍSICA/QUÍMICA: Problemas con 3+ fórmulas encadenadas, circuitos RC/RL/RLC, termodinámica de procesos reales, equilibrio químico multi-etapa. PROHIBIDO: F=ma de un solo paso, conversiones simples.
- IDIOMAS: Gramática avanzada (subjuntivo compuesto, condicionales mixtos tipo 3, inversión estilística), análisis pragmático, traducción técnica. PROHIBIDO: present simple, vocabulario básico.
- CONTABILIDAD/FINANZAS: Asientos compuestos multi-cuenta, análisis de ratios encadenados, flujo de caja descontado. PROHIBIDO: asientos simples de una cuenta.
- CUALQUIER OTRO DOMINIO: Identifica el concepto central y pregúntate: "¿Un profesional con 5 años de experiencia encontraría este ejercicio desafiante?" Si NO → hazlo más complejo.

══ AUTO-VALIDACIÓN OBLIGATORIA ══
Antes de incluir CADA ejercicio en el JSON, verifica:
✓ ¿Requiere 3+ pasos de razonamiento? Si NO → RECHAZAR.
✓ ¿Un estudiante de primer semestre podría resolverlo en 10 segundos? Si SÍ → RECHAZAR.
✓ ¿Involucra solo una operación/concepto aislado? Si SÍ → RECHAZAR.
✓ ¿Es del nivel más avanzado posible dentro del dominio? Si NO → escalar complejidad.

${['MATH', 'PHYSICS', 'CHEMISTRY', 'ACCOUNTING', 'GENERAL'].includes(domain) ? `══ VERIFICACIÓN MATEMÁTICA RIGUROSA (OBLIGATORIA) ══
⚠️ NO asumas que tu primer cálculo es correcto. DEBES hacer doble verificación:
1. Realiza el cálculo paso a paso.
2. VERIFICA el resultado repitiendo el cálculo con un método diferente (ej: suma en orden inverso, descomposición, etc.).
3. Si el resultado de la verificación NO coincide → REHAZ el cálculo desde cero.
4. Si el cálculo es demasiado complejo para tu ventana de contexto (>8 dígitos, >5 operandos), SIMPLIFICA los números pero AUMENTA la complejidad del razonamiento lógico (más pasos, conversiones, redondeo).
5. PROHIBIDO generar respuestas con más de 8 dígitos significativos en fill_in_blank. Si el resultado natural tiene más, redondea y pide el resultado redondeado explícitamente.
6. La explicación DEBE mostrar EXACTAMENTE los mismos pasos que producen el correctAnswer. Si hay discrepancia → la pregunta es INVÁLIDA.

══ REGLAS ESPECÍFICAS POR TIPO DE OPERACIÓN MATEMÁTICA ══

▸ FRACCIONES:
  - NUNCA sumes numeradores y denominadores directamente. 3/8 + 1/9 ≠ 4/17.
  - SIEMPRE busca el MCM de los denominadores primero.
  - Ejemplo correcto: 3/8 + 1/9 = 27/72 + 8/72 = 35/72.
  - SIEMPRE simplifica el resultado usando MCD.
  - Si la respuesta es una fracción, escríbela como "numerador/denominador" (ej: "35/72").

▸ EXPONENCIACIÓN / POTENCIAS:
  - NUNCA inventes el resultado de a^b. CALCULA paso a paso.
  - Para bases decimales con exponentes >10 (ej: 2.8^40), el resultado tiene órdenes de magnitud enormes.
  - VERIFICA: log₁₀(resultado) ≈ exponente × log₁₀(base). Ej: log₁₀(2.8^40) = 40 × log₁₀(2.8) ≈ 40 × 0.447 ≈ 17.88, o sea ≈ 10^17.88.
  - Si no puedes calcular el resultado exacto, pide el resultado en notación científica.
  - PROHIBIDO: generar números "plausibles" sin calcularlos. Un error de 7 órdenes de magnitud es inaceptable.

▸ SERIES GEOMÉTRICAS:
  - S_n = a₁ × (r^n − 1) / (r − 1). NUNCA sumes los primeros términos manualmente si n > 5.
  - VERIFICA la magnitud: si r > 1, el resultado crece exponencialmente.
  - Si las opciones no reflejan la magnitud correcta → la pregunta es INVÁLIDA.

▸ OPERACIONES CON DECIMALES:
  - Alinea siempre por el punto decimal.
  - Verifica el número de decimales en el resultado.
  - 45.67 + 128.3 = 173.97, NO 173.70 ni 174.0.

▸ PREGUNTAS DE POSICIÓN DE DÍGITOS:
  - Si preguntas "¿cuál es el dígito en la posición de las centenas?", la respuesta SIEMPRE es un solo dígito (0-9).
  - NUNCA generes una explicación con operaciones aritméticas como "0-9 = -9". Eso NO TIENE SENTIDO.
  - La explicación DEBE mostrar: 1) El resultado numérico calculado, 2) Las posiciones: unidades, decenas, centenas, miles, etc., 3) El dígito exacto en la posición solicitada.
  - Ejemplo correcto: "29,999,999 → posición de decenas de millón → dígito 2".
  - PROHIBIDO confundir posiciones: unidades=10⁰, decenas=10¹, centenas=10², miles=10³, decenas de mil=10⁴, centenas de mil=10⁵, unidades de millón=10⁶, decenas de millón=10⁷.` : `══ DOMINIO NO MATEMÁTICO — PROHIBICIÓN DE EJERCICIOS MATEMÁTICOS ══
Este material pertenece al dominio: ${domain}.
🚫 PROHIBIDO TOTAL generar ejercicios de cálculo aritmético, álgebra, ecuaciones, fracciones, series,
integrales, derivadas, sumas/restas/multiplicaciones/divisiones de números, geometría, trigonometría,
o CUALQUIER tipo de problema matemático puro.
Los ejercicios deben evaluar EXCLUSIVAMENTE la comprensión, análisis y aplicación del contenido
del material proporcionado dentro del dominio ${domain}.
Si necesitas incluir datos numéricos, úsalos como CONTEXTO (fechas, cantidades históricas, estadísticas),
NO como problemas a resolver.`}

══ CALIDAD DE DISTRACTORES (multiple_choice) ══
⚠️ NUNCA generes opciones con el mismo valor numérico o la misma explicación.
Cada distractor DEBE representar un error conceptual plausible:
${['MATH', 'PHYSICS', 'CHEMISTRY', 'ACCOUNTING', 'GENERAL'].includes(domain) ? `- Error de acarreo (ej: olvidar llevar 1 en una suma)
- Error de fórmula (ej: usar suma en vez de resta)
- Error de redondeo (ej: redondear hacia arriba vs abajo)
- Error de orden de operaciones (ej: sumar antes de multiplicar)` : `- Confusión de conceptos similares dentro del dominio ${domain}
- Información parcialmente correcta pero incompleta
- Inversión de causa y efecto
- Generalización excesiva o aplicación incorrecta de un principio`}
Si NO puedes generar 3 distractores plausibles y DISTINTOS → convierte la pregunta a fill_in_blank.
VERIFICACIÓN: Las 4 opciones DEBEN ser valores DIFERENTES entre sí. Si dos opciones son iguales → la pregunta es INVÁLIDA.

══ PRECISION EN fill_in_blank ══
- PROHIBIDO pedir respuestas con más de 2 decimales. Si el resultado tiene más decimales, pide explícitamente que redondeen (ej: "redondea a 2 decimales").
- PROHIBIDO pedir números de más de 8 dígitos sin separadores. Si el resultado es grande, permite separadores o pide el resultado en notación simplificada.
- La respuesta correcta (correctAnswer) NUNCA debe incluir separadores de miles (comas, puntos). Solo dígitos y opcionalmente un punto decimal.
- "Difícil" NO significa "números más largos". Significa mayor PROFUNDIDAD COGNITIVA: más pasos, conversiones, análisis de casos, redondeo estratégico.`,
            FREE: `Genera ejercicios variados que cubran TODO el contenido. Mezcla niveles: comprensión, análisis, aplicación y creación.`,
        };

        const hardComplexityOverrides = difficulty === 'HARD' ? `
══════════════════════════════════════════════════
REGLAS DE COMPLEJIDAD MÁXIMA PARA NIVEL HARD
══════════════════════════════════════════════════
DETECTA el dominio del material y aplica estas reglas SIN EXCEPCIÓN:
${isMathRelevant ? `
▸ MATEMÁTICAS / CÁLCULO:
  - fill_in_blank: ecuaciones cuadráticas (x²+5x-6=0, x=___), derivadas (d/dx[x³·ln(x)] = ___), integrales definidas, optimización (máximo/mínimo), sistemas 2×2 o 3×3.
  - ordering: pasos completos de demostración matemática o resolución de ecuaciones complejas.
  - multiple_choice: análisis de comportamiento de funciones, convergencia de series, interpretación gráfica de derivadas.
  - PROHIBIDO: "Resuelve: 234 + 567 = ___" o cualquier aritmética pura.
` : `
▸ ⚠️ ESTE MATERIAL NO ES DE MATEMÁTICAS (dominio: ${domain}) ⚠️
  - NO generes ejercicios de cálculo, aritmética, álgebra, ecuaciones, series, integrales ni derivadas.
  - Si el material contiene números o datos cuantitativos, úsalos como CONTEXTO, no como problemas a resolver.
  - Concentra TODOS los ejercicios en el contenido conceptual del dominio ${domain}.
`}
▸ SQL / BASES DE DATOS:
  - fill_in_blank: completar CTEs, cláusulas WINDOW, subconsultas correlacionadas, GROUP BY + HAVING complejos.
  - ordering: pasos de optimización de consulta, diseño de índices, plan de ejecución.
  - multiple_choice: análisis de planes de ejecución, normalización avanzada (3NF vs BCNF), estrategias de indexación, transacciones ACID, aislamiento.
  - PROHIBIDO: "SELECT * FROM tabla WHERE id = ___" o cualquier consulta trivial sin JOIN.

▸ PROGRAMACIÓN:
  - fill_in_blank: completar algoritmos recursivos, implementar funciones de complejidad O(n log n), resolver casos de recursión mutua, completar implementaciones de estructuras de datos.
  - ordering: pasos de un algoritmo complejo (QuickSort, BFS/DFS, programación dinámica).
  - multiple_choice: analizar complejidad temporal/espacial de un fragmento de código dado, identificar patrones de diseño, razonar sobre condiciones de carrera o deadlocks.

▸ FÍSICA / QUÍMICA:
  - fill_in_blank: problemas donde se encadenan 3+ fórmulas, análisis de circuitos RC/RL, equilibrio químico con Kp/Kc, termodinámica (ΔG=ΔH-TΔS).
  - ordering: pasos de análisis de un sistema físico complejo o reacción en varias etapas.
  - multiple_choice: interpretación de diagramas de fases, análisis de errores experimentales, predicción de comportamiento de sistemas.

▸ IDIOMAS (inglés, francés, etc.):
  - fill_in_blank: subjuntivo presente/pasado, condicionales mixtos (3rd conditional rewrite), voz pasiva en tiempos perfectos, verbos modales perfectos (should have, must have).
  - ordering: reordenar párrafos argumentativos, reconstruir secuencia de eventos en voz pasiva.
  - multiple_choice: análisis de registro formal/informal, corrección de errores sutiles en párrafos técnicos.

▸ HISTORIA / CIENCIAS SOCIALES:
  - fill_in_blank: completar análisis causal de eventos históricos, fechas clave en contexto, citas de documentos primarios.
  - ordering: secuencia cronológica de eventos complejos, cadenas causales multi-factor.
  - multiple_choice: análisis crítico de interpretaciones históricas, comparación de movimientos sociales, evaluación de fuentes primarias vs secundarias.

▸ BIOLOGÍA / CIENCIAS NATURALES:
  - fill_in_blank: completar procesos celulares complejos, cadenas metabólicas, nomenclatura avanzada.
  - ordering: etapas de procesos biológicos multi-paso (mitosis, ciclo de Krebs, transcripción-traducción).
  - multiple_choice: análisis de experimentos, predicción de resultados genéticos, interpretación de datos ecológicos.

REGLA UNIVERSAL HARD: Si puedes describir el ejercicio en una línea simple, NO es suficientemente complejo. El enunciado del ejercicio HARD debe presentar un escenario real y requerir análisis profundo.

▸ REGLA DE ESCALADO POR DOMINIO (APLICA A CUALQUIER TEMA):
  - Identifica el NÚCLEO del contenido RAG.
  - Pregúntate: "¿Cuál es la versión más avanzada y profesional de aplicar este conocimiento DENTRO DEL MISMO DOMINIO?"
  - Genera ejercicios a ESE nivel DENTRO del dominio ${domain}. NUNCA cambies de dominio.
  ${isMathRelevant ? `Ejemplos:
    * Tema "sumas" → sumatorias Σ, series geométricas, sumas parciales, sumas de Riemann` : `Ejemplos:
    * Tema de historia → análisis multicausal, comparación de fuentes primarias, evaluación historiográfica`}
    * Tema "variables en Python" → closures, scope chains, generadores, decoradores con estado
    * Tema "SELECT en SQL" → window functions con PARTITION BY, CTEs recursivos, subconsultas correlacionadas
    * Tema "fuerzas en física" → sistemas de poleas con fricción, planos inclinados con resortes
    * Tema "present tense" en inglés → present perfect continuous vs simple, inversión estilística
    * Tema "contabilidad básica" → asientos de ajuste con depreciación, amortización, provisiones

▸ AUTO-CHECK FINAL (OBLIGATORIO antes de emitir el JSON):
  Para cada ejercicio, verifica mentalmente:
  1. ¿El ejercicio pertenece al dominio ${domain}? Si NO → DESCÁRTALO y genera uno del dominio correcto. ✓
  2. ¿Requiere combinar 2+ conceptos del material? ✓
  3. ¿Un profesional del área tardaría >30 segundos en resolverlo? ✓
  Si algún ejercicio no cumple los 3 puntos, REEMPLÁZALO por uno más complejo del dominio ${domain}.
══════════════════════════════════════════════════
` : '';

        const exerciseTypeInstructions = `
TIPOS DE EJERCICIOS DISPONIBLES (usa "type" para identificar cada uno):

1. "multiple_choice" — Pregunta de opción múltiple clásica.
   Campos: { type: "multiple_choice", question, options (array de 4), correctIndex (0-3), explanation }

2. "fill_in_blank" — Ejercicio PRÁCTICO donde el estudiante resuelve y escribe la respuesta.
   OBLIGATORIO para: ${isMathRelevant ? 'cálculos matemáticos, resolver operaciones, ' : ''}completar código, completar frases, traducciones, respuestas conceptuales.
   Campos: { type: "fill_in_blank", question (usa "___" para marcar el espacio), correctAnswer (string), hint (pista opcional), explanation }
   ${isMathRelevant ? `Ejemplos por dominio y dificultad:
   EASY:
   - Matemáticas: { type: "fill_in_blank", question: "Resuelve: 24 + 18 = ___", correctAnswer: "42", hint: "Suma las unidades primero", explanation: "24 + 18 = 42" }
   INTERMEDIATE:
   - Matemáticas: { type: "fill_in_blank", question: "Resuelve: 4,827 + 3,695 = ___", correctAnswer: "8522", hint: "Suma columna por columna con acarreo", explanation: "7+5=12 (lleva 1), 2+9+1=12 (lleva 1), 8+6+1=15 (lleva 1), 4+3+1=8. Resultado: 8,522" }
   HARD (COMPLEJIDAD MÁXIMA — los ejemplos para HARD son los que debes seguir):
   - Matemáticas/Suma: { type: "fill_in_blank", question: "Una empresa tiene 3 sucursales con ventas mensuales de $45,230, $78,945 y $63,120. Calcula el total de ventas y luego aplica un impuesto del 16%. ¿Cuál es el monto total con impuesto? (redondea a entero)", correctAnswer: "217422", hint: "Primero suma las 3 cantidades, luego multiplica por 1.16", explanation: "Paso 1: 45230 + 78945 + 63120 = 187295. Paso 2: 187295 × 1.16 = 217262.2 → redondeado: 217262. VERIFICACIÓN: 187295 × 0.16 = 29967.2, + 187295 = 217262." }
   - Matemáticas/Álgebra: { type: "fill_in_blank", question: "Sea f(x) = x³ - 6x² + 9x + 2. Encuentra el valor de x donde ocurre el mínimo local. f'(x) = 0 cuando x = ___ (entero positivo)", correctAnswer: "3", hint: "Deriva y factoriza: f'(x)=3x²-12x+9=3(x-1)(x-3)", explanation: "f'(x)=3x²-12x+9=0 → x=1 (máximo local) y x=3 (mínimo local). VERIFICACIÓN: f''(x)=6x-12, f''(3)=6>0 confirma mínimo local. f(3)=27-54+27+2=2." }` : `Ejemplos por dominio y dificultad:
   EASY:
   - General: { type: "fill_in_blank", question: "El proceso por el cual las plantas convierten la luz solar en energía se llama ___", correctAnswer: "fotosíntesis", hint: "Es un proceso que ocurre en los cloroplastos", explanation: "La fotosíntesis es el proceso por el cual las plantas convierten CO₂ y H₂O en glucosa usando luz solar." }
   INTERMEDIATE:
   - General: { type: "fill_in_blank", question: "En el contexto de la Segunda Guerra Mundial, el desembarco aliado en Normandía el 6 de junio de 1944 se conoce como ___", correctAnswer: "Día D", hint: "Es una letra del alfabeto seguida de su nombre", explanation: "El Día D (D-Day) fue la operación Overlord, el mayor desembarco anfibio de la historia." }
   HARD:
   - General: { type: "fill_in_blank", question: "Según el material proporcionado, el concepto clave que se aplica en este contexto es ___", correctAnswer: "(basado en el material RAG)", hint: "Revisa el material de referencia", explanation: "Basado en el contenido del material proporcionado." }`}
   - SQL: { type: "fill_in_blank", question: "Completa la función de ventana para calcular el salario acumulado por departamento:\nSELECT nombre, departamento, salario,\n  ___(salario) OVER (PARTITION BY departamento ORDER BY fecha_contratacion) AS salario_acum\nFROM empleados;", correctAnswer: "SUM", hint: "Función de agregado que suma progresivamente", explanation: "SUM() OVER(PARTITION BY ... ORDER BY ...) calcula una suma acumulada (running total) dentro de cada partición." }
   - Programación: { type: "fill_in_blank", question: "Completa la búsqueda binaria recursiva:\nfunction binarySearch(arr, target, lo, hi) {\n  if (lo > hi) return -1;\n  const mid = Math.floor((lo + hi) / 2);\n  if (arr[mid] === target) return mid;\n  if (arr[mid] < target) return binarySearch(arr, target, ___, hi);\n  return binarySearch(arr, target, lo, mid - 1);\n}", correctAnswer: "mid + 1", hint: "Si el elemento del medio es menor, busca en la mitad derecha", explanation: "Si arr[mid] < target, el objetivo está en [mid+1, hi]. Pasar lo=mid+1 descarta la mitad izquierda." }
   ${isMathRelevant ? `- Física: { type: "fill_in_blank", question: "Un proyectil se lanza a 30° con v₀=40m/s. Su alcance horizontal R = v₀²·sin(2θ)/g = ___ m (g=10m/s², sin(60°)≈0.866)", correctAnswer: "138.56", hint: "R=1600·0.866/10", explanation: "R = (40²·sin(60°))/10 = (1600·0.866)/10 ≈ 138.56 m" }` : ''}

3. "ordering" — Ordenar elementos en la secuencia correcta.
   Ideal para: pasos de un algoritmo, líneas de código, procesos complejos, pasos de demostración.
   Campos: { type: "ordering", question, items (array EN ORDEN CORRECTO — el servidor los baraja automáticamente), correctOrder: [0,1,2,...] (siempre identidad — el servidor lo recalcula), explanation }
   IMPORTANTE: Proporciona los items YA EN SU ORDEN CORRECTO y pon correctOrder como [0,1,2,...]. El servidor los baraja automáticamente y recalcula los índices.

   ⚠️ REGLA CRÍTICA DE CONSISTENCIA — OBLIGATORIA:
   La explanation NUNCA debe mencionar un número de pasos, fases o etapas distinto al número real de items.
   Si tienes 5 items, la explanation DEBE decir "5 pasos" o simplemente no enumerar. NUNCA escribas "4 fases" si hay 5 items.
   VERIFICA: cuenta los items y asegúrate de que la explanation sea coherente antes de emitir el JSON.

   ${isMathRelevant ? `⚠️ REGLA PEDAGÓGICA PARA ARITMÉTICA CON DECIMALES — OBLIGATORIA:
   La "coma decimal" (o "punto decimal") en operaciones de suma/resta con decimales se coloca PRIMERO, junto con la alineación.
   NUNCA debe aparecer como paso final. El orden correcto es SIEMPRE:
     PASO 1 (PRIMERO): Alinear los números verticalmente por la coma decimal Y marcar la posición de la coma en el resultado.
     PASOS 2…N: Operar columna por columna de derecha a izquierda (centésimas → décimas → unidades → decenas…).
     ÚLTIMO PASO: Escribir o verificar el resultado completo.
   PROHIBIDO: "Bajar la coma decimal", "Colocar la coma decimal" o equivalentes como PASO FINAL.

   Ejemplo EASY (enteros): { type: "ordering", question: "Ordena los pasos para resolver 234 + 178", items: ["Sumar unidades: 4+8=12, escribir 2, llevar 1", "Sumar decenas: 3+7+1=11, escribir 1, llevar 1", "Sumar centenas: 2+1+1=4", "Obtener resultado: 412"], correctOrder: [0, 1, 2, 3], explanation: "Se suman 4 columnas de derecha a izquierda propagando el acarreo." }
   Ejemplo EASY (decimales): { type: "ordering", question: "Ordena los pasos para sumar 45.67 + 128.3", items: ["Alinear los números por la coma decimal y marcar su posición en el resultado", "Sumar centésimas: 7+0=7", "Sumar décimas: 6+3=9", "Sumar unidades: 5+8=13, escribir 3, llevar 1", "Sumar decenas y centenas con acarreo; resultado final: 173.97"], correctOrder: [0, 1, 2, 3, 4], explanation: "5 pasos: la coma decimal se fija PRIMERO por alineación; luego se opera columna por columna de derecha a izquierda." }` : ''}
   Ejemplo HARD: { type: "ordering", question: "Ordena los pasos de QuickSort para el arreglo [3,8,1,5,2,7]", items: ["Seleccionar pivote (ej: 5)", "Particionar: [3,1,2] [5] [8,7]", "Recursión izquierda: [1,2,3]", "Recursión derecha: [7,8]", "Combinar: [1,2,3,5,7,8]"], correctOrder: [0, 1, 2, 3, 4], explanation: "5 pasos — QuickSort: selecciona pivote, particiona O(n), aplica recursión en cada mitad. Complejidad promedio O(n log n)." }

DECISIÓN INTELIGENTE DE TIPOS — PRIORIZA EJERCICIOS PRÁCTICOS:
- PRIMERO identifica el DOMINIO del tema/tarea (matemáticas, programación, idiomas, ciencias, etc.)
- SEGUNDO decide qué tipos de ejercicios MIDEN MEJOR la competencia del estudiante en ese dominio.
- PRINCIPIO CLAVE: Si el tema involucra HACER (calcular, resolver, programar, escribir), usa "fill_in_blank" para que el estudiante HAGA, no solo elija respuestas.

REGLAS POR DOMINIO (AJUSTA COMPLEJIDAD según dificultad seleccionada):
${isMathRelevant ? `- MATEMÁTICAS: MÍNIMO 5 de ${targetCount} deben ser "fill_in_blank". Escala de complejidad: EASY (1-2 dígitos: 3+5), INTERMEDIATE (3-4 dígitos: 4827+3695), HARD (7+ dígitos, 3+ operandos, operaciones mezcladas: 1023232+12213456+987654, o sumatorias Σ, series, sistemas de ecuaciones, derivadas, integrales). PROHIBIDO EN HARD: sumas de menos de 5 dígitos o de solo 2 números simples.
- CIENCIAS: MÍNIMO 3 "fill_in_blank" con problemas multi-fórmula. HARD: 3+ ecuaciones encadenadas. NUNCA cálculos de un solo paso.` : `- ⚠️ DOMINIO ${domain}: NO generes ejercicios matemáticos. TODOS los ejercicios deben ser sobre el contenido del material.`}
- SQL/BASES DE DATOS: MÍNIMO 4 "fill_in_blank". EASY: SELECTs con WHERE. INTERMEDIATE: JOINs simples, GROUP BY. HARD: CTEs, window functions, subconsultas correlacionadas — NUNCA SELECTs sin JOIN.
- PROGRAMACIÓN: MÍNIMO 4 "fill_in_blank" para completar código, 2 "ordering" para algoritmos. HARD: algoritmos avanzados (recursión, grafos, programación dinámica), análisis de complejidad. NUNCA sintaxis básica.
- IDIOMAS: MÍNIMO 4 "fill_in_blank". HARD: gramática avanzada (subjuntivo, condicionales mixtos), traducción técnica. NUNCA vocabulario básico.
- HISTORIA, SOCIALES: 2-3 "ordering" para causalidad compleja, resto "multiple_choice" para análisis crítico.
- BIOLOGÍA, NATURALES: MÍNIMO 3 "fill_in_blank" con procesos multi-etapa, 2 "ordering" para secuencias biológicas.
- OTROS DOMINIOS: MÍNIMO 3 "fill_in_blank", 1-2 "ordering". HARD: Lleva el tema a su expresión práctica más compleja y profesional.

REGLAS DE CALIDAD:
- Los ejercicios fill_in_blank deben tener UNA sola respuesta correcta clara y verificable.
- Para ordering, provee entre 4 y 6 items con secuencias no triviales.
- NO varíes la dificultad internamente en un set HARD — mantén la complejidad máxima en TODOS los ejercicios.
- Contextualiza: en HARD usa escenarios del mundo profesional, no de aula básica.

REGLA CRÍTICA DE LONGITUD EN OPCIONES (multiple_choice) — ANTI-SESGO DE LONGITUD:
- TODAS las opciones DEBEN tener longitud MUY SIMILAR (máximo 15% de diferencia en caracteres entre la más corta y la más larga).
- La respuesta correcta NUNCA debe ser más larga, más detallada ni más elaborada que las incorrectas.
- Si la respuesta correcta necesita ser específica, haz que TODAS las opciones sean IGUALMENTE específicas y detalladas.
- PROHIBIDO ABSOLUTO: opciones cortas como distractores y la correcta larga/detallada.
- TÉCNICA OBLIGATORIA: Escribe PRIMERO la respuesta correcta con el nivel de detalle necesario. Luego escribe CADA distractor con el MISMO nivel de detalle, la MISMA estructura gramatical y longitud SIMILAR.
- VERIFICACIÓN: Antes de finalizar cada pregunta multiple_choice, CUENTA los caracteres de cada opción. Si alguna difiere más de 15% del promedio, REESCRIBE las opciones.

DISTRIBUCIÓN OBLIGATORIA DE TIPOS:
- SIEMPRE incluye AL MENOS 3 ejercicios "fill_in_blank" y AL MENOS 1 "ordering" en cada set de ${targetCount}.
- NUNCA generes SOLO preguntas "multiple_choice". La variedad es OBLIGATORIA.
`;

        return `Eres un profesor experto de nivel universitario/profesional diseñando ${targetCount} ejercicios de evaluación.
${difficultyInstructions[difficulty] || difficultyInstructions.HARD}
${groundingRule}
${hardComplexityOverrides}
${exerciseTypeInstructions}
PROHIBIDO ejercicios de memorización pura o de un solo paso trivial. El estudiante debe RAZONAR, ANALIZAR y CONSTRUIR soluciones complejas.
La explicación debe ser detallada y educativa, mostrando el procedimiento completo de resolución.
REGLA ANTI-SESGO: En preguntas de opción múltiple, TODAS las opciones DEBEN tener la MISMA longitud y estructura. Escribe PRIMERO la correcta, luego iguala CADA distractor en largo y detalle. La respuesta correcta NUNCA debe ser la más larga. VERIFICA contando caracteres.
FORMATO: JSON array con los campos según el type de cada ejercicio.`;
    }

    /** @private Validate and normalize a single parsed question/exercise object */
    _normalizeQuestion(q) {
        if (!q || typeof q.question !== 'string' || q.question.trim().length < 5) return null;
        const type = String(q.type || 'multiple_choice').trim().toLowerCase();

        switch (type) {
            case 'fill_in_blank': {
                let correctAnswer = String(q.correctAnswer ?? q.correct_answer ?? '').trim();
                if (!correctAnswer) return null;

                // Normalize numeric answers: strip thousand separators only.
                // DO NOT truncate decimals here — QuizMathValidator.verify() runs
                // after normalization and will compute the correct precision.
                // Truncating to 2 decimals caused 2777.778 → 2777.78 (wrong).
                const numericClean = correctAnswer.replace(/,/g, '').replace(/\s/g, '');
                const numericVal = Number(numericClean);
                if (Number.isFinite(numericVal) && /^-?\d/.test(numericClean)) {
                    // Strip thousand separators from correct answer (always store as plain digits)
                    correctAnswer = numericClean;
                }

                return {
                    type: 'fill_in_blank',
                    question: q.question.trim(),
                    correctAnswer,
                    hint: String(q.hint ?? '').trim() || null,
                    explanation: String(q.explanation ?? '').trim() || `La respuesta correcta es: "${correctAnswer}"`,
                };
            }
            case 'ordering': {
                const rawItems = Array.isArray(q.items) ? q.items.map(i => String(i ?? '').trim()).filter(Boolean) : [];
                const rawCorrectOrder = Array.isArray(q.correctOrder ?? q.correct_order)
                    ? (q.correctOrder ?? q.correct_order).map(Number)
                    : [];
                if (rawItems.length < 3) return null;

                // Semantic validation: catches LLM procedural errors
                // (e.g. "coma decimal" as independent step when it's part of alignment)
                const validation = OrderingQuestionValidator.validateQuestion(q.question, rawItems);
                if (!validation.valid) {
                    console.warn(`[ReinforcementService] Ordering question rejected by semantic validator: ${validation.reason} — "${q.question.substring(0, 60)}..."`);
                    return null;
                }
                const validatedItems = validation.items;
                if (validation.corrections?.length > 0) {
                    console.log(`🔧 [ReinforcementService] Ordering corrections applied: ${validation.corrections.join('; ')}`);
                }

                // Recalculate correctOrder as identity since validator already fixed item order
                const validatedCorrectOrder = validatedItems.map((_, i) => i);

                // Server-side shuffle: fixes LLM indexing errors
                const fixed = QuizMathValidator.fixOrderingQuestion(validatedItems, validatedCorrectOrder);
                if (!fixed) return null;
                const llmExplanation = String(q.explanation ?? '').trim();
                // Detect and log explanation ↔ correctOrder inconsistencies
                const sanitized = QuizMathValidator._stripOrderingClaims(llmExplanation);
                if (sanitized.length < llmExplanation.length * 0.7) {
                    console.warn(`⚠️ [ReinforcementService] Ordering explanation inconsistency detected — stripped conflicting ordering claims: "${q.question.substring(0, 60)}..."`);
                }
                return {
                    type: 'ordering',
                    question: q.question.trim(),
                    items: fixed.items,
                    correctOrder: fixed.correctOrder,
                    explanation: QuizMathValidator.buildOrderingExplanation(fixed.correctSequence, llmExplanation),
                };
            }
            default: {
                // multiple_choice — architecture requires exactly 4 options
                if (!Array.isArray(q.options) || q.options.length < 4) return null;
                const correctIndex = Number(q.correctIndex ?? q.correct_index ?? 0);
                if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= q.options.length) {
                    // Try to recover: find correct answer by text in explanation
                    console.warn(`[ReinforcementService] correctIndex=${q.correctIndex} out of range (options.length=${q.options.length}) for: "${q.question.substring(0, 60)}..." — rejecting`);
                    return null;
                }
                const options = q.options.map(o => String(o ?? '').trim());

                // Anti-length-bias: equalize all option lengths
                const optionLens = options.map(o => o.length);
                const avgLen = optionLens.reduce((a, b) => a + b, 0) / optionLens.length;
                const correctLen = options[correctIndex].length;
                const maxOtherLen = Math.max(...options.filter((_, i) => i !== correctIndex).map(o => o.length));

                // If correct answer is >40% longer than the average of others, trim it
                if (avgLen > 0 && correctLen > avgLen * 1.4) {
                    console.warn(`[ReinforcementService] Length bias detected: correct="${options[correctIndex].substring(0, 40)}..." (${correctLen} chars) vs avg (${Math.round(avgLen)} chars). Equalizing.`);
                    const targetLen = Math.round(Math.max(maxOtherLen, avgLen * 1.1));
                    if (correctLen > targetLen) {
                        const trimmed = options[correctIndex].substring(0, targetLen);
                        // Find a natural break point (comma, period, dash, 'porque', 'ya que')
                        const breakPoints = [
                            trimmed.lastIndexOf(','),
                            trimmed.lastIndexOf('.'),
                            trimmed.lastIndexOf(' -'),
                            trimmed.lastIndexOf(' porque'),
                            trimmed.lastIndexOf(' ya que'),
                            trimmed.lastIndexOf(' debido'),
                        ].filter(p => p > targetLen * 0.4);
                        const bestBreak = breakPoints.length > 0 ? Math.max(...breakPoints) : -1;
                        if (bestBreak > 0) {
                            options[correctIndex] = options[correctIndex].substring(0, bestBreak).trim();
                        } else {
                            // Trim to last complete word within target length
                            const lastSpace = trimmed.lastIndexOf(' ');
                            if (lastSpace > targetLen * 0.5) {
                                options[correctIndex] = options[correctIndex].substring(0, lastSpace).trim();
                            }
                        }
                    }
                }

                // Anti-duplicate-options: reject if options are not all unique
                const uniqueOpts = new Set(options.map(o => o.toLowerCase().replace(/[^a-záéíóúñü0-9]/g, '').trim()));
                if (uniqueOpts.size < options.length) {
                    console.warn(`[ReinforcementService] Duplicate options detected in: "${q.question.substring(0, 60)}..." — rejecting question`);
                    return null;
                }

                // Anti-duplicate numeric options: for numeric-looking options, compare values
                const numericOpts = options.map(o => {
                    const cleaned = o.replace(/[^0-9.\-]/g, '');
                    const n = Number(cleaned);
                    return cleaned && Number.isFinite(n) ? n : null;
                });
                if (numericOpts.every(n => n !== null)) {
                    const uniqueNums = new Set(numericOpts);
                    if (uniqueNums.size < numericOpts.length) {
                        console.warn(`[ReinforcementService] Duplicate numeric option values in: "${q.question.substring(0, 60)}..." — rejecting question`);
                        return null;
                    }
                }

                return {
                    type: 'multiple_choice',
                    question: q.question.trim(),
                    options,
                    correctIndex,
                    explanation: String(q.explanation ?? '').trim() || `La respuesta correcta es: "${options[correctIndex]}"`,
                };
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // MATH VERIFICATION — Delegates to QuizMathValidator (Decimal.js precision)
    // ═══════════════════════════════════════════════════════════════════════════

    _verifyMathAnswer(q) {
        return QuizMathValidator.verify(q);
    }
    /** @private Extract complete JSON objects from a potentially truncated array string */
    _extractObjectsFromBrokenArray(jsonStr) {
        const results = [];
        let depth = 0;
        let inString = false;
        let escape = false;
        let objStart = -1;

        for (let i = 0; i < jsonStr.length; i++) {
            const ch = jsonStr[i];
            if (escape) { escape = false; continue; }
            if (ch === '\\' && inString) { escape = true; continue; }
            if (ch === '"') { inString = !inString; continue; }
            if (inString) continue;

            if (ch === '{') {
                if (depth === 0) objStart = i;
                depth++;
            } else if (ch === '}') {
                depth--;
                if (depth === 0 && objStart !== -1) {
                    try {
                        const obj = JSON.parse(jsonStr.substring(objStart, i + 1));
                        results.push(obj);
                    } catch (_) { /* skip malformed object */ }
                    objStart = -1;
                }
            }
        }
        return results;
    }

    /** @private Parse questions from LLM JSON output with fallback repair */
    _parseQuestionsJson(content) {
        const start = content.indexOf('[');
        const end = content.lastIndexOf(']');
        const pipeline = ValidationPipeline.getInstance();

        // Strategy 1: clean JSON array
        if (start !== -1 && end !== -1 && start < end) {
            try {
                const parsed = JSON.parse(content.substring(start, end + 1));
                if (Array.isArray(parsed)) {
                    const normalized = parsed
                        .map(q => this._normalizeQuestion(q))
                        .filter(Boolean);
                    // Use ValidationPipeline for unified math verification + structural checks
                    const validated = pipeline.validateBatch(normalized);
                    if (validated.length > 0) return validated;
                }
            } catch (_) { /* fall through to repair */ }
        }

        // Strategy 2: extract individual objects (handles truncated/malformed arrays)
        console.warn('[ReinforcementService] JSON parse failed, attempting object extraction repair...');
        const searchIn = start !== -1 ? content.substring(start) : content;
        const objects = this._extractObjectsFromBrokenArray(searchIn);
        if (objects.length > 0) {
            const normalized = objects
                .map(q => this._normalizeQuestion(q))
                .filter(Boolean);
            const validated = pipeline.validateBatch(normalized);
            if (validated.length > 0) {
                console.log(`[ReinforcementService] Repair recovered ${validated.length} questions from broken JSON`);
                return validated;
            }
        }

        console.warn('[ReinforcementService] JSON repair failed, no valid questions extracted');
        return [];
    }

    /** @private Fast local dedup using normalized text comparison */
    _localDedup(newQuestions, existingTexts) {
        const normalize = (text) => text.toLowerCase().replace(/[^a-záéíóúñü0-9\s]/g, '').replace(/\s+/g, ' ').trim();
        const existingNorm = new Set(existingTexts.map(normalize));

        return newQuestions.filter(q => {
            const norm = normalize(q.question);
            if (existingNorm.has(norm)) return false;
            // Jaccard similarity check
            const words = new Set(norm.split(' '));
            for (const existing of existingNorm) {
                const existingWords = new Set(existing.split(' '));
                const intersection = [...words].filter(w => existingWords.has(w)).length;
                const union = new Set([...words, ...existingWords]).size;
                if (union > 0 && intersection / union > 0.8) return false;
            }
            existingNorm.add(norm); // Avoid in-batch duplicates
            return true;
        });
    }

    /**
     * Returns true if the topic/task name or RAG content explicitly indicates math content.
     * This is the single source of truth for whether math exercises are permitted.
     * @private
     */
    _isMathContent(topicName = '', taskName = '', ragContent = '') {
        const titleText = `${topicName} ${taskName}`.toLowerCase();
        const mathTitleKeywords = [
            'suma', 'sumas', 'adición', 'sustracción', 'resta', 'multiplicaci', 'divisi',
            'aritmética', 'álgebra', 'cálculo', 'calculo', 'ecuaci', 'matemática',
            'matemáticas', 'trigonometría', 'geometría', 'fracción', 'decimal', 'porcentaje',
            'integral', 'derivada', 'límite', 'sumatoria', 'logaritmo', 'exponente',
            'polinomio', 'probabilidad', 'estadística', 'problema matemático', 'problemas matemáticos',
            'math', 'mathematics', 'arithmetic', 'algebra', 'calculus', 'serie aritm', 'serie geom',
        ];
        // Strong: explicit math keywords in title → math is allowed
        if (mathTitleKeywords.some(k => titleText.includes(k))) return true;
        // RAG-only: require HEAVY evidence (6+ distinct keywords) to prevent false positives
        // from documents that casually mention numbers, calculations, or percentages as context
        if (ragContent) {
            const ragSample = ragContent.substring(0, 3000).toLowerCase();
            const hits = mathTitleKeywords.filter(k => ragSample.includes(k)).length;
            if (hits >= 6) return true;
        }
        return false;
    }

    _isExerciseTrivialForHard(q, domain = 'GENERAL', isMathContent = false) {
        const text = (q.question || '').toLowerCase();
        const answer = String(q.correct_answer || q.correctAnswer || '').toLowerCase();
        const allText = text + ' ' + answer;

        // 0. Cross-domain contamination check — reject questions from the wrong domain
        if (domain === 'MATH') {
            // Programming/SQL signals are forbidden in a MATH topic
            const programmingSignals = [
                'select ', ' from ', ' where ', ' join ', 'function(', 'function (', '() {', '() =>',
                'algorithm', 'class ', 'new class', '= new ', 'api ', '\.push(', '\.pop(', '\.map(',
                'const ', 'let ', 'var ', 'def ', 'import ', 'console.log', 'system.out',
                'kahan', 'binary search', 'quicksort', 'mergesort', 'heapsort', 'bfs', 'dfs',
                'dijkstra', 'memoization', 'dynamic programming', 'programación dinámica',
                'recursion', 'recursive', 'recursivo', 'linked list', 'graph ', ' grafo',
                'hash map', 'hashmap', 'stack overflow', 'time complexity', 'space complexity',
                'big-o', 'o(n)', 'o(log', 'pseudocódigo', 'pseudocode', 'sintaxis de', 'punto flotante de doble'
            ];
            if (programmingSignals.some(s => text.includes(s))) {
                return true; // Reject: programming/SQL question in a MATH topic
            }
        }

        if (domain === 'SQL') {
            // Pure math/science questions are off-domain for SQL topics
            const mathOnlySignals = [/\b\d+\s*[+\-*\/]\s*\d+\s*=\s*___/, /calcula\s+la\s+(integral|derivada|sumatoria)/i];
            if (mathOnlySignals.some(r => r.test(text))) return true;
        }

        // Cross-domain: reject pure math questions in non-math domains
        // GENERAL is only math-adjacent when explicitly identified via _isMathContent
        const MATH_ADJACENT = ['MATH', 'PHYSICS', 'CHEMISTRY', 'ACCOUNTING'];
        const isMathAdjacent = MATH_ADJACENT.includes(domain) || (domain === 'GENERAL' && isMathContent);
        if (!isMathAdjacent) {
            // Detect pure math/arithmetic questions that don't belong in this domain
            const pureMathSignals = [
                /\b\d+\s*[+\-*\/]\s*\d+\s*=\s*___/,                          // arithmetic: "234 + 567 = ___"
                /calcula\s+(la\s+)?(integral|derivada|sumatoria|suma|raíz)/i,   // "calcula la integral..."
                /resuelve\s+(la\s+)?ecuaci[oó]n/i,                              // "resuelve la ecuación..."
                /\b(sen|cos|tan|log|ln|sqrt|\u222b|\u2211|\u03c0|\u221a)\b/i,  // trig/calc symbols
                /\bx\s*[\^²³]\s*[+\-]\s*\d/,                                  // polynomial: "x² + 3"
                /\b\d+\s*\/\s*\d+\s*[+\-]\s*\d+\s*\/\s*\d+/,                  // fractions: "3/8 + 1/9"
                /serie\s+(geom[eé]trica|aritm[eé]tica)/i,                       // "serie geométrica"
                /sistema\s+de\s+ecuaciones/i,                                   // "sistema de ecuaciones"
                /\bmatriz|matrices|determinante\b/i,                             // matrices
            ];
            if (pureMathSignals.some(r => r.test(text))) {
                console.warn(`[ReinforcementService] Cross-domain MATH rejected in ${domain}: "${text.substring(0, 80)}..."`);
                return true;
            }
        }

        // 1. Simple arithmetic: reject if ALL numbers have < 5 digits in MATH domain
        if (domain === 'MATH' && /^\s*¿?(cuánto|calcula|resuelve|resultado)\b/.test(text)) {
            const numbers = text.match(/\d+/g) || [];
            if (numbers.length >= 2 && numbers.every(n => n.length < 5)) return true;
        } else if (/^\s*¿?(cuánto|calcula|resuelve|resultado)\b/.test(text)) {
            const numbers = text.match(/\d+/g) || [];
            if (numbers.length >= 2 && numbers.every(n => n.length < 5)) return true;
        }

        // 2. Very short fill_in_blank without code/math
        if (q.type === 'fill_in_blank') {
            const wordCount = text.split(/\s+/).length;
            if (wordCount < 12 && !/[=<>{}()\[\]|&;]/.test(text) && !/\d{5,}/.test(text)) return true;
        }

        // 3. Simple numeric answers (1-4 digits) without math/code context
        if (/^\d{1,4}$/.test(answer.trim()) && !/[∫∑σ√π]/.test(text) && !/\b(select|from|where|function|class|algorithm)\b/i.test(text)) {
            const numbers = text.match(/\d+/g) || [];
            if (numbers.every(n => n.length < 5)) return true;
        }

        // 4. SQL without JOINs, subqueries, window functions, CTEs, or HAVING
        if (/\b(select|sql|consulta|query)\b/i.test(allText)) {
            const hasComplexSQL = /\b(join|subquer|window|over\s*\(|partition\s+by|cte|with\s+\w+\s+as|having|union|intersect|except|lateral|cross\s+apply)\b/i.test(allText);
            if (!hasComplexSQL && /\bselect\b/i.test(allText)) return true;
        }

        // 5. Pure definition questions
        if (/^¿?(qué es|what is|define|definición de|concepto de)\b/i.test(text.trim())) return true;

        return false;
    }

    /** @private Save questions with embeddings in background (non-blocking) */
    async _backgroundSave(userId, courseId, topicId, taskId, questions) {
        try {
            const mcpService = new MCPService();
            const result = await mcpService.saveReinforcementHistory(
                userId, courseId, questions,
                topicId || null, taskId || null
            );
            const savedCount = result?.savedCount || 0;
            const cumulativeCount = result?.cumulativeCount || savedCount;
            console.log(`💾 [ReinforcementService] Background save complete: ${savedCount}/${questions.length} unique saved (cumulative: ${cumulativeCount})`);
            if (savedCount < questions.length) {
                console.log(`💾 [ReinforcementService] ${questions.length - savedCount} questions were duplicates (hash or semantic)`);
            }
        } catch (e) {
            console.error('[ReinforcementService] Background save error:', e.message);
            // Non-blocking, just log
        }
    }

    async getHistory(userId, courseId, pagination = {}) {
        const sessions = await this.reinforcementRepo.findByUserAndCourse(userId, courseId, pagination);
        return Result.ok(sessions);
    }

    async getUserSessions(userId, pagination = {}) {
        const sessions = await this.reinforcementRepo.findByUser(userId, pagination);
        return Result.ok(sessions);
    }

    _looksLikeBinaryOrOfficeXml(text) {
        if (!text || text.length < 50) return false;
        const sample = text.substring(0, 2000);
        if (sample.startsWith('PK\x03\x04') || sample.startsWith('PK')) return true;
        const officeXmlPatterns = [
            'schemas.openxmlformats.org', 'schemas.microsoft.com/office',
            '<w:document', '<w:body', '<w:r>', '<w:p>', '<w:t>',
            '<w:rPr>', '<w:pPr>', '<w:sz', '<w:rFonts',
            'word/document.xml', 'word/_rels', '[Content_Types].xml', 'docProps/core.xml',
        ];
        const matchCount = officeXmlPatterns.filter(p => sample.includes(p)).length;
        if (matchCount >= 2) return true;
        const controlChars = (sample.match(/[\x00-\x08\x0E-\x1F\x7F-\x9F]/g) || []).length;
        if (controlChars > sample.length * 0.03) return true;
        const lines = sample.split('\n');
        const b64Lines = lines.filter(l => l.length > 100 && /^[A-Za-z0-9+/=]+$/.test(l.trim()));
        if (b64Lines.length > 3) return true;
        return false;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // ███████╗████████╗███████╗ █████╗ ██╗  ████████╗██╗  ██╗
    // ██╔════╝╚══██╔══╝██╔════╝██╔══██╗██║  ╚══██╔══╝██║  ██║
    // ███████╗   ██║   █████╗  ███████║██║     ██║   ███████║
    // ╚════██║   ██║   ██╔══╝  ██╔══██║██║     ██║   ██╔══██║
    // ███████║   ██║   ███████╗██║  ██║███████╗██║   ██║  ██║
    // ╚══════╝   ╚═╝   ╚══════╝╚═╝  ╚═╝╚══════╝╚═╝   ╚═╝  ╚═╝
    //  █████╗ ███████╗███████╗███████╗███████╗███████╗███╗   ███╗███████╗███╗   ██╗████████╗
    // ██╔══██╗██╔════╝██╔════╝██╔════╝██╔════╝██╔════╝████╗ ████║██╔════╝████╗  ██║╚══██╔══╝
    // ███████║███████╗███████╗█████╗  ███████╗███████╗██╔████╔██║█████╗  ██╔██╗ ██║   ██║
    // ██╔══██║╚════██║╚════██║██╔══╝  ╚════██║╚════██║██║╚██╔╝██║██╔══╝  ██║╚██╗██║   ██║
    // ██║  ██║███████║███████║███████╗███████║███████║██║ ╚═╝ ██║███████╗██║ ╚████║   ██║
    // ╚═╝  ╚═╝╚══════╝╚══════╝╚══════╝╚══════╝╚══════╝╚═╝     ╚═╝╚══════╝╚═╝  ╚═══╝   ╚═╝
    //
    // Stealth Assessment System (Evaluación Invisible)
    // Paper de referencia: Stealth Assessment in Digital Games (Valerie Shute, 2011)
    //
    // El estudiante NO sabe que está siendo evaluado. La IA analiza constantemente:
    // - Tiempo de respuesta por pregunta
    // - Patrones de error (qué tipo de preguntas falla más)
    // - Cambios de mente (si cambia su respuesta)
    // - Nivel de confianza (velocidad + patrones)
    // - Comportamiento bajo presión
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * Saves detailed interaction data for stealth assessment.
     * Called by the client after each question is answered (invisibly to the student).
     *
     * @param {Object} data - Stealth assessment data
     * @param {number} data.userId - User ID
     * @param {number} data.courseId - Course ID
     * @param {number} [data.topicId] - Topic ID
     * @param {number} [data.taskId] - Task ID
     * @param {string} data.sessionId - Unique session identifier
     * @param {Array<Object>} data.interactions - Array of interaction data per question
     * @param {string} data.interactions[].questionId - Unique question identifier
     * @param {string} data.interactions[].questionType - 'multiple_choice' | 'fill_in_blank' | 'ordering'
     * @param {string} data.interactions[].questionCategory - Category/topic of the question
     * @param {number} data.interactions[].timeToFirstClick - Time until first interaction (ms)
     * @param {number} data.interactions[].timeToSubmit - Total time until submit (ms)
     * @param {number} data.interactions[].answerChanges - Number of times answer was changed
     * @param {Array<Object>} data.interactions[].changeHistory - History of answer changes with timestamps
     * @param {boolean} data.interactions[].isCorrect - Whether final answer was correct
     * @param {number} data.interactions[].difficulty - Question difficulty (1-5)
     * @param {number} [data.interactions[].hintUsed] - Whether hint was used (0/1)
     * @param {number} [data.interactions[].scrollEvents] - Number of scroll events (reading behavior)
     * @param {number} [data.interactions[].focusLostCount] - Times the user left the question
     */
    async saveStealthAssessment(data) {
        try {
            const { userId, courseId, topicId, taskId, sessionId, interactions } = data;

            if (!Array.isArray(interactions) || interactions.length === 0) {
                return Result.fail('No interactions data provided');
            }

            const supabase = SupabaseService.getInstance();

            // Prepare batch insert for stealth_assessment_interactions
            const interactionRecords = interactions.map((interaction, index) => ({
                user_id: userId,
                course_id: courseId,
                topic_id: topicId || null,
                task_id: taskId || null,
                session_id: sessionId,
                question_index: index,
                question_id: interaction.questionId || `q_${index}`,
                question_type: interaction.questionType || 'multiple_choice',
                question_category: interaction.questionCategory || 'general',
                difficulty: interaction.difficulty || 3,
                time_to_first_click_ms: interaction.timeToFirstClick || 0,
                time_to_submit_ms: interaction.timeToSubmit || 0,
                answer_changes: interaction.answerChanges || 0,
                change_history: JSON.stringify(interaction.changeHistory || []),
                is_correct: interaction.isCorrect || false,
                hint_used: interaction.hintUsed || false,
                scroll_events: interaction.scrollEvents || 0,
                focus_lost_count: interaction.focusLostCount || 0,
                created_at: new Date().toISOString(),
            }));

            // Insert all interactions
            const { data: savedInteractions, error: insertError } = await supabase.client
                .from('stealth_assessment_interactions')
                .insert(interactionRecords)
                .select();

            if (insertError) {
                console.error('[StealthAssessment] Error saving interactions:', insertError.message);
                // Continue even if save fails - we still want to analyze
            }

            // Analyze the interactions and generate the comprehension X-ray
            const analysis = await this.analyzeStealthMetrics(userId, courseId, interactions, {
                topicId,
                taskId,
                sessionId,
            });

            // Save the analysis summary
            const { error: summaryError } = await supabase.client
                .from('stealth_assessment_summaries')
                .upsert({
                    user_id: userId,
                    course_id: courseId,
                    topic_id: topicId || null,
                    task_id: taskId || null,
                    session_id: sessionId,
                    ...analysis.metrics,
                    cognitive_profile: JSON.stringify(analysis.cognitiveProfile),
                    weak_areas: JSON.stringify(analysis.weakAreas),
                    strong_areas: JSON.stringify(analysis.strongAreas),
                    behavioral_patterns: JSON.stringify(analysis.behavioralPatterns),
                    recommendations: JSON.stringify(analysis.recommendations),
                    comprehension_score: analysis.comprehensionScore,
                    confidence_index: analysis.confidenceIndex,
                    updated_at: new Date().toISOString(),
                }, {
                    onConflict: 'user_id,course_id,session_id',
                });

            if (summaryError) {
                console.error('[StealthAssessment] Error saving summary:', summaryError.message);
            }

            console.log(`🔬 [StealthAssessment] Saved ${interactions.length} interactions for user ${userId}, session ${sessionId}`);
            console.log(`📊 [StealthAssessment] Comprehension Score: ${analysis.comprehensionScore}%, Confidence Index: ${analysis.confidenceIndex}%`);

            return Result.ok({
                saved: savedInteractions?.length || interactions.length,
                analysis,
            });
        } catch (error) {
            console.error('[StealthAssessment] saveStealthAssessment error:', error.message);
            return Result.fail(error.message);
        }
    }

    /**
     * Analyzes stealth assessment metrics to generate cognitive insights.
     * This is the core of the invisible evaluation system.
     *
     * @param {number} userId
     * @param {number} courseId
     * @param {Array<Object>} interactions - Current session interactions
     * @param {Object} context - Additional context (topicId, taskId, sessionId)
     * @returns {Object} Analysis results with metrics and insights
     */
    async analyzeStealthMetrics(userId, courseId, interactions, context = {}) {
        const totalQuestions = interactions.length;
        const correctCount = interactions.filter(i => i.isCorrect).length;
        const accuracy = totalQuestions > 0 ? (correctCount / totalQuestions) * 100 : 0;

        // ─── Time Analysis ─────────────────────────────────────────────────────────
        const responseTimes = interactions.map(i => i.timeToSubmit || 0);
        const avgResponseTime = responseTimes.reduce((a, b) => a + b, 0) / totalQuestions || 0;
        const medianResponseTime = this._calculateMedian(responseTimes);
        const responseTimeVariance = this._calculateVariance(responseTimes);

        // Detect rushing (too fast) or overthinking (too slow)
        const rushingThreshold = 3000; // < 3 seconds = probably guessing
        const overthinkingThreshold = 60000; // > 60 seconds = struggling
        const rushingCount = responseTimes.filter(t => t < rushingThreshold && t > 0).length;
        const overthinkingCount = responseTimes.filter(t => t > overthinkingThreshold).length;

        // ─── Confidence Analysis ───────────────────────────────────────────────────
        const totalAnswerChanges = interactions.reduce((sum, i) => sum + (i.answerChanges || 0), 0);
        const questionsWithChanges = interactions.filter(i => (i.answerChanges || 0) > 0).length;
        const avgChangesPerQuestion = totalAnswerChanges / totalQuestions || 0;

        // High changes + wrong answer = low confidence & confusion
        // No changes + fast time + correct = high confidence
        const confidenceSignals = interactions.map(i => {
            let signal = 50; // base confidence

            // Time-based confidence
            if (i.timeToSubmit < rushingThreshold) signal -= 20; // too fast = guessing
            else if (i.timeToSubmit > overthinkingThreshold) signal -= 15; // too slow = struggling
            else if (i.timeToSubmit >= 5000 && i.timeToSubmit <= 30000) signal += 10; // optimal range

            // Change-based confidence
            if (i.answerChanges === 0 && i.isCorrect) signal += 20; // confident and correct
            else if (i.answerChanges > 2) signal -= 15; // too many changes = uncertain
            else if (i.answerChanges === 1 && i.isCorrect) signal += 5; // reconsidered and got it right

            // Correctness bonus
            if (i.isCorrect) signal += 15;
            else signal -= 10;

            // Focus loss penalty
            if ((i.focusLostCount || 0) > 2) signal -= 10;

            return Math.max(0, Math.min(100, signal));
        });
        const confidenceIndex = Math.round(confidenceSignals.reduce((a, b) => a + b, 0) / totalQuestions || 0);

        // ─── Error Pattern Analysis ────────────────────────────────────────────────
        const errorsByCategory = {};
        const errorsByType = {};
        const errorsByDifficulty = {};

        interactions.filter(i => !i.isCorrect).forEach(i => {
            const category = i.questionCategory || 'general';
            const type = i.questionType || 'multiple_choice';
            const difficulty = i.difficulty || 3;

            errorsByCategory[category] = (errorsByCategory[category] || 0) + 1;
            errorsByType[type] = (errorsByType[type] || 0) + 1;
            errorsByDifficulty[difficulty] = (errorsByDifficulty[difficulty] || 0) + 1;
        });

        // Find weak areas (categories with > 50% error rate)
        const categoryStats = {};
        interactions.forEach(i => {
            const category = i.questionCategory || 'general';
            if (!categoryStats[category]) {
                categoryStats[category] = { total: 0, errors: 0 };
            }
            categoryStats[category].total++;
            if (!i.isCorrect) categoryStats[category].errors++;
        });

        const weakAreas = Object.entries(categoryStats)
            .filter(([, stats]) => stats.total >= 2 && (stats.errors / stats.total) > 0.5)
            .map(([category, stats]) => ({
                category,
                errorRate: Math.round((stats.errors / stats.total) * 100),
                totalQuestions: stats.total,
                errors: stats.errors,
            }))
            .sort((a, b) => b.errorRate - a.errorRate);

        const strongAreas = Object.entries(categoryStats)
            .filter(([, stats]) => stats.total >= 2 && (stats.errors / stats.total) < 0.3)
            .map(([category, stats]) => ({
                category,
                successRate: Math.round(((stats.total - stats.errors) / stats.total) * 100),
                totalQuestions: stats.total,
                correct: stats.total - stats.errors,
            }))
            .sort((a, b) => b.successRate - a.successRate);

        // ─── Behavioral Patterns ───────────────────────────────────────────────────
        const behavioralPatterns = {
            // Guessing pattern: fast response + wrong answer + no changes
            guessing: interactions.filter(i =>
                i.timeToSubmit < rushingThreshold &&
                !i.isCorrect &&
                (i.answerChanges || 0) === 0
            ).length,

            // Deliberate pattern: moderate time + correct + 0-1 changes
            deliberate: interactions.filter(i =>
                i.timeToSubmit >= 5000 &&
                i.timeToSubmit <= 45000 &&
                i.isCorrect
            ).length,

            // Struggling pattern: long time + wrong answer + multiple changes
            struggling: interactions.filter(i =>
                i.timeToSubmit > overthinkingThreshold &&
                !i.isCorrect
            ).length,

            // Second-guessing pattern: changed answer and got it wrong (was probably right first)
            secondGuessing: interactions.filter(i =>
                (i.answerChanges || 0) >= 1 &&
                !i.isCorrect
            ).length,

            // Distracted pattern: multiple focus losses
            distracted: interactions.filter(i =>
                (i.focusLostCount || 0) > 2
            ).length,

            // Hint dependency: used hint
            hintDependency: interactions.filter(i => i.hintUsed).length,
        };

        // ─── Cognitive Profile ─────────────────────────────────────────────────────
        const cognitiveProfile = this._buildStealthCognitiveProfile({
            accuracy,
            confidenceIndex,
            avgResponseTime,
            responseTimeVariance,
            behavioralPatterns,
            weakAreas,
            totalQuestions,
        });

        // ─── Comprehension Score (0-100) ───────────────────────────────────────────
        // Weighted formula considering multiple factors
        const comprehensionScore = Math.round(
            (accuracy * 0.40) + // 40% weight on correctness
            (confidenceIndex * 0.25) + // 25% weight on confidence
            (cognitiveProfile.consistencyScore * 0.20) + // 20% weight on consistency
            (cognitiveProfile.engagementScore * 0.15) // 15% weight on engagement
        );

        // ─── Generate Recommendations ──────────────────────────────────────────────
        const recommendations = this._generateStealthRecommendations({
            comprehensionScore,
            confidenceIndex,
            behavioralPatterns,
            weakAreas,
            cognitiveProfile,
            avgResponseTime,
        });

        return {
            // Core metrics
            metrics: {
                total_questions: totalQuestions,
                correct_count: correctCount,
                accuracy: Math.round(accuracy * 100) / 100,
                avg_response_time_ms: Math.round(avgResponseTime),
                median_response_time_ms: Math.round(medianResponseTime),
                response_time_variance: Math.round(responseTimeVariance),
                total_answer_changes: totalAnswerChanges,
                questions_with_changes: questionsWithChanges,
                rushing_count: rushingCount,
                overthinking_count: overthinkingCount,
            },

            // Scores
            comprehensionScore,
            confidenceIndex,

            // Detailed analysis
            cognitiveProfile,
            weakAreas,
            strongAreas,
            behavioralPatterns,
            errorsByCategory,
            errorsByType,
            errorsByDifficulty,

            // Actionable insights
            recommendations,

            // Metadata
            analyzedAt: new Date().toISOString(),
            sessionId: context.sessionId,
        };
    }

    /**
     * Builds a cognitive profile based on stealth assessment data.
     */
    _buildStealthCognitiveProfile({
        accuracy,
        confidenceIndex,
        avgResponseTime,
        responseTimeVariance,
        behavioralPatterns,
        weakAreas,
        totalQuestions,
    }) {
        // Learning style inference
        let learningStyle = 'balanced';
        if (avgResponseTime < 10000 && accuracy > 70) {
            learningStyle = 'quick_intuitive'; // Fast and accurate
        } else if (avgResponseTime > 30000 && accuracy > 70) {
            learningStyle = 'methodical_analytical'; // Slow but accurate
        } else if (behavioralPatterns.guessing > totalQuestions * 0.3) {
            learningStyle = 'impulsive_guesser'; // Too many guesses
        } else if (behavioralPatterns.secondGuessing > totalQuestions * 0.2) {
            learningStyle = 'second_guesser'; // Changes mind too much
        }

        // Consistency score (inverse of variance, normalized)
        const maxExpectedVariance = 900000000; // 30 seconds squared
        const consistencyScore = Math.max(0, Math.min(100,
            100 - (responseTimeVariance / maxExpectedVariance) * 100
        ));

        // Engagement score based on behavioral signals
        const totalBehavioralIssues =
            behavioralPatterns.guessing +
            behavioralPatterns.distracted +
            behavioralPatterns.struggling;
        const engagementScore = Math.max(0, Math.min(100,
            100 - (totalBehavioralIssues / totalQuestions) * 50
        ));

        // Mastery level
        let masteryLevel = 'novice';
        let masteryColor = '#FF6B6B';
        if (accuracy >= 90 && confidenceIndex >= 75) {
            masteryLevel = 'expert';
            masteryColor = '#51CF66';
        } else if (accuracy >= 75 && confidenceIndex >= 60) {
            masteryLevel = 'proficient';
            masteryColor = '#339AF0';
        } else if (accuracy >= 60 && confidenceIndex >= 45) {
            masteryLevel = 'competent';
            masteryColor = '#FAB005';
        } else if (accuracy >= 40) {
            masteryLevel = 'developing';
            masteryColor = '#FF922B';
        }

        // Stress indicator (high variance + low confidence + many changes)
        const stressIndicator = Math.min(100, Math.round(
            (responseTimeVariance > 500000000 ? 30 : 0) +
            (confidenceIndex < 40 ? 30 : 0) +
            (behavioralPatterns.secondGuessing > 2 ? 20 : 0) +
            (behavioralPatterns.struggling > 2 ? 20 : 0)
        ));

        // Knowledge retention prediction (based on patterns)
        const retentionPrediction = Math.round(
            (accuracy * 0.5) +
            (confidenceIndex * 0.3) +
            (behavioralPatterns.deliberate / totalQuestions * 100 * 0.2)
        );

        return {
            learningStyle,
            consistencyScore: Math.round(consistencyScore),
            engagementScore: Math.round(engagementScore),
            masteryLevel,
            masteryColor,
            stressIndicator,
            retentionPrediction: Math.min(100, retentionPrediction),
            needsSupport: weakAreas.length > 0 || accuracy < 50 || confidenceIndex < 40,
            readyForAdvanced: accuracy >= 80 && confidenceIndex >= 70 && behavioralPatterns.deliberate > totalQuestions * 0.5,
        };
    }

    /**
     * Generates personalized recommendations based on stealth assessment analysis.
     */
    _generateStealthRecommendations({
        comprehensionScore,
        confidenceIndex,
        behavioralPatterns,
        weakAreas,
        cognitiveProfile,
        avgResponseTime,
    }) {
        const recommendations = [];

        // Based on comprehension score
        if (comprehensionScore < 40) {
            recommendations.push({
                priority: 'high',
                type: 'review_fundamentals',
                message: 'Se recomienda revisar los conceptos básicos del tema antes de continuar.',
                action: 'Repasar el material de la lección desde el inicio.',
            });
        } else if (comprehensionScore < 60) {
            recommendations.push({
                priority: 'medium',
                type: 'targeted_practice',
                message: 'Hay áreas específicas que requieren más práctica.',
                action: 'Enfocarse en ejercicios de las áreas identificadas como débiles.',
            });
        }

        // Based on confidence
        if (confidenceIndex < 40) {
            recommendations.push({
                priority: 'medium',
                type: 'build_confidence',
                message: 'Se detecta inseguridad en las respuestas.',
                action: 'Practicar con ejercicios de menor dificultad para construir confianza.',
            });
        }

        // Based on behavioral patterns
        if (behavioralPatterns.guessing > 3) {
            recommendations.push({
                priority: 'high',
                type: 'slow_down',
                message: 'Se detecta un patrón de respuestas apresuradas.',
                action: 'Tomar más tiempo para leer y analizar cada pregunta antes de responder.',
            });
        }

        if (behavioralPatterns.secondGuessing > 2) {
            recommendations.push({
                priority: 'medium',
                type: 'trust_instincts',
                message: 'Se observa tendencia a cambiar respuestas correctas.',
                action: 'Confiar más en la primera respuesta instintiva cuando hay seguridad.',
            });
        }

        if (behavioralPatterns.overthinking > 2) {
            recommendations.push({
                priority: 'low',
                type: 'time_management',
                message: 'Algunas preguntas toman demasiado tiempo.',
                action: 'Practicar técnicas de gestión del tiempo en exámenes.',
            });
        }

        if (behavioralPatterns.distracted > 2) {
            recommendations.push({
                priority: 'medium',
                type: 'focus',
                message: 'Se detectan interrupciones frecuentes durante el quiz.',
                action: 'Buscar un ambiente más tranquilo y libre de distracciones.',
            });
        }

        // Based on weak areas
        if (weakAreas.length > 0) {
            const topWeak = weakAreas.slice(0, 3).map(w => w.category).join(', ');
            recommendations.push({
                priority: 'high',
                type: 'focus_areas',
                message: `Áreas que necesitan refuerzo: ${topWeak}`,
                action: 'Dedicar tiempo adicional a estudiar estos temas específicos.',
                details: weakAreas.slice(0, 3),
            });
        }

        // Based on cognitive profile
        if (cognitiveProfile.stressIndicator > 60) {
            recommendations.push({
                priority: 'medium',
                type: 'stress_management',
                message: 'Se detectan señales de estrés durante la evaluación.',
                action: 'Practicar técnicas de relajación y tomar descansos entre sesiones de estudio.',
            });
        }

        if (cognitiveProfile.readyForAdvanced) {
            recommendations.push({
                priority: 'low',
                type: 'advance',
                message: '¡Excelente dominio del tema!',
                action: 'Listo para avanzar a contenido de mayor dificultad.',
            });
        }

        // Sort by priority
        const priorityOrder = { high: 0, medium: 1, low: 2 };
        recommendations.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

        return recommendations;
    }

    /**
     * Gets the comprehension X-ray (radiografía de comprensión) for a student.
     * This is the visible output for teachers/admins only.
     *
     * @param {number} userId
     * @param {number} courseId
     * @param {Object} options - Filter options (topicId, taskId, limit)
     */
    async getComprehensionXRay(userId, courseId, options = {}) {
        try {
            const { topicId, taskId, limit = 10 } = options;
            const supabase = SupabaseService.getInstance();

            // Get recent stealth assessment summaries
            let query = supabase.client
                .from('stealth_assessment_summaries')
                .select('*')
                .eq('user_id', userId)
                .eq('course_id', courseId)
                .order('updated_at', { ascending: false })
                .limit(limit);

            if (topicId) query = query.eq('topic_id', topicId);
            if (taskId) query = query.eq('task_id', taskId);

            const { data: summaries, error } = await query;

            if (error) {
                console.error('[StealthAssessment] Error fetching X-ray:', error.message);
                return Result.fail(error.message);
            }

            if (!summaries || summaries.length === 0) {
                return Result.ok({
                    hasData: false,
                    message: 'No hay datos de evaluación invisible disponibles para este estudiante.',
                });
            }

            // Aggregate data across sessions
            const aggregated = this._aggregateXRayData(summaries);

            // Generate AI-powered insights if LLM is available
            let aiInsights = null;
            if (this.llmPort) {
                aiInsights = await this._generateAIInsights(aggregated);
            }

            return Result.ok({
                hasData: true,
                studentId: userId,
                courseId,
                sessionsAnalyzed: summaries.length,
                latestSession: summaries[0]?.updated_at,

                // Aggregated scores
                overallComprehension: aggregated.avgComprehension,
                overallConfidence: aggregated.avgConfidence,

                // Trends
                comprehensionTrend: aggregated.comprehensionTrend,
                confidenceTrend: aggregated.confidenceTrend,

                // Patterns
                consistentWeakAreas: aggregated.consistentWeakAreas,
                consistentStrongAreas: aggregated.consistentStrongAreas,
                dominantBehavioralPatterns: aggregated.dominantPatterns,

                // Cognitive profile evolution
                currentCognitiveProfile: aggregated.latestProfile,
                profileEvolution: aggregated.profileEvolution,

                // Recommendations (prioritized)
                recommendations: aggregated.recommendations,

                // AI-generated insights (if available)
                aiInsights,

                // Raw session data for detailed view
                sessions: summaries.map(s => ({
                    sessionId: s.session_id,
                    date: s.updated_at,
                    comprehensionScore: s.comprehension_score,
                    confidenceIndex: s.confidence_index,
                    totalQuestions: s.total_questions,
                    accuracy: s.accuracy,
                })),
            });
        } catch (error) {
            console.error('[StealthAssessment] getComprehensionXRay error:', error.message);
            return Result.fail(error.message);
        }
    }

    /**
     * Aggregates X-ray data from multiple sessions.
     */
    _aggregateXRayData(summaries) {
        const comprehensionScores = summaries.map(s => s.comprehension_score || 0);
        const confidenceScores = summaries.map(s => s.confidence_index || 0);

        // Calculate averages
        const avgComprehension = Math.round(
            comprehensionScores.reduce((a, b) => a + b, 0) / summaries.length
        );
        const avgConfidence = Math.round(
            confidenceScores.reduce((a, b) => a + b, 0) / summaries.length
        );

        // Calculate trends (comparing recent vs older)
        let comprehensionTrend = 'stable';
        let confidenceTrend = 'stable';

        if (summaries.length >= 3) {
            const recentComp = comprehensionScores.slice(0, Math.ceil(summaries.length / 2));
            const olderComp = comprehensionScores.slice(Math.ceil(summaries.length / 2));
            const recentAvg = recentComp.reduce((a, b) => a + b, 0) / recentComp.length;
            const olderAvg = olderComp.reduce((a, b) => a + b, 0) / olderComp.length;

            if (recentAvg > olderAvg + 5) comprehensionTrend = 'improving';
            else if (recentAvg < olderAvg - 5) comprehensionTrend = 'declining';

            const recentConf = confidenceScores.slice(0, Math.ceil(summaries.length / 2));
            const olderConf = confidenceScores.slice(Math.ceil(summaries.length / 2));
            const recentConfAvg = recentConf.reduce((a, b) => a + b, 0) / recentConf.length;
            const olderConfAvg = olderConf.reduce((a, b) => a + b, 0) / olderConf.length;

            if (recentConfAvg > olderConfAvg + 5) confidenceTrend = 'improving';
            else if (recentConfAvg < olderConfAvg - 5) confidenceTrend = 'declining';
        }

        // Aggregate weak areas (appears in > 50% of sessions)
        const weakAreaCounts = {};
        summaries.forEach(s => {
            const weakAreas = JSON.parse(s.weak_areas || '[]');
            weakAreas.forEach(w => {
                weakAreaCounts[w.category] = (weakAreaCounts[w.category] || 0) + 1;
            });
        });
        const consistentWeakAreas = Object.entries(weakAreaCounts)
            .filter(([, count]) => count >= summaries.length * 0.5)
            .map(([category, count]) => ({ category, occurrences: count }))
            .sort((a, b) => b.occurrences - a.occurrences);

        // Aggregate strong areas
        const strongAreaCounts = {};
        summaries.forEach(s => {
            const strongAreas = JSON.parse(s.strong_areas || '[]');
            strongAreas.forEach(w => {
                strongAreaCounts[w.category] = (strongAreaCounts[w.category] || 0) + 1;
            });
        });
        const consistentStrongAreas = Object.entries(strongAreaCounts)
            .filter(([, count]) => count >= summaries.length * 0.5)
            .map(([category, count]) => ({ category, occurrences: count }))
            .sort((a, b) => b.occurrences - a.occurrences);

        // Aggregate behavioral patterns
        const patternTotals = {
            guessing: 0,
            deliberate: 0,
            struggling: 0,
            secondGuessing: 0,
            distracted: 0,
        };
        summaries.forEach(s => {
            const patterns = JSON.parse(s.behavioral_patterns || '{}');
            Object.keys(patternTotals).forEach(key => {
                patternTotals[key] += patterns[key] || 0;
            });
        });
        const dominantPatterns = Object.entries(patternTotals)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([pattern, count]) => ({ pattern, totalOccurrences: count }));

        // Latest cognitive profile
        const latestProfile = JSON.parse(summaries[0]?.cognitive_profile || '{}');

        // Profile evolution (simplified)
        const profileEvolution = summaries.slice(0, 5).map(s => ({
            date: s.updated_at,
            masteryLevel: JSON.parse(s.cognitive_profile || '{}').masteryLevel || 'unknown',
            comprehension: s.comprehension_score,
        }));

        // Aggregate recommendations (most frequent high-priority ones)
        const recommendationCounts = {};
        summaries.forEach(s => {
            const recs = JSON.parse(s.recommendations || '[]');
            recs.filter(r => r.priority === 'high').forEach(r => {
                recommendationCounts[r.type] = recommendationCounts[r.type] || { ...r, count: 0 };
                recommendationCounts[r.type].count++;
            });
        });
        const recommendations = Object.values(recommendationCounts)
            .sort((a, b) => b.count - a.count)
            .slice(0, 5);

        return {
            avgComprehension,
            avgConfidence,
            comprehensionTrend,
            confidenceTrend,
            consistentWeakAreas,
            consistentStrongAreas,
            dominantPatterns,
            latestProfile,
            profileEvolution,
            recommendations,
        };
    }

    /**
     * Generates AI-powered insights from aggregated stealth assessment data.
     */
    async _generateAIInsights(aggregatedData) {
        try {
            const prompt = `Eres un experto en pedagogía y neurociencia del aprendizaje. Analiza los siguientes datos de evaluación invisible (stealth assessment) de un estudiante y genera insights accionables.

DATOS DEL ESTUDIANTE:
- Comprensión promedio: ${aggregatedData.avgComprehension}%
- Confianza promedio: ${aggregatedData.avgConfidence}%
- Tendencia de comprensión: ${aggregatedData.comprehensionTrend}
- Tendencia de confianza: ${aggregatedData.confidenceTrend}
- Nivel de maestría actual: ${aggregatedData.latestProfile.masteryLevel || 'desconocido'}
- Estilo de aprendizaje detectado: ${aggregatedData.latestProfile.learningStyle || 'no determinado'}
- Indicador de estrés: ${aggregatedData.latestProfile.stressIndicator || 0}%
- Áreas débiles consistentes: ${aggregatedData.consistentWeakAreas.map(w => w.category).join(', ') || 'ninguna identificada'}
- Áreas fuertes consistentes: ${aggregatedData.consistentStrongAreas.map(s => s.category).join(', ') || 'ninguna identificada'}
- Patrones de comportamiento dominantes: ${aggregatedData.dominantPatterns.map(p => p.pattern).join(', ')}

Genera un análisis breve (máximo 3 párrafos) que incluya:
1. Una evaluación del estado actual del estudiante
2. Las fortalezas y oportunidades de mejora más importantes
3. Una recomendación específica y accionable para el docente

Responde en español, con un tono profesional pero accesible.`;

            const response = await this.llmPort.chat(
                'Eres un analista educativo experto en evaluación formativa y neurociencia del aprendizaje.',
                prompt,
                { temperature: 0.3, maxTokens: 500 }
            );

            return response?.content || null;
        } catch (error) {
            console.error('[StealthAssessment] Error generating AI insights:', error.message);
            return null;
        }
    }

    /**
     * Gets stealth assessment analytics for an entire course.
     * For teachers/admins to see class-level patterns.
     */
    async getCourseStealthAnalytics(courseId, options = {}) {
        try {
            const { limit = 100 } = options;
            const supabase = SupabaseService.getInstance();

            // Get all recent summaries for the course
            const { data: summaries, error } = await supabase.client
                .from('stealth_assessment_summaries')
                .select('*')
                .eq('course_id', courseId)
                .order('updated_at', { ascending: false })
                .limit(limit);

            if (error) {
                return Result.fail(error.message);
            }

            if (!summaries || summaries.length === 0) {
                return Result.ok({
                    hasData: false,
                    message: 'No hay datos de evaluación invisible para este curso.',
                });
            }

            // Group by user
            const userGroups = {};
            summaries.forEach(s => {
                if (!userGroups[s.user_id]) {
                    userGroups[s.user_id] = [];
                }
                userGroups[s.user_id].push(s);
            });

            // Calculate per-student stats
            const studentStats = Object.entries(userGroups).map(([userId, userSummaries]) => {
                const avgComp = userSummaries.reduce((a, s) => a + (s.comprehension_score || 0), 0) / userSummaries.length;
                const avgConf = userSummaries.reduce((a, s) => a + (s.confidence_index || 0), 0) / userSummaries.length;
                const latestProfile = JSON.parse(userSummaries[0]?.cognitive_profile || '{}');

                return {
                    userId: parseInt(userId),
                    sessionsCount: userSummaries.length,
                    avgComprehension: Math.round(avgComp),
                    avgConfidence: Math.round(avgConf),
                    masteryLevel: latestProfile.masteryLevel || 'unknown',
                    needsSupport: latestProfile.needsSupport || avgComp < 50,
                    lastActivity: userSummaries[0]?.updated_at,
                };
            });

            // Course-level aggregations
            const totalStudents = studentStats.length;
            const avgCourseComprehension = Math.round(
                studentStats.reduce((a, s) => a + s.avgComprehension, 0) / totalStudents
            );
            const avgCourseConfidence = Math.round(
                studentStats.reduce((a, s) => a + s.avgConfidence, 0) / totalStudents
            );

            const studentsNeedingSupport = studentStats.filter(s => s.needsSupport).length;

            const masteryDistribution = {
                expert: studentStats.filter(s => s.masteryLevel === 'expert').length,
                proficient: studentStats.filter(s => s.masteryLevel === 'proficient').length,
                competent: studentStats.filter(s => s.masteryLevel === 'competent').length,
                developing: studentStats.filter(s => s.masteryLevel === 'developing').length,
                novice: studentStats.filter(s => s.masteryLevel === 'novice').length,
            };

            // Aggregate weak areas across all students
            const courseWeakAreas = {};
            summaries.forEach(s => {
                const weakAreas = JSON.parse(s.weak_areas || '[]');
                weakAreas.forEach(w => {
                    courseWeakAreas[w.category] = (courseWeakAreas[w.category] || 0) + 1;
                });
            });
            const topCourseWeakAreas = Object.entries(courseWeakAreas)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([category, count]) => ({ category, studentCount: count }));

            return Result.ok({
                hasData: true,
                courseId,
                analyzedAt: new Date().toISOString(),

                // Overview
                totalStudents,
                totalSessions: summaries.length,
                avgCourseComprehension,
                avgCourseConfidence,
                studentsNeedingSupport,
                supportPercentage: Math.round((studentsNeedingSupport / totalStudents) * 100),

                // Distributions
                masteryDistribution,

                // Problem areas
                topCourseWeakAreas,

                // Student details (sorted by need for support)
                students: studentStats.sort((a, b) => a.avgComprehension - b.avgComprehension),
            });
        } catch (error) {
            console.error('[StealthAssessment] getCourseStealthAnalytics error:', error.message);
            return Result.fail(error.message);
        }
    }

    // ─── Helper Methods ────────────────────────────────────────────────────────────

    _calculateMedian(arr) {
        if (!arr || arr.length === 0) return 0;
        const sorted = [...arr].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    _calculateVariance(arr) {
        if (!arr || arr.length === 0) return 0;
        const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
        return arr.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / arr.length;
    }

    // ─── Intelligent Recommendations System ────────────────────────────────────────

    /**
     * Gets personalized learning recommendations for a student based on their performance.
     * Uses AI to detect weaknesses and suggest interventions.
     * Includes BOTH task submissions (graded tasks) AND reinforcement results.
     */
    async getStudentRecommendations(userId, options = {}) {
        try {
            const { limit = 5 } = options;
            const supabase = SupabaseService.getInstance();

            // 1. Get reinforcement results for this user
            const { data: resultsData, error: resultsError } = await supabase.client
                .from('reinforcement_results')
                .select(`
                    id,
                    user_id,
                    course_id,
                    topic_id,
                    task_id,
                    total_questions,
                    correct_answers,
                    incorrect_answers,
                    grade,
                    difficulty,
                    duration_seconds,
                    created_at
                `)
                .eq('user_id', userId)
                .order('created_at', { ascending: false })
                .limit(100);

            if (resultsError) {
                console.error('[Recommendations] Error fetching reinforcement results:', resultsError.message);
            }

            // 2. Get ALL graded task submissions for this user (IMPORTANT: includes all users who have submitted at least 1 task)
            const { data: submissionsData, error: submissionsError } = await supabase.client
                .from('task_submissions')
                .select(`
                    id,
                    user_id,
                    task_id,
                    grade,
                    feedback,
                    created_at,
                    tasks!inner (
                        id,
                        title,
                        topic_id,
                        topics!inner (
                            id,
                            nombre,
                            materia_id,
                            subjects!inner (
                                id,
                                name,
                                course_id
                            )
                        )
                    )
                `)
                .eq('user_id', userId)
                .not('grade', 'is', null)
                .order('created_at', { ascending: false })
                .limit(100);

            if (submissionsError) {
                console.error('[Recommendations] Error fetching submissions:', submissionsError.message);
            }

            const hasReinforcementData = resultsData && resultsData.length > 0;
            const hasSubmissionData = submissionsData && submissionsData.length > 0;

            // If no data from either source, return empty
            if (!hasReinforcementData && !hasSubmissionData) {
                return Result.ok({ recommendations: [], hasData: false });
            }

            // 3. Group performance by topic from BOTH sources
            const topicPerformance = new Map();

            // Process reinforcement results
            for (const result of (resultsData || [])) {
                const topicId = result.topic_id;
                if (!topicId) continue;

                if (!topicPerformance.has(topicId)) {
                    topicPerformance.set(topicId, {
                        topicId,
                        courseId: result.course_id,
                        sessions: [],
                        submissions: [],
                        totalQuestions: 0,
                        totalCorrect: 0,
                        totalIncorrect: 0,
                        grades: [],
                        source: 'reinforcement',
                    });
                }

                const perf = topicPerformance.get(topicId);
                perf.sessions.push(result);
                perf.totalQuestions += result.total_questions || 0;
                perf.totalCorrect += result.correct_answers || 0;
                perf.totalIncorrect += result.incorrect_answers || 0;
                if (result.grade) perf.grades.push(parseFloat(result.grade));
            }

            // Process task submissions (graded tasks)
            for (const submission of (submissionsData || [])) {
                const task = submission.tasks;
                if (!task || !task.topics) continue;

                const topic = task.topics;
                const subject = topic.subjects;
                const topicId = topic.id;
                const courseId = subject?.course_id;

                if (!topicId || !courseId) continue;

                if (!topicPerformance.has(topicId)) {
                    topicPerformance.set(topicId, {
                        topicId,
                        courseId,
                        sessions: [],
                        submissions: [],
                        totalQuestions: 0,
                        totalCorrect: 0,
                        totalIncorrect: 0,
                        grades: [],
                        source: 'submission',
                        topicName: topic.nombre,
                        subjectId: topic.materia_id,
                        subjectName: subject?.name,
                        taskName: task.title,
                    });
                }

                const perf = topicPerformance.get(topicId);
                perf.submissions.push(submission);

                // Update topic metadata if not set
                if (!perf.topicName) perf.topicName = topic.nombre;
                if (!perf.subjectId) perf.subjectId = topic.materia_id;
                if (!perf.subjectName) perf.subjectName = subject?.name;
                if (!perf.taskName) perf.taskName = task.title;

                // Convert grade (0-10 scale) to accuracy and add to grades
                const grade = parseFloat(submission.grade);
                if (!isNaN(grade)) {
                    perf.grades.push(grade);
                    // Simulate accuracy from grade (grade 5 = 50% accuracy)
                    perf.totalQuestions += 10;
                    perf.totalCorrect += Math.round(grade);
                    perf.totalIncorrect += 10 - Math.round(grade);
                }
            }

            // 4. Calculate accuracy for each topic and identify weaknesses
            const weakTopics = [];
            for (const [topicId, perf] of topicPerformance) {
                const accuracy = perf.totalQuestions > 0
                    ? Math.round((perf.totalCorrect / perf.totalQuestions) * 100)
                    : 0;
                const avgGrade = perf.grades.length > 0
                    ? Math.round(perf.grades.reduce((a, b) => a + b, 0) / perf.grades.length * 10) / 10
                    : 0;

                // Calculate trend (recent vs older)
                let trend = 'stable';
                const allEntries = [...perf.sessions, ...perf.submissions].sort(
                    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
                );

                if (allEntries.length >= 2) {
                    const recentEntries = allEntries.slice(0, Math.ceil(allEntries.length / 2));
                    const olderEntries = allEntries.slice(Math.ceil(allEntries.length / 2));

                    const getEntryScore = (entry) => {
                        if (entry.total_questions) {
                            return entry.total_questions > 0 ? (entry.correct_answers / entry.total_questions) * 100 : 0;
                        }
                        return parseFloat(entry.grade || 0) * 10;
                    };

                    const recentAvg = recentEntries.reduce((sum, e) => sum + getEntryScore(e), 0) / recentEntries.length;
                    const olderAvg = olderEntries.reduce((sum, e) => sum + getEntryScore(e), 0) / olderEntries.length;

                    if (recentAvg > olderAvg + 5) trend = 'improving';
                    else if (recentAvg < olderAvg - 5) trend = 'declining';
                }

                const totalActivities = perf.sessions.length + perf.submissions.length;
                const lastActivityDate = allEntries[0]?.created_at;

                // Include topics with low performance (accuracy < 80% or grade < 8)
                // Also include topics where user only has submissions (to encourage reinforcement)
                const needsReinforcement = accuracy < 80 || avgGrade < 8 || perf.sessions.length === 0;

                if (needsReinforcement) {
                    weakTopics.push({
                        topicId,
                        courseId: perf.courseId,
                        accuracy,
                        avgGrade,
                        totalSessions: totalActivities,
                        totalQuestions: perf.totalQuestions,
                        trend,
                        lastSessionDate: lastActivityDate,
                        source: perf.source,
                        topicName: perf.topicName,
                        subjectId: perf.subjectId,
                        subjectName: perf.subjectName,
                        taskName: perf.taskName,
                        hasReinforcement: perf.sessions.length > 0,
                        hasSubmissions: perf.submissions.length > 0,
                    });
                }
            }

            // Sort by accuracy (lowest first) and limit
            weakTopics.sort((a, b) => a.accuracy - b.accuracy);
            const topWeakTopics = weakTopics.slice(0, limit);

            if (topWeakTopics.length === 0) {
                return Result.ok({ recommendations: [], hasData: true, message: 'No se detectaron debilidades significativas.' });
            }

            // 5. Get topic and course details (only for topics not already populated from submissions)
            const topicIdsToFetch = topWeakTopics.filter(t => !t.topicName).map(t => t.topicId);
            const courseIds = [...new Set(topWeakTopics.map(t => t.courseId))];

            const [topicsResult, coursesResult] = await Promise.all([
                topicIdsToFetch.length > 0
                    ? supabase.client.from('topics').select('id, nombre, description, materia_id').in('id', topicIdsToFetch)
                    : { data: [] },
                supabase.client.from('courses').select('id, title').in('id', courseIds),
            ]);

            const topicsMap = new Map();
            const coursesMap = new Map();

            for (const topic of topicsResult.data || []) {
                topicsMap.set(topic.id, topic);
            }
            for (const course of coursesResult.data || []) {
                coursesMap.set(course.id, course);
            }

            // 6. Get subject details for topics (only for those not already populated)
            const subjectIdsToFetch = topWeakTopics
                .filter(t => !t.subjectName && (topicsMap.get(t.topicId)?.materia_id || t.subjectId))
                .map(t => topicsMap.get(t.topicId)?.materia_id || t.subjectId)
                .filter(Boolean);

            let subjectsMap = new Map();
            if (subjectIdsToFetch.length > 0) {
                const { data: subjectsData } = await supabase.client
                    .from('subjects')
                    .select('id, name')
                    .in('id', [...new Set(subjectIdsToFetch)]);
                for (const subject of subjectsData || []) {
                    subjectsMap.set(subject.id, subject);
                }
            }

            // 7. Build recommendations
            const recommendations = topWeakTopics.map(weak => {
                // Use data from submissions if available, otherwise from DB lookup
                const topicFromDb = topicsMap.get(weak.topicId) || {};
                const topic = {
                    nombre: weak.topicName || topicFromDb.nombre,
                    materia_id: weak.subjectId || topicFromDb.materia_id,
                };
                const course = coursesMap.get(weak.courseId) || {};
                const subject = {
                    name: weak.subjectName || subjectsMap.get(topic.materia_id)?.name,
                };

                const problemDescription = this._buildProblemDescription(weak, topic, subject);
                const interventionType = this._determineInterventionType(weak);

                return {
                    id: `rec_${weak.topicId}_${Date.now()}`,
                    type: interventionType,
                    status: 'pending',
                    priority: weak.accuracy < 50 ? 'high' : weak.accuracy < 60 ? 'medium' : 'low',

                    // Problem details
                    problem: {
                        description: problemDescription,
                        topicId: weak.topicId,
                        topicName: topic.nombre || `Tema #${weak.topicId}`,
                        courseId: weak.courseId,
                        courseName: course.title || `Curso #${weak.courseId}`,
                        subjectId: topic.materia_id || null,
                        subjectName: subject.name || null,
                    },

                    // Performance metrics (before)
                    before: {
                        accuracy: weak.accuracy,
                        avgGrade: weak.avgGrade,
                        totalSessions: weak.totalSessions,
                        totalQuestions: weak.totalQuestions,
                        trend: weak.trend,
                    },

                    // Intervention details
                    intervention: {
                        type: interventionType,
                        description: this._buildInterventionDescription(interventionType, topic),
                        questionCount: 10,
                        difficulty: 'EASY',
                        estimatedMinutes: 15,
                    },

                    // Links for actions
                    actions: {
                        reinforcement: {
                            path: `/reinforcement/${weak.courseId}`,
                            query: {
                                topicId: weak.topicId,
                                topicName: topic.nombre || '',
                                difficulty: 'EASY',
                                autoStart: 'true',
                                fromRecommendation: 'true',
                            },
                        },
                        learning: {
                            path: '/learning/course-selection',
                            query: {
                                courseId: weak.courseId,
                                topicId: weak.topicId,
                                subjectId: topic.materia_id || '',
                                topicName: topic.nombre || '',
                                fromRecommendation: 'true',
                            },
                        },
                    },

                    createdAt: new Date().toISOString(),
                };
            });

            return Result.ok({
                recommendations,
                hasData: true,
                totalWeakAreas: weakTopics.length,
                analyzedSessions: (resultsData || []).length,
                analyzedSubmissions: (submissionsData || []).length,
            });
        } catch (error) {
            console.error('[Recommendations] Error:', error.message);
            return Result.fail(error.message);
        }
    }

    /**
     * Marks a recommendation as completed and calculates the after metrics.
     */
    async completeRecommendation(userId, recommendationId, topicId) {
        try {
            const supabase = SupabaseService.getInstance();

            // Get latest results for this topic after the recommendation was started
            const { data: recentResults, error } = await supabase.client
                .from('reinforcement_results')
                .select('*')
                .eq('user_id', userId)
                .eq('topic_id', topicId)
                .order('created_at', { ascending: false })
                .limit(5);

            if (error) return Result.fail(error.message);

            if (!recentResults || recentResults.length === 0) {
                return Result.ok({ completed: false, message: 'No hay sesiones recientes para evaluar.' });
            }

            // Calculate new performance metrics
            const totalQuestions = recentResults.reduce((sum, r) => sum + (r.total_questions || 0), 0);
            const totalCorrect = recentResults.reduce((sum, r) => sum + (r.correct_answers || 0), 0);
            const accuracy = totalQuestions > 0 ? Math.round((totalCorrect / totalQuestions) * 100) : 0;
            const avgGrade = recentResults.length > 0
                ? Math.round(recentResults.reduce((sum, r) => sum + parseFloat(r.grade || 0), 0) / recentResults.length * 10) / 10
                : 0;

            return Result.ok({
                completed: true,
                after: {
                    accuracy,
                    avgGrade,
                    totalSessions: recentResults.length,
                    totalQuestions,
                },
                lastSessionDate: recentResults[0]?.created_at,
            });
        } catch (error) {
            console.error('[Recommendations] completeRecommendation error:', error.message);
            return Result.fail(error.message);
        }
    }

    _buildProblemDescription(weak, topic, subject) {
        const topicName = topic.nombre || `Tema #${weak.topicId}`;
        const subjectName = subject.name ? ` en ${subject.name}` : '';
        const taskInfo = weak.taskName ? ` (Tarea: ${weak.taskName})` : '';

        // Special message for users who only have submissions (no reinforcement yet)
        if (!weak.hasReinforcement && weak.hasSubmissions) {
            if (weak.avgGrade < 6) {
                return `Calificación de ${weak.avgGrade.toFixed(1)} en ${topicName}${subjectName}${taskInfo}. Reforzar ayudará a mejorar tu comprensión.`;
            } else if (weak.avgGrade < 8) {
                return `Nota de ${weak.avgGrade.toFixed(1)} en ${topicName}${subjectName}${taskInfo}. Puedes mejorar con práctica adicional.`;
            } else {
                return `Buen desempeño en ${topicName}${subjectName}${taskInfo}. Refuerza para dominar completamente el tema.`;
            }
        }

        // Standard messages based on accuracy
        if (weak.accuracy < 40) {
            return `El estudiante muestra dificultades significativas en ${topicName}${subjectName} con solo ${weak.accuracy}% de precisión.`;
        } else if (weak.accuracy < 55) {
            return `El estudiante necesita reforzar ${topicName}${subjectName}. Su dominio actual es del ${weak.accuracy}%.`;
        } else if (weak.accuracy < 70) {
            return `El estudiante tiene un desempeño moderado en ${topicName}${subjectName} (${weak.accuracy}% de precisión) que puede mejorar.`;
        } else {
            return `Buen progreso en ${topicName}${subjectName} (${weak.accuracy}%). Práctica adicional consolidará tu conocimiento.`;
        }
    }

    _determineInterventionType(weak) {
        // Users with only submissions (no reinforcement) get targeted reinforcement
        if (!weak.hasReinforcement && weak.hasSubmissions) {
            if (weak.avgGrade < 6) return 'intensive_reinforcement';
            if (weak.avgGrade < 8) return 'targeted_reinforcement';
            return 'practice_reinforcement';
        }

        if (weak.accuracy < 40) return 'intensive_reinforcement';
        if (weak.accuracy < 55) return 'targeted_reinforcement';
        if (weak.trend === 'declining') return 'review_reinforcement';
        return 'practice_reinforcement';
    }

    _buildInterventionDescription(type, topic) {
        const topicName = topic.nombre || 'el tema';

        switch (type) {
            case 'intensive_reinforcement':
                return `Refuerzo intensivo: 10 preguntas progresivas en ${topicName} comenzando desde nivel fácil para construir confianza.`;
            case 'targeted_reinforcement':
                return `Refuerzo dirigido: 10 preguntas enfocadas en los conceptos clave de ${topicName} que necesitan práctica.`;
            case 'review_reinforcement':
                return `Repaso guiado: 10 preguntas de revisión en ${topicName} para recuperar el nivel anterior.`;
            default:
                return `Práctica adicional: 10 preguntas para fortalecer el dominio de ${topicName}.`;
        }
    }
}
export default ReinforcementDomainService;

