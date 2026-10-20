// Formulas in our own form (own-forms.mjs): the same value, written our way. Run: node test-own-forms.mjs
import assert from 'node:assert/strict';
import { mathForm } from './own-forms.mjs';

const cases = [
  ['font-size', 'calc((1 - 1) * calc(.012 * min(100vh, 900px)) + 1rem)', '1rem'],
  ['font-size', 'min(16px, 16px)', '16px'],
  ['font-size', 'min(calc((1.5 - 1) * 1.2vw + 1rem), max(calc((1.5 - 1) * 0.012 * 2560px + 1rem), calc(1.5 * 1rem)))', 'min(0.6vw + 1rem, max(1rem + 15.36px, 1.5rem))'],
  ['max-width', 'calc(-2.6em + 100vw)', 'calc(100vw - 2.6em)'],
  ['top', 'calc(-1 * 0px)', '0px'],
  ['top', 'calc(50% + 0px + (89.78125px / 2) - (94px / 2))', 'calc(50% - 2.1094px)'],
  ['grid-template-rows', 'repeat(24,minmax(calc(min(1920px, calc(100vw - 3vw * 2 - 0vw )) * 0.0215), auto))', 'repeat(24,minmax(min(41.28px, 2.021vw), auto))'],
  ['line-height', 'calc(1.2em * (1 + (1 - 2.8)/25))', '1.1136em'],
  ['border-color', 'hsla(22,68%,17%,calc(1*0.55))', 'hsla(22,68%,17%,0.55)'],
  ['transform', 'translate3d(calc(0px + 0px), calc(0px + 0px), 0px)', 'translate3d(0px, 0px, 0px)'],
  ['width', 'calc(100% - 2 * 4vw)', 'calc(-8vw + 100%)'],
  ['padding', 'calc(5px - 10px)', 'calc(-5px)'],
  ['margin-top', 'calc(5px - 10px)', '-5px'],
  ['height', 'clamp(10px, 5vw, 40px)', 'max(10px, min(5vw, 40px))'],
  ['stroke-width', 'max(1px,0.1em)', 'max(1px, 0.1em)'],
  // Not something we read: left as it is.
  ['width', 'calc(100% - env(safe-area-inset-left))', 'calc(100% - env(safe-area-inset-left))'],
  // A leftover from a variable the page never set: invalid in the browser too, so the declaration goes.
  ['max-height', 'calc(90svh - unset)', null],
];
for (const [p, v, want] of cases) assert.equal(mathForm(p, v), want, `${p}: ${v}`);
console.log(`own forms: ${cases.length} formulas ok`);
