import path from 'path';
import { runStaticValidation } from '../review/staticValidation.js';
import { runExplainGraph } from '../ai/langGraphAgent.js';

export async function explainProjectQuestion(project, question) {
  const files = project.generatedFiles || [];
  const graph = Object.keys(project.dependencyGraph || {}).length ? project.dependencyGraph : runStaticValidation(files).graph;
  const mode = explainMode(question);
  const relevant = expandRelevantFiles(selectRelevantFiles(files, graph, question, mode), files, graph, question, mode);
  const routeMap = extractRouteMap(files);
  const stateFlow = extractStateFlow(files, graph, question);
  const flow = buildFlow(relevant, graph, question);
  const functionDetails = buildFunctionDetails(relevant, graph);
  const codeContext = buildCodeContext(relevant, graph, question);
  const presentation = presentationFor(question, mode);
  const importantFiles = relevant.map((file) => ({ path: file.path, reason: reasonFor(file, question) }));
  const gaps = [];
  if (!relevant.length) gaps.push('No generated file directly matched the question.');
  for (const file of relevant) {
    const node = graph[file.path];
    if (node?.parseError) gaps.push(file.path + ' has a parse problem: ' + node.parseError);
    if (node?.missingImports?.length) gaps.push(file.path + ' has missing imports: ' + node.missingImports.join(', '));
  }
  const fallback = {
    title: titleFor(question, mode),
    mode,
    directAnswer: directAnswer(question, relevant, routeMap, mode),
    flow,
    functionDetails,
    codeContext,
    codeInsights: buildCodeInsights(codeContext),
    presentation,
    visualBlocks: buildVisualBlocks({ mode, relevant, graph, flow, functionDetails, codeContext }),
    stateFlow,
    importantFiles,
    confirmedFacts: confirmedFacts(relevant, graph, routeMap),
    inferences: inferFacts(question, relevant),
    gapsOrProblems: gaps
  };
  return runExplainGraph({
    question,
    graphSummary: buildGraphSummary({ files: relevant, graph, routeMap, stateFlow, question, mode, codeContext, presentation }),
    fallback
  }).catch(() => fallback);
}

function buildGraphSummary({ files, graph, routeMap, stateFlow, question, mode, codeContext = [], presentation = 'summary' }) {
  return {
    question,
    mode,
    routes: routeMap,
    stateFlow,
    presentation,
    codeContext,
    files: files.map((file) => {
      const node = graph[file.path] || {};
      return {
        path: file.path,
        exports: node.exports || [],
        imports: node.imports || [],
        importedBy: node.importedBy || [],
        renders: node.renders || [],
        functions: functionSummaries(file, node),
        eventHandlers: (node.eventHandlers || []).map((name) => ({ name, purpose: purposeForName(name) })),
        hasLocalStorage: String(file.content || '').includes('localStorage'),
        source: sourceForPrompt(file, question),
        sections: sourceSections(file.content),
        sample: String(file.content || '').slice(0, 700)
      };
    })
  };
}

function selectRelevantFiles(files, graph, question, mode = 'general') {
  const q = String(question || '').toLowerCase();
  const referenced = referencedFiles(files, question);
  const picked = new Map();
  for (const file of referenced) {
    picked.set(file.path, file);
    for (const imported of graph[file.path]?.imports || []) {
      const importedFile = files.find((item) => item.path === imported);
      if (importedFile && picked.size < 8) picked.set(importedFile.path, importedFile);
    }
    for (const importer of graph[file.path]?.importedBy || []) {
      const importerFile = files.find((item) => item.path === importer);
      if (importerFile && picked.size < 8) picked.set(importerFile.path, importerFile);
    }
  }
  if (picked.size) return Array.from(picked.values()).slice(0, 8);

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
    if ((mode === 'flow' || /route|flow|navigation/.test(q)) && file.path === 'src/App.jsx') score += 12;
    if (mode === 'code' && /\.(jsx|js)$/.test(file.path)) score += 3;
    if (/navbar|nav|sidebar|menu/.test(q) && /appshell|header|nav|sidebar/.test(filePath + content)) score += 8;
    if (/filter/.test(q) && /filter/.test(content)) score += 10;
    if (/dark|theme/.test(q) && /dark|theme|slate|black/.test(content)) score += 6;
    if (/todo|task/.test(q) && /todo|task/.test(content)) score += 6;
    if (score > 0) scored.push({ file, score });
  }
  scored.sort((a, b) => b.score - a.score);
  if (!scored.length && mode === 'code') {
    return defaultCodeWalkthroughFiles(files);
  }
  const scoredPicked = new Map();
  for (const item of scored.slice(0, 6)) {
    scoredPicked.set(item.file.path, item.file);
    for (const imported of graph[item.file.path]?.imports || []) {
      const importedFile = files.find((file) => file.path === imported);
      if (importedFile && scoredPicked.size < 8) scoredPicked.set(importedFile.path, importedFile);
    }
  }
  return Array.from(scoredPicked.values()).slice(0, 8);
}

function expandRelevantFiles(relevant, files, graph, question, mode = 'general') {
  const referenced = referencedFiles(files, question);
  if (referenced.length) return relevant;
  if (relevant.length) return mode === 'code' ? relevant.slice(0, 10) : relevant;
  const fallbackPaths = ['src/App.jsx', 'src/main.jsx'];
  const picked = new Map();
  for (const filePath of fallbackPaths) {
    const file = files.find((item) => item.path === filePath);
    if (file) picked.set(file.path, file);
    for (const imported of graph[filePath]?.imports || []) {
      const importedFile = files.find((item) => item.path === imported);
      if (importedFile && picked.size < 8) picked.set(importedFile.path, importedFile);
    }
  }
  if (!picked.size) {
    for (const file of files.filter((item) => /\.(jsx|js)$/.test(item.path)).slice(0, 8)) picked.set(file.path, file);
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

function buildFunctionDetails(files, graph) {
  return files.flatMap((file) => {
    const node = graph[file.path] || {};
    const functions = [
      ...(node.localFunctions || []).map((name) => ({ name, kind: 'function', purpose: purposeForName(name), usedFor: usageForFunction(file, name) })),
      ...(node.eventHandlers || []).map((name) => ({ name, kind: 'event handler', purpose: purposeForName(name), usedFor: 'handles user interaction in ' + file.path }))
    ];
    return functions.map((item) => ({
      file: file.path,
      name: item.name,
      kind: item.kind,
      purpose: item.purpose,
      usedFor: item.usedFor,
      connectedTo: [...(node.renders || []), ...(node.imports || [])].slice(0, 6)
    }));
  }).slice(0, 16);
}

function buildCodeContext(files, graph, question) {
  const detailed = /detail|deep|code|function|line|inside|why|how/i.test(String(question || ''));
  return files.slice(0, detailed ? 6 : 4).map((file) => {
    const node = graph[file.path] || {};
    return {
      path: file.path,
      language: file.language || languageFor(file.path),
      exports: node.exports || [],
      imports: node.imports || [],
      renderedSymbols: node.renders || [],
      localFunctions: node.localFunctions || [],
      eventHandlers: node.eventHandlers || [],
      source: sourceForPrompt(file, question),
      sections: sourceSections(file.content)
    };
  });
}

function sourceForPrompt(file, question) {
  const content = String(file.content || '');
  const q = String(question || '').toLowerCase();
  const wantsFull = /full|entire|all code|complete file|line by line|deep|detail/i.test(q);
  const directlyReferenced = referencedFiles([file], question).length > 0;
  const limit = wantsFull || directlyReferenced ? 9000 : 3200;
  if (content.length <= limit) return content;
  return content.slice(0, limit) + '\n/* ...source truncated for prompt budget... */';
}

function buildCodeInsights(codeContext) {
  return (codeContext || []).map((item) => ({
    file: item.path,
    summary: insightSummary(item),
    keyParts: [
      ...(item.exports || []).slice(0, 4).map((name) => ({ name, kind: 'export', does: 'is exported from this module', uses: item.renderedSymbols || [] })),
      ...(item.localFunctions || []).slice(0, 5).map((name) => ({ name, kind: 'function', does: purposeForName(name), uses: [] })),
      ...(item.eventHandlers || []).slice(0, 5).map((name) => ({ name, kind: 'event handler', does: purposeForName(name), uses: [] }))
    ].slice(0, 8),
    importantLines: importantSourceHints(item.source),
    sections: item.sections || [],
    connections: [...(item.imports || []), ...(item.renderedSymbols || [])].slice(0, 8)
  })).slice(0, 8);
}

function insightSummary(item) {
  const pieces = [];
  if (item.exports?.length) pieces.push('exports ' + item.exports.join(', '));
  if (item.renderedSymbols?.length) pieces.push('renders ' + item.renderedSymbols.join(', '));
  if (item.localFunctions?.length) pieces.push('defines helper logic such as ' + item.localFunctions.slice(0, 4).join(', '));
  if (item.eventHandlers?.length) pieces.push('handles interaction through ' + item.eventHandlers.slice(0, 4).join(', '));
  if (item.imports?.length) pieces.push('depends on ' + item.imports.slice(0, 4).join(', '));
  if (item.sections?.length) pieces.push('code structure includes ' + item.sections.slice(0, 5).map((section) => section.label).join(', '));
  return pieces.length ? pieces.join('; ') + '.' : 'This file contributes UI/source behavior for the generated app.';
}

function defaultCodeWalkthroughFiles(files) {
  const priority = ['src/App.jsx', 'src/main.jsx', 'src/index.css'];
  const picked = new Map();
  for (const filePath of priority) {
    const file = files.find((item) => item.path === filePath);
    if (file) picked.set(file.path, file);
  }
  for (const file of files) {
    if (!/\.(jsx|js|css)$/.test(file.path)) continue;
    if (/src\/(components|pages|routes|layouts)\//.test(file.path)) picked.set(file.path, file);
    if (picked.size >= 10) break;
  }
  if (!picked.size) {
    for (const file of files.filter((item) => /\.(jsx|js|css)$/.test(item.path)).slice(0, 10)) picked.set(file.path, file);
  }
  return Array.from(picked.values()).slice(0, 10);
}

function sourceSections(source) {
  const text = String(source || '');
  const sections = [];
  if (/^import\s/m.test(text)) sections.push({ label: 'imports', explanation: 'brings in React, libraries, styles, or local components used by this file' });
  if (/export\s+default|export\s+function|export\s+const/m.test(text)) sections.push({ label: 'exports', explanation: 'exposes the component/module so another file can render or import it' });
  if (/useState\s*\(/.test(text)) sections.push({ label: 'state', explanation: 'stores local UI values that can change after user interaction' });
  if (/useEffect\s*\(/.test(text)) sections.push({ label: 'effects', explanation: 'runs lifecycle or synchronization logic after render' });
  if (/function\s+handle|const\s+handle|onClick|onSubmit|onChange/.test(text)) sections.push({ label: 'events', explanation: 'connects user actions such as clicks, typing, or form submits to logic' });
  if (/return\s*\(|<main|<section|<div/.test(text)) sections.push({ label: 'rendered JSX', explanation: 'defines the visible UI structure shown in the preview' });
  if (/className=|style=|@tailwind|background|color|padding|grid|flex/.test(text)) sections.push({ label: 'styling', explanation: 'controls layout, spacing, color, and responsive appearance' });
  if (/\.map\(/.test(text)) sections.push({ label: 'lists', explanation: 'turns arrays of data into repeated UI elements' });
  if (/\.filter\(/.test(text)) sections.push({ label: 'filtering', explanation: 'narrows data before it is rendered' });
  return sections.slice(0, 8);
}

function importantSourceHints(source) {
  const text = String(source || '');
  const hints = [];
  if (/useState/.test(text)) hints.push('uses useState for local UI state');
  if (/useEffect/.test(text)) hints.push('uses useEffect for lifecycle or derived behavior');
  if (/localStorage/.test(text)) hints.push('reads or writes localStorage');
  if (/\.map\(/.test(text)) hints.push('maps data into rendered UI elements');
  if (/\.filter\(/.test(text)) hints.push('filters data before rendering');
  if (/onClick|onSubmit|onChange/.test(text)) hints.push('contains user event wiring');
  return hints.slice(0, 6);
}

function presentationFor(question, mode) {
  const q = String(question || '').toLowerCase();
  if (/diagram|visual|map|graph|tree/.test(q)) return 'graph';
  if (/flow|journey|sequence|step by step|end to end/.test(q)) return 'flow';
  if (/file|where|which/.test(q) || mode === 'file') return 'file-deep-dive';
  if (/code|function|handler|component|line|detail|inside/.test(q) || mode === 'code') return 'code-walkthrough';
  if (/why|decision|reason/.test(q)) return 'reasoning';
  return 'summary';
}

function buildVisualBlocks({ mode, relevant, graph, flow, functionDetails, codeContext }) {
  const blocks = [];
  if (flow.length) {
    blocks.push({ type: 'flow', title: 'Runtime path', items: flow.slice(0, 8) });
  }
  if (functionDetails.length) {
    blocks.push({ type: 'functions', title: 'Functions and handlers', items: functionDetails.slice(0, 12) });
  }
  if (codeContext.length) {
    blocks.push({
      type: 'files',
      title: mode === 'file' ? 'Referenced file context' : 'Code context used',
      items: codeContext.map((item) => ({
        path: item.path,
        exports: item.exports,
        imports: item.imports,
        functions: item.localFunctions,
        handlers: item.eventHandlers
      }))
    });
  }
  if (relevant.length) {
    blocks.push({
      type: 'connections',
      title: 'File connections',
      items: relevant.map((file) => ({
        file: file.path,
        imports: graph[file.path]?.imports || [],
        importedBy: graph[file.path]?.importedBy || []
      })).slice(0, 8)
    });
  }
  return blocks;
}

function languageFor(filePath) {
  if (/\.css$/i.test(filePath)) return 'css';
  if (/\.json$/i.test(filePath)) return 'json';
  return 'jsx';
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

function directAnswer(question, files, routeMap, mode = 'general') {
  if (!files.length) return 'I could not confirm this from the generated files.';
  const paths = files.slice(0, 3).map((file) => file.path).join(', ');
  if (mode === 'flow') return 'Here is the runtime flow through the generated app, grounded in the file graph: ' + paths + '.';
  if (mode === 'code') return 'Here is a code-level explanation of the relevant files, including exports, functions, event handlers, imports, and rendered components: ' + paths + '.';
  if (/which file|where/.test(String(question).toLowerCase())) return 'The most relevant generated file(s) are: ' + paths + '.';
  if (/route/.test(String(question).toLowerCase()) && routeMap.length) return 'Routes are configured in src/App.jsx and render: ' + routeMap.map((route) => route.path + ' -> ' + route.component).join(', ') + '.';
  return 'This is handled primarily by ' + paths + ', based on real generated file content and import relationships.';
}

function explainFile(file, node, question) {
  const parts = [];
  const detailed = /detail|deep|function|line|full|inside/i.test(String(question || ''));
  if (detailed && node.localFunctions?.length) parts.push('functions ' + node.localFunctions.map((name) => name + ' (' + purposeForName(name) + ')').join(', '));
  if (detailed && node.eventHandlers?.length) parts.push('event handlers ' + node.eventHandlers.map((name) => name + ' (' + purposeForName(name) + ')').join(', '));
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

function reasonFor(file, question) {
  if (referencedFiles([file], question).length) return 'The question directly referenced this file name/path.';
  return 'Matched the question via filename, rendered symbols, route wiring, or text content.';
}

function referencedFiles(files, question) {
  const q = String(question || '').toLowerCase();
  return (files || []).filter((file) => {
    const full = String(file.path || '').toLowerCase();
    const base = path.posix.basename(full);
    const noExt = base.replace(/\.(jsx|js|css|json|html)$/i, '');
    return q.includes(full) || q.includes(base) || (noExt.length > 2 && q.includes(noExt));
  });
}

function functionSummaries(file, node) {
  return (node.localFunctions || []).map((name) => ({
    name,
    purpose: purposeForName(name),
    usedFor: usageForFunction(file, name)
  }));
}

function usageForFunction(file, name) {
  const content = String(file.content || '');
  const uses = [];
  if (new RegExp('on[A-Z][A-Za-z0-9_]*=\{?' + name).test(content)) uses.push('wired to a UI event');
  if (content.includes(name + '(')) uses.push('called inside the module');
  if (/localStorage/.test(content)) uses.push('part of persisted browser state');
  if (/filter|map|reduce|sort/i.test(name + content.slice(0, 1000))) uses.push('transforms rendered data');
  return uses.length ? uses.join(', ') : 'local helper/component logic';
}

function purposeForName(name) {
  const value = String(name || 'function');
  if (/handle|on[A-Z]/.test(value)) return 'responds to a user interaction';
  if (/filter/i.test(value)) return 'filters visible data';
  if (/sort/i.test(value)) return 'sorts visible data';
  if (/toggle/i.test(value)) return 'toggles UI state';
  if (/submit|save/i.test(value)) return 'submits or saves user input';
  if (/load|fetch/i.test(value)) return 'loads data for the UI';
  if (/render|component|page|app/i.test(value)) return 'renders UI';
  return "supports this file's UI behavior";
}
function explainMode(question) {
  const q = String(question || '').toLowerCase();
  if (/\b(flow|journey|sequence|step by step|end to end|runtime|navigation|route)\b/.test(q)) return 'flow';
  if (/\b(code|function|handler|component|logic|detail|inside|line|export|import)\b/.test(q)) return 'code';
  if (/\.(jsx|js|css|json|html)\b/.test(q)) return 'file';
  return 'general';
}
function titleFor(question, mode = 'general') {
  const cleaned = String(question || 'Generated app explanation').replace(/[?.!]+$/, '').slice(0, 70);
  if (mode === 'flow') return 'Flow: ' + cleaned;
  if (mode === 'code') return 'Code explanation: ' + cleaned;
  if (mode === 'file') return 'File explanation: ' + cleaned;
  return cleaned;
}
function componentName(filePath) { return path.posix.basename(filePath).replace(/\.(jsx|js|css)$/, ''); }
function tokens(text) { return String(text || '').split(/[^a-z0-9]+/).filter((token) => token.length > 2 && !['how','does','the','this','that','where','which','file','work','works','explain'].includes(token)); }
function dedupeState(states) { const map = new Map(); for (const state of states) map.set(state.state + state.definedIn, state); return Array.from(map.values()); }
