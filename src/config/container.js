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
import { EmailQueueService } from '../infrastructure/notifications/EmailQueueService.js';
import { WompiAdapter } from '../infrastructure/payment/WompiAdapter.js';

import { OpenAITTSAdapter } from '../infrastructure/tts/OpenAITTSAdapter.js';
import { FFmpegVideoAdapter } from '../infrastructure/video/FFmpegVideoAdapter.js';
import { LLMAdapter } from '../infrastructure/ai/LLMAdapter.js';
import { RAGAdapter } from '../infrastructure/ai/RAGAdapter.js';
import { GitHubAdapter } from '../infrastructure/github/GitHubAdapter.js';
import { CacheAdapter } from '../infrastructure/cache/CacheAdapter.js';
import { MetaWhatsAppAdapter } from '../infrastructure/messaging/MetaWhatsAppAdapter.js';
import { SupabaseWhatsAppSessionRepository } from '../infrastructure/database/repositories/SupabaseWhatsAppSessionRepository.js';

// ── Dominio: Servicios (casos de uso) ───────────────────────
import { AuthService } from '../domain/services/AuthService.js';
import { UserDomainService } from '../domain/services/UserDomainService.js';
import { CourseDomainService } from '../domain/services/CourseDomainService.js';
import { CourseNotificationService } from '../domain/services/CourseNotificationService.js';
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
import { LearningContextService } from '../domain/services/LearningContextService.js';
import { RAGService } from '../domain/services/RAGService.js';
import { WhatsAppDomainService } from '../domain/services/WhatsAppDomainService.js';

// ── Interfaces: Controladores ───────────────────────────────
import { AuthController } from '../interfaces/controllers/AuthController.js';
import { UserController } from '../interfaces/controllers/UserController.js';
import { CourseController } from '../interfaces/controllers/CourseController.js';
import { VideoController } from '../interfaces/controllers/VideoController.js';
import { TopicController } from '../interfaces/controllers/TopicController.js';
import { TaskController } from '../interfaces/controllers/TaskController.js';
import { ContentItemController } from '../interfaces/controllers/ContentItemController.js';
import { SubmissionController } from '../interfaces/controllers/SubmissionController.js';
import { SubscriptionController } from '../interfaces/controllers/SubscriptionController.js';
import { ProgressController } from '../interfaces/controllers/ProgressController.js';
import { LikeController } from '../interfaces/controllers/LikeController.js';
import { CommentController } from '../interfaces/controllers/CommentController.js';
import { NotificationController } from '../interfaces/controllers/NotificationController.js';
import { PaymentController } from '../interfaces/controllers/PaymentController.js';
import { StorageController } from '../interfaces/controllers/StorageController.js';
import { HealthController } from '../interfaces/controllers/HealthController.js';
import { PersonaController } from '../interfaces/controllers/PersonaController.js';
import { RolController } from '../interfaces/controllers/RolController.js';
import { FileContextController } from '../interfaces/controllers/FileContextController.js';
import { ReinforcementController } from '../interfaces/controllers/ReinforcementController.js';
import { ChatMessageController } from '../interfaces/controllers/ChatMessageController.js';
import { TTSController } from '../interfaces/controllers/TTSController.js';
import { LLMController } from '../interfaces/controllers/LLMController.js';
import { VideoProcessingController } from '../interfaces/controllers/VideoProcessingController.js';
import { VideoStreamingController } from '../interfaces/controllers/VideoStreamingController.js';
import { RAGController } from '../interfaces/controllers/RAGController.js';
import { MCPController } from '../interfaces/controllers/MCPController.js';
import { AppDistributionController } from '../interfaces/controllers/AppDistributionController.js';
import { ExcelController } from '../interfaces/controllers/ExcelController.js';
import { WhatsAppController } from '../interfaces/controllers/WhatsAppController.js';

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
    const emailQueueService = new EmailQueueService(); // Instancia singleton
    const paymentGateway = safeInit('WompiAdapter', () => new WompiAdapter());

    const ttsAdapter = safeInit('OpenAITTSAdapter', () => new OpenAITTSAdapter());
    const videoProcessingAdapter = safeInit('FFmpegVideoAdapter', () => new FFmpegVideoAdapter());
    const llmAdapter = safeInit('LLMAdapter', () => new LLMAdapter());
    const ragAdapter = safeInit('RAGAdapter', () => new RAGAdapter());
    const githubAdapter = safeInit('GitHubAdapter', () => new GitHubAdapter());
    const cacheAdapter = safeInit('CacheAdapter', () => new CacheAdapter());

    // WhatsApp adapter (non-critical — missing env vars will not crash)
    const whatsAppAdapter = safeInit('MetaWhatsAppAdapter', () => new MetaWhatsAppAdapter({
        accessToken: process.env.WHATSAPP_ACCESS_TOKEN,
        // Prefer explicit phone_number_id when available to avoid using a WABA ID
        phoneId: process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_ID,
        appSecret: process.env.WHATSAPP_APP_SECRET,
        otpTemplateName: process.env.WHATSAPP_OTP_TEMPLATE || 'hello_world',
        otpTemplateLanguage: process.env.WHATSAPP_OTP_TEMPLATE_LANG || 'en_US',
    }));

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
    const whatsAppSessionRepo = new SupabaseWhatsAppSessionRepository(client);

    // ═══════════════════════════════════════════════════════════
    // 3. SERVICIOS DE DOMINIO — Inyectar repositorios y adaptadores
    //    Orden determinado por el grafo de dependencias.
    // ═══════════════════════════════════════════════════════════

    // Nivel 0: servicios sin dependencias inter-servicio
    const authService = new AuthService({ userRepository: userRepo, jwtAdapter });
    const userService = new UserDomainService({ userRepository: userRepo, fileStoragePort: storageAdapter });
    const storageService = new StorageDomainService({ fileStoragePort: storageAdapter });
    const topicService = new TopicDomainService({ topicRepository: topicRepo, courseRepository: courseRepo });
    const contentItemService = new ContentItemDomainService({ contentItemRepository: contentItemRepo });
    const subscriptionService = new SubscriptionDomainService({ subscriptionRepository: subscriptionRepo, userRepository: userRepo });
    const progressService = new ProgressDomainService({ progressRepository: progressRepo, taskRepository: taskRepo, submissionRepository: submissionRepo, courseRepository: courseRepo, userRepository: userRepo });
    const notificationService = new NotificationDomainService({
        notificationRepository: notificationRepo,
        userRepository: userRepo,
        pushNotificationPort: fcmAdapter,
        emailPort: emailAdapter,
        userService,
        courseRepository: courseRepo,
        topicRepository: topicRepo,
        taskRepository: taskRepo,
    });
    const paymentService = new PaymentDomainService({ transactionRepository: transactionRepo, courseRepository: courseRepo, paymentGatewayPort: paymentGateway, progressRepository: progressRepo });
    const personaService = new PersonaDomainService({ personaRepository: personaRepo });
    const rolService = new RolDomainService({ rolRepository: rolRepo, courseRepository: courseRepo });
    const fileContextService = new FileContextDomainService({ fileContextRepository: fileContextRepo });
    const reinforcementService = new ReinforcementDomainService({ reinforcementRepository: reinforcementRepo });

    const chatMessageService = new ChatMessageDomainService({ chatMessageRepository: chatMessageRepo });

    // Nivel 1: servicios que dependen de servicios del Nivel 0
    const videoService = new VideoDomainService({
        videoRepository: videoRepo,
        fileStoragePort: storageAdapter,
        courseRepository: courseRepo,
        notificationService,
        subscriptionService,
        userRepository: userRepo
    });
    // Crear courseNotificationService primero (depende de nivel 0)
    const courseNotificationService = new CourseNotificationService({
        subscriptionRepository: subscriptionRepo,
        notificationService,
        userService,
        emailQueueService
    });

    // courseService necesita courseNotificationService, por lo que se instancia aquí
    const courseService = new CourseDomainService({
        courseRepository: courseRepo,
        transactionRepository: transactionRepo,
        progressRepository: progressRepo,
        fileStoragePort: storageAdapter,
        courseNotificationService
    });

    // Nivel 1: servicios que dependen de notificationService u otros servicios
    const taskService = new TaskDomainService({ taskRepository: taskRepo, topicRepository: topicRepo, notificationService, courseService, progressService, userService });
    const submissionService = new SubmissionDomainService({ submissionRepository: submissionRepo, taskRepository: taskRepo, progressRepository: progressRepo, progressService, notificationService, courseService, topicService, userService, fileStoragePort: storageAdapter });
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

    // LearningContextService — contexto de aprendizaje unificado (SRP)
    const ragServiceInstance = safeInit('RAGService', () => new RAGService());
    const learningContextService = new LearningContextService({
        topicRepository: topicRepo,
        taskRepository: taskRepo,
        contentItemRepository: contentItemRepo,
        ragService: ragServiceInstance,
        mcpService: mcpServiceLegacy,
    });

    // Nivel 3: WhatsApp (depende de MCP, LLM, repos)
    const whatsAppDomainService = safeInit('WhatsAppDomainService', () => new WhatsAppDomainService({
        whatsAppPort: whatsAppAdapter,
        whatsAppSessionRepo,
        userRepository: userRepo,
        rolRepository: rolRepo,
        // Pass the legacy MCPService implementation so the WhatsApp flow can
        // execute SQL queries and generate Excel via existing MCP APIs.
        mcpDomainService: mcpServiceLegacy,
        excelService,
        llmDomainService,
        submissionRepository: submissionRepo,
        progressRepository: progressRepo,
        courseRepository: courseRepo,
        chatMessageRepository: chatMessageRepo,
    }));

    // ═══════════════════════════════════════════════════════════
    // 4. CONTROLADORES — Inyectar servicios de dominio
    // ═══════════════════════════════════════════════════════════

    const authController = new AuthController({ authService });
    const userController = new UserController({ userService, whatsAppService: whatsAppDomainService });
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
    const reinforcementController = new ReinforcementController({ reinforcementService, learningContextService });
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

    // WhatsApp
    const whatsAppController = safeInit('WhatsAppController', () => new WhatsAppController({
        whatsAppService: whatsAppDomainService,
        verifyToken: process.env.WHATSAPP_VERIFY_TOKEN,
    }));

    return {
        // Middleware
        jwtAdapter,
        supabaseService: supabase, // For diagnostics endpoint

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
        whatsAppController,

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
        learningContextService,
        whatsAppDomainService,

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
        whatsAppAdapter,
    };
}

export default createContainer;