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

// AWS SDK for Cloudflare R2 (S3-compatible)
import { S3Client, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

// ============================================================
// 📦 REFACTORED MODULES - New modular architecture
// These modules provide cleaner, more maintainable code
// The legacy functions below are kept for backwards compatibility
// ============================================================
import { NotificationService } from './src/services/NotificationService.js';
import { R2StorageService } from './src/services/R2StorageService.js';
import { UserService } from './src/services/UserService.js';
// Note: Additional refactored modules available:
// - notificationRoutes: ./src/interfaces/routes/notificationRoutes.js
// - fileUtils: ./src/utils/fileUtils.js  
// - githubUtils: ./src/utils/githubUtils.js
// - emailTemplates: ./src/templates/emailTemplates.js

import { createRequire } from 'module';
const require = createRequire(
    import.meta.url);

const app = express();
const PORT = process.env.PORT || 3001;
const MAX_TOKENS = 4096;

// ============================================================
// 🏥 CRITICAL: Healthcheck endpoint MUST be defined FIRST
// This ensures Railway can verify the container is healthy
// even before all other services are initialized
// ============================================================
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        server: 'coursev-mcp-server',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Also respond to / for basic health checks
app.get('/_health', (req, res) => {
    res.status(200).send('OK');
});

console.log('🏥 Healthcheck endpoints registered (/health, /_health)');

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
    console.log(`✅ LLMService initialized with ${process.env.DEEPSEEK_MODEL || 'deepseek-chat'} (Provider: DeepSeek AI)`);
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

// ============================================================
// 📚 REINFORCEMENT LEARNING HISTORY TABLE INITIALIZATION
// Create table for storing question history per user-course to avoid repetitions
// ============================================================

/**
 * Initialize reinforcement learning history table
 */
async function initializeReinforcementHistoryTable() {
    if (!supabaseService) {
        console.warn('⚠️ SupabaseService not available - skipping reinforcement history table initialization');
        return;
    }

    try {
        console.log('📚 Initializing reinforcement learning history table...');

        // Create table if it doesn't exist
        const createTableQuery = `
            CREATE TABLE IF NOT EXISTS reinforcement_question_history (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                course_id INTEGER NOT NULL,
                questions JSONB NOT NULL,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                UNIQUE(user_id, course_id)
            );

            -- Create index for faster lookups
            CREATE INDEX IF NOT EXISTS idx_reinforcement_history_user_course
            ON reinforcement_question_history(user_id, course_id);

            -- Create index for cleanup (older entries)
            CREATE INDEX IF NOT EXISTS idx_reinforcement_history_created_at
            ON reinforcement_question_history(created_at);
        `;

        // Execute the table creation
        const { error } = await supabaseService.client.rpc('exec_sql', {
            sql: createTableQuery
        });

        if (error) {
            // Try direct table creation if RPC fails
            console.log('⚠️ RPC method failed, trying direct table creation...');
            const { error: directError } = await supabaseService.client
                .from('reinforcement_question_history')
                .select('id')
                .limit(1);

            if (directError && directError.code === 'PGRST116') {
                console.log('📚 Table does not exist, would need manual creation via Supabase dashboard');
                console.log('⚠️ Please create the table manually with the following SQL:');
                console.log(createTableQuery);
            }
        } else {
            console.log('✅ Reinforcement learning history table initialized successfully');
        }
    } catch (error) {
        console.warn('⚠️ Failed to initialize reinforcement history table:', error.message);
        console.log('ℹ️ The application will continue without question history tracking');
    }
}

// Initialize the table
initializeReinforcementHistoryTable();

/**
 * Get reinforcement question history for a user-course combination
 * @param {number} userId - User ID
 * @param {number} courseId - Course ID
 * @returns {Promise<Array>} Array of previous questions
 */
async function getReinforcementQuestionHistory(userId, courseId) {
    if (!supabaseService) {
        console.warn('⚠️ SupabaseService not available for history retrieval');
        return [];
    }

    try {
        const { data, error } = await supabaseService.client
            .from('reinforcement_question_history')
            .select('questions')
            .eq('user_id', userId)
            .eq('course_id', courseId)
            .single();

        if (error && error.code !== 'PGRST116') {
            console.warn('⚠️ Error retrieving question history:', error.message);
            return [];
        }

        return data?.questions || [];
    } catch (error) {
        console.warn('⚠️ Failed to retrieve question history:', error.message);
        return [];
    }
}

/**
 * Save reinforcement questions to history for a user-course combination
 * @param {number} userId - User ID
 * @param {number} courseId - Course ID
 * @param {Array} questions - Array of questions to save
 */
async function saveReinforcementQuestionHistory(userId, courseId, questions) {
    if (!supabaseService) {
        console.warn('⚠️ SupabaseService not available for history saving');
        return;
    }

    try {
        // First, get existing history
        const existingHistory = await getReinforcementQuestionHistory(userId, courseId);

        // Combine existing with new questions
        const allQuestions = [...existingHistory, ...questions];

        // Keep only the last 50 questions to avoid excessive storage
        const recentQuestions = allQuestions.slice(-50);

        // Upsert the record
        const { error } = await supabaseService.client
            .from('reinforcement_question_history')
            .upsert({
                user_id: userId,
                course_id: courseId,
                questions: recentQuestions
            }, {
                onConflict: 'user_id,course_id'
            });

        if (error) {
            console.warn('⚠️ Error saving question history:', error.message);
        } else {
            console.log(`✅ Saved ${questions.length} questions to history for user ${userId}, course ${courseId}`);
        }
    } catch (error) {
        console.warn('⚠️ Failed to save question history:', error.message);
    }
}

/**
 * Check if a prompt is for reinforcement learning questions
 * @param {string} prompt - The prompt text
 * @returns {boolean} True if it's a reinforcement learning request
 */
function isReinforcementLearningRequest(prompt) {
    if (!prompt) return false;

    const lowerPrompt = prompt.toLowerCase();
    return lowerPrompt.includes('refuerzo') ||
           lowerPrompt.includes('reinforcement') ||
           lowerPrompt.includes('preguntas de selección múltiple') ||
           lowerPrompt.includes('multiple-choice') ||
           (lowerPrompt.includes('genera') && lowerPrompt.includes('preguntas'));
}

/**
 * Extract course ID from request body for reinforcement learning
 * @param {Object} reqBody - Request body
 * @returns {number|null} Course ID or null
 */
function extractCourseIdFromRequest(reqBody) {
    // Try different possible field names
    return reqBody.courseId || reqBody.course_id || reqBody.idCurso || null;
}

// ============================================================
// CLOUDFLARE R2 SERVICE (S3-Compatible Storage)
// ============================================================

// Initialize S3 Client for Cloudflare R2
let r2Client = null;
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || '';
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || '';
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || '';
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'coursev-files';
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || 'https://pub-9f393625246c4018b5613be60b01bda1.r2.dev';

if (R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY) {
    try {
        r2Client = new S3Client({
            region: 'auto',
            endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
            credentials: {
                accessKeyId: R2_ACCESS_KEY_ID,
                secretAccessKey: R2_SECRET_ACCESS_KEY,
            },
        });
        console.log('✅ Cloudflare R2 Client initialized');
    } catch (error) {
        console.error('❌ Failed to initialize R2 Client:', error.message);
    }
} else {
    console.warn('⚠️ Cloudflare R2 not configured completely (Missing env vars). Public downloads may still work.');
}

/**
 * Descarga y lee un archivo desde Cloudflare R2
 * @param {string} objectKey - La key del objeto en R2 (ej: "submissions/task_1/user_123.pdf")
 * @returns {Promise<{content: string, contentType: string, size: number}>}
 */
async function fetchR2File(objectKey) {
    if (!r2Client) {
        throw new Error('R2 Client not configured');
    }

    console.log(`📥 Fetching file from R2: ${objectKey}`);

    try {
        const command = new GetObjectCommand({
            Bucket: R2_BUCKET_NAME,
            Key: objectKey,
        });

        const response = await r2Client.send(command);
        const contentType = response.ContentType || 'application/octet-stream';
        const size = response.ContentLength || 0;

        // Convertir el stream a buffer
        const chunks = [];
        for await (const chunk of response.Body) {
            chunks.push(chunk);
        }
        const buffer = Buffer.concat(chunks);

        console.log(`✅ File fetched: ${size} bytes, type: ${contentType}`);

        // Procesar según tipo de contenido
        let content;
        if (contentType.includes('text') || 
            contentType.includes('json') || 
            contentType.includes('javascript') ||
            contentType.includes('xml') ||
            objectKey.endsWith('.txt') ||
            objectKey.endsWith('.sql') ||
            objectKey.endsWith('.py') ||
            objectKey.endsWith('.js') ||
            objectKey.endsWith('.java') ||
            objectKey.endsWith('.kt') ||
            objectKey.endsWith('.html') ||
            objectKey.endsWith('.css') ||
            objectKey.endsWith('.md')) {
            // Archivos de texto - devolver como string
            content = buffer.toString('utf-8');
        } else if (contentType.includes('pdf')) {
            // PDF - devolver como base64 para procesamiento posterior
            content = buffer.toString('base64');
        } else {
            // Otros archivos - devolver como base64
            content = buffer.toString('base64');
        }

        return {
            content,
            contentType,
            size,
            isBase64: !contentType.includes('text') && !contentType.includes('json')
        };
    } catch (error) {
        console.error(`❌ Error fetching R2 file: ${error.message}`);
        throw error;
    }
}

/**
 * Extrae la key del objeto de una URL de R2
 * @param {string} url - URL completa de R2 (ej: "https://pub-xxx.r2.dev/submissions/task_1/file.pdf")
 * @returns {string|null} - La key del objeto o null
 */
function extractR2ObjectKey(url) {
    if (!url) return null;

    // Patrones de URL de R2
    const patterns = [
        // URL pública: https://pub-xxx.r2.dev/folder/file.ext
        /https?:\/\/pub-[^\/]+\.r2\.dev\/(.+)/,
        // URL de endpoint: https://account.r2.cloudflarestorage.com/bucket/key
        /https?:\/\/[^\/]+\.r2\.cloudflarestorage\.com\/[^\/]+\/(.+)/,
        // URL directa con bucket: https://account.r2.cloudflarestorage.com/key
        /https?:\/\/[^\/]+\.r2\.cloudflarestorage\.com\/(.+)/,
    ];

    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) {
            return decodeURIComponent(match[1]);
        }
    }

    return null;
}

/**
 * Lista archivos en un directorio de R2
 * @param {string} prefix - Prefijo/carpeta (ej: "submissions/task_1/")
 * @returns {Promise<Array<{key: string, size: number, lastModified: Date}>>}
 */
async function listR2Files(prefix) {
    if (!r2Client) {
        throw new Error('R2 Client not configured');
    }

    console.log(`📂 Listing R2 files with prefix: ${prefix}`);

    try {
        const command = new ListObjectsV2Command({
            Bucket: R2_BUCKET_NAME,
            Prefix: prefix,
            MaxKeys: 100,
        });

        const response = await r2Client.send(command);
        const files = (response.Contents || []).map(obj => ({
            key: obj.Key,
            size: obj.Size,
            lastModified: obj.LastModified,
            url: `${R2_PUBLIC_URL}/${obj.Key}`
        }));

        console.log(`✅ Found ${files.length} files`);
        return files;
    } catch (error) {
        console.error(`❌ Error listing R2 files: ${error.message}`);
        throw error;
    }
}

/**
 * Obtiene el contenido de un archivo de entrega desde R2, URL directa, o file_contexts
 * @param {string} fileUri - URI del archivo (puede ser URL de R2 o URL directa)
 * @param {string} fileName - Nombre del archivo para determinar el tipo
 * @param {number} submissionId - ID de la submission para buscar en file_contexts
 * @returns {Promise<{content: string, contentType: string, fileType: string}>}
 */
async function getSubmissionFileContent(fileUri, fileName, submissionId = null) {
    console.log(`📄 Getting submission file content: ${fileName}`);
    console.log(`   URI: ${fileUri}`);
    console.log(`   SubmissionId: ${submissionId}`);

    // OPCIÓN 1: Intentar obtener el contenido desde file_contexts (más confiable)
    if (submissionId && supabaseService) {
        try {
            console.log(`🔍 Buscando contenido en file_contexts para submission ${submissionId}...`);
            const { data: fileContext, error } = await supabaseService.client
                .from('file_contexts')
                .select('file_content, file_type, file_name, extracted_text, metadata, content_summary')
                .eq('submission_id', submissionId)
                .order('id', { ascending: false })
                .limit(1)
                .single();

            if (!error && fileContext) {
                // El contenido puede estar en file_content o extracted_text
                const content = fileContext.file_content || fileContext.extracted_text;
                if (content) {
                    console.log(`✅ Contenido encontrado en file_contexts (${content.length} chars)`);
                    return {
                        content: content,
                        contentType: 'text/plain',
                        size: content.length,
                        isBase64: false,
                        fileType: fileContext.file_type || getFileTypeFromName(fileName || fileContext.file_name),
                        fileName: fileContext.file_name || fileName,
                        metadata: fileContext.metadata,
                        summary: fileContext.content_summary,
                        extractedText: fileContext.extracted_text,
                        source: 'file_contexts'
                    };
                }
            }
            console.log(`⚠️ No se encontró contenido en file_contexts: ${error?.message || 'sin datos o contenido vacío'}`);
        } catch (fcError) {
            console.log(`⚠️ Error buscando en file_contexts: ${fcError.message}`);
        }
    }

    // OPCIÓN 2: Determinar si es una URL de R2 e intentar descargar
    const isR2Url = fileUri && (
        fileUri.includes('.r2.dev') || 
        fileUri.includes('.r2.cloudflarestorage.com') ||
        fileUri.includes('pub-')
    );

    // OPCIÓN 2a: Usar cliente R2 autenticado si está disponible
    if (isR2Url && r2Client) {
        try {
            console.log(`🔐 Intentando acceso autenticado a R2...`);
            const objectKey = extractR2ObjectKey(fileUri);
            if (objectKey) {
                const result = await fetchR2File(objectKey);
                return {
                    ...result,
                    fileType: getFileTypeFromName(fileName),
                    source: 'r2_authenticated'
                };
            }
        } catch (r2Error) {
            console.log(`⚠️ Error con R2 autenticado: ${r2Error.message}`);
        }
    }

    // OPCIÓN 2b: Intentar descarga directa desde URL pública de R2
    if (isR2Url) {
        try {
            console.log(`🌐 Intentando descarga desde URL pública de R2: ${fileUri}`);
            const response = await axios.get(fileUri, {
                responseType: 'arraybuffer',
                timeout: 60000,
                headers: {
                    'User-Agent': 'CourseV-MCP-Server/1.0',
                    'Accept': '*/*'
                }
            });

            const buffer = Buffer.from(response.data);
            const contentType = response.headers['content-type'] || 'application/octet-stream';
            
            let content;
            if (contentType.includes('text') || isTextFile(fileName)) {
                content = buffer.toString('utf-8');
            } else {
                content = buffer.toString('base64');
            }

            console.log(`✅ Archivo descargado desde R2 público: ${buffer.length} bytes`);
            return {
                content,
                contentType,
                size: buffer.length,
                isBase64: !contentType.includes('text') && !isTextFile(fileName),
                fileType: getFileTypeFromName(fileName),
                source: 'r2_public'
            };
        } catch (publicError) {
            console.log(`⚠️ Error descargando desde R2 público: ${publicError.message}`);
        }
    }

    // OPCIÓN 3: Si es una URL HTTP/HTTPS normal, descargar directamente
    if (fileUri && (fileUri.startsWith('http://') || fileUri.startsWith('https://'))) {
        try {
            console.log(`🌐 Intentando descarga HTTP directa: ${fileUri}`);
            const response = await axios.get(fileUri, {
                responseType: 'arraybuffer',
                timeout: 30000,
                headers: {
                    'User-Agent': 'CourseV-MCP-Server/1.0'
                }
            });

            const buffer = Buffer.from(response.data);
            const contentType = response.headers['content-type'] || 'application/octet-stream';
            
            let content;
            if (contentType.includes('text') || isTextFile(fileName)) {
                content = buffer.toString('utf-8');
            } else {
                content = buffer.toString('base64');
            }

            return {
                content,
                contentType,
                size: buffer.length,
                isBase64: !contentType.includes('text') && !isTextFile(fileName),
                fileType: getFileTypeFromName(fileName),
                source: 'http_direct'
            };
        } catch (error) {
            console.error(`❌ Error downloading file: ${error.message}`);
        }
    }

    // Si llegamos aquí, no pudimos obtener el contenido
    throw new Error(`No se pudo obtener el contenido del archivo. URI: ${fileUri}, SubmissionId: ${submissionId}`);
}

/**
 * Determina si un archivo es de texto basándose en su nombre
 */
function isTextFile(fileName) {
    const textExtensions = [
        '.txt', '.sql', '.py', '.js', '.ts', '.java', '.kt', '.swift',
        '.html', '.css', '.json', '.xml', '.md', '.csv', '.yaml', '.yml',
        '.sh', '.bat', '.ps1', '.c', '.cpp', '.h', '.hpp', '.cs', '.php',
        '.rb', '.go', '.rs', '.scala', '.r', '.m', '.lua', '.pl'
    ];
    const lowerName = fileName.toLowerCase();
    return textExtensions.some(ext => lowerName.endsWith(ext));
}

/**
 * Determina el tipo de archivo basándose en su nombre
 */
function getFileTypeFromName(fileName) {
    const lowerName = (fileName || '').toLowerCase();
    
    if (lowerName.endsWith('.pdf')) return 'pdf';
    if (lowerName.endsWith('.docx') || lowerName.endsWith('.doc')) return 'docx';
    if (lowerName.endsWith('.xlsx') || lowerName.endsWith('.xls')) return 'excel';
    if (lowerName.endsWith('.pptx') || lowerName.endsWith('.ppt')) return 'powerpoint';
    if (lowerName.endsWith('.txt')) return 'text';
    if (lowerName.endsWith('.sql')) return 'sql';
    if (lowerName.endsWith('.py')) return 'python';
    if (lowerName.endsWith('.js') || lowerName.endsWith('.ts')) return 'javascript';
    if (lowerName.endsWith('.java')) return 'java';
    if (lowerName.endsWith('.kt')) return 'kotlin';
    if (lowerName.endsWith('.html') || lowerName.endsWith('.htm')) return 'html';
    if (lowerName.endsWith('.css')) return 'css';
    if (lowerName.endsWith('.json')) return 'json';
    if (lowerName.endsWith('.xml')) return 'xml';
    if (lowerName.endsWith('.md')) return 'markdown';
    if (lowerName.endsWith('.csv')) return 'csv';
    if (lowerName.endsWith('.zip') || lowerName.endsWith('.rar')) return 'archive';
    if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg') || 
        lowerName.endsWith('.png') || lowerName.endsWith('.gif')) return 'image';
    if (lowerName.endsWith('.mp4') || lowerName.endsWith('.avi') || 
        lowerName.endsWith('.mov')) return 'video';
    
    return 'unknown';
}

// ============================================================
// END CLOUDFLARE R2 SERVICE
// ============================================================

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
    console.log('   📋 Tarea:', taskDescription?.substring(0, 100) || 'Sin descripción');

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
        console.log('   📁 Archivos analizados:', result.filesAnalyzed?.length || 0);

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

// ============================================================
// 📧 PLANTILLAS HTML PROFESIONALES PARA EMAILS
// Diseño minimalista, elegante y profesional
// ============================================================

/**
 * Genera el CSS base para todas las plantillas de email
 */
function getEmailBaseStyles() {
    return `
        body { 
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
            background-color: #f8fafc; 
            margin: 0; 
            padding: 20px;
            color: #1e293b;
        }
        .container { 
            max-width: 600px; 
            margin: 0 auto; 
            background: #ffffff; 
            border-radius: 16px; 
            overflow: hidden;
            box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
        }
        .header { 
            background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); 
            padding: 32px 24px; 
            text-align: center;
        }
        .header-icon { 
            font-size: 48px; 
            margin-bottom: 8px;
        }
        .header h1 { 
            color: white; 
            margin: 0; 
            font-size: 24px; 
            font-weight: 600;
            letter-spacing: -0.5px;
        }
        .header p { 
            color: rgba(255,255,255,0.85); 
            margin: 8px 0 0 0; 
            font-size: 14px;
        }
        .content { 
            padding: 32px 24px;
        }
        .greeting { 
            font-size: 18px; 
            color: #334155; 
            margin-bottom: 24px;
        }
        .greeting strong { 
            color: #6366f1;
        }
        .card { 
            background: #f8fafc; 
            border-radius: 12px; 
            padding: 20px; 
            margin: 16px 0;
            border-left: 4px solid #6366f1;
        }
        .card-title { 
            font-size: 12px; 
            text-transform: uppercase; 
            letter-spacing: 1px; 
            color: #64748b; 
            margin: 0 0 8px 0;
            font-weight: 600;
        }
        .card-value { 
            font-size: 20px; 
            font-weight: 700; 
            color: #1e293b; 
            margin: 0;
        }
        .grade-display { 
            text-align: center; 
            padding: 24px; 
            background: linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%); 
            border-radius: 12px; 
            margin: 20px 0;
        }
        .grade-display.low { 
            background: linear-gradient(135deg, #fef2f2 0%, #fecaca 100%);
        }
        .grade-display.medium { 
            background: linear-gradient(135deg, #fffbeb 0%, #fef3c7 100%);
        }
        .grade-number { 
            font-size: 48px; 
            font-weight: 800; 
            color: #16a34a; 
            line-height: 1;
        }
        .grade-display.low .grade-number { 
            color: #dc2626;
        }
        .grade-display.medium .grade-number { 
            color: #d97706;
        }
        .grade-label { 
            font-size: 14px; 
            color: #64748b; 
            margin-top: 4px;
        }
        .comparison-grid { 
            display: table; 
            width: 100%; 
            margin: 20px 0;
        }
        .comparison-row { 
            display: table-row;
        }
        .comparison-cell { 
            display: table-cell; 
            width: 50%; 
            padding: 12px; 
            vertical-align: top;
        }
        .comparison-box { 
            background: #f8fafc; 
            border-radius: 12px; 
            padding: 16px; 
            height: 100%;
        }
        .comparison-box.old { 
            border: 2px solid #e2e8f0;
        }
        .comparison-box.new { 
            border: 2px solid #6366f1; 
            background: linear-gradient(135deg, #f5f3ff 0%, #ede9fe 100%);
        }
        .comparison-label { 
            font-size: 11px; 
            text-transform: uppercase; 
            letter-spacing: 1px; 
            color: #94a3b8; 
            margin-bottom: 8px;
            font-weight: 600;
        }
        .comparison-box.new .comparison-label { 
            color: #6366f1;
        }
        .comparison-value { 
            font-size: 28px; 
            font-weight: 700; 
            color: #94a3b8;
        }
        .comparison-box.new .comparison-value { 
            color: #6366f1;
        }
        .feedback-box { 
            background: #f8fafc; 
            border-radius: 12px; 
            padding: 20px; 
            margin: 16px 0;
            border: 1px solid #e2e8f0;
        }
        .feedback-box.old { 
            opacity: 0.7;
        }
        .feedback-box.new { 
            border-color: #6366f1; 
            background: linear-gradient(135deg, #f5f3ff 0%, #ede9fe 100%);
        }
        .feedback-label { 
            font-size: 11px; 
            text-transform: uppercase; 
            letter-spacing: 1px; 
            color: #64748b; 
            margin-bottom: 12px;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .feedback-box.new .feedback-label { 
            color: #6366f1;
        }
        .feedback-text { 
            font-size: 15px; 
            line-height: 1.6; 
            color: #334155;
            margin: 0;
            font-style: italic;
        }
        .message { 
            font-size: 15px; 
            line-height: 1.7; 
            color: #475569; 
            margin: 16px 0;
        }
        .cta-button { 
            display: inline-block; 
            background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); 
            color: white !important; 
            padding: 14px 32px; 
            border-radius: 10px; 
            text-decoration: none; 
            font-weight: 600; 
            font-size: 15px;
            margin: 24px 0;
            transition: transform 0.2s;
        }
        .divider { 
            height: 1px; 
            background: linear-gradient(to right, transparent, #e2e8f0, transparent); 
            margin: 24px 0;
        }
        .footer { 
            background: #f8fafc; 
            padding: 24px; 
            text-align: center; 
            border-top: 1px solid #e2e8f0;
        }
        .footer p { 
            margin: 0; 
            color: #94a3b8; 
            font-size: 13px;
        }
        .footer .brand { 
            font-weight: 600; 
            color: #6366f1;
        }
        .badge { 
            display: inline-block; 
            padding: 4px 12px; 
            border-radius: 20px; 
            font-size: 12px; 
            font-weight: 600;
        }
        .badge-success { 
            background: #dcfce7; 
            color: #16a34a;
        }
        .badge-warning { 
            background: #fef3c7; 
            color: #d97706;
        }
        .badge-info { 
            background: #e0e7ff; 
            color: #6366f1;
        }
        .info-row { 
            display: flex; 
            justify-content: space-between; 
            padding: 12px 0; 
            border-bottom: 1px solid #f1f5f9;
        }
        .info-row:last-child { 
            border-bottom: none;
        }
        .info-label { 
            color: #64748b; 
            font-size: 14px;
        }
        .info-value { 
            color: #1e293b; 
            font-weight: 600; 
            font-size: 14px;
        }
        .arrow-icon { 
            color: #6366f1; 
            font-size: 24px; 
            margin: 0 12px;
        }
    `;
}

/**
 * Plantilla: Notificación de nueva calificación
 */
function generateGradeEmailHTML(studentName, taskName, grade, feedback, gradedByUsername) {
    const gradeNum = parseFloat(grade);
    const gradeClass = gradeNum >= 7 ? '' : gradeNum >= 5 ? 'medium' : 'low';
    const gradeEmoji = gradeNum >= 9 ? '🏆' : gradeNum >= 7 ? '⭐' : gradeNum >= 5 ? '📝' : '📚';
    const motivationalText = gradeNum >= 7 
        ? '¡Excelente trabajo! Sigue así.' 
        : gradeNum >= 5 
            ? 'Buen esfuerzo. ¡Puedes mejorar!' 
            : 'No te desanimes. ¡Sigue practicando!';
    
    const gradeFormatted = typeof grade === 'number' ? grade.toFixed(1) : grade;
    
    const feedbackSection = feedback ? `
            <div class="feedback-box new">
                <div class="feedback-label">💬 Feedback del profesor</div>
                <p class="feedback-text">"${feedback}"</p>
            </div>
            ` : '';

    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>${getEmailBaseStyles()}</style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="header-icon">${gradeEmoji}</div>
            <h1>¡Tu tarea ha sido calificada!</h1>
            <p>Ya puedes ver tu calificación</p>
        </div>
        
        <div class="content">
            <p class="greeting">¡Hola <strong>${studentName}</strong>! 👋</p>
            
            <div class="card">
                <p class="card-title">📚 Tarea evaluada</p>
                <p class="card-value">${taskName}</p>
            </div>
            
            <div class="grade-display ${gradeClass}">
                <div class="grade-number">${gradeFormatted}</div>
                <div class="grade-label">de 10 puntos</div>
            </div>
            
            ${feedbackSection}
            
            <div class="card">
                <p class="card-title">👨‍🏫 Calificado por</p>
                <p class="card-value">${gradedByUsername || 'Tu profesor'}</p>
            </div>
            
            <p class="message" style="text-align: center; margin-top: 24px;">
                ${motivationalText}
            </p>
            
            <div style="text-align: center;">
                <a href="#" class="cta-button">Ver detalles en CourseV</a>
            </div>
        </div>
        
        <div class="footer">
            <p>Este email fue enviado por <span class="brand">CourseV</span></p>
            <p style="margin-top: 8px;">© 2025 YisusCompany. Todos los derechos reservados.</p>
        </div>
    </div>
</body>
</html>
    `;
}

/**
 * Plantilla: Notificación de calificación MODIFICADA
 */
function generateGradeModifiedEmailHTML(studentName, taskName, oldGrade, newGrade, oldFeedback, newFeedback, gradedByUsername) {
    const newGradeNum = parseFloat(newGrade);
    const oldGradeNum = parseFloat(oldGrade);
    const gradeImproved = newGradeNum > oldGradeNum;
    const changeEmoji = gradeImproved ? '📈' : newGradeNum < oldGradeNum ? '📉' : '🔄';
    const changeText = gradeImproved 
        ? '¡Tu calificación ha mejorado!' 
        : newGradeNum < oldGradeNum 
            ? 'Tu calificación ha sido ajustada' 
            : 'Tu calificación ha sido actualizada';
    
    const oldGradeFormatted = typeof oldGrade === 'number' ? oldGrade.toFixed(1) : oldGrade;
    const newGradeFormatted = typeof newGrade === 'number' ? newGrade.toFixed(1) : newGrade;
    const dateFormatted = new Date().toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
    
    // Secciones condicionales
    let feedbackSection = '';
    if (oldFeedback || newFeedback) {
        let oldFeedbackHTML = oldFeedback ? `
                <div class="feedback-box old">
                    <div class="feedback-label">
                        <span>📝</span> Feedback anterior
                    </div>
                    <p class="feedback-text" style="text-decoration: line-through; color: #94a3b8;">"${oldFeedback}"</p>
                </div>
                ` : '';
        
        let newFeedbackHTML = newFeedback ? `
                <div class="feedback-box new">
                    <div class="feedback-label">
                        <span>✨</span> Nuevo feedback
                    </div>
                    <p class="feedback-text">"${newFeedback}"</p>
                </div>
                ` : '';
        
        feedbackSection = `
            <div style="margin: 24px 0;">
                <p style="font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: #64748b; margin-bottom: 16px; font-weight: 600; text-align: center;">
                    💬 Feedback
                </p>
                ${oldFeedbackHTML}
                ${newFeedbackHTML}
            </div>
            `;
    }

    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>${getEmailBaseStyles()}</style>
</head>
<body>
    <div class="container">
        <div class="header" style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);">
            <div class="header-icon">${changeEmoji}</div>
            <h1>Calificación Actualizada</h1>
            <p>${changeText}</p>
        </div>
        
        <div class="content">
            <p class="greeting">¡Hola <strong>${studentName}</strong>!</p>
            
            <div class="card">
                <p class="card-title">📚 Tarea</p>
                <p class="card-value">${taskName}</p>
            </div>
            
            <!-- Comparación de Notas -->
            <div style="text-align: center; margin: 24px 0;">
                <p style="font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: #64748b; margin-bottom: 16px; font-weight: 600;">
                    📊 Cambio en la calificación
                </p>
                <table style="width: 100%; border-collapse: collapse;">
                    <tr>
                        <td style="width: 45%; padding: 12px; vertical-align: middle;">
                            <div class="comparison-box old" style="text-align: center;">
                                <div class="comparison-label">Nota anterior</div>
                                <div class="comparison-value" style="text-decoration: line-through;">${oldGradeFormatted}</div>
                            </div>
                        </td>
                        <td style="width: 10%; text-align: center; vertical-align: middle;">
                            <span style="font-size: 24px; color: #6366f1;">→</span>
                        </td>
                        <td style="width: 45%; padding: 12px; vertical-align: middle;">
                            <div class="comparison-box new" style="text-align: center;">
                                <div class="comparison-label">Nueva nota</div>
                                <div class="comparison-value">${newGradeFormatted}</div>
                            </div>
                        </td>
                    </tr>
                </table>
            </div>
            
            <!-- Comparación de Feedback -->
            ${feedbackSection}
            
            <div class="divider"></div>
            
            <div style="background: #f8fafc; border-radius: 12px; padding: 16px;">
                <div class="info-row">
                    <span class="info-label">👨‍🏫 Modificado por</span>
                    <span class="info-value">${gradedByUsername || 'Tu profesor'}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">📅 Fecha</span>
                    <span class="info-value">${dateFormatted}</span>
                </div>
            </div>
            
            <div style="text-align: center; margin-top: 24px;">
                <a href="#" class="cta-button">Ver detalles en CourseV</a>
            </div>
        </div>
        
        <div class="footer">
            <p>Este email fue enviado por <span class="brand">CourseV</span></p>
            <p style="margin-top: 8px;">© 2025 YisusCompany. Todos los derechos reservados.</p>
        </div>
    </div>
</body>
</html>
    `;
}

/**
 * Plantilla: Notificación de nuevo curso
 */
function generateNewCourseEmailHTML(userName, creatorUsername, courseTitle, thumbnailUrl) {
    const thumbnailSection = thumbnailUrl ? `
            <div style="text-align: center; margin: 24px 0;">
                <img src="${thumbnailUrl}" alt="Thumbnail del curso" style="max-width: 100%; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
            </div>
            ` : '';
    
    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>${getEmailBaseStyles()}</style>
</head>
<body>
    <div class="container">
        <div class="header" style="background: linear-gradient(135deg, #10b981 0%, #059669 100%);">
            <div class="header-icon">📚</div>
            <h1>¡Nuevo Curso Disponible!</h1>
            <p>De un creador que sigues</p>
        </div>
        
        <div class="content">
            <p class="greeting">¡Hola <strong>${userName || 'estudiante'}</strong>! 👋</p>
            
            <p class="message">
                <strong>${creatorUsername}</strong> acaba de publicar un nuevo curso que podría interesarte.
            </p>
            
            ${thumbnailSection}
            
            <div class="card" style="border-left-color: #10b981;">
                <p class="card-title">🎓 Nuevo curso</p>
                <p class="card-value">${courseTitle}</p>
            </div>
            
            <div style="background: #f0fdf4; border-radius: 12px; padding: 16px; margin: 20px 0; text-align: center;">
                <p style="margin: 0; color: #166534; font-size: 15px;">
                    ¡No te pierdas este nuevo contenido!<br>
                    Entra ahora y comienza a aprender.
                </p>
            </div>
            
            <div style="text-align: center;">
                <a href="#" class="cta-button" style="background: linear-gradient(135deg, #10b981 0%, #059669 100%);">
                    Ver curso ahora
                </a>
            </div>
        </div>
        
        <div class="footer">
            <p>Este email fue enviado por <span class="brand">CourseV</span></p>
            <p style="margin-top: 8px;">© 2025 YisusCompany. Todos los derechos reservados.</p>
        </div>
    </div>
</body>
</html>
    `;
}

/**
 * Plantilla: Notificación genérica profesional
 */
function generateGenericEmailHTML(title, message, type, senderUsername) {
    const typeConfig = {
        'new_course': { icon: '📚', color: '#10b981', gradient: 'linear-gradient(135deg, #10b981 0%, #059669 100%)' },
        'new_video': { icon: '🎬', color: '#f59e0b', gradient: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)' },
        'task_graded': { icon: '📊', color: '#6366f1', gradient: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)' },
        'task_submission': { icon: '📝', color: '#0ea5e9', gradient: 'linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%)' },
        'new_task': { icon: '📋', color: '#8b5cf6', gradient: 'linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%)' },
        'default': { icon: '🔔', color: '#6366f1', gradient: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)' }
    };
    
    const config = typeConfig[type] || typeConfig['default'];
    
    const senderSection = senderUsername ? `
            <div class="card" style="border-left-color: ${config.color};">
                <p class="card-title">👤 De</p>
                <p class="card-value">${senderUsername}</p>
            </div>
            ` : '';

    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>${getEmailBaseStyles()}</style>
</head>
<body>
    <div class="container">
        <div class="header" style="background: ${config.gradient};">
            <div class="header-icon">${config.icon}</div>
            <h1>${title || 'Nueva Notificación'}</h1>
        </div>
        
        <div class="content">
            ${senderSection}
            
            <div class="message" style="font-size: 16px; line-height: 1.8; padding: 20px 0;">
                ${message}
            </div>
            
            <div class="divider"></div>
            
            <div style="text-align: center;">
                <a href="#" class="cta-button" style="background: ${config.gradient};">
                    Abrir en CourseV
                </a>
            </div>
        </div>
        
        <div class="footer">
            <p>Este email fue enviado por <span class="brand">CourseV</span></p>
            <p style="margin-top: 8px;">© 2025 YisusCompany. Todos los derechos reservados.</p>
        </div>
    </div>
</body>
</html>
    `;
}

// ============================================================
// FIN PLANTILLAS HTML
// ============================================================

// Configurar bodyParser.json() ANTES de las rutas
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.json({ limit: '50mb' }));

// ============================================================
// 📍 REGISTER MODULAR ROUTES
// The notification routes are now handled by the refactored module
// Legacy routes below are kept for backwards compatibility
// ============================================================

// Reinforcement history endpoints (save and fetch)
app.post('/reinforcement-history', async (req, res) => {
    try {
        const { userId, courseId, questions } = req.body || {};
        if (!userId || !courseId || !questions) {
            return res.status(400).json({ success: false, error: 'Missing userId, courseId or questions' });
        }

        // saveReinforcementQuestionHistory is defined above in this file
        await saveReinforcementQuestionHistory(Number(userId), Number(courseId), questions);

        return res.json({ success: true, message: 'Reinforcement history saved' });
    } catch (err) {
        console.error('Error saving reinforcement history:', err);
        return res.status(500).json({ success: false, error: String(err) });
    }
});

app.get('/reinforcement-history/:userId/:courseId', async (req, res) => {
    try {
        const userId = Number(req.params.userId);
        const courseId = Number(req.params.courseId);
        if (!userId || !courseId) {
            return res.status(400).json({ success: false, error: 'Missing userId or courseId' });
        }

        const history = await getReinforcementQuestionHistory(userId, courseId);
        return res.json({ success: true, data: history });
    } catch (err) {
        console.error('Error fetching reinforcement history:', err);
        return res.status(500).json({ success: false, error: String(err) });
    }
});

// Note: The notificationRoutes module is available but we keep
// the legacy functions below to avoid breaking existing integrations
// TODO: Migrate to app.use('/', notificationRoutes) after testing

// Initialize refactored services (singletons)
const notificationServiceInstance = NotificationService.getInstance();
const r2StorageServiceInstance = R2StorageService.getInstance();
const userServiceInstance = UserService.getInstance();
console.log('✅ Refactored services initialized: NotificationService, R2StorageService, UserService');

/**
 * Envía una notificación push a un usuario específico vía FCM
 * ACTUALIZADO: Usa sendEachForMulticast en lugar de sendMulticast (deprecado)
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

        // 2. Construir el mensaje base (sin tokens, se agregan individualmente)
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

        // 3. Enviar vía FCM usando send() individual para cada token
        // IMPORTANTE: Google deprecó /batch API el 20 junio 2024
        // sendEach y sendEachForMulticast fallan con 404 en versiones antiguas
        // Solución: enviar uno por uno con send() que siempre funciona
        console.log(`📨 Enviando ${uniqueTokens.length} notificaciones push individualmente...`);
        
        const results = [];
        const failedTokens = [];
        
        for (let i = 0; i < uniqueTokens.length; i++) {
            const token = uniqueTokens[i];
            try {
                const message = {
                    ...baseMessage,
                    token: token
                };
                const messageId = await admin.messaging().send(message);
                results.push({ success: true, messageId });
                console.log(`   ✅ Token ${i + 1}/${uniqueTokens.length}: Enviado (${messageId})`);
            } catch (sendError) {
                results.push({ success: false, error: sendError });
                console.warn(`   ⚠️ Token ${i + 1}/${uniqueTokens.length} falló: ${sendError.code || sendError.message}`);
                
                // Solo eliminar tokens con errores de registro inválido
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
        console.log(`📨 Notificaciones enviadas a usuario ${userId}: ${successCount} éxitos, ${failureCount} fallos`);

        // Limpiar tokens inválidos
        if (failedTokens.length > 0) {
            console.log('🧹 Limpiando tokens inválidos:', failedTokens.length);
            await supabaseService.client
                .from('user_fcm_tokens')
                .delete()
                .in('token', failedTokens);
        }

    } catch (error) {
        console.error('❌ Error enviando notificación push:', error.message);
        // No re-lanzar el error para evitar que falle toda la operación
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

        // 🎬 Template de email con animación Lottie y diseño moderno CourseV
        const htmlContent = `
<!DOCTYPE html>
<html lang="es">
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="X-UA-Compatible" content="IE=edge">
    <meta http-equiv="X-UA-Compatible" content="IE=edge">
    <title>${subject}</title>
    <!--[if mso]>
    <noscript>
        <xml>
            <o:OfficeDocumentSettings>
                <o:PixelsPerInch>96</o:PixelsPerInch>
            </o:OfficeDocumentSettings>
        </xml>
    </noscript>
    <![endif]-->
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
        
        * { margin: 0; padding: 0; box-sizing: border-box; }
        
        body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background-color: #0f172a;
            color: #e2e8f0;
        }
        
        .email-container {
            max-width: 600px;
            margin: 0 auto;
            background: linear-gradient(180deg, #1e293b 0%, #0f172a 100%);
        }
        
        .header {
            background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 50%, #a855f7 100%);
            padding: 40px 30px;
            text-align: center;
            position: relative;
            overflow: hidden;
        }
        
        .header::before {
            content: '';
            position: absolute;
            top: -50%;
            left: -50%;
            width: 200%;
            height: 200%;
            background: radial-gradient(circle, rgba(255,255,255,0.1) 0%, transparent 70%);
            animation: pulse 4s ease-in-out infinite;
        }
        
        @keyframes pulse {
            0%, 100% { transform: scale(1); opacity: 0.5; }
            50% { transform: scale(1.1); opacity: 0.8; }
        }
        
        .logo-container {
            position: relative;
            z-index: 1;
        }
        
        .brand-name {
            font-size: 36px;
            font-weight: 700;
            color: #ffffff;
            letter-spacing: -1px;
            margin-bottom: 8px;
        }
        
        .brand-tagline {
            font-size: 14px;
            color: rgba(255,255,255,0.85);
            font-weight: 500;
        }
        
        .animation-container {
            background: linear-gradient(180deg, #1e293b 0%, #334155 100%);
            padding: 30px;
            text-align: center;
            border-bottom: 1px solid #475569;
        }
        
        .lottie-wrapper {
            width: 280px;
            height: 200px;
            margin: 0 auto;
            border-radius: 16px;
            overflow: hidden;
            background: #1e293b;
            box-shadow: 0 8px 32px rgba(99, 102, 241, 0.2);
        }
        
        .content {
            padding: 40px 30px;
        }
        
        .subject-title {
            font-size: 24px;
            font-weight: 700;
            color: #f1f5f9;
            margin-bottom: 20px;
            line-height: 1.3;
        }
        
        .message-box {
            background: linear-gradient(135deg, #1e293b 0%, #334155 100%);
            border: 1px solid #475569;
            border-radius: 16px;
            padding: 24px;
            margin-bottom: 30px;
        }
        
        .message-text {
            font-size: 16px;
            color: #cbd5e1;
            line-height: 1.8;
        }
        
        .cta-button {
            display: inline-block;
            background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
            color: #ffffff !important;
            text-decoration: none;
            padding: 16px 40px;
            border-radius: 12px;
            font-weight: 600;
            font-size: 16px;
            text-align: center;
            box-shadow: 0 4px 20px rgba(99, 102, 241, 0.4);
            transition: all 0.3s ease;
        }
        
        .cta-button:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 24px rgba(99, 102, 241, 0.5);
        }
        
        .features {
            display: flex;
            justify-content: center;
            gap: 20px;
            margin-top: 30px;
            flex-wrap: wrap;
        }
        
        .feature-item {
            background: rgba(99, 102, 241, 0.1);
            border: 1px solid rgba(99, 102, 241, 0.3);
            border-radius: 12px;
            padding: 16px 20px;
            text-align: center;
            min-width: 150px;
        }
        
        .feature-icon {
            font-size: 24px;
            margin-bottom: 8px;
        }
        
        .feature-text {
            font-size: 13px;
            color: #94a3b8;
            font-weight: 500;
        }
        
        .footer {
            background: #0f172a;
            padding: 30px;
            border-top: 1px solid #1e293b;
            text-align: center;
        }
        
        .footer-brand {
            font-size: 20px;
            font-weight: 700;
            color: #6366f1;
            margin-bottom: 16px;
        }
        
        .footer-text {
            font-size: 13px;
            color: #64748b;
            margin-bottom: 8px;
        }
        
        .footer-links {
            margin-top: 20px;
        }
        
        .footer-link {
            color: #6366f1;
            text-decoration: none;
            font-size: 13px;
            margin: 0 12px;
        }
        
        .social-links {
            margin-top: 20px;
        }
        
        .social-icon {
            display: inline-block;
            width: 36px;
            height: 36px;
            background: #1e293b;
            border-radius: 50%;
            margin: 0 8px;
            line-height: 36px;
            font-size: 16px;
        }
        
        .divider {
            height: 1px;
            background: linear-gradient(90deg, transparent 0%, #475569 50%, transparent 100%);
            margin: 30px 0;
        }
        
        @media only screen and (max-width: 600px) {
            .email-container { width: 100% !important; }
            .content { padding: 30px 20px; }
            .header { padding: 30px 20px; }
            .brand-name { font-size: 28px; }
            .subject-title { font-size: 20px; }
            .lottie-wrapper { width: 240px; height: 170px; }
        }
    </style>
</head>
<body style="margin: 0; padding: 0; background-color: #0f172a;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #0f172a; padding: 40px 20px;">
        <tr>
            <td align="center">
                <!-- Main Container -->
                <table class="email-container" width="600" cellpadding="0" cellspacing="0" border="0" style="background: linear-gradient(180deg, #1e293b 0%, #0f172a 100%); border-radius: 24px; overflow: hidden; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);">
                    
                    <!-- Header with Gradient -->
                    <tr>
                        <td class="header" style="background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 50%, #a855f7 100%); padding: 40px 30px; text-align: center;">
                            <div class="logo-container">
                                <h1 class="brand-name" style="font-size: 36px; font-weight: 700; color: #ffffff; letter-spacing: -1px; margin: 0 0 8px 0;">
                                    📚 CourseV
                                </h1>
                                <p class="brand-tagline" style="font-size: 14px; color: rgba(255,255,255,0.9); margin: 0; font-weight: 500;">
                                    Tu plataforma de aprendizaje inteligente
                                </p>
                            </div>
                        </td>
                    </tr>
                    
                    <!-- Image Section - Responsive con VML fallback para Outlook -->
                    <tr>
                        <td class="animation-container" style="background: linear-gradient(180deg, #1e293b 0%, #334155 100%); padding: 30px; text-align: center; border-bottom: 1px solid #475569;">
                            <!--[if mso]>
                            <v:rect xmlns:v="urn:schemas-microsoft-com:vml" fill="true" stroke="false" style="width:540px;height:300px;">
                            <v:fill type="frame" src="https://pub-9f393625246c4018b5613be60b01bda1.r2.dev/videos/88a385d4fe0ce2a8dfea2d0ae4677174.gif" />
                            <v:textbox inset="0,0,0,0">
                            <![endif]-->
                            <div style="max-width: 540px; width: 100%; margin: 0 auto; border-radius: 16px; overflow: hidden; box-shadow: 0 8px 32px rgba(99, 102, 241, 0.2);">
                                <!-- GIF animado de CourseV desde R2 -->
                                <img 
                                    src="https://pub-9f393625246c4018b5613be60b01bda1.r2.dev/videos/88a385d4fe0ce2a8dfea2d0ae4677174.gif"
                                    alt="CourseV - Plataforma de Aprendizaje"
                                    width="540"
                                    style="width: 100%; max-width: 540px; height: auto; display: block; border-radius: 16px; border: 0;"
                                />
                            </div>
                            <!--[if mso]>
                            </v:textbox>
                            </v:rect>
                            <![endif]-->
                            <p style="margin-top: 16px; font-size: 13px; color: #94a3b8;">
                                ✨ Aprendizaje interactivo con IA
                            </p>
                        </td>
                    </tr>
                    
                    <!-- Content Section -->
                    <tr>
                        <td class="content" style="padding: 40px 30px;">
                            <h2 class="subject-title" style="font-size: 24px; font-weight: 700; color: #f1f5f9; margin: 0 0 20px 0; line-height: 1.3;">
                                ${subject}
                            </h2>
                            
                            <div class="message-box" style="background: linear-gradient(135deg, #1e293b 0%, #334155 100%); border: 1px solid #475569; border-radius: 16px; padding: 24px; margin-bottom: 30px;">
                                <p class="message-text" style="font-size: 16px; color: #cbd5e1; line-height: 1.8; margin: 0;">
                                    ${text.replace(/\n/g, '<br>')}
                                </p>
                            </div>
                            
                            <!-- CTA Button -->
                            <div style="text-align: center; margin: 30px 0;">
                                <a href="https://coursev-app.yisuscompany.com/app-link?action=chat" class="cta-button" style="display: inline-block; background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); color: #ffffff; text-decoration: none; padding: 16px 40px; border-radius: 12px; font-weight: 600; font-size: 16px;">
                                    🚀 Abrir CourseV
                                </a>
                            </div>
                            
                            <!-- Features -->
                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top: 30px;">
                                <tr>
                                    <td align="center">
                                        <table cellpadding="0" cellspacing="0" border="0">
                                            <tr>
                                                <td style="background: rgba(99, 102, 241, 0.1); border: 1px solid rgba(99, 102, 241, 0.3); border-radius: 12px; padding: 16px 20px; text-align: center; margin: 0 10px;">
                                                    <div style="font-size: 24px; margin-bottom: 8px;">🤖</div>
                                                    <div style="font-size: 13px; color: #94a3b8; font-weight: 500;">IA Avanzada</div>
                                                </td>
                                                <td width="20"></td>
                                                <td style="background: rgba(99, 102, 241, 0.1); border: 1px solid rgba(99, 102, 241, 0.3); border-radius: 12px; padding: 16px 20px; text-align: center; margin: 0 10px;">
                                                    <div style="font-size: 24px; margin-bottom: 8px;">📱</div>
                                                    <div style="font-size: 13px; color: #94a3b8; font-weight: 500;">App Móvil</div>
                                                </td>
                                                <td width="20"></td>
                                                <td style="background: rgba(99, 102, 241, 0.1); border: 1px solid rgba(99, 102, 241, 0.3); border-radius: 12px; padding: 16px 20px; text-align: center; margin: 0 10px;">
                                                    <div style="font-size: 24px; margin-bottom: 8px;">🎓</div>
                                                    <div style="font-size: 13px; color: #94a3b8; font-weight: 500;">Cursos Pro</div>
                                                </td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                    
                    <!-- Divider -->
                    <tr>
                        <td>
                            <div style="height: 1px; background: linear-gradient(90deg, transparent 0%, #475569 50%, transparent 100%); margin: 0 30px;"></div>
                        </td>
                    </tr>
                    
                    <!-- Footer -->
                    <tr>
                        <td class="footer" style="background: #0f172a; padding: 30px; text-align: center;">
                            <div class="footer-brand" style="font-size: 20px; font-weight: 700; color: #6366f1; margin-bottom: 16px;">
                                📚 CourseV
                            </div>
                            <p class="footer-text" style="font-size: 13px; color: #64748b; margin: 0 0 8px 0;">
                                Este es un mensaje automático de CourseV
                            </p>
                            <p style="font-size: 12px; color: #475569; margin: 0;">
                                © ${new Date().getFullYear()} CourseV by YisusCompany. Todos los derechos reservados.
                            </p>
                            
                            <div class="footer-links" style="margin-top: 20px;">
                                <a href="https://yisuscompany.com" class="footer-link" style="color: #6366f1; text-decoration: none; font-size: 13px; margin: 0 12px;">
                                    yisuscompany.com
                                </a>
                                <span style="color: #475569;">|</span>
                                <a href="mailto:coursev@yisuscompany.com" class="footer-link" style="color: #6366f1; text-decoration: none; font-size: 13px; margin: 0 12px;">
                                    Contacto
                                </a>
                            </div>
                        </td>
                    </tr>
                </table>
                
                <!-- Unsubscribe Section -->
                <table width="600" cellpadding="0" cellspacing="0" border="0" style="margin-top: 20px;">
                    <tr>
                        <td style="text-align: center; color: #475569; font-size: 11px; padding: 10px;">
                            <p style="margin: 0;">
                                Recibiste este correo porque eres usuario de CourseV.
                            </p>
                            <p style="margin: 8px 0 0 0;">
                                <a href="#" style="color: #6366f1; text-decoration: none;">Cancelar suscripción</a>
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

            // ✅ Usar dominio verificado yisuscompany.com
            // Dominio verificado en https://resend.com/domains
            const fromEmail = 'CourseV@yisuscompany.com';
            const fromName = 'CourseV'; // Nombre que aparece en el cliente de email
            
            try {
                const resendResponse = await axios.post('https://api.resend.com/emails', {
                    from: `${fromName} <${fromEmail}>`,
                    to: [userEmail],
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

                console.log(`✅ Email enviado a ${userEmail} via Resend desde ${fromEmail}: ${resendResponse.data.id}`);
                return;
            } catch (resendError) {
                console.error('❌ Error con Resend:', resendError.response?.data || resendError.message);
                // Fallback - reintentar con el mismo dominio verificado
                console.log('🔄 Reintentando envío de email...');
                try {
                    const fallbackResponse = await axios.post('https://api.resend.com/emails', {
                        from: 'CourseV <CourseV@yisuscompany.com>',
                        to: [userEmail],
                        subject: `📚 ${subject}`,
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
                    console.error('❌ Fallback también falló:', fallbackError.response?.data || fallbackError.message);
                }
            }
        }

        // 3. OPCIÓN 2: SendGrid HTTP API
        if (process.env.SENDGRID_API_KEY) {
            console.log('📧 Enviando email via SendGrid HTTP API...');

            const sgResponse = await axios.post('https://api.sendgrid.com/v3/mail/send', {
                personalizations: [{
                    to: [{ email: userEmail }],
                    subject: `📚 ${subject}`
                }],
                from: { 
                    email: process.env.SENDGRID_FROM_EMAIL || 'coursev@yisuscompany.com',
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
                from: `"CourseV" <${process.env.GMAIL_USER}>`,
                to: userEmail,
                subject: `📚 ${subject}`,
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

    // ============================================================
    // 🔍 VALIDACIÓN DE CONTENIDO VACÍO O SIN CONTENIDO REAL
    // Si la tarea no tiene contenido, automáticamente calificación = 0
    // ============================================================
    
    // Función para verificar si el contenido está realmente vacío o es inválido
    const esContenidoVacio = (content) => {
        if (!content) return true;
        
        // Limpiar espacios, saltos de línea y caracteres especiales
        const contenidoLimpio = content
            .replace(/\s+/g, '') // Eliminar espacios y saltos de línea
            .replace(/[\r\n\t]/g, '') // Eliminar caracteres de control
            .replace(/[^\w\u00C0-\u024F]/g, '') // Solo letras y números (incluye acentos)
            .trim();
        
        // Verificar si está vacío o tiene muy poco contenido significativo
        if (contenidoLimpio.length < 20) return true;
        
        // Verificar patrones de contenido vacío o placeholder
        const patronesVacios = [
            /^[\s\n\r\t]*$/,  // Solo espacios
            /^(null|undefined|none|empty|vacío|vacio)$/i,
            /^\[\s*\]$/,  // Array vacío
            /^\{\s*\}$/,  // Objeto vacío
            /^""$/,  // String vacío
            /^''$/,  // String vacío
            /^sin\s*contenido/i,
            /^no\s*content/i,
            /^empty\s*file/i,
            /^archivo\s*vacío/i,
            /^archivo\s*vacio/i
        ];
        
        for (const patron of patronesVacios) {
            if (patron.test(content.trim())) return true;
        }
        
        return false;
    };
    
    // Verificar si el contenido está vacío
    if (esContenidoVacio(fileContent)) {
        console.log(`⚠️ Submission ${submissionId}: Contenido vacío detectado - Calificación: 0`);
        const nota = 0;
        const cumplimiento = 'La entrega no contiene contenido válido.';
        const resumen = `❌ **CALIFICACIÓN: 0/100**

📋 **DESCRIPCIÓN DE LA TAREA:** ${contentSummary}

⚠️ **PROBLEMA:** La entrega está vacía o no contiene contenido significativo.

El archivo enviado (${fileName || 'sin nombre'}) no tiene contenido que pueda ser evaluado.

💡 **PARA OBTENER CALIFICACIÓN:**
1. Asegúrate de que el archivo contenga tu trabajo
2. Verifica que el contenido sea visible y legible
3. Si usaste un formato especial, conviértelo a PDF o TXT
4. Vuelve a subir la tarea con el contenido completo

**Nota:** Una entrega sin contenido siempre recibirá calificación de 0.`;

        ragCache[submissionId] = { nota, resumen, cumplimiento };
        return res.json({ nota, resumen, cumplimiento });
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

⚠️ REGLA CRÍTICA #1: ENTREGAS VACÍAS = NOTA 0 AUTOMÁTICO
- Si el archivo está vacío o no tiene contenido: NOTA 0 INMEDIATO
- Si el contenido es solo espacios en blanco: NOTA 0 INMEDIATO  
- Si no hay código/texto significativo: NOTA 0 INMEDIATO
- Si el archivo solo contiene placeholders como "null", "empty", "vacío": NOTA 0 INMEDIATO

CRITERIOS DE EVALUACIÓN ABSOLUTOS:
1. CONTENIDO VACÍO O INEXISTENTE: ¿El archivo tiene contenido real? Si NO: nota 0 OBLIGATORIO
2. COMPATIBILIDAD TECNOLÓGICA: ¿El archivo contiene EXACTAMENTE el lenguaje/tecnología solicitada?
3. COHERENCIA TEMÁTICA CRÍTICA: ¿El contenido responde EXACTAMENTE al tema/proyecto solicitado?
4. CUMPLIMIENTO DE REQUISITOS: ¿Se cumplen TODOS los requisitos especificados?

REGLAS DE CALIFICACIÓN INFLEXIBLES:
- Si el archivo está VACÍO o sin contenido: nota 0 OBLIGATORIO (NO NEGOCIABLE)
- Si el lenguaje/tecnología NO coincide: nota 0 OBLIGATORIO
- Si el tema/proyecto NO coincide: nota 0 OBLIGATORIO  
- Si se pide BANCO y se entrega PELÍCULAS: nota 0 OBLIGATORIO
- Si se pide PELÍCULAS y se entrega BANCO: nota 0 OBLIGATORIO
- Si se pide HOSPITAL y se entrega TIENDA: nota 0 OBLIGATORIO
- Si faltan requisitos clave: nota 0-3 máximo
- Si cumple parcialmente: nota 4-7
- Si cumple totalmente: nota 8-10

CASOS CRÍTICOS INCOMPATIBLES (SIEMPRE nota 0):
- ARCHIVO VACÍO o sin contenido significativo
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

CRÍTICO: 
1. Si el archivo está VACÍO o no tiene contenido significativo: asigna nota 0 inmediatamente
2. Si detectas CUALQUIER incompatibilidad temática (ej: banco vs películas), asigna nota 0 inmediatamente y explica la incompatibilidad específica.`;

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
        // 🔥 LÓGICA DE DECISIÓN DE CALIFICACIÓN DELEGADA AL LLM:
        // En lugar de usar reglas de lenguaje frágiles (regex), le pedimos al LLM que decida
        // si la pregunta amerita una calificación o es solo una consulta.
        // Esto se hace en el PROMPT.
        
        const promptLlama = `INSTRUCCIONES PARA ASISTENTE EDUCATIVO HÍBRIDO:

INSTRUCCIONES CRÍTICAS:
- EL USUARIO ES UN DOCENTE REVISANDO LA ENTREGA DE UN ESTUDIANTE
- TU TAREA ES DETERMINAR SI EL USUARIO ESTÁ PIDIENDO UNA CALIFICACIÓN O SOLO INFORMACIÓN
- RESPONDE SIEMPRE EN ESPAÑOL
- FORMATO EDUCATIVO Y PROFESIONAL

Información de la evaluación previa:
- Nota calculada previamente: ${resultado.nota}/10
- Análisis previo: ${resultado.resumen}
- Estado de cumplimiento: ${resultado.cumplimiento}

Pregunta del usuario: "${pregunta}"

REGLAS DE DECISIÓN (Sigue esto estrictamente):
1. SI el usuario pide explícitamente una nota, calificación, evaluación, puntaje, o pregunta "¿cuánto saqué?", "¿cómo voy?":
   -> DEBES incluir el bloque de "CALIFICACIÓN ACTUAL" con la nota numérica.
   -> Usa el Formato A (Evaluación).

2. SI el usuario hace preguntas generales como "¿qué envié?", "¿cuál es el contenido?", "¿por qué está mal?", "¿cómo mejoro?", o preguntas técnicas sobre el tema:
   -> NO incluyas una calificación numérica.
   -> Responde solo a la duda.
   -> Usa el Formato B (Consulta).

FORMATO A (Evaluación - Solo si se pide nota):
📊 **CALIFICACIÓN ACTUAL: ${resultado.nota}/10**

🔍 **ANÁLISIS DE TU ENTREGA:**
[Explicación detallada basada en el análisis previo]

💬 **RETROALIMENTACIÓN:**
[Responder a la pregunta]

⭐ **RECOMENDACIONES:**
[Pasos para mejorar]

FORMATO B (Consulta - Preguntas generales):
💬 **RESPUESTA:**
[Responde directamente a la pregunta del usuario de manera útil]

💡 **CONTEXTO ADICIONAL:**
[Información relevante del análisis previo sin dar la nota numérica]

(IMPORTANTE: TÚ decides qué formato usar basándote en la intención de la pregunta del usuario)`;

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
            `${process.env.SUPABASE_URL}/rest/v1/usuarios?id=in.(${subscriberIds.join(',')})&select=id,username,email`, {
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

                // Send email with Resend - Plantilla profesional
                if (user.email) {
                    try {
                        const senderEmail = 'CourseV@yisuscompany.com';
                        const emailHTML = generateNewCourseEmailHTML(
                            user.username,
                            creatorUsername,
                            courseTitle,
                            courseThumbnailUrl
                        );
                        
                        await axios.post('https://api.resend.com/emails', {
                            from: `CourseV <${senderEmail}>`,
                            to: user.email,
                            subject: `📚 ¡${creatorUsername} publicó un nuevo curso!`,
                            html: emailHTML
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
 * 📊 Notifica al ESTUDIANTE cuando recibe una calificación en su tarea
 * Endpoint: POST /notify-grade
 * Body: { studentId, taskName, grade, feedback, gradedByUsername, oldGrade, oldFeedback, isModification }
 * 
 * IMPORTANTE: La notificación va al ESTUDIANTE (dueño de la entrega),
 * NO al creador del curso.
 * 
 * Si isModification=true, muestra comparación entre nota/feedback anterior y nuevo
 */
app.post('/notify-grade', async(req, res) => {
    const { studentId, taskName, grade, feedback, gradedByUsername, oldGrade, oldFeedback, isModification } = req.body;

    if (!studentId || !taskName || grade === undefined) {
        return res.status(400).json({ error: 'studentId, taskName y grade son requeridos' });
    }

    const isUpdate = isModification === true || (oldGrade !== undefined && oldGrade !== null);
    
    console.log(`📊 Notificando calificación al estudiante ${studentId}`);
    console.log(`   📝 Tarea: ${taskName}`);
    console.log(`   📈 Nota: ${grade}/10 ${isUpdate ? `(anterior: ${oldGrade}/10)` : '(nueva)'}`);
    console.log(`   👤 Calificado por: ${gradedByUsername || 'Profesor'}`);

    try {
        // 1. Obtener información del estudiante
        const { data: student, error: studentError } = await supabaseService.client
            .from('usuarios')
            .select('id, email, username')
            .eq('id', studentId)
            .single();

        if (studentError || !student) {
            console.error(`❌ Estudiante ${studentId} no encontrado:`, studentError?.message);
            return res.status(404).json({ error: 'Estudiante no encontrado' });
        }

        console.log(`✅ Estudiante encontrado: ${student.username} (${student.email})`);

        // 2. Preparar contenido de la notificación
        const gradeFormatted = typeof grade === 'number' ? grade.toFixed(1) : grade;
        const gradeEmoji = grade >= 9 ? '🏆' : grade >= 7 ? '⭐' : grade >= 5 ? '✅' : '📚';
        
        // Determinar si es modificación o nueva calificación
        let emailSubject, emailHTML, pushTitle, pushBody, notificationType;
        
        if (isUpdate) {
            // Calificación MODIFICADA - usar plantilla de comparación
            const oldGradeFormatted = typeof oldGrade === 'number' ? oldGrade.toFixed(1) : oldGrade;
            const gradeImproved = parseFloat(grade) > parseFloat(oldGrade);
            const changeEmoji = gradeImproved ? '📈' : parseFloat(grade) < parseFloat(oldGrade) ? '📉' : '🔄';
            
            emailSubject = `${changeEmoji} Tu calificación en "${taskName}" ha sido actualizada`;
            emailHTML = generateGradeModifiedEmailHTML(
                student.username,
                taskName,
                oldGrade,
                grade,
                oldFeedback,
                feedback,
                gradedByUsername
            );
            pushTitle = `${changeEmoji} Calificación actualizada: ${oldGradeFormatted} → ${gradeFormatted}`;
            pushBody = `Tu nota en "${taskName}" cambió de ${oldGradeFormatted} a ${gradeFormatted}`;
            notificationType = 'grade_modified';
            
            console.log(`   🔄 Modificación: ${oldGradeFormatted} → ${gradeFormatted}`);
        } else {
            // Nueva calificación
            emailSubject = `${gradeEmoji} ¡Tu tarea "${taskName}" ha sido calificada!`;
            emailHTML = generateGradeEmailHTML(
                student.username,
                taskName,
                grade,
                feedback,
                gradedByUsername
            );
            pushTitle = `${gradeEmoji} Tarea calificada: ${gradeFormatted}/10`;
            pushBody = `Tu tarea "${taskName}" ha sido evaluada${gradedByUsername ? ` por ${gradedByUsername}` : ''}`;
            notificationType = 'grade';
        }

        // 3. Enviar Email al estudiante con plantilla HTML profesional
        if (student.email) {
            try {
                const RESEND_API_KEY = process.env.RESEND_API_KEY;
                if (RESEND_API_KEY) {
                    await axios.post('https://api.resend.com/emails', {
                        from: 'CourseV <CourseV@yisuscompany.com>',
                        to: student.email,
                        subject: emailSubject,
                        html: emailHTML
                    }, {
                        headers: {
                            'Authorization': `Bearer ${RESEND_API_KEY}`,
                            'Content-Type': 'application/json'
                        }
                    });
                    console.log(`📧 Email de calificación enviado a ${student.email}`);
                }
            } catch (emailError) {
                console.warn(`⚠️ Error enviando email:`, emailError.response?.data || emailError.message);
            }
        }

        // 4. Enviar Push Notification al estudiante
        await sendPushNotification(
            studentId,
            pushTitle,
            pushBody,
            {
                type: notificationType,
                taskName: taskName,
                grade: gradeFormatted.toString(),
                oldGrade: isUpdate ? String(oldGrade) : null,
                action: 'OPEN_GRADES'
            }
        );
        console.log(`📱 Push notification de calificación enviada al estudiante ${studentId}`);

        // 5. Guardar notificación en la base de datos
        try {
            await supabaseService.client
                .from('notifications')
                .insert({
                    user_id: studentId,
                    title: emailSubject,
                    message: isUpdate 
                        ? `Tu calificación en "${taskName}" cambió de ${oldGrade} a ${gradeFormatted}/10`
                        : `Tu tarea "${taskName}" ha sido calificada con ${gradeFormatted}/10`,
                    type: notificationType,
                    read: false,
                    created_at: new Date().toISOString()
                });
            console.log(`💾 Notificación guardada en BD para estudiante ${studentId}`);
        } catch (dbError) {
            console.warn(`⚠️ No se pudo guardar notificación en BD:`, dbError.message);
        }

        res.json({
            success: true,
            message: isUpdate 
                ? 'Notificación de calificación MODIFICADA enviada al estudiante'
                : 'Notificación de calificación enviada al estudiante',
            isModification: isUpdate,
            studentId: studentId,
            studentUsername: student.username,
            studentEmail: student.email,
            taskName: taskName,
            grade: gradeFormatted,
            oldGrade: isUpdate ? oldGrade : null,
            oldFeedback: isUpdate ? oldFeedback : null,
            newFeedback: feedback
        });

    } catch (error) {
        console.error('❌ Error en /notify-grade:', error);
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
            .select('username')
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
            message: `${creator.username} ha subido: ${videoTitle}`,
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
                `${creator.username} acaba de subir un nuevo video: ${videoTitle}`, {
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
                `Hola,\n\n${creator.username} acaba de subir un nuevo video titulado: "${videoTitle}".\n\n¡Entra a la app para verlo ahora!`
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
 * 🔔 Endpoint genérico para enviar notificaciones por push y email
 * Endpoint: POST /send-notification
 * Body: { userId, title, message, type, relatedId, senderUsername }
 * 
 * Este endpoint envía notificaciones por:
 * 1. Push notification (Firebase Cloud Messaging)
 * 2. Email (Resend API)
 */
app.post('/send-notification', async(req, res) => {
    const { userId, title, message, type, relatedId, senderUsername } = req.body;

    if (!userId) {
        return res.status(400).json({ error: 'userId es requerido' });
    }

    console.log(`🔔 Enviando notificación completa para usuario ${userId}`);
    console.log(`   Tipo: ${type}, Título: ${title}`);

    const results = {
        push: { success: false, error: null },
        email: { success: false, error: null }
    };

    try {
        // 1. ENVIAR PUSH NOTIFICATION
        try {
            if (admin && admin.messaging) {
                // Obtener FCM token del usuario desde Supabase
                const { data: tokens, error: tokenError } = await supabaseService.client
                    .from('user_fcm_tokens')
                    .select('token')
                    .eq('user_id', userId)
                    .order('last_updated', { ascending: false });

                if (!tokenError && tokens && tokens.length > 0) {
                    const sendPromises = tokens.map(async({ token }) => {
                        try {
                            const pushMessage = {
                                notification: {
                                    title: title || '📢 Nueva notificación',
                                    body: message || 'Tienes una nueva notificación',
                                },
                                data: {
                                    userId: userId.toString(),
                                    type: type || 'generic',
                                    relatedId: relatedId ? relatedId.toString() : '',
                                    senderUsername: senderUsername || '',
                                    timestamp: new Date().toISOString()
                                },
                                android: {
                                    priority: 'high',
                                    notification: {
                                        channelId: 'deepseek_updates',
                                        sound: 'default',
                                        priority: 'high',
                                        defaultSound: true,
                                        color: '#6366f1'
                                    }
                                },
                                token: token
                            };

                            const response = await admin.messaging().send(pushMessage);
                            console.log(`✅ Push enviado a token: ${token.substring(0, 15)}...`);
                            return { success: true, messageId: response };
                        } catch (error) {
                            console.error(`❌ Error push token ${token.substring(0, 10)}...`, error.message);
                            
                            // Eliminar token inválido
                            if (error.code === 'messaging/invalid-registration-token' ||
                                error.code === 'messaging/registration-token-not-registered') {
                                await supabaseService.client
                                    .from('user_fcm_tokens')
                                    .delete()
                                    .eq('token', token);
                            }
                            return { success: false, error: error.message };
                        }
                    });

                    const pushResults = await Promise.all(sendPromises);
                    const successCount = pushResults.filter(r => r.success).length;
                    results.push.success = successCount > 0;
                    results.push.sentCount = successCount;
                    console.log(`📱 Push notifications: ${successCount}/${tokens.length} enviadas`);
                } else {
                    results.push.error = 'No FCM tokens found';
                    console.warn(`⚠️ No se encontraron tokens FCM para usuario ${userId}`);
                }
            } else {
                results.push.error = 'Firebase Admin not configured';
                console.warn('⚠️ Firebase Admin no disponible');
            }
        } catch (pushError) {
            results.push.error = pushError.message;
            console.error('❌ Error en push notification:', pushError.message);
        }

        // 2. ENVIAR EMAIL
        try {
            // Convertir userId a número para asegurar compatibilidad con Supabase
            const userIdNumber = parseInt(userId, 10);
            console.log(`🔍 Buscando email para userId: ${userId} (parseado: ${userIdNumber})`);
            
            // Obtener email del usuario desde Supabase
            // NOTA: El campo es 'username', no 'usuario'
            const { data: userData, error: userError } = await supabaseService.client
                .from('usuarios')
                .select('email, username')
                .eq('id', userIdNumber)
                .single();

            console.log(`🔍 Resultado consulta usuario:`, { userData, userError });

            if (!userError && userData && userData.email && userData.email !== '.' && !userData.email.startsWith('missing_email_')) {
                const userEmail = userData.email;
                const userName = userData.username || 'Usuario';
                console.log(`📧 Enviando email a: ${userEmail}`);

                // Crear contenido del email usando plantilla profesional
                let emailSubject = title || '📢 Nueva notificación en CourseV';
                
                // Generar HTML profesional usando la plantilla genérica
                const emailHTML = generateGenericEmailHTML(title, message, type, senderUsername);

                // Personalizar subject según el tipo
                switch(type) {
                    case 'new_course':
                        emailSubject = `📚 ${title}`;
                        break;
                    case 'new_video':
                        emailSubject = `🎬 ${title}`;
                        break;
                    case 'task_graded':
                    case 'grade':
                    case 'grade_modified':
                        emailSubject = `📊 ${title}`;
                        break;
                    case 'task_submission':
                        emailSubject = `📝 ${title}`;
                        break;
                    case 'new_task':
                        emailSubject = `📋 ${title}`;
                        break;
                }

                // Enviar con Resend API
                const RESEND_API_KEY = process.env.RESEND_API_KEY;
                if (RESEND_API_KEY) {
                    const fromEmail = 'CourseV <CourseV@yisuscompany.com>';
                    
                    const emailResponse = await fetch('https://api.resend.com/emails', {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${RESEND_API_KEY}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            from: fromEmail,
                            to: [userEmail],
                            subject: emailSubject,
                            html: emailHTML
                        })
                    });

                    if (emailResponse.ok) {
                        results.email.success = true;
                        console.log(`✅ Email enviado a ${userEmail}`);
                    } else {
                        const errorData = await emailResponse.json();
                        results.email.error = errorData.message || 'Email send failed';
                        console.error(`❌ Error enviando email:`, errorData);
                    }
                } else {
                    results.email.error = 'Resend API key not configured';
                    console.warn('⚠️ Resend API key no configurada');
                }
            } else {
                // Detallar la razón por la que no se envió email
                let reason = 'Unknown';
                if (userError) {
                    reason = `DB error: ${userError.message || JSON.stringify(userError)}`;
                } else if (!userData) {
                    reason = 'Usuario no encontrado en base de datos';
                } else if (!userData.email) {
                    reason = 'Campo email vacío o nulo';
                } else if (userData.email === '.') {
                    reason = 'Email placeholder "." (no configurado)';
                } else if (userData.email.startsWith('missing_email_')) {
                    reason = `Email placeholder temporal: ${userData.email}`;
                }
                results.email.error = reason;
                console.warn(`⚠️ No se pudo enviar email para usuario ${userId}: ${reason}`);
                if (userData) {
                    console.warn(`   Datos del usuario: email="${userData.email}", username="${userData.username}"`);
                }
            }
        } catch (emailError) {
            results.email.error = emailError.message;
            console.error('❌ Error en email:', emailError.message);
        }

        // Responder con resultados
        const overallSuccess = results.push.success || results.email.success;
        res.json({
            success: overallSuccess,
            message: `Notificación enviada: Push=${results.push.success}, Email=${results.email.success}`,
            results
        });

    } catch (error) {
        console.error('❌ Error general en /send-notification:', error);
        res.status(500).json({ error: error.message, results });
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
        // 🔥 NUEVO: También recibimos submissionId, taskId, fileUri para poder obtener el contenido desde R2/Supabase
        // 🔥 NUEVO: jsonContent para archivos adjuntos del curso, model para especificar modelo LLM
        let { prompt, ollamaUrl, descripcionTarea, taskDescription, fileContent, userId, submissionId, taskId, fileUri, studentId, jsonContent, model } = req.body;

        // ============================================================
        // 🔥 NUEVO: OBTENER CONTENIDO DESDE R2/SUPABASE SI NO VIENE EN EL REQUEST
        // Si fileContent está vacío pero tenemos información de la submission,
        // intentar obtener el contenido directamente desde el servidor
        // ============================================================
        if ((!fileContent || fileContent.trim().length < 50) && supabaseService) {
            console.log('🔍 FileContent vacío o muy corto, intentando obtener desde servidor...');
            
            try {
                let submission = null;
                
                // Estrategia 1: Buscar por submissionId directo
                if (submissionId) {
                    console.log(`📡 Buscando submission por ID: ${submissionId}`);
                    const { data, error } = await supabaseService.client
                        .from('task_submissions')
                        .select('*')
                        .eq('id', submissionId)
                        .single();
                    
                    if (!error && data) {
                        submission = data;
                        console.log(`✅ Submission encontrada: ID=${data.id}, file_uri=${data.file_uri}`);
                    }
                }
                
                // Estrategia 2: Buscar por taskId + studentId
                if (!submission && taskId && studentId) {
                    console.log(`📡 Buscando submission por taskId=${taskId} y studentId=${studentId}`);
                    const { data, error } = await supabaseService.client
                        .from('task_submissions')
                        .select('*')
                        .eq('task_id', taskId)
                        .eq('student_id', studentId)
                        .order('submission_date', { ascending: false })
                        .limit(1)
                        .single();
                    
                    if (!error && data) {
                        submission = data;
                        console.log(`✅ Submission encontrada: ID=${data.id}, file_uri=${data.file_uri}`);
                    }
                }
                
                // Estrategia 3: Buscar por taskId + userId
                if (!submission && taskId && userId) {
                    console.log(`📡 Buscando submission por taskId=${taskId} y userId=${userId}`);
                    const { data, error } = await supabaseService.client
                        .from('task_submissions')
                        .select('*')
                        .eq('task_id', taskId)
                        .eq('student_id', userId)
                        .order('submission_date', { ascending: false })
                        .limit(1)
                        .single();
                    
                    if (!error && data) {
                        submission = data;
                        console.log(`✅ Submission encontrada: ID=${data.id}, file_uri=${data.file_uri}`);
                    }
                }
                
                // Estrategia 4: Buscar ÚLTIMA submission del usuario (fallback si no hay taskId)
                // Esto es útil cuando el usuario pregunta sobre su última tarea enviada
                if (!submission && (userId || studentId)) {
                    const searchUserId = userId || studentId;
                    console.log(`📡 Buscando ÚLTIMA submission del usuario ${searchUserId}...`);
                    const { data, error } = await supabaseService.client
                        .from('task_submissions')
                        .select('*')
                        .eq('student_id', searchUserId)
                        .order('submission_date', { ascending: false })
                        .limit(1)
                        .single();
                    
                    if (!error && data) {
                        submission = data;
                        console.log(`✅ Última submission encontrada: ID=${data.id}, file_uri=${data.file_uri}, taskId=${data.task_id}`);
                    } else {
                        console.log(`⚠️ No se encontró ninguna submission para el usuario ${searchUserId}`);
                    }
                }
                
                // Si encontramos la submission, obtener el contenido del archivo
                if (submission && submission.file_uri) {
                    console.log(`📥 Obteniendo contenido del archivo desde: ${submission.file_uri}`);
                    
                    try {
                        const fileData = await getSubmissionFileContent(
                            submission.file_uri,
                            submission.file_name || 'archivo',
                            submission.id
                        );
                        
                        if (fileData && fileData.content) {
                            fileContent = fileData.content;
                            fileUri = submission.file_uri;
                            submissionId = submission.id;
                            
                            console.log(`✅ Contenido obtenido exitosamente: ${fileContent.length} caracteres`);
                            console.log(`📄 Fuente: ${fileData.source || 'desconocida'}`);
                            console.log(`📋 Primeros 200 chars: ${fileContent.substring(0, 200)}...`);
                        }
                    } catch (fetchError) {
                        console.error(`❌ Error obteniendo contenido del archivo: ${fetchError.message}`);
                    }
                }
            } catch (dbError) {
                console.error(`❌ Error buscando submission en base de datos: ${dbError.message}`);
            }
        }

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
        console.log('🔑 SubmissionId:', submissionId || 'NO PROPORCIONADO');
        console.log('📋 TaskId:', taskId || 'NO PROPORCIONADO');
        console.log('📎 JsonContent:', jsonContent ? 'PRESENTE' : 'NO PROPORCIONADO');
        console.log('🤖 Model:', model || 'NO ESPECIFICADO');

        // ============================================================
        // 🔥 NUEVO: PROCESAR jsonContent PARA ARCHIVOS ADJUNTOS DEL CURSO
        // Si viene jsonContent con archivos del curso, descargarlos y añadir al prompt
        // ============================================================
        let augmentedPrompt = prompt;
        if (jsonContent) {
            try {
                const files = JSON.parse(jsonContent);
                if (Array.isArray(files) && files.length > 0) {
                    console.log(`📂 Procesando ${files.length} archivos adjuntos del curso...`);
                    
                    for (const file of files) {
                        if (file.uri && (file.uri.includes('r2.dev') || file.uri.startsWith('http'))) {
                            console.log(`📥 Descargando contenido de ${file.name}...`);
                            try {
                                const fileData = await getSubmissionFileContent(file.uri, file.name || 'archivo', null);
                                
                                if (fileData && fileData.content) {
                                    // Solo incluir contenido de texto, no binario
                                    if (!fileData.isBase64 && fileData.contentType && fileData.contentType.startsWith('text/')) {
                                        // Limitar tamaño para evitar overflow del contexto
                                        const contentSnippet = fileData.content.substring(0, 8000);
                                        augmentedPrompt += `\n\n--- Contenido del archivo del curso: ${file.name} ---\n${contentSnippet}`;
                                        if (fileData.content.length > 8000) {
                                            augmentedPrompt += `\n...(contenido truncado)...`;
                                        }
                                        console.log(`✅ Contenido de ${file.name} añadido al prompt (${contentSnippet.length} chars)`);
                                    } else {
                                        augmentedPrompt += `\n\n--- Archivo adjunto del curso: ${file.name} (${fileData.contentType || 'tipo desconocido'}) ---`;
                                        console.log(`ℹ️ Archivo ${file.name} es binario o no textual, solo referencia añadida`);
                                    }
                                }
                            } catch (e) {
                                console.warn(`⚠️ Error descargando archivo ${file.name}: ${e.message}`);
                            }
                        }
                    }
                }
            } catch (e) {
                console.warn("⚠️ Error procesando jsonContent:", e.message);
            }
        }

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
            
            // 🔥 NUEVO: Intentar extraer URL de R2 del taskDescription si hay una
            if ((!fileContent || fileContent.trim().length < 50)) {
                const r2UrlMatch = taskDescription.match(/(https?:\/\/[^\s]*\.r2\.dev[^\s]*)/);
                if (r2UrlMatch) {
                    const r2Url = r2UrlMatch[1];
                    console.log(`🔗 URL de R2 detectada en taskDescription: ${r2Url}`);
                    
                    try {
                        const fileData = await getSubmissionFileContent(r2Url, extractedFileName || 'archivo.txt', null);
                        if (fileData && fileData.content) {
                            fileContent = fileData.content;
                            console.log(`✅ Contenido descargado desde URL en taskDescription: ${fileContent.length} caracteres`);
                        }
                    } catch (urlError) {
                        console.log(`⚠️ Error descargando desde URL en taskDescription: ${urlError.message}`);
                    }
                }
            }
        }

        // ============================================================
        // 🔍 VALIDACIÓN DE CONTENIDO VACÍO O SIN CONTENIDO REAL
        // Si la tarea no tiene contenido, automáticamente calificación = 0
        // ============================================================
        const esContenidoVacioPrompt = (content) => {
            if (!content) return true;
            
            // Limpiar espacios, saltos de línea y caracteres especiales
            const contenidoLimpio = content
                .replace(/\s+/g, '')
                .replace(/[\r\n\t]/g, '')
                .replace(/[^\w\u00C0-\u024F]/g, '')
                .trim();
            
            // Verificar si está vacío o tiene muy poco contenido significativo
            if (contenidoLimpio.length < 20) return true;
            
            // Verificar patrones de contenido vacío
            const patronesVacios = [
                /^[\s\n\r\t]*$/,
                /^(null|undefined|none|empty|vacío|vacio)$/i,
                /^\[\s*\]$/,
                /^\{\s*\}$/,
                /^sin\s*contenido/i,
                /^no\s*content/i,
                /^empty\s*file/i,
                /^archivo\s*vac(í|i)o/i
            ];
            
            for (const patron of patronesVacios) {
                if (patron.test(content.trim())) return true;
            }
            
            return false;
        };

        // ============================================================
        // 🔍 FUNCIÓN PARA EXTRAER LA NOTA DEL TEXTO DE RESPUESTA DEL LLM
        // ============================================================
        const extraerNotaDeRespuesta = (respuesta) => {
            if (!respuesta) return 0;
            
            // Patrones para extraer la nota del formato de respuesta del LLM
            const patrones = [
                /📊\s*\*?\*?CALIFICACIÓN(?:\s+ACTUAL)?[:\s]*(\d+(?:\.\d+)?)\s*\/\s*10/i,
                /📊\s*\*?\*?CALIFICACIÓN(?:\s+ACTUAL)?[:\s]*(\d+(?:\.\d+)?)\s*\/\s*100/i,
                /calificación(?:\s+actual)?[:\s]*\*?\*?\s*(\d+(?:\.\d+)?)\s*\/\s*10/i,
                /calificación(?:\s+actual)?[:\s]*\*?\*?\s*(\d+(?:\.\d+)?)\s*\/\s*100/i,
                /nota[:\s]*\*?\*?\s*(\d+(?:\.\d+)?)\s*\/\s*10/i,
                /nota[:\s]*\*?\*?\s*(\d+(?:\.\d+)?)\s*\/\s*100/i,
                /(\d+(?:\.\d+)?)\s*\/\s*10\s*\*?\*?/i,
                /(\d+(?:\.\d+)?)\s*\/\s*100\s*\*?\*?/i
            ];
            
            for (const patron of patrones) {
                const match = respuesta.match(patron);
                if (match) {
                    let nota = parseFloat(match[1]);
                    // Si el patrón es sobre 100, convertir a 10
                    if (patron.source.includes('100')) {
                        nota = Math.round(nota / 10 * 10) / 10; // Redondear a 1 decimal
                    }
                    // Asegurar que está en el rango 0-10
                    nota = Math.max(0, Math.min(10, nota));
                    console.log(`📊 Nota extraída del LLM: ${nota}/10 (patrón: ${patron.source})`);
                    return nota;
                }
            }
            
            console.log('⚠️ No se pudo extraer nota del texto de respuesta del LLM');
            return 0;
        };

        // Si el archivo tiene contenido vacío y se pide calificación, dar 0
        const preguntaLowerVacio = (prompt || '').toLowerCase();
        const esPreguntaCalificacion = /nota|calificaci(ó|o)n|puntaje|evaluaci(ó|o)n|califica|eval(ú|u)a|analiza|revisa/.test(preguntaLowerVacio);
        
        if (esPreguntaCalificacion && esContenidoVacioPrompt(fileContent)) {
            console.log('⚠️ CONTENIDO VACÍO DETECTADO EN /procesar-prompt - Calificación: 0');
            const respuestaVacio = `📊 **CALIFICACIÓN: 0/100**

❌ **RESULTADO:** No aprobado

📋 **Tarea:** ${extractedTaskName || taskDescription || 'Sin nombre'}

⚠️ **MOTIVO DE LA CALIFICACIÓN:**
La entrega está vacía o no contiene contenido que pueda ser evaluado.

El archivo enviado (${extractedFileName || 'sin nombre'}) no tiene contenido significativo para analizar.

💡 **PARA MEJORAR TU CALIFICACIÓN:**
1. Asegúrate de que el archivo contenga tu trabajo completo
2. Verifica que el contenido sea visible y legible
3. Si usaste un formato especial, conviértelo a PDF o TXT
4. Vuelve a subir la tarea con el contenido completo

📝 **Feedback:** Una entrega vacía o sin contenido siempre recibirá calificación de 0. Por favor, sube tu trabajo para poder evaluarlo correctamente.`;

            return res.json({
                respuesta_texto: respuestaVacio,
                nota: 0,
                esCalificacion: true,
                contenidoVacio: true
            });
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
                respuesta_texto: respuestaError,
                nota: 0,
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
                            console.log('⚠️ Análisis de GitHub falló:', analysisResult?.error || 'Error desconocido');

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
            (/nota|calificaci(ó|o)n|puntaje|puntuaci(ó|o)n|evaluaci(ó|o)n|score|grade|calif(í|i)ca(me|la|el)|eval(ú|u)a(me|la|el)/.test(preguntaLower) &&
            !/contenido|que envie|qué envié|archivo|resumen/.test(preguntaLower)) ||
            (
                /(revisa|corrige|ver|dime|cu(á|a)l|qu(é|e))/.test(preguntaLower) &&
                /(nota|calificaci(ó|o)n|puntaje)/.test(preguntaLower)
            );

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
            // ============================================================
            // 🎯 REINFORCEMENT LEARNING QUESTIONS HANDLING
            // Check if this is a reinforcement learning request and apply history logic
            // ============================================================
            const esReinforcementRequest = isReinforcementLearningRequest(prompt);
            const courseId = extractCourseIdFromRequest(req.body);

            if (esReinforcementRequest && courseId && userId) {
                console.log('🎯 PROCESANDO SOLICITUD DE REINFORCEMENT LEARNING...');
                console.log('   - User ID:', userId);
                console.log('   - Course ID:', courseId);

                try {
                    // Get existing question history for this user-course combination
                    const questionHistory = await getReinforcementQuestionHistory(userId, courseId);
                    console.log(`📚 Retrieved ${questionHistory.length} previous questions from history`);

                    // Extract question count from prompt (default to 5)
                    const questionCountMatch = prompt.match(/genera\s+(\d+)/i);
                    const questionCount = questionCountMatch ? parseInt(questionCountMatch[1]) : 5;

                    // Build prompt with history to avoid repetitions
                    let promptCompleto = `INSTRUCCIONES CRÍTICAS PARA GENERAR PREGUNTAS DE REFORZAMIENTO:
- GENERA ${questionCount} PREGUNTAS DE SELECCIÓN MÚLTIPLE (A, B, C, D) PARA REFORZAR CONOCIMIENTOS
- TODAS LAS PREGUNTAS DEBEN SER ÚNICAS Y NO REPETIRSE ENTRE SESIONES
- USA EXCLUSIVAMENTE EL CONTENIDO PROPORCIONADO POR EL DOCENTE (TEMAS, TAREAS Y ARCHIVOS)
- NO INVENTES CONTENIDO NI USES CONOCIMIENTOS GENERALES
- LAS PREGUNTAS DEBEN SER TÉCNICAS Y RELACIONADAS CON PROGRAMACIÓN
- FORMATO JSON ESTRICTO SIN MARKDOWN, SIN TEXTO EXTRA

HISTORIAL DE PREGUNTAS ANTERIORES (NO REPETIR NINGUNA):
${questionHistory.map((q, i) => `${i + 1}. ${q.question || q.pregunta || 'Pregunta sin texto'}`).join('\n')}

CONTEXTO DEL CURSO:
${augmentedPrompt}

FORMATO DE RESPUESTA JSON ESTRICTO:
[
  {
    "question": "¿Pregunta técnica específica del contenido docente?",
    "options": ["Opción A (respuesta correcta)", "Opción B (error común)", "Opción C (alternativa plausible)", "Opción D (incorrecta)"],
    "correctIndex": 0,
    "explanation": "Explicación técnica detallada con referencia específica al código o concepto del material docente."
  }
]`;

                    const tokensPrompt = encode(promptCompleto).length;
                    console.log('[REINFORCEMENT DeepSeek v2.3] TOKENS CONSUMIDOS:', tokensPrompt);

                    // Call DeepSeek for reinforcement questions
                    let respuestaFinal = await callDeepSeek(null, promptCompleto);

                    // Defensive fallback
                    if (!respuestaFinal || !respuestaFinal.trim()) {
                        console.log('⚠️ WARNING: DeepSeek devolvió respuesta VACÍA para reinforcement');
                        respuestaFinal = 'Lo siento, no pude generar preguntas de refuerzo en este momento. Intenta nuevamente.';
                    } else {
                        // Try to parse and save the generated questions
                        try {
                            const cleanJson = respuestaFinal.replace(/```json/g, '').replace(/```/g, '').trim();
                            const generatedQuestions = JSON.parse(cleanJson);

                            if (Array.isArray(generatedQuestions) && generatedQuestions.length > 0) {
                                // Save to history
                                await saveReinforcementQuestionHistory(userId, courseId, generatedQuestions);
                                console.log(`✅ Generated and saved ${generatedQuestions.length} reinforcement questions`);
                            }
                        } catch (parseError) {
                            console.warn('⚠️ Could not parse generated questions for history:', parseError.message);
                        }
                    }

                    // Send response
                    const tokensRespuesta = encode(respuestaFinal).length;
                    console.log('[REINFORCEMENT DeepSeek v2.3] TOKENS DE RESPUESTA:', tokensRespuesta);
                    console.log('📊 RESUMEN TOKENS - TOTAL:', tokensPrompt + tokensRespuesta);

                    console.log('✅ ENVIANDO RESPUESTA DE REINFORCEMENT AL CLIENTE');
                    const endTime = new Date();
                    const duration = endTime - startTime;
                    console.log('🕐 HORA DE RESPUESTA:', endTime.toLocaleString('es-ES'));
                    console.log('⏱️ DURACIÓN TOTAL:', Math.round(duration / 1000), 'segundos');
                    console.log('==============================================');

                    res.setHeader('Content-Type', 'application/json; charset=utf-8');
                    return res.json({ respuesta_texto: respuestaFinal });

                } catch (reinforcementError) {
                    console.error('❌ ERROR EN REINFORCEMENT LEARNING:', reinforcementError.message);
                    // Fall back to regular processing
                    console.log('🔄 Falling back to regular DeepSeek processing...');
                }
            }

            console.log('📊 PROCESANDO PREGUNTA SIMPLE CON DEEPSEEK V2.3...');
            try {
                // Si hay contexto académico disponible, incluirlo para dar mejor respuesta
                let promptCompleto = `INSTRUCCIONES CRÍTICAS:
- EL USUARIO ES UN DOCENTE REVISANDO LA ENTREGA DE UN ESTUDIANTE
- RESPONDE SIEMPRE EN ESPAÑOL
- USA TERMINOLOGÍA EN ESPAÑOL
- NO USES PALABRAS EN INGLÉS SALVO TÉRMINOS TÉCNICOS NECESARIOS
- FORMATO EDUCATIVO Y PROFESIONAL
- RESPUESTA CLARA Y COMPRENSIBLE

PREGUNTA DEL USUARIO: ${prompt}`;

                if (taskDescription && taskDescription.trim() && fileContent && fileContent.trim()) {
                    promptCompleto = `INSTRUCCIONES CRÍTICAS:
- EL USUARIO ES UN DOCENTE REVISANDO LA ENTREGA DE UN ESTUDIANTE
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
                    // 🔥 LÓGICA REFORZADA: Solo persistir nota si es una pregunta explícita de calificación
                    // y la nota es válida. Si es "0/10" por "archivo no disponible", NO PERSISTIR a menos que sea explícito.
                    const isGradingRequestStrict = /nota|calificaci(ó|o)n|puntaje|evaluaci(ó|o)n|score|grade/.test(prompt.toLowerCase()) &&
                                                  !/contenido|que envie|qué envié|archivo|resumen/.test(prompt.toLowerCase());

                    if (isGradingRequestStrict && submissionId) {
                        const gradeMatch = respuestaFinal.match(/(\d+(?:\.\d+)?)\s*\/\s*10|nota\s*[:\-]?\s*(\d+(?:\.\d+)?)/i);
                        const gradeStr = gradeMatch ? (gradeMatch[1] || gradeMatch[2]) : null;
                        const gradeVal = gradeStr ? parseFloat(gradeStr.replace(',', '.')) : null;
                        
                        if (gradeVal !== null) {
                            console.log(`🔁 Persistiendo calificación detectada ${gradeVal} para submissionId=${submissionId} (simple path)`);
                            await updateTaskSubmissionSupabase(submissionId, gradeVal, respuestaFinal);
                        }
                    } else {
                        console.log('ℹ️ No se persiste calificación (no es pregunta de evaluación estricta)');
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
                const tokensPrompt = encode(augmentedPrompt).length;
                console.log('[MODELO DeepSeek v2.3] TOKENS CONSUMIDOS (FALLBACK):', tokensPrompt);
                console.log('[MODELO DeepSeek v2.3] PROMPT ENVIADO (FALLBACK):', augmentedPrompt.substring(0, 300) + '...');

                // Detectar si es una solicitud de preguntas de refuerzo sobre programación
                let systemPrompt = null;
                if (augmentedPrompt.includes('PROGRAMACIÓN') && augmentedPrompt.includes('preguntas de selección múltiple')) {
                    systemPrompt = `Eres un experto educador en programación con amplia experiencia enseñando desarrollo de software.
Tu tarea es generar preguntas técnicas de programación que evalúen conocimientos reales y prácticos.
ENFOCA TUS PREGUNTAS EXCLUSIVAMENTE EN:
TEMAS SOBRE PROGRAMACION Y DESARROLLO 

IMPORTANTE:
- Las preguntas deben ser TÉCNICAS y PRÁCTICAS
- Evita preguntas teóricas abstractas
- Incluye código real en las preguntas y opciones
- Las explicaciones deben ser detalladas y técnicas
- Usa terminología precisa de desarrollo de software`;
                }

                // Call DeepSeek via LLMService
                let respuestaFinal = await callDeepSeek(systemPrompt, augmentedPrompt);

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

⚠️ REGLA CRÍTICA #1: ENTREGAS VACÍAS = NOTA 0 AUTOMÁTICO
- Si el archivo/entrega está VACÍO o no tiene contenido: NOTA 0 INMEDIATO
- Si el contenido es solo espacios en blanco o caracteres sin sentido: NOTA 0 INMEDIATO
- Si no hay código/texto/trabajo significativo: NOTA 0 INMEDIATO
- Si el archivo solo contiene placeholders como "null", "empty", "vacío", "test": NOTA 0 INMEDIATO
- Si la longitud del contenido real es menor a 50 caracteres: NOTA 0 INMEDIATO

PRINCIPIO FUNDAMENTAL: 
SER JUSTO - Si se pide "UN EJEMPLO" de algo, CUALQUIER ejemplo válido de esa categoría merece nota alta.
PERO: Un archivo VACÍO o sin trabajo SIEMPRE es NOTA 0, sin excepciones.

CRITERIOS DE EVALUACIÓN INTELIGENTES:
⚫ **SIN CONTENIDO (0)**: Archivo vacío o sin trabajo real
🟢 **CUMPLIMIENTO PERFECTO (9-10)**: Entrega exactamente lo pedido
🟢 **CUMPLIMIENTO BUENO (7-8)**: Cumple bien, aunque sea más complejo
🟡 **CUMPLIMIENTO PARCIAL (5-6)**: Relacionado pero no exacto
🟠 **CUMPLIMIENTO MÍNIMO (3-4)**: Alguna relación pero se desvía
🔴 **NO CUMPLE (1-2)**: Poca o ninguna relación
⚫ **TOTALMENTE INCORRECTO (0)**: Sin relación alguna O archivo vacío

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
⚫ ARCHIVO VACÍO o sin contenido = 0/10 (SIEMPRE)
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

EVALÚA DE MANERA JUSTA Y EDUCATIVA. ASEGÚRATE DE INCLUIR LA LÍNEA "📊 **CALIFICACIÓN ACTUAL: X/10**" AL INICIO.
IMPORTANTE: Si el contenido entregado está vacío o no tiene trabajo real, la calificación DEBE ser 0/10.`;

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

                // Extraer nota del texto de respuesta del LLM
                const notaExtraida = extraerNotaDeRespuesta(respuestaEvaluacion);
                console.log(`📊 NOTA EXTRAÍDA DE EVALUACIÓN CRÍTICA: ${notaExtraida}/10`);
                
                // Persistir la nota en Supabase si hay submissionId
                if (submissionId) {
                    try {
                        console.log(`🔁 Intentando persistir nota ${notaExtraida} para submissionId=${submissionId} en Supabase`);
                        const ok = await updateTaskSubmissionSupabase(submissionId, notaExtraida, respuestaEvaluacion);
                        if (!ok) console.log('⚠️ Persistencia en Supabase fallida o no confirmada');
                    } catch (err) {
                        console.log('❌ Error al persistir nota en Supabase:', err.message);
                    }
                }

                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                return res.json({ 
                    respuesta_texto: respuestaEvaluacion,
                    nota: notaExtraida,
                    esCalificacion: true
                });

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

            // Extraer nota del texto de respuesta del LLM
            const notaExtraida = extraerNotaDeRespuesta(respuestaFinal);
            console.log(`📊 NOTA EXTRAÍDA DE RESPUESTA FINAL: ${notaExtraida}/10`);
            
            // Persistir la nota en Supabase si hay submissionId
            if (submissionId) {
                try {
                    console.log(`🔁 Intentando persistir nota ${notaExtraida} para submissionId=${submissionId} en Supabase`);
                    const ok = await updateTaskSubmissionSupabase(submissionId, notaExtraida, respuestaFinal);
                    if (!ok) console.log('⚠️ Persistencia en Supabase fallida o no confirmada');
                } catch (err) {
                    console.log('❌ Error al persistir nota en Supabase:', err.message);
                }
            }

            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            return res.json({ 
                respuesta_texto: respuestaFinal,
                nota: notaExtraida,
                esCalificacion: true
            });
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

// Store active SSE connections for MCP
const mcpSseConnections = new Map();

/**
 * 🔌 MCP SSE Endpoint - Server-Sent Events for VS Code MCP clients
 * This allows VS Code from ANY machine to connect to this MCP server
 * 
 * GET /mcp/sse - Establishes SSE connection
 * POST /mcp/message - Send messages to the server
 * 
 * FIXED: Correct SSE format for MCP protocol compliance
 * - Uses proper event format with data-only messages for JSON-RPC responses
 * - Sends endpoint URL immediately upon connection
 */
app.get('/mcp/sse', (req, res) => {
    console.log('🔌 MCP SSE Connection request received');

    // Set SSE headers with additional keep-alive settings
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx/proxy buffering
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    
    // Disable request timeout for SSE connections
    res.setTimeout(0);
    req.setTimeout(0);
    
    if (req.socket) {
        req.socket.setTimeout(0);
        req.socket.setNoDelay(true);
        req.socket.setKeepAlive(true, 5000); // Keep-alive every 5 seconds
    }
    
    // Flush headers immediately
    res.flushHeaders();

    // Generate unique session ID
    const sessionId = `mcp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    // Store connection with metadata
    mcpSseConnections.set(sessionId, {
        response: res,
        createdAt: Date.now(),
        lastActivity: Date.now()
    });

    // CRITICAL: Send endpoint info to client using the correct MCP SSE format
    // VS Code expects: event: endpoint\ndata: <URL>\n\n
    const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN 
        ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
        : 'https://mcp-backenddeploy-production.up.railway.app';
    const endpointUrl = `${baseUrl}/mcp/message?sessionId=${sessionId}`;
    
    // Send the endpoint event - this tells VS Code where to POST messages
    res.write(`event: endpoint\ndata: ${endpointUrl}\n\n`);

    console.log(`📡 MCP SSE Session established: ${sessionId}`);
    console.log(`   Endpoint URL: ${endpointUrl}`);

    // Send ping every 15 seconds to keep connection alive (Railway has ~5 min timeout)
    const pingInterval = setInterval(() => {
        try {
            const conn = mcpSseConnections.get(sessionId);
            if (conn && !res.writableEnded && res.writable) {
                // SSE comment for keep-alive (starts with colon)
                res.write(`: keep-alive ${Date.now()}\n\n`);
                conn.lastActivity = Date.now();
            } else {
                console.log(`🔌 SSE Connection no longer writable: ${sessionId}`);
                clearInterval(pingInterval);
                mcpSseConnections.delete(sessionId);
            }
        } catch (err) {
            console.error(`❌ Ping error for ${sessionId}:`, err.message);
            clearInterval(pingInterval);
            mcpSseConnections.delete(sessionId);
        }
    }, 15000);

    // Handle connection errors
    res.on('error', (err) => {
        console.error(`❌ SSE Response error (${sessionId}): ${err.message}`);
        clearInterval(pingInterval);
        mcpSseConnections.delete(sessionId);
    });

    req.on('error', (err) => {
        console.error(`❌ SSE Request error (${sessionId}): ${err.message}`);
        clearInterval(pingInterval);
        mcpSseConnections.delete(sessionId);
    });

    res.on('close', () => {
        console.log(`🔌 SSE Response closed: ${sessionId}`);
        clearInterval(pingInterval);
        mcpSseConnections.delete(sessionId);
    });

    // Cleanup on request close
    req.on('close', () => {
        console.log(`🔌 MCP SSE Connection closed: ${sessionId}`);
        clearInterval(pingInterval);
        mcpSseConnections.delete(sessionId);
    });
});

/**
 * 🔌 MCP Message Endpoint - Receives JSON-RPC messages from VS Code
 * POST /mcp/message?sessionId=xxx
 * 
 * FIXED: MCP SSE protocol requires:
 * - HTTP response: 202 Accepted (or 200 for notifications)
 * - JSON-RPC response: sent via SSE stream ONLY
 */
app.post('/mcp/message', async(req, res) => {
    const { sessionId } = req.query;
    const { method, params, id } = req.body;

    console.log(`🔌 MCP Message: ${method} (session: ${sessionId}, id: ${id})`);

    // Get SSE connection object (contains response and metadata)
    const sseConn = mcpSseConnections.get(sessionId);
    const sseResponse = sseConn?.response;
    
    // Verify session exists
    if (!sseConn || !sseResponse) {
        console.error(`❌ SSE session not found: ${sessionId}`);
        return res.status(400).json({ 
            jsonrpc: '2.0', 
            id, 
            error: { code: -32000, message: `Session not found: ${sessionId}. Please reconnect.` } 
        });
    }
    
    // Verify SSE connection is still open
    if (sseResponse.writableEnded || !sseResponse.writable) {
        console.error(`❌ SSE connection closed for session: ${sessionId}`);
        mcpSseConnections.delete(sessionId);
        return res.status(400).json({ 
            jsonrpc: '2.0', 
            id, 
            error: { code: -32000, message: 'SSE connection closed. Please reconnect.' } 
        });
    }
    
    // Update last activity timestamp
    sseConn.lastActivity = Date.now();

    // For notifications (no id), just acknowledge
    if (id === undefined || id === null) {
        if (method === 'notifications/initialized' || method === 'initialized') {
            console.log(`📨 MCP Initialized notification received`);
        }
        return res.status(200).send('');
    }

    try {
        let result;

        switch (method) {
            case 'initialize':
                // Test Supabase connection
                try {
                    await supabaseService.testConnection();
                    console.log('✅ Supabase connection verified for MCP session');
                } catch (dbErr) {
                    console.error('❌ Supabase connection failed:', dbErr.message);
                    // Continue anyway - some tools may still work
                }
                result = {
                    protocolVersion: '2024-11-05',
                    capabilities: {
                        tools: { listChanged: true },
                        resources: { subscribe: true, listChanged: true }
                    },
                    serverInfo: {
                        name: 'tareamov-mcp-server',
                        version: '1.0.0',
                        description: 'MCP Server for TareaMov - Course Management Platform'
                    }
                };
                break;

            case 'notifications/initialized':
            case 'initialized':
                result = {};
                break;

            case 'tools/list':
                result = {
                    tools: [
                        {
                            name: 'query_database',
                            description: 'Execute queries on TareaMov Supabase database. Returns real-time data.',
                            inputSchema: {
                                type: 'object',
                                properties: { query: { type: 'string', description: 'SQL or natural language query' } },
                                required: ['query']
                            }
                        },
                        {
                            name: 'get_database_schema',
                            description: 'Get the complete database schema with all tables and columns',
                            inputSchema: { type: 'object', properties: {}, required: [] }
                        },
                        {
                            name: 'get_user_info',
                            description: 'Get detailed information about a specific user',
                            inputSchema: {
                                type: 'object',
                                properties: {
                                    userId: { type: 'number', description: 'User ID' },
                                    username: { type: 'string', description: 'Username' }
                                }
                            }
                        },
                        {
                            name: 'get_course_info',
                            description: 'Get detailed information about a course including videos and tasks',
                            inputSchema: {
                                type: 'object',
                                properties: { courseId: { type: 'number', description: 'Course ID' } },
                                required: ['courseId']
                            }
                        },
                        {
                            name: 'get_task_submissions',
                            description: 'Get all submissions for a specific task',
                            inputSchema: {
                                type: 'object',
                                properties: { taskId: { type: 'number', description: 'Task ID' } },
                                required: ['taskId']
                            }
                        },
                        {
                            name: 'send_notification',
                            description: 'Send push notification and email to a user',
                            inputSchema: {
                                type: 'object',
                                properties: {
                                    userId: { type: 'number', description: 'Target user ID' },
                                    title: { type: 'string', description: 'Notification title' },
                                    message: { type: 'string', description: 'Notification message' },
                                    type: { type: 'string', description: 'Notification type' }
                                },
                                required: ['userId', 'title', 'message']
                            }
                        }
                    ]
                };
                break;

            case 'tools/call':
                const toolName = params?.name;
                const toolArgs = params?.arguments || {};
                console.log(`🔧 Tool call: ${toolName}`, JSON.stringify(toolArgs).substring(0, 100));
                result = await handleMCPToolCall(toolName, toolArgs);
                break;

            case 'resources/list':
                result = {
                    resources: [
                        { uri: 'tareamov://database/schema', name: 'Database Schema', mimeType: 'application/json' },
                        { uri: 'tareamov://database/stats', name: 'Database Statistics', mimeType: 'application/json' }
                    ]
                };
                break;

            case 'resources/read':
                result = await handleMCPResourceRead(params?.uri);
                break;

            default:
                if (method.startsWith('notifications/')) {
                    return res.status(200).send('');
                }
                // Send error via SSE
                const notFoundError = { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
                sseResponse.write(`event: message\ndata: ${JSON.stringify(notFoundError)}\n\n`);
                return res.status(202).send('Accepted');
        }

        // Build JSON-RPC response
        const response = { jsonrpc: '2.0', id, result };
        
        // Send response via SSE stream (this is the MCP protocol requirement)
        sseResponse.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
        console.log(`✅ MCP Response sent via SSE for: ${method}`);
        
        // Return 202 Accepted to acknowledge receipt
        res.status(202).send('Accepted');

    } catch (error) {
        console.error(`❌ MCP Error (${method}):`, error);
        const errorResponse = { jsonrpc: '2.0', id, error: { code: -32603, message: error.message } };
        
        // Send error via SSE
        try {
            sseResponse.write(`event: message\ndata: ${JSON.stringify(errorResponse)}\n\n`);
        } catch (sseErr) {
            console.error(`❌ Could not write error to SSE: ${sseErr.message}`);
        }
        
        res.status(202).send('Accepted');
    }
});

/**
 * � MCP Unified Endpoint - Handles all MCP protocol requests
 * This endpoint allows VS Code from ANY machine to connect to this MCP server
 * Supports: initialize, tools/list, tools/call, resources/list, resources/read
 * 
 * URL: POST /mcp
 * Body: { jsonrpc: "2.0", method: "...", params: {...}, id: 1 }
 */
app.post('/mcp', async(req, res) => {
    const { method, params, id } = req.body;
    console.log(`🔌 MCP Request: ${method}`);

    try {
        let result;

        switch (method) {
            case 'initialize':
                await supabaseService.testConnection();
                result = {
                    protocolVersion: '2024-11-05',
                    capabilities: {
                        tools: { listChanged: true },
                        resources: { subscribe: true, listChanged: true }
                    },
                    serverInfo: {
                        name: 'tareamov-mcp-server',
                        version: '1.0.0',
                        description: 'MCP Server for TareaMov - Course Management Platform'
                    }
                };
                break;

            case 'tools/list':
                result = {
                    tools: [
                        {
                            name: 'query_database',
                            description: 'Execute queries on TareaMov Supabase database. Returns real-time data from usuarios, courses, videos, tasks, subscriptions, etc.',
                            inputSchema: {
                                type: 'object',
                                properties: {
                                    query: {
                                        type: 'string',
                                        description: 'SQL query or natural language query to execute'
                                    }
                                },
                                required: ['query']
                            }
                        },
                        {
                            name: 'get_database_schema',
                            description: 'Get the complete database schema with all tables and columns',
                            inputSchema: {
                                type: 'object',
                                properties: {},
                                required: []
                            }
                        },
                        {
                            name: 'get_user_info',
                            description: 'Get detailed information about a specific user',
                            inputSchema: {
                                type: 'object',
                                properties: {
                                    userId: { type: 'number', description: 'User ID' },
                                    username: { type: 'string', description: 'Username' }
                                }
                            }
                        },
                        {
                            name: 'get_course_info',
                            description: 'Get detailed information about a course including videos and tasks',
                            inputSchema: {
                                type: 'object',
                                properties: {
                                    courseId: { type: 'number', description: 'Course ID' }
                                },
                                required: ['courseId']
                            }
                        },
                        {
                            name: 'get_task_submissions',
                            description: 'Get all submissions for a specific task',
                            inputSchema: {
                                type: 'object',
                                properties: {
                                    taskId: { type: 'number', description: 'Task ID' }
                                },
                                required: ['taskId']
                            }
                        },
                        {
                            name: 'send_notification',
                            description: 'Send push notification and email to a user',
                            inputSchema: {
                                type: 'object',
                                properties: {
                                    userId: { type: 'number', description: 'Target user ID' },
                                    title: { type: 'string', description: 'Notification title' },
                                    message: { type: 'string', description: 'Notification message' },
                                    type: { type: 'string', description: 'Notification type (new_course, new_video, task_graded, etc.)' }
                                },
                                required: ['userId', 'title', 'message']
                            }
                        },
                        {
                            name: 'analyze_repository',
                            description: 'Analyze a GitHub repository submitted as a task',
                            inputSchema: {
                                type: 'object',
                                properties: {
                                    repoUrl: { type: 'string', description: 'GitHub repository URL' },
                                    taskDescription: { type: 'string', description: 'Task description for context' }
                                },
                                required: ['repoUrl']
                            }
                        }
                    ]
                };
                break;

            case 'tools/call':
                const toolName = params?.name;
                const toolArgs = params?.arguments || {};
                result = await handleMCPToolCall(toolName, toolArgs);
                break;

            case 'resources/list':
                result = {
                    resources: [
                        {
                            uri: 'tareamov://database/schema',
                            name: 'Database Schema',
                            description: 'Complete TareaMov database schema',
                            mimeType: 'application/json'
                        },
                        {
                            uri: 'tareamov://database/stats',
                            name: 'Database Statistics',
                            description: 'Current database statistics (users, courses, tasks, etc.)',
                            mimeType: 'application/json'
                        }
                    ]
                };
                break;

            case 'resources/read':
                const resourceUri = params?.uri;
                result = await handleMCPResourceRead(resourceUri);
                break;

            case 'notifications/initialized':
            case 'initialized':
                result = {};
                break;

            default:
                return res.json({
                    jsonrpc: '2.0',
                    id,
                    error: {
                        code: -32601,
                        message: `Method not found: ${method}`
                    }
                });
        }

        res.json({
            jsonrpc: '2.0',
            id,
            result
        });

    } catch (error) {
        console.error(`❌ MCP Error (${method}):`, error);
        res.json({
            jsonrpc: '2.0',
            id,
            error: {
                code: -32603,
                message: error.message
            }
        });
    }
});

/**
 * Handle MCP tool calls
 */
async function handleMCPToolCall(toolName, args) {
    console.log(`🔧 MCP Tool Call: ${toolName}`, args);

    switch (toolName) {
        case 'query_database':
            return await executeDatabaseQuery(args.query);

        case 'get_database_schema':
            return await getDatabaseSchema();

        case 'get_user_info':
            return await getUserInfo(args.userId, args.username);

        case 'get_course_info':
            return await getCourseInfo(args.courseId);

        case 'get_task_submissions':
            return await getTaskSubmissions(args.taskId);

        case 'send_notification':
            return await sendMCPNotification(args);

        case 'analyze_repository':
            if (mcpService) {
                const analysis = await mcpService.analyzeRepository(args.repoUrl, args.taskDescription || '');
                return { content: [{ type: 'text', text: JSON.stringify(analysis, null, 2) }] };
            }
            return { content: [{ type: 'text', text: 'GitHub analysis not available' }] };

        default:
            throw new Error(`Unknown tool: ${toolName}`);
    }
}

/**
 * Handle MCP resource reads
 */
async function handleMCPResourceRead(uri) {
    console.log(`📖 MCP Resource Read: ${uri}`);

    if (uri === 'tareamov://database/schema') {
        const schema = await getDatabaseSchema();
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(schema, null, 2) }] };
    }

    if (uri === 'tareamov://database/stats') {
        const stats = await getDatabaseStats();
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(stats, null, 2) }] };
    }

    throw new Error(`Unknown resource: ${uri}`);
}

/**
 * Execute database query (SQL or natural language)
 */
async function executeDatabaseQuery(query) {
    try {
        // Detect if it's natural language or SQL
        const isSQL = /^(SELECT|INSERT|UPDATE|DELETE|WITH)\s/i.test(query.trim());
        
        let sqlQuery = query;
        if (!isSQL) {
            // Convert natural language to SQL using simple patterns
            sqlQuery = convertNaturalLanguageToSQL(query);
        }

        // Execute via Supabase RPC or direct query
        const { data, error } = await supabaseService.client.rpc('execute_sql', { query: sqlQuery });
        
        if (error) {
            // Fallback: try direct table query for simple cases
            const tableMatch = sqlQuery.match(/FROM\s+(\w+)/i);
            if (tableMatch) {
                const tableName = tableMatch[1];
                const { data: tableData, error: tableError } = await supabaseService.client
                    .from(tableName)
                    .select('*')
                    .limit(100);
                
                if (!tableError) {
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({ query: sqlQuery, results: tableData, count: tableData.length }, null, 2)
                        }]
                    };
                }
            }
            throw error;
        }

        return {
            content: [{
                type: 'text',
                text: JSON.stringify({ query: sqlQuery, results: data }, null, 2)
            }]
        };
    } catch (error) {
        return {
            content: [{
                type: 'text',
                text: `Error executing query: ${error.message}`
            }],
            isError: true
        };
    }
}

/**
 * Convert natural language query to SQL
 */
function convertNaturalLanguageToSQL(query) {
    const lowerQuery = query.toLowerCase();

    // Users queries
    if (lowerQuery.includes('usuario') || lowerQuery.includes('user')) {
        if (lowerQuery.includes('todos') || lowerQuery.includes('all')) {
            return 'SELECT id, usuario, email, created_at FROM usuarios ORDER BY created_at DESC LIMIT 100';
        }
        if (lowerQuery.includes('contar') || lowerQuery.includes('count') || lowerQuery.includes('cuantos')) {
            return 'SELECT COUNT(*) as total FROM usuarios';
        }
    }

    // Courses queries
    if (lowerQuery.includes('curso') || lowerQuery.includes('course')) {
        if (lowerQuery.includes('todos') || lowerQuery.includes('all')) {
            return 'SELECT id, name, description, creator_user_id, created_at FROM courses ORDER BY created_at DESC LIMIT 100';
        }
        if (lowerQuery.includes('contar') || lowerQuery.includes('count') || lowerQuery.includes('cuantos')) {
            return 'SELECT COUNT(*) as total FROM courses';
        }
    }

    // Tasks queries
    if (lowerQuery.includes('tarea') || lowerQuery.includes('task')) {
        if (lowerQuery.includes('todos') || lowerQuery.includes('all')) {
            return 'SELECT id, name, description, course_id, due_date FROM tasks ORDER BY created_at DESC LIMIT 100';
        }
    }

    // Submissions queries
    if (lowerQuery.includes('entrega') || lowerQuery.includes('submission')) {
        return 'SELECT id, task_id, student_username, grade, created_at FROM task_submissions ORDER BY created_at DESC LIMIT 100';
    }

    // Default: return as-is (might be SQL already)
    return query;
}

/**
 * Get database schema
 */
async function getDatabaseSchema() {
    const tables = [
        'usuarios', 'personas', 'courses', 'videos', 'topics', 'content_items',
        'tasks', 'task_submissions', 'subscriptions', 'chat_messages',
        'file_contexts', 'roles', 'recursos', 'rol_recursos', 'notifications'
    ];

    const schema = {};
    for (const table of tables) {
        try {
            const { data } = await supabaseService.client.from(table).select('*').limit(1);
            if (data && data.length > 0) {
                schema[table] = Object.keys(data[0]);
            } else {
                schema[table] = ['(empty table)'];
            }
        } catch (e) {
            schema[table] = ['(error reading table)'];
        }
    }

    return { content: [{ type: 'text', text: JSON.stringify(schema, null, 2) }] };
}

/**
 * Get database statistics
 */
async function getDatabaseStats() {
    const stats = {};
    const tables = ['usuarios', 'courses', 'videos', 'tasks', 'task_submissions', 'subscriptions', 'notifications'];

    for (const table of tables) {
        try {
            const { count } = await supabaseService.client.from(table).select('*', { count: 'exact', head: true });
            stats[table] = count || 0;
        } catch (e) {
            stats[table] = 'error';
        }
    }

    return stats;
}

/**
 * Get user information
 */
async function getUserInfo(userId, username) {
    try {
        let query = supabaseService.client.from('usuarios').select('*');
        
        if (userId) {
            query = query.eq('id', userId);
        } else if (username) {
            query = query.eq('usuario', username);
        } else {
            return { content: [{ type: 'text', text: 'Please provide userId or username' }] };
        }

        const { data, error } = await query.single();
        if (error) throw error;

        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
        return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
}

/**
 * Get course information
 */
async function getCourseInfo(courseId) {
    try {
        const { data: course, error } = await supabaseService.client
            .from('courses')
            .select('*, videos(*), tasks(*)')
            .eq('id', courseId)
            .single();

        if (error) throw error;

        return { content: [{ type: 'text', text: JSON.stringify(course, null, 2) }] };
    } catch (error) {
        return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
}

/**
 * Get task submissions
 */
async function getTaskSubmissions(taskId) {
    try {
        const { data, error } = await supabaseService.client
            .from('task_submissions')
            .select('*')
            .eq('task_id', taskId)
            .order('created_at', { ascending: false });

        if (error) throw error;

        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
        return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
}

/**
 * Send notification via MCP
 */
async function sendMCPNotification(args) {
    const { userId, title, message, type = 'generic' } = args;

    try {
        // Call the existing send-notification logic
        const response = await fetch(`http://localhost:${PORT}/send-notification`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId, title, message, type })
        });

        const result = await response.json();
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
        return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
}

/**
 * 🔍 DETAILED Health check endpoint for monitoring services
 * This checks all dependencies (DB, LLM, etc.)
 * Use /health for simple healthchecks (defined at top of file)
 */
app.get('/health/detailed', async(req, res) => {
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
            server: 'coursev-mcp-server',
            version: '1.0.0',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
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
                },
                {
                    name: 'get_submission_file',
                    description: `Retrieve the content of a file submitted by a student for a task. 
This tool downloads and reads files stored in Cloudflare R2 cloud storage.

**USE CASES:**
- Read the content of a student's submission file to analyze or grade it
- Extract code, text, or data from submitted files (PDF, DOCX, TXT, SQL, Python, Java, etc.)
- Verify what a student submitted for a specific task

**SUPPORTED FILE TYPES:**
- Text files: .txt, .sql, .py, .js, .java, .kt, .html, .css, .json, .xml, .md, .csv
- Documents: .pdf, .docx (returns base64 for binary files)
- Code files: All common programming languages

**HOW TO USE:**
1. First query the task_submissions table to get submissionId, fileUri, and fileName
2. Then call this tool with that information to get the file content`,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            submissionId: {
                                type: 'number',
                                description: 'The ID of the submission (from task_submissions table)'
                            },
                            fileUri: {
                                type: 'string',
                                description: 'The file URI/URL from the submission (fileUri field from task_submissions)'
                            },
                            fileName: {
                                type: 'string',
                                description: 'The name of the file (fileName field from task_submissions)'
                            }
                        },
                        required: ['submissionId']
                    }
                },
                {
                    name: 'list_submission_files',
                    description: `List all files in a submission folder in Cloudflare R2.
Useful to see what files are available for a specific task.`,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            taskId: {
                                type: 'number',
                                description: 'The task ID to list submissions for'
                            },
                            prefix: {
                                type: 'string',
                                description: 'Optional custom prefix/folder path in R2'
                            }
                        },
                        required: []
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
    console.log('🔧 Tool call request:', params?.name);

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
                    // 🔥 CRITICAL MODIFICATION: Enforce "Only Grade If Requested" logic
                    // Check if the query explicitly asks for grading/evaluation
                    const lowerQuery = args.query.toLowerCase();
                    const isGradingRequest = lowerQuery.includes('calific') || 
                                            lowerQuery.includes('nota') || 
                                            lowerQuery.includes('evalu') || 
                                            lowerQuery.includes('puntaje') ||
                                            lowerQuery.includes('grade') ||
                                            lowerQuery.includes('score') ||
                                            lowerQuery.includes('rate');
                    
                    let modifiedQuery = args.query;
                    if (!isGradingRequest) {
                        modifiedQuery = `SYSTEM INSTRUCTION: The user is asking a general question. Do NOT provide a grade (1-10) or formal evaluation. Answer helpfully based on context. USER QUERY: ${args.query}`;
                        console.log('🛡️ Q&A Mode enforced (No grading)');
                    } else {
                        console.log('📝 Grading Mode enabled');
                    }

                    const agentResponse = await mcpService.processQueryWithAgent(modifiedQuery);
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
                // 🔥 CRITICAL MODIFICATION: Enforce "Only Grade If Requested" logic for Repo Analysis
                // If the user didn't provide specific criteria, inject the "No Grade" instruction by default
                // unless the task description itself asks for it.
                let modifiedTaskDesc = args.taskDescription || '';
                
                // Simple heuristic: if task description doesn't explicitly mention grading terms, add safety instruction
                const lowerDesc = modifiedTaskDesc.toLowerCase();
                const isExplicitGrading = lowerDesc.includes('calific') || lowerDesc.includes('grade') || lowerDesc.includes('rubric');
                
                if (!isExplicitGrading) {
                    modifiedTaskDesc += "\n\nSYSTEM INSTRUCTION: Unless the user explicitly asks for a grade/score in their request, provide a qualitative analysis only. Do not assign a numerical score (1-10) if not requested.";
                    console.log('🛡️ Repo Analysis: Qualitative mode hint added');
                }

                const result = await mcpService.analyzeGitHubRepo(args.repoUrl, {
                    taskDescription: modifiedTaskDesc,
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
        } else if (name === 'get_submission_file') {
            console.log('📄 Getting submission file:', args.submissionId);

            try {
                let fileUri = args.fileUri;
                let fileName = args.fileName;
                const submissionId = args.submissionId;

                // Si no se proporcionan fileUri o fileName, buscar en la base de datos
                if (!fileUri || !fileName) {
                    console.log('🔍 Fetching submission details from database...');
                    const { data: submission, error } = await supabaseService.client
                        .from('task_submissions')
                        .select('file_uri, file_name, task_id, student_id')
                        .eq('id', submissionId)
                        .single();

                    if (error || !submission) {
                        throw new Error(`Submission ${submissionId} not found: ${error?.message || 'No data'}`);
                    }

                    fileUri = submission.file_uri;
                    fileName = submission.file_name;
                    console.log(`📋 Found submission: ${fileName} -> ${fileUri}`);
                }

                // Obtener el contenido del archivo (pasando submissionId para buscar en file_contexts)
                const fileData = await getSubmissionFileContent(fileUri, fileName, submissionId);

                // Preparar respuesta con metadata
                const response = {
                    success: true,
                    submissionId: submissionId,
                    fileName: fileName,
                    fileType: fileData.fileType,
                    contentType: fileData.contentType,
                    size: fileData.size,
                    isBase64: fileData.isBase64,
                    source: fileData.source || 'unknown',
                    content: fileData.isBase64 
                        ? `[Base64 content - ${fileData.size} bytes. Use appropriate decoder for ${fileData.fileType} files]`
                        : fileData.content,
                    // Si es texto, incluir el contenido completo
                    ...(fileData.isBase64 ? {} : { fullContent: fileData.content }),
                    // Incluir metadata adicional si está disponible
                    ...(fileData.metadata ? { metadata: fileData.metadata } : {}),
                    ...(fileData.summary ? { summary: fileData.summary } : {})
                };

                // Si es un archivo de texto, incluir análisis básico
                if (!fileData.isBase64 && fileData.content) {
                    response.analysis = {
                        lineCount: fileData.content.split('\n').length,
                        charCount: fileData.content.length,
                        preview: fileData.content.substring(0, 500) + (fileData.content.length > 500 ? '...' : '')
                    };
                }

                res.json({
                    jsonrpc: '2.0',
                    id: req.body.id,
                    result: {
                        content: [{
                            type: 'text',
                            text: JSON.stringify(response, null, 2)
                        }]
                    }
                });
            } catch (fileError) {
                console.error('❌ Get submission file error:', fileError);
                res.json({
                    jsonrpc: '2.0',
                    id: req.body.id,
                    result: {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                error: true,
                                message: `Error obteniendo archivo: ${fileError.message}`,
                                hint: 'Verifica que el submissionId existe y el archivo está disponible en R2'
                            }, null, 2)
                        }]
                    }
                });
            }
        } else if (name === 'list_submission_files') {
            console.log('📂 Listing submission files');

            try {
                let prefix = args.prefix;
                
                // Si se proporciona taskId, construir el prefijo
                if (args.taskId) {
                    prefix = `submissions/task_${args.taskId}/`;
                } else if (!prefix) {
                    prefix = 'submissions/';
                }

                if (!r2Client) {
                    throw new Error('Cloudflare R2 not configured on server');
                }

                const files = await listR2Files(prefix);

                res.json({
                    jsonrpc: '2.0',
                    id: req.body.id,
                    result: {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                success: true,
                                prefix: prefix,
                                fileCount: files.length,
                                files: files.map(f => ({
                                    name: f.key.split('/').pop(),
                                    path: f.key,
                                    size: f.size,
                                    url: f.url,
                                    lastModified: f.lastModified
                                }))
                            }, null, 2)
                        }]
                    }
                });
            } catch (listError) {
                console.error('❌ List files error:', listError);
                res.json({
                    jsonrpc: '2.0',
                    id: req.body.id,
                    result: {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                error: true,
                                message: `Error listando archivos: ${listError.message}`
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

// ============================================================
// 📥 ENDPOINT PARA OBTENER CONTENIDO DE UNA SUBMISSION
// Permite al cliente Android obtener el contenido de un archivo
// enviado como tarea, directamente desde R2/Supabase
// ============================================================
app.post('/obtener-contenido-submission', async(req, res) => {
    console.log('📥 Solicitud de contenido de submission recibida');
    
    try {
        const { submissionId, taskId, studentId, fileUri } = req.body;
        
        console.log(`   submissionId: ${submissionId}`);
        console.log(`   taskId: ${taskId}`);
        console.log(`   studentId: ${studentId}`);
        console.log(`   fileUri: ${fileUri}`);
        
        if (!supabaseService) {
            return res.status(500).json({
                error: 'Supabase no está configurado',
                success: false
            });
        }
        
        let submission = null;
        
        // Estrategia 1: Buscar por submissionId
        if (submissionId) {
            const { data, error } = await supabaseService.client
                .from('task_submissions')
                .select('*')
                .eq('id', submissionId)
                .single();
            
            if (!error && data) {
                submission = data;
            }
        }
        
        // Estrategia 2: Buscar por taskId + studentId
        if (!submission && taskId && studentId) {
            const { data, error } = await supabaseService.client
                .from('task_submissions')
                .select('*')
                .eq('task_id', taskId)
                .eq('student_id', studentId)
                .order('submission_date', { ascending: false })
                .limit(1)
                .single();
            
            if (!error && data) {
                submission = data;
            }
        }
        
        if (!submission) {
            return res.status(404).json({
                error: 'Submission no encontrada',
                success: false
            });
        }
        
        console.log(`✅ Submission encontrada: ID=${submission.id}, file_uri=${submission.file_uri}`);
        
        // Obtener el contenido del archivo
        try {
            const fileData = await getSubmissionFileContent(
                submission.file_uri,
                submission.file_name || 'archivo',
                submission.id
            );
            
            if (fileData && fileData.content) {
                console.log(`✅ Contenido obtenido: ${fileData.content.length} caracteres`);
                
                return res.json({
                    success: true,
                    submissionId: submission.id,
                    taskId: submission.task_id,
                    studentId: submission.student_id,
                    fileName: submission.file_name,
                    fileUri: submission.file_uri,
                    submissionDate: submission.submission_date,
                    grade: submission.grade,
                    feedback: submission.feedback,
                    content: fileData.content,
                    contentType: fileData.contentType,
                    fileType: fileData.fileType,
                    source: fileData.source,
                    metadata: fileData.metadata,
                    summary: fileData.summary
                });
            } else {
                return res.status(404).json({
                    error: 'No se pudo obtener el contenido del archivo',
                    success: false,
                    submission: {
                        id: submission.id,
                        fileName: submission.file_name,
                        fileUri: submission.file_uri
                    }
                });
            }
        } catch (fetchError) {
            console.error(`❌ Error obteniendo contenido: ${fetchError.message}`);
            return res.status(500).json({
                error: `Error obteniendo contenido: ${fetchError.message}`,
                success: false,
                submission: {
                    id: submission.id,
                    fileName: submission.file_name,
                    fileUri: submission.file_uri
                }
            });
        }
    } catch (error) {
        console.error(`❌ Error general: ${error.message}`);
        return res.status(500).json({
            error: error.message,
            success: false
        });
    }
});

// ============================================================
// 📋 ENDPOINT PARA LISTAR SUBMISSIONS DE UNA TAREA
// Permite obtener todas las entregas de una tarea específica
// ============================================================
app.get('/listar-submissions/:taskId', async(req, res) => {
    const { taskId } = req.params;
    console.log(`📋 Listando submissions para taskId: ${taskId}`);
    
    try {
        if (!supabaseService) {
            return res.status(500).json({
                error: 'Supabase no está configurado',
                success: false
            });
        }
        
        const { data, error } = await supabaseService.client
            .from('task_submissions')
            .select('id, task_id, student_id, file_uri, file_name, submission_date, grade, feedback')
            .eq('task_id', taskId)
            .order('submission_date', { ascending: false });
        
        if (error) {
            return res.status(500).json({
                error: error.message,
                success: false
            });
        }
        
        console.log(`✅ Encontradas ${data.length} submissions`);
        
        return res.json({
            success: true,
            taskId: taskId,
            count: data.length,
            submissions: data
        });
    } catch (error) {
        console.error(`❌ Error: ${error.message}`);
        return res.status(500).json({
            error: error.message,
            success: false
        });
    }
});

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
    console.log(`   • POST /obtener-contenido-submission`);
    console.log(`   • GET  /listar-submissions/:taskId`);
    console.log(`   • GET  / (health check)`);
    console.log(`   • GET  /health (Railway healthcheck - fast)`);
    console.log(`   • GET  /health/detailed (full diagnostics)`);
    console.log(`   • POST /initialize (MCP)`);
    console.log(`   • POST /tools/list (MCP)`);
    console.log(`   • POST /tools/call (MCP)`);
    console.log('='.repeat(60));
});