// How many runners the host wants awake. Run: node test-scale.mjs
import { runnersNeeded, runnersMax } from './src/scale.js';
let bad = 0;
const is = (got, want, what) => { if (got !== want) { bad++; console.log('FAIL', what, 'got', got, 'want', want); } };
is(runnersNeeded({ jobs: 0, busy: 0, serving: false }, 4), 0, 'nothing to do');
is(runnersNeeded({ jobs: 0, busy: 3, serving: false }, 4), 0, 'only running jobs: start nothing new');
is(runnersNeeded({ jobs: 0, busy: 0, serving: true }, 4), 1, 'upkeep only: the first runner');
is(runnersNeeded({ jobs: 1, busy: 0 }, 4), 1, 'one job');
is(runnersNeeded({ jobs: 2, busy: 0 }, 4), 1, 'two jobs fit one runner');
is(runnersNeeded({ jobs: 3, busy: 0 }, 4), 2, 'three jobs need a second');
is(runnersNeeded({ jobs: 1, busy: 2 }, 4), 2, 'one waiting behind two being made');
is(runnersNeeded({ jobs: 58, busy: 0 }, 4), 4, 'a long queue stops at the maximum');
is(runnersNeeded({ jobs: 58, busy: 0 }, 1), 1, 'maximum of one: as before');
is(runnersMax({}), 1, 'unset: one runner, as before');
is(runnersMax({ RUNNERS_MAX: '4' }), 4, 'set');
is(runnersMax({ RUNNERS_MAX: '99' }), 10, 'capped');
is(runnersMax({ RUNNERS_MAX: 'x' }), 1, 'nonsense');
console.log(bad ? `scale: ${bad} FAILED` : 'scale: all checks pass');
process.exit(bad ? 1 : 0);
