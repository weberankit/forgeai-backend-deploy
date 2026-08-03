import * as parser from '@babel/parser';
import traverseModule from '@babel/traverse';

const traverse = traverseModule.default || traverseModule;
const ignoredWords = new Set(['the', 'and', 'with', 'that', 'this', 'button', 'page', 'not', 'working', 'work', 'edit', 'change', 'make', 'add']);

export function buildEditInteractionIndex(files = []) {
  const index = {};
  for (const file of files || []) {
    if (!/\.(js|jsx)$/.test(file.path)) continue;
    index[file.path] = analyzeInteractions(file);
  }
  return index;
}

export function rankInteractionTargets(index, message, limit = 6) {
  const query = semanticTokens(message);
  if (!query.length) return [];
  return Object.entries(index || {}).map(([path, value]) => {
    const evidence = [...(value.labels || []), ...(value.routes || []), ...(value.handlers || []), ...(value.configValues || [])];
    let score = 0;
    const matches = [];
    for (const token of query) {
      for (const candidate of evidence.flatMap(semanticTokens)) {
        const similarity = tokenSimilarity(token, candidate);
        if (similarity < 0.72) continue;
        score += similarity >= 0.99 ? 12 : 8;
        matches.push(token + '≈' + candidate);
      }
    }
    if (/button|link|click|open|navigate/i.test(message) && (value.controls || []).length) score += 6;
    return { path, score, evidence: [...new Set(matches)].slice(0, 8), interactions: value };
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
}

function analyzeInteractions(file) {
  const result = { labels: [], routes: [], handlers: [], controls: [], configValues: [] };
  let ast;
  try { ast = parser.parse(String(file.content || ''), { sourceType: 'module', plugins: ['jsx'], errorRecovery: true }); }
  catch { return result; }
  traverse(ast, {
    JSXElement(ref) {
      const opening = ref.node.openingElement;
      const name = jsxName(opening.name);
      if (!/^(?:Button|Link|NavLink|button|a)$/.test(name)) return;
      const label = jsxText(ref.node.children).trim().replace(/\s+/g, ' ').slice(0, 160);
      const attributes = Object.fromEntries((opening.attributes || []).map((attr) => [attr.name?.name, attributeValue(attr.value)]).filter(([key]) => key));
      const route = attributes.to || attributes.href;
      const handler = attributes.onClick;
      if (label) result.labels.push(label);
      if (route) result.routes.push(route);
      if (handler) result.handlers.push(handler);
      result.controls.push({ type: name, label, route, handler });
    },
    CallExpression(ref) {
      const callee = ref.node.callee;
      const name = callee?.name || callee?.property?.name;
      if (!['navigate', 'push', 'replace'].includes(name)) return;
      const route = literalValue(ref.node.arguments?.[0]);
      if (route) result.routes.push(route);
    },
    ObjectProperty(ref) {
      const key = ref.node.key?.name || ref.node.key?.value;
      if (!['label', 'title', 'name', 'text', 'path', 'to', 'href', 'route'].includes(String(key))) return;
      const value = literalValue(ref.node.value);
      if (!value) return;
      result.configValues.push(value);
      if (['path', 'to', 'href', 'route'].includes(String(key))) result.routes.push(value);
      else result.labels.push(value);
    }
  });
  for (const key of ['labels', 'routes', 'handlers', 'configValues']) result[key] = [...new Set(result[key])].slice(0, 30);
  result.controls = result.controls.slice(0, 20);
  return result;
}

function jsxText(children = []) {
  return children.map((child) => {
    if (child.type === 'JSXText') return child.value;
    if (child.type === 'JSXExpressionContainer') return literalValue(child.expression) || '';
    if (child.type === 'JSXElement') return jsxText(child.children);
    return '';
  }).join(' ');
}

function attributeValue(value) {
  if (!value) return '';
  if (value.type === 'StringLiteral') return value.value;
  if (value.type !== 'JSXExpressionContainer') return '';
  return literalValue(value.expression) || expressionName(value.expression);
}

function literalValue(node) {
  if (!node) return '';
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0]?.value?.cooked || '';
  return '';
}

function expressionName(node) {
  if (!node) return '';
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'CallExpression') return expressionName(node.callee);
  if (node.type === 'ArrowFunctionExpression') return expressionName(node.body);
  if (node.type === 'MemberExpression') return [expressionName(node.object), expressionName(node.property)].filter(Boolean).join('.');
  return node.type || '';
}

function jsxName(node) {
  if (!node) return '';
  if (node.type === 'JSXIdentifier') return node.name;
  if (node.type === 'JSXMemberExpression') return jsxName(node.object) + '.' + jsxName(node.property);
  return '';
}

function semanticTokens(value) {
  return String(value || '').toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2 && !ignoredWords.has(word));
}

function tokenSimilarity(left, right) {
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.9;
  const distance = levenshtein(left, right);
  return 1 - distance / Math.max(left.length, right.length, 1);
}

function levenshtein(left, right) {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const saved = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (left[i - 1] === right[j - 1] ? 0 : 1));
      previous = saved;
    }
  }
  return row[right.length];
}
