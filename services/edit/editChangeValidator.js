import * as parser from '@babel/parser';
import traverseModule from '@babel/traverse';

const traverse = traverseModule.default || traverseModule;
const textPropertyNames = new Set(['text', 'title', 'label', 'name', 'heading', 'description', 'question', 'answer', 'placeholder']);

export function extractExactTextReplacement(message) {
  const match = String(message || '').match(/(?:change|replace|rename|update)[ ]+(?:the[ ]+)?(?:text[ ]+)?["'“]([^"'”]+)["'”][ ]+(?:to|with)[ ]+["'“]([^"'”]+)["'”]/i);
  if (!match || match[1] === match[2]) return null;
  return { from: match[1], to: match[2] };
}

export function createExactTextChanges(files, message) {
  const replacement = extractExactTextReplacement(message);
  if (!replacement) return { changes: [], handled: false };
  const candidates = [];
  for (const file of files) {
    if (!file.path.endsWith('.jsx') && !file.path.endsWith('.js')) continue;
    for (const range of findSafeTextRanges(file.content, replacement.from)) candidates.push({ file, range });
  }
  if (candidates.length !== 1) {
    return {
      changes: [],
      handled: true,
      clarification: candidates.length === 0
        ? 'I could not find the exact text “' + replacement.from + '” in the selected UI.'
        : 'I found “' + replacement.from + '” in multiple places. Please name the page or component to change.'
    };
  }
  const { file, range } = candidates[0];
  const content = file.content.slice(0, range.start) + range.prefix + replacement.to + range.suffix + file.content.slice(range.end);
  return {
    handled: true,
    changes: [{ path: file.path, changeType: 'update', content, reason: 'Replaced only the requested UI text.', addressesFindingIds: [] }]
  };
}

export function validateMinimalEditChanges(originalFiles, proposedChanges, message) {
  const byPath = new Map(originalFiles.map((file) => [file.path, String(file.content || '')]));
  const words = new Set(String(message || '').toLowerCase().match(/[a-z]+/g) || []);
  const contains = (values) => values.some((value) => words.has(value));
  const broadRequest = contains(['redesign', 'rewrite', 'rebuild', 'entire', 'whole', 'all', 'every', 'theme', 'layout']);
  const behaviorRepair = contains(['fix', 'working', 'navigate', 'navigation', 'tab', 'tabs', 'click', 'clickable', 'interaction', 'behavior']);
  const textOnly = contains(['text', 'copy', 'word', 'label', 'title', 'heading', 'rename', 'replace'])
    && !behaviorRepair
    && !broadRequest
    && !contains(['color', 'background', 'style', 'spacing', 'layout', 'font', 'size']);
  const errors = [];
  const meaningfulChanges = [];
  for (const change of proposedChanges || []) {
    if (change.operation === 'delete') continue;
    const before = byPath.get(change.path);
    const after = String(change.content || '');
    if (before === undefined || before === after) continue;
    meaningfulChanges.push({ path: change.path, before, after });
    const stats = lineDiffStats(before, after);
    const allowed = behaviorRepair
      ? Math.max(50, Math.ceil(stats.beforeLines * 1.75))
      : broadRequest
        ? Math.max(30, Math.ceil(stats.beforeLines * 0.75))
        : Math.max(12, Math.ceil(stats.beforeLines * 0.35));
    if (stats.changed > allowed) errors.push(change.path + ' changes ' + stats.changed + ' lines; the safe limit is ' + allowed + '.');
    if (!contains(['remove', 'delete']) && after.length < before.length * 0.6) errors.push(change.path + ' removes too much existing code.');
    if (textOnly && classNames(before).join('\n') !== classNames(after).join('\n')) errors.push(change.path + ' changes styling classes during a text-only edit.');
    if (textOnly && changedValueCount(uiTextValues(before), uiTextValues(after)) > 2) errors.push(change.path + ' changes neighboring UI text beyond the requested replacement.');
  }
  const navigationRepair = behaviorRepair && contains(['nav', 'navbar', 'navigation', 'tab', 'tabs']);
  if (navigationRepair && !meaningfulChanges.some(hasNavigationBehaviorChange)) {
    errors.push('The request asks to repair navigation, but the patch does not connect a tab to routing, a parent selection callback, or content-view state.');
  }
  if (navigationRepair && !hasNavigationDestination(meaningfulChanges)) {
    errors.push('The navigation patch does not change a route or conditionally render content for the selected tab.');
  }
  return { valid: errors.length === 0, errors };
}

function hasNavigationDestination(changes) {
  const changedContent = changes.map((change) => change.after).join('\n');
  return /<(?:NavLink|Link)\b|\buseNavigate\b|\bnavigate\s*\(/.test(changedContent)
    || /\b(?:active|selected|current)(?:Tab|View|Section)\s*===/.test(changedContent)
    || /switch\s*\(\s*(?:active|selected|current)(?:Tab|View|Section)\s*\)/.test(changedContent)
    || /\[(?:active|selected|current)(?:Tab|View|Section)\]/.test(changedContent);
}

function hasNavigationBehaviorChange(change) {
  if (!/src\/(?:App[.]jsx|components\/[^/]*(?:Nav|Sidebar)[^/]*[.]jsx|pages\/[^/]+[.]jsx)$/i.test(change.path)) return false;
  return navigationBehaviorSignature(change.before) !== navigationBehaviorSignature(change.after)
    && navigationBehaviorSignature(change.after).length > 0;
}

function navigationBehaviorSignature(content) {
  const value = String(content || '');
  const patterns = [
    /<(?:NavLink|Link)\b/g,
    /\buseNavigate\b/g,
    /\bnavigate\s*\(/g,
    /\bon(?:Navigate|Select|TabChange|ItemChange)\b/g,
    /\b(?:active|selected|current)(?:Tab|View|Section)\b/g,
    /\bset(?:Active|Selected|Current)(?:Tab|View|Section)\b/g,
    /window[.]location/g
  ];
  return patterns.map((pattern) => (value.match(pattern) || []).length).join(':');
}

function findSafeTextRanges(content, expected) {
  let ast;
  try { ast = parser.parse(String(content || ''), { sourceType: 'module', plugins: ['jsx'] }); }
  catch { return []; }
  const ranges = [];
  traverse(ast, {
    JSXText(pathRef) {
      addInnerRange(ranges, pathRef.node, expected);
    },
    StringLiteral(pathRef) {
      if (pathRef.node.value !== expected || !isSafeStringLiteral(pathRef)) return;
      const raw = content.slice(pathRef.node.start, pathRef.node.end);
      const quote = raw[0] === '"' || raw[0] === "'" ? raw[0] : "'";
      ranges.push({ start: pathRef.node.start, end: pathRef.node.end, prefix: quote, suffix: quote });
    }
  });
  return ranges;
}

function addInnerRange(ranges, node, expected) {
  const value = String(node.value || '');
  const index = value.indexOf(expected);
  if (index < 0 || value.indexOf(expected, index + expected.length) >= 0) return;
  ranges.push({ start: node.start, end: node.end, prefix: value.slice(0, index), suffix: value.slice(index + expected.length) });
}

function isSafeStringLiteral(pathRef) {
  const parent = pathRef.parentPath;
  if (parent?.isJSXExpressionContainer()) return true;
  if (parent?.isJSXAttribute()) return ['aria-label', 'title', 'placeholder', 'alt'].includes(parent.node.name?.name);
  if (!parent?.isObjectProperty() || parent.node.value !== pathRef.node) return false;
  const key = parent.node.key?.name || parent.node.key?.value;
  return textPropertyNames.has(String(key || '').toLowerCase());
}

function uiTextValues(content) {
  let ast;
  try { ast = parser.parse(String(content || ''), { sourceType: 'module', plugins: ['jsx'] }); }
  catch { return []; }
  const values = [];
  traverse(ast, {
    JSXText(pathRef) {
      const value = String(pathRef.node.value || '').trim();
      if (value) values.push(value);
    },
    StringLiteral(pathRef) {
      if (isSafeStringLiteral(pathRef) && pathRef.node.value) values.push(pathRef.node.value);
    }
  });
  return values;
}

function changedValueCount(before, after) {
  const remaining = [...after];
  let changed = 0;
  for (const value of before) {
    const index = remaining.indexOf(value);
    if (index >= 0) remaining.splice(index, 1);
    else changed += 1;
  }
  return changed + remaining.length;
}

function classNames(content) {
  let ast;
  try { ast = parser.parse(String(content || ''), { sourceType: 'module', plugins: ['jsx'] }); }
  catch { return []; }
  const values = [];
  traverse(ast, {
    JSXAttribute(pathRef) {
      if (pathRef.node.name?.name !== 'className') return;
      const value = pathRef.node.value;
      if (value?.type === 'StringLiteral') values.push(value.value);
      else if (value?.type === 'JSXExpressionContainer' && value.expression?.type === 'StringLiteral') values.push(value.expression.value);
      else values.push(content.slice(value?.start || pathRef.node.start, value?.end || pathRef.node.end));
    }
  });
  return values;
}

function lineDiffStats(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  const rows = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = 1; i <= a.length; i += 1) for (let j = 1; j <= b.length; j += 1) rows[i][j] = a[i - 1] === b[j - 1] ? rows[i - 1][j - 1] + 1 : Math.max(rows[i - 1][j], rows[i][j - 1]);
  const common = rows[a.length][b.length];
  return { beforeLines: a.length, changed: a.length + b.length - common * 2 };
}
