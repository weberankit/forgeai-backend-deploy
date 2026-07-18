export function createPageFallbackChanges(targetFiles, message) {
  const details = pageDetails(message);
  if (!details) return [];
  const pagePath = 'src/pages/' + details.component + '.jsx';
  if (targetFiles.some((file) => file.path === pagePath)) return [];
  const router = targetFiles.find((file) => /<Routes[ >]/.test(file.content) && file.path === 'src/App.jsx')
    || targetFiles.find((file) => /<Routes[ >]/.test(file.content))
    || targetFiles.find((file) => /const\s+routes\s*=|createBrowserRouter/i.test(file.content));
  if (!router) return [];
  const importPath = relativeImport(router.path, pagePath);
  let routerContent = String(router.content || '');
  const importLine = "import " + details.component + " from '" + importPath + "';\n";
  if (!routerContent.includes(importLine.trim())) routerContent = importLine + routerContent;
  if (/<Routes[ >]/.test(routerContent)) {
    const routeLine = '          <Route path="' + details.route + '" element={<' + details.component + ' />} />';
    if (routerContent.includes('<Route path="*"')) routerContent = routerContent.replace('<Route path="*"', routeLine + '\n          <Route path="*"');
    else routerContent = routerContent.replace('</Routes>', routeLine + '\n        </Routes>');
    if (routerContent.includes('const navItems = [') && !routerContent.includes("path: '" + details.route + "'") && !routerContent.includes('"path": "' + details.route + '"')) routerContent = routerContent.replace('const navItems = [', "const navItems = [\n  { label: '" + details.label + "', path: '" + details.route + "' },");
  } else {
    const routeEntry = "  {\n    path: '" + details.route + "',\n    component: " + details.component + ",\n  },\n";
    routerContent = routerContent.replace(/const\s+routes\s*=\s*\[/, (match) => match + '\n' + routeEntry);
  }
  const requestedLayout = /layout|dashboard/i.test(message) ? targetFiles.find((file) => file.path.startsWith('src/layouts/') && file.path.endsWith('.jsx')) : null;
  const layoutName = requestedLayout ? requestedLayout.path.split('/').pop().replace('.jsx', '') : '';
  const layoutImport = requestedLayout ? "import " + layoutName + " from '" + relativeImport(pagePath, requestedLayout.path) + "';\n\n" : '';
  const pageContent = layoutImport + [
    'export default function ' + details.component + '() {',
    '  return (',
    requestedLayout ? '    <' + layoutName + '>' : '',
    '      <section className="space-y-4">',
    '        <h1 className="text-3xl font-bold tracking-tight">' + details.label + '</h1>',
    '        <p className="text-slate-600">Welcome to the ' + details.label + ' page.</p>',
    '      </section>',
    requestedLayout ? '    </' + layoutName + '>' : '',
    '  );',
    '}',
    ''
  ].filter(Boolean).join('\n');
  const changes = [
    { operation: 'create', path: pagePath, content: pageContent, reason: 'Created the ' + details.label + ' page.' },
    { operation: 'update', path: router.path, content: routerContent, reason: 'Registered ' + details.route + ' in the existing router.' }
  ];
  if (/nav|menu|link|include/i.test(message)) {
    for (const navigation of targetFiles.filter((file) => file.path !== router.path && /<(NavLink|Link)[ >]/.test(file.content))) {
      const content = addNavigationLink(navigation.content, details);
      if (content !== navigation.content) changes.push({ operation: 'update', path: navigation.path, content, reason: 'Added the ' + details.label + ' navigation link.' });
    }
  }
  return changes;
}

function pageDetails(message) {
  const text = String(message || '').trim();
  const explicitRoute = text.match(/(?:at|route)\s+(\/[a-z0-9/_-]+)/i)?.[1];
  const patterns = [
    /(?:add|create|make|build)\s+(?:me\s+)?(?:a\s+)?(?:new\s+)?([A-Za-z][A-Za-z0-9 _-]*?)\s+(?:page|screen|view|route)(?:[ .,]|$)/i,
    /(?:page|screen|view)\s+(?:named|called|for)\s+["']?([A-Za-z][A-Za-z0-9 _-]*?)["']?(?:[ .,]|$)/i
  ];
  const fillers = new Set(['a', 'new', 'the', 'page', 'screen', 'route', 'view']);
  let rawName = patterns.map((pattern) => text.match(pattern)?.[1]?.trim()).find((value) => value && !fillers.has(value.toLowerCase())) || '';
  if (!rawName && explicitRoute) rawName = explicitRoute.split('/').filter(Boolean).pop() || '';
  if (!rawName) return null;
  const words = rawName.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const label = words.map(capitalize).join(' ');
  const component = words.map(capitalize).join('') + 'Page';
  const route = explicitRoute || '/' + words.map((word) => word.toLowerCase()).join('-');
  return { label, component, route };
}

function addNavigationLink(content, details) {
  const source = String(content || '');
  if (source.includes('to="' + details.route + '"') || source.includes("to='" + details.route + "'")) return source;
  const tag = source.includes('<NavLink') ? 'NavLink' : 'Link';
  const link = '\n      <' + tag + ' to="' + details.route + '">' + details.label + '</' + tag + '>\n    ';
  return source.includes('</nav>') ? source.replace('</nav>', link + '</nav>') : source;
}

function relativeImport(fromPath, targetPath) {
  const from = fromPath.split('/').slice(0, -1);
  const target = targetPath.split('/');
  while (from.length && target.length && from[0] === target[0]) { from.shift(); target.shift(); }
  return (from.length ? '../'.repeat(from.length) : './') + target.join('/');
}

function capitalize(value) {
  return value ? value[0].toUpperCase() + value.slice(1) : '';
}
