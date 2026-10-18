// Picks the data store: the real one (Supabase) once its key is set, or the in-browser demo. ?demo forces the demo.
import { SUPABASE_KEY } from './config.js';
const demo = !SUPABASE_KEY || new URLSearchParams(location.search).has('demo');
export const { store, PLANS } = demo ? await import('./store-local.js') : { ...(await import('./store-supabase.js')), PLANS: (await import('./store-local.js')).PLANS };
