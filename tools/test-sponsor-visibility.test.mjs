// The sponsor card must count as displayed only when it is really on screen.
// These cases encode the geometry rules from tools/sponsor.html so a future
// refactor cannot silently weaken the visibility gate.

const CARD_W = 676;   // 760px window minus padding
const CARD_H = 420;   // headline + body + call to action

// Mirror of visible() from tools/sponsor.html.
function visible({ visibilityState = 'visible', top, height, innerHeight, scrollY = 0, width = CARD_W }) {
  if (visibilityState !== 'visible') return false;
  const bottom = top + height;
  if (width <= 200 || height <= 70) return false;
  const shown = Math.min(bottom, innerHeight) - Math.max(top, 0);
  const fits = top >= 0 && bottom <= innerHeight;
  const fillsTop = scrollY <= 8 && shown >= innerHeight * 0.9;
  return (fits || fillsTop) && shown >= Math.min(height, innerHeight) * 0.9;
}

const cases = [
  {
    name: 'card fully inside a tall window counts',
    input: { top: 120, height: CARD_H, innerHeight: 900 },
    want: true,
  },
  {
    name: 'hidden tab never counts',
    input: { visibilityState: 'hidden', top: 120, height: CARD_H, innerHeight: 900 },
    want: false,
  },
  {
    name: 'card larger than the window, scrolled to the top, counts',
    input: { top: 0, height: 900, innerHeight: 600, scrollY: 0 },
    want: true,
  },
  {
    name: 'card larger than the window but scrolled away does not count',
    input: { top: -700, height: 900, innerHeight: 600, scrollY: 700 },
    want: false,
  },
  {
    name: 'card pushed below the fold does not count',
    input: { top: 800, height: CARD_H, innerHeight: 600 },
    want: false,
  },
  {
    name: 'collapsed card does not count',
    input: { top: 10, height: 40, innerHeight: 900 },
    want: false,
  },
  {
    name: 'card narrower than 200px does not count',
    input: { top: 10, height: CARD_H, innerHeight: 900, width: 180 },
    want: false,
  },
  {
    name: 'card half cut off below the window does not count',
    input: { top: 500, height: 400, innerHeight: 600 },
    want: false,
  },
];

let failed = 0;
for (const c of cases) {
  const got = visible(c.input);
  const ok = got === c.want;
  if (!ok) failed += 1;
  console.log((ok ? 'ok   ' : 'FAIL ') + c.name);
  if (!ok) console.log('       expected ' + c.want + ', got ' + got);
}
console.log(failed === 0 ? '\nall visibility cases pass' : '\n' + failed + ' case(s) failed');
process.exit(failed === 0 ? 0 : 1);
