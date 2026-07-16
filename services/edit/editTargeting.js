export function resolveEditTargets(project, message) {
  const text = String(message || '').toLowerCase();
  const files = project.generatedFiles || [];
  const scored = [];
  for (const file of files) {
    if (!/\.(jsx|js|css)$/.test(file.path)) continue;
    let score = 0;
    const lowerPath = file.path.toLowerCase();
    const lowerContent = String(file.content || '').toLowerCase();
    for (const token of tokens(text)) {
      if (lowerPath.includes(token)) score += 4;
      if (lowerContent.includes(token)) score += 2;
    }
    if (/hero/.test(text) && lowerContent.includes('section')) score += 5;
    if (/navbar|nav|menu/.test(text) && /nav|menu|appshell|header/.test(lowerPath + lowerContent)) score += 6;
    if (/pricing/.test(text) && /pricing/.test(lowerPath + lowerContent)) score += 8;
    if (/dark/.test(text) && file.path === 'src/App.jsx') score += 2;
    if (score > 0) scored.push({ path: file.path, score, reasons: [] });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 5);
  if (!top.length) return { confidence: 'low', targets: ['src/App.jsx'], needsClarification: false };
  if (/summary|card|progress|completed/.test(text)) {
    const targets = files.filter((file) => /src\/(components\/DataCard|pages\/).*\.jsx$/.test(file.path)).map((file) => file.path);
    if (targets.length) return { confidence: 'high', targets: targets.slice(0, 6), needsClarification: false };
  }
  if (/hero|section|dark|pricing/.test(text)) {
    const pageTargets = files.filter((file) => file.path.startsWith('src/pages/') && /\.jsx$/.test(file.path)).map((file) => file.path);
    if (pageTargets.length) return { confidence: 'medium', targets: pageTargets.slice(0, 4), needsClarification: false };
  }
  if (top.length > 1 && top[0].score === top[1].score && top[0].score < 8) return { confidence: 'low', targets: top.map((item) => item.path), needsClarification: true };
  const graph = project.dependencyGraph || {};
  const dependents = new Set(top.slice(0, 2).map((item) => item.path));
  for (const item of top.slice(0, 2)) for (const parent of graph[item.path]?.importedBy || []) dependents.add(parent);
  return { confidence: top[0].score >= 8 ? 'high' : 'medium', targets: Array.from(dependents).slice(0, 8), needsClarification: false };
}
function tokens(text) { return text.split(/[^a-z0-9]+/).filter((token) => token.length > 2 && !['the','and','use','with','make','add','remove','change','update'].includes(token)); }
