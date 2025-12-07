/**
 * Validation Schemas
 * Centralized Joi validation schemas for request validation
 */

import Joi from 'joi';

// Query validation
export const querySchema = Joi.object({
  query: Joi.string().required().min(1).max(10000)
    .messages({
      'string.empty': 'Query cannot be empty',
      'string.max': 'Query is too long (max 10000 characters)',
      'any.required': 'Query is required'
    }),
  includeRAG: Joi.boolean().optional().default(true),
  includeSchema: Joi.boolean().optional().default(false),
  maxTokens: Joi.number().optional().min(100).max(10000).default(4000)
});

// RAG search validation
export const ragSearchSchema = Joi.object({
  query: Joi.string().required().min(1).max(1000),
  topK: Joi.number().optional().min(1).max(20).default(5),
  threshold: Joi.number().optional().min(0).max(1).default(0.7)
});

// Knowledge addition validation
export const knowledgeSchema = Joi.object({
  content: Joi.string().required().min(1).max(50000),
  metadata: Joi.object().optional().default({})
});

// Table query validation
export const tableQuerySchema = Joi.object({
  tableName: Joi.string().required()
    .valid(
      'personas', 'usuarios', 'videos', 'topics', 'content_items',
      'tasks', 'subscriptions', 'task_submissions', 'chat_messages',
      'file_contexts', 'courses', 'roles', 'recursos', 'rol_recursos'
    ),
  page: Joi.number().optional().min(1).default(1),
  pageSize: Joi.number().optional().min(1).max(100).default(50)
});

// Pagination validation
export const paginationSchema = Joi.object({
  page: Joi.number().optional().min(1).default(1),
  pageSize: Joi.number().optional().min(1).max(100).default(50),
  sortBy: Joi.string().optional(),
  sortOrder: Joi.string().optional().valid('asc', 'desc').default('asc')
});

export default {
  querySchema,
  ragSearchSchema,
  knowledgeSchema,
  tableQuerySchema,
  paginationSchema
};
