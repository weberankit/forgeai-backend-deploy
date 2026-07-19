export function resolveEditTargets(project, message) {
  const text = String(message || '').toLowerCase();
  const files = project.generatedFiles || [];
  const graph = project.dependencyGraph || {};
  const messageTokens = tokens(text);
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
    if (/dark|theme|global style|font/.test(text) && /src\/(index\.css|styles\/)/.test(lowerPath)) { score += 9; reasons.push('global-style'); }
    if (score > 0) scored.push({ path: file.path, score, reasons: [...new Set(reasons)] });
  }
  scored.sort((a, b) => b.score - a.score);
  const seeds = scored.slice(0, 4);
  const targets = new Set(seeds.map((item) => item.path));
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
    confidence: seeds[0]?.score >= 12 ? 'high' : seeds.length ? 'medium' : 'low',
    targets: [...targets].slice(0, 8),
    candidates: seeds,
    needsClarification: false
  };
}
function tokens(text) { return text.split(/[^a-z0-9]+/).filter((token) => token.length > 2 && !['the','and','use','with','make','add','remove','change','update','please','this','that','into','from','should','would','could'].includes(token)); }
