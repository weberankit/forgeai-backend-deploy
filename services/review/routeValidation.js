import * as parser from '@babel/parser';
import traverseModule from '@babel/traverse';

const traverse = traverseModule.default || traverseModule;

export function validateRouteIntegration(files = []) {
  const routes = [];
  const navigation = [];
  const errors = [];
  for (const file of files) {
    if (!file.path.endsWith('.js') && !file.path.endsWith('.jsx')) continue;
    let ast;
    try { ast = parser.parse(String(file.content || ''), { sourceType: 'module', plugins: ['jsx'] }); }
    catch { continue; }
    traverse(ast, {
      JSXOpeningElement(pathRef) {
        const name = jsxName(pathRef.node.name);
        if (name === 'Route') {
          const routePath = stringAttribute(pathRef.node.attributes, 'path');
          if (routePath) routes.push({ path: routePath, file: file.path });
        }
        if (name === 'Link' || name === 'NavLink') {
          const to = stringAttribute(pathRef.node.attributes, 'to');
          if (to) navigation.push({ path: to, file: file.path });
        }
      },
      ObjectProperty(pathRef) {
        const key = pathRef.node.key?.name || pathRef.node.key?.value;
        if (key !== 'path' || pathRef.node.value?.type !== 'StringLiteral') return;
        const owner = pathRef.findParent((parent) => parent.isVariableDeclarator());
        const ownerName = owner?.node?.id?.name || '';
        if (/(nav|menu|navigation)/i.test(ownerName)) navigation.push({ path: pathRef.node.value.value, file: file.path });
        if (/(route|router)/i.test(ownerName)) routes.push({ path: pathRef.node.value.value, file: file.path });
      }
    });
  }
  const seen = new Set();
  for (const route of routes) {
    if (route.path === '*') continue;
    const key = route.path;
    if (seen.has(key)) errors.push({ code: 'duplicate_route', message: 'Duplicate route path in ' + route.file + ': ' + route.path, file: route.file });
    else seen.add(key);
  }
  const registered = new Set(routes.map((route) => route.path));
  const concreteRoutes = routes.filter((route) => route.path !== '*');
  if (concreteRoutes.length && !registered.has('/')) errors.push({ code: 'missing_root_route', message: 'Generated application has no route for /. Add a root page or redirect / to the primary route.', file: concreteRoutes[0].file });
  for (const item of navigation) {
    if (!item.path.startsWith('/') || item.path.startsWith('//') || item.path.includes(':')) continue;
    if (!registered.has(item.path)) errors.push({ code: 'unregistered_navigation', message: 'Navigation points to an unregistered route: ' + item.path, file: item.file });
  }
  return { passed: errors.length === 0, errors, routes, navigation };
}

function stringAttribute(attributes, name) {
  const attribute = (attributes || []).find((item) => item.type === 'JSXAttribute' && item.name?.name === name);
  if (attribute?.value?.type === 'StringLiteral') return attribute.value.value;
  if (attribute?.value?.type === 'JSXExpressionContainer' && attribute.value.expression?.type === 'StringLiteral') return attribute.value.expression.value;
  return '';
}

function jsxName(name) {
  if (!name) return '';
  if (name.type === 'JSXIdentifier') return name.name;
  if (name.type === 'JSXMemberExpression') return jsxName(name.object) + '.' + jsxName(name.property);
  return '';
}
