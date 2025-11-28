let _enabled = false;

export function setDebug(v) {
  _enabled = !!v;
}

export function log(...args) {
  if (_enabled) console.log(...args);
}

export function info(...args) {
  if (_enabled) console.info(...args);
}

export function warn(...args) {
  if (_enabled) console.warn(...args);
}

// Errors should always be visible
export function error(...args) {
  console.error(...args);
}

export function enabled() {
  return _enabled;
}
