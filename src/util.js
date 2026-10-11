const crypto = require('crypto');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function keyFrom(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest();
}

function encrypt(text, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const enc = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, enc].map((b) => b.toString('base64')).join('.');
}

function decrypt(payload, secret) {
  const [iv, tag, enc] = String(payload).split('.').map((s) => Buffer.from(s, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFrom(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

/** Converte "R$ 1.234,56", "1234.56" ou "12,5" em número. Retorna null se vazio/inválido. */
function parseNum(v) {
  if (v === null || v === undefined) return null;
  let s = String(v).replace(/R\$|%|\s/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Aceita dd/mm/aaaa ou aaaa-mm-dd. Retorna 'aaaa-mm-dd' ou null. */
function parseDate(v) {
  const s = String(v || '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  let y, mo, d;
  if (m) [, y, mo, d] = m;
  else if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) [, d, mo, y] = m;
  else return null;
  const dt = new Date(Date.UTC(+y, +mo - 1, +d));
  if (dt.getUTCFullYear() !== +y || dt.getUTCMonth() !== +mo - 1 || dt.getUTCDate() !== +d) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** CSV simples com aspas. Detecta separador ; ou , pela primeira linha. */
function parseCsv(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] || '';
  const delim = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"' && src[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''));
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])));
}

function isoOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, 'Data/hora inválida');
  return d.toISOString();
}

module.exports = { HttpError, encrypt, decrypt, parseNum, parseDate, parseCsv, isoOrNull };
