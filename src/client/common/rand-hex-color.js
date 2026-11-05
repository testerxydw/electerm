export function getRandomHexColor () {
  let color = '#'
  const hexValues = '0123456789ABCDEF'

  for (let i = 0; i < 6; i++) {
    const index = Math.floor(Math.random() * 16)
    color += hexValues[index]
  }

  return color
}

// 书签与页签共用的色卡。挑色时按"同一色相给深/中/浅三档"铺，
// 因为徽标字色是运行时按 isDark 现算的（深底白字、浅底黑字），
// 每一档都得各自站得住，不能靠边框描边来救对比度。
export const defaultColors = [
  '#0366d6',
  '#28a745',
  '#d73a49',
  '#ffab4a',
  '#ffd33d',
  '#6f42c1',
  '#e99695',
  '#24292e',
  '#6a737d',
  '#0969da',
  '#1f6feb',
  '#54aeff',
  '#0a3069',
  '#cf222e',
  '#e36209',
  '#fb8500',
  '#9a6700',
  '#bf3989',
  '#f778ba',
  '#8250df',
  '#1f883d',
  '#2da44e',
  '#0f7b6c',
  '#1b7c80'
]

export const getRandomDefaultColor = () => {
  const index = Math.floor(Math.random() * defaultColors.length)
  return defaultColors[index]
}
