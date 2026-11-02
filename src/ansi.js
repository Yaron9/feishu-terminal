// Keep terminal escape stripping independent of the Node.js version.
export function stripVTControlCharacters(text) {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|\x9b[0-?]*[ -/]*[@-~]/g, '');
}
