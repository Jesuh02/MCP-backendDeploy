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

// Adaptadores externos
import { R2StorageAdapter } from '../infrastructure/storage/R2StorageAdapter.js';
import { FCMAdapter } from '../infrastructure/notifications/FCMAdapter.js';
import { EmailAdapter } from '../infrastructure/notifications/EmailAdapter.js';
import { WompiAdapter } from '../infrastructure/payment/WompiAdapter.js';

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

/**
 * Inicializa todo el grafo de dependencias y retorna un objeto con todos los
 * controladores listos para montar en las rutas Express.
 *
 * @returns {object} Mapa de controladores y servicios disponibles.
 */
export function createContainer() {
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
    const storageAdapter = new R2StorageAdapter();
    const fcmAdapter = new FCMAdapter();
    const emailAdapter = new EmailAdapter();
    const paymentGateway = new WompiAdapter();

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

    // ═══════════════════════════════════════════════════════════
    // 3. SERVICIOS DE DOMINIO — Inyectar repositorios y adaptadores
    // ═══════════════════════════════════════════════════════════

    const authService = new AuthService({ userRepository: userRepo, jwtAdapter });
    const userService = new UserDomainService({ userRepository: userRepo, fileStoragePort: storageAdapter });
    const storageService = new StorageDomainService({ fileStoragePort: storageAdapter });
    const courseService = new CourseDomainService({ courseRepository: courseRepo, transactionRepository: transactionRepo, fileStoragePort: storageAdapter });
    const videoService = new VideoDomainService({ videoRepository: videoRepo, fileStoragePort: storageAdapter });
    const topicService = new TopicDomainService({ topicRepository: topicRepo, courseRepository: courseRepo });
    const taskService = new TaskDomainService({ taskRepository: taskRepo, topicRepository: topicRepo });
    const contentItemService = new ContentItemDomainService({ contentItemRepository: contentItemRepo });
    const submissionService = new SubmissionDomainService({ submissionRepository: submissionRepo, taskRepository: taskRepo, progressRepository: progressRepo });
    const subscriptionService = new SubscriptionDomainService({ subscriptionRepository: subscriptionRepo, userRepository: userRepo });
    const progressService = new ProgressDomainService({ progressRepository: progressRepo });
    // NotificationService moved up to be available for dependency injection
    const notificationService = new NotificationDomainService({ notificationRepository: notificationRepo, userRepository: userRepo, pushNotificationPort: fcmAdapter, emailPort: emailAdapter });

    // Services depending on NotificationService
    const likeService = new LikeDomainService({ likeRepository: likeRepo, notificationService, commentRepository: commentRepo, videoRepository: videoRepo, userRepository: userRepo });
    const commentService = new CommentDomainService({ commentRepository: commentRepo, videoRepository: videoRepo, notificationService, userRepository: userRepo });
    const paymentService = new PaymentDomainService({ transactionRepository: transactionRepo, courseRepository: courseRepo, paymentGatewayPort: paymentGateway });
    const personaService = new PersonaDomainService({ personaRepository: personaRepo });
    const rolService = new RolDomainService({ rolRepository: rolRepo });
    const fileContextService = new FileContextDomainService({ fileContextRepository: fileContextRepo });
    const reinforcementService = new ReinforcementDomainService({ reinforcementRepository: reinforcementRepo });

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
    const submissionController = new SubmissionController({ submissionService, storageService, storageAdapter, notificationService, userService: userService, taskService: taskService, courseService: courseService });
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

        // Servicios (por si se necesitan en rutas legacy)
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

        // Adaptadores (por si se necesitan directamente)
        storageAdapter,
        fcmAdapter,
        emailAdapter,
        paymentGateway,
    };
}

export default createContainer;