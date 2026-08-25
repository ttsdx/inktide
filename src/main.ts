import { Game } from './Game.ts';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const hudRoot = document.getElementById('hud') as HTMLDivElement;
const boot = document.getElementById('boot') as HTMLDivElement;

const game = new Game(canvas, hudRoot);

game
  .init()
  .then(() => {
    boot.classList.add('hidden');
    setTimeout(() => boot.remove(), 600);
    game.start();
  })
  .catch((err) => {
    console.error(err);
    boot.innerHTML = `<div style="text-align:center;max-width:640px;padding:24px">
      <div style="font-size:24px;font-weight:800;letter-spacing:.1em">WebGL2 required</div>
      <div style="margin-top:12px;opacity:.8;font-size:14px;line-height:1.6">
        Ink Tide needs a WebGL2 context with multiple render targets.<br/>
        <code style="opacity:.6">${String(err)}</code>
      </div>
    </div>`;
  });

// Exposed for the Playwright screenshot harness.
declare global {
  interface Window {
    __INKTIDE__: Game;
  }
}
window.__INKTIDE__ = game;
