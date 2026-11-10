export interface VideoPictureRect {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

function intersect(first: VideoPictureRect, second: VideoPictureRect): VideoPictureRect {
  const left = Math.max(first.left, second.left)
  const top = Math.max(first.top, second.top)
  const right = Math.max(left, Math.min(first.right, second.right))
  const bottom = Math.max(top, Math.min(first.bottom, second.bottom))
  return { left, top, right, bottom, width: right - left, height: bottom - top }
}

function positionOffset(value: string | undefined, space: number): number {
  if (value === 'left' || value === 'top') return 0
  if (value === 'right' || value === 'bottom') return space
  if (value?.endsWith('%')) return space * (parseFloat(value) / 100)
  if (value?.endsWith('px')) return parseFloat(value)
  return space / 2
}

/** The video element can fill the tile while contain leaves empty space inside it. */
export function calculateVideoPictureRect(
  box: VideoPictureRect,
  videoWidth: number,
  videoHeight: number,
  objectFit: string,
  objectPosition = '50% 50%',
): VideoPictureRect {
  if (videoWidth <= 0 || videoHeight <= 0 || box.width <= 0 || box.height <= 0) return box
  if (objectFit !== 'contain' && objectFit !== 'scale-down' && objectFit !== 'none') return box
  const containScale = Math.min(box.width / videoWidth, box.height / videoHeight)
  const scale = objectFit === 'none' ? 1 : objectFit === 'scale-down' ? Math.min(1, containScale) : containScale
  const width = videoWidth * scale
  const height = videoHeight * scale
  const position = objectPosition.trim().split(/\s+/)
  const left = box.left + positionOffset(position[0], box.width - width)
  const top = box.top + positionOffset(position[1], box.height - height)
  return intersect({ left, top, right: left + width, bottom: top + height, width, height }, box)
}

/** Keep labels on the foreground video; do not anchor them to Jitsi's blurred backdrop. */
export function getMeetingBannerAnchorRect(tile: HTMLElement): VideoPictureRect {
  const tileRect = tile.getBoundingClientRect()
  const view = tile.ownerDocument.defaultView
  if (!view) return tileRect
  const primary = tile.querySelector<HTMLVideoElement>('video#largeVideo')
  const videos = tile.tagName.toLowerCase() === 'video'
    ? [tile as HTMLVideoElement]
    : primary ? [primary] : Array.from(tile.querySelectorAll<HTMLVideoElement>('video'))
  let bestRect: VideoPictureRect | undefined
  for (const video of videos) {
    if (!video.videoWidth || !video.videoHeight
      || video.closest('#largeVideoBackgroundContainer, #largeVideoBackground, .large-video-background')) continue
    let visible = true
    for (let element: HTMLElement | null = video; element; element = element.parentElement) {
      const style = view.getComputedStyle(element)
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        visible = false
        break
      }
      if (element === tile) break
    }
    if (!visible) continue
    const style = view.getComputedStyle(video)
    const rect = intersect(calculateVideoPictureRect(
      video.getBoundingClientRect(), video.videoWidth, video.videoHeight, style.objectFit, style.objectPosition,
    ), tileRect)
    if (rect.width < 24 || rect.height < 24) continue
    if (!bestRect || rect.width * rect.height > bestRect.width * bestRect.height) bestRect = rect
  }
  // Camera off or metadata not ready: retain the existing avatar/tile positioning.
  return bestRect ?? tileRect
}