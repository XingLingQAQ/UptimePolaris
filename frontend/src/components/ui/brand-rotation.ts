export function startBrandRotation(
  mark: HTMLElement,
  reduced: boolean,
): () => void {
  const animation = mark.animate(
    [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
    // 必要的加载反馈保持低速转动。 / Keep essential loading feedback, at a lower speed.
    {
      duration: reduced ? 4200 : 1400,
      iterations: Infinity,
      easing: 'linear',
    },
  );
  animation.startTime = 0;
  return () => animation.cancel();
}
