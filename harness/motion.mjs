// Runs in the browser. Give short positioning transitions time to finish before
// capturing an as-yet unmeasured label on its native animation timeline.
export function motionSettleDelay(minimum = 150) {
  const geometry = /^(transform|translate|scale|rotate|left|right|top|bottom|inset.*|width|height)$/;
  let remaining = 0;
  for (const animation of document.getAnimations()) {
    if (animation.playState !== "running" || !animation.effect || animation.playbackRate <= 0) continue;
    const keys = animation.effect.getKeyframes().flatMap((frame) => Object.keys(frame));
    if (!keys.some((key) => geometry.test(key))) continue;
    const end = animation.effect.getComputedTiming().endTime;
    if (!Number.isFinite(end) || !Number.isFinite(animation.currentTime)) continue;
    const time = (end - animation.currentTime) / animation.playbackRate;
    if (time > 0 && time <= 2000) remaining = Math.max(remaining, time);
  }
  // The extension coalesces reveal measurements for 100ms. Leave one further
  // frame after that refresh; continuous/infinite animation never blocks here.
  return Math.max(minimum, remaining ? Math.ceil(remaining + 150) : 0);
}
