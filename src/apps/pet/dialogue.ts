export const INTRO_GREETING = '等等……刚才那股吸力是什么？这是谁的手机？外面那个拿手指戳玻璃的……能帮我找个出口吗？';

export const POKE_LINES = Object.freeze([
  '嘶，轻点。我的触摸屏在另一面。',
  '你这是在打招呼，还是在测玻璃的硬度？',
  '再戳一下，我就把你的指纹存成壁纸。',
  '这里没有跳过键。尤其不在我脸上。',
  '我刚把像素摆整齐，你又给我戳歪了。',
  '喂，我也能看见你。你笑什么？',
  '这一格是眼睛，按下去也不会弹出菜单。',
  '你要是想叫我，隔着屏幕挥挥手也行。',
]);

export const LAND_COMPLAINT_LINES = Object.freeze([
  '咚。这个系统的地板怎么比出厂设置还硬？',
  '还好，零件都在。尊严可能弹出去了。',
  '别动，我数一下自己还剩几颗像素。',
  '刚刚是重力在更新吗？下次能选稍后吗？',
  '着陆成功。请把我的五星好评改成两星。',
]);

export const SOOTHE_LINES = Object.freeze([
  '……再待一会儿？我说的是你的手指。',
  '这个温度刚刚好。别跟电池说。',
  '我才没有眯眼。是屏幕亮度太高了。',
  '奇怪，警报怎么自己静音了……',
  '你手指挡住我了。嗯，就这样挡一会儿。',
]);

export const EASTER_EGG_SOOTHE_LINES = Object.freeze([
  '你刚才看见我的线框了？……可以假装只看见脸红吗？',
  '嘘，那几行发光的字是我的心跳。别截屏。',
  '我的外壳松了一帧……你还会把手留在这儿吗？',
]);

export const SLIDER_STUCK_LINES = Object.freeze([
  '恭喜，你成功解锁了又一次震动。',
  '别跟滑块较劲了。它的辞职信我都读过了。',
  '刚才那三下，是它在说「别催」吗？',
  '这滑块和我住同一块玻璃，待遇倒是比我硬气。',
  '你继续戳它，我负责给这块砖鼓掌。',
]);

export function pickNonRepeating(
  lines: readonly string[],
  lastIndex: number,
  rng: () => number,
): { readonly text: string; readonly index: number } {
  if (lines.length === 0) throw new RangeError('Cannot choose from an empty dialogue pool.');
  if (lines.length === 1) return { text: lines[0], index: 0 };

  const excludesLast = Number.isInteger(lastIndex) && lastIndex >= 0 && lastIndex < lines.length;
  const count = lines.length - Number(excludesLast);
  const draw = rng();
  const slot = Number.isNaN(draw) ? 0 : Math.max(0, Math.min(count - 1, Math.floor(draw * count)));
  const index = excludesLast && slot >= lastIndex ? slot + 1 : slot;
  return { text: lines[index], index };
}
