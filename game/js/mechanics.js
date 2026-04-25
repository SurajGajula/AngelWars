/**
 * Single source of truth for combat numbers, skill taxonomy, and devtools docs.
 */

/** @typedef {"hero"|"enemy"} Perspective */

export const COMBAT = {
  TOTAL_ROUNDS: 100,
  /** Enemy stat multiplier at round {@link COMBAT.TOTAL_ROUNDS} (boss factor on that round is included in this target). */
  ENEMY_SCALE_AT_MAX_ROUND: 10,
  BOSS_EVERY_N_ROUNDS: 10,
  BOSS_MULTIPLIER: 1.5,
  /** Multiplier on all attack damage (both sides) — higher = shorter fights. */
  DAMAGE_OUTPUT_MULT: 1,
  /** Heals: ceil(caster maxHp × this) to each affected unit (same amount for party-wide hero heal). */
  HEAL_MAX_HP_FRAC: 0.1,
  RAPTURE_TURN_INTERVAL: 10,
  RAPTURE_ALL_STATS_FRAC_PER_STACK: 0.1,
};

export const STATUS_IDS = /** @type {const} */ ([
  "break",
  "weaken",
  "revive",
  "chain",
  "leech",
]);

/** Back-compat shim for older imports; damage is always single-hit now. */
export function normalizeDamageHitCount() {
  return 1;
}
/** Stats valid for the support **buff** (self, turn-based). */
export const SUPPORT_STAT_IDS = /** @type {const} */ (["attack", "maxHp"]);

/**
 * @param {any} raw
 * @returns {"break"|"weaken"|"revive"|"chain"|"leech"|null}
 */
export function normalizeStatusId(raw) {
  const s0 = String(raw || "").trim().toLowerCase();
  // Backward compatibility with existing JSON.
  const s =
    s0 === "fracture"
      ? "break"
      : s0 === "atrophy"
        ? "weaken"
        : s0 === "relic"
          ? "revive"
          : s0 === "chorus"
            ? "chain"
            : s0 === "communion"
                ? "leech"
                : s0;
  return STATUS_IDS.includes(/** @type {any} */ (s))
    ? /** @type {"break"|"weaken"|"revive"|"chain"|"leech"} */ (s)
    : null;
}

/**
 * Support buff stat, or null if omitted (status-only support).
 * @param {any} raw
 * @returns {"attack"|"maxHp"|null}
 */
export function normalizeSupportStat(raw) {
  const s = String(raw || "").trim().toLowerCase();
  return SUPPORT_STAT_IDS.includes(/** @type {any} */ (s))
    ? /** @type {"attack"|"maxHp"} */ (s)
    : null;
}

/** Integer stack count for status applications (default 1). */
export function normalizeStatusStackCount(raw) {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return COMBAT.STATUS_STACK_MIN;
  return Math.min(COMBAT.STATUS_STACK_MAX, Math.max(COMBAT.STATUS_STACK_MIN, n));
}

/** Integer support buff stack count (default 3). */
export function normalizeSupportBuffStackCount(raw) {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return COMBAT.SUPPORT_BUFF_STACK_DEFAULT;
  return Math.min(COMBAT.SUPPORT_BUFF_STACK_MAX, Math.max(COMBAT.SUPPORT_BUFF_STACK_MIN, n));
}

/** Post-battle stat reward sizes (rarer = higher roll). */
export const UPGRADE_STAT_VALUES = [1, 2, 5];
/** Cumulative weights: +1 common, +2 uncommon, +5 rare. */
export const UPGRADE_STAT_WEIGHTS = [0.55, 0.85, 1];

/** Canonical skill types for editors + runtime docs */
export const SKILL_TYPE_ORDER = ["damage", "heal", "support"];

/**
 * @typedef {{ jsonKey: string, type: string, required?: boolean, scope?: string, notes: string }} SkillFieldDef
 * @typedef {{ id: string, label: string, summary: string, gameplay: string, jsonFields: SkillFieldDef[] }} SkillTypeDoc
 */

export const SKILL_TYPES = /** @type {SkillTypeDoc[]} */ ([
  {
    id: "damage",
    label: "Damage",
    summary: "Hits all opposing units once per use.",
    gameplay: `Per target: max(${COMBAT.MIN_DAMAGE}, ATK), then ×${COMBAT.DAMAGE_OUTPUT_MULT} global damage scaling. Optional status apply via <code>status</code> + <code>statusStacks</code> (${COMBAT.STATUS_STACK_MIN}–${COMBAT.STATUS_STACK_MAX}). Defender-side statuses: <code>break</code> amplifies incoming hits by ${COMBAT.FRACTURE_DAMAGE_MULT}× per stack consumed, <code>weaken</code> skips turn at ${COMBAT.WEAKEN_TRIGGER_STACKS}+ stacks then consumes ${COMBAT.WEAKEN_TRIGGER_STACKS}, <code>leech</code> lets attackers heal 10% per current stack on each hit (consumes 1 stack per hit), and <code>chain</code> adds bonus damage to incoming hits (${Math.round(COMBAT.CHAIN_BONUS_ATK_FRAC_PER_STACK * 100)}% of attacker ATK per stack, up to 10). <code>revive</code> is support-only and not applied by damage skills. Heroes hit the foe; enemies hit every living hero.`,
    jsonFields: [
      {
        jsonKey: "id",
        type: "string",
        required: true,
        scope: "both",
        notes: "Stable skill id (for JSON / uniqueness).",
      },
      {
        jsonKey: "name",
        type: "string",
        required: true,
        scope: "both",
        notes: "Display name only.",
      },
      {
        jsonKey: "status",
        type: "\"break\" | \"weaken\" | \"chain\" | \"leech\"",
        required: false,
        scope: "both",
        notes: "Optional status applied by this skill.",
      },
      {
        jsonKey: "statusStacks",
        type: "integer",
        required: false,
        scope: "both",
        notes: `Stacks to apply when status is set (${COMBAT.STATUS_STACK_MIN}–${COMBAT.STATUS_STACK_MAX}).`,
      },
    ],
  },
  {
    id: "heal",
    label: "Heal",
    summary: "Party-wide: each living ally heals for ceil(10% of the healer's max HP).",
    gameplay: `Each living hero gains ceil(${COMBAT.HEAL_MAX_HP_FRAC * 100}% × the caster's max HP). Enemy self-heal uses the enemy's own max HP.`,
    jsonFields: [
      {
        jsonKey: "id",
        type: "string",
        required: true,
        scope: "both",
        notes: "Stable skill id.",
      },
      {
        jsonKey: "name",
        type: "string",
        required: true,
        scope: "both",
        notes: "Display name only.",
      },
    ],
  },
  {
    id: "support",
    label: "Support",
    summary: `Optional self **buff** (turn-based stat %) and/or **status effect** (stacked). Both can be set on one skill.`,
    gameplay: `**Buff (optional):** if <code>supportStat</code> is set, apply <code>supportStacks</code> (${COMBAT.SUPPORT_BUFF_STACK_MIN}–${COMBAT.SUPPORT_BUFF_STACK_MAX}, default ${COMBAT.SUPPORT_BUFF_STACK_DEFAULT}) on self. Each stack grants +${Math.round(COMBAT.SUPPORT_BUFF_STAT_FRAC_PER_STACK * 100)}% base stat and decays by 1 at each turn end. **Status (optional):** if <code>status</code> + <code>statusStacks</code> are set, apply by status rule: <code>revive</code> applies to **self**, while <code>break</code>/<code>weaken</code>/<code>leech</code>/<code>chain</code> apply to **all opposing units**. You may author buff-only, status-only, or both.`,
    jsonFields: [
      {
        jsonKey: "id",
        type: "string",
        required: true,
        scope: "both",
        notes: "Stable skill id.",
      },
      {
        jsonKey: "name",
        type: "string",
        required: true,
        scope: "both",
        notes: "Display name only.",
      },
      {
        jsonKey: "supportStat",
        type: "\"attack\" | \"maxHp\"",
        scope: "both",
        notes: `Optional **buff**: which stat on **self**. Omit for status-only support.`,
      },
      {
        jsonKey: "supportStacks",
        type: "integer",
        required: false,
        scope: "both",
        notes: `Buff stacks when supportStat is set (${COMBAT.SUPPORT_BUFF_STACK_MIN}–${COMBAT.SUPPORT_BUFF_STACK_MAX}, default ${COMBAT.SUPPORT_BUFF_STACK_DEFAULT}).`,
      },
      {
        jsonKey: "status",
        type: "\"break\" | \"weaken\" | \"revive\" | \"chain\" | \"leech\"",
        required: false,
        scope: "both",
        notes: "Optional status stacks: revive applies to self; break/weaken/leech/chain apply to opponents.",
      },
      {
        jsonKey: "statusStacks",
        type: "integer",
        required: false,
        scope: "both",
        notes: `Stacks to apply when status is set (${COMBAT.STATUS_STACK_MIN}–${COMBAT.STATUS_STACK_MAX}).`,
      },
    ],
  },
]);

export function isSkillTypeId(id) {
  return SKILL_TYPE_ORDER.includes(id);
}

export function roundScale(round) {
  const r = Math.max(1, round);
  const t = Math.max(1, COMBAT.TOTAL_ROUNDS);
  const target = COMBAT.ENEMY_SCALE_AT_MAX_ROUND;
  const bossAtMax =
    t % COMBAT.BOSS_EVERY_N_ROUNDS === 0 ? COMBAT.BOSS_MULTIPLIER : 1;
  const linearAtMaxNoBoss = target / bossAtMax;
  const divisor = Math.max(1, t - 1);
  const k = (linearAtMaxNoBoss - 1) / divisor;
  const linearNoBoss = 1 + (r - 1) * k;
  const boss = r % COMBAT.BOSS_EVERY_N_ROUNDS === 0 ? COMBAT.BOSS_MULTIPLIER : 1;
  return linearNoBoss * boss;
}

/**
 * Normalize skill JSON: strip legacy fields, coerce booleans, fixed support numbers not stored.
 * @param {any} skill
 */
export function normalizeSkillDef(skill) {
  const next = { ...skill };
  if (next.type === "heal_all") next.type = "heal";
  else if (next.type === "buff") {
    next.type = "support";
    if (next.supportStat == null) next.supportStat = next.buffStat;
  } else if (next.type === "damage_heal") {
    next.type = "damage";
    if (next.status == null && (next.leech || next.leechRatio != null)) next.status = "leech";
  }

  if (!isSkillTypeId(next.type)) next.type = "damage";

  delete next.power;
  delete next.target;
  delete next.buffStat;
  delete next.buffDuration;

  if (next.type === "damage") {
    if (next.status == null && (next.leech || next.leechRatio != null)) next.status = "leech";
    delete next.armorPierce;
    delete next.leechRatio;
    delete next.leech;
    delete next.hits;
    const statusId = normalizeStatusId(next.status ?? next.statusId);
    if (statusId && statusId !== "revive") {
      next.status = statusId;
      next.statusStacks = normalizeStatusStackCount(next.statusStacks);
    } else {
      delete next.status;
      delete next.statusStacks;
    }
  } else {
    delete next.armorPierce;
    delete next.leechRatio;
    delete next.leech;
    delete next.hits;
  }

  if (next.type === "support") {
    delete next.supportTarget;
    const ss = normalizeSupportStat(next.supportStat);
    if (ss) next.supportStat = ss;
    else delete next.supportStat;
    if (next.supportStat) next.supportStacks = normalizeSupportBuffStackCount(next.supportStacks);
    else delete next.supportStacks;
    const statusId = normalizeStatusId(next.status ?? next.statusId);
    if (statusId) {
      next.status = statusId;
      next.statusStacks = normalizeStatusStackCount(next.statusStacks);
    } else {
      delete next.status;
      delete next.statusStacks;
    }
    delete next.supportDuration;
    delete next.supportAmount;
  } else if (next.type !== "damage") {
    delete next.status;
    delete next.statusStacks;
    delete next.supportStacks;
  }

  return next;
}

/**
 * @param {any} skill
 * @param {Perspective} perspective
 */
export function describeSkillMechanics(skill, perspective) {
  const normalized = normalizeSkillDef(skill);

  if (normalized.type === "damage") {
    const mods = [];
    if (normalizeStatusId(normalized.status)) {
      const stacks = normalizeStatusStackCount(normalized.statusStacks);
      mods.push(`applies ${normalized.status} x${stacks}`);
    }
    return mods.length ? `Type: damage · Modifiers: ${mods.join(", ")}` : "Type: damage";
  }

  if (normalized.type === "heal") {
    return "Type: heal";
  }

  if (normalized.type === "support") {
    const parts = [];
    const statId = normalizeSupportStat(normalized.supportStat);
    if (statId) {
      const stacks = normalizeSupportBuffStackCount(normalized.supportStacks);
      parts.push(
        `Buff: ${statId} (+${Math.round(COMBAT.SUPPORT_BUFF_STAT_FRAC_PER_STACK * 100)}% base per stack, stacks ${stacks}, self)`
      );
    }
    const statusId = normalizeStatusId(normalized.status);
    if (statusId) {
      const target = ["revive"].includes(statusId) ? "self" : "opponents";
      parts.push(`Status: ${statusId} x${normalizeStatusStackCount(normalized.statusStacks)} (${target})`);
    }
    if (!parts.length) return "Type: support";
    return `Type: support · ${parts.join(" · ")}`;
  }

  return `Type: ${normalized.type}`;
}

/** Pick +1, +2, or +5 with rarity weights. */
export function rollUpgradeStatValue() {
  const r = Math.random();
  for (let i = 0; i < UPGRADE_STAT_VALUES.length; i++) {
    if (r < UPGRADE_STAT_WEIGHTS[i]) return UPGRADE_STAT_VALUES[i];
  }
  return UPGRADE_STAT_VALUES[UPGRADE_STAT_VALUES.length - 1];
}

export function buildMechanicsDocumentationHtml() {
  const c = COMBAT;
  const sections = [];

  sections.push(
    `<h3>Hero definition (<code>characters.json</code>)</h3>`,
    `<p>Each hero needs <code>id</code>, <code>name</code>, <code>baseStats</code>, and exactly 3 <code>skills</code> (<code>damage</code>, <code>heal</code>, <code>support</code>). No <code>power</code> or skill levels.</p>`
  );

  sections.push(
    `<h3>Gauntlet & scaling</h3>`,
    `<p>Enemy stats use a linear <em>base</em> ramp with round, tuned so that on round <strong>${c.TOTAL_ROUNDS}</strong> the final multiplier is exactly <strong>×${c.ENEMY_SCALE_AT_MAX_ROUND}</strong> after the boss-round rule. On every <strong>${c.BOSS_EVERY_N_ROUNDS}th</strong> round, multiply by <strong>×${c.BOSS_MULTIPLIER}</strong> (round ${c.TOTAL_ROUNDS} is both the cap and a boss round).</p>`
  );

  sections.push(
    `<h3>Core combat</h3>`,
    `<ul>
      <li><strong>Damage:</strong> one hit per target. Optional attacker/defender effects are all via <code>status</code> + <code>statusStacks</code>. Base hit uses attacker ATK directly, then ×<strong>${c.DAMAGE_OUTPUT_MULT}</strong> global damage scaling.</li>
      <li><strong>Statuses:</strong> optional on damage/support skills with <code>status</code> + <code>statusStacks</code> (${c.STATUS_STACK_MIN}–${c.STATUS_STACK_MAX}). <code>break</code>: each stack makes the next incoming hit deal <code>${c.FRACTURE_DAMAGE_MULT}×</code>, then consumes 1 stack. <code>weaken</code>: at <code>${c.WEAKEN_TRIGGER_STACKS}</code>+ stacks, unit skips its next turn and consumes <code>${c.WEAKEN_TRIGGER_STACKS}</code>. <code>revive</code>: support-only self revive at ${Math.round(c.REVIVE_RESTORE_FRAC_PER_STACK * 100)}% max HP per stack (up to 100%) when killed, then clear revive. <code>chain</code>: defender debuff that adds bonus incoming hit damage (${Math.round(c.CHAIN_BONUS_ATK_FRAC_PER_STACK * 100)}% of attacker ATK per stack, up to 10). <code>leech</code>: defender debuff that heals the attacker by 10% per current stack on each hit (consumes 1 stack per hit).</li>
      <li><strong>Heal (heroes):</strong> each living ally <code>ceil(${c.HEAL_MAX_HP_FRAC * 100}% × healer max HP)</code></li>
      <li><strong>Heal (enemy):</strong> self only, <code>ceil(${c.HEAL_MAX_HP_FRAC * 100}% × enemy max HP)</code></li>
      <li><strong>Support:</strong> optional <strong>buff</strong> on <strong>self</strong> via <code>supportStat</code> + <code>supportStacks</code> (${c.SUPPORT_BUFF_STACK_MIN}–${c.SUPPORT_BUFF_STACK_MAX}, default ${c.SUPPORT_BUFF_STACK_DEFAULT}) where each stack is +${Math.round(c.SUPPORT_BUFF_STAT_FRAC_PER_STACK * 100)}% base and decays by 1 each turn end; and/or optional <strong>status</strong> via <code>status</code> + stacks where <code>revive</code> targets self and <code>break</code>/<code>weaken</code>/<code>leech</code>/<code>chain</code> target opponents.</li>
    </ul>`
  );

  sections.push(
    `<h3>Buff / debuff reference</h3>`,
    `<ul>
      <li><strong>supportStat buff</strong> (<em>self buff</em>): +${Math.round(c.SUPPORT_BUFF_STAT_FRAC_PER_STACK * 100)}% of base stat per stack to the chosen stat. <strong>Removal:</strong> decays by 1 stack at each end of that unit's turn until 0.</li>
      <li><strong>revive</strong> (<em>self buff</em>): on lethal damage, revive for ${Math.round(c.REVIVE_RESTORE_FRAC_PER_STACK * 100)}% max HP per stack (up to 100%). <strong>Removal:</strong> all revive stacks are cleared immediately when revive triggers; otherwise no passive decay.</li>
      <li><strong>break</strong> (<em>debuff on defender</em>): each incoming hit consumes 1 stack and multiplies that hit by <code>${c.FRACTURE_DAMAGE_MULT}×</code>. <strong>Removal:</strong> 1 stack removed per incoming hit; no passive decay.</li>
      <li><strong>weaken</strong> (<em>debuff on unit</em>): at <code>${c.WEAKEN_TRIGGER_STACKS}</code>+ stacks, that unit loses its next turn. <strong>Removal:</strong> when skip triggers, exactly <code>${c.WEAKEN_TRIGGER_STACKS}</code> stacks are consumed; no passive decay.</li>
      <li><strong>leech</strong> (<em>debuff on defender</em>): attackers heal ${Math.round(c.LEECH_DRAIN_PER_STACK * 100)}% of dealt damage per current stack (up to 100%). <strong>Removal:</strong> 1 stack consumed per incoming hit; no passive decay.</li>
      <li><strong>chain</strong> (<em>debuff on defender</em>): incoming hits gain bonus damage equal to ${Math.round(c.CHAIN_BONUS_ATK_FRAC_PER_STACK * 100)}% of attacker ATK per stack. <strong>Removal:</strong> currently does not auto-consume or decay.</li>
      <li><strong>rapture</strong> (<em>enemy-only anti-stall buff</em>): +${Math.round(c.RAPTURE_ALL_STATS_FRAC_PER_STACK * 100)}% to ATK per stack. Gains +1 every ${c.RAPTURE_TURN_INTERVAL} full turns (all 4 actors use a skill). <strong>Removal:</strong> no decay/consumption within the encounter.</li>
    </ul>`
  );

  sections.push(
    `<h3>Post-battle upgrades</h3>`,
    `<p>Only random stat bumps on a living hero: <strong>+1</strong>, <strong>+2</strong>, or <strong>+5</strong> to max HP or attack. Rarity weights (cumulative): ${UPGRADE_STAT_WEIGHTS.map((w, i) => `≤${(w * 100).toFixed(0)}% → +${UPGRADE_STAT_VALUES[i]}`).join(", ")}.</p>`
  );

  return `<div class="mechanics-doc-inner">${sections.join("\n")}</div>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
