/**
 * Single source of truth for combat numbers, skill taxonomy, and devtools docs.
 */

/** @typedef {"hero"|"enemy"} Perspective */

export const COMBAT = {
  TOTAL_ROUNDS: 100,
  /** Enemy stat multiplier at round {@link COMBAT.TOTAL_ROUNDS}. */
  ENEMY_SCALE_AT_MAX_ROUND: 100,
  /** Multiplier on all attack damage (both sides) — higher = shorter fights. */
  DAMAGE_OUTPUT_MULT: 1,
  /** Heals: ceil(caster maxHp × this) to each affected unit (same amount for party-wide hero heal). */
  HEAL_MAX_HP_FRAC: 0.1,
  RAPTURE_TURN_INTERVAL: 10,
  RAPTURE_ALL_STATS_FRAC_PER_STACK: 0.1,
};

const SKILL_TYPE_ORDER = /** @type {const} */ (["damage", "heal", "support"]);
export { SKILL_TYPE_ORDER };

export function isSkillTypeId(id) {
  return SKILL_TYPE_ORDER.includes(id);
}

export function normalizeStatusId(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (["break", "weaken", "revive", "chain", "leech"].includes(s)) return s;
  return null;
}

export function normalizeSupportStat(raw) {
  const s = String(raw || "").trim().toLowerCase();
  return s === "attack" || s === "maxhp" ? (s === "maxhp" ? "maxHp" : "attack") : null;
}

export function normalizeStatusStackCount(raw) {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) ? Math.max(1, n) : 1;
}

export function normalizeSupportBuffStackCount(raw) {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) ? Math.max(1, n) : 1;
}

export function roundScale(round) {
  const r = Math.max(1, round);
  const t = Math.max(1, COMBAT.TOTAL_ROUNDS);
  const maxScale = Math.max(1, Number(COMBAT.ENEMY_SCALE_AT_MAX_ROUND || 1));
  const progress = (r - 1) / Math.max(1, t - 1);
  const curvePower = 2;
  // Single scaling formula: starts at 1 on round 1 and reaches maxScale on final round.
  return 1 + (maxScale - 1) * Math.pow(progress, curvePower);
}

export function normalizeSkillDef(skill) {
  const next = { ...skill };
  const type = isSkillTypeId(next.type) ? next.type : "damage";
  return {
    id: String(next.id || "basic_attack"),
    name: String(next.name || "Attack"),
    type,
  };
}

export function buildMechanicsDocumentationHtml() {
  return `<div class="mechanics-doc-inner">
    <h3>Gameplay-first mechanics</h3>
    <p>Combat currently runs on basic attacks and relic effects. Enemy scaling follows one curve formula from 1 at round 1 to the configured max at the final round.</p>
  </div>`;
}
