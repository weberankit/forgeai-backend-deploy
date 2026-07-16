import { randomUUID } from 'crypto';
import path from 'path';
import { VerifiedFix } from '../../models/VerifiedFix.js';

const sensitivePattern = /(api[_-]?key|secret|token|password|mongodb|postgres|\.env|private)/i;

export function buildErrorSignature({ category = '', message = '', file = '' } = {}) {
  return [category, normalizeWords(message).slice(0, 8).join(' '), fileType(file)].filter(Boolean).join(' | ');
}

export async function storeVerifiedFixCandidate({ project, review, fixChanges, validationPassed, previewEvidence = [] }) {
  const blockerHighBefore = (review?.findings || []).filter((finding) => ['blocker', 'high'].includes(finding.severity));
  if (!blockerHighBefore.length || !fixChanges?.length || !validationPassed) return null;
  const first = blockerHighBefore[0];
  const summary = fixChanges.map((change) => change.reason || change.path).join('; ');
  if (sensitivePattern.test(summary + ' ' + first.description + ' ' + first.rootCause)) return null;
  const record = await VerifiedFix.create({
    fixId: randomUUID(),
    pattern: generalizePattern(first),
    context: first.category || 'unknown',
    errorSignature: buildErrorSignature({ category: first.category, message: first.description, file: first.file }),
    errorCategory: first.category || 'unknown',
    technologies: ['React', 'Vite', 'JavaScript'],
    fixSummary: summary.slice(0, 500),
    changedFileTypes: [...new Set(fixChanges.map((change) => fileType(change.path)).filter(Boolean))],
    verificationEvidence: ['static validation passed', ...previewEvidence].slice(0, 5),
    verified: true,
    projectId: project.projectId,
    scope: 'global'
  });
  return record;
}

export async function retrieveVerifiedFixes({ category = '', technologies = [], message = '', file = '' } = {}) {
  const candidates = await VerifiedFix.find({ verified: true, scope: 'global' }).sort({ updatedAt: -1 }).limit(100).lean();
  const queryWords = new Set(normalizeWords([category, message, file, ...technologies].join(' ')));
  return candidates
    .map((record) => ({ ...record, score: scoreRecord(record, queryWords, category, technologies, file) }))
    .filter((record) => record.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ score, ...record }) => ({ ...record, score }));
}

function scoreRecord(record, queryWords, category, technologies, file) {
  let score = 0;
  if (category && record.errorCategory === category) score += 5;
  for (const tech of technologies || []) if ((record.technologies || []).includes(tech)) score += 2;
  if (file && (record.changedFileTypes || []).includes(fileType(file))) score += 3;
  const haystack = normalizeWords([record.pattern, record.context, record.errorSignature, record.fixSummary].join(' '));
  for (const word of haystack) if (queryWords.has(word)) score += 1;
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
