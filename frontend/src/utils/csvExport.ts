// CSV Export utilities for FlowFi
//
// Raw-value guarantee: exports produced by this module always contain the
// canonical raw values for each record. Amounts are emitted in their smallest
// unit (e.g. stroops) and timestamps are emitted as Unix timestamps (seconds).
// Locale-sensitive presentation (localized amounts, dates, pluralized labels)
// must never replace the canonical values in an export.
//
// If a human-readable, locale-aware column is desired, callers may opt in via
// `convertArrayToCSV`/`downloadCSV` options by supplying a `displayColumns`
// map. Display columns are appended after the raw columns and are clearly
// suffixed so they can never be mistaken for canonical data.

type CsvRow = Record<string, unknown>;

export interface CsvDisplayColumn {
    /** Header for the appended, locale-aware display column. */
    header: string;
    /** Produces the localized display value for a given row. */
    format: (row: CsvRow) => string;
}

export interface CsvExportOptions {
    /**
     * Optional locale-aware display columns. Only appended when explicitly
     * provided; raw canonical columns are always emitted first.
     */
    displayColumns?: CsvDisplayColumn[];
    /** Locale used for any Date values that are explicitly formatted. */
    locale?: string;
}

/**
 * Escape a single CSV cell.
 *
 * Canonical values are preserved verbatim. `Date` objects are serialized as
 * their Unix timestamp (seconds) so canonical output is never altered by the
 * host locale or timezone. Use `formatDisplayDate` for localized output.
 */
export const escapeCsvCell = (value: unknown): string => {
    if (value === null || value === undefined) {
        return '';
    }

    let text: string;
    if (value instanceof Date) {
        // Canonical: Unix timestamp in seconds (UTC, locale-independent).
        text = String(Math.floor(value.getTime() / 1000));
    } else {
        text = String(value);
    }

    const escaped = text.replace(/"/g, '""');

    return /("|,|\n)/.test(escaped) ? `"${escaped}"` : escaped;
};

/**
 * Format a Unix timestamp (seconds) as a locale-aware display string.
 * Intended for opt-in display columns only; never for canonical columns.
 */
export const formatDisplayDate = (
    unixSeconds: number | string,
    locale?: string
): string => {
    const seconds =
        typeof unixSeconds === 'string' ? Number(unixSeconds) : unixSeconds;
    if (!Number.isFinite(seconds)) return '';
    return new Date(seconds * 1000).toLocaleString(locale);
};

/**
 * Format a smallest-unit amount as a locale-aware display string.
 * Intended for opt-in display columns only; never for canonical columns.
 */
export const formatDisplayAmount = (
    smallestUnit: number | string | bigint,
    decimals: number,
    locale?: string
): string => {
    const raw =
        typeof smallestUnit === 'bigint'
            ? smallestUnit
            : BigInt(Math.trunc(Number(smallestUnit)));
    const negative = raw < BigInt(0);
    const abs = negative ? -raw : raw;
    const divisor = BigInt(10) ** BigInt(decimals);
    const whole = abs / divisor;
    const fraction = abs % divisor;
    const fractionText = fraction
        .toString()
        .padStart(decimals, '0')
        .replace(/0+$/, '');
    const wholeText = whole.toLocaleString(locale);
    const sign = negative ? '-' : '';
    return fractionText
        ? `${sign}${wholeText}.${fractionText}`
        : `${sign}${wholeText}`;
};

export const convertArrayToCSV = <T extends CsvRow>(
    arr: T[] | null | undefined,
    options: CsvExportOptions = {}
): string => {
    if (!arr || arr.length === 0) return '';

    const separator = ',';
    const firstRow = arr[0];
    if (!firstRow) return '';
    const keys = Object.keys(firstRow);
    const displayColumns = options.displayColumns ?? [];

    const header = [
        ...keys,
        ...displayColumns.map((column) => column.header),
    ].join(separator);

    const rows = arr.map((row) => {
        const rawCells = keys.map((key) => escapeCsvCell(row[key]));
        const displayCells = displayColumns.map((column) =>
            escapeCsvCell(column.format(row))
        );
        return [...rawCells, ...displayCells].join(separator);
    });

    return [header, ...rows].join('\n');
};

export const downloadCSV = <T extends CsvRow>(
    data: T[],
    filename: string,
    options: CsvExportOptions = {}
) => {
    const csvData = convertArrayToCSV(data, options);
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