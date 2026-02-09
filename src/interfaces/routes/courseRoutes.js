import { Router } from 'express';
import { SupabaseService } from '../../infrastructure/database/SupabaseService.js';

const router = Router();
const supabaseService = SupabaseService.getInstance();

/**
 * GET /creator/:userId/with-submissions
 * Get all courses created by a specific user that have at least one task submission
 * Used by ChatBotFragment to filter context
 */
router.get('/creator/:userId/with-submissions', async(req, res) => {
    try {
        const userId = parseInt(req.params.userId);

        if (isNaN(userId)) {
            return res.status(400).json({ error: 'Invalid user ID' });
        }

        console.log(`🔍 Fetching courses with submissions for creator ${userId}`);

        // Use raw SQL for efficient join and distinct filtering
        // This avoids N+1 queries or deep nested fetching
        const sqlQuery = `
            SELECT DISTINCT c.*
            FROM courses c
            JOIN topics t ON t.course_id = c.id
            JOIN tasks k ON k.topic_id = t.id
            JOIN task_submissions s ON s.task_id = k.id
            WHERE c.creator_user_id = ${userId}
            ORDER BY c.created_at DESC
        `;

        const result = await supabaseService.executeRawSQL(sqlQuery);

        if (result.error) {
            throw new Error(result.error);
        }

        const courses = result.data || [];
        console.log(`✅ Found ${courses.length} courses with submissions for user ${userId}`);

        res.json(courses);
    } catch (error) {
        console.error(`❌ Error fetching courses with submissions:`, error);
        res.status(500).json({ error: error.message });
    }
});

export default router;