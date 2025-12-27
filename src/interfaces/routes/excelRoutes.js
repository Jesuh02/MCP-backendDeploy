import { Router } from 'express';
import { MCPService } from '../../domain/services/MCPService.js';
import { R2StorageService } from '../../services/R2StorageService.js';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const xlsx = require('xlsx');

const router = Router();
const mcpService = new MCPService();
const r2Service = R2StorageService.getInstance();

/**
 * Generate an Excel file from a natural language query
 * 1. Process query with MCPService (Supabase)
 * 2. Convert data to Excel
 * 3. Upload to R2
 * 4. Return URL
 */
router.post('/generate-excel', async (req, res) => {
    try {
        const { query, userId } = req.body;

        if (!query) {
            return res.status(400).json({ error: 'Query is required' });
        }

        console.log(`📊 Generating Excel for query: "${query}" (User: ${userId})`);

        // 1. Get Data
        // We use processQuery which handles natural language -> SQL -> Data
        const result = await mcpService.processQuery(query);
        
        if (result.error) {
            return res.status(400).json({ error: result.message, hint: result.hint });
        }

        let dataToExport = [];
        
        // Handle different data structures
        if (Array.isArray(result.data)) {
            dataToExport = result.data;
        } else if (result.data && typeof result.data === 'object') {
            // It might be a snapshot object (from generateDataSnapshot)
            if (result.data.metrics) {
                // Convert metrics object to array of key-value pairs
                dataToExport = Object.entries(result.data.metrics).map(([key, value]) => ({ Metric: key, Value: value }));
            } else if (result.data.data) {
                // Nested data
                dataToExport = Array.isArray(result.data.data) ? result.data.data : [result.data.data];
            } else {
                // Try to find any array property
                const arrayProp = Object.values(result.data).find(v => Array.isArray(v));
                if (arrayProp) {
                    dataToExport = arrayProp;
                } else {
                    // Fallback: just wrap the object
                    dataToExport = [result.data];
                }
            }
        }

        if (!dataToExport || dataToExport.length === 0) {
            return res.status(404).json({ error: 'No data found for this query' });
        }

        console.log(`✅ Data retrieved: ${dataToExport.length} rows`);

        // 2. Generate Excel
        const wb = xlsx.utils.book_new();
        const ws = xlsx.utils.json_to_sheet(dataToExport);
        
        // Auto-width columns
        const colWidths = Object.keys(dataToExport[0] || {}).map(key => ({ wch: Math.max(key.length, 15) }));
        ws['!cols'] = colWidths;

        xlsx.utils.book_append_sheet(wb, ws, "Results");
        
        const excelBuffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

        // 3. Upload to R2
        const timestamp = Date.now();
        const filename = `reports/excel_export_${userId || 'anon'}_${timestamp}.xlsx`;
        
        console.log(`📤 Uploading Excel to ${filename}...`);
        const publicUrl = await r2Service.uploadFile(
            excelBuffer, 
            filename, 
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );

        // 4. Return URL
        res.json({
            success: true,
            url: publicUrl,
            rows: dataToExport.length,
            filename: filename
        });

    } catch (error) {
        console.error('❌ Error generating Excel:', error);
        res.status(500).json({ error: error.message });
    }
});

export default router;
