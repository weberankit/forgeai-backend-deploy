// export function buildVisionPrompt() {
//   return [
//     'Analyze this uploaded UI sketch/reference image for a frontend React app generator.',
//     'Return strict JSON only with this shape:',
//     '{"layout":"string","visibleSections":["string"],"navigation":"string","components":["string"],"visualStyle":"string","textContent":["string"],"metadata":{}}',
//     'Focus on layout, UI sections, components, visual hierarchy, colors, and any readable labels. Do not invent backend requirements.'
//   ].join('\n');
// }
export function buildVisionPrompt() {
  return [
    'Analyze this uploaded UI sketch/reference image for a frontend React app generator.',
    'Return strict JSON only. Do not include Markdown fences, comments, or trailing commas.',
    '',
    'Only report what is actually visible in the image. Never invent labels, text, colors, components, or sections that are not clearly present. If something is ambiguous, low-fidelity (e.g. a rough hand-drawn box), or illegible, describe it at the confidence level it actually supports (e.g. "small illegible label near top-left", "rough box, likely a button") rather than stating a guess as fact.',
    'If the image shows more than one screen, state, or flow step, describe each one as a separate entry within the arrays below (e.g. prefix with "Screen 1:", "Screen 2:") rather than merging them into a single description.',
    'Use an empty array or empty string for any field with nothing genuinely present in the image — do not pad fields with plausible-sounding filler.',
    'Focus on layout, UI sections, components, visual hierarchy, colors, spacing, and any readable labels or text. Do not invent or infer backend, data, or authentication requirements.',
    'Describe colors concretely (e.g. "dark navy background, warm orange accent") rather than vague adjectives alone.',
    'Do not identify or name any real, recognizable person, brand, logo, or copyrighted screenshot content that may appear in the image. Describe such elements only by their structural/visual role (e.g. "logo placeholder top-left", "profile photo in card") without naming the actual brand or person.',
    '',
    'Return strict JSON only with this shape:',
    '{"layout":"string","visibleSections":["string"],"navigation":"string","components":["string"],"visualStyle":"string","textContent":["string"],"metadata":{"screenCount":1,"deviceType":"mobile|desktop|tablet|unknown","sketchFidelity":"low_fidelity_sketch|wireframe|polished_mockup|screenshot"}}',
    '',
    'Before returning, verify: every reported item is actually visible in the image, not inferred or invented; multi-screen content is clearly separated; empty categories are empty rather than padded; metadata.screenCount matches the number of distinct screens actually described. Correct your answer if any check fails.'
  ].join('\n');
}