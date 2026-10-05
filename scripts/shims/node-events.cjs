// Node's events module, except that setMaxListeners skips browser event targets.
// In Obsidian's renderer, AbortController is the browser's, and Node's setMaxListeners rejects its signal.
// The limit only controls a warning about many listeners, so skipping it is safe.
const events = require('node:events');

function setMaxListeners(n, ...targets) {
  const supported = targets.filter((target) => {
    if (target instanceof events.EventEmitter) return true;
    try {
      events.setMaxListeners(n, target);
    } catch {
      // A browser EventTarget. Leave its listener limit as it is.
    }
    return false;
  });
  if (!targets.length || supported.length) events.setMaxListeners(n, ...supported);
}

module.exports = new Proxy(events, {
  get: (target, key, receiver) => (key === 'setMaxListeners' ? setMaxListeners : Reflect.get(target, key, receiver)),
});
