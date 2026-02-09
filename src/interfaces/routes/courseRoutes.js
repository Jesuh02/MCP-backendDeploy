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

/**
 * GET /:courseId/submissions
 * Get all submissions for a course including student usernames
 * Used by Android app when execute_sql RPC is not available
 */
router.get('/:courseId/submissions', async(req, res) => {
    try {
        const courseId = parseInt(req.params.courseId);

        if (isNaN(courseId)) {
            return res.status(400).json({ error: 'Invalid course ID' });
        }

        console.log(`🔍 Fetching submissions with usernames for course ${courseId}`);

        // First try: use executeRawSQL which has its own fallback logic
        try {
            const sqlQuery = `
                SELECT 
                    ts.id as submission_id,
                    ts.task_id,
                    tk.title as task_title,
                    ts.student_id,
                    u.username as student_username,
                    ts.grade,
                    ts.submission_date,
                    ts.file_uri
                FROM task_submissions ts
                JOIN tasks tk ON ts.task_id = tk.id
                JOIN topics t ON tk.topic_id = t.id
                LEFT JOIN usuarios u ON ts.student_id = u.id
                WHERE t.course_id = ${courseId}
                ORDER BY ts.submission_date DESC
            `;

            const result = await supabaseService.executeRawSQL(sqlQuery);
            const submissions = Array.isArray(result) ? result : (result?.data || []);
            console.log(`✅ Found ${submissions.length} submissions for course ${courseId} (via SQL)`);
            return res.json(submissions);
        } catch (sqlError) {
            console.warn(`⚠️ SQL approach failed, using PostgREST fallback: ${sqlError.message}`);
        }

        // Fallback: use PostgREST individual queries
        // 1. Get topics for this course
        const { data: topics, error: topicsErr } = await supabaseService.client
            .from('topics')
            .select('id')
            .eq('course_id', courseId);
        if (topicsErr) throw topicsErr;
        if (!topics || topics.length === 0) return res.json([]);

        const topicIds = topics.map(t => t.id);

        // 2. Get tasks for these topics
        const { data: tasks, error: tasksErr } = await supabaseService.client
            .from('tasks')
            .select('id, title, topic_id')
            .in('topic_id', topicIds);
        if (tasksErr) throw tasksErr;
        if (!tasks || tasks.length === 0) return res.json([]);

        const taskIds = tasks.map(t => t.id);
        const taskMap = {};
        tasks.forEach(t => { taskMap[t.id] = t.title; });

        // 3. Get submissions for these tasks
        const { data: submissions, error: subsErr } = await supabaseService.client
            .from('task_submissions')
            .select('id, task_id, student_id, grade, submission_date, file_uri')
            .in('task_id', taskIds)
            .order('submission_date', { ascending: false });
        if (subsErr) throw subsErr;
        if (!submissions || submissions.length === 0) return res.json([]);

        // 4. Get unique student IDs and fetch usernames
        const studentIds = [...new Set(submissions.map(s => s.student_id).filter(Boolean))];
        const userMap = {};
        if (studentIds.length > 0) {
            const { data: users } = await supabaseService.client
                .from('usuarios')
                .select('id, username')
                .in('id', studentIds);
            if (users) {
                users.forEach(u => { userMap[u.id] = u.username; });
            }
        }

        // 5. Combine results
        const result = submissions.map(s => ({
            submission_id: s.id,
            task_id: s.task_id,
            task_title: taskMap[s.task_id] || 'Unknown',
            student_id: s.student_id,
            student_username: userMap[s.student_id] || 'Unknown',
            grade: s.grade,
            submission_date: s.submission_date,
            file_uri: s.file_uri
        }));

        console.log(`✅ Found ${result.length} submissions for course ${courseId} (via PostgREST fallback)`);
        res.json(result);
    } catch (error) {
        console.error(`❌ Error fetching course submissions:`, error);
        res.status(500).json({ error: error.message });
    }
});

export default router;