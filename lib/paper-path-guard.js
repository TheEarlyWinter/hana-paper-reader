import fs from "node:fs";
import path from "node:path";

/**
 * Validates that no component in targetPath is a symbolic link or junction,
 * and ensures that targetPath resolves within rootBoundary via realpathSync.
 */
export function verifyNoSymlinks(targetPath, rootBoundary = null) {
  const resolvedTarget = path.resolve(targetPath);
  const boundary = rootBoundary ? path.resolve(rootBoundary) : null;

  // 1. Traverse up the path hierarchy to check every existing directory/file with lstat
  let current = resolvedTarget;
  while (true) {
    if (fs.existsSync(current)) {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`symlink or junction detected: "${current}"`);
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  // 2. Realpath boundary check if boundary is specified
  if (boundary && fs.existsSync(boundary)) {
    const realBoundary = fs.realpathSync(boundary);
    if (fs.existsSync(resolvedTarget)) {
      const realTarget = fs.realpathSync(resolvedTarget);
      if (realTarget !== realBoundary && !realTarget.startsWith(`${realBoundary}${path.sep}`)) {
        throw new Error(`path "${resolvedTarget}" escapes root boundary "${boundary}"`);
      }
    } else {
      // Find nearest existing ancestor
      let existingAncestor = path.dirname(resolvedTarget);
      while (!fs.existsSync(existingAncestor) && path.dirname(existingAncestor) !== existingAncestor) {
        existingAncestor = path.dirname(existingAncestor);
      }
      if (fs.existsSync(existingAncestor)) {
        const realAncestor = fs.realpathSync(existingAncestor);
        if (realAncestor !== realBoundary && !realAncestor.startsWith(`${realBoundary}${path.sep}`)) {
          throw new Error(`path "${resolvedTarget}" escapes root boundary "${boundary}"`);
        }
      }
    }
  }
}
