import path from 'path';
import { runStaticValidation } from '../review/staticValidation.js';

export async function explainProjectQuestion(project, question) {
  const files = project.generatedFiles || [];
  const validation = runStaticValidation(files);
  const graph = Object.keys(project.dependencyGraph || {}).length ? project.dependencyGraph : validation.graph;
  const relevant = selectRelevantFiles(files, graph, question);
  const routeMap = extractRouteMap(files);
  const stateFlow = extractStateFlow(files, graph, question);
  const flow = buildFlow(relevant, graph, question);
  const importantFiles = relevant.map((file) => ({ path: file.path, reason: reasonFor(file, question) }));
  const gaps = [];
  if (!relevant.length) gaps.push('No generated file directly matched the question.');
  for (const file of relevant) {
    const node = graph[file.path];
    if (node?.parseError) gaps.push(file.path + ' has a parse problem: ' + node.parseError);
    if (node?.missingImports?.length) gaps.push(file.path + ' has missing imports: ' + node.missingImports.join(', '));
  }
  return {
    title: titleFor(question),
    directAnswer: directAnswer(question, relevant, routeMap),
    flow,
    stateFlow,
    importantFiles,
    confirmedFacts: confirmedFacts(relevant, graph, routeMap),
    inferences: inferFacts(question, relevant),
    gapsOrProblems: gaps
  };
}

function selectRelevantFiles(files, graph, question) {
  const q = String(question || '').toLowerCase();
  const scored = [];
  for (const file of files) {
    if (!/\.(jsx|js|css)$/.test(file.path)) continue;
    const content = String(file.content || '').toLowerCase();
    const filePath = file.path.toLowerCase();
    let score = 0;
    for (const token of tokens(q)) {
      if (filePath.includes(token)) score += 5;
      if (content.includes(token)) score += 3;
      if ((graph[file.path]?.exports || []).some((symbol) => symbol.toLowerCase().includes(token))) score += 4;
      if ((graph[file.path]?.renders || []).some((symbol) => symbol.toLowerCase().includes(token))) score += 4;
    }
    if (/route|flow|navigation/.test(q) && file.path === 'src/App.jsx') score += 10;
    if (/navbar|nav|sidebar|menu/.test(q) && /appshell|header|nav|sidebar/.test(filePath + content)) score += 8;
    if (/filter/.test(q) && /filter/.test(content)) score += 10;
    if (/dark|theme/.test(q) && /dark|theme|slate|black/.test(content)) score += 6;
    if (/todo|task/.test(q) && /todo|task/.test(content)) score += 6;
    if (score > 0) scored.push({ file, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const picked = new Map();
  for (const item of scored.slice(0, 6)) {
    picked.set(item.file.path, item.file);
    for (const imported of graph[item.file.path]?.imports || []) {
      const importedFile = files.find((file) => file.path === imported);
      if (importedFile && picked.size < 8) picked.set(importedFile.path, importedFile);
    }
  }
  return Array.from(picked.values()).slice(0, 8);
}

function buildFlow(files, graph, question) {
  return files.map((file, index) => {
    const node = graph[file.path] || {};
    return {
      step: index + 1,
      file: file.path,
      symbol: (node.exports || [componentName(file.path)])[0] || componentName(file.path),
      explanation: explainFile(file, node, question),
      callsOrRenders: [...(node.renders || []), ...(node.imports || [])].slice(0, 8)
    };
  });
}

function extractRouteMap(files) {
  const app = files.find((file) => file.path === 'src/App.jsx');
  if (!app) return [];
  const routes = [];
  const regex = /<Route\s+path=["']([^"']+)["']\s+element=\{<([A-Za-z0-9_]+)/g;
  let match;
  while ((match = regex.exec(app.content))) routes.push({ path: match[1], component: match[2], file: 'src/App.jsx' });
  return routes;
}

function extractStateFlow(files, graph, question) {
  const q = String(question || '').toLowerCase();
  const states = [];
  for (const file of files) {
    const content = String(file.content || '');
    const stateRegex = /useState\(([^)]*)\)/g;
    if (stateRegex.test(content)) states.push({ state: 'local component state', definedIn: file.path, updatedBy: graph[file.path]?.eventHandlers || [], consumedBy: [file.path], persistence: content.includes('localStorage') ? 'localStorage' : 'redux-runtime' });
    if (content.includes('localStorage')) states.push({ state: q.includes('theme') ? 'theme' : 'persisted frontend data', definedIn: file.path, updatedBy: graph[file.path]?.eventHandlers || [], consumedBy: [file.path], persistence: 'localStorage' });
    if (/createSlice|configureStore|Provider/.test(content)) states.push({ state: 'redux state', definedIn: file.path, updatedBy: [], consumedBy: graph[file.path]?.importedBy || [], persistence: 'redux-runtime' });
  }
  return dedupeState(states).slice(0, 6);
}

function directAnswer(question, files, routeMap) {
  if (!files.length) return 'I could not confirm this from the generated files.';
  const paths = files.slice(0, 3).map((file) => file.path).join(', ');
  if (/which file|where/.test(String(question).toLowerCase())) return 'The most relevant generated file(s) are: ' + paths + '.';
  if (/route/.test(String(question).toLowerCase()) && routeMap.length) return 'Routes are configured in src/App.jsx and render: ' + routeMap.map((route) => route.path + ' -> ' + route.component).join(', ') + '.';
  return 'This is handled primarily by ' + paths + ', based on real generated file content and import relationships.';
}

function explainFile(file, node, question) {
  const parts = [];
  if (node.exports?.length) parts.push('exports ' + node.exports.join(', '));
  if (node.renders?.length) parts.push('renders ' + node.renders.join(', '));
  if (node.imports?.length) parts.push('imports ' + node.imports.join(', '));
  if (file.content.includes('localStorage')) parts.push('uses localStorage');
  return parts.length ? parts.join('; ') + '.' : 'Relevant content appears in this file.';
}

function confirmedFacts(files, graph, routeMap) {
  const facts = [];
  if (routeMap.length) facts.push('Routes were parsed from src/App.jsx.');
  for (const file of files.slice(0, 4)) {
    const node = graph[file.path] || {};
    if (node.imports?.length) facts.push(file.path + ' imports ' + node.imports.join(', ') + '.');
    if (node.renders?.length) facts.push(file.path + ' renders ' + node.renders.join(', ') + '.');
  }
  return facts.slice(0, 8);
}

function inferFacts(question, files) {
  const inferences = [];
  if (/dark|theme/.test(String(question).toLowerCase()) && files.some((file) => /slate|black|dark/.test(file.content))) inferences.push('Theme behavior is inferred from styling classes because no explicit theme store may exist.');
  if (/filter/.test(String(question).toLowerCase())) inferences.push('Filtering behavior is inferred from matching text and component structure, not from executing the app.');
  return inferences;
}

function reasonFor(file, question) { return 'Matched the question via filename, rendered symbols, route wiring, or text content.'; }
function titleFor(question) { return String(question || 'Generated app explanation').replace(/[?.!]+$/, '').slice(0, 80); }
function componentName(filePath) { return path.posix.basename(filePath).replace(/\.(jsx|js|css)$/, ''); }
function tokens(text) { return String(text || '').split(/[^a-z0-9]+/).filter((token) => token.length > 2 && !['how','does','the','this','that','where','which','file','work','works','explain'].includes(token)); }
function dedupeState(states) { const map = new Map(); for (const state of states) map.set(state.state + state.definedIn, state); return Array.from(map.values()); }
