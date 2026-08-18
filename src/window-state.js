/**
 * Remembering where the window was.
 *
 * The one part worth isolating is the check that a saved rectangle is still
 * reachable: a window restored onto a monitor that has since been unplugged
 * is invisible, with no way to fetch it back short of editing the settings
 * file — the kind of bug a user experiences as "the app stopped opening".
 *
 * Electron-free so the geometry can be exercised without a screen.
 */

/** @typedef {{x: number, y: number, width: number, height: number}} Rect */

/**
 * The saved bounds, if they still overlap a screen.
 *
 * Overlap rather than containment: a window left half off the edge, or
 * hanging below a shorter secondary display, is where the user put it and is
 * still draggable. Only a rectangle that touches no work area at all is
 * discarded.
 *
 * @param {unknown} saved the stored rectangle
 * @param {Rect[]} workAreas each display's usable area
 * @returns {Rect | undefined}
 */
export function visibleBounds(saved, workAreas) {
  const rect = ['x', 'y', 'width', 'height'].every(key => Number.isFinite(saved?.[key]))
    ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height }
    : undefined
  if (!rect || rect.width <= 0 || rect.height <= 0) return undefined
  const overlaps = workAreas.some(area => (
    rect.x < area.x + area.width && rect.x + rect.width > area.x
    && rect.y < area.y + area.height && rect.y + rect.height > area.y
  ))
  return overlaps ? rect : undefined
}
