// =============================================================
// lab-grow.js — the lab learns what you wonder about.
//
// Each SceneSpec carries a `field` tag (astronomy | chemistry | …).
// The first question in any field unlocks a piece of furniture in the
// room. Counts persist in localStorage so the room is yours across
// visits — close the tab, come back tomorrow, the telescope is still
// there.
// =============================================================

const STORE_KEY = 'wonderlab.lab.fields.v1';

/** Read the current { field: count } map (or {} on miss / parse fail). */
export function loadFieldCounts() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return {};
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}

function save(counts) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(counts)); } catch {}
}

/**
 * Bump a field's count. Returns:
 *   { newGrowth: <field|null>, counts: { ... } }
 * `newGrowth` is non-null exactly when this is the first time the
 * visitor's asked something in that field — that's the moment to
 * spawn the furniture with an animation + toast.
 */
export function bumpField(field) {
  if (!field || typeof field !== 'string') return { newGrowth: null, counts: loadFieldCounts() };
  const counts = loadFieldCounts();
  const wasZero = !counts[field];
  counts[field] = (counts[field] || 0) + 1;
  save(counts);
  return { newGrowth: wasZero ? field : null, counts };
}

/** Wipe everything — used by the "reset the lab" button in settings. */
export function clearFieldCounts() {
  try { localStorage.removeItem(STORE_KEY); } catch {}
}

/**
 * Field → furniture mapping. The `key` matches a builder method on
 * LabScene (_spawnTelescope etc.), the `label` is the toast copy.
 * `general` and unmapped fields don't grow anything new.
 */
export const FIELD_FURNITURE = {
  astronomy: { key: 'telescope',  label: 'a tiny telescope' },
  chemistry: { key: 'testtubes',  label: 'a test-tube rack' },
  physics:   { key: 'pendulum',   label: 'a swinging pendulum' },
  biology:   { key: 'petridish',  label: 'a petri dish' },
};
