export async function describeImage(image) {
  if (!image) return null;

  return {
    layout: 'Development fallback: uploaded image accepted and queued for visual interpretation.',
    visibleSections: ['Unable to inspect pixels without configured vision provider. Treat as a sketch/reference.'],
    navigation: 'Infer navigation from prompt and visible context when a vision provider is configured.',
    components: ['Upload reference image', 'Prompt-derived UI sections'],
    visualStyle: 'Use prompt plus uploaded image metadata as design direction.',
    textContent: [],
    metadata: {
      originalName: image.originalname,
      mimeType: image.mimetype,
      size: image.size
    }
  };
}
