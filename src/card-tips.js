export const CLIPPED_TIP = '完整内容：发 /t screen';
export const WELCOME_TIP = '直接在本话题回复即可继续；/t ls 看所有终端';
export const RECOVERY_TIP = '终端已变化，请重新 /t ls';
export const ROTATING_TIPS = ['/t ls 看所有终端', '/t screen 看完整屏幕', '/t move 话题找不到时移到新话题', '/t k esc 发送按键'];
export const TIP_INTERVAL = 6 * 60 * 60 * 1000;

// Called only when preparing an actual publication. Persist reservations before
// delivery, alongside the retry payload, so restart cannot repeat a tip.
export function planTurnTip(binding, turn, now, eligible = true) {
  const patch = {};
  if (!binding.firstTipTurnId) patch.firstTipTurnId = turn.id;
  const first = (binding.firstTipTurnId ?? turn.id) === turn.id;
  if (!eligible) return { text: '', patch };
  if (first && binding.welcomePending) {
    return { text: WELCOME_TIP, patch: { ...patch, welcomePending: false,
      tipTurnId: turn.id, tipText: WELCOME_TIP, lastTipAt: now } };
  }
  if (binding.tipTurnId === turn.id) return { text: turn.settled || binding.tipText === WELCOME_TIP ? binding.tipText : '', patch };
  if (!turn.settled || binding.lastTipAt != null && now - binding.lastTipAt < TIP_INTERVAL) return { text: '', patch };
  const index = binding.tipIndex ?? 0;
  return { text: ROTATING_TIPS[index % ROTATING_TIPS.length], patch: { ...patch,
    tipTurnId: turn.id, tipText: ROTATING_TIPS[index % ROTATING_TIPS.length], lastTipAt: now, tipIndex: index + 1 } };
}
