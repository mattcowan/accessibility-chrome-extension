// RFC 4180 CSV builder for findings export. Sibling of
// tools/keyboard-trap-scan/lib/csv.js — keep the column set in sync by hand.
// (buildCsv/downloadTable are popup-only generic helpers — e.g. the
// live-region log export — and are intentionally absent from the scanner.)

export const COLUMNS = [
  'tool',
  'wcag',
  'severity',
  'selector',
  'snippet',
  'details',
  'url',
  'timestamp',
  'status',
];

function field(value) {
  const s = value == null ? '' : String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function buildCsv(columns, rows, meta = {}) {
  const out = [];
  // Header block naming the run before the column row (Excel reads it fine).
  if (meta.url) out.push(`URL:,${field(meta.url)}`);
  if (meta.exported) out.push(`Exported:,${field(meta.exported)}`);
  if (out.length) out.push('');
  out.push(columns.join(','));
  for (const r of rows) {
    out.push(columns.map((c) => field(r[c])).join(','));
  }
  // UTF-8 BOM so Excel opens it with correct encoding.
  return '﻿' + out.join('\r\n') + '\r\n';
}

export function toCsv(findings, meta = {}) {
  return buildCsv(COLUMNS, findings, meta);
}

export function downloadTable(columns, rows, filename, meta) {
  const blob = new Blob([buildCsv(columns, rows, meta)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadCsv(findings, filename, meta) {
  return downloadTable(COLUMNS, findings, filename, meta);
}
