// CSV Export utilities for FlowFi

type CsvRow = Record<string, unknown>;

export const escapeCsvCell = (value: unknown): string => {
    if (value === null || value === undefined) {
        return '';
    }

    const text = value instanceof Date ? value.toLocaleString() : String(value);
    const escaped = text.replace(/"/g, '""');

    return /("|,|\n)/.test(escaped) ? `"${escaped}"` : escaped;
};

export const convertArrayToCSV = <T extends CsvRow>(
    arr: T[] | null | undefined
): string => {
    if (!arr || arr.length === 0) return '';

    const separator = ',';
    const firstRow = arr[0];
    if (!firstRow) return '';
    const keys = Object.keys(firstRow);

    return [
        keys.join(separator),
        ...arr.map((row) =>
            keys.map((key) => escapeCsvCell(row[key])).join(separator)
        ),
    ].join('\n');
};

/**
 * Annotation fields that may be attached to a transaction for export.
 * Annotations are local/encrypted operational context and are never
 * published on-chain; exporting them is an explicit user action.
 */
export interface TransactionAnnotationFields {
    annotation?: string | null;
    notes?: string | null;
}

/**
 * Merge annotation fields into a transaction row for CSV export.
 *
 * - Unannotated transactions get empty annotation/notes cells so the
 *   exported column set stays stable across rows.
 * - Annotated transactions include their (already decrypted) annotation
 *   and private notes text.
 * - Existing row keys are preserved; annotation columns are appended only
 *   when not already present.
 */
export const withAnnotationFields = <T extends CsvRow>(
    row: T,
    annotation?: TransactionAnnotationFields | null
): T & { annotation: string; notes: string } => {
    const annotationText =
        annotation?.annotation === null || annotation?.annotation === undefined
            ? ''
            : String(annotation.annotation);
    const notesText =
        annotation?.notes === null || annotation?.notes === undefined
            ? ''
            : String(annotation.notes);

    return {
        ...row,
        annotation: annotationText,
        notes: notesText,
    };
};

/**
 * Convert transactions (optionally annotated) to CSV, ensuring annotation
 * and notes columns are always present in the output.
 */
export const convertTransactionsToCSV = <T extends CsvRow>(
    arr: (T & TransactionAnnotationFields)[] | null | undefined
): string => {
    if (!arr || arr.length === 0) return '';

    const rows = arr.map((row) => withAnnotationFields(row, row));

    return convertArrayToCSV(rows);
};

export const downloadCSV = <T extends CsvRow>(data: T[], filename: string) => {
    const csvData = convertArrayToCSV(data);
    const blob = new Blob([csvData], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    if (link.download !== undefined) {
        const url = URL.createObjectURL(blob);
        link.setAttribute('href', url);
        link.setAttribute('download', filename);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }
};

/**
 * Download a CSV that includes annotation and private notes columns.
 * Annotations are local/encrypted data; this is an explicit user-initiated
 * export and must not be triggered automatically.
 */
export const downloadTransactionsCSV = <T extends CsvRow>(
    data: (T & TransactionAnnotationFields)[],
    filename: string
) => {
    const csvData = convertTransactionsToCSV(data);
    const blob = new Blob([csvData], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    if (link.download !== undefined) {
        const url = URL.createObjectURL(blob);
        link.setAttribute('href', url);
        link.setAttribute('download', filename);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }
};