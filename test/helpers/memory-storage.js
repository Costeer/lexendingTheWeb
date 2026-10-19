// Storage cloning, removals and sync events shared by the Node settings tests.
// Failure and response-order hooks belong in each suite's storage wrapper.
export function createMemoryStorage(initial = {}, { silentWrites = false } = {}) {
  let saved = structuredClone(initial);
  const listeners = new Set();
  const writes = [];
  const emit = (changes) => listeners.forEach((listener) => listener(structuredClone(changes), "sync"));
  const change = (changes, notify = true) => {
    for (const [key, value] of Object.entries(changes)) {
      if (Object.hasOwn(value, "newValue")) saved[key] = structuredClone(value.newValue);
      else delete saved[key];
    }
    if (notify) emit(changes);
  };
  const storage = {
    async get() { return structuredClone(saved); },
    async set(patch) {
      const copy = structuredClone(patch);
      const changes = Object.fromEntries(Object.entries(copy).map(([key, newValue]) => [key, { oldValue: saved[key], newValue }]));
      writes.push(copy);
      change(changes, !silentWrites);
    },
    async remove(keys) {
      const changes = {};
      for (const key of keys) {
        if (Object.hasOwn(saved, key)) changes[key] = { oldValue: saved[key] };
      }
      if (Object.keys(changes).length) change(changes, !silentWrites);
    }
  };
  return { storage, writes, saved: () => structuredClone(saved), emit, change,
    onChanged: { addListener: (listener) => listeners.add(listener) } };
}

export async function mutationResponse(run) {
  try { return { ok: true, settings: await run() }; }
  catch (error) { return { ok: false, code: error.code, message: error.message }; }
}
