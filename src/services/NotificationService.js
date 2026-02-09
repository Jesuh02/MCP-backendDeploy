/**
 * NotificationService.js
 * Servicio centralizado para envío de notificaciones (Push y Email)
 * 
 * @description Maneja el envío de notificaciones push vía Firebase Cloud Messaging (FCM)
 * y notificaciones por email vía Resend, SendGrid o Gmail SMTP
 */

import axios from 'axios';
import { createRequire } from 'module';
import { SupabaseService } from '../infrastructure/database/SupabaseService.js';
import {
    generateGradeEmailHTML,
    generateGradeModifiedEmailHTML,
    generateNewCourseEmailHTML,
    generateGenericEmailHTML,
    generateChatResponseEmailHTML
} from '../templates/emailTemplates.js';

const require = createRequire(
    import.meta.url);

// ============================================================
// SINGLETON INSTANCE
// ============================================================
let instance = null;

class NotificationService {
    constructor() {
        if (instance) {
            return instance;
        }

        this.admin = null;
        this.nodemailer = null;
        this.supabaseService = null;

        this._initializeFirebase();
        this._initializeNodemailer();
        this._initializeSupabase();

        instance = this;
    }

    /**
     * Get singleton instance
     * @returns {NotificationService}
     */
    static getInstance() {
        if (!instance) {
            instance = new NotificationService();
        }
        return instance;
    }

    /**
     * Send notification (Wrapper for sendPushNotification to fix missing method error)
     * @param {number} userId 
     * @param {string} title 
     * @param {string} body 
     */
    async sendNotification(userId, title, body) {
        // Enforce using sendPushNotification compatible signature
        return this.sendPushNotification(userId, title, body);
    }

    /**
     * Initialize Firebase Admin SDK
     * @private
     */
    _initializeFirebase() {
        try {
            this.admin = require('firebase-admin');

            // Check if already initialized
            if (this.admin.apps && this.admin.apps.length > 0) {
                console.log('✅ Firebase Admin already initialized');
                return;
            }

            // OPTION 1: Use individual environment variables (RECOMMENDED for Railway)
            if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
                console.log('🔧 NotificationService: Using individual Firebase environment variables');

                let privateKey = process.env.FIREBASE_PRIVATE_KEY;
                if (privateKey.includes('\\n')) {
                    privateKey = privateKey.replace(/\\n/g, '\n');
                }

                const serviceAccount = {
                    type: 'service_account',
                    project_id: process.env.FIREBASE_PROJECT_ID,
                    private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
                    private_key: privateKey,
                    client_email: process.env.FIREBASE_CLIENT_EMAIL,
                    client_id: process.env.FIREBASE_CLIENT_ID || '',
                    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
                    token_uri: 'https://oauth2.googleapis.com/token',
                    auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
                    client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL || ''
                };

                this.admin.initializeApp({
                    credential: this.admin.credential.cert(serviceAccount)
                });
                console.log('✅ NotificationService: Firebase Admin initialized');
            }
            // OPTION 2: Try to load from FIREBASE_SERVICE_ACCOUNT JSON (legacy)
            else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
                console.log('🔧 NotificationService: Using FIREBASE_SERVICE_ACCOUNT JSON');
                let serviceAccount;
                try {
                    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
                } catch (error) {
                    const cleaned = process.env.FIREBASE_SERVICE_ACCOUNT.toString().replace(/\\"/g, '"');
                    serviceAccount = JSON.parse(cleaned);
                }

                if (serviceAccount.private_key && serviceAccount.private_key.includes('\\n')) {
                    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
                }

                this.admin.initializeApp({
                    credential: this.admin.credential.cert(serviceAccount)
                });
                console.log('✅ NotificationService: Firebase Admin initialized from JSON');
            } else {
                console.warn('⚠️ NotificationService: Firebase not configured - push notifications disabled');
            }
        } catch (error) {
            console.warn('⚠️ NotificationService: Firebase Admin not initialized:', error.message);
        }
    }

    /**
     * Initialize Nodemailer
     * @private
     */
    _initializeNodemailer() {
        try {
            this.nodemailer = require('nodemailer');
            console.log('✅ NotificationService: Nodemailer initialized');
        } catch (e) {
            console.warn('⚠️ NotificationService: Nodemailer not available');
        }
    }

    /**
     * Initialize Supabase Service
     * @private
     */
    _initializeSupabase() {
        try {
            this.supabaseService = SupabaseService.getInstance();
        } catch (error) {
            console.error('❌ NotificationService: Failed to initialize SupabaseService:', error.message);
        }
    }

    /**
     * Check if Firebase is available for push notifications
     * @returns {boolean}
     */
    isFirebaseAvailable() {
        return !!(this.admin && this.admin.apps && this.admin.apps.length > 0);
    }

    /**
     * Get user's FCM tokens from database
     * @param {number} userId - User ID
     * @returns {Promise<string[]>} Array of FCM tokens
     */
    async getUserFCMTokens(userId) {
        if (!this.supabaseService) {
            throw new Error('SupabaseService not available');
        }

        const { data: tokens, error } = await this.supabaseService.client
            .from('user_fcm_tokens')
            .select('token')
            .eq('user_id', userId);

        if (error) {
            console.error('❌ Error getting FCM tokens:', error.message);
            return [];
        }

        if (!tokens || tokens.length === 0) {
            console.log(`ℹ️ User ${userId} has no registered FCM tokens.`);
            return [];
        }

        // Remove duplicates
        return [...new Set(tokens.map(t => t.token))];
    }

    /**
     * Remove invalid FCM tokens from database
     * @param {string[]} tokens - Array of invalid tokens to remove
     */
    async removeInvalidFCMTokens(tokens) {
        if (!this.supabaseService || tokens.length === 0) return;

        console.log('🧹 Removing invalid tokens:', tokens.length);
        await this.supabaseService.client
            .from('user_fcm_tokens')
            .delete()
            .in('token', tokens);
    }

    /**
     * Send push notification to a specific user via FCM
     * Uses individual send() calls instead of deprecated sendMulticast
     * 
     * @param {number} userId - User ID to send notification to
     * @param {string} title - Notification title
     * @param {string} body - Notification body text
     * @param {Object} data - Additional data payload
     * @returns {Promise<{success: number, failure: number}>}
     */
    async sendPushNotification(userId, title, body, data = {}) {
        if (!this.isFirebaseAvailable()) {
            console.warn('⚠️ Firebase Admin not initialized. Skipping push notification.');
            return { success: 0, failure: 0 };
        }

        try {
            const uniqueTokens = await this.getUserFCMTokens(userId);

            if (uniqueTokens.length === 0) {
                return { success: 0, failure: 0 };
            }

            // Build base message (without token, added individually)
            const baseMessage = {
                notification: { title, body },
                data: data,
                android: {
                    priority: 'high',
                    notification: {
                        channelId: 'deepseek_updates'
                    }
                }
            };

            // Send individual notifications (Google deprecated /batch API on June 20, 2024)
            console.log(`📨 Sending ${uniqueTokens.length} push notifications individually...`);

            const results = [];
            const failedTokens = [];

            for (let i = 0; i < uniqueTokens.length; i++) {
                const token = uniqueTokens[i];
                try {
                    const message = {...baseMessage, token };
                    const messageId = await this.admin.messaging().send(message);
                    results.push({ success: true, messageId });
                    console.log(`   ✅ Token ${i + 1}/${uniqueTokens.length}: Sent (${messageId})`);
                } catch (sendError) {
                    results.push({ success: false, error: sendError });
                    console.warn(`   ⚠️ Token ${i + 1}/${uniqueTokens.length} failed: ${sendError.code || sendError.message}`);

                    // Only remove tokens with invalid registration errors
                    const errorCode = sendError.code;
                    if (errorCode === 'messaging/invalid-registration-token' ||
                        errorCode === 'messaging/registration-token-not-registered' ||
                        errorCode === 'messaging/unregistered') {
                        failedTokens.push(token);
                    }
                }
            }

            const successCount = results.filter(r => r.success).length;
            const failureCount = results.filter(r => !r.success).length;
            console.log(`📨 Notifications sent to user ${userId}: ${successCount} successes, ${failureCount} failures`);

            // Clean up invalid tokens
            await this.removeInvalidFCMTokens(failedTokens);

            return { success: successCount, failure: failureCount };
        } catch (error) {
            console.error('❌ Error sending push notification:', error.message);
            return { success: 0, failure: 1 };
        }
    }

    /**
     * Get user email from database
     * @param {number} userId - User ID
     * @returns {Promise<string|null>} User email or null
     */
    async getUserEmail(userId) {
        if (!this.supabaseService) {
            return null;
        }

        const { data: user, error } = await this.supabaseService.client
            .from('usuarios')
            .select('email')
            .eq('id', userId)
            .single();

        if (error || !user || !user.email) {
            console.warn(`⚠️ No email found for userId ${userId}`);
            return null;
        }

        return user.email.trim();
    }

    /**
     * Validate email format
     * @param {string} email - Email to validate
     * @returns {boolean}
     */
    validateEmail(email) {
        if (!email) return false;
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(email);
    }

    /**
     * Send email notification using Resend API
     * @param {string} email - Recipient email
     * @param {string} subject - Email subject
     * @param {string} htmlContent - HTML content
     * @returns {Promise<boolean>} Success status
     */
    async _sendViaResend(email, subject, htmlContent) {
        if (!process.env.RESEND_API_KEY) {
            return false;
        }

        console.log('📧 Sending email via Resend HTTP API...');
        const fromEmail = 'CourseV@yisuscompany.com';
        const fromName = 'CourseV';

        try {
            const response = await axios.post('https://api.resend.com/emails', {
                from: `${fromName} <${fromEmail}>`,
                to: [email],
                subject: `📚 ${subject}`,
                html: htmlContent,
                headers: {
                    'X-Entity-Ref-ID': `coursev-${Date.now()}`,
                    'List-Unsubscribe': '<mailto:unsubscribe@yisuscompany.com>'
                }
            }, {
                headers: {
                    'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            });

            console.log(`✅ Email sent to ${email} via Resend: ${response.data.id}`);
            return true;
        } catch (error) {
            console.error('❌ Error with Resend:', error.response ? .data || error.message);

            // Retry with fallback
            console.log('🔄 Retrying email send...');
            try {
                const fallbackResponse = await axios.post('https://api.resend.com/emails', {
                    from: 'CourseV <CourseV@yisuscompany.com>',
                    to: [email],
                    subject: `📚 ${subject}`,
                    html: htmlContent
                }, {
                    headers: {
                        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
                        'Content-Type': 'application/json'
                    }
                });
                console.log(`✅ Email sent to ${email} via fallback: ${fallbackResponse.data.id}`);
                return true;
            } catch (fallbackError) {
                console.error('❌ Fallback also failed:', fallbackError.response ? .data || fallbackError.message);
            }
        }

        return false;
    }

    /**
     * Send email notification using SendGrid API
     * @param {string} email - Recipient email
     * @param {string} subject - Email subject
     * @param {string} htmlContent - HTML content
     * @returns {Promise<boolean>} Success status
     */
    async _sendViaSendGrid(email, subject, htmlContent) {
        if (!process.env.SENDGRID_API_KEY) {
            return false;
        }

        console.log('📧 Sending email via SendGrid HTTP API...');

        try {
            const response = await axios.post('https://api.sendgrid.com/v3/mail/send', {
                personalizations: [{
                    to: [{ email }],
                    subject: `📚 ${subject}`
                }],
                from: {
                    email: process.env.SENDGRID_FROM_EMAIL,
                    name: 'CourseV'
                },
                content: [{
                    type: 'text/html',
                    value: htmlContent
                }]
            }, {
                headers: {
                    'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            });

            console.log(`✅ Email sent to ${email} via SendGrid: ${response.status}`);
            return true;
        } catch (error) {
            console.error('❌ Error with SendGrid:', error.response ? .data || error.message);
            return false;
        }
    }

    /**
     * Send email notification using Gmail SMTP (local development only)
     * @param {string} email - Recipient email
     * @param {string} subject - Email subject
     * @param {string} text - Plain text content
     * @param {string} htmlContent - HTML content
     * @returns {Promise<boolean>} Success status
     */
    async _sendViaGmail(email, subject, text, htmlContent) {
        if (!this.nodemailer || !process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
            return false;
        }

        console.warn('⚠️ Using Gmail SMTP - Only works in local development, NOT on Railway');

        try {
            const transporter = this.nodemailer.createTransport({
                service: 'gmail',
                auth: {
                    user: process.env.GMAIL_USER,
                    pass: process.env.GMAIL_APP_PASSWORD
                }
            });

            const info = await transporter.sendMail({
                from: `"CourseV" <${process.env.GMAIL_USER}>`,
                to: email,
                subject: `📚 ${subject}`,
                text: text,
                html: htmlContent
            });

            console.log(`✅ Email sent to ${email}: ${info.messageId}`);
            return true;
        } catch (error) {
            console.error('❌ Error with Gmail SMTP:', error.message);
            return false;
        }
    }

    /**
     * Send email notification to a specific user
     * Optimized for Railway: Uses HTTP APIs instead of SMTP
     * 
     * @param {number} userId - User ID to send email to
     * @param {string} subject - Email subject
     * @param {string} text - Plain text content (used for HTML generation)
     * @param {Object} options - Additional options
     * @param {string} options.type - Template type: 'grade', 'grade-modified', 'new-course', 'chat-response', 'generic'
     * @param {Object} options.data - Template-specific data
     * @returns {Promise<boolean>} Success status
     */
    async sendEmailNotification(userId, subject, text, options = {}) {
        try {
            // Get user email
            const userEmail = await this.getUserEmail(userId);
            if (!userEmail) {
                return false;
            }

            // Validate email format
            if (!this.validateEmail(userEmail)) {
                console.warn(`⚠️ Invalid email for userId ${userId}: "${userEmail}"`);
                return false;
            }

            console.log(`📧 Preparing email for: ${userEmail}`);

            // Generate HTML content based on template type
            let htmlContent;
            const templateType = options.type || 'generic';
            const templateData = options.data || {};

            switch (templateType) {
                case 'grade':
                    htmlContent = generateGradeEmailHTML({
                        studentName: templateData.studentName || 'Estudiante',
                        taskTitle: templateData.taskTitle || 'Tarea',
                        grade: templateData.grade,
                        feedback: templateData.feedback || text,
                        courseName: templateData.courseName
                    });
                    break;

                case 'grade-modified':
                    htmlContent = generateGradeModifiedEmailHTML({
                        studentName: templateData.studentName || 'Estudiante',
                        taskTitle: templateData.taskTitle || 'Tarea',
                        previousGrade: templateData.previousGrade,
                        newGrade: templateData.newGrade,
                        reason: templateData.reason || text,
                        courseName: templateData.courseName
                    });
                    break;

                case 'new-course':
                    htmlContent = generateNewCourseEmailHTML({
                        courseTitle: templateData.courseTitle || subject,
                        courseDescription: templateData.courseDescription || text,
                        instructorName: templateData.instructorName,
                        thumbnailUrl: templateData.thumbnailUrl
                    });
                    break;

                case 'chat-response':
                    htmlContent = generateChatResponseEmailHTML({
                        question: templateData.question || '',
                        answer: templateData.answer || text
                    });
                    break;

                case 'generic':
                default:
                    htmlContent = generateGenericEmailHTML({
                        subject,
                        message: text
                    });
                    break;
            }

            // Try to send email using available providers
            // Priority: Resend > SendGrid > Gmail SMTP

            if (await this._sendViaResend(userEmail, subject, htmlContent)) {
                return true;
            }

            if (await this._sendViaSendGrid(userEmail, subject, htmlContent)) {
                return true;
            }

            if (await this._sendViaGmail(userEmail, subject, text, htmlContent)) {
                return true;
            }

            console.error('❌ No email service configured (RESEND_API_KEY or SENDGRID_API_KEY required for Railway)');
            return false;

        } catch (error) {
            console.error('❌ Error sending email:', error.message);
            if (error.response) {
                console.error('   HTTP Status:', error.response.status);
                console.error('   Details:', JSON.stringify(error.response.data, null, 2));
            }
            return false;
        }
    }

    /**
     * Send both push and email notification to a user
     * 
     * @param {number} userId - User ID
     * @param {string} title - Notification title (used for push)
     * @param {string} subject - Email subject
     * @param {string} message - Notification message
     * @param {Object} options - Additional options
     * @returns {Promise<{push: Object, email: boolean}>}
     */
    async sendBothNotifications(userId, title, subject, message, options = {}) {
        const results = {
            push: { success: 0, failure: 0 },
            email: false
        };

        // Send push notification
        try {
            results.push = await this.sendPushNotification(userId, title, message, options.pushData || {});
        } catch (error) {
            console.error('❌ Push notification failed:', error.message);
        }

        // Send email notification
        try {
            results.email = await this.sendEmailNotification(userId, subject, message, options);
        } catch (error) {
            console.error('❌ Email notification failed:', error.message);
        }

        return results;
    }

    /**
     * Send notifications to multiple users
     * 
     * @param {number[]} userIds - Array of user IDs
     * @param {string} title - Notification title
     * @param {string} message - Notification message
     * @param {Object} options - Additional options
     * @returns {Promise<{total: number, pushSuccess: number, emailSuccess: number}>}
     */
    async sendBulkNotifications(userIds, title, message, options = {}) {
        const results = {
            total: userIds.length,
            pushSuccess: 0,
            emailSuccess: 0
        };

        for (const userId of userIds) {
            try {
                const result = await this.sendBothNotifications(userId, title, title, message, options);
                if (result.push.success > 0) results.pushSuccess++;
                if (result.email) results.emailSuccess++;
            } catch (error) {
                console.error(`❌ Failed to notify user ${userId}:`, error.message);
            }
        }

        console.log(`📊 Bulk notification results: ${results.pushSuccess}/${results.total} push, ${results.emailSuccess}/${results.total} email`);
        return results;
    }

    /**
     * Notify all subscribers of a specific creator about a new course.
     * 
     * @param {number} creatorUserId - ID of the creator
     * @param {string} creatorUsername - Username of the creator
     * @param {Object} courseData - { id, title, thumbnailUri }
     * @returns {Promise<{success: number, total: number}>}
     */
    async notifySubscribersOfNewCourse(creatorUserId, creatorUsername, courseData) {
        console.log(`📢 Notifying subscribers of ${creatorUsername} about new course: ${courseData.title}`);

        try {
            // 1. Fetch Subscribers from Supabase
            // Table: subscriptions (subscriber_id, creator_id)
            const { data: subscribers, error } = await this.supabaseService.client
                .from('subscriptions')
                .select('subscriber_id')
                .eq('creator_id', creatorUserId);

            if (error) {
                console.error('❌ Error fetching subscribers:', error.message);
                throw error;
            }

            if (!subscribers || subscribers.length === 0) {
                console.log('ℹ️ No subscribers found for this creator.');
                return { success: 0, total: 0 };
            }

            const subscriberIds = subscribers.map(s => s.subscriber_id);
            console.log(`👥 Found ${subscriberIds.length} subscribers.`);

            // 2. Insert into 'notifications' table for In-App History
            // Table: notifications (user_id, type, title, message, related_id, is_read, created_at)
            const notificationsToInsert = subscriberIds.map(userId => ({
                user_id: userId,
                type: 'new_course', // Must match Android Notification.TYPE_NEW_COURSE
                title: '¡Nuevo curso disponible!',
                message: `${creatorUsername} ha publicado un nuevo curso: ${courseData.title}`,
                related_id: courseData.id,
                is_read: false,
                created_at: new Date()
            }));

            const { error: insertError } = await this.supabaseService.client
                .from('notifications')
                .insert(notificationsToInsert);

            if (insertError) {
                console.error('❌ Error inserting notifications into DB:', insertError.message);
                // We verify if some succeeded or fail hard? 
                // Usually insert is all or nothing. We proceed to push/email anyway.
            } else {
                console.log('✅ In-App notifications inserted successfully.');
            }

            // 3. Send Push and Email Notifications
            // Use sendBulkNotifications
            const pushTitle = '¡Nuevo Curso!';
            const pushMessage = `${creatorUsername} acaba de publicar "${courseData.title}". ¡Échale un vistazo!`;

            const results = await this.sendBulkNotifications(
                subscriberIds,
                pushTitle,
                pushMessage, {
                    // Push data payload
                    pushData: {
                        type: 'new_course',
                        courseId: String(courseData.id),
                        creatorId: String(creatorUserId)
                    },
                    // Email template data
                    type: 'new-course',
                    templateData: {
                        courseTitle: courseData.title,
                        courseDescription: `No te pierdas el nuevo contenido de ${creatorUsername}.`,
                        instructorName: creatorUsername,
                        thumbnailUrl: courseData.thumbnailUri
                    }
                }
            );

            return { success: results.pushSuccess + results.emailSuccess, total: subscriberIds.length };

        } catch (error) {
            console.error('❌ Error in notifySubscribersOfNewCourse:', error.message);
            return { success: 0, total: 0, error: error.message };
        }
    }

    /**
     * Notify video owner when someone comments on their video
     * 
     * @param {number} videoOwnerId - ID of the video owner (recipient)
     * @param {number} videoId - ID of the video
     * @param {number} commentId - ID of the comment
     * @param {string} commentAuthor - Username of the person who commented
     * @param {string} commentAuthorAvatar - Avatar URL of the commenter
     * @param {string} videoThumbnail - Video thumbnail URL
     * @param {string} commentText - The comment text (optional, for preview)
     * @returns {Promise<{success: boolean, notificationId?: number}>}
     */
    async notifyVideoComment(videoOwnerId, videoId, commentId, commentAuthor, commentAuthorAvatar, videoThumbnail, commentText = '') {
        console.log(`💬 Notifying user ${videoOwnerId} about comment from ${commentAuthor} on video ${videoId}`);

        try {
            // Create metadata with comment_id for navigation
            const metadata = JSON.stringify({ comment_id: commentId });

            // Insert notification into database
            const notification = {
                user_id: videoOwnerId,
                sender_username: commentAuthor,
                sender_avatar_url: commentAuthorAvatar,
                type: 'comment', // Must match Android Notification.TYPE_COMMENT
                title: 'Nuevo comentario',
                message: `${commentAuthor} comentó en tu video${commentText ? ': ' + commentText.substring(0, 50) : ''}`,
                thumbnail_url: videoThumbnail,
                related_id: videoId,
                metadata: metadata, // ⭐ IMPORTANTE: Incluye comment_id para navegación
                is_read: false,
                created_at: new Date()
            };

            const { data, error } = await this.supabaseService.client
                .from('notifications')
                .insert(notification)
                .select()
                .single();

            if (error) {
                console.error('❌ Error inserting comment notification:', error.message);
                throw error;
            }

            console.log(`✅ Comment notification created with ID: ${data.id}`);

            // Send push notification
            try {
                await this.sendBothNotifications(
                    videoOwnerId,
                    'Nuevo comentario',
                    'Nuevo comentario',
                    notification.message, {
                        pushData: {
                            type: 'comment',
                            videoId: String(videoId),
                            commentId: String(commentId)
                        }
                    }
                );
            } catch (pushError) {
                console.warn('⚠️ Failed to send push notification for comment:', pushError.message);
            }

            return { success: true, notificationId: data.id };

        } catch (error) {
            console.error('❌ Error in notifyVideoComment:', error.message);
            return { success: false, error: error.message };
        }
    }

    /**
     * Notify comment author when someone likes their comment
     * 
     * @param {number} commentOwnerId - ID of the comment owner (recipient)
     * @param {number} videoId - ID of the video
     * @param {number} commentId - ID of the liked comment
     * @param {string} likerUsername - Username of the person who liked
     * @param {string} likerAvatar - Avatar URL of the person who liked
     * @param {string} videoThumbnail - Video thumbnail URL
     * @returns {Promise<{success: boolean, notificationId?: number}>}
     */
    async notifyCommentLike(commentOwnerId, videoId, commentId, likerUsername, likerAvatar, videoThumbnail) {
        console.log(`❤️ Notifying user ${commentOwnerId} about like from ${likerUsername} on comment ${commentId}`);

        try {
            // Create metadata with comment_id for navigation
            const metadata = JSON.stringify({ comment_id: commentId });

            // Insert notification into database
            const notification = {
                user_id: commentOwnerId,
                sender_username: likerUsername,
                sender_avatar_url: likerAvatar,
                type: 'like', // Must match Android Notification.TYPE_LIKE
                title: 'Le gusta tu comentario',
                message: `A ${likerUsername} le gustó tu comentario`,
                thumbnail_url: videoThumbnail,
                related_id: videoId,
                metadata: metadata, // ⭐ IMPORTANTE: Incluye comment_id para navegación
                is_read: false,
                created_at: new Date()
            };

            const { data, error } = await this.supabaseService.client
                .from('notifications')
                .insert(notification)
                .select()
                .single();

            if (error) {
                console.error('❌ Error inserting like notification:', error.message);
                throw error;
            }

            console.log(`✅ Like notification created with ID: ${data.id}`);

            // Send push notification
            try {
                await this.sendBothNotifications(
                    commentOwnerId,
                    'Le gusta tu comentario',
                    'Le gusta tu comentario',
                    notification.message, {
                        pushData: {
                            type: 'like',
                            videoId: String(videoId),
                            commentId: String(commentId)
                        }
                    }
                );
            } catch (pushError) {
                console.warn('⚠️ Failed to send push notification for like:', pushError.message);
            }

            return { success: true, notificationId: data.id };

        } catch (error) {
            console.error('❌ Error in notifyCommentLike:', error.message);
            return { success: false, error: error.message };
        }
    }

    /**
     * Notify comment author when someone replies to their comment
     * 
     * @param {number} parentCommentOwnerId - ID of the parent comment owner (recipient)
     * @param {number} videoId - ID of the video
     * @param {number} parentCommentId - ID of the parent comment
     * @param {number} replyCommentId - ID of the reply comment
     * @param {string} replyAuthor - Username of the person who replied
     * @param {string} replyAuthorAvatar - Avatar URL of the replier
     * @param {string} videoThumbnail - Video thumbnail URL
     * @param {string} replyText - The reply text (optional, for preview)
     * @returns {Promise<{success: boolean, notificationId?: number}>}
     */
    async notifyCommentReply(parentCommentOwnerId, videoId, parentCommentId, replyCommentId, replyAuthor, replyAuthorAvatar, videoThumbnail, replyText = '') {
        console.log(`↩️ Notifying user ${parentCommentOwnerId} about reply from ${replyAuthor} to comment ${parentCommentId}`);

        try {
            // Create metadata with comment_id pointing to the reply for navigation
            const metadata = JSON.stringify({ comment_id: replyCommentId, parent_comment_id: parentCommentId });

            // Insert notification into database
            const notification = {
                user_id: parentCommentOwnerId,
                sender_username: replyAuthor,
                sender_avatar_url: replyAuthorAvatar,
                type: 'comment', // Use 'comment' type for replies as well
                title: 'Respuesta a tu comentario',
                message: `${replyAuthor} respondió a tu comentario${replyText ? ': ' + replyText.substring(0, 50) : ''}`,
                thumbnail_url: videoThumbnail,
                related_id: videoId,
                metadata: metadata, // ⭐ IMPORTANTE: Incluye comment_id de la respuesta
                is_read: false,
                created_at: new Date()
            };

            const { data, error } = await this.supabaseService.client
                .from('notifications')
                .insert(notification)
                .select()
                .single();

            if (error) {
                console.error('❌ Error inserting reply notification:', error.message);
                throw error;
            }

            console.log(`✅ Reply notification created with ID: ${data.id}`);

            // Send push notification
            try {
                await this.sendBothNotifications(
                    parentCommentOwnerId,
                    'Respuesta a tu comentario',
                    'Respuesta a tu comentario',
                    notification.message, {
                        pushData: {
                            type: 'comment',
                            videoId: String(videoId),
                            commentId: String(replyCommentId),
                            parentCommentId: String(parentCommentId)
                        }
                    }
                );
            } catch (pushError) {
                console.warn('⚠️ Failed to send push notification for reply:', pushError.message);
            }

            return { success: true, notificationId: data.id };

        } catch (error) {
            console.error('❌ Error in notifyCommentReply:', error.message);
            return { success: false, error: error.message };
        }
    }
}

// Export singleton instance getter and class
export { NotificationService };
export default NotificationService;