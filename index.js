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

const app = express();
const PORT = process.env.PORT || 3001;
const MAX_TOKENS = 4096;

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
        let { prompt, ollamaUrl, descripcionTarea, taskDescription, fileContent } = req.body;

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
    console.log('='.repeat(60));
});