import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';
import { VerifiedFix } from '../../models/VerifiedFix.js';

const sensitivePattern = /(api[_-]?key|secret|token|password|mongodb|postgres|\.env|private)/i;
const vectorSize = 128;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultMemoryFile = path.resolve(__dirname, '../../data/verified-fix-memory.json');

export function buildErrorSignature({ category = '', message = '', file = '' } = {}) {
  return [category, normalizeWords(message).slice(0, 8).join(' '), fileType(file)].filter(Boolean).join(' | ');
}

export async function storeVerifiedFixCandidate({ project, review, fixChanges, validationPassed, previewEvidence = [] }) {
  const blockerHighBefore = (review?.findings || []).filter((finding) => ['blocker', 'high'].includes(finding.severity));
  if (!blockerHighBefore.length || !fixChanges?.length || !validationPassed) return null;
  const first = blockerHighBefore[0];
  const summary = fixChanges.map((change) => change.reason || change.path).join('; ');
  if (sensitivePattern.test(summary + ' ' + first.description + ' ' + first.rootCause)) return null;

  const memoryRecord = buildVerifiedFixMemoryRecord({
    project,
    finding: first,
    fixChanges,
    fixSummary: summary.slice(0, 500),
    previewEvidence
  });
  await appendVerifiedFixMemoryRecord(memoryRecord);

  const record = await VerifiedFix.create({
    fixId: randomUUID(),
    pattern: memoryRecord.pattern,
    context: memoryRecord.context,
    errorSignature: memoryRecord.errorSignature,
    errorCategory: memoryRecord.errorCategory,
    technologies: memoryRecord.technologies,
    fixSummary: memoryRecord.fix_applied,
    changedFileTypes: memoryRecord.changedFileTypes,
    verificationEvidence: memoryRecord.verificationEvidence,
    verified: true,
    projectId: project.projectId,
    scope: 'global'
  });
  return record;
}

export async function retrieveVerifiedFixes({ category = '', technologies = [], message = '', file = '' } = {}) {
  const dbQuery = mongoose.connection.readyState === 1
    ? VerifiedFix.find({ verified: true, scope: 'global' }).sort({ updatedAt: -1 }).limit(100).lean().catch(() => [])
    : Promise.resolve([]);
  const [dbCandidates, fileCandidates] = await Promise.all([
    dbQuery,
    readVerifiedFixMemoryRecords().catch(() => [])
  ]);
  const candidates = dedupeRecords([...dbCandidates, ...fileCandidates]);
  const queryWords = new Set(normalizeWords([category, message, file, ...technologies].join(' ')));
  const queryVector = embedText([category, message, file, ...technologies].join(' '));
  return candidates
    .map((record) => ({ ...record, score: scoreRecord(record, queryWords, queryVector, category, technologies, file) }))
    .filter((record) => record.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ score, ...record }) => ({ ...record, score }));
}

export function buildKnownPitfallsPrompt(records = []) {
  const verified = records.filter((record) => record?.verified !== false).slice(0, 3);
  if (!verified.length) return 'No verified pitfalls matched this context.';
  return verified.map((record, index) => [
    String(index + 1) + '. Pattern: ' + (record.pattern || 'Verified frontend generation failure'),
    '   Context: ' + (record.context || record.errorCategory || 'frontend generation'),
    '   Avoid: ' + (record.errorSignature || record.failure || record.description || 'repeating the same generated-code failure'),
    '   Known fix: ' + (record.fix_applied || record.fixSummary || 'Use the verified fix from memory.'),
    '   Verification: ' + ((record.verificationEvidence || []).join('; ') || 'verified: true')
  ].join('\n')).join('\n');
}

export function buildVerifiedFixMemoryRecord({ project, finding, fixChanges, fixSummary, previewEvidence = [] }) {
  const textForVector = [
    finding.category,
    finding.title,
    finding.description,
    finding.rootCause,
    finding.file,
    fixSummary,
    fixChanges.map((change) => change.path).join(' ')
  ].join(' ');
  return {
    id: randomUUID(),
    pattern: generalizePattern(finding),
    context: [finding.category || 'unknown', finding.file || '', (project?.expandedSpec?.projectName || project?.name || '')].filter(Boolean).join(' | '),
    failure: finding.description || finding.title || '',
    errorSignature: buildErrorSignature({ category: finding.category, message: finding.description, file: finding.file }),
    errorCategory: finding.category || 'unknown',
    agent: 'Fix Agent',
    fix_applied: fixSummary,
    changedFiles: fixChanges.map((change) => change.path).filter(Boolean),
    changedFileTypes: [...new Set(fixChanges.map((change) => fileType(change.path)).filter(Boolean))],
    technologies: ['React', 'Vite', 'JavaScript'],
    verificationEvidence: ['static validation passed', ...previewEvidence].slice(0, 5),
    verified: true,
    projectId: project?.projectId || '',
    createdAt: new Date().toISOString(),
    embedding: embedText(textForVector)
  };
}

export async function appendVerifiedFixMemoryRecord(record) {
  const memoryFile = getMemoryFile();
  await fs.mkdir(path.dirname(memoryFile), { recursive: true });
  const records = await readVerifiedFixMemoryRecords();
  const nextRecords = dedupeRecords([record, ...records]).slice(0, 500);
  await fs.writeFile(memoryFile, JSON.stringify(nextRecords, null, 2) + '\n');
  return record;
}

export async function readVerifiedFixMemoryRecords() {
  const memoryFile = getMemoryFile();
  const raw = await fs.readFile(memoryFile, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return '[]';
    throw error;
  });
  const parsed = JSON.parse(raw || '[]');
  return Array.isArray(parsed) ? parsed.filter((record) => record?.verified !== false) : [];
}

function scoreRecord(record, queryWords, queryVector, category, technologies, file) {
  let score = 0;
  if (category && record.errorCategory === category) score += 5;
  for (const tech of technologies || []) if ((record.technologies || []).includes(tech)) score += 2;
  if (file && (record.changedFileTypes || []).includes(fileType(file))) score += 3;
  const haystack = normalizeWords([record.pattern, record.context, record.errorSignature, record.fixSummary, record.fix_applied].join(' '));
  for (const word of haystack) if (queryWords.has(word)) score += 1;
  score += cosineSimilarity(queryVector, record.embedding || embedText([record.pattern, record.context, record.errorSignature, record.fixSummary, record.fix_applied].join(' '))) * 8;
  return score;
}

function generalizePattern(finding) {
  const text = [finding.title, finding.description, finding.rootCause].join(' ').toLowerCase();
  if (text.includes('default export')) return 'Missing default export in React module';
  if (text.includes('relative import') || text.includes('import')) return 'Incorrect or missing relative import';
  if (text.includes('redux')) return 'Redux wiring issue in generated frontend';
  if (text.includes('localstorage')) return 'localStorage persistence or parse issue';
  if (text.includes('route')) return 'Route component wiring issue';
  if (text.includes('package')) return 'Generated package configuration issue';
  return finding.title || 'Verified generated frontend fix';
}

function normalizeWords(value) {
  return String(value || '').toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2 && !sensitivePattern.test(word));
}

function fileType(filePath) {
  const ext = path.posix.extname(String(filePath || '')).replace('.', '');
  if (!ext) return '';
  if (ext === 'jsx') return 'jsx';
  if (ext === 'js') return 'js';
  if (ext === 'css') return 'css';
  if (ext === 'json') return 'json';
  return ext;
}

function getMemoryFile() {
  return process.env.VERIFIED_FIX_MEMORY_FILE || defaultMemoryFile;
}

function dedupeRecords(records) {
  const map = new Map();
  for (const record of records || []) {
    const key = record.fixId || record.id || [record.pattern, record.errorSignature, record.fixSummary || record.fix_applied].join('|');
    if (!map.has(key)) map.set(key, record);
  }
  return Array.from(map.values());
}

function embedText(value) {
  const vector = Array(vectorSize).fill(0);
  for (const word of normalizeWords(value)) {
    vector[hashWord(word) % vectorSize] += 1;
  }
  const length = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0)) || 1;
  return vector.map((item) => Number((item / length).toFixed(6)));
}

function cosineSimilarity(a = [], b = []) {
  if (!a.length || !b.length) return 0;
  let dot = 0;
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) dot += Number(a[index] || 0) * Number(b[index] || 0);
  return dot;
}

function hashWord(word) {
  let hash = 2166136261;
  for (const char of String(word)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}
