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
    generateChatResponseEmailHTML,
    generateTaskReminderEmailHTML,
    generateCollaboratorAddedEmailHTML,
    generateEnrollmentRequestEmailHTML
} from './emailTemplates.js';

export default {
    getEmailBaseStyles: () => import('./emailTemplates.js').then(m => m.getEmailBaseStyles),
    generateGradeEmailHTML: () => import('./emailTemplates.js').then(m => m.generateGradeEmailHTML),
    generateGradeModifiedEmailHTML: () => import('./emailTemplates.js').then(m => m.generateGradeModifiedEmailHTML),
    generateNewCourseEmailHTML: () => import('./emailTemplates.js').then(m => m.generateNewCourseEmailHTML),
    generateGenericEmailHTML: () => import('./emailTemplates.js').then(m => m.generateGenericEmailHTML),
    generateChatResponseEmailHTML: () => import('./emailTemplates.js').then(m => m.generateChatResponseEmailHTML),
    generateTaskReminderEmailHTML: () => import('./emailTemplates.js').then(m => m.generateTaskReminderEmailHTML),
    generateCollaboratorAddedEmailHTML: () => import('./emailTemplates.js').then(m => m.generateCollaboratorAddedEmailHTML),
    generateEnrollmentRequestEmailHTML: () => import('./emailTemplates.js').then(m => m.generateEnrollmentRequestEmailHTML)
};


