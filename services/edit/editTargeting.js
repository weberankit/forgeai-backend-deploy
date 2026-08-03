import { buildEditInteractionIndex, rankInteractionTargets } from './editInteractionIndex.js';

export function resolveEditTargets(project, message) {
  const text = normalizeEditMessage(message);
  const files = project.generatedFiles || [];
  const graph = project.dependencyGraph || {};
  const messageTokens = tokens(text);
  const explicitTargets = inferExplicitTargets(project, files, text);
  const interactionCandidates = rankInteractionTargets(buildEditInteractionIndex(files), text);
  for (const candidate of interactionCandidates) candidate.reasons = (candidate.evidence || []).map((value) => 'interaction:' + value);
  const scored = [];
  for (const file of files) {
    if (!/\.(jsx|js|css)$/.test(file.path)) continue;
    let score = 0;
    const reasons = [];
    const lowerPath = file.path.toLowerCase();
    const lowerContent = String(file.content || '').toLowerCase();
    const node = graph[file.path] || {};
    const astSymbols = [
      ...(node.exports || []),
      ...(node.localFunctions || []),
      ...(node.eventHandlers || []),
      ...(node.renders || []),
      ...Object.values(node.importedSymbols || {}).flat()
    ].map((value) => String(value).toLowerCase());
    for (const token of messageTokens) {
      if (lowerPath.includes(token)) { score += 8; reasons.push('path:' + token); }
      if (astSymbols.some((symbol) => symbol.includes(token))) { score += 7; reasons.push('ast:' + token); }
      if (lowerContent.includes(token)) { score += 2; reasons.push('content:' + token); }
    }
    if (/hero/.test(text) && lowerContent.includes('section')) { score += 5; reasons.push('hero-section'); }
    if (/navbar|nav|menu|header/.test(text) && /nav|menu|appshell|header/.test(lowerPath + lowerContent)) { score += 8; reasons.push('navigation'); }
    if (/footer/.test(text) && /footer/.test(lowerPath + lowerContent)) { score += 8; reasons.push('footer'); }
    if (/pricing/.test(text) && /pricing/.test(lowerPath + lowerContent)) { score += 8; reasons.push('pricing'); }
    if (/dark|theme|global style|font|color|colorful|attractive/.test(text) && /src\/(index\.css|styles\/)/.test(lowerPath)) { score += 9; reasons.push('global-style'); }
    if (score > 0) scored.push({ path: file.path, score, reasons: [...new Set(reasons)] });
  }
  scored.sort((a, b) => b.score - a.score);
  const seeds = scored.slice(0, 4);
  const targets = new Set(explicitTargets);
  for (const candidate of interactionCandidates.slice(0, 3)) targets.add(candidate.path);
  for (const seed of seeds) targets.add(seed.path);
  if (!targets.size) {
    for (const filePath of project.lastChangedFiles || []) if (files.some((file) => file.path === filePath)) targets.add(filePath);
    if (files.some((file) => file.path === 'src/App.jsx')) targets.add('src/App.jsx');
    for (const file of files.filter((item) => item.path.startsWith('src/pages/') && /\.jsx$/.test(item.path)).slice(0, 3)) targets.add(file.path);
  }
  for (const seed of [...targets]) {
    for (const related of [...(graph[seed]?.imports || []), ...(graph[seed]?.importedBy || [])]) {
      if (/\.(jsx|js|css)$/.test(related)) targets.add(related);
      if (targets.size >= 8) break;
    }
    if (targets.size >= 8) break;
  }
  return {
    confidence: explicitTargets.length || interactionCandidates[0]?.score >= 12 || seeds[0]?.score >= 12 ? 'high' : seeds.length || interactionCandidates.length ? 'medium' : 'low',
    targets: [...targets].slice(0, 8),
    editableTargets: [...new Set([...explicitTargets, ...interactionCandidates.slice(0, 3).map((item) => item.path), ...seeds.map((item) => item.path)])].slice(0, 6),
    candidates: [...interactionCandidates, ...seeds].slice(0, 8),
    interactionEvidence: interactionCandidates.slice(0, 6),
    ...inferCreationRequest(project, text),
    needsClarification: false
  };
}
function normalizeEditMessage(message) {
  return String(message || '').toLowerCase()
    .replace(/\bhomw\b/g, 'home')
    .replace(/\bmyimge\b/g, 'my image')
    .replace(/\bandalso\b/g, 'and also')
    .replace(/\battrative\b/g, 'attractive')
    .replace(/\bcolourfull?\b/g, 'colorful')
    .replace(/\bcolour\b/g, 'color');
}

function inferExplicitTargets(project, files, text) {
  const available = new Set(files.map((file) => file.path));
  const targets = [];
  const add = (filePath) => { if (available.has(filePath) && !targets.includes(filePath)) targets.push(filePath); };

  if (/\bhome(?:\s+page)?\b|\bhomepage\b/.test(text)) {
    const rootComponent = (project.blueprint?.routes || []).find((route) => route.path === '/')?.component;
    const preferredNames = [rootComponent, 'Home', 'HomePage', 'LandingPage'].filter(Boolean).map((name) => String(name).toLowerCase());
    for (const file of files) {
      if (!/^src\/pages\/.*\.jsx$/.test(file.path)) continue;
      const basename = file.path.split('/').pop().replace(/\.jsx$/, '').toLowerCase();
      if (preferredNames.includes(basename)) add(file.path);
    }
  }

  if (/color|colorful|attractive|theme|font|background/.test(text)) {
    add('src/index.css');
    for (const file of files) if (/^src\/styles\/.*\.(js|css)$/.test(file.path)) add(file.path);
  }
  return targets;
}

function inferCreationRequest(project, text) {
  const match = text.match(/\b(?:add|create|build|make)\s+(?:a\s+|an\s+|new\s+)*(?:new\s+)?([a-z][a-z0-9 -]{1,40}?)\s+page\b/i);
  if (!match) return { creationIntent: false, creatableFiles: [] };
  const words = match[1].trim().split(/\s+/).filter(Boolean);
  const component = words.map((word) => word[0].toUpperCase() + word.slice(1)).join('');
  const filePath = 'src/pages/' + component + '.jsx';
  const exists = (project.generatedFiles || []).some((file) => file.path === filePath);
  return {
    creationIntent: !exists,
    creatableFiles: exists ? [] : [filePath],
    requestedRoute: '/' + words.join('-').toLowerCase()
  };
}

function tokens(text) { return text.split(/[^a-z0-9]+/).filter((token) => token.length > 2 && !['the','and','use','with','make','add','remove','change','update','please','this','that','into','from','should','would','could','page','wanted','also'].includes(token)); }
