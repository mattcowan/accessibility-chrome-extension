// RFC 4180 CSV builder for findings export. Sibling of
// tools/keyboard-trap-scan/lib/csv.js — keep the column set in sync by hand.

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

export function toCsv(findings, meta = {}) {
  const rows = [];
  // Header block naming the run before the column row (Excel reads it fine).
  if (meta.url) rows.push(`URL:,${field(meta.url)}`);
  if (meta.exported) rows.push(`Exported:,${field(meta.exported)}`);
  if (rows.length) rows.push('');
  rows.push(COLUMNS.join(','));
  for (const f of findings) {
    rows.push(COLUMNS.map((c) => field(f[c])).join(','));
  }
  // UTF-8 BOM so Excel opens it with correct encoding.
  return '﻿' + rows.join('\r\n') + '\r\n';
}

export function downloadCsv(findings, filename, meta) {
  const blob = new Blob([toCsv(findings, meta)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
