// Background video addresses as Squarespace stores them (capture.mjs bgVideoId). Run: node test-media-bg.mjs
import assert from 'node:assert/strict';
import { bgVideoId } from './capture.mjs';

const cases = [
  ['https://vimeo.com/1183995649?share=copy&fl=sv&fe=ci', { p: 'vimeo', id: '1183995649' }],
  ['https://vimeo.com/317532872', { p: 'vimeo', id: '317532872' }],
  ['https://vimeo.com/76979871/8a3f1b2c9d', { p: 'vimeo', id: '76979871', h: '8a3f1b2c9d' }],
  ['//player.vimeo.com/video/1183995649?api=1&background=1&h=abc123def', { p: 'vimeo', id: '1183995649', h: 'abc123def' }],
  ['https://www.youtube.com/watch?v=hoAh7YPQyCw', { p: 'youtube', id: 'hoAh7YPQyCw' }],
  ['https://youtu.be/hoAh7YPQyCw?t=4', { p: 'youtube', id: 'hoAh7YPQyCw' }],
  ['https://www.youtube.com/embed/hoAh7YPQyCw?autoplay=1', { p: 'youtube', id: 'hoAh7YPQyCw' }],
  ['https://www.youtube.com/watch?feature=share&v=hoAh7YPQyCw', { p: 'youtube', id: 'hoAh7YPQyCw' }],
  ['https://example.com/video.mp4', null],
];
for (const [u, want] of cases) assert.deepEqual(bgVideoId(u), want, u);
console.log(`bgVideoId: ${cases.length} cases ok`);
