// Small canvas drawing helpers shared by the HUD and menus.
import { POWERS, type PowerKind, type Skin } from './content';

export const FONT = '"Avenir Next", "Segoe UI", Roboto, system-ui, -apple-system, sans-serif';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export function text(
  ctx: CanvasRenderingContext2D,
  s: string,
  x: number,
  y: number,
  size: number,
  color: string,
  weight = 800,
  align: CanvasTextAlign = 'center',
): void {
  ctx.font = `${weight} ${Math.round(size)}px ${FONT}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillText(s, x, y);
}

export function button(ctx: CanvasRenderingContext2D, r: Rect, label: string, primary: boolean): void {
  roundRect(ctx, r.x, r.y, r.w, r.h, r.h / 2);
  if (primary) {
    const g = ctx.createLinearGradient(0, r.y, 0, r.y + r.h);
    g.addColorStop(0, '#9ffbff');
    g.addColorStop(1, '#3fd3e0');
    ctx.fillStyle = g;
    ctx.fill();
    text(ctx, label, r.x + r.w / 2, r.y + r.h / 2 + 1, r.h * 0.4, '#0b0d1f', 900);
  } else {
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    text(ctx, label, r.x + r.w / 2, r.y + r.h / 2 + 1, r.h * 0.36, '#ffffff', 800);
  }
}

export function gemIcon(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.fillStyle = '#ffd166';
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r * 0.75, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r * 0.75, y);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#fff3b0';
  ctx.beginPath();
  ctx.moveTo(x, y - r * 0.55);
  ctx.lineTo(x + r * 0.3, y);
  ctx.lineTo(x, y + r * 0.1);
  ctx.lineTo(x - r * 0.3, y);
  ctx.closePath();
  ctx.fill();
}

/** A gem icon followed by an amount, centred on x. */
export function gemAmount(ctx: CanvasRenderingContext2D, amount: string, x: number, y: number, size: number, color = '#ffd166'): void {
  ctx.font = `800 ${Math.round(size)}px ${FONT}`;
  const tw = ctx.measureText(amount).width;
  const iw = size * 0.9;
  const left = x - (tw + iw) / 2;
  gemIcon(ctx, left + iw * 0.4, y, size * 0.42);
  text(ctx, amount, left + iw, y, size, color, 800, 'left');
}

export function progressBar(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, frac: number, color: string): void {
  roundRect(ctx, x, y, w, h, h / 2);
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fill();
  if (frac > 0) {
    roundRect(ctx, x, y, Math.max(h, w * Math.min(1, frac)), h, h / 2);
    ctx.fillStyle = color;
    ctx.fill();
  }
}

/** Power-up glyph inside a glowing orb. */
export function powerIcon(ctx: CanvasRenderingContext2D, kind: PowerKind, x: number, y: number, r: number): void {
  const color = POWERS[kind].color;
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = 'rgba(11, 13, 31, 0.85)';
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.5, r * 0.14);
  ctx.stroke();

  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const s = r * 0.5;
  ctx.beginPath();
  switch (kind) {
    case 'shield':
      ctx.moveTo(0, -s);
      ctx.lineTo(s * 0.85, -s * 0.6);
      ctx.quadraticCurveTo(s * 0.8, s * 0.6, 0, s);
      ctx.quadraticCurveTo(-s * 0.8, s * 0.6, -s * 0.85, -s * 0.6);
      ctx.closePath();
      ctx.fill();
      break;
    case 'magnet':
      ctx.lineWidth = s * 0.45;
      ctx.arc(0, -s * 0.05, s * 0.6, Math.PI, 0, true);
      ctx.moveTo(-s * 0.6, -s * 0.05);
      ctx.lineTo(-s * 0.6, -s * 0.75);
      ctx.moveTo(s * 0.6, -s * 0.05);
      ctx.lineTo(s * 0.6, -s * 0.75);
      ctx.stroke();
      break;
    case 'slow':
      ctx.lineWidth = s * 0.25;
      ctx.arc(0, 0, s * 0.85, 0, Math.PI * 2);
      ctx.moveTo(0, 0);
      ctx.lineTo(0, -s * 0.55);
      ctx.moveTo(0, 0);
      ctx.lineTo(s * 0.4, s * 0.15);
      ctx.stroke();
      break;
    case 'double':
      text(ctx, '2x', 0, s * 0.08, s * 1.4, color, 900);
      break;
  }
  ctx.restore();
}

/** Radial countdown ring drawn around an icon. */
export function timerRing(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, frac: number, color: string): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
  ctx.stroke();
}

export function trailColor(skin: Skin, i: number, time: number): string {
  if (skin.rainbow) return `hsl(${(time * 220 + i * 22) % 360}, 100%, 65%)`;
  return skin.trail[i % skin.trail.length];
}

export function hit(r: Rect, x: number, y: number, pad = 6): boolean {
  return x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad;
}
