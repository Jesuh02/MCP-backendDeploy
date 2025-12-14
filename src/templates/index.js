/**
 * templates/index.js
 * Exportaciones centralizadas de todas las plantillas
 */

export {
    getEmailBaseStyles,
    generateGradeEmailHTML,
    generateGradeModifiedEmailHTML,
    generateNewCourseEmailHTML,
    generateGenericEmailHTML,
    generateChatResponseEmailHTML
} from './emailTemplates.js';

export default {
    getEmailBaseStyles: () => import('./emailTemplates.js').then(m => m.getEmailBaseStyles),
    generateGradeEmailHTML: () => import('./emailTemplates.js').then(m => m.generateGradeEmailHTML),
    generateGradeModifiedEmailHTML: () => import('./emailTemplates.js').then(m => m.generateGradeModifiedEmailHTML),
    generateNewCourseEmailHTML: () => import('./emailTemplates.js').then(m => m.generateNewCourseEmailHTML),
    generateGenericEmailHTML: () => import('./emailTemplates.js').then(m => m.generateGenericEmailHTML),
    generateChatResponseEmailHTML: () => import('./emailTemplates.js').then(m => m.generateChatResponseEmailHTML)
};
