import { JWTAdapter } from '../modules/auth/infrastructure/jwt.adapter.js';
import { SupabaseService } from '../shared/database/SupabaseService.js';

import { R2StorageAdapter } from '../modules/storage/infrastructure/r2.storage.adapter.js';
import { FCMAdapter } from '../modules/notification/infrastructure/fcm.adapter.js';
import { EmailAdapter } from '../modules/notification/infrastructure/email.adapter.js';
import { EmailQueueService } from '../modules/notification/infrastructure/email-queue.service.js';
import { WompiAdapter } from '../modules/payment/infrastructure/wompi.adapter.js';
import { OpenAITTSAdapter } from '../modules/tts/infrastructure/openai-tts.adapter.js';
import { FFmpegVideoAdapter } from '../modules/video/infrastructure/ffmpeg.adapter.js';
import { LLMAdapter } from '../modules/ai/infrastructure/llm.adapter.js';
import { RAGAdapter } from '../modules/ai/infrastructure/rag.adapter.js';
import { GitHubAdapter } from '../shared/github/GitHubAdapter.js';
import { CacheAdapter } from '../shared/cache/CacheAdapter.js';
import { MetaWhatsAppAdapter } from '../modules/whatsapp/infrastructure/meta-whatsapp.adapter.js';

import { AuthService } from '../modules/auth/auth.service.js';
import { AuthController } from '../modules/auth/auth.controller.js';

import { UserDomainService } from '../modules/user/user.service.js';
import { SupabaseUserRepository } from '../modules/user/infrastructure/supabase.user.repository.js';
import { UserController } from '../modules/user/user.controller.js';

import { PersonaDomainService } from '../modules/persona/persona.service.js';
import { SupabasePersonaRepository } from '../modules/persona/infrastructure/supabase.persona.repository.js';
import { PersonaController } from '../modules/persona/persona.controller.js';

import { RolDomainService } from '../modules/rol/rol.service.js';
import { SupabaseRolRepository } from '../modules/rol/infrastructure/supabase.rol.repository.js';
import { RolController } from '../modules/rol/rol.controller.js';

import { CourseDomainService } from '../modules/course/course.service.js';
import { CourseNotificationService } from '../modules/course/course-notification.service.js';
import { SupabaseCourseRepository } from '../modules/course/infrastructure/supabase.course.repository.js';
import { CourseController } from '../modules/course/course.controller.js';

import { TopicDomainService } from '../modules/topic/topic.service.js';
import { SupabaseTopicRepository } from '../modules/topic/infrastructure/supabase.topic.repository.js';
import { TopicController } from '../modules/topic/topic.controller.js';

import { TaskDomainService } from '../modules/task/task.service.js';
import { SupabaseTaskRepository } from '../modules/task/infrastructure/supabase.task.repository.js';
import { TaskController } from '../modules/task/task.controller.js';

import { ContentItemDomainService } from '../modules/content-item/content-item.service.js';
import { SupabaseContentItemRepository } from '../modules/content-item/infrastructure/supabase.content-item.repository.js';
import { ContentItemController } from '../modules/content-item/content-item.controller.js';

import { VideoDomainService } from '../modules/video/video.service.js';
import { VideoProcessingDomainService } from '../modules/video/video-processing.service.js';
import { VideoStreamingDomainService } from '../modules/video/video-streaming.service.js';
import { SupabaseVideoRepository } from '../modules/video/infrastructure/supabase.video.repository.js';
import { VideoController } from '../modules/video/video.controller.js';
import { VideoProcessingController } from '../modules/video/video-processing.controller.js';
import { VideoStreamingController } from '../modules/video/video-streaming.controller.js';

import { SubmissionDomainService } from '../modules/submission/submission.service.js';
import { SupabaseSubmissionRepository } from '../modules/submission/infrastructure/supabase.submission.repository.js';
import { SubmissionController } from '../modules/submission/submission.controller.js';

import { SubscriptionDomainService } from '../modules/subscription/subscription.service.js';
import { SupabaseSubscriptionRepository } from '../modules/subscription/infrastructure/supabase.subscription.repository.js';
import { SubscriptionController } from '../modules/subscription/subscription.controller.js';

import { ProgressDomainService } from '../modules/progress/progress.service.js';
import { SupabaseProgressRepository } from '../modules/progress/infrastructure/supabase.progress.repository.js';
import { ProgressController } from '../modules/progress/progress.controller.js';

import { LikeDomainService } from '../modules/like/like.service.js';
import { SupabaseLikeRepository } from '../modules/like/infrastructure/supabase.like.repository.js';
import { LikeController } from '../modules/like/like.controller.js';

import { CommentDomainService } from '../modules/comment/comment.service.js';
import { SupabaseCommentRepository } from '../modules/comment/infrastructure/supabase.comment.repository.js';
import { CommentController } from '../modules/comment/comment.controller.js';

import { NotificationDomainService } from '../modules/notification/notification.service.js';
import { SupabaseNotificationRepository } from '../modules/notification/infrastructure/supabase.notification.repository.js';
import { NotificationController } from '../modules/notification/notification.controller.js';

import { PaymentDomainService } from '../modules/payment/payment.service.js';
import { SupabaseTransactionRepository } from '../modules/payment/infrastructure/supabase.transaction.repository.js';
import { PaymentController } from '../modules/payment/payment.controller.js';

import { StorageDomainService } from '../modules/storage/storage.service.js';
import { StorageController } from '../modules/storage/storage.controller.js';

import { ReinforcementDomainService } from '../modules/reinforcement/reinforcement.service.js';
import { SupabaseReinforcementRepository } from '../modules/reinforcement/infrastructure/supabase.reinforcement.repository.js';
import { ReinforcementController } from '../modules/reinforcement/reinforcement.controller.js';

import { FileContextDomainService } from '../modules/file-context/file-context.service.js';
import { SupabaseFileContextRepository } from '../modules/file-context/infrastructure/supabase.file-context.repository.js';
import { FileContextController } from '../modules/file-context/file-context.controller.js';

import { ChatMessageDomainService } from '../modules/chat/chat.service.js';
import { SupabaseChatMessageRepository } from '../modules/chat/infrastructure/supabase.chat.repository.js';
import { ChatMessageController } from '../modules/chat/chat.controller.js';

import { LLMDomainService } from '../modules/ai/llm.service.js';
import { RAGDomainService } from '../modules/ai/rag.service.js';
import { RAGService } from '../modules/ai/rag-legacy.service.js';
import { MCPDomainService } from '../modules/ai/mcp.service.js';
import { MCPService } from '../modules/ai/mcp-legacy.service.js';
import { LearningContextService } from '../modules/ai/learning-context.service.js';
import { LLMController } from '../modules/ai/llm.controller.js';
import { RAGController } from '../modules/ai/rag.controller.js';
import { MCPController } from '../modules/ai/mcp.controller.js';

import { TTSDomainService } from '../modules/tts/tts.service.js';
import { TTSController } from '../modules/tts/tts.controller.js';

import { WhatsAppDomainService } from '../modules/whatsapp/whatsapp.service.js';
import { SupabaseWhatsAppSessionRepository } from '../modules/whatsapp/infrastructure/supabase.whatsapp-session.repository.js';
import { WhatsAppController } from '../modules/whatsapp/whatsapp.controller.js';

import { HealthController } from '../modules/health/health.controller.js';

import { AppDistributionDomainService } from '../modules/app-distribution/app-distribution.service.js';
import { AppDistributionController } from '../modules/app-distribution/app-distribution.controller.js';

import { ExcelDomainService } from '../modules/excel/excel.service.js';
import { ExcelController } from '../modules/excel/excel.controller.js';

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
    const subscriptionService = new SubscriptionDomainService({ subscriptionRepository: subscriptionRepo, userRepository: userRepo, notificationService });
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