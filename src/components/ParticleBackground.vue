<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

const canvas = ref<HTMLCanvasElement | null>(null)

interface Node {
  x: number
  y: number
  vx: number
  vy: number
  r: number
}

const LINK_DIST = 130
const NODE_COUNT = 64
let ctx: CanvasRenderingContext2D | null = null
let nodes: Node[] = []
let raf = 0
let width = 0
let height = 0
let mouse = { x: -9999, y: -9999 }

function resize(): void {
  if (!canvas.value) return
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  width = canvas.value.clientWidth
  height = canvas.value.clientHeight
  canvas.value.width = width * dpr
  canvas.value.height = height * dpr
  ctx = canvas.value.getContext('2d')
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0)
}

function seed(): void {
  nodes = Array.from({ length: NODE_COUNT }, () => ({
    x: Math.random() * width,
    y: Math.random() * height,
    vx: (Math.random() - 0.5) * 0.35,
    vy: (Math.random() - 0.5) * 0.35,
    r: Math.random() * 1.6 + 0.8,
  }))
}

function step(): void {
  if (!ctx) return
  ctx.clearRect(0, 0, width, height)

  for (const n of nodes) {
    n.x += n.vx
    n.y += n.vy
    if (n.x < 0 || n.x > width) n.vx *= -1
    if (n.y < 0 || n.y > height) n.vy *= -1
    const dx = n.x - mouse.x
    const dy = n.y - mouse.y
    const d = Math.hypot(dx, dy)
    if (d < 120 && d > 0.01) {
      n.x += (dx / d) * 0.5
      n.y += (dy / d) * 0.5
    }
  }

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]
      const b = nodes[j]
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      if (d < LINK_DIST) {
        const alpha = (1 - d / LINK_DIST) * 0.32
        ctx.strokeStyle = `rgba(56, 189, 248, ${alpha.toFixed(3)})`
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
      }
    }
  }

  for (const n of nodes) {
    ctx.fillStyle = 'rgba(125, 211, 252, 0.85)'
    ctx.beginPath()
    ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2)
    ctx.fill()
  }

  raf = requestAnimationFrame(step)
}

function onMouseMove(e: MouseEvent): void {
  mouse.x = e.clientX
  mouse.y = e.clientY
}

onMounted(() => {
  resize()
  seed()
  step()
  window.addEventListener('resize', () => {
    resize()
    seed()
  })
  window.addEventListener('mousemove', onMouseMove)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  window.removeEventListener('resize', resize)
  window.removeEventListener('mousemove', onMouseMove)
})
</script>

<template>
  <canvas ref="canvas" class="particles"></canvas>
</template>

<style scoped>
.particles {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  z-index: -1;
  opacity: 0.85;
  pointer-events: none;
}
</style>
