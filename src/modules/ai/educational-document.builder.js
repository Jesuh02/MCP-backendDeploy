function isMarkdownTableRow(line) {
    const trimmed = String(line || '').trim();
    return trimmed.startsWith('|') && trimmed.includes('|', 1);
}

function isMarkdownTableSeparator(line) {
    const cells = parseMarkdownTableRow(line);
    return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell.trim()));
}

function parseMarkdownTableRow(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed.startsWith('|')) return [];
    return trimmed
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map(cell => cell.trim());
}

function cleanMarkdownText(text) {
    return String(text || '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .trim();
}

function parseMarkdownInline(text, TextRun, options = {}) {
    const base = {
        color: options.color,
        size: options.size,
        bold: options.bold,
        italics: options.italics,
    };
    const parts = String(text || '').split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/);
    const runs = parts
        .filter(Boolean)
        .map(part => {
            if (part.startsWith('**') && part.endsWith('**')) {
                return new TextRun({ ...base, text: part.slice(2, -2), bold: true });
            }
            if (part.startsWith('*') && part.endsWith('*')) {
                return new TextRun({ ...base, text: part.slice(1, -1), italics: true });
            }
            if (part.startsWith('`') && part.endsWith('`')) {
                return new TextRun({ ...base, text: part.slice(1, -1), font: 'Consolas' });
            }
            return new TextRun({ ...base, text: part });
        });
    return runs.length > 0 ? runs : [new TextRun({ ...base, text: String(text || '') })];
}

function paragraphFromLine(line, docx) {
    const {
        Paragraph,
        TextRun,
        HeadingLevel,
        AlignmentType,
    } = docx;

    if (line.startsWith('# ')) {
        return new Paragraph({ text: cleanMarkdownText(line.slice(2)), heading: HeadingLevel.HEADING_1 });
    }
    if (line.startsWith('## ')) {
        return new Paragraph({ text: cleanMarkdownText(line.slice(3)), heading: HeadingLevel.HEADING_2 });
    }
    if (line.startsWith('### ')) {
        return new Paragraph({ text: cleanMarkdownText(line.slice(4)), heading: HeadingLevel.HEADING_3 });
    }
    if (line.startsWith('- ') || line.startsWith('* ')) {
        return new Paragraph({
            children: parseMarkdownInline(line.slice(2).trim(), TextRun),
            bullet: { level: 0 },
        });
    }
    if (/^\d+\.\s/.test(line)) {
        return new Paragraph({
            children: parseMarkdownInline(line.replace(/^\d+\.\s/, '').trim(), TextRun),
            bullet: { level: 0 },
        });
    }
    if (line.trim() === '') {
        return new Paragraph({ text: '' });
    }
    if (/^_{3,}$/.test(line.trim()) || /^-{3,}$/.test(line.trim())) {
        return new Paragraph({ text: '' });
    }
    return new Paragraph({
        children: parseMarkdownInline(line, TextRun),
        alignment: AlignmentType.LEFT,
    });
}

function buildTableCell(text, docx, isHeader = false) {
    const {
        Paragraph,
        TextRun,
        TableCell,
        ShadingType,
        VerticalAlign,
        AlignmentType,
    } = docx;

    return new TableCell({
        margins: { top: 120, bottom: 120, left: 120, right: 120 },
        verticalAlign: VerticalAlign.CENTER,
        shading: isHeader
            ? { type: ShadingType.CLEAR, fill: '1F4E79', color: 'auto' }
            : { type: ShadingType.CLEAR, fill: 'F8FAFC', color: 'auto' },
        children: [
            new Paragraph({
                alignment: isHeader ? AlignmentType.CENTER : AlignmentType.LEFT,
                children: parseMarkdownInline(text, TextRun, {
                    bold: isHeader,
                    color: isHeader ? 'FFFFFF' : '1F2937',
                    size: 20,
                }),
            }),
        ],
    });
}

function buildMarkdownTable(tableLines, docx) {
    const {
        Paragraph,
        Table,
        TableRow,
        WidthType,
        BorderStyle,
    } = docx;

    if (tableLines.length < 2 || !isMarkdownTableSeparator(tableLines[1])) {
        return tableLines.map(line => paragraphFromLine(line, docx));
    }

    const header = parseMarkdownTableRow(tableLines[0]);
    const bodyRows = tableLines
        .slice(2)
        .map(parseMarkdownTableRow)
        .filter(row => row.length > 0);

    const columnCount = Math.max(header.length, ...bodyRows.map(row => row.length), 1);
    const normalizeRow = row => Array.from({ length: columnCount }, (_, index) => row[index] || '');
    const border = { style: BorderStyle.SINGLE, size: 8, color: 'CBD5E1' };

    const rows = [
        new TableRow({
            tableHeader: true,
            children: normalizeRow(header).map(cell => buildTableCell(cell, docx, true)),
        }),
        ...bodyRows.map(row => new TableRow({
            children: normalizeRow(row).map(cell => buildTableCell(cell, docx, false)),
        })),
    ];

    return [
        new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            borders: {
                top: border,
                bottom: border,
                left: border,
                right: border,
                insideHorizontal: border,
                insideVertical: border,
            },
            rows,
        }),
        new Paragraph({ text: '' }),
    ];
}

function markdownToDocxChildren(markdownContent, docx) {
    const children = [];
    const lines = String(markdownContent || '').split('\n');

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (isMarkdownTableRow(line) && index + 1 < lines.length && isMarkdownTableSeparator(lines[index + 1])) {
            const tableLines = [line, lines[index + 1]];
            index += 2;
            while (index < lines.length && isMarkdownTableRow(lines[index])) {
                tableLines.push(lines[index]);
                index++;
            }
            index--;
            children.push(...buildMarkdownTable(tableLines, docx));
            continue;
        }
        children.push(paragraphFromLine(line, docx));
    }

    return children;
}

export async function buildEducationalDocx({ title, subtitle, markdownContent }) {
    const docx = await import('docx');
    const {
        Document,
        Paragraph,
        TextRun,
        HeadingLevel,
        Packer,
        AlignmentType,
    } = docx;

    const children = [
        new Paragraph({
            text: title || 'Documento educativo',
            heading: HeadingLevel.TITLE,
            alignment: AlignmentType.CENTER,
        }),
    ];

    if (subtitle) {
        children.push(new Paragraph({
            children: [new TextRun({ text: subtitle, italics: true, size: 24, color: '475569' })],
            alignment: AlignmentType.CENTER,
        }));
    }

    children.push(new Paragraph({ text: '' }));
    children.push(...markdownToDocxChildren(markdownContent, docx));

    const doc = new Document({
        sections: [{
            properties: {},
            children,
        }],
    });
    return Packer.toBuffer(doc);
}

export function parseMarkdownInlineForDocx(text, TextRun) {
    return parseMarkdownInline(text, TextRun);
}
