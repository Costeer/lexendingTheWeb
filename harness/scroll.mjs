// Serializable browser function. Some responsive pages constrain body to the
// viewport and scroll body independently while window.scrollY remains zero.
export function pageScrollState({ y, x = 0 } = {}) {
  const body = document.body;
  const root = document.documentElement;
  const css = body && getComputedStyle(body);
  const bodyScrolls = body && /auto|scroll/.test(css.overflowY)
    && body.clientHeight >= innerHeight * .85 && body.clientHeight <= innerHeight + 2
    && body.scrollHeight > body.clientHeight + 2
    && root.scrollHeight <= innerHeight + 2;
  if (Number.isFinite(y)) {
    if (bodyScrolls) body.scrollTo({ left: x, top: y, behavior: "instant" });
    else scrollTo({ left: x, top: y, behavior: "instant" });
  }
  return {
    y: bodyScrolls ? body.scrollTop : scrollY,
    height: bodyScrolls ? body.scrollHeight : Math.max(root.scrollHeight, body?.scrollHeight ?? 0),
    container: bodyScrolls ? "body" : "document"
  };
}
