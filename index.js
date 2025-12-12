// CRITICAL: Load environment variables FIRST
import './src/config/env.js';

import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import { encode } from 'gpt-3-encoder';
import ragCache from './rag_cache.js';
import ndjson from 'ndjson';
import { networkInterfaces } from 'os';
import { PDFLoader } from 'langchain/document_loaders/fs/pdf';
import { TextLoader } from 'langchain/document_loaders/fs/text';
import { DocxLoader } from 'langchain/document_loaders/fs/docx';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { LLMService } from './src/infrastructure/ai/LLMService.js';
import { MCPService } from './src/domain/services/MCPService.js';
import { SupabaseService } from './src/infrastructure/database/SupabaseService.js';

import { createRequire } from 'module';
const require = createRequire(
    import.meta.url);

const app = express();
const PORT = process.env.PORT || 3001;
const MAX_TOKENS = 4096;

// Initialize Firebase Admin (with error handling)
let admin;
try {
    admin = require('firebase-admin');
} catch (e) {
    console.warn('⚠️ Firebase Admin not available:', e.message);
}

// Initialize Nodemailer for Email Notifications
let nodemailer;
try {
    nodemailer = require('nodemailer');
    console.log('✅ Nodemailer initialized');
} catch (e) {
    console.warn('⚠️ Nodemailer not found. Email notifications will not work. Run: npm install nodemailer');
}

// Only initialize Firebase if admin was loaded successfully
if (admin) {
    try {
        // OPTION 1: Use individual environment variables (RECOMMENDED for Railway)
        if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
            console.log('🔧 Using individual Firebase environment variables');

            let privateKey = process.env.FIREBASE_PRIVATE_KEY;

            // Fix escaped newlines if present
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

            console.log('🔑 Private key info:', {
                length: privateKey.length,
                startsCorrect: privateKey.startsWith('-----BEGIN PRIVATE KEY-----'),
                endsCorrect: privateKey.trim().endsWith('-----END PRIVATE KEY-----')
            });

            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            console.log('✅ Firebase Admin initialized from individual environment variables');
        }
        // OPTION 2: Try to load from FIREBASE_SERVICE_ACCOUNT JSON (legacy)
        else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            console.log('🔧 Using FIREBASE_SERVICE_ACCOUNT JSON');
            let serviceAccount;
            try {
                serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
            } catch (error) {
                console.warn('⚠️ Error parsing FIREBASE_SERVICE_ACCOUNT JSON:', error.message);
                // Attempt to fix common copy-paste issues with escaped quotes
                const cleaned = process.env.FIREBASE_SERVICE_ACCOUNT.toString().replace(/\\"/g, '"');
                serviceAccount = JSON.parse(cleaned);
            }

            // Fix private_key newlines
            if (serviceAccount.private_key) {
                let privateKey = serviceAccount.private_key;
                if (privateKey.includes('\\n')) {
                    privateKey = privateKey.replace(/\\n/g, '\n');
                }
                serviceAccount.private_key = privateKey;

                console.log('🔑 Private key processed:', {
                    length: privateKey.length,
                    startsCorrect: privateKey.startsWith('-----BEGIN PRIVATE KEY-----'),
                    endsCorrect: privateKey.trim().endsWith('-----END PRIVATE KEY-----')
                });
            }

            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            console.log('✅ Firebase Admin initialized from FIREBASE_SERVICE_ACCOUNT JSON');
        }
        // OPTION 3: Fallback to local file
        else {
            console.log('🔧 Using local serviceAccountKey.json file');
            const serviceAccount = require('./serviceAccountKey.json');
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            console.log('✅ Firebase Admin initialized from file');
        }
    } catch (error) {
        console.warn('⚠️ Firebase Admin not initialized:', error.message);
        console.warn('💡 Use individual env vars: FIREBASE_PROJECT_ID, FIREBASE_PRIVATE_KEY, FIREBASE_CLIENT_EMAIL');
    }
} else {
    console.warn('⚠️ Firebase Admin package not available - push notifications disabled');
}

// Initialize LLMService with DeepSeek
let llmService = null;
try {
    llmService = LLMService.getInstance();
    console.log('✅ LLMService initialized with DeepSeek');
} catch (error) {
    console.error('❌ Failed to initialize LLMService:', error.message);
}

/**
 * Helper function to call DeepSeek via LLMService
 * Replaces all Ollama calls with DeepSeek API
 */
async function callDeepSeek(systemPrompt, userPrompt) {
    if (!llmService || !llmService.model) {
        throw new Error('LLMService not available - DeepSeek not configured');
    }

    const messages = [];
    if (systemPrompt) {
        messages.push(new SystemMessage(systemPrompt));
    }
    messages.push(new HumanMessage(userPrompt));

    console.log('🤖 Calling DeepSeek v2.3...');
    const response = await llmService.generateResponse(messages);

    // Extract content from response
    const content = response.content || response.text || response.toString();
    console.log('✅ DeepSeek response received:', content.length, 'characters');

    return content;
}

// Initialize MCPService for GitHub analysis
let mcpService = null;
try {
    mcpService = new MCPService();
    console.log('✅ MCPService initialized for GitHub analysis');
} catch (error) {
    console.error('❌ Failed to initialize MCPService:', error.message);
}

// Initialize SupabaseService
let supabaseService = null;
try {
    supabaseService = SupabaseService.getInstance();
    console.log('✅ SupabaseService initialized');
} catch (error) {
    console.error('❌ Failed to initialize SupabaseService:', error.message);
}

/**
 * Detecta si el nombre de archivo indica un repositorio de GitHub
 * Formato: github_OWNER_REPO o github_OWNER_REPO_BRANCH
 */
function isGitHubRepository(fileName) {
    if (!fileName) return false;
    return fileName.toLowerCase().startsWith('github_') ||
        fileName.toLowerCase().includes('github.com');
}

/**
 * Extrae la URL de GitHub del nombre del archivo
 * Convierte: github_Jesuh02_ProjectCourseV1 -> https://github.com/Jesuh02/ProjectCourseV1
 */
function extractGitHubUrl(fileName) {
    if (!fileName) return null;

    // Si ya es una URL completa
    if (fileName.includes('github.com')) {
        const urlMatch = fileName.match(/https?:\/\/github\.com\/[\w-]+\/[\w-]+/);
        return urlMatch ? urlMatch[0] : null;
    }

    // Formato: github_OWNER_REPO o github_OWNER_REPO_BRANCH
    const match = fileName.match(/github[_-](\w+)[_-](\w+)(?:[_-](\w+))?/i);
    if (match) {
        const owner = match[1];
        const repo = match[2];
        return `https://github.com/${owner}/${repo}`;
    }

    return null;
}

/**
 * Analiza un repositorio de GitHub usando el MCP Service
 */
async function analyzeGitHubRepository(repoUrl, taskDescription, prompt) {
    console.log('🐙 INICIANDO ANÁLISIS DE REPOSITORIO GITHUB...');
    console.log('   📦 URL:', repoUrl);
    console.log('   📋 Tarea:', taskDescription ? .substring(0, 100) || 'Sin descripción');

    if (!mcpService) {
        throw new Error('MCPService no está disponible');
    }

    try {
        const result = await mcpService.analyzeGitHubRepo(repoUrl, {
            taskDescription: taskDescription,
            criteria: prompt,
            maxFiles: 25
        });

        console.log('✅ Análisis de GitHub completado');
        console.log('   📊 Nota:', result.grade || 'N/A');
        console.log('   📁 Archivos analizados:', result.filesAnalyzed ? .length || 0);

        return result;
    } catch (error) {
        console.error('❌ Error analizando repositorio GitHub:', error.message);
        throw error;
    }
}

/**
 * Formatea el resultado del análisis de GitHub para respuesta al usuario
 */
function formatGitHubAnalysisResponse(analysis, taskDescription) {
    const grade = analysis.grade || 0;
    const feedback = analysis.feedback || analysis.detailedAnalysis || 'Sin feedback disponible';
    const strengths = analysis.strengths || [];
    const improvements = analysis.improvements || [];
    const filesAnalyzed = analysis.filesAnalyzed || [];

    let response = `📊 **CALIFICACIÓN DEL REPOSITORIO: ${grade}/100**\n\n`;

    // Estado basado en la nota
    if (grade >= 80) {
        response += `🎯 **ESTADO:** ✅ APROBADO - Excelente trabajo\n\n`;
    } else if (grade >= 60) {
        response += `🎯 **ESTADO:** ⚠️ APROBADO CON OBSERVACIONES\n\n`;
    } else if (grade >= 40) {
        response += `🎯 **ESTADO:** 📝 NECESITA MEJORAS\n\n`;
    } else {
        response += `🎯 **ESTADO:** ❌ REQUIERE REVISIÓN SIGNIFICATIVA\n\n`;
    }

    // Información del repositorio
    if (analysis.repository) {
        response += `📦 **REPOSITORIO:** ${analysis.repository.fullName || analysis.repository.name || 'N/A'}\n`;
        if (analysis.repository.description) {
            response += `📝 **Descripción:** ${analysis.repository.description}\n`;
        }
        response += `\n`;
    }

    // Feedback principal
    response += `💬 **EVALUACIÓN:**\n${feedback}\n\n`;

    // Fortalezas
    if (strengths.length > 0) {
        response += `✅ **FORTALEZAS:**\n`;
        strengths.forEach((s, i) => {
            response += `${i + 1}. ${s}\n`;
        });
        response += `\n`;
    }

    // Áreas de mejora
    if (improvements.length > 0) {
        response += `📈 **ÁREAS DE MEJORA:**\n`;
        improvements.forEach((imp, i) => {
            response += `${i + 1}. ${imp}\n`;
        });
        response += `\n`;
    }

    // Archivos analizados (resumido)
    if (filesAnalyzed.length > 0) {
        response += `📁 **ARCHIVOS ANALIZADOS:** ${filesAnalyzed.length} archivos\n`;
        // Mostrar solo los primeros 5
        const filesToShow = filesAnalyzed.slice(0, 5);
        filesToShow.forEach(f => {
            response += `   • ${f}\n`;
        });
        if (filesAnalyzed.length > 5) {
            response += `   ... y ${filesAnalyzed.length - 5} archivos más\n`;
        }
    }

    return response;
}

// Helper: update task_submissions row in Supabase via REST (requires SUPABASE_URL and SUPABASE_KEY env vars)
async function updateTaskSubmissionSupabase(submissionId, grade, feedback) {
    try {
        const supabaseUrl = process.env.SUPABASE_URL || '';
        const supabaseKey = process.env.SUPABASE_KEY || '';
        if (!supabaseUrl || !supabaseKey) {
            console.log('⚠️ Supabase env not configured; skipping remote update');
            return false;
        }
        const url = `${supabaseUrl.replace(/\/+$/, '')}/rest/v1/task_submissions?id=eq.${submissionId}`;
        const payload = {};
        if (grade !== null && typeof grade !== 'undefined') payload.grade = grade;
        if (feedback !== null && typeof feedback !== 'undefined') payload.feedback = feedback;

        const resp = await axios.patch(url, payload, {
            headers: {
                'apikey': supabaseKey,
                'Authorization': `Bearer ${supabaseKey}`,
                'Content-Type': 'application/json'
            }
        });
        console.log(`✅ Supabase updated task_submission ${submissionId}: status=${resp.status}`);
        return resp.status >= 200 && resp.status < 300;
    } catch (err) {
        console.log('❌ Error updating Supabase task_submission:', err.message);
        return false;
    }
}

// Configurar bodyParser.json() ANTES de las rutas
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.json({ limit: '50mb' }));

/**
 * Envía una notificación push a un usuario específico vía FCM
 */
async function sendPushNotification(userId, title, body, data = {}) {
    if (!admin || !admin.apps || !admin.apps.length) {
        console.warn('⚠️ Firebase Admin no está inicializado. Saltando notificación push.');
        return;
    }

    try {
        // 1. Obtener los tokens del usuario desde Supabase
        const { data: tokens, error } = await supabaseService.client
            .from('user_fcm_tokens')
            .select('token')
            .eq('user_id', userId);

        if (error) {
            console.error('❌ Error obteniendo tokens FCM:', error.message);
            return;
        }

        if (!tokens || tokens.length === 0) {
            console.log(`ℹ️ El usuario ${userId} no tiene tokens FCM registrados.`);
            return;
        }

        const registrationTokens = tokens.map(t => t.token);

        // Eliminar duplicados si los hay
        const uniqueTokens = [...new Set(registrationTokens)];

        // 2. Construir el mensaje
        const message = {
            notification: { title, body },
            data: data,
            tokens: uniqueTokens,
            android: {
                priority: 'high',
                notification: {
                    channelId: 'deepseek_updates'
                }
            }
        };

        // 3. Enviar vía FCM Multicast
        const response = await admin.messaging().sendMulticast(message);
        console.log(`📨 Notificaciones enviadas a usuario ${userId}: ${response.successCount} éxitos, ${response.failureCount} fallos`);

        // Limpiar tokens inválidos
        if (response.failureCount > 0) {
            const failedTokens = [];
            response.responses.forEach((resp, idx) => {
                if (!resp.success) {
                    failedTokens.push(uniqueTokens[idx]);
                }
            });

            if (failedTokens.length > 0) {
                console.log('🧹 Limpiando tokens inválidos:', failedTokens.length);
                await supabaseService.client
                    .from('user_fcm_tokens')
                    .delete()
                    .in('token', failedTokens);
            }
        }

    } catch (error) {
        console.error('❌ Error enviando notificación:', error);
    }
}

/**
 * Envía una notificación por correo electrónico a un usuario específico
 * OPTIMIZADO PARA RAILWAY: Usa HTTP APIs en lugar de SMTP
 */
async function sendEmailNotification(userId, subject, text) {
    try {
        // 1. Obtener el email del usuario desde Supabase
        const { data: user, error } = await supabaseService.client
            .from('usuarios')
            .select('email')
            .eq('id', userId)
            .single();

        if (error || !user || !user.email) {
            console.warn(`⚠️ No se encontró email para userId ${userId}`);
            return;
        }

        // 🔒 VALIDACIÓN: Verificar que el email tenga formato válido
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        const userEmail = user.email.trim();

        if (!userEmail || !emailRegex.test(userEmail)) {
            console.warn(`⚠️ Email inválido para userId ${userId}: "${user.email}"`);
            return;
        }

        console.log(`📧 Preparando email para: ${userEmail}`);

        // Limpiar el texto de caracteres que pueden parecer spam
        const cleanText = text
            .replace(/🔥|💥|⚡|🚀|💰|💸|🎁|🎉/g, '') // Eliminar emojis promocionales
            .replace(/!!!+/g, '!') // Reducir múltiples signos de exclamación
            .replace(/\*\*\*/g, '') // Eliminar énfasis excesivo
            .trim();

        const htmlContent = `
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="X-UA-Compatible" content="IE=edge">
    <title>${subject}</title>
    <style>
        @keyframes float {
            0%, 100% { transform: translateY(0px); }
            50% { transform: translateY(-15px); }
        }
        @keyframes wave {
            0%, 100% { transform: rotate(-5deg); }
            50% { transform: rotate(5deg); }
        }
        @keyframes pulse {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.05); }
        }
        @keyframes shine {
            0% { background-position: -200% center; }
            100% { background-position: 200% center; }
        }
        .animated-illustration {
            animation: float 3s ease-in-out infinite;
        }
        .hand {
            animation: wave 2s ease-in-out infinite;
            transform-origin: bottom right;
        }
        .coffee-machine {
            animation: pulse 2s ease-in-out infinite;
        }
        .shine-effect {
            background: linear-gradient(90deg, transparent, rgba(255,255,255,0.3), transparent);
            background-size: 200% 100%;
            animation: shine 3s linear infinite;
        }
    </style>
</head>
<body style="margin: 0; padding: 0; background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%); font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="padding: 40px 20px;">
        <tr>
            <td align="center">
                <!-- Animated Illustration Header -->
                <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; margin-bottom: 20px;">
                    <tr>
                        <td align="center" style="padding: 30px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 16px 16px 0 0; position: relative; overflow: hidden;">
                            <div style="position: relative; z-index: 2;">
                                <!-- SVG Animated Illustration -->
                                <svg width="280" height="200" viewBox="0 0 280 200" xmlns="http://www.w3.org/2000/svg" style="margin-bottom: 20px;">
                                    <!-- Desk -->
                                    <rect x="40" y="140" width="200" height="15" rx="5" fill="#2d5016" opacity="0.8"/>
                                    <rect x="35" y="155" width="210" height="8" rx="4" fill="#1a3a0f"/>
                                    
                                    <!-- Coffee Machine (animated) -->
                                    <g class="coffee-machine">
                                        <rect x="165" y="100" width="50" height="40" rx="5" fill="#FFD93D"/>
                                        <rect x="170" y="105" width="15" height="8" rx="2" fill="#4a4a4a"/>
                                        <rect x="195" y="105" width="15" height="8" rx="2" fill="#4a4a4a"/>
                                        <circle cx="190" cy="125" r="6" fill="#FF6B6B"/>
                                        <rect x="175" y="135" width="10" height="5" rx="1" fill="#6c5ce7"/>
                                    </g>
                                    
                                    <!-- Plant -->
                                    <ellipse cx="230" cy="135" rx="8" ry="5" fill="#8B4513"/>
                                    <path d="M230,135 Q220,125 225,115 T230,105" stroke="#27ae60" stroke-width="3" fill="none"/>
                                    <path d="M230,135 Q240,125 235,115 T230,105" stroke="#27ae60" stroke-width="3" fill="none"/>
                                    <circle cx="225" cy="110" r="8" fill="#2ecc71"/>
                                    <circle cx="235" cy="110" r="8" fill="#2ecc71"/>
                                    
                                    <!-- Person (animated) -->
                                    <g class="animated-illustration">
                                        <!-- Body -->
                                        <ellipse cx="120" cy="135" rx="25" ry="20" fill="#6c5ce7"/>
                                        <rect x="95" y="125" width="50" height="35" rx="8" fill="#6c5ce7"/>
                                        
                                        <!-- Neck -->
                                        <rect x="110" y="95" width="20" height="12" rx="3" fill="#ffd1a3"/>
                                        
                                        <!-- Head -->
                                        <circle cx="120" cy="80" r="20" fill="#ffd1a3"/>
                                        
                                        <!-- Hair -->
                                        <path d="M105,75 Q100,65 110,60 Q120,55 130,60 Q140,65 135,75" fill="#2c3e50"/>
                                        <ellipse cx="108" cy="82" rx="8" ry="15" fill="#2c3e50"/>
                                        <ellipse cx="132" cy="82" rx="8" ry="15" fill="#2c3e50"/>
                                        
                                        <!-- Eyes -->
                                        <circle cx="113" cy="78" r="2" fill="#2c3e50"/>
                                        <circle cx="127" cy="78" r="2" fill="#2c3e50"/>
                                        
                                        <!-- Smile -->
                                        <path d="M113,88 Q120,92 127,88" stroke="#2c3e50" stroke-width="2" fill="none" stroke-linecap="round"/>
                                        
                                        <!-- Arm with wave animation -->
                                        <g class="hand">
                                            <path d="M145,120 Q155,115 160,125" stroke="#ffd1a3" stroke-width="8" fill="none" stroke-linecap="round"/>
                                            <circle cx="162" cy="128" r="6" fill="#ffd1a3"/>
                                        </g>
                                        
                                        <!-- Book -->
                                        <rect x="75" y="125" width="20" height="15" rx="2" fill="#e74c3c"/>
                                        <line x1="85" y1="125" x2="85" y2="140" stroke="#c0392b" stroke-width="1"/>
                                    </g>
                                </svg>
                                
                                <h1 style="margin: 0; color: #ffffff; font-size: 32px; font-weight: 700; text-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                                    CourseV
                                </h1>
                                <p style="margin: 8px 0 0 0; color: #ffffff; font-size: 14px; opacity: 0.95; font-weight: 500;">
                                    Plataforma Educativa Inteligente
                                </p>
                            </div>
                            
                            <!-- Decorative circles -->
                            <div style="position: absolute; top: 20px; left: 20px; width: 60px; height: 60px; border-radius: 50%; background: rgba(255,255,255,0.1);"></div>
                            <div style="position: absolute; bottom: 20px; right: 20px; width: 80px; height: 80px; border-radius: 50%; background: rgba(255,255,255,0.1);"></div>
                        </td>
                    </tr>
                </table>
                
                <!-- Main Content Card -->
                <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="background-color: #ffffff; border-radius: 0 0 16px 16px; box-shadow: 0 10px 30px rgba(0,0,0,0.1); max-width: 600px;">
                    <!-- Content -->
                    <tr>
                        <td style="padding: 40px 35px;">
                            <h2 style="margin: 0 0 20px 0; color: #2d3748; font-size: 24px; font-weight: 700; line-height: 1.3;">
                                ${subject}
                            </h2>
                            <div style="color: #4a5568; font-size: 16px; line-height: 1.8; margin-bottom: 30px;">
                                ${cleanText.replace(/\n/g, '<br>')}
                            </div>
                        </td>
                    </tr>
                    
                    <!-- Footer -->
                    <tr>
                        <td style="background: linear-gradient(135deg, #f7fafc 0%, #edf2f7 100%); padding: 30px 35px; border-top: 2px solid #e2e8f0; border-radius: 0 0 16px 16px;">
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                                <tr>
                                    <td style="text-align: center;">
                                        <p style="margin: 0 0 12px 0; color: #718096; font-size: 14px; font-weight: 500;">
                                            📚 Notificación oficial de CourseV
                                        </p>
                                        <p style="margin: 0 0 15px 0; color: #a0aec0; font-size: 12px;">
                                            © ${new Date().getFullYear()} CourseV. Todos los derechos reservados.
                                        </p>
                                        <div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid #e2e8f0;">
                                            <a href="https://yisuscompany.com" style="display: inline-block; padding: 10px 24px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #ffffff; text-decoration: none; border-radius: 6px; font-size: 13px; font-weight: 600; box-shadow: 0 4px 12px rgba(102, 126, 234, 0.3);">
                                                Visitar yisuscompany.com
                                            </a>
                                        </div>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                </table>
                
                <!-- Unsubscribe Section -->
                <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="margin-top: 25px; max-width: 600px;">
                    <tr>
                        <td style="text-align: center; padding: 20px; background-color: rgba(255,255,255,0.7); border-radius: 8px;">
                            <p style="margin: 0 0 8px 0; color: #718096; font-size: 12px;">
                                Has recibido este correo porque tienes una cuenta activa en CourseV
                            </p>
                            <p style="margin: 0; font-size: 12px;">
                                <a href="mailto:unsubscribe@yisuscompany.com?subject=Unsubscribe" style="color: #667eea; text-decoration: none; font-weight: 500;">
                                    ✉️ Cancelar suscripción
                                </a>
                            </p>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;

        // 2. OPCIÓN 1: Resend HTTP API (RECOMENDADO para Railway)
        if (process.env.RESEND_API_KEY) {
            console.log('📧 Enviando email via Resend HTTP API...');

            // ✅ Dominio verificado: yisuscompany.com (IONOS DNS configurado)
            // Registros DNS configurados en IONOS:
            // - MX: inbound-smtp.us-east-1.amazonaws.com
            // - TXT resend._domainkey: [DKIM key]
            // - MX send: feedback-smtp.us-east-1.amazonses.com
            // - TXT send: v=spf1 include:amazonses.com ~all
            // - TXT _dmarc: v=DMARC1; p=none;
            const fromEmail = 'CourseV@yisuscompany.com'; // ✅ Dominio verificado en Resend
            const fromName = 'CourseV - Plataforma Educativa'; // Nombre profesional del remitente

            try {
                const resendResponse = await axios.post('https://api.resend.com/emails', {
                    from: `${fromName} <${fromEmail}>`, // Formato: "Nombre <email@domain.com>"
                    to: [userEmail],
                    subject: subject,
                    html: htmlContent,
                    // Headers adicionales para evitar spam
                    headers: {
                        'X-Entity-Ref-ID': `coursev-${Date.now()}`,
                        'X-Mailer': 'CourseV Education Platform v1.0',
                        'List-Unsubscribe': `<mailto:unsubscribe@yisuscompany.com?subject=Unsubscribe>`,
                        'Precedence': 'bulk'
                    },
                    // Tags para tracking en Resend
                    tags: [
                        { name: 'category', value: 'notification' },
                        { name: 'app', value: 'coursev' }
                    ]
                }, {
                    headers: {
                        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
                        'Content-Type': 'application/json'
                    }
                });

                console.log(`✅ Email enviado a ${userEmail} via Resend desde ${fromEmail}: ${resendResponse.data.id}`);
                return;
            } catch (resendError) {
                console.error('❌ Error con Resend:', resendError.response ? .data || resendError.message);
                // Fallback a onboarding@resend.dev si falla el dominio personalizado
                console.log('🔄 Reintentando con email por defecto de Resend...');
                try {
                    const fallbackResponse = await axios.post('https://api.resend.com/emails', {
                        from: 'onboarding@resend.dev',
                        to: [userEmail],
                        subject: subject,
                        html: htmlContent
                    }, {
                        headers: {
                            'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
                            'Content-Type': 'application/json'
                        }
                    });
                    console.log(`✅ Email enviado a ${userEmail} via fallback: ${fallbackResponse.data.id}`);
                    return;
                } catch (fallbackError) {
                    console.error('❌ Fallback también falló:', fallbackError.response ? .data || fallbackError.message);
                }
            }
        }

        // 3. OPCIÓN 2: SendGrid HTTP API
        if (process.env.SENDGRID_API_KEY) {
            console.log('📧 Enviando email via SendGrid HTTP API...');

            const sgResponse = await axios.post('https://api.sendgrid.com/v3/mail/send', {
                personalizations: [{
                    to: [{ email: userEmail }],
                    subject: subject
                }],
                from: {
                    email: process.env.SENDGRID_FROM_EMAIL || 'noreply@example.com',
                    name: 'TareaMov AI'
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

            console.log(`✅ Email enviado a ${userEmail} via SendGrid: ${sgResponse.status}`);
            return;
        }

        // 4. FALLBACK: Gmail SMTP (⚠️ NO funciona en Railway, solo desarrollo local)
        if (nodemailer && process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
            console.warn('⚠️ Usando Gmail SMTP - Solo funciona en desarrollo local, NO en Railway');

            const transporter = nodemailer.createTransport({
                service: 'gmail',
                auth: {
                    user: process.env.GMAIL_USER,
                    pass: process.env.GMAIL_APP_PASSWORD
                }
            });

            const info = await transporter.sendMail({
                from: `"TareaMov AI" <${process.env.GMAIL_USER}>`,
                to: userEmail,
                subject: subject,
                text: text,
                html: htmlContent
            });

            console.log(`✅ Email enviado a ${userEmail}: ${info.messageId}`);
            return;
        }

        console.error('❌ No hay servicio de email configurado (RESEND_API_KEY o SENDGRID_API_KEY requeridos para Railway)');

    } catch (error) {
        console.error('❌ Error enviando email:', error.message);
        if (error.response) {
            console.error('   HTTP Status:', error.response.status);
            console.error('   Detalles:', JSON.stringify(error.response.data, null, 2));
        }
    }
}

// Configurar timeouts globales para Express
app.use((req, res, next) => {
    // Timeout de 25 minutos para todas las rutas
    req.setTimeout(1500000); // 25 minutos
    res.setTimeout(1500000); // 25 minutos
    next();
});

/**
 * Analiza el archivo y la descripción, asigna nota y resumen, y almacena en cache.
 * Retorna { nota, resumen, cumplimiento }
 */
app.post('/analizar-entrega', async(req, res) => {
    const { submissionId, fileContent, contentSummary, ollamaUrl, fileType, fileName } = req.body;

    if (!submissionId || !fileContent || typeof contentSummary === 'undefined' || !ollamaUrl) {
        return res.status(400).json({ error: 'Faltan datos requeridos.' });
    }

    // Detectar si el archivo no pudo ser procesado correctamente
    const esArchivoNoProcessable = fileContent.includes('Tipo de archivo no soportado') ||
        fileContent.includes('ESTADO DEL ANÁLISIS') ||
        fileContent.includes('no pudo ser procesado') ||
        fileType === 'UNKNOWN' ||
        fileType === 'unknown' ||
        fileContent.length < 100;

    if (esArchivoNoProcessable) {
        // Si el archivo no es procesable, devolver nota 0 con explicación clara
        const nota = 0;
        const cumplimiento = 'El archivo no pudo ser analizado correctamente.';
        const resumen = `❌ NO SE PUEDE CALIFICAR: El archivo enviado (${fileName || 'sin nombre'}) no pudo ser procesado o no contiene contenido legible. 

📋 DESCRIPCIÓN DE LA TAREA: ${contentSummary}

⚠️ PROBLEMAS DETECTADOS:
- El archivo puede estar en un formato no soportado
- El archivo puede estar corrupto o vacío
- El sistema no pudo extraer el contenido del archivo

💡 RECOMENDACIÓN: 
1. Verifica que el archivo esté en un formato compatible (PDF, DOCX, TXT, SQL, etc.)
2. Asegúrate de que el archivo no esté corrupto
3. Si es un archivo de Google Drive, descárgalo localmente primero
4. Vuelve a subir el archivo en un formato compatible

Para poder calificar esta tarea, necesito poder leer y analizar el contenido del archivo.`;

        ragCache[submissionId] = { nota, resumen, cumplimiento };
        return res.json({ nota, resumen, cumplimiento });
    }

    // Extracción de contexto usando LangChain
    let textoExtraido = fileContent;
    try {
        if (fileType === 'pdf') {
            // const { PDFLoader } = require('langchain/document_loaders/fs/pdf');
            const buffer = Buffer.from(fileContent, 'base64');
            const loader = new PDFLoader(buffer);
            const docs = await loader.load();
            textoExtraido = docs.map(doc => doc.pageContent).join('\n');
        } else if (fileType === 'txt') {
            // const { TextLoader } = require('langchain/document_loaders/fs/text');
            const loader = new TextLoader(fileContent);
            const docs = await loader.load();
            textoExtraido = docs.map(doc => doc.pageContent).join('\n');
        } else if (fileType === 'docx') {
            // const { DocxLoader } = require('langchain/document_loaders/fs/docx');
            const buffer = Buffer.from(fileContent, 'base64');
            const loader = new DocxLoader(buffer);
            const docs = await loader.load();
            textoExtraido = docs.map(doc => doc.pageContent).join('\n');
        }
    } catch (err) {
        // Si LangChain falla, usar el contenido original
        textoExtraido = fileContent;
    }

    // Estrategia: resumir contenido para ahorrar recursos
    const resumenArchivo = textoExtraido.length > 500 ? textoExtraido.slice(0, 500) + '\n...resumido...' : textoExtraido;
    let nota = 0;
    let cumplimiento = '';
    let resumen = '';

    // Lógica de calificación estricta mejorada
    const descripcionLower = contentSummary.toLowerCase();
    const archivoLower = fileContent.toLowerCase();

    // Función auxiliar para detectar incompatibilidades específicas
    const detectarIncompatibilidad = (descripcion, archivo) => {
        // Patrones de tecnologías/lenguajes específicos con mayor precisión
        const patrones = {
            python: {
                keywords: ['python', 'py\b', '\.py\b', 'import\s+\w+', 'def\s+\w+', 'print\(', 'from\s+\w+', 'if\s+__name__', 'elif\s+', 'elif:', 'range\('],
                extensions: ['.py'],
                syntax: ['import ', 'def ', 'print(', 'if __name__', 'elif ', 'range(']
            },
            java: {
                keywords: ['java\b', 'class\s+\w+', 'public\s+static', '\.java\b', 'import\s+java', 'System\.out', 'public\s+class', 'private\s+', 'protected\s+'],
                extensions: ['.java'],
                syntax: ['public class', 'System.out', 'import java', 'public static']
            },
            javascript: {
                keywords: ['javascript', 'js\b', '\.js\b', 'function\s*\(', 'var\s+', 'let\s+', 'const\s+', 'console\.log', '=>', 'document\.'],
                extensions: ['.js'],
                syntax: ['function(', 'var ', 'let ', 'const ', 'console.log', '=>', 'document.']
            },
            html: {
                keywords: ['html\b', '\.html\b', '<html>', '<head>', '<body>', '<div>', '<!DOCTYPE', '<p>', '<h1>', '<script>'],
                extensions: ['.html'],
                syntax: ['<html>', '<head>', '<body>', '<div>', '<!DOCTYPE', '<p>', '<h1>']
            },
            css: {
                keywords: ['css\b', '\.css\b', '{.*}', '@media', '#\w+', '\.[\w-]+\s*{', 'background:', 'color:', 'margin:'],
                extensions: ['.css'],
                syntax: ['{', '}', '@media', 'background:', 'color:', 'margin:', 'padding:']
            },
            sql: {
                keywords: ['sql\b', 'select\s+', 'insert\s+', 'update\s+', 'delete\s+', 'create\s+table', 'alter\s+table', 'from\s+', 'where\s+'],
                extensions: ['.sql'],
                syntax: ['SELECT ', 'INSERT ', 'UPDATE ', 'DELETE ', 'CREATE TABLE', 'FROM ', 'WHERE ']
            },
            php: {
                keywords: ['php\b', '\.php\b', '<\?php', '\$\w+', 'echo\s+', 'mysqli_'],
                extensions: ['.php'],
                syntax: ['<?php', '$', 'echo ', 'mysqli_']
            },
            csharp: {
                keywords: ['c#', 'csharp', '\.cs\b', 'using\s+System', 'namespace\s+', 'Console\.WriteLine'],
                extensions: ['.cs'],
                syntax: ['using System', 'namespace ', 'Console.WriteLine']
            }
        };

        // Detectar qué tecnología se solicita en la descripción
        const tecnologiaSolicitada = [];
        for (const [tech, config] of Object.entries(patrones)) {
            const hasKeywords = config.keywords.some(keyword => new RegExp(keyword, 'i').test(descripcion));
            const hasExtensions = config.extensions.some(ext => descripcion.includes(ext));
            const hasSyntax = config.syntax.some(syntax => descripcion.toLowerCase().includes(syntax.toLowerCase()));

            if (hasKeywords || hasExtensions || hasSyntax) {
                tecnologiaSolicitada.push(tech);
            }
        }

        // Detectar qué tecnología está presente en el archivo
        const tecnologiaPresente = [];
        for (const [tech, config] of Object.entries(patrones)) {
            const hasKeywords = config.keywords.some(keyword => new RegExp(keyword, 'i').test(archivo));
            const hasSyntax = config.syntax.some(syntax => archivo.toLowerCase().includes(syntax.toLowerCase()));

            if (hasKeywords || hasSyntax) {
                tecnologiaPresente.push(tech);
            }
        }

        // Si se solicita una tecnología específica pero el archivo contiene otra diferente
        if (tecnologiaSolicitada.length > 0 && tecnologiaPresente.length > 0) {
            const hayCoincidencia = tecnologiaSolicitada.some(tech => tecnologiaPresente.includes(tech));
            if (!hayCoincidencia) {
                return {
                    incompatible: true,
                    mensaje: `Se solicitó ${tecnologiaSolicitada.join(', ')} pero el archivo contiene ${tecnologiaPresente.join(', ')}`
                };
            }
        }

        // Si se solicita una tecnología específica pero no está presente en el archivo
        if (tecnologiaSolicitada.length > 0 && tecnologiaPresente.length === 0) {
            return {
                incompatible: true,
                mensaje: `Se solicitó ${tecnologiaSolicitada.join(', ')} pero el archivo no contiene código de esta tecnología`
            };
        }

        // Validaciones adicionales por contenido temático MEJORADAS
        const temasDescripcion = [];
        const temasArchivo = [];

        // Detectar temas específicos en la descripción con mayor precisión
        if (descripcion.includes('calculadora') || descripcion.includes('operaciones matemáticas') || descripcion.includes('calcular')) temasDescripcion.push('calculadora');
        if (descripcion.includes('base de datos') || descripcion.includes('database') || descripcion.includes('bd ') || descripcion.includes('mysql') || descripcion.includes('sql')) temasDescripcion.push('base_datos');
        if (descripcion.includes('web') || descripcion.includes('página') || descripcion.includes('sitio web')) temasDescripcion.push('web');
        if (descripcion.includes('juego') || descripcion.includes('game') || descripcion.includes('videojuego')) temasDescripcion.push('juego');
        if (descripcion.includes('api') || descripcion.includes('servicio') || descripcion.includes('endpoint')) temasDescripcion.push('api');

        // TEMAS ESPECÍFICOS CRÍTICOS - Detección de dominios específicos
        if (descripcion.includes('banco') || descripcion.includes('bancario') || descripcion.includes('cuenta bancaria') || descripcion.includes('transacciones bancarias') || descripcion.includes('sistema bancario')) temasDescripcion.push('banco');
        if (descripcion.includes('películas') || descripcion.includes('cine') || descripcion.includes('film') || descripcion.includes('movie') || descripcion.includes('proyección')) temasDescripcion.push('peliculas');
        if (descripcion.includes('hospital') || descripcion.includes('médico') || descripcion.includes('paciente') || descripcion.includes('clínica')) temasDescripcion.push('hospital');
        if (descripcion.includes('escuela') || descripcion.includes('estudiante') || descripcion.includes('alumno') || descripcion.includes('universidad')) temasDescripcion.push('educacion');
        if (descripcion.includes('tienda') || descripcion.includes('productos') || descripcion.includes('inventario') || descripcion.includes('ventas')) temasDescripcion.push('tienda');
        if (descripcion.includes('biblioteca') || descripcion.includes('libros') || descripcion.includes('autor') || descripcion.includes('préstamo')) temasDescripcion.push('biblioteca');
        if (descripcion.includes('empleados') || descripcion.includes('recursos humanos') || descripcion.includes('nómina') || descripcion.includes('personal')) temasDescripcion.push('rrhh');

        // Detectar temas específicos en el archivo con mayor precisión
        if (archivo.includes('calcular') || archivo.includes('sumar') || archivo.includes('restar') || archivo.includes('operacion') || archivo.includes('matematica')) temasArchivo.push('calculadora');
        if (archivo.includes('select') || archivo.includes('insert') || archivo.includes('database') || archivo.includes('create table') || archivo.includes('mysql')) temasArchivo.push('base_datos');
        if (archivo.includes('<html>') || archivo.includes('<body>') || archivo.includes('css') || archivo.includes('web')) temasArchivo.push('web');
        if (archivo.includes('score') || archivo.includes('player') || archivo.includes('game') || archivo.includes('jugar')) temasArchivo.push('juego');
        if (archivo.includes('endpoint') || archivo.includes('request') || archivo.includes('response') || archivo.includes('api')) temasArchivo.push('api');

        // TEMAS ESPECÍFICOS CRÍTICOS EN EL ARCHIVO - Detección de dominios específicos
        if (archivo.includes('banco') || archivo.includes('cuenta') || archivo.includes('saldo') || archivo.includes('transaccion') || archivo.includes('cliente_banco') || archivo.includes('numero_cuenta')) temasArchivo.push('banco');
        if (archivo.includes('pelicula') || archivo.includes('titulo_pel') || archivo.includes('genero_pel') || archivo.includes('cine') || archivo.includes('proyeccion') || archivo.includes('ticket') || archivo.includes('movies')) temasArchivo.push('peliculas');
        if (archivo.includes('paciente') || archivo.includes('medico') || archivo.includes('hospital') || archivo.includes('diagnostico') || archivo.includes('tratamiento')) temasArchivo.push('hospital');
        if (archivo.includes('estudiante') || archivo.includes('alumno') || archivo.includes('curso') || archivo.includes('calificacion') || archivo.includes('matricula')) temasArchivo.push('educacion');
        if (archivo.includes('producto') || archivo.includes('precio') || archivo.includes('inventario') || archivo.includes('venta') || archivo.includes('cliente_tienda')) temasArchivo.push('tienda');
        if (archivo.includes('libro') || archivo.includes('autor') || archivo.includes('editorial') || archivo.includes('prestamo') || archivo.includes('biblioteca')) temasArchivo.push('biblioteca');
        if (archivo.includes('empleado') || archivo.includes('salario') || archivo.includes('departamento') || archivo.includes('nomina') || archivo.includes('personal')) temasArchivo.push('rrhh');

        // VALIDACIÓN CRÍTICA: Si hay temas específicos solicitados pero el archivo trata de otro tema
        if (temasDescripcion.length > 0 && temasArchivo.length > 0) {
            const hayCoincidenciaTema = temasDescripcion.some(tema => temasArchivo.includes(tema));
            if (!hayCoincidenciaTema) {
                return {
                    incompatible: true,
                    mensaje: `Se solicitó un proyecto sobre ${temasDescripcion.join(', ')} pero el archivo trata sobre ${temasArchivo.join(', ')}. INCOMPATIBILIDAD TEMÁTICA TOTAL.`
                };
            }
        }

        // VALIDACIÓN ADICIONAL: Casos específicos críticos que siempre deben dar nota 0
        const incompatibilidadesCriticas = [
            // Banco vs otros temas
            { descripcion: ['banco'], archivo: ['peliculas'], mensaje: 'Se solicitó sistema bancario pero se entregó base de datos de películas' },
            { descripcion: ['banco'], archivo: ['hospital'], mensaje: 'Se solicitó sistema bancario pero se entregó base de datos hospitalaria' },
            { descripcion: ['banco'], archivo: ['tienda'], mensaje: 'Se solicitó sistema bancario pero se entregó base de datos de tienda' },

            // Películas vs otros temas
            { descripcion: ['peliculas'], archivo: ['banco'], mensaje: 'Se solicitó sistema de películas pero se entregó base de datos bancaria' },
            { descripcion: ['peliculas'], archivo: ['hospital'], mensaje: 'Se solicitó sistema de películas pero se entregó base de datos hospitalaria' },

            // Hospital vs otros temas
            { descripcion: ['hospital'], archivo: ['banco'], mensaje: 'Se solicitó sistema hospitalario pero se entregó base de datos bancaria' },
            { descripción: ['hospital'], archivo: ['peliculas'], mensaje: 'Se solicitó sistema hospitalario pero se entregó base de datos de películas' }
        ];

        for (const incompatibilidad of incompatibilidadesCriticas) {
            const tieneDescripcionCritica = incompatibilidad.descripcion.some(tema => temasDescripcion.includes(tema));
            const tieneArchivoCritico = incompatibilidad.archivo.some(tema => temasArchivo.includes(tema));

            if (tieneDescripcionCritica && tieneArchivoCritico) {
                return {
                    incompatible: true,
                    mensaje: incompatibilidad.mensaje
                };
            }
        }

        return { incompatible: false };
    };

    // Verificar incompatibilidades
    const resultadoIncompatibilidad = detectarIncompatibilidad(descripcionLower, archivoLower);

    // Reglas estrictas de validación mejoradas
    if (resultadoIncompatibilidad.incompatible) {
        nota = 0;
        cumplimiento = 'El archivo no cumple con los requisitos solicitados.';
        resumen = `❌ INCOMPATIBILIDAD DETECTADA: ${resultadoIncompatibilidad.mensaje}. La tarea no coincide con la descripción del curso.`;
    } else if (
        // Validaciones adicionales específicas para casos comunes
        (descripcionLower.includes('python') && archivoLower.includes('sql') && !descripcionLower.includes('sql')) ||
        (descripcionLower.includes('sql') && archivoLower.includes('python') && !descripcionLower.includes('python')) ||
        (descripcionLower.includes('java') && !archivoLower.includes('java') && archivoLower.length > 50) ||
        (descripcionLower.includes('javascript') && !archivoLower.includes('javascript') && archivoLower.length > 50) ||
        (descripcionLower.includes('html') && !archivoLower.includes('html') && archivoLower.length > 50) ||
        (descripcionLower.includes('css') && !archivoLower.includes('css') && archivoLower.length > 50)
    ) {
        nota = 0;
        cumplimiento = 'El archivo no cumple con el parámetro solicitado.';
        resumen = `❌ Se esperaba ${contentSummary}, pero el archivo entregado no coincide con lo solicitado.`;
    } else if (descripcionLower.includes('python') && archivoLower.includes('python')) {
        nota = 10;
        cumplimiento = 'El archivo cumple totalmente con el parámetro solicitado.';
        resumen = '✅ Script en Python recibido correctamente.';
    } else {
        // Llamar a gemma3n para veredicto rápido y nota proporcional
        try {
            const promptGemma = `INSTRUCCIONES CRÍTICAS PARA CALIFICACIÓN ULTRA ESTRICTA: 

ALERTA MÁXIMA: CERO TOLERANCIA para incompatibilidades temáticas. Si el estudiante entrega algo diferente a lo solicitado = NOTA 0 OBLIGATORIO.

CRITERIOS DE EVALUACIÓN ABSOLUTOS:
1. COMPATIBILIDAD TECNOLÓGICA: ¿El archivo contiene EXACTAMENTE el lenguaje/tecnología solicitada?
2. COHERENCIA TEMÁTICA CRÍTICA: ¿El contenido responde EXACTAMENTE al tema/proyecto solicitado?
3. CUMPLIMIENTO DE REQUISITOS: ¿Se cumplen TODOS los requisitos especificados?

REGLAS DE CALIFICACIÓN INFLEXIBLES:
- Si el lenguaje/tecnología NO coincide: nota 0 OBLIGATORIO
- Si el tema/proyecto NO coincide: nota 0 OBLIGATORIO  
- Si se pide BANCO y se entrega PELÍCULAS: nota 0 OBLIGATORIO
- Si se pide PELÍCULAS y se entrega BANCO: nota 0 OBLIGATORIO
- Si se pide HOSPITAL y se entrega TIENDA: nota 0 OBLIGATORIO
- Si faltan requisitos clave: nota 0-3 máximo
- Si cumple parcialmente: nota 4-7
- Si cumple totalmente: nota 8-10

CASOS CRÍTICOS INCOMPATIBLES (SIEMPRE nota 0):
- Se pide Python pero se envía SQL
- Se pide calculadora pero se envía base de datos
- Se pide HTML pero se envía Java
- Se pide API pero se envía juego
- Se pide sistema BANCARIO pero se envía base de datos de PELÍCULAS
- Se pide sistema de PELÍCULAS pero se envía base de datos BANCARIA
- Se pide sistema HOSPITALARIO pero se envía cualquier otro tema

FORMATO DE RESPUESTA OBLIGATORIO:
📊 **CALIFICACIÓN ACTUAL: [número]/10**

🔍 **ANÁLISIS ESTRICTO:**
[Explicación detallada del cumplimiento/incompatibilidad]

💬 **JUSTIFICACIÓN:**
[Por qué esta calificación específica]

❌ **INCOMPATIBILIDADES DETECTADAS:** [Si las hay]
✅ **ASPECTOS CORRECTOS:** [Si los hay]

Descripción de la tarea (LO QUE SE SOLICITÓ): ${contentSummary}

Archivo entregado (LO QUE SE ENVIÓ):
${resumenArchivo}

CRÍTICO: Si detectas CUALQUIER incompatibilidad temática (ej: banco vs películas), asigna nota 0 inmediatamente y explica la incompatibilidad específica.`;

            const tokensGemma = encode(promptGemma).length;
            console.log('[MODELO gemma3n:latest] TOKENS CONSUMIDOS:', tokensGemma);
            console.log('[MODELO gemma3n:latest] PROMPT ENVIADO:', promptGemma);

            const responseGemma = await axios({
                method: 'post',
                url: `${ollamaUrl}/api/generate`,
                data: {
                    model: 'gemma3n:latest',
                    prompt: promptGemma
                },
                responseType: 'stream',
                timeout: 1200000, // 20 minutos para coincidir con el cliente Android
                headers: {
                    'Accept': 'application/x-ndjson',
                    'Content-Type': 'application/json'
                }
            });
            // const ndjson = require('ndjson');
            let resultadoGemma = await new Promise((resolve, reject) => {
                let texto = '';
                responseGemma.data
                    .pipe(ndjson.parse())
                    .on('data', obj => {
                        if (obj && obj.response) texto += obj.response;
                    })
                    .on('end', () => resolve(texto))
                    .on('error', err => reject(err));
            });
            // Defensive fallback if model returns empty
            if (!resultadoGemma || !resultadoGemma.trim()) {
                console.log('⚠️ WARNING: modelo gemma3n devolvió respuesta VACÍA, aplicando fallback');
                resultadoGemma = 'Lo siento, no he obtenido una respuesta del modelo en este momento. Por favor intenta nuevamente.';
            }

            const tokensRespuestaGemma = encode(resultadoGemma).length;
            console.log('[MODELO gemma3n:latest] TOKENS DE RESPUESTA:', tokensRespuestaGemma);
            console.log('[MODELO gemma3n:latest] RESPUESTA RECIBIDA:', resultadoGemma);

            // Resumen de consumo total de tokens para análisis
            const tokensTotal = tokensGemma + tokensRespuestaGemma;
            console.log('📊 RESUMEN DE TOKENS - TOTAL CONSUMIDO:', tokensTotal, '(Prompt:', tokensGemma, '+ Respuesta:', tokensRespuestaGemma, ')');

            // Extraer nota y resumen del resultado con validación estricta mejorada
            const matchNota = resultadoGemma.match(/nota\s*:?\s*(\d+)/i) ||
                resultadoGemma.match(/(\d+)\/10/i) ||
                resultadoGemma.match(/calificación\s*:?\s*(\d+)/i);
            let notaExtraida = matchNota ? parseInt(matchNota[1]) : 0; // Por defecto nota 0 si no se puede extraer

            // Validación estricta: si el modelo menciona cualquier incompatibilidad, forzar nota 0
            const resultadoLower = resultadoGemma.toLowerCase();
            if (resultadoLower.includes('no cumple') ||
                resultadoLower.includes('no coincide') ||
                resultadoLower.includes('incorrecto') ||
                resultadoLower.includes('incompatible') ||
                resultadoLower.includes('incompatibilidad') ||
                resultadoLower.includes('lenguaje diferente') ||
                resultadoLower.includes('tecnología diferente') ||
                resultadoLower.includes('tipo incorrecto') ||
                resultadoLower.includes('tema diferente') ||
                resultadoLower.includes('proyecto diferente') ||
                resultadoLower.includes('nota: 0') ||
                resultadoLower.includes('nota 0') ||
                resultadoLower.includes('calificación: 0') ||
                resultadoLower.includes('0/10') ||
                resultadoLower.includes('se solicitó') && resultadoLower.includes('pero') ||
                resultadoLower.includes('se pidió') && resultadoLower.includes('pero') ||
                resultadoLower.includes('esperaba') && resultadoLower.includes('pero')) {
                notaExtraida = 0;
                console.log('🚨 INCOMPATIBILIDAD DETECTADA POR MODELO - FORZANDO NOTA 0');
            }

            // Validación adicional: si el contenido y descripción no tienen palabras clave comunes críticas
            const palabrasClaveDescripcion = descripcionLower.match(/\b(python|java|javascript|html|css|sql|php|calculadora|database|web|api|juego)\b/g) || [];
            const palabrasClaveArchivo = archivoLower.match(/\b(python|java|javascript|html|css|sql|php|calcul|database|web|api|game|score)\b/g) || [];

            if (palabrasClaveDescripcion.length > 0 && palabrasClaveArchivo.length > 0) {
                const hayCoincidencia = palabrasClaveDescripcion.some(palabra =>
                    palabrasClaveArchivo.some(archivoWord =>
                        archivoWord.includes(palabra.substring(0, 4)) || palabra.includes(archivoWord.substring(0, 4))
                    )
                );
                if (!hayCoincidencia) {
                    notaExtraida = 0;
                    console.log('🚨 SIN COINCIDENCIA EN PALABRAS CLAVE CRÍTICAS - FORZANDO NOTA 0');
                    console.log('Descripción:', palabrasClaveDescripcion);
                    console.log('Archivo:', palabrasClaveArchivo);
                }
            }

            nota = notaExtraida;
            // If we have a submissionId, attempt to persist the computed grade to Supabase
            try {
                if (submissionId) {
                    console.log(`🔁 Intentando persistir nota ${nota} para submissionId=${submissionId} en Supabase`);
                    const ok = await updateTaskSubmissionSupabase(submissionId, nota, resultadoGemma);
                    if (!ok) console.log('⚠️ Persistencia en Supabase fallida o no confirmada');
                }
            } catch (err) {
                console.log('❌ Error al persistir nota en Supabase:', err.message);
            }
            resumen = resultadoGemma; // Guardar toda la respuesta incluyendo retroalimentación
            cumplimiento = nota === 0 ? '❌ No cumple con los requisitos (INCOMPATIBLE)' : (nota === 10 ? '✅ Cumplimiento total' : '⚠️ Cumplimiento parcial');
        } catch (err) {
            console.log('⚠️ ERROR EN ANÁLISIS GEMMA3N:', err.message);
            // Si no se puede analizar y hay palabras clave incompatibles detectadas previamente, asignar nota 0
            const palabrasClaveDescripcion = descripcionLower.match(/\b(python|java|javascript|html|css|sql|php|calculadora|database|web|api|juego)\b/g) || [];
            const palabrasClaveArchivo = archivoLower.match(/\b(python|java|javascript|html|css|sql|php|calcul|database|web|api|game|score)\b/g) || [];

            if (palabrasClaveDescripcion.length > 0 && palabrasClaveArchivo.length > 0) {
                const hayCoincidencia = palabrasClaveDescripcion.some(palabra =>
                    palabrasClaveArchivo.some(archivoWord =>
                        archivoWord.includes(palabra.substring(0, 4)) || palabra.includes(archivoWord.substring(0, 4))
                    )
                );
                if (!hayCoincidencia) {
                    nota = 0;
                    resumen = `❌ ERROR EN ANÁLISIS: No se pudo procesar pero se detectó incompatibilidad entre lo solicitado (${palabrasClaveDescripcion.join(', ')}) y lo enviado (${palabrasClaveArchivo.join(', ')}).`;
                    cumplimiento = '❌ No cumple con los requisitos (INCOMPATIBLE)';
                } else {
                    nota = 3; // Nota baja por no poder analizar completamente
                    resumen = `⚠️ No se pudo analizar completamente con IA, pero parece haber compatibilidad básica entre la descripción y el archivo.`;
                    cumplimiento = '⚠️ Análisis incompleto';
                }
            } else {
                nota = 2; // Nota muy baja si no se pueden detectar palabras clave
                resumen = `⚠️ No se pudo analizar con IA y no se detectaron palabras clave claras para comparar compatibilidad.`;
                cumplimiento = '⚠️ Análisis fallido';
            }
        }
    }

    // Guardar en cache
    ragCache[submissionId] = { nota, resumen, cumplimiento };
    return res.json({ nota, resumen, cumplimiento });
});

/**
 * Microservicio de feedback conversacional
 * Recibe submissionId y pregunta del usuario, responde usando nota y resumen del análisis previo
 */
app.post('/feedback-entrega', async(req, res) => {
    const { submissionId, pregunta, ollamaUrl } = req.body;
    if (!submissionId || !pregunta || !ollamaUrl) {
        return res.status(400).json({ error: 'Faltan datos requeridos.' });
    }
    const resultado = ragCache[submissionId];
    if (!resultado) {
        return res.status(404).json({ error: 'No existe análisis previo para este submissionId.' });
    }
    // Llamar a llama3 para generar feedback usando nota y resumen
    try {
        const promptLlama = `INSTRUCCIONES PARA RETROALIMENTACIÓN EDUCATIVA ESTRICTA:

INSTRUCCIONES CRÍTICAS:
- RESPONDE SIEMPRE EN ESPAÑOL
- USA TERMINOLOGÍA EN ESPAÑOL
- NO USES PALABRAS EN INGLÉS SALVO TÉRMINOS TÉCNICOS NECESARIOS
- FORMATO EDUCATIVO Y PROFESIONAL

IMPORTANTE: Mantén consistencia con la evaluación previa. Si la nota fue 0 por incompatibilidad temática, REFUERZA este mensaje claramente.

Información de la evaluación:
- Nota recibida: ${resultado.nota}/10
- Análisis previo: ${resultado.resumen}
- Estado de cumplimiento: ${resultado.cumplimiento}

Pregunta del usuario: ${pregunta}

REGLAS PARA RETROALIMENTACIÓN (EN ESPAÑOL):
1. Si la nota fue 0 por incompatibilidad temática (ej: banco vs películas): EXPLICA claramente que no cumple con el tema solicitado
2. Si la nota fue 0 por incompatibilidad tecnológica: EXPLICA que debe usar la tecnología correcta
3. Si la nota es baja (1-3): Señala errores específicos y cómo corregirlos
4. Si la nota es media (4-7): Reconoce aspectos positivos pero indica mejoras necesarias
5. Si la nota es alta (8-10): Felicita pero sugiere refinamientos opcionales

CASOS CRÍTICOS A REFORZAR:
- "Se solicitó sistema bancario pero entregaste base de datos de películas - incompatibilidad total"
- "Se pidió calculadora pero enviaste base de datos - no coincide con el tema"
- "Se requería HTML pero enviaste Java - tecnología incorrecta"

FORMATO DE RESPUESTA REQUERIDO (EN ESPAÑOL):
📊 **CALIFICACIÓN ACTUAL: ${resultado.nota}/10**

🔍 **ANÁLISIS DE TU ENTREGA:**
[Explicación detallada basada en el análisis previo]

💬 **RETROALIMENTACIÓN:**
[Responder a la pregunta específica del usuario]
[Si nota = 0 por incompatibilidad: REFORZAR que debe entregar exactamente lo solicitado]
[Sugerencias constructivas para mejorar]
[Aspectos positivos identificados si los hay]

⭐ **RECOMENDACIONES:**
[Pasos concretos para mejorar en futuras entregas]
[Si incompatible: "Debes crear un proyecto que coincida exactamente con la descripción"]

La respuesta debe ser educativa, constructiva y MUY CLARA sobre por qué se asignó esa calificación.`;

        const tokensLlama = encode(promptLlama).length;
        console.log('[MODELO llama3:latest] TOKENS CONSUMIDOS:', tokensLlama);
        console.log('[MODELO llama3:latest] PROMPT ENVIADO:', promptLlama);

        const responseLlama = await axios({
            method: 'post',
            url: `${ollamaUrl}/api/generate`,
            data: {
                model: 'llama3:latest',
                prompt: promptLlama
            },
            responseType: 'stream',
            timeout: 1200000, // 20 minutos para coincidir con el cliente Android
            headers: {
                'Accept': 'application/x-ndjson',
                'Content-Type': 'application/json'
            }
        });
        // const ndjson = require('ndjson');
        let respuestaFeedback = await new Promise((resolve, reject) => {
            let texto = '';
            responseLlama.data
                .pipe(ndjson.parse())
                .on('data', obj => {
                    if (obj && obj.response) texto += obj.response;
                })
                .on('end', () => resolve(texto))
                .on('error', err => reject(err));
        });
        // Defensive fallback if model returns empty
        if (!respuestaFeedback || !respuestaFeedback.trim()) {
            console.log('⚠️ WARNING: modelo llama3 (feedback) devolvió respuesta VACÍA, aplicando fallback');
            respuestaFeedback = 'Lo siento, en este momento no obtuve una respuesta del modelo. Intenta nuevamente.';
        }

        const tokensRespuestaFeedback = encode(respuestaFeedback).length;
        console.log('[MODELO llama3:latest] TOKENS DE RESPUESTA:', tokensRespuestaFeedback);
        console.log('[MODELO llama3:latest] RESPUESTA RECIBIDA:', respuestaFeedback);

        // Resumen de consumo total de tokens para feedback
        const tokensTotal = tokensLlama + tokensRespuestaFeedback;
        console.log('📊 RESUMEN DE TOKENS - TOTAL CONSUMIDO:', tokensTotal, '(Prompt:', tokensLlama, '+ Respuesta:', tokensRespuestaFeedback, ')');

        return res.json({ feedback: respuestaFeedback });
    } catch (err) {
        return res.status(500).json({ error: 'Error en feedback', detalle: err.message });
    }
});

// Ruta de prueba para verificar que el microservicio está activo
app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'Microservicio activo', timestamp: new Date().toISOString() });
});

/**
 * Smart link handler: Detecta si la app está instalada y redirige o descarga APK
 * GET /app-link?userId=XXX
 * - Si el usuario tiene la app instalada: redirige al deep link (tareamov://...)
 * - Si NO tiene la app: descarga automáticamente el APK
 */
app.get('/app-link', async(req, res) => {
    const { userId, action = 'chat' } = req.query;

    if (!userId) {
        return res.status(400).send('userId es requerido');
    }

    // Construir deep link para la app
    const deepLink = `tareamov://${action}?userId=${userId}`;
    const apkUrl = `${req.protocol}://${req.get('host')}/download-apk`;

    // Página HTML que detecta si la app está instalada
    const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Abriendo TareaMov...</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
        }
        .container {
            text-align: center;
            padding: 40px;
            max-width: 500px;
        }
        .logo {
            font-size: 64px;
            margin-bottom: 20px;
        }
        h1 {
            font-size: 32px;
            margin-bottom: 16px;
            font-weight: 700;
        }
        p {
            font-size: 18px;
            opacity: 0.9;
            margin-bottom: 30px;
        }
        .spinner {
            border: 4px solid rgba(255,255,255,0.3);
            border-top: 4px solid white;
            border-radius: 50%;
            width: 50px;
            height: 50px;
            animation: spin 1s linear infinite;
            margin: 30px auto;
        }
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        .btn {
            display: inline-block;
            background: white;
            color: #667eea;
            padding: 16px 32px;
            border-radius: 12px;
            text-decoration: none;
            font-weight: 600;
            font-size: 16px;
            margin-top: 20px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.2);
            transition: transform 0.2s;
        }
        .btn:hover {
            transform: translateY(-2px);
        }
        .hidden {
            display: none;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="logo">📱</div>
        <div id="opening">
            <h1>Abriendo TareaMov</h1>
            <p>Redirigiendo a la aplicación...</p>
            <div class="spinner"></div>
        </div>
        <div id="download" class="hidden">
            <h1>Descarga TareaMov</h1>
            <p>La aplicación no está instalada en tu dispositivo</p>
            <a href="${apkUrl}" class="btn">📥 Descargar APK</a>
            <p style="margin-top: 20px; font-size: 14px;">La descarga comenzará automáticamente en 3 segundos...</p>
        </div>
    </div>

    <script>
        // Intentar abrir la app con deep link
        const deepLink = "${deepLink}";
        const apkUrl = "${apkUrl}";
        let appOpened = false;

        // Detectar si el usuario sale de la página (app se abrió)
        document.addEventListener('visibilitychange', function() {
            if (document.hidden) {
                appOpened = true;
            }
        });

        // Intentar abrir la app
        window.location.href = deepLink;

        // Si después de 2 segundos no se abrió la app, mostrar descarga
        setTimeout(function() {
            if (!appOpened && !document.hidden) {
                // La app no está instalada, mostrar descarga
                document.getElementById('opening').classList.add('hidden');
                document.getElementById('download').classList.remove('hidden');
                
                // Iniciar descarga automática después de 3 segundos
                setTimeout(function() {
                    window.location.href = apkUrl;
                }, 3000);
            }
        }, 2000);

        // Fallback: Si el usuario vuelve a la página, también mostrar descarga
        window.addEventListener('focus', function() {
            setTimeout(function() {
                if (!document.hidden) {
                    document.getElementById('opening').classList.add('hidden');
                    document.getElementById('download').classList.remove('hidden');
                }
            }, 500);
        });
    </script>
</body>
</html>`;

    res.send(html);
});

/**
 * Descarga el APK de TareaMov
 * GET /download-apk
 */
app.get('/download-apk', (req, res) => {
    const apkPath = './app-debug.apk';
    const fs = require('fs');

    // Verificar si el APK existe
    if (!fs.existsSync(apkPath)) {
        return res.status(404).send(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>APK no disponible</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            text-align: center;
            padding: 20px;
        }
        .container {
            max-width: 500px;
        }
        h1 { font-size: 32px; margin-bottom: 16px; }
        p { font-size: 18px; opacity: 0.9; }
    </style>
</head>
<body>
    <div class="container">
        <h1>⚠️ APK no disponible</h1>
        <p>El archivo app-debug.apk no se encuentra en el servidor.</p>
        <p style="margin-top: 20px; font-size: 14px;">Contacta al administrador para obtener el APK.</p>
    </div>
</body>
</html>
        `);
    }

    // Configurar headers para descarga
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', 'attachment; filename="TareaMov.apk"');

    // Enviar el archivo
    res.sendFile(apkPath, { root: __dirname }, (err) => {
        if (err) {
            console.error('❌ Error enviando APK:', err);
            res.status(500).send('Error al descargar el APK');
        } else {
            console.log('✅ APK descargado exitosamente');
        }
    });
});

/**
 * Notifica a los suscriptores cuando un creador crea un nuevo curso
 * 1. Busca los suscriptores del creador.
 * 2. Guarda la notificación en la base de datos (tabla 'notifications').
 * 3. Envía emails con Resend a los suscriptores.
 */
app.post('/notify-course-creation', async(req, res) => {
    try {
        const { creatorUserId, creatorUsername, courseId, courseTitle, courseThumbnailUrl } = req.body;

        if (!creatorUserId || !courseId) {
            return res.status(400).json({ error: 'Missing required fields: creatorUserId, courseId' });
        }

        console.log(`📢 Course creation notification: User ${creatorUserId} created course "${courseTitle}"`);

        // 1. Fetch subscribers from Supabase
        const subscribersResponse = await axios.get(
            `${process.env.SUPABASE_URL}/rest/v1/subscriptions?subscriber_id=eq.${creatorUserId}&select=subscribed_to_id`, {
                headers: {
                    'apikey': process.env.SUPABASE_KEY,
                    'Authorization': `Bearer ${process.env.SUPABASE_KEY}`
                }
            }
        );

        const subscribers = subscribersResponse.data || [];
        console.log(`Found ${subscribers.length} subscribers for user ${creatorUserId}`);

        if (subscribers.length === 0) {
            return res.json({ message: 'No subscribers to notify', notificationsSent: 0 });
        }

        // 2. Get subscriber details (username, email)
        const subscriberIds = subscribers.map(s => s.subscribed_to_id);
        const usersResponse = await axios.get(
            `${process.env.SUPABASE_URL}/rest/v1/usuarios?id=in.(${subscriberIds.join(',')})&select=id,usuario,email`, {
                headers: {
                    'apikey': process.env.SUPABASE_KEY,
                    'Authorization': `Bearer ${process.env.SUPABASE_KEY}`
                }
            }
        );

        const users = usersResponse.data || [];

        // 3. Create notification records + send emails
        let successCount = 0;

        for (const user of users) {
            try {
                // Create in-app notification
                const notification = {
                    user_id: user.id,
                    type: 'new_course',
                    title: `${creatorUsername || 'Un creador'} subió un nuevo curso`,
                    message: `${courseTitle || 'Nuevo curso disponible'}`,
                    sender_username: creatorUsername,
                    sender_avatar_url: null, // Could fetch from personas table
                    thumbnail_url: courseThumbnailUrl,
                    related_id: courseId,
                    is_read: false
                };

                await axios.post(
                    `${process.env.SUPABASE_URL}/rest/v1/notifications`,
                    notification, {
                        headers: {
                            'apikey': process.env.SUPABASE_KEY,
                            'Authorization': `Bearer ${process.env.SUPABASE_KEY}`,
                            'Content-Type': 'application/json'
                        }
                    }
                );

                // Send email with Resend
                if (user.email) {
                    try {
                        await axios.post('https://api.resend.com/emails', {
                            from: 'Notificaciones <notificaciones@yisuscompany.com>',
                            to: user.email,
                            subject: `¡${creatorUsername} subió un nuevo curso!`,
                            html: `
                                <h2>Nuevo curso disponible</h2>
                                <p><strong>${creatorUsername}</strong> acaba de publicar un nuevo curso:</p>
                                <h3>${courseTitle}</h3>
                                <p>¡Entra a la app para verlo ahora!</p>
                                <br>
                                <p>Saludos,<br>El equipo de YisusCompany</p>
                            `
                        }, {
                            headers: {
                                'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
                                'Content-Type': 'application/json'
                            }
                        });
                        console.log(`✅ Email sent to ${user.email}`);
                    } catch (emailError) {
                        console.warn(`⚠️ Failed to send email to ${user.email}:`, emailError.message);
                    }
                }

                successCount++;
            } catch (error) {
                console.error(`Error notifying user ${user.id}:`, error.message);
            }
        }

        res.json({
            message: 'Notifications sent',
            notificationsSent: successCount,
            totalSubscribers: users.length
        });

    } catch (error) {
        console.error('Error in notify-course-creation:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Notifica a los suscriptores cuando un creador sube un nuevo video.
 * 1. Busca los suscriptores del creador.
 * 2. Guarda la notificación en la base de datos (tabla 'notifications').
 * 3. Envía notificaciones Push a los dispositivos de los suscriptores.
 */
app.post('/notify-video-upload', async(req, res) => {
    const { creatorId, videoTitle, videoId } = req.body;

    if (!creatorId || !videoTitle || !videoId) {
        return res.status(400).json({ error: 'Faltan datos requeridos: creatorId, videoTitle, videoId' });
    }

    console.log(`📢 Procesando notificación de video para creador ${creatorId}`);

    try {
        // 1. Obtener información del creador (nombre)
        const { data: creator, error: creatorError } = await supabaseService.client
            .from('usuarios')
            .select('usuario')
            .eq('id', creatorId)
            .single();

        if (creatorError || !creator) {
            throw new Error(`Error obteniendo creador: ${creatorError?.message}`);
        }

        // 2. Obtener suscriptores del creador
        const { data: subscriptions, error: subError } = await supabaseService.client
            .from('subscriptions')
            .select('subscriber_id')
            .eq('creator_id', creatorId);

        if (subError) {
            throw new Error(`Error obteniendo suscriptores: ${subError.message}`);
        }

        if (!subscriptions || subscriptions.length === 0) {
            console.log('ℹ️ El creador no tiene suscriptores.');
            return res.json({ message: 'Sin suscriptores para notificar', count: 0 });
        }

        const subscriberIds = subscriptions.map(s => s.subscriber_id);
        console.log(`👥 Encontrados ${subscriberIds.length} suscriptores.`);

        // 3. Preparar notificaciones para la base de datos
        const notificationsToInsert = subscriberIds.map(subId => ({
            user_id: subId,
            title: 'Nuevo video disponible',
            message: `${creator.usuario} ha subido: ${videoTitle}`,
            type: 'video_upload',
            related_id: videoId,
            is_read: false,
            created_at: new Date().toISOString()
        }));

        // 4. Guardar en Supabase (tabla 'notifications')
        // Asegúrate de que la tabla 'notifications' exista en tu esquema
        const { error: insertError } = await supabaseService.client
            .from('notifications')
            .insert(notificationsToInsert);

        if (insertError) {
            console.error('⚠️ Error guardando notificaciones en DB:', insertError.message);
            // No detenemos el proceso, intentamos enviar Push de todos modos
        } else {
            console.log('✅ Notificaciones guardadas en base de datos.');
        }

        // 5. Enviar Notificaciones Push y Email
        let pushCount = 0;
        let emailCount = 0;
        for (const subId of subscriberIds) {
            // Push Notification
            await sendPushNotification(
                subId,
                '¡Nuevo Video!',
                `${creator.usuario} acaba de subir un nuevo video: ${videoTitle}`, {
                    type: 'video_upload',
                    videoId: videoId.toString(),
                    creatorId: creatorId.toString()
                }
            );
            pushCount++;

            // Email Notification
            await sendEmailNotification(
                subId,
                '¡Nuevo Video Disponible! 🎥',
                `Hola,\n\n${creator.usuario} acaba de subir un nuevo video titulado: "${videoTitle}".\n\n¡Entra a la app para verlo ahora!`
            );
            emailCount++;
        }

        res.json({
            success: true,
            message: `Notificaciones procesadas`,
            subscribers: subscriberIds.length,
            pushSent: pushCount,
            emailSent: emailCount
        });

    } catch (error) {
        console.error('❌ Error en /notify-video-upload:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Notifica por email al usuario cuando recibe una respuesta del chat IA
 * Endpoint: POST /notify-chat-response
 * Body: { userId, responsePreview }
 * 
 * 🔒 SEGURIDAD: NO envía la respuesta completa por email (datos sensibles)
 * Solo notifica que hay una respuesta disponible con deep link a la app
 */
app.post('/notify-chat-response', async(req, res) => {
    const { userId, responsePreview } = req.body;

    if (!userId) {
        return res.status(400).json({ error: 'userId es requerido' });
    }

    console.log(`📧 Enviando notificación de chat para usuario ${userId}`);

    try {
        // Obtener información del usuario (email, nombre)
        const { data: user, error: userError } = await supabaseService.client
            .from('usuarios')
            .select('email, username')
            .eq('id', userId)
            .single();

        if (userError || !user || !user.email) {
            console.warn(`⚠️ No se encontró email para userId ${userId}`);
            return res.status(404).json({ error: 'Usuario no encontrado o sin email' });
        }

        // 🔒 SEGURIDAD: NO incluir datos sensibles en el email
        // Solo notificar que hay una respuesta disponible
        const emailSubject = 'Nueva respuesta disponible - CourseV';

        // Smart link que detecta si la app está instalada o descarga el APK
        const smartLink = `${process.env.BASE_URL || 'v0-eo-jesuh02s-projects.vercel.app'}$ `;

        const emailBody = `Hola ${user.username || 'Usuario'},

Tu consulta ha sido procesada por nuestro asistente de inteligencia artificial y tu respuesta está disponible.

Por razones de seguridad, la respuesta completa solo está disponible dentro de la aplicación móvil.

Para ver tu respuesta, accede a la aplicación CourseV:
${smartLink}

Información de seguridad:
- Las respuestas pueden contener información personal
- No compartimos datos completos por correo electrónico
- Verifica tu identidad en la aplicación antes de acceder

Si no solicitaste esta consulta, por favor ignora este mensaje.

Saludos cordiales,
Equipo CourseV
Plataforma Educativa`;

        // Enviar email usando la función existente
        await sendEmailNotification(userId, emailSubject, emailBody);

        console.log(`✅ Notificación de chat enviada a ${user.email} (sin datos sensibles)`);
        res.json({
            success: true,
            message: 'Notificación enviada',
            email: user.email,
            securityNote: 'Response preview not included for security'
        });

    } catch (error) {
        console.error('❌ Error en /notify-chat-response:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Envía notificación push via Firebase Cloud Messaging
 * Endpoint: POST /send-push-notification
 * Body: { userId, title, body, data }
 * 
 * Envía notificación push cuando el usuario recibe respuesta del chat
 * y la app está en background o cerrada
 */
app.post('/send-push-notification', async(req, res) => {
    const { userId, title, body, data } = req.body;

    if (!userId) {
        return res.status(400).json({ error: 'userId es requerido' });
    }

    console.log(`📱 Enviando notificación push para usuario ${userId}`);

    try {
        // Verificar que Firebase Admin esté disponible
        if (!admin || !admin.messaging) {
            console.warn('⚠️ Firebase Admin no disponible - push notifications desactivadas');
            return res.status(503).json({
                error: 'Push notifications no disponibles',
                reason: 'Firebase Admin not configured'
            });
        }

        // Obtener FCM token del usuario desde Supabase
        const { data: tokens, error: tokenError } = await supabaseService.client
            .from('user_fcm_tokens')
            .select('token')
            .eq('user_id', userId)
            .order('last_updated', { ascending: false });

        if (tokenError || !tokens || tokens.length === 0) {
            console.warn(`⚠️ No se encontró FCM token para userId ${userId}`);
            return res.status(404).json({ error: 'No FCM token found for user' });
        }

        // Intentar enviar a todos los tokens del usuario (puede tener múltiples dispositivos)
        const sendPromises = tokens.map(async({ token }) => {
            try {
                const message = {
                    notification: {
                        title: title || '🤖 Nueva respuesta del chat',
                        body: body || 'Tu consulta ha sido procesada',
                    },
                    data: {
                        userId: userId.toString(),
                        type: 'chat_response',
                        timestamp: new Date().toISOString(),
                        ...data
                    },
                    android: {
                        priority: 'high',
                        notification: {
                            channelId: 'chat_notifications',
                            sound: 'default',
                            priority: 'high',
                            defaultSound: true,
                            defaultVibrateTimings: true,
                            defaultLightSettings: true,
                            color: '#6366f1', // Indigo color (TareaMov brand)
                            icon: 'ic_notification',
                            clickAction: 'OPEN_CHAT'
                        }
                    },
                    token: token
                };

                const response = await admin.messaging().send(message);
                console.log(`✅ Push notification enviada exitosamente:`, response);
                return { success: true, token, messageId: response };
            } catch (error) {
                console.error(`❌ Error enviando push a token ${token.substring(0, 10)}...`, error.message);

                // Si el token es inválido, eliminarlo de la base de datos
                if (error.code === 'messaging/invalid-registration-token' ||
                    error.code === 'messaging/registration-token-not-registered') {
                    await supabaseService.client
                        .from('user_fcm_tokens')
                        .delete()
                        .eq('token', token);
                    console.log(`🗑️ Token inválido eliminado de la base de datos`);
                }

                return { success: false, token, error: error.message };
            }
        });

        const results = await Promise.all(sendPromises);
        const successCount = results.filter(r => r.success).length;

        console.log(`📊 Notificaciones enviadas: ${successCount}/${tokens.length}`);

        res.json({
            success: successCount > 0,
            message: `Push notifications sent to ${successCount} device(s)`,
            results
        });

    } catch (error) {
        console.error('❌ Error en /send-push-notification:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Recibe un prompt, lo divide o resume si supera el límite de tokens,
 * y lo envía al modelo Granite/Ollama.
 */
app.post('/procesar-prompt', async(req, res) => {
    const startTime = new Date();
    console.log('==============================================');
    console.log('🔥 NUEVA SOLICITUD RECIBIDA EN /procesar-prompt');
    console.log('🕐 HORA DE INICIO:', startTime.toLocaleString('es-ES'));
    console.log('==============================================');

    try {
        console.log('📥 BODY RECIBIDO:', JSON.stringify(req.body, null, 2));
        console.log('==============================================');

        // Recibe prompt del usuario, url de ollama y contexto del archivo (descripcionTarea)
        let { prompt, ollamaUrl, descripcionTarea, taskDescription, fileContent, userId } = req.body;

        // CORRECCIÓN AUTOMÁTICA: Si ollamaUrl usa cualquier IP del servidor, cambiarla a localhost
        // Esto es necesario porque el móvil envía la IP del host, pero Ollama está en localhost del servidor
        if (ollamaUrl) {
            // Obtener todas las IPs locales del servidor
            const localIPs = getLocalIPAddress();
            // Agregar IPs comunes adicionales
            const allServerIPs = [...localIPs, '10.0.2.2', '127.0.0.1', 'localhost'];

            allServerIPs.forEach(ip => {
                if (ollamaUrl.includes(ip)) {
                    const originalUrl = ollamaUrl;
                    ollamaUrl = ollamaUrl.replace(ip, 'localhost');
                    console.log(`🔄 URL de Ollama corregida automáticamente: ${originalUrl} → ${ollamaUrl}`);
                }
            });
        }

        // Validaciones: solo una respuesta por error
        if (typeof prompt !== 'string' || !prompt.trim()) {
            console.log('❌ ERROR: Prompt requerido');
            return res.status(400).json({ error: 'Prompt requerido.' });
        }
        if (!ollamaUrl) {
            console.log('❌ ERROR: ollamaUrl requerido');
            return res.status(400).json({ error: 'ollamaUrl requerido.' });
        }

        console.log('✅ VALIDACIONES PASADAS');
        console.log('📝 Prompt:', prompt);
        console.log('🌐 OllamaUrl:', ollamaUrl);
        console.log('📋 TaskDescription:', taskDescription || 'NO PROPORCIONADO');
        console.log('📄 FileContent length:', (fileContent || '').length);

        // 🔥 MEJORA: Extraer información estructurada del taskDescription si tiene formato con emojis
        // El cliente Android envía taskDescription en formato:
        // "📋 TAREA: nombre\n📝 DESCRIPCIÓN DEL PROFESOR:\ndescripción\n📎 ARCHIVO: archivo.ext\n📄 RESUMEN: resumen"
        let extractedTaskName = '';
        let extractedProfessorDescription = '';
        let extractedFileName = '';
        let extractedSummary = '';

        if (taskDescription) {
            // Extraer nombre de la tarea
            const taskMatch = taskDescription.match(/📋\s*TAREA:\s*([^\n]+)/);
            if (taskMatch) extractedTaskName = taskMatch[1].trim();

            // Extraer descripción del profesor
            const descMatch = taskDescription.match(/📝\s*DESCRIPCIÓN(?:\s+DEL\s+PROFESOR)?[:\s]*\n?([\s\S]*?)(?=\n📎|\n📄|$)/i);
            if (descMatch) extractedProfessorDescription = descMatch[1].trim();

            // Extraer nombre del archivo
            const fileMatch = taskDescription.match(/📎\s*ARCHIVO[^:]*:\s*([^\n]+)/);
            if (fileMatch) extractedFileName = fileMatch[1].trim();

            // Extraer resumen del contenido
            const summaryMatch = taskDescription.match(/📄\s*RESUMEN[^:]*:\s*([\s\S]+?)$/);
            if (summaryMatch) extractedSummary = summaryMatch[1].trim();

            console.log('🔍 INFORMACIÓN EXTRAÍDA DEL CONTEXTO:');
            console.log('   - Tarea:', extractedTaskName || '(no encontrado)');
            console.log('   - Descripción profesor:', extractedProfessorDescription ? extractedProfessorDescription.substring(0, 100) + '...' : '(no encontrado)');
            console.log('   - Archivo:', extractedFileName || '(no encontrado)');
            console.log('   - Resumen:', extractedSummary ? extractedSummary.substring(0, 100) + '...' : '(no encontrado)');
        }

        // Detectar archivos no procesables y responder inmediatamente
        // LÓGICA MEJORADA: Un archivo es no procesable solo si tiene indicadores de error específicos
        const esArchivoNoProcessable = fileContent && (
            // Indicadores claros de error
            (fileContent.includes('Tipo de archivo no soportado') && fileContent.length < 500) ||
            (fileContent.includes('ESTADO DEL ANÁLISIS') && fileContent.includes('⚠️')) ||
            (fileContent.includes('no pudo ser procesado') && fileContent.length < 500) ||
            fileContent.includes('⚠️ ARCHIVO NO PROCESABLE') ||
            fileContent.includes('NO SE PUEDE CALIFICAR ⚠️') ||
            (fileContent.includes('Tipo de archivo: UNKNOWN') && !fileContent.includes('CREATE TABLE') && !fileContent.includes('SELECT')) ||
            fileContent.includes('Estado: NO PROCESABLE') ||
            // Contenido extremadamente corto (menos de 100 caracteres de contenido real)
            (fileContent.length < 150 && !fileContent.includes('=== CONTENIDO DEL ARCHIVO ==='))
        );

        if (esArchivoNoProcessable) {
            console.log('⚠️ ARCHIVO NO PROCESABLE DETECTADO');
            const respuestaError = `❌ **NO SE PUEDE CALIFICAR ESTA ENTREGA**

El archivo que enviaste no pudo ser procesado correctamente por el sistema. Esto puede deberse a varias razones:

🔸 **Posibles causas:**
- El formato del archivo no es compatible
- El archivo está corrupto o vacío  
- Es un archivo de Google Drive (no compatible)
- El sistema no pudo extraer el contenido

📋 **Tarea solicitada:** ${taskDescription || 'Sin descripción'}

💡 **¿Qué debes hacer?**
1. Verifica que tu archivo esté en un formato compatible:
   ✅ PDF, Word (.docx), Excel (.xlsx), PowerPoint (.pptx)
   ✅ Archivos de texto (.txt)
   ✅ Archivos SQL (.sql)
   
2. Si es un archivo de Google Drive:
   - Descárgalo primero a tu dispositivo
   - Luego súbelo nuevamente a la tarea
   
3. Asegúrate de que el archivo no esté vacío o corrupto

4. Vuelve a intentar subir el archivo

⚠️ **Nota:** Necesito poder leer el contenido del archivo para poder ayudarte con la calificación.`;

            console.log('📤 ENVIANDO RESPUESTA DE ARCHIVO NO PROCESABLE');
            return res.json({
                respuesta: respuestaError,
                esError: true,
                archivoNoProcesable: true
            });
        }

        // 🐙 DETECCIÓN DE REPOSITORIOS GITHUB
        // Si el archivo enviado es un repositorio de GitHub, usar el MCP para analizarlo
        const esRepositorioGitHub = isGitHubRepository(extractedFileName);

        if (esRepositorioGitHub) {
            console.log('🐙 REPOSITORIO DE GITHUB DETECTADO:', extractedFileName);

            const gitHubUrl = extractGitHubUrl(extractedFileName);

            if (gitHubUrl) {
                console.log('🔗 URL de GitHub extraída:', gitHubUrl);

                // Verificar si es una pregunta que requiere análisis del repositorio
                const preguntaLowerGH = (prompt || '').toLowerCase();
                const requiereAnalisis =
                    /nota|calificaci(ó|o)n|puntaje|evaluaci(ó|o)n|analiza|revisa|califica|eval(ú|u)a/.test(preguntaLowerGH) ||
                    /archivo|repositorio|c(ó|o)digo|proyecto|entrega/.test(preguntaLowerGH) ||
                    /tarea|trabajo|dame|dime/.test(preguntaLowerGH);

                if (requiereAnalisis) {
                    console.log('📊 Iniciando análisis de repositorio GitHub con MCP...');

                    try {
                        const analysisResult = await analyzeGitHubRepository(
                            gitHubUrl,
                            extractedProfessorDescription || extractedTaskName || taskDescription,
                            prompt
                        );

                        if (analysisResult && analysisResult.success) {
                            const respuestaFormateada = formatGitHubAnalysisResponse(
                                analysisResult,
                                taskDescription
                            );

                            const endTime = new Date();
                            const duration = endTime - startTime;
                            console.log('✅ ANÁLISIS DE GITHUB COMPLETADO');
                            console.log('🕐 HORA DE RESPUESTA:', endTime.toLocaleString('es-ES'));
                            console.log('⏱️ DURACIÓN TOTAL:', Math.round(duration / 1000), 'segundos');
                            console.log('==============================================');

                            // Intentar persistir la calificación si hay submissionId
                            const submissionId = req.body.submissionId;
                            if (submissionId && analysisResult.grade) {
                                try {
                                    // Convertir nota de 100 a 10
                                    const gradeOutOf10 = Math.round(analysisResult.grade / 10 * 10) / 10;
                                    await updateTaskSubmissionSupabase(submissionId, gradeOutOf10, respuestaFormateada);
                                    console.log(`🔁 Calificación GitHub persistida: ${gradeOutOf10}/10`);
                                } catch (err) {
                                    console.log('⚠️ Error persistiendo calificación GitHub:', err.message);
                                }
                            }

                            res.setHeader('Content-Type', 'application/json; charset=utf-8');
                            return res.json({ respuesta_texto: respuestaFormateada });
                        } else {
                            // Si el análisis falló pero tenemos información del error
                            console.log('⚠️ Análisis de GitHub falló:', analysisResult ? .error || 'Error desconocido');

                            const respuestaError = `⚠️ **ERROR AL ANALIZAR REPOSITORIO**

No se pudo analizar el repositorio de GitHub: ${gitHubUrl}

📋 **Error:** ${analysisResult?.error || 'Error desconocido'}
💡 **Sugerencia:** ${analysisResult?.hint || 'Verifica que el repositorio sea público y la URL sea correcta'}

🔗 **URL del repositorio:** ${gitHubUrl}
📝 **Tarea:** ${extractedTaskName || 'Sin nombre'}

Por favor, verifica que:
1. El repositorio exista y sea público
2. La URL sea correcta
3. El repositorio contenga archivos de código fuente`;

                            res.setHeader('Content-Type', 'application/json; charset=utf-8');
                            return res.json({ respuesta_texto: respuestaError });
                        }
                    } catch (githubError) {
                        console.error('❌ Error en análisis de GitHub:', githubError.message);

                        // Fallback: informar al usuario sobre el error
                        const respuestaFallback = `⚠️ **ERROR AL CONECTAR CON GITHUB**

No se pudo analizar el repositorio: ${gitHubUrl}

📋 **Error técnico:** ${githubError.message}

💡 **Alternativas:**
1. Verifica que el servidor MCP esté ejecutándose
2. Comprueba que el repositorio sea público
3. Intenta nuevamente más tarde

🔗 **Repositorio:** ${gitHubUrl}`;

                        res.setHeader('Content-Type', 'application/json; charset=utf-8');
                        return res.json({ respuesta_texto: respuestaFallback });
                    }
                } else {
                    console.log('ℹ️ Pregunta sobre GitHub detectada pero no requiere análisis completo');
                    // Continuar con el flujo normal pero informando sobre el repositorio
                }
            } else {
                console.log('⚠️ No se pudo extraer URL de GitHub del nombre:', extractedFileName);
            }
        }

        // 📧 DETECCIÓN DE SOLICITUD DE NOTIFICACIÓN/CORREO
        const esSolicitudCorreo = /envi(ar|a|e)\s+(un\s+)?(correo|email|mail)|notific(ar|a|e)\s+a|mand(ar|a|e)\s+(un\s+)?(correo|email)/i.test(prompt);

        if (esSolicitudCorreo) {
            console.log('📧 SOLICITUD DE CORREO DETECTADA');

            try {
                // 1. Extraer intención y datos con LLM
                const extractionPrompt = `ACTÚA COMO UN PARSER DE COMANDOS.
                Analiza la solicitud del usuario para enviar un correo electrónico.
                
                Solicitud: "${prompt}"
                
                Extrae la siguiente información en formato JSON PURO:
                {
                    "target_type": "me" (si es para mí/usuario actual) o "user" (si es para otro) or "unknown",
                    "target_name": "nombre del usuario destinatario (si target_type es user)",
                    "subject": "Asunto del correo (inferido o explícito)",
                    "body": "Cuerpo del mensaje (inferido o explícito)"
                }
                
                Responde SOLO con el JSON.`;

                const extractionResponse = await callDeepSeek(null, extractionPrompt);
                const jsonMatch = extractionResponse.match(/\{[\s\S]*\}/);

                if (jsonMatch) {
                    const cmd = JSON.parse(jsonMatch[0]);
                    console.log('📧 DATOS EXTRAÍDOS:', cmd);

                    let targetUserId = null;

                    if (cmd.target_type === 'me') {
                        targetUserId = userId;
                        if (!targetUserId) {
                            // Intentar buscar por username si está disponible en el body (a veces se envía como 'studentName' o similar)
                            // O responder pidiendo login
                            console.log('⚠️ UserId no disponible en request para envío a "me"');
                        }
                    } else if (cmd.target_type === 'user' && cmd.target_name) {
                        // Buscar usuario en DB
                        if (supabaseService) {
                            const { data: users, error } = await supabaseService.client
                                .from('usuarios')
                                .select('id, email')
                                .ilike('usuario', cmd.target_name)
                                .limit(1);

                            if (users && users.length > 0) {
                                targetUserId = users[0].id;
                            } else {
                                return res.json({ respuesta_texto: `⚠️ No encontré al usuario "${cmd.target_name}" en la base de datos.` });
                            }
                        }
                    }

                    if (targetUserId) {
                        // Enviar correo
                        console.log(`📧 Enviando correo a ID: ${targetUserId}`);
                        await sendEmailNotification(targetUserId, cmd.subject || 'Notificación de TareaMov', cmd.body || 'Este es un mensaje automático enviado desde el asistente IA.');

                        // Responder al usuario
                        const respuestaExito = `✅ Correo enviado exitosamente a ${cmd.target_type === 'me' ? 'tu dirección de email' : cmd.target_name}.\n\n**Asunto:** ${cmd.subject}\n**Mensaje:** ${cmd.body}`;

                        return res.json({ respuesta_texto: respuestaExito });
                    } else if (cmd.target_type === 'me' && !userId) {
                        return res.json({ respuesta_texto: "⚠️ No puedo enviarte un correo porque no detecto tu ID de usuario. Asegúrate de haber iniciado sesión." });
                    }
                }
            } catch (err) {
                console.error('❌ Error procesando solicitud de correo:', err);
                // Continuar con el flujo normal si falla la extracción
            }
        }

        // Determinar si la pregunta es sobre nota/calificación/tarea/feedback/archivo (ampliado)
        const preguntaLower = (prompt || '').toLowerCase();

        // 🔥 MEJORA: También considerar como pregunta de nota si hay contexto de tarea disponible
        const hayContextoTarea = (taskDescription && taskDescription.trim().length > 0) ||
            (extractedTaskName && extractedTaskName.length > 0) ||
            (extractedProfessorDescription && extractedProfessorDescription.length > 0);

        const esPreguntaNota =
            /nota|calificaci(ó|o)n|puntaje|puntuaci(ó|o)n|evaluaci(ó|o)n|score|grade|calif(í|i)ca(me|la|el)|eval(ú|u)a(me|la|el)/.test(preguntaLower) ||
            /archivo|documento|contenido|trata|tema|enviado|subido|entregado|analiza|analizar/.test(preguntaLower) ||
            /tarea|trabajo|ejercicio|descripci(ó|o)n|requisito|solicita|pide|especifica/.test(preguntaLower) ||
            (
                /(revisa|corrige|ver|dime|cu(á|a)l|qu(é|e))/.test(preguntaLower) &&
                /(nota|calificaci(ó|o)n|puntaje|archivo|documento|tarea|descripci(ó|o)n)/.test(preguntaLower)
            ) ||
            // 🔥 Si hay contexto de tarea y el usuario hace cualquier pregunta relacionada
            (hayContextoTarea && /mi|esta|la|el|sobre|de|cumpl|bien|mal|falta|mejora|problema/.test(preguntaLower));

        // Configuración especial: usar solo gemma3n para evaluaciones críticas
        // 🔥 MEJORA: También activar evaluación crítica si hay descripción del profesor aunque fileContent esté vacío
        const esPreguntaEvaluacionCritica =
            /nota|calificaci(ó|o)n|puntaje|evaluaci(ó|o)n|calif(í|i)ca/.test(preguntaLower) &&
            ((taskDescription && taskDescription.trim()) || (extractedProfessorDescription && extractedProfessorDescription.trim())) &&
            (fileContent && fileContent.trim() || extractedSummary);

        console.log('🔍 ANÁLISIS DE CONTEXTO:');
        console.log('   - hayContextoTarea:', hayContextoTarea);
        console.log('   - esPreguntaNota:', esPreguntaNota);
        console.log('   - esPreguntaEvaluacionCritica:', esPreguntaEvaluacionCritica);

        // DETECCIÓN CRÍTICA DE INCOMPATIBILIDADES ESPECÍFICAS
        const detectarIncompatibilidadCritica = (descripcion, contenido) => {
            // Defensive: ensure we operate on strings to avoid "toLowerCase of undefined" errors
            const descripcionStr = (typeof descripcion === 'string') ? descripcion : '';
            const contenidoStr = (typeof contenido === 'string') ? contenido : '';
            const descripcionLower = descripcionStr.toLowerCase();
            const contenidoLower = contenidoStr.toLowerCase();

            // Caso específico: IA vs Matrículas/Académico
            if (descripcionLower.includes('inteligencia artificial') || descripcionLower.includes('ia ')) {
                const esMatriculas = contenidoLower.includes('matricula') ||
                    contenidoLower.includes('estudiante') ||
                    contenidoLower.includes('alumno') ||
                    contenidoLower.includes('docente') ||
                    contenidoLower.includes('profesor') ||
                    contenidoLower.includes('asignatura') ||
                    contenidoLower.includes('nota') ||
                    contenidoLower.includes('calificacion') ||
                    contenidoLower.includes('estu_') ||
                    contenidoLower.includes('doce_') ||
                    contenidoLower.includes('asig_') ||
                    contenidoLower.includes('matr_');

                if (esMatriculas) {
                    return {
                        incompatible: true,
                        nota: 0,
                        mensaje: "Se solicitó BASE DE DATOS DE INTELIGENCIA ARTIFICIAL pero se entregó SISTEMA DE MATRÍCULAS ACADÉMICAS. Son temas completamente diferentes."
                    };
                }
            }

            // Otros casos críticos se pueden agregar aquí
            return { incompatible: false };
        };

        // Verificar incompatibilidad crítica ANTES de enviar a los modelos
        const incompatibilidadCritica = detectarIncompatibilidadCritica(taskDescription, fileContent);

        if (incompatibilidadCritica.incompatible) {
            console.log('🚨 INCOMPATIBILIDAD CRÍTICA DETECTADA - RESPUESTA AUTOMÁTICA NOTA 0');
            const respuestaAutomatica = `📊 **CALIFICACIÓN: 0/10**

🚫 **INCOMPATIBILIDAD TEMÁTICA TOTAL DETECTADA:**
- 🎯 TEMA SOLICITADO: ${taskDescription}
- 📄 TEMA ENTREGADO: Sistema de matrículas académicas  
- ⚖️ COMPATIBILIDAD: CERO - Son dominios completamente diferentes

❌ **DIAGNÓSTICO CRÍTICO:**
${incompatibilidadCritica.mensaje}

💬 **VEREDICTO FINAL:**
NOTA 0 - La entrega no tiene relación alguna con el tema solicitado. Inteligencia Artificial implica algoritmos, machine learning, redes neuronales, etc. Un sistema de matrículas estudiantiles es gestión académica.

⭐ **SOLUCIÓN REQUERIDA:**
Crear una base de datos que contenga información relacionada con IA: datasets de entrenamiento, modelos de machine learning, algoritmos de IA, redes neuronales, sistemas expertos, etc.`;

            const endTime = new Date();
            const duracion = Math.round((endTime - startTime) / 1000);
            console.log('✅ ENVIANDO RESPUESTA AUTOMÁTICA DE INCOMPATIBILIDAD');
            console.log('🕐 HORA DE RESPUESTA:', endTime.toLocaleString('es-ES'));
            console.log('⏱️ DURACIÓN TOTAL:', duracion, 'segundos');
            console.log('==============================================');

            // ENVIAR NOTIFICACIÓN PUSH Y EMAIL SI HAY USER_ID
            if (userId) {
                const notifTitle = "Respuesta Lista 🤖";
                const notifBody = "DeepSeek ha respondido a tu consulta.";

                // Push Notification
                sendPushNotification(
                    userId,
                    notifTitle,
                    notifBody, {
                        type: "DEEPSEEK_RESPONSE",
                        fragment: "ChatBotFragment"
                    }
                ).catch(err => console.error('Error enviando push:', err));

                // Email Notification
                sendEmailNotification(
                    userId,
                    notifTitle,
                    `Hola,\n\nTu consulta ha sido procesada por DeepSeek.\n\nRespuesta:\n${respuestaAutomatica.substring(0, 200)}...\n\nAbre la app para ver la respuesta completa.`
                ).catch(err => console.error('Error enviando email:', err));
            }

            return res.json({ respuesta_texto: respuestaAutomatica });
        }

        console.log('🔍 ¿Es pregunta de nota/tarea/archivo?:', esPreguntaNota);
        console.log('🎯 ¿Es evaluación crítica (solo gemma3n)?:', esPreguntaEvaluacionCritica);

        // Si NO es pregunta de nota/tarea/archivo, solo DeepSeek responde
        if (!esPreguntaNota) {
            console.log('📊 PROCESANDO PREGUNTA SIMPLE CON DEEPSEEK V2.3...');
            try {
                // Si hay contexto académico disponible, incluirlo para dar mejor respuesta
                let promptCompleto = `INSTRUCCIONES CRÍTICAS:
- RESPONDE SIEMPRE EN ESPAÑOL
- USA TERMINOLOGÍA EN ESPAÑOL
- NO USES PALABRAS EN INGLÉS SALVO TÉRMINOS TÉCNICOS NECESARIOS
- FORMATO EDUCATIVO Y PROFESIONAL
- RESPUESTA CLARA Y COMPRENSIBLE

PREGUNTA DEL USUARIO: ${prompt}`;

                if (taskDescription && taskDescription.trim() && fileContent && fileContent.trim()) {
                    promptCompleto = `INSTRUCCIONES CRÍTICAS:
- RESPONDE SIEMPRE EN ESPAÑOL
- USA TERMINOLOGÍA EN ESPAÑOL
- NO USES PALABRAS EN INGLÉS SALVO TÉRMINOS TÉCNICOS NECESARIOS
- FORMATO EDUCATIVO Y PROFESIONAL
- RESPUESTA CLARA Y COMPRENSIBLE

CONTEXTO ACADÉMICO DISPONIBLE:

Descripción de la tarea: ${taskDescription}
Contenido entregado: ${fileContent}

Pregunta del usuario: ${prompt}

Responde considerando el contexto académico disponible si es relevante para la pregunta. SIEMPRE EN ESPAÑOL.`;
                }

                const tokensPrompt = encode(promptCompleto).length;
                console.log('[MODELO DeepSeek v2.3] TOKENS CONSUMIDOS:', tokensPrompt);
                console.log('[MODELO DeepSeek v2.3] PROMPT ENVIADO:', promptCompleto.substring(0, 500) + '...');

                // Call DeepSeek via LLMService
                let respuestaFinal = await callDeepSeek(null, promptCompleto);

                // Defensive fallback if model returns empty
                if (!respuestaFinal || !respuestaFinal.trim()) {
                    console.log('⚠️ WARNING: DeepSeek devolvió respuesta VACÍA, aplicando mensaje por defecto');
                    respuestaFinal = 'Lo siento, en este momento no obtuve una respuesta del modelo. Intenta nuevamente.';
                }

                // ENVIAR NOTIFICACIÓN PUSH Y EMAIL SI HAY USER_ID
                if (userId) {
                    const notifTitle = "Respuesta Lista 🤖";
                    const notifBody = "DeepSeek ha respondido a tu consulta.";

                    // Push Notification
                    sendPushNotification(
                        userId,
                        notifTitle,
                        notifBody, {
                            type: "DEEPSEEK_RESPONSE",
                            fragment: "ChatBotFragment"
                        }
                    ).catch(err => console.error('Error enviando push:', err));

                    // Email Notification
                    sendEmailNotification(
                        userId,
                        notifTitle,
                        `Hola,\n\nTu consulta ha sido procesada por DeepSeek.\n\nRespuesta:\n${respuestaFinal.substring(0, 200)}...\n\nAbre la app para ver la respuesta completa.`
                    ).catch(err => console.error('Error enviando email:', err));
                }

                const tokensRespuestaSimple = encode(respuestaFinal).length;
                console.log('[MODELO DeepSeek v2.3] TOKENS DE RESPUESTA:', tokensRespuestaSimple);
                console.log('[MODELO DeepSeek v2.3] RESPUESTA RECIBIDA:', respuestaFinal.substring(0, 300) + '...');

                // Resumen de consumo total de tokens para respuesta simple
                const tokensTotal = tokensPrompt + tokensRespuestaSimple;
                console.log('📊 RESUMEN DE TOKENS - TOTAL CONSUMIDO:', tokensTotal, '(Prompt:', tokensPrompt, '+ Respuesta:', tokensRespuestaSimple, ')');

                console.log('✅ ENVIANDO RESPUESTA SIMPLE AL CLIENTE');
                const endTime = new Date();
                const duration = endTime - startTime;
                console.log('🕐 HORA DE RESPUESTA:', endTime.toLocaleString('es-ES'));
                console.log('⏱️ DURACIÓN TOTAL:', Math.round(duration / 1000), 'segundos');
                console.log('==============================================');
                // If possible, extract a numeric grade from the respuestaFinal and persist it
                try {
                    const gradeMatch = respuestaFinal.match(/(\d+(?:\.\d+)?)\s*\/\s*10|nota\s*[:\-]?\s*(\d+(?:\.\d+)?)/i);
                    const gradeStr = gradeMatch ? (gradeMatch[1] || gradeMatch[2]) : null;
                    const gradeVal = gradeStr ? parseFloat(gradeStr.replace(',', '.')) : null;
                    if (gradeVal !== null && submissionId) {
                        console.log(`🔁 Persistiendo calificación detectada ${gradeVal} para submissionId=${submissionId}`);
                        await updateTaskSubmissionSupabase(submissionId, gradeVal, respuestaFinal);
                    }
                } catch (err) {
                    console.log('⚠️ Error extrayendo/persistiendo calificación (silent):', err.message);
                }
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                return res.json({ respuesta_texto: respuestaFinal });
            } catch (err) {
                console.log('❌ ERROR EN DEEPSEEK:', err.message);
                return res.status(500).json({ error: 'Error en DeepSeek', detalle: err.message });
            }
        }

        // Si es pregunta de nota/tarea, usar taskDescription y fileContent por separado
        console.log('📊 PROCESANDO PREGUNTA DE NOTA/TAREA CON DEEPSEEK V2.3...');

        // Validar taskDescription pero permitir que esté vacío (usar prompt simple en ese caso)
        if (!taskDescription || !taskDescription.trim()) {
            console.log('⚠️ WARNING: taskDescription vacío, procesando como pregunta simple');
            console.log('📝 taskDescription recibido:', taskDescription);
            // Procesar como pregunta simple sin contexto de archivo
            try {
                const tokensPrompt = encode(prompt).length;
                console.log('[MODELO DeepSeek v2.3] TOKENS CONSUMIDOS (FALLBACK):', tokensPrompt);
                console.log('[MODELO DeepSeek v2.3] PROMPT ENVIADO (FALLBACK):', prompt.substring(0, 300) + '...');

                // Call DeepSeek via LLMService
                let respuestaFinal = await callDeepSeek(null, prompt);

                // Defensive fallback if model returns empty
                if (!respuestaFinal || !respuestaFinal.trim()) {
                    console.log('⚠️ WARNING: DeepSeek devolvió respuesta VACÍA (simple path), aplicando mensaje por defecto');
                    respuestaFinal = 'Lo siento, en este momento no obtuve una respuesta del modelo. Intenta nuevamente.';
                }

                const tokensRespuestaSimple = encode(respuestaFinal).length;
                console.log('[MODELO DeepSeek v2.3] TOKENS DE RESPUESTA (FALLBACK):', tokensRespuestaSimple);
                console.log('[MODELO DeepSeek v2.3] RESPUESTA RECIBIDA (FALLBACK):', respuestaFinal.substring(0, 300) + '...');

                const tokensTotal = tokensPrompt + tokensRespuestaSimple;
                console.log('📊 RESUMEN DE TOKENS - TOTAL CONSUMIDO (FALLBACK):', tokensTotal);

                const endTime = new Date();
                const duration = endTime - startTime;
                console.log('🕐 HORA DE RESPUESTA:', endTime.toLocaleString('es-ES'));
                console.log('⏱️ DURACIÓN TOTAL:', Math.round(duration / 1000), 'segundos');
                console.log('==============================================');
                try {
                    const gradeMatch = respuestaFinal.match(/(\d+(?:\.\d+)?)\s*\/\s*10|nota\s*[:\-]?\s*(\d+(?:\.\d+)?)/i);
                    const gradeStr = gradeMatch ? (gradeMatch[1] || gradeMatch[2]) : null;
                    const gradeVal = gradeStr ? parseFloat(gradeStr.replace(',', '.')) : null;
                    if (gradeVal !== null && submissionId) {
                        console.log(`🔁 Persistiendo calificación detectada ${gradeVal} para submissionId=${submissionId} (fallback)`);
                        await updateTaskSubmissionSupabase(submissionId, gradeVal, respuestaFinal);
                    }
                } catch (err) {
                    console.log('⚠️ Error extrayendo/persistiendo calificación (fallback):', err.message);
                }

                // ENVIAR NOTIFICACIÓN PUSH Y EMAIL SI HAY USER_ID
                if (userId) {
                    const notifTitle = "Respuesta Lista 🤖";
                    const notifBody = "DeepSeek ha respondido a tu consulta.";

                    // Push Notification
                    sendPushNotification(
                        userId,
                        notifTitle,
                        notifBody, {
                            type: "DEEPSEEK_RESPONSE",
                            fragment: "ChatBotFragment"
                        }
                    ).catch(err => console.error('Error enviando push:', err));

                    // Email Notification
                    sendEmailNotification(
                        userId,
                        notifTitle,
                        `Hola,\n\nTu consulta ha sido procesada por DeepSeek.\n\nRespuesta:\n${respuestaFinal.substring(0, 200)}...\n\nAbre la app para ver la respuesta completa.`
                    ).catch(err => console.error('Error enviando email:', err));
                }

                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                return res.json({ respuesta_texto: respuestaFinal });
            } catch (err) {
                console.log('❌ ERROR EN DEEPSEEK (FALLBACK):', err.message);
                return res.status(500).json({ error: 'Error en DeepSeek', detalle: err.message });
            }
        }

        // Validar fileContent pero permitir que esté vacío (usar solo taskDescription)
        if (!fileContent || !fileContent.trim()) {
            console.log('⚠️ WARNING: fileContent vacío, usando solo taskDescription');
            console.log('📄 fileContent recibido (longitud):', (fileContent || '').length);

            // 🔥 MEJORADO: Detectar si el taskDescription indica que el archivo no está disponible
            const archivoNoDisponible = taskDescription && (
                taskDescription.includes('⚠️ NOTA IMPORTANTE') ||
                taskDescription.includes('contenido del archivo del estudiante NO está disponible') ||
                taskDescription.includes('⚠️ NOTA: No se encontró archivo')
            );

            // Construir prompt contextualizado según el caso
            let promptContextualizado;
            if (archivoNoDisponible) {
                promptContextualizado = `CONTEXTO ACADÉMICO:
El estudiante ha seleccionado una tarea pero el contenido del archivo NO está disponible para análisis.
Solo puedo proporcionar información basada en la DESCRIPCIÓN de la tarea.

${taskDescription}

PREGUNTA DEL ESTUDIANTE: ${prompt}

INSTRUCCIONES DE RESPUESTA:
1. Si el estudiante pregunta por calificación o evaluación:
   - Explica que NO puedes calificar porque no tienes acceso al contenido del archivo
   - Describe qué se espera en base a la descripción de la tarea
   - Sugiere que vuelva a subir el archivo o contacte al profesor

2. Si el estudiante pregunta sobre la tarea:
   - Proporciona información basada en la descripción disponible
   - Explica los requisitos de la tarea
   - Da orientación sobre cómo completarla

RESPONDE EN ESPAÑOL de forma clara y educativa.`;
            } else {
                promptContextualizado = `CONTEXTO ACADÉMICO:
${taskDescription}

PREGUNTA DEL ESTUDIANTE: ${prompt}

INSTRUCCIONES: Responde en español de forma clara y educativa basándote en la información de la tarea proporcionada.`;
            }

            try {
                const tokensPrompt = encode(promptContextualizado).length;
                console.log('[MODELO DeepSeek v2.3] TOKENS CONSUMIDOS (SIN ARCHIVO):', tokensPrompt);
                console.log('[MODELO DeepSeek v2.3] PROMPT ENVIADO (SIN ARCHIVO):', promptContextualizado.substring(0, 500) + '...');

                // Call DeepSeek via LLMService
                let respuestaFinal = await callDeepSeek(null, promptContextualizado);

                const tokensRespuesta = encode(respuestaFinal).length;
                console.log('[MODELO DeepSeek v2.3] TOKENS DE RESPUESTA (SIN ARCHIVO):', tokensRespuesta);
                console.log('[MODELO DeepSeek v2.3] RESPUESTA RECIBIDA (SIN ARCHIVO):', respuestaFinal.substring(0, 300) + '...');

                const tokensTotal = tokensPrompt + tokensRespuesta;
                console.log('📊 RESUMEN DE TOKENS - TOTAL CONSUMIDO (SIN ARCHIVO):', tokensTotal);

                const endTime = new Date();
                const duration = endTime - startTime;
                console.log('🕐 HORA DE RESPUESTA:', endTime.toLocaleString('es-ES'));
                console.log('⏱️ DURACIÓN TOTAL:', Math.round(duration / 1000), 'segundos');
                console.log('==============================================');
                try {
                    const gradeMatch = respuestaFinal.match(/(\d+(?:\.\d+)?)\s*\/\s*10|nota\s*[:\-]?\s*(\d+(?:\.\d+)?)/i);
                    const gradeStr = gradeMatch ? (gradeMatch[1] || gradeMatch[2]) : null;
                    const gradeVal = gradeStr ? parseFloat(gradeStr.replace(',', '.')) : null;
                    if (gradeVal !== null && submissionId) {
                        console.log(`🔁 Persistiendo calificación detectada ${gradeVal} para submissionId=${submissionId} (sin archivo)`);
                        await updateTaskSubmissionSupabase(submissionId, gradeVal, respuestaFinal);
                    }
                } catch (err) {
                    console.log('⚠️ Error extrayendo/persistiendo calificación (sin archivo):', err.message);
                }

                // ENVIAR NOTIFICACIÓN PUSH Y EMAIL SI HAY USER_ID
                if (userId) {
                    const notifTitle = "Respuesta Lista 🤖";
                    const notifBody = "DeepSeek ha respondido a tu consulta.";

                    // Push Notification
                    sendPushNotification(
                        userId,
                        notifTitle,
                        notifBody, {
                            type: "DEEPSEEK_RESPONSE",
                            fragment: "ChatBotFragment"
                        }
                    ).catch(err => console.error('Error enviando push:', err));

                    // Email Notification
                    sendEmailNotification(
                        userId,
                        notifTitle,
                        `Hola,\n\nTu consulta ha sido procesada por DeepSeek.\n\nRespuesta:\n${respuestaFinal.substring(0, 200)}...\n\nAbre la app para ver la respuesta completa.`
                    ).catch(err => console.error('Error enviando email:', err));
                }

                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                return res.json({ respuesta_texto: respuestaFinal });
            } catch (err) {
                console.log('❌ ERROR EN DEEPSEEK (SIN ARCHIVO):', err.message);
                return res.status(500).json({ error: 'Error en DeepSeek', detalle: err.message });
            }
        }

        const taskDescriptionClean = taskDescription.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
        const fileContentClean = fileContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();

        // MODO ESPECIAL: DeepSeek para evaluaciones críticas (reemplaza gemma3n)
        if (esPreguntaEvaluacionCritica) {
            console.log('🎯 MODO EVALUACIÓN CRÍTICA - DEEPSEEK V2.3');
            const promptEvaluacionCritica = `EVALUADOR ACADÉMICO JUSTO Y EQUILIBRADO:

INSTRUCCIONES EDUCATIVAS:
- RESPONDE SIEMPRE EN ESPAÑOL
- EVALUACIÓN JUSTA Y CONSTRUCTIVA
- RECONOCE CUANDO EL ESTUDIANTE CUMPLE CON LO SOLICITADO
- FORMATO EDUCATIVO Y PROFESIONAL

PRINCIPIO FUNDAMENTAL: 
SER JUSTO - Si se pide "UN EJEMPLO" de algo, CUALQUIER ejemplo válido de esa categoría merece nota alta.

CRITERIOS DE EVALUACIÓN INTELIGENTES:
🟢 **CUMPLIMIENTO PERFECTO (9-10)**: Entrega exactamente lo pedido
🟢 **CUMPLIMIENTO BUENO (7-8)**: Cumple bien, aunque sea más complejo
🟡 **CUMPLIMIENTO PARCIAL (5-6)**: Relacionado pero no exacto
🟠 **CUMPLIMIENTO MÍNIMO (3-4)**: Alguna relación pero se desvía
🔴 **NO CUMPLE (1-2)**: Poca o ninguna relación
⚫ **TOTALMENTE INCORRECTO (0)**: Sin relación alguna

REGLAS ESPECÍFICAS DE EVALUACIÓN:

📝 **SOLICITUDES GENERALES** (merecen nota alta si cumplen):
- "ejemplo de algoritmo Python" → Cualquier script Python = 8-10
- "ejemplo de programa" → Cualquier programa funcional = 8-10
- "ejemplo de código" → Cualquier código válido = 8-10
- "script Python" → Cualquier script Python = 8-10

📝 **SOLICITUDES ESPECÍFICAS** (deben cumplir exactamente):
- "base de datos de IA" → DEBE ser sobre IA, no películas = 0 si no es IA
- "calculadora" → DEBE calcular, no ser un menú = 0 si no calcula
- "algoritmo de ordenamiento" → DEBE ordenar = 0 si no ordena
- "página de login" → DEBE tener login = 0 si no tiene login

EJEMPLOS CONCRETOS:
✅ "ejemplo algoritmo Python" + script Python complejo = 10/10 (CUMPLE)
❌ "base de datos de IA" + base de datos de películas = 0/10 (NO CUMPLE)
❌ "calculadora" + sistema de archivos = 0/10 (NO CUMPLE)
✅ "ejemplo de programa" + cualquier programa = 9-10/10 (CUMPLE)

FORMATO RESPUESTA OBLIGATORIO (EN ESPAÑOL):
📊 **CALIFICACIÓN ACTUAL: [0-10]/10**
🎯 **TEMA SOLICITADO:** [lo que pidió el profesor]
📄 **TEMA ENTREGADO:** [lo que envió el estudiante]
⚖️ **COMPATIBILIDAD:** [TU ANÁLISIS JUSTO]
📝 **JUSTIFICACIÓN:** [Explicación educativa y justa]

PREGUNTA: ${prompt}

LO QUE SE PIDIÓ:
${taskDescriptionClean}

LO QUE SE ENTREGÓ:
${fileContentClean}

EVALÚA DE MANERA JUSTA Y EDUCATIVA. ASEGÚRATE DE INCLUIR LA LÍNEA "📊 **CALIFICACIÓN ACTUAL: X/10**" AL INICIO.`;

            try {
                const tokensEvaluacion = encode(promptEvaluacionCritica).length;
                console.log('[MODO CRÍTICO - DEEPSEEK v2.3] TOKENS CONSUMIDOS:', tokensEvaluacion);

                // Call DeepSeek via LLMService
                let respuestaEvaluacion = await callDeepSeek(null, promptEvaluacionCritica);

                const tokensRespuesta = encode(respuestaEvaluacion).length;
                console.log('[MODO CRÍTICO - DEEPSEEK v2.3] TOKENS DE RESPUESTA:', tokensRespuesta);
                console.log('[MODO CRÍTICO - DEEPSEEK v2.3] RESPUESTA:', respuestaEvaluacion.substring(0, 500) + '...');

                const endTime = new Date();
                const duration = endTime - startTime;
                console.log('🕐 EVALUACIÓN CRÍTICA COMPLETADA:', endTime.toLocaleString('es-ES'));
                console.log('⏱️ DURACIÓN:', Math.round(duration / 1000), 'segundos');
                console.log('==============================================');

                // ENVIAR NOTIFICACIÓN PUSH Y EMAIL SI HAY USER_ID
                if (userId) {
                    const notifTitle = "Respuesta Lista 🤖";
                    const notifBody = "DeepSeek ha respondido a tu consulta.";

                    // Push Notification
                    sendPushNotification(
                        userId,
                        notifTitle,
                        notifBody, {
                            type: "DEEPSEEK_RESPONSE",
                            fragment: "ChatBotFragment"
                        }
                    ).catch(err => console.error('Error enviando push:', err));

                    // Email Notification
                    sendEmailNotification(
                        userId,
                        notifTitle,
                        `Hola,\n\nTu consulta ha sido procesada por DeepSeek.\n\nRespuesta:\n${respuestaEvaluacion.substring(0, 200)}...\n\nAbre la app para ver la respuesta completa.`
                    ).catch(err => console.error('Error enviando email:', err));
                }

                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                return res.json({ respuesta_texto: respuestaEvaluacion });

            } catch (err) {
                console.log('❌ ERROR EN EVALUACIÓN CRÍTICA:', err.message);
                return res.status(500).json({ error: 'Error en evaluación crítica', detalle: err.message });
            }
        }

        // Construir prompt unificado para DeepSeek (reemplaza gemma3n + llama3)
        let promptUnificado = `EVALUADOR ACADÉMICO JUSTO Y EDUCATIVO:

INSTRUCCIONES EDUCATIVAS:
- RESPONDE SIEMPRE EN ESPAÑOL
- EVALUACIÓN JUSTA Y CONSTRUCTIVA
- RECONOCE CUANDO EL ESTUDIANTE CUMPLE CON LA SOLICITUD
- FORMATO EDUCATIVO Y PROFESIONAL

PRINCIPIO FUNDAMENTAL: 
SER JUSTO - Evaluar si el estudiante entregó lo que se le pidió, siendo flexible con la interpretación.

CRITERIOS DE EVALUACIÓN INTELIGENTES:
🟢 **CUMPLIMIENTO EXCELENTE (9-10)**: Entrega exactamente lo pedido
🟢 **CUMPLIMIENTO BUENO (7-8)**: Cumple bien con lo solicitado
🟡 **CUMPLIMIENTO ACEPTABLE (5-6)**: Cumple parcialmente o relacionado
🟠 **CUMPLIMIENTO BÁSICO (3-4)**: Alguna relación pero se desvía
🔴 **CUMPLIMIENTO DEFICIENTE (1-2)**: Poca relación
⚫ **NO CUMPLE (0)**: Sin relación alguna

REGLAS DE EVALUACIÓN ESPECÍFICAS:

📝 **SOLICITUDES GENERALES** (nota alta si cumplen la categoría):
- "ejemplo de X" → Cualquier X válido merece 8-10
- "script/programa/código" → Cualquier implementación funcional = 8-10

📝 **SOLICITUDES ESPECÍFICAS** (deben cumplir exactamente el tema):
- "base de datos de IA" → DEBE ser de IA, no de películas
- "calculadora" → DEBE calcular números
- "login/registro" → DEBE tener autenticación
- Si no coincide específicamente = 0-2

FORMATO DE RESPUESTA OBLIGATORIO:
📊 **CALIFICACIÓN ACTUAL: [NOTA]/10**
🎯 **ESTADO:** [APROBADO / REVISAR / RECHAZADO]
🎯 **TEMA SOLICITADO:** [lo que pidió el profesor]
📄 **TEMA ENTREGADO:** [lo que envió el estudiante]
📝 **FEEDBACK:** [Tu explicación detallada y constructiva]

PREGUNTA DEL USUARIO: ${prompt}

LO QUE SE PIDIÓ:
"${taskDescriptionClean}"

LO QUE SE ENTREGÓ:
${fileContentClean}

EVALÚA DE MANERA JUSTA Y EDUCATIVA. ASEGÚRATE DE INCLUIR LA LÍNEA "📊 **CALIFICACIÓN ACTUAL: X/10**" AL INICIO.`;

        const tokensPrompt = encode(promptUnificado).length;
        console.log('[MODELO DeepSeek v2.3] TOKENS CONSUMIDOS:', tokensPrompt);
        console.log('[MODELO DeepSeek v2.3] PROMPT ENVIADO:', promptUnificado.substring(0, 500) + '...');

        let respuestaFinal = '';
        try {
            // Call DeepSeek via LLMService
            respuestaFinal = await callDeepSeek(null, promptUnificado);

            const tokensRespuestaFinal = encode(respuestaFinal).length;
            console.log('[MODELO DeepSeek v2.3] TOKENS DE RESPUESTA:', tokensRespuestaFinal);
            console.log('[MODELO DeepSeek v2.3] RESPUESTA RECIBIDA:', respuestaFinal.substring(0, 500) + '...');

            // Resumen de consumo total de tokens
            const tokensTotal = tokensPrompt + tokensRespuestaFinal;
            console.log('📊 RESUMEN DE TOKENS - TOTAL CONSUMIDO:', tokensTotal);

            console.log('✅ ENVIANDO RESPUESTA COMPLETA AL CLIENTE');
            const endTime = new Date();
            const duration = endTime - startTime;
            console.log('🕐 HORA DE RESPUESTA:', endTime.toLocaleString('es-ES'));
            console.log('⏱️ DURACIÓN TOTAL:', Math.round(duration / 1000), 'segundos');
            console.log('==============================================');

            // ENVIAR NOTIFICACIÓN PUSH Y EMAIL SI HAY USER_ID
            if (userId) {
                const notifTitle = "Respuesta Lista 🤖";
                const notifBody = "DeepSeek ha respondido a tu consulta.";

                // Push Notification
                sendPushNotification(
                    userId,
                    notifTitle,
                    notifBody, {
                        type: "DEEPSEEK_RESPONSE",
                        fragment: "ChatBotFragment"
                    }
                ).catch(err => console.error('Error enviando push:', err));

                // Email Notification
                sendEmailNotification(
                    userId,
                    notifTitle,
                    `Hola,\n\nTu consulta ha sido procesada por DeepSeek.\n\nRespuesta:\n${respuestaFinal.substring(0, 200)}...\n\nAbre la app para ver la respuesta completa.`
                ).catch(err => console.error('Error enviando email:', err));
            }

            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            return res.json({ respuesta_texto: respuestaFinal });
        } catch (err) {
            console.log('❌ ERROR EN DEEPSEEK:', err.message);
            return res.status(500).json({ error: 'Error en DeepSeek', detalle: err.message });
        }

    } catch (error) {
        console.log('❌ ERROR GENERAL EN /procesar-prompt:', error.message);
        console.log('❌ STACK TRACE:', error.stack);
        return res.status(500).json({ error: 'Error interno del servidor', detalle: error.message });
    }
});

// Función para obtener la IP local del servidor automáticamente
function getLocalIPAddress() {
    // const { networkInterfaces } = require('os');
    const nets = networkInterfaces();
    const results = [];

    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            // Ignorar direcciones internas (loopback) y no IPv4
            const familyV4Value = typeof net.family === 'string' ? 'IPv4' : 4;
            if (net.family === familyV4Value && !net.internal) {
                results.push(net.address);
            }
        }
    }

    return results;
}

// ============================================================
// MCP ENDPOINTS (Integrated from mcp-http.js for single-port deployment)
// ============================================================

// Initialize Supabase service for MCP endpoints
// const supabaseService = SupabaseService.getInstance(); // Already initialized at top level

/**
 * MCP Health check endpoint
 */
app.get('/health', async(req, res) => {
    try {
        const dbHealth = await supabaseService.healthCheck();

        // Test LLM connection
        let llmHealth = { status: 'not_tested' };
        try {
            if (mcpService && mcpService.llmService) {
                llmHealth = await mcpService.llmService.testConnection();
            } else if (llmService) {
                llmHealth = await llmService.testConnection();
            }
        } catch (e) {
            llmHealth = { status: 'error', error: e.message };
        }

        res.json({
            status: 'ok',
            server: 'tareamov-mcp-server',
            version: '1.0.0',
            timestamp: new Date().toISOString(),
            services: {
                database: dbHealth,
                llm: llmHealth
            }
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

/**
 * MCP initialize endpoint
 */
app.post('/initialize', async(req, res) => {
    console.log('🔧 MCP Initialize request received');

    try {
        await supabaseService.testConnection();
        console.log('✅ Supabase connected');

        res.json({
            jsonrpc: '2.0',
            id: req.body.id,
            result: {
                protocolVersion: '2024-11-05',
                capabilities: {
                    tools: {
                        listChanged: true
                    },
                    resources: {
                        subscribe: true,
                        listChanged: true
                    }
                },
                serverInfo: {
                    name: 'tareamov-mcp-server',
                    version: '1.0.0'
                }
            }
        });
    } catch (error) {
        console.error('❌ Initialize error:', error);
        res.status(500).json({
            jsonrpc: '2.0',
            id: req.body.id,
            error: {
                code: -32603,
                message: 'Internal error during initialization',
                data: error.message
            }
        });
    }
});

/**
 * MCP tools/list endpoint
 */
app.post('/tools/list', async(req, res) => {
    console.log('🔧 Tools list request received');

    res.json({
        jsonrpc: '2.0',
        id: req.body.id,
        result: {
            tools: [{
                    name: 'query_database',
                    description: `Execute queries on the TareaMov Supabase database. Returns real-time data.

**CAPABILITIES:**
- Execute RAW PostgreSQL/SQL queries directly (SELECT, INSERT, UPDATE, DELETE)
- Process natural language queries that are auto-converted to SQL
- Full access to all Supabase tables and relationships

**AVAILABLE TABLES:**
usuarios, personas, courses, videos, topics, content_items, tasks, task_submissions, subscriptions, chat_messages, file_contexts, roles, recursos, rol_recursos, progreso_estudiante`,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            query: {
                                type: 'string',
                                description: 'SQL query (preferred) or natural language query.'
                            }
                        },
                        required: ['query']
                    }
                },
                {
                    name: 'get_database_schema',
                    description: `Get the complete Supabase database schema with all tables, columns, types, and relationships.`,
                    inputSchema: {
                        type: 'object',
                        properties: {},
                        description: 'No parameters required - returns full schema'
                    }
                },
                {
                    name: 'send_notification',
                    description: `Send a notification to a user via Email and/or Push.
Use this tool when the user asks to send a notification, email, or alert to someone.
You can send to specific users by their ID.`,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            userId: {
                                type: 'string',
                                description: 'The UUID of the user to notify'
                            },
                            title: {
                                type: 'string',
                                description: 'Title of the notification/email'
                            },
                            message: {
                                type: 'string',
                                description: 'Body content of the notification/email'
                            },
                            channel: {
                                type: 'string',
                                enum: ['email', 'push', 'both'],
                                description: 'Delivery channel (default: both)'
                            }
                        },
                        required: ['userId', 'title', 'message']
                    }
                },
                {
                    name: 'analyze_github_repo',
                    description: `Analyze and grade a GitHub repository. Extracts code, README, and structure to evaluate quality.`,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            repoUrl: {
                                type: 'string',
                                description: 'GitHub repository URL (e.g., https://github.com/user/repo)'
                            },
                            criteria: {
                                type: 'string',
                                description: 'Optional evaluation criteria or rubric'
                            },
                            taskDescription: {
                                type: 'string',
                                description: 'Optional task/assignment description for context'
                            }
                        },
                        required: ['repoUrl']
                    }
                }
            ]
        }
    });
});

/**
 * MCP tools/call endpoint
 */
app.post('/tools/call', async(req, res) => {
    const { params } = req.body;
    console.log('🔧 Tool call request:', params ? .name);

    try {
        const { name, arguments: args } = params;

        if (name === 'query_database') {
            let result;
            const isSQL = /^\s*(select|insert|update|delete|with)\s/i.test(args.query);

            if (isSQL) {
                console.log('📊 Executing raw SQL query...');
                result = await mcpService.processQuery(args.query, { includeSchema: true });
            } else {
                console.log('🤖 Processing Natural Language Query via Agent...');
                try {
                    const agentResponse = await mcpService.processQueryWithAgent(args.query);
                    result = {
                        data: agentResponse,
                        sqlScript: "-- Executed via LLM Agent with tool calling"
                    };
                } catch (agentError) {
                    console.error('❌ Agent error:', agentError);
                    result = {
                        error: true,
                        message: `Error del agente LLM: ${agentError.message}`
                    };
                }
            }

            res.json({
                jsonrpc: '2.0',
                id: req.body.id,
                result: {
                    content: [{
                        type: 'text',
                        text: JSON.stringify(result, null, 2)
                    }]
                }
            });
        } else if (name === 'get_database_schema') {
            const schema = await mcpService.getDatabaseSchema();
            res.json({
                jsonrpc: '2.0',
                id: req.body.id,
                result: {
                    content: [{
                        type: 'text',
                        text: JSON.stringify(schema, null, 2)
                    }]
                }
            });
        } else if (name === 'send_notification') {
            console.log('📧 Sending notification to:', args.userId);
            const { userId, title, message, channel = 'both' } = args;
            const results = [];

            try {
                if (channel === 'push' || channel === 'both') {
                    await sendPushNotification(userId, title, message);
                    results.push('Push sent');
                }
                if (channel === 'email' || channel === 'both') {
                    await sendEmailNotification(userId, title, message);
                    results.push('Email sent');
                }

                res.json({
                    jsonrpc: '2.0',
                    id: req.body.id,
                    result: {
                        content: [{
                            type: 'text',
                            text: `Notification sent successfully via: ${results.join(', ')}`
                        }]
                    }
                });
            } catch (error) {
                console.error('❌ Notification error:', error);
                res.json({
                    jsonrpc: '2.0',
                    id: req.body.id,
                    result: {
                        content: [{
                            type: 'text',
                            text: `Error sending notification: ${error.message}`
                        }]
                    }
                });
            }
        } else if (name === 'analyze_github_repo') {
            console.log('🐙 Analyzing GitHub repository:', args.repoUrl);

            try {
                const result = await mcpService.analyzeGitHubRepo(args.repoUrl, {
                    taskDescription: args.taskDescription,
                    gradingCriteria: args.gradingCriteria,
                    focusAreas: args.focusAreas,
                    maxFiles: args.maxFiles
                });

                res.json({
                    jsonrpc: '2.0',
                    id: req.body.id,
                    result: {
                        content: [{
                            type: 'text',
                            text: JSON.stringify(result, null, 2)
                        }]
                    }
                });
            } catch (githubError) {
                console.error('❌ GitHub analysis error:', githubError);
                res.json({
                    jsonrpc: '2.0',
                    id: req.body.id,
                    result: {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                error: true,
                                message: `Error analizando repositorio: ${githubError.message}`
                            }, null, 2)
                        }]
                    }
                });
            }
        } else {
            res.status(404).json({
                jsonrpc: '2.0',
                id: req.body.id,
                error: {
                    code: -32601,
                    message: `Tool not found: ${name}`
                }
            });
        }
    } catch (error) {
        console.error('❌ Tool call error:', error);
        res.json({
            jsonrpc: '2.0',
            id: req.body.id,
            result: {
                content: [{
                    type: 'text',
                    text: `❌ Error executing tool: ${error.message}\nHint: Check table names and SQL syntax.`
                }]
            }
        });
    }
});

// ============================================================
// END OF MCP ENDPOINTS
// ============================================================

// Listen on all interfaces so the service is reachable from other devices on the LAN
app.listen(PORT, '0.0.0.0', () => {
    const localIPs = getLocalIPAddress();
    console.log('='.repeat(60));
    console.log('🚀 Microservicio de distribución de contexto con DeepSeek v2.3');
    console.log('='.repeat(60));
    console.log(`📡 Puerto: ${PORT}`);
    console.log(`🌐 Escuchando en todas las interfaces: 0.0.0.0`);
    console.log(`🤖 Modelo LLM: DeepSeek v2.3 (Cloud API)`);
    console.log('\n📍 Direcciones IP detectadas automáticamente:');
    console.log('   ℹ️  Configura tu app Android para usar una de estas IPs');
    console.log('');

    if (localIPs.length > 0) {
        localIPs.forEach((ip, index) => {
            console.log(`   ${index + 1}. http://${ip}:${PORT}`);
        });
        console.log('');
        console.log(`   💡 IP Principal recomendada: http://${localIPs[0]}:${PORT}`);
    } else {
        console.log('   ⚠️  No se detectaron IPs locales (puede estar usando solo localhost)');
    }

    console.log('\n🔗 Endpoints disponibles:');
    console.log(`   • POST /analizar-entrega`);
    console.log(`   • POST /feedback-entrega`);
    console.log(`   • POST /procesar-prompt`);
    console.log(`   • GET  / (health check)`);
    console.log(`   • GET  /health (MCP health)`);
    console.log(`   • POST /initialize (MCP)`);
    console.log(`   • POST /tools/list (MCP)`);
    console.log(`   • POST /tools/call (MCP)`);
    console.log('='.repeat(60));
});