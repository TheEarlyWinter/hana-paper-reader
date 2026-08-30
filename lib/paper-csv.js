function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&#(\d+);/g, (_match, code) => {
      const number = Number(code);
      return Number.isFinite(number) ? String.fromCodePoint(Math.min(0x10ffff, number)) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => {
      const number = Number.parseInt(code, 16);
      return Number.isFinite(number) ? String.fromCodePoint(Math.min(0x10ffff, number)) : "";
    })
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ");
}

function cellText(value) {
  return decodeHtmlEntities(String(value || "")
    .replace(/<!--[^]*?-->/g, "")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*\/\s*(?:p|div|li)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/\r\n?/g, "\n")
    .trim());
}

export function tableHtmlToRows(html) {
  const source = String(html || "");
  const rows = [];
  const rowPattern = /<\s*tr\b[^>]*>([^]*?)<\s*\/\s*tr\s*>/gi;
  let rowMatch;
  while ((rowMatch = rowPattern.exec(source))) {
    const cells = [];
    const cellPattern = /<\s*(?:th|td)\b[^>]*>([^]*?)<\s*\/\s*(?:th|td)\s*>/gi;
    let cellMatch;
    while ((cellMatch = cellPattern.exec(rowMatch[1]))) cells.push(cellText(cellMatch[1]));
    if (cells.length) rows.push(cells);
  }
  return rows;
}

function safeCsvValue(value) {
  const text = String(value ?? "");
  const formulaLike = /^[=+@]/.test(text) || (/^-\s*[A-Za-z(]/.test(text) && !/^-\s*\d/.test(text));
  return formulaLike ? `'${text}` : text;
}

export function csvText(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => (Array.isArray(row) ? row : [])
    .map((value) => `"${safeCsvValue(value).replace(/"/g, '""')}"`)
    .join(","))
    .join("\r\n");
}

export function tableHtmlToCsv(html) {
  return csvText(tableHtmlToRows(html));
}
