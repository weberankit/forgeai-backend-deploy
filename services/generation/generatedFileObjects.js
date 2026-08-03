import { languageForPath, normalizeProjectPath } from './pathSafety.js';

// Mongoose subdocuments expose schema values through getters, so spreading them
// copies Mongoose internals instead of path/content. Normalize at every pipeline
// boundary before files are cloned, validated, snapshotted, or edited.
export function toPlainGeneratedFile(file = {}) {
  const source = typeof file?.toObject === 'function'
    ? file.toObject({ depopulate: true, versionKey: false })
    : file;
  const filePath = normalizeProjectPath(source?.path ?? file?.path);
  return {
    ...source,
    path: filePath,
    language: source?.language ?? file?.language ?? languageForPath(filePath),
    content: String(source?.content ?? file?.content ?? '')
  };
}

export function toPlainGeneratedFiles(files = []) {
  return Array.from(files || [], toPlainGeneratedFile);
}
