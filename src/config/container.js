/**
 * container.js — Contenedor de Inyección de Dependencias (DI Container).
 *
 * Implementa el patrón Composition Root: aquí se instancian todos los
 * adaptadores de infraestructura y se inyectan en los servicios de dominio
 * y controladores.
 *
 * Principios aplicados:
 *   - Dependency Inversion (SOLID-D): el dominio depende de puertos abstractos,
 *     no de implementaciones concretas.
 *   - Single Responsibility: este módulo SOLO se encarga del wiring.
 *   - Open/Closed: para agregar un nuevo dominio, se añade aquí sin modificar existentes.
 */

// ── Infraestructura: Adaptadores ────────────────────────────
import { JWTAdapter } from '../infrastructure/auth/JWTAdapter.js';
import { SupabaseService } from '../infrastructure/database/SupabaseService.js';

// Repositorios Supabase (adaptadores de salida)
import { SupabaseUserRepository } from '../infrastructure/database/repositories/SupabaseUserRepository.js';
import { SupabaseCourseRepository } from '../infrastructure/database/repositories/SupabaseCourseRepository.js';
import { SupabaseVideoRepository } from '../infrastructure/database/repositories/SupabaseVideoRepository.js';
import { SupabaseTopicRepository } from '../infrastructure/database/repositories/SupabaseTopicRepository.js';
import { SupabaseTaskRepository } from '../infrastructure/database/repositories/SupabaseTaskRepository.js';
import { SupabaseContentItemRepository } from '../infrastructure/database/repositories/SupabaseContentItemRepository.js';
import { SupabaseSubmissionRepository } from '../infrastructure/database/repositories/SupabaseSubmissionRepository.js';
import { SupabaseSubscriptionRepository } from '../infrastructure/database/repositories/SupabaseSubscriptionRepository.js';
import { SupabaseProgressRepository } from '../infrastructure/database/repositories/SupabaseProgressRepository.js';
import { SupabaseLikeRepository } from '../infrastructure/database/repositories/SupabaseLikeRepository.js';
import { SupabaseCommentRepository } from '../infrastructure/database/repositories/SupabaseCommentRepository.js';
import { SupabaseNotificationRepository } from '../infrastructure/database/repositories/SupabaseNotificationRepository.js';
import { SupabaseTransactionRepository } from '../infrastructure/database/repositories/SupabaseTransactionRepository.js';
import { SupabasePersonaRepository } from '../infrastructure/database/repositories/SupabasePersonaRepository.js';
import { SupabaseRolRepository } from '../infrastructure/database/repositories/SupabaseRolRepository.js';
import { SupabaseFileContextRepository } from '../infrastructure/database/repositories/SupabaseFileContextRepository.js';
import { SupabaseReinforcementRepository } from '../infrastructure/database/repositories/SupabaseReinforcementRepository.js';
import { SupabaseChatMessageRepository } from '../infrastructure/database/repositories/SupabaseChatMessageRepository.js';

// Adaptadores externos
import { R2StorageAdapter } from '../infrastructure/storage/R2StorageAdapter.js';
import { FCMAdapter } from '../infrastructure/notifications/FCMAdapter.js';
import { EmailAdapter } from '../infrastructure/notifications/EmailAdapter.js';
import { WompiAdapter } from '../infrastructure/payment/WompiAdapter.js';

import { OpenAITTSAdapter } from '../infrastructure/tts/OpenAITTSAdapter.js';
import { FFmpegVideoAdapter } from '../infrastructure/video/FFmpegVideoAdapter.js';
import { LLMAdapter } from '../infrastructure/ai/LLMAdapter.js';
import { RAGAdapter } from '../infrastructure/ai/RAGAdapter.js';
import { GitHubAdapter } from '../infrastructure/github/GitHubAdapter.js';
import { CacheAdapter } from '../infrastructure/cache/CacheAdapter.js';

// ── Dominio: Servicios (casos de uso) ───────────────────────
import { AuthService } from '../domain/services/AuthService.js';
import { UserDomainService } from '../domain/services/UserDomainService.js';
import { CourseDomainService } from '../domain/services/CourseDomainService.js';
import { VideoDomainService } from '../domain/services/VideoDomainService.js';
import { TopicDomainService } from '../domain/services/TopicDomainService.js';
import { TaskDomainService } from '../domain/services/TaskDomainService.js';
import { ContentItemDomainService } from '../domain/services/ContentItemDomainService.js';
import { SubmissionDomainService } from '../domain/services/SubmissionDomainService.js';
import { SubscriptionDomainService } from '../domain/services/SubscriptionDomainService.js';
import { ProgressDomainService } from '../domain/services/ProgressDomainService.js';
import { LikeDomainService } from '../domain/services/LikeDomainService.js';
import { CommentDomainService } from '../domain/services/CommentDomainService.js';
import { NotificationDomainService } from '../domain/services/NotificationDomainService.js';
import { PaymentDomainService } from '../domain/services/PaymentDomainService.js';
import { StorageDomainService } from '../domain/services/StorageDomainService.js';
import { PersonaDomainService } from '../domain/services/PersonaDomainService.js';
import { RolDomainService } from '../domain/services/RolDomainService.js';
import { FileContextDomainService } from '../domain/services/FileContextDomainService.js';
import { ReinforcementDomainService } from '../domain/services/ReinforcementDomainService.js';
import { ChatMessageDomainService } from '../domain/services/ChatMessageDomainService.js';

import { TTSDomainService } from '../domain/services/TTSDomainService.js';
import { VideoProcessingDomainService } from '../domain/services/VideoProcessingDomainService.js';
import { VideoStreamingDomainService } from '../domain/services/VideoStreamingDomainService.js';
import { LLMDomainService } from '../domain/services/LLMDomainService.js';
import { RAGDomainService } from '../domain/services/RAGDomainService.js';
import { MCPDomainService } from '../domain/services/MCPDomainService.js';
import { AppDistributionDomainService } from '../domain/services/AppDistributionDomainService.js';
import { ExcelDomainService } from '../domain/services/ExcelDomainService.js';
import { MCPService } from '../domain/services/MCPService.js';

// ── Interfaces: Controladores ───────────────────────────────
import { AuthController } from '../interfaces/http/controllers/AuthController.js';
import { UserController } from '../interfaces/http/controllers/UserController.js';
import { CourseController } from '../interfaces/http/controllers/CourseController.js';
import { VideoController } from '../interfaces/http/controllers/VideoController.js';
import { TopicController } from '../interfaces/http/controllers/TopicController.js';
import { TaskController } from '../interfaces/http/controllers/TaskController.js';
import { ContentItemController } from '../interfaces/http/controllers/ContentItemController.js';
import { SubmissionController } from '../interfaces/http/controllers/SubmissionController.js';
import { SubscriptionController } from '../interfaces/http/controllers/SubscriptionController.js';
import { ProgressController } from '../interfaces/http/controllers/ProgressController.js';
import { LikeController } from '../interfaces/http/controllers/LikeController.js';
import { CommentController } from '../interfaces/http/controllers/CommentController.js';
import { NotificationController } from '../interfaces/http/controllers/NotificationController.js';
import { PaymentController } from '../interfaces/http/controllers/PaymentController.js';
import { StorageController } from '../interfaces/http/controllers/StorageController.js';
import { HealthController } from '../interfaces/http/controllers/HealthController.js';
import { PersonaController } from '../interfaces/http/controllers/PersonaController.js';
import { RolController } from '../interfaces/http/controllers/RolController.js';
import { FileContextController } from '../interfaces/http/controllers/FileContextController.js';
import { ReinforcementController } from '../interfaces/http/controllers/ReinforcementController.js';
import { ChatMessageController } from '../interfaces/http/controllers/ChatMessageController.js';

import { TTSController } from '../interfaces/http/controllers/TTSController.js';
import { LLMController } from '../interfaces/http/controllers/LLMController.js';
import { VideoProcessingController } from '../interfaces/http/controllers/VideoProcessingController.js';
import { VideoStreamingController } from '../interfaces/http/controllers/VideoStreamingController.js';
import { RAGController } from '../interfaces/http/controllers/RAGController.js';
import { MCPController } from '../interfaces/http/controllers/MCPController.js';
import { AppDistributionController } from '../interfaces/http/controllers/AppDistributionController.js';
import { ExcelController } from '../interfaces/http/controllers/ExcelController.js';

/**
 * Inicializa todo el grafo de dependencias y retorna un objeto con todos los
 * controladores listos para montar en las rutas Express.
 *
 * @returns {object} Mapa de controladores y servicios disponibles.
 */
export function createContainer() {
    // ═══════════════════════════════════════════════════════════
    // HELPER: Safe adapter initialization (Robustness Principle)
    // Non-critical adapters failing must NOT crash the server.
    // ═══════════════════════════════════════════════════════════

    function safeInit(name, factory) {
        try {
            return factory();
        } catch (e) {
            console.warn(`⚠️ Container: ${name} failed to initialize — ${e.message}`);
            return null;
        }
    }

    // ═══════════════════════════════════════════════════════════
    // 1. INFRAESTRUCTURA — Instanciar adaptadores
    // ═══════════════════════════════════════════════════════════

    let supabase, client;
    try {
        supabase = SupabaseService.getInstance();
        client = supabase.client;
    } catch (e) {
        console.warn('⚠️ Container: Supabase no disponible —', e.message);
        client = null;
    }

    const jwtAdapter = new JWTAdapter();

    // Adapters are individually guarded to follow the Robustness Principle:
    // failures in non-critical adapters (AI, TTS, video processing) must NOT
    // prevent the core API (videos, users, courses) from starting.

    const storageAdapter = safeInit('R2StorageAdapter', () => new R2StorageAdapter());
    const fcmAdapter = safeInit('FCMAdapter', () => new FCMAdapter());
    const emailAdapter = safeInit('EmailAdapter', () => new EmailAdapter());
    const paymentGateway = safeInit('WompiAdapter', () => new WompiAdapter());

    const ttsAdapter = safeInit('OpenAITTSAdapter', () => new OpenAITTSAdapter());
    const videoProcessingAdapter = safeInit('FFmpegVideoAdapter', () => new FFmpegVideoAdapter());
    const llmAdapter = safeInit('LLMAdapter', () => new LLMAdapter());
    const ragAdapter = safeInit('RAGAdapter', () => new RAGAdapter());
    const githubAdapter = safeInit('GitHubAdapter', () => new GitHubAdapter());
    const cacheAdapter = safeInit('CacheAdapter', () => new CacheAdapter());

    // ═══════════════════════════════════════════════════════════
    // 2. REPOSITORIOS — Inyectar cliente Supabase
    // ═══════════════════════════════════════════════════════════

    const userRepo = new SupabaseUserRepository(client);
    const courseRepo = new SupabaseCourseRepository(client);
    const videoRepo = new SupabaseVideoRepository(client);
    const topicRepo = new SupabaseTopicRepository(client);
    const taskRepo = new SupabaseTaskRepository(client);
    const contentItemRepo = new SupabaseContentItemRepository(client);
    const submissionRepo = new SupabaseSubmissionRepository(client);
    const subscriptionRepo = new SupabaseSubscriptionRepository(client);
    const progressRepo = new SupabaseProgressRepository(client);
    const likeRepo = new SupabaseLikeRepository(client);
    const commentRepo = new SupabaseCommentRepository(client);
    const notificationRepo = new SupabaseNotificationRepository(client);
    const transactionRepo = new SupabaseTransactionRepository(client);
    const personaRepo = new SupabasePersonaRepository(client);
    const rolRepo = new SupabaseRolRepository(client);
    const fileContextRepo = new SupabaseFileContextRepository(client);
    const reinforcementRepo = new SupabaseReinforcementRepository(client);
    const chatMessageRepo = new SupabaseChatMessageRepository(client);

    // ═══════════════════════════════════════════════════════════
    // 3. SERVICIOS DE DOMINIO — Inyectar repositorios y adaptadores
    //    Orden determinado por el grafo de dependencias.
    // ═══════════════════════════════════════════════════════════

    // Nivel 0: servicios sin dependencias inter-servicio
    const authService = new AuthService({ userRepository: userRepo, jwtAdapter });
    const userService = new UserDomainService({ userRepository: userRepo, fileStoragePort: storageAdapter });
    const storageService = new StorageDomainService({ fileStoragePort: storageAdapter });
    const courseService = new CourseDomainService({ courseRepository: courseRepo, transactionRepository: transactionRepo, progressRepository: progressRepo, fileStoragePort: storageAdapter });
    const videoService = new VideoDomainService({ videoRepository: videoRepo, fileStoragePort: storageAdapter });
    const topicService = new TopicDomainService({ topicRepository: topicRepo, courseRepository: courseRepo });
    const contentItemService = new ContentItemDomainService({ contentItemRepository: contentItemRepo });
    const subscriptionService = new SubscriptionDomainService({ subscriptionRepository: subscriptionRepo, userRepository: userRepo });
    const progressService = new ProgressDomainService({ progressRepository: progressRepo, taskRepository: taskRepo, submissionRepository: submissionRepo });
    const notificationService = new NotificationDomainService({ notificationRepository: notificationRepo, userRepository: userRepo, pushNotificationPort: fcmAdapter, emailPort: emailAdapter });
    const paymentService = new PaymentDomainService({ transactionRepository: transactionRepo, courseRepository: courseRepo, paymentGatewayPort: paymentGateway, progressRepository: progressRepo });
    const personaService = new PersonaDomainService({ personaRepository: personaRepo });
    const rolService = new RolDomainService({ rolRepository: rolRepo, courseRepository: courseRepo });
    const fileContextService = new FileContextDomainService({ fileContextRepository: fileContextRepo });
    const reinforcementService = new ReinforcementDomainService({ reinforcementRepository: reinforcementRepo });
    const chatMessageService = new ChatMessageDomainService({ chatMessageRepository: chatMessageRepo });

    // Nivel 1: servicios que dependen de notificationService u otros servicios
    const taskService = new TaskDomainService({ taskRepository: taskRepo, topicRepository: topicRepo, notificationService, courseService, progressService, userService });
    const submissionService = new SubmissionDomainService({ submissionRepository: submissionRepo, taskRepository: taskRepo, progressRepository: progressRepo, notificationService, courseService, topicService, userService, fileStoragePort: storageAdapter });
    const likeService = new LikeDomainService({ likeRepository: likeRepo, notificationService, commentRepository: commentRepo, videoRepository: videoRepo, userRepository: userRepo });
    const commentService = new CommentDomainService({ commentRepository: commentRepo, videoRepository: videoRepo, notificationService, userRepository: userRepo });

    // Nivel 2: servicios de IA y procesamiento
    const ttsService = new TTSDomainService({ ttsPort: ttsAdapter });
    const videoProcessingService = new VideoProcessingDomainService({ videoProcessingPort: videoProcessingAdapter, fileStoragePort: storageAdapter });
    const videoStreamingService = new VideoStreamingDomainService({ videoRepository: videoRepo, fileStoragePort: storageAdapter });

    // Evict expired URL cache entries every 10 minutes
    setInterval(() => videoStreamingService.evictExpiredCache(), 10 * 60 * 1000);
    const llmDomainService = new LLMDomainService({
        llmPort: llmAdapter,
        ragPort: ragAdapter,
        cachePort: cacheAdapter,
        githubPort: githubAdapter,
        fileStoragePort: storageAdapter,
        submissionRepository: submissionRepo,
        fileContextRepository: fileContextRepo,
        reinforcementRepository: reinforcementRepo,
    });
    const ragDomainService = new RAGDomainService({ ragPort: ragAdapter, llmPort: llmAdapter });
    const mcpDomainService = new MCPDomainService({
        userRepository: userRepo,
        courseRepository: courseRepo,
        taskRepository: taskRepo,
        submissionRepository: submissionRepo,
        notificationService,
        llmPort: llmAdapter,
    });

    // MCPService legacy (singleton interno) — se inyecta en ExcelDomainService
    const mcpServiceLegacy = new MCPService();
    const excelService = new ExcelDomainService({ mcpService: mcpServiceLegacy, fileStoragePort: storageAdapter });

    // ═══════════════════════════════════════════════════════════
    // 4. CONTROLADORES — Inyectar servicios de dominio
    // ═══════════════════════════════════════════════════════════

    const authController = new AuthController({ authService });
    const userController = new UserController({ userService });
    const courseController = new CourseController({ courseService });
    const videoController = new VideoController({ videoService });
    const topicController = new TopicController({ topicService });
    const taskController = new TaskController({ taskService });
    const contentItemController = new ContentItemController({ contentItemService });
    const submissionController = new SubmissionController({ submissionService, storageService, storageAdapter });
    const subscriptionController = new SubscriptionController({ subscriptionService });
    const progressController = new ProgressController({ progressService });
    const likeController = new LikeController({ likeService });
    const commentController = new CommentController({ commentService });
    const notificationController = new NotificationController({ notificationService });
    const paymentController = new PaymentController({ paymentService });
    const storageController = new StorageController({ storageService });
    const healthController = new HealthController({ fileStoragePort: storageAdapter, pushNotificationPort: fcmAdapter, emailPort: emailAdapter, paymentGatewayPort: paymentGateway });
    const personaController = new PersonaController({ personaService });
    const rolController = new RolController({ rolService });
    const fileContextController = new FileContextController({ fileContextService });
    const reinforcementController = new ReinforcementController({ reinforcementService });
    const chatMessageController = new ChatMessageController({ chatMessageService });

    const ttsController = new TTSController({ ttsService });
    const llmController = new LLMController({ llmService: llmDomainService });
    const videoProcessingController = new VideoProcessingController({ videoProcessingService });
    const videoStreamingController = new VideoStreamingController({ videoStreamingService });
    const ragController = new RAGController({ ragService: ragDomainService });
    const mcpController = new MCPController({ mcpService: mcpDomainService });

    // Nivel 3: Distribución de app (sin dependencias de dominio pesadas)
    const appDistributionService = new AppDistributionDomainService();
    const appDistributionController = new AppDistributionController({ appDistributionService });

    // Excel
    const excelController = new ExcelController({ excelService });

    return {
        // Middleware
        jwtAdapter,

        // Controladores (para montar rutas)
        authController,
        userController,
        courseController,
        videoController,
        topicController,
        taskController,
        contentItemController,
        submissionController,
        subscriptionController,
        progressController,
        likeController,
        commentController,
        notificationController,
        paymentController,
        storageController,
        healthController,
        personaController,
        rolController,
        fileContextController,
        reinforcementController,
        chatMessageController,

        ttsController,
        llmController,
        videoProcessingController,
        videoStreamingController,
        ragController,
        mcpController,
        appDistributionController,
        excelController,

        // Servicios de dominio
        authService,
        userService,
        courseService,
        videoService,
        topicService,
        taskService,
        contentItemService,
        submissionService,
        subscriptionService,
        progressService,
        likeService,
        commentService,
        notificationService,
        paymentService,
        storageService,
        personaService,
        rolService,
        fileContextService,
        reinforcementService,
        chatMessageService,
        ttsService,
        videoProcessingService,
        videoStreamingService,
        llmDomainService,
        ragDomainService,
        mcpDomainService,
        appDistributionService,
        excelService,
        mcpServiceLegacy, // Injected for server.js legacy tools

        // Adaptadores
        storageAdapter,
        fcmAdapter,
        emailAdapter,
        paymentGateway,
        ttsAdapter,
        videoProcessingAdapter,
        llmAdapter,
        ragAdapter,
        githubAdapter,
        cacheAdapter,
    };
}

export default createContainer;