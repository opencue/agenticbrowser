/**
 * Keep the browser window the size of the viewport the agent is emulating.
 *
 * Emulation.setDeviceMetricsOverride changes the page's viewport and nothing
 * else, so an agent working at a phone width renders a 390px layout inside a
 * 1280px window — a narrow strip of site with a wide band of empty chrome
 * beside it. Watching someone work like that is the problem: it looks broken,
 * and screenshots of it are mostly blank.
 *
 * Resizing is best-effort and deliberately quiet. It is cosmetic, it races the
 * agent's own actions, and no automation result may depend on it.
 */

/** Chrome's own frame around the page: tab strip, toolbar, bookmarks. */
const CHROME_HEIGHT = 132;
const CHROME_WIDTH = 0;

/**
 * Windows narrower than this are not worth following: Chrome clamps very small
 * widths anyway, and a sliver of a window is harder to watch than a wide one.
 */
const MIN_WIDTH = 360;

/** Desktop-sized emulation is what the window already is; leave it alone. */
const DESKTOP_WIDTH = 1000;

export function createWindowFit(cdp) {
  let last = null;

  return {
    /**
     * @param {{width?: number, height?: number, mobile?: boolean}} metrics
     * @param {string|null} targetId The tab the emulation applies to.
     */
    async follow(metrics, targetId) {
      const width = Number(metrics?.width);
      const height = Number(metrics?.height);
      if (!targetId) return;
      // Clearing the override (0x0) means "back to the real window", which the
      // window already is.
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0) return;
      if (width >= DESKTOP_WIDTH) return;
      if (width < MIN_WIDTH) return;

      const key = `${targetId}:${width}x${height}`;
      if (key === last) return;
      last = key;

      try {
        const { windowId } = await cdp.call("Browser.getWindowForTarget", { targetId });
        await cdp.call("Browser.setWindowBounds", {
          windowId,
          bounds: {
            width: Math.round(width + CHROME_WIDTH),
            height: Math.round(height + CHROME_HEIGHT),
            windowState: "normal",
          },
        });
      } catch {
        // A tab that closed, a window the compositor refuses to resize, a
        // headless browser with no window at all — none of it is a failure of
        // the action the agent was performing.
      }
    },
  };
}
