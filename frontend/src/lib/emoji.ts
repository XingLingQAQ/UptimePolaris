export function getEmojiUrl(emoji: string) {
  // Split emoji into array of code points / 将 emoji 拆成码点数组
  const codePoints = [...emoji]
    .map(char => char.codePointAt(0)?.toString(16).toLowerCase())
    .filter(Boolean);

  // Handle flag emojis / 处理旗帜 emoji
  if (
    codePoints.length === 2 &&
    codePoints[0]?.startsWith('1f1') &&
    codePoints[1]?.startsWith('1f1')
  ) {
    return `https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/svg/${codePoints.join('-')}.svg`;
  }

  // Handle regular emojis / 处理普通 emoji
  return `https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/svg/${codePoints[0]}.svg`;
}
