import './style.css';
import { Game } from './game';
import { money } from './monetize';
import { initNative, onBackButton, onLifecycle } from './native';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const probe = document.getElementById('safe-area-probe')!;
const game = new Game();
if (import.meta.env.DEV) Object.assign(window, { __game: game, __money: money });

function readSafeArea() {
  const cs = getComputedStyle(probe);
  return {
    top: parseFloat(cs.paddingTop) || 0,
    bottom: parseFloat(cs.paddingBottom) || 0,
    left: parseFloat(cs.paddingLeft) || 0,
    right: parseFloat(cs.paddingRight) || 0,
  };
}

function resize(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  game.resize(w, h, readSafeArea());
}

window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 100));
resize();

canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  game.pointerDown(e.clientX, e.clientY);
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (e.code === 'Space' || e.code === 'Enter' || e.code === 'ArrowUp' || e.code === 'ArrowDown') {
    e.preventDefault();
    game.action();
  } else if (e.code === 'Escape' || e.code === 'KeyP') {
    if (game.state === 'paused') game.action();
    else game.pause();
  }
});

onLifecycle(
  () => game.onAppPause(),
  () => game.onAppResume(),
);
onBackButton(() => game.back());

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  game.update(dt);
  game.render(ctx);
  requestAnimationFrame(frame);
}

void (async () => {
  await game.load();
  requestAnimationFrame((t) => {
    last = t;
    frame(t);
  });
  await initNative();
})();
