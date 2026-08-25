/**
 * WATER SATURATION ATTRIBUTION
 *
 * RUNS AT RETINA SCALE, AND HAS TO.
 *
 * The ocean's pre-filter, foam thresholds and detail fade are all driven by the
 * pixel footprint, so the shader's output is genuinely resolution-dependent.
 * The first version of this probe rendered 900x500 at scale 1 and measured the
 * water-02 camera at 0.507 saturation where the shipped 1600x900 at scale 2
 * capture of the identical camera and instant measures 0.840. Every attribution
 * it produced described a frame nobody will ever see. Four times in this
 * project a measurement has been trusted before its own conditions were
 * checked; this is the fourth.
 *
 * The same ocean measures 0.84 to 0.96 mean saturation in frames containing
 * nothing but water and 0.27 to 0.42 in frames containing gameplay. This turns
 * one candidate off at a time on an identical gameplay camera and reports what
 * each is worth.
 *
 * ONE PROCESS PER VARIANT. Sharing a page between samples has produced
 * incoherent numbers three separate times in this project; a fresh browser is
 * the only version of this that can be trusted.
 *
 *   node tools/satProbe.mjs            runs every variant
 *   node tools/satProbe.mjs spray      runs one
 *
 * WHAT TWO TURNS OF THIS ESTABLISHED, so the next attempt starts from the data
 * instead of repeating it. All measured at 1600x900 scale 2, one browser per
 * sample, mean saturation of the lower 40% of frame:
 *
 *   The gap is real. Water-only captures 0.79-0.96, gameplay captures
 *   0.27-0.42.
 *
 *   Nothing is drawn on top. Spray, the ribbon and its halo, bloom, the
 *   interior lines, the gates and buoys, the foam, the haze, the glitter and
 *   the pre-filter each recover under 0.015, and several are negative.
 *
 *   It is not the camera's geometry. At one instant a 5.2 m level camera and a
 *   22 m looking-down camera both measure 0.58 where the chase camera measures
 *   0.31.
 *
 *   It is not distance. Binned into ten screen bands the drop is uniform:
 *   0.81 to 0.47 at the top of the water, 0.77 to 0.37 at the bottom.
 *
 *   It appears the moment the throttle opens. Idle at t=12 measures 0.76; at
 *   t=20 under power, 0.40.
 *
 *   Two contributors are confirmed and neither is dominant. The wake field is
 *   worth 0.06 (0.334 with it, 0.395 without — and note the earlier test of
 *   this was invalid, because Game rebinds the wake texture every frame and
 *   undid the switch before the next render). The speed FOV kick is worth 0.04
 *   (65.1 degrees against 56 at the same pose).
 *
 *   That leaves roughly 0.3 unaccounted for.
 */
import { chromium } from '@playwright/test';

const VARIANTS = [
  ['baseline',   () => {}],
  ['no spray',   (h) => h.setLayerVisible('spray', false)],
  ['no ribbon',  (h) => { h.setLayerVisible('ribbon', false); h.setLayerVisible('ribbonGlow', false); }],
  ['no wake',    (h) => h.setLayerVisible('wake', false)],
  ['no bloom',   (h) => h.setPassUniform('composite', 'uBloomStrength', 0)],
  ['no lines',   (h) => h.setPassUniform('sobel', 'uLineStrength', 0)],
  ['no props',   (h) => { h.setLayerVisible('gates', false); h.setLayerVisible('buoys', false); }],
  ['no foam',    (h) => h.setOceanUniform('uFoamFold', 5)],
  ['no glitter', (h) => h.setOceanUniform('uSparkleAmount', 0)],
  ['no haze',    (h) => h.setOceanUniform('uFogNear', 100000)],
  ['no prefilter', (h) => h.setOceanUniform('uPreFilterFloor', 1)],
  ['full lift',  (h) => h.setOceanUniform('uLiftStrength', 1)],
];

const only = process.argv[2];
const rows = [];

for (const [label, apply] of VARIANTS) {
  if (only && !label.includes(only)) continue;
  const b = await chromium.launch({args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
  const p = await (await b.newContext({viewport:{width:1600,height:900}, deviceScaleFactor:2})).newPage();
  await p.goto('http://127.0.0.1:43555/?harness=1&quality=ultra&adaptive=0',{waitUntil:'domcontentloaded'});
  await p.waitForFunction(()=>Boolean(window.__INKTIDE__?.harness.ready()),null,{timeout:180000});
  const sat = await p.evaluate((name)=>{
    const g = window.__INKTIDE__;
    document.getElementById('boot')?.remove();
    g.harness.pause();
    g.harness.setInput({throttle:1, steer:0});
    g.harness.step(Math.round(52*60), 1/60, false);
    // The hero-01 camera: the frame a player actually spends the race in.
    g.harness.setCamera('chase');
    const h = g.harness;
    if (name === 'no spray') h.setLayerVisible('spray', false);
    else if (name === 'no ribbon') { h.setLayerVisible('ribbon', false); h.setLayerVisible('ribbonGlow', false); }
    else if (name === 'no wake') h.setLayerVisible('wake', false);
    else if (name === 'no bloom') h.setPassUniform('composite','uBloomStrength',0);
    else if (name === 'no lines') h.setPassUniform('sobel','uLineStrength',0);
    else if (name === 'no props') { h.setLayerVisible('gates', false); h.setLayerVisible('buoys', false); }
    else if (name === 'no foam') h.setOceanUniform('uFoamFold', 5);
    else if (name === 'no glitter') h.setOceanUniform('uSparkleAmount', 0);
    else if (name === 'no haze') h.setOceanUniform('uFogNear', 100000);
    else if (name === 'no prefilter') h.setOceanUniform('uPreFilterFloor', 1);
    else if (name === 'full lift') h.setOceanUniform('uLiftStrength', 1);
    h.renderFrames(3);
    const c=document.getElementById('scene');
    const cv=document.createElement('canvas'); cv.width=c.width; cv.height=c.height;
    cv.getContext('2d').drawImage(c,0,0);
    const d=cv.getContext('2d').getImageData(0,0,cv.width,cv.height).data;
    let s=0,n=0;
    for(let y=Math.floor(cv.height*0.60); y<cv.height; y+=2)
      for(let x=0; x<cv.width; x+=2){
        const i=(y*cv.width+x)*4;
        const mx=Math.max(d[i],d[i+1],d[i+2]), mn=Math.min(d[i],d[i+1],d[i+2]);
        s += mx===0?0:(mx-mn)/mx; n++;
      }
    return s/n;
  }, label);
  rows.push([label, sat]);
  console.log(`  ${label.padEnd(12)} ${sat.toFixed(3)}`);
  await b.close();
}
if (rows.length > 1) {
  const base = rows[0][1];
  console.log('\n  attribution (saturation regained by removing the layer):');
  for (const [label, s] of rows.slice(1)) {
    console.log(`    ${label.padEnd(12)} ${(s-base>=0?'+':'')}${(s-base).toFixed(3)}`);
  }
}
