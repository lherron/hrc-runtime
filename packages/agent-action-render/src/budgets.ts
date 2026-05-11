export const MAX_LINE_CHARS = 80
export const MAX_PREVIEW_CHARS = 60

export function truncateText(value: string, width: number, suffix = '...'): string {
  if (width <= 0) return ''
  if (value.length <= width) return value
  if (width <= suffix.length) return suffix.slice(0, width)
  return `${value.slice(0, width - suffix.length)}${suffix}`
}
