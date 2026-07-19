export function buildVisionPrompt() {
  return [
    'Analyze this uploaded UI sketch/reference image for a frontend React app generator.',
    'Return strict JSON only with this shape:',
    '{"layout":"string","visibleSections":["string"],"navigation":"string","components":["string"],"visualStyle":"string","textContent":["string"],"metadata":{}}',
    'Focus on layout, UI sections, components, visual hierarchy, colors, and any readable labels. Do not invent backend requirements.'
  ].join('\n');
}
