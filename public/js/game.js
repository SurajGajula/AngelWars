import {
  COMBAT,
  roundScale,
  normalizeSkillDef,
} from "./mechanics.js";

/** Pause after each skill resolves (UI + pacing), including auto-repeat. */
const SKILL_POST_DELAY_MS = 1000;
const GAMEPLAY_SPEED_STEPS = Object.freeze([0.5, 1, 2]);
let gameplaySpeedIdx = 1;

/** @type {any[]} */
let characterDefs = [];
/** @type {any[]} */
let enemyDefs = [];
/** @type {string} */
let arenaBackgroundUrl = "";
const BASIC_ATTACK_SKILL = Object.freeze({ id: "basic_attack", name: "Attack", type: "damage" });
const RELIC_LIBRARY = Object.freeze([
  {
    id: "growth_hp_round",
    name: "Vital Bloom",
    desc: "+1 Max HP each round",
  },
  {
    id: "growth_atk_round",
    name: "War Ember",
    desc: "+1 ATK each round",
  },
  {
    id: "growth_hybrid_round",
    name: "Twin Sigil",
    desc: "+1 Max HP and +1 ATK each round",
  },
  {
    id: "round_heal_scaling",
    name: "Mending Clock",
    desc: "Heal N HP each round (N = round number)",
  },
  {
    id: "unique_relic_guard",
    name: "Relic Guard",
    desc: "Reduce incoming damage by 1 for each unique relic you have",
  },
  {
    id: "double_draft_pick",
    name: "Twin Claim",
    desc: "If only this holder receives relics this round, they can draft 2 instead of 1",
  },
]);
const RELIC_BY_ID = Object.freeze(Object.fromEntries(RELIC_LIBRARY.map((r) => [r.id, r])));
let draftPoolRelicIds = RELIC_LIBRARY.map((r) => r.id);

let state = {
  round: 1,
  party: /** @type {BattleFighter[]} */ ([]),
  enemy: /** @type {BattleFighter | null} */ (null),
  actedThisCycle: /** @type {Set<BattleFighter>} */ (new Set()),
  /** Whose skills stay visible in the dock (updated on each hero turn). */
  skillDockHeroId: /** @type {string | null} */ (null),
  partyInspectId: /** @type {string | null} */ (null),
  /** Right column: party HP vs combat log + enemy reference. */
  battleView: /** @type {"hud"|"log"} */ ("hud"),
  /** Last skill id used this run per hero (for Repeat). */
  lastSkillIdByHeroId: /** @type {Record<string, string>} */ ({}),
  /** After each full initiative cycle (every living unit acted), each hero's last skill id (Repeat All). */
  lastPartyVolleySkills: /** @type {Record<string, string>} */ ({}),
  /** When true, after each enemy turn we repeat-all once (if possible) until an ally dies or the foe dies. */
  autoRepeatPartyUntilCasualty: false,
  /** Living hero count when auto-repeat was armed (any drop stops auto). */
  autoRepeatLivingAtArm: 0,
  /** Battle-local full-turn counter (increments after all actors use a skill). */
  turnsElapsedInEncounter: 0,
  /** True only when a full actor cycle completed and relic timers should advance once. */
  pendingRelicTurnAdvance: false,
  /** Distinct actor keys that have used a skill in the current full turn. */
  actedSkillActorKeys: /** @type {Set<string>} */ (new Set()),
  /** Hero def ids that have finished a turn in the current party volley (cleared after the foe acts). */
  heroesActedThisVolley: /** @type {Set<string>} */ (new Set()),
  /** Shown on sprite tiles on next `renderBattle` (damage white, heal gold). */
  pendingCombatFloats: /** @type {{ id: string, text: string, kind: "damage"|"heal" }[]} */ ([]),
  /** True while a hero skill is resolving + post-delay; blocks duplicate skill use. */
  battleInputLocked: false,
};

/** @type {HTMLAudioElement | null} */
let bgm = null;
/** @type {HTMLAudioElement | null} */
let attackHitSfx = null;

function startBgm() {
  if (!bgm) return;
  bgm.volume = 0.45;
  const p = bgm.play();
  if (!p || typeof p.catch !== "function") return;
  p.catch(() => {
    // Browser blocked autoplay; first user gesture retry handler below will resume.
  });
}

function bindBgmAutoplayFallback() {
  const tryStart = () => {
    startBgm();
    if (!bgm || !bgm.paused) {
      window.removeEventListener("pointerdown", tryStart, true);
      window.removeEventListener("keydown", tryStart, true);
    }
  };
  window.addEventListener("pointerdown", tryStart, true);
  window.addEventListener("keydown", tryStart, true);
}

function playAttackHitSfx() {
  if (!attackHitSfx) return;
  attackHitSfx.currentTime = 0;
  const p = attackHitSfx.play();
  if (!p || typeof p.catch !== "function") return;
  p.catch(() => {
    // Ignore blocked/failed SFX playback.
  });
}

function setBgmMuted(muted) {
  if (!bgm) return;
  bgm.muted = !!muted;
  const btn = document.getElementById("btn-mute-bgm");
  if (!btn) return;
  btn.textContent = muted ? "Unmute" : "Mute";
  btn.setAttribute("aria-pressed", muted ? "true" : "false");
  btn.setAttribute("aria-label", muted ? "Unmute background music" : "Mute background music");
}

function gameplaySpeed() {
  const raw = Number(GAMEPLAY_SPEED_STEPS[gameplaySpeedIdx] || 1);
  return raw > 0 ? raw : 1;
}

function scaledDelay(ms) {
  const base = Math.max(0, Number(ms) || 0);
  return Math.max(0, Math.round(base / gameplaySpeed()));
}

function syncGameplaySpeedButton() {
  const btn = document.getElementById("btn-game-speed");
  if (!btn) return;
  const spd = gameplaySpeed();
  btn.textContent = `Speed ${spd}x`;
  btn.setAttribute("aria-label", `Gameplay speed ${spd}x`);
}

function cycleGameplaySpeed() {
  gameplaySpeedIdx = (gameplaySpeedIdx + 1) % GAMEPLAY_SPEED_STEPS.length;
  syncGameplaySpeedButton();
}

function normalizeCharacterDefs(list) {
  return (list || []).map((c) => ({
    ...c,
    baseStats: { maxHp: 100, attack: 10 },
    skills: (c.skills || []).map((sk) => normalizeSkillDef(sk)),
  }));
}

/** True if `sprites/<id>.png` exists (game ships static sprites only). */
function spritePngAvailable(id) {
  const safeId = String(id || "").trim();
  if (!safeId) return Promise.resolve(false);
  return new Promise((resolve) => {
    const img = new Image();
    const done = (ok) => {
      img.onload = null;
      img.onerror = null;
      resolve(ok);
    };
    const t = window.setTimeout(() => done(false), 8000);
    img.onload = () => {
      window.clearTimeout(t);
      done(true);
    };
    img.onerror = () => {
      window.clearTimeout(t);
      done(false);
    };
    img.src = `sprites/${safeId}.png`;
  });
}

/**
 * @param {any[]} defs
 */
async function filterDefsWithSprites(defs) {
  const list = defs || [];
  const flags = await Promise.all(list.map((d) => spritePngAvailable(d?.id)));
  return list.filter((_, i) => flags[i]);
}

/**
 * @typedef {object} Buff
 * @property {string} stat
 * @property {number} stacks
 */

/**
 * @typedef {object} BattleFighter
 * @property {'hero'|'enemy'} kind
 * @property {any} def
 * @property {number} hp
 * @property {number} maxHp
 * @property {number} attack
 * @property {Buff[]} buffs
 * @property {{ id: string, stacks: number, intervalTurns?: number, counter?: number, valuePercent?: number }[]} relics
 * @property {number} [cycleIndex]
 */

function defaultRelicsForDef(def, kind, opts = {}) {
  const id = String(def?.id || "").toLowerCase();
  const scale = Number(opts.enemyScale || 1);
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  if (Array.isArray(def?.innateRelics) && def.innateRelics.length) {
    const relics = def.innateRelics.map((r) => ({ ...r }));
    if (kind === "enemy") {
      const scaleRelic = relics.find((r) => r.id === "enemy_scale");
      if (scaleRelic) {
        scaleRelic.valueScale = Number(safeScale.toFixed(2));
      } else {
        relics.unshift({ id: "enemy_scale", stacks: 0, valueScale: Number(safeScale.toFixed(2)) });
      }
    }
    return relics;
  }
  if (kind === "enemy") {
    const relics = [
      { id: "enemy_scale", stacks: 0, valueScale: Number(safeScale.toFixed(2)) },
      { id: "rapture", stacks: 0, intervalTurns: 10, counter: 10 },
    ];
    if (id === "golgotha") {
      relics.push({ id: "golgotha_heartsear", stacks: 1, intervalTurns: 3, counter: 3 });
    }
    if (id === "absolution") {
      relics.push({ id: "absolution_everpain", stacks: 1, intervalTurns: 1, counter: 1 });
    }
    if (id === "micheal") {
      relics.push({ id: "micheal_fallen_fury", stacks: 1 });
    }
    if (id === "chorus") {
      relics.push({ id: "chorus_diminuendo", stacks: 1, counter: 5 });
    }
    return relics;
  }
  if (id === "chariot") {
    return [{ id: "chariot_third_strike", stacks: 0, intervalTurns: 3, counter: 3 }];
  }
  if (id === "cherub") {
    return [{ id: "cherub_martyr_split", stacks: 0 }];
  }
  if (id === "seraph") {
    return [{ id: "seraph_heal", stacks: 0, valuePercent: 10 }];
  }
  if (id === "judgement") {
    return [{ id: "judgement_round_bonus", stacks: 0, valueRound: true }];
  }
  if (id === "justice") {
    return [{ id: "justice_equal_atk", stacks: 0 }];
  }
  if (id === "cradle") {
    return [{ id: "cradle_last_stand_revive", stacks: 0, valuePercent: 20 }];
  }
  return [];
}

function buffBonusForStat(f, stat) {
  const base = stat === "attack" ? f.attack : stat === "maxHp" ? f.maxHp : 0;
  let add = 0;
  for (const b of f.buffs) {
    if (b.stat !== stat) continue;
    if (b.stacks != null) add += Math.max(0, Math.floor(base * COMBAT.SUPPORT_BUFF_STAT_FRAC_PER_STACK * Number(b.stacks)));
    else if (b.percentFrac != null) add += Math.max(0, Math.floor(base * b.percentFrac));
    else add += Number(b.amount) || 0;
  }
  return add;
}

function effectiveStats(f) {
  const rapture = (f.relics || []).find((r) => r.id === "rapture");
  const enemyScaleRelic = (f.relics || []).find((r) => r.id === "enemy_scale");
  const michealFallenFury = (f.relics || []).find((r) => r.id === "micheal_fallen_fury");
  const raptureStacks = Math.max(0, Number(rapture?.stacks || 0));
  const raptureMult = 1 + Math.min(10, raptureStacks) * 0.1;
  const enemyScale = Math.max(0.1, Number(enemyScaleRelic?.valueScale || 1));
  const deadAllies = Math.max(0, 3 - aliveHeroes().length);
  const furyTier = michealFallenFury ? relicRoundTierStacks() : 0;
  if (michealFallenFury) michealFallenFury.stacks = furyTier;
  const furyMult = 1 + deadAllies * 0.1 * furyTier;
  const attack = (f.attack + buffBonusForStat(f, "attack")) * furyMult;
  const relicMult = raptureMult * enemyScale;
  return {
    attack: Math.max(0, Math.floor(attack * relicMult)),
    maxHp: Math.max(1, Math.floor(f.maxHp * relicMult)),
    raptureStacks,
    enemyScale,
  };
}

function tickBuffsForActor(f) {
  for (const b of f.buffs) {
    if (b.stacks != null) b.stacks -= 1;
    else if (b.duration != null) b.duration -= 1;
  }
  f.buffs = f.buffs.filter((b) => (b.stacks != null ? b.stacks > 0 : (b.duration || 0) > 0));
}

function actorTurnKey(actor) {
  return `${actor.kind}:${String(actor?.def?.id || actor?.def?.name || "unknown")}`;
}

/** Living heroes plus the current foe (if alive) must each contribute a skill action to complete one encounter turn. */
function expectedActorKeysForFullTurn() {
  const keys = aliveHeroes().map(actorTurnKey);
  if (state.enemy && state.enemy.hp > 0) keys.push(actorTurnKey(state.enemy));
  return keys;
}

function registerSkillAction(actor) {
  state.actedSkillActorKeys.add(actorTurnKey(actor));
  const expected = expectedActorKeysForFullTurn();
  if (!expected.length) return;
  if (!expected.every((k) => state.actedSkillActorKeys.has(k))) return;
  for (const h of aliveHeroes()) {
    const sid = state.lastSkillIdByHeroId[h.def.id];
    if (sid) state.lastPartyVolleySkills[h.def.id] = sid;
  }
  state.actedSkillActorKeys.clear();
  state.turnsElapsedInEncounter += 1;
  state.pendingRelicTurnAdvance = true;
}

function relicRoundTierStacks() {
  return Math.min(5, Math.floor((Math.max(1, Number(state.round || 1)) - 1) / 20) + 1);
}

function processRelicsOnTurnAdvance() {
  for (const unit of allLivingCombatants()) {
    for (const relic of unit.relics || []) {
      if (relic.id === "rapture") {
        const interval = Math.max(1, Number(relic.intervalTurns || 0));
        const counter = Math.max(1, Number(relic.counter || interval));
        if (counter <= 1) {
          relic.stacks = Math.min(10, Math.max(0, Number(relic.stacks || 0)) + 1);
          logLine(
            `<span class="system">${escapeHtml(unit.def.name)} gains <strong>rapture</strong> ×${relic.stacks} (+${relic.stacks * 10}% ATK / MaxHP).</span>`
          );
          relic.counter = interval;
        } else {
          relic.counter = counter - 1;
        }
        continue;
      }
      if (relic.id === "golgotha_heartsear" && unit.kind === "enemy") {
        const interval = Math.max(1, Number(relic.intervalTurns || 3));
        const counter = Math.max(1, Number(relic.counter || interval));
        const roundStacks = relicRoundTierStacks();
        relic.stacks = roundStacks;
        if (counter <= 1) {
          const target = aliveHeroes().reduce(
            (best, h) => {
              if (!best) return h;
              return h.hp > best.hp ? h : best;
            },
            null
          );
          if (target) {
            const pct = 0.1 * roundStacks;
            const dmg = Math.max(1, Math.floor(Math.max(0, Number(target.maxHp || 0)) * pct));
            const dmgRes = applyDamage(target, dmg);
            queueCombatFloat(target.def.id, `-${dmgRes.primary}`, "damage");
            for (const rr of dmgRes.redirected) {
              queueCombatFloat(rr.target.def.id, `-${rr.damage}`, "damage");
            }
            logLine(
              `<span class="enemy">${escapeHtml(unit.def.name)}</span>'s <strong>Heartsear</strong> scorches <span class="player">${escapeHtml(target.def.name)}</span> for <strong>${dmgRes.total}</strong> (${Math.round(pct * 100)}% max HP).`
            );
          }
          relic.counter = interval;
        } else {
          relic.counter = counter - 1;
        }
        continue;
      }
      if (relic.id === "chorus_diminuendo" && unit.kind === "enemy") {
        const tier = Math.min(5, Math.max(1, Number(relic.stacks || 1)));
        const interval = Math.max(1, 6 - tier);
        const counter = Math.max(1, Number(relic.counter || interval));
        if (counter <= 1) {
          const names = [];
          for (const h of state.party) {
            const curMax = Math.max(1, Math.floor(Number(h.maxHp || 1)));
            const nh = Math.max(1, curMax - 1);
            h.maxHp = nh;
            h.hp = Math.min(Math.max(0, Math.floor(Number(h.hp || 0))), nh);
            names.push(h.def.name);
          }
          relic.stacks = Math.min(5, tier + 1);
          const nextTier = Math.min(5, Math.max(1, Number(relic.stacks || 1)));
          relic.counter = Math.max(1, 6 - nextTier);
          logLine(
            `<span class="enemy">${escapeHtml(unit.def.name)}</span>'s <strong>Diminuendo</strong> cuts party max HP by <strong>1</strong> (${escapeHtml(names.join(", "))}); next pulse every <strong>${relic.counter}</strong> turn(s).`
          );
        } else {
          relic.counter = counter - 1;
        }
        continue;
      }
    }
  }
}

function logLine(html) {
  const el = document.getElementById("combat-log");
  if (!el) return;
  const p = document.createElement("p");
  p.innerHTML = html;
  el.appendChild(p);
  el.scrollTop = el.scrollHeight;
}

function queueCombatFloat(fighterId, text, kind) {
  const id = String(fighterId || "").trim();
  if (!id) return;
  state.pendingCombatFloats.push({
    id,
    text: String(text),
    kind: kind === "heal" ? "heal" : "damage",
  });
}

function flushCombatFloats() {
  const list = state.pendingCombatFloats.splice(0, state.pendingCombatFloats.length);
  list.forEach((item, i) => {
    window.setTimeout(() => {
      let attempts = 0;
      const place = () => {
        const tile = document.querySelector(`[data-fighter-id="${item.id}"]`);
        const arena = document.querySelector(".battle-arena");
        if (!tile) {
          attempts += 1;
          if (attempts < 6) window.setTimeout(place, 32);
          return;
        }
        if (!(arena instanceof HTMLElement)) return;
        const tileRect = tile.getBoundingClientRect();
        const arenaRect = arena.getBoundingClientRect();
        const left = tileRect.left - arenaRect.left + tileRect.width / 2;
        const top = tileRect.top - arenaRect.top + tileRect.height * 0.34;
        const el = document.createElement("div");
        el.className =
          item.kind === "heal" ? "combat-float combat-float-heal" : "combat-float combat-float-damage";
        el.textContent = item.text;
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
        arena.appendChild(el);
        const rm = () => {
          el.remove();
        };
        el.addEventListener("animationend", rm, { once: true });
        window.setTimeout(rm, 1400);
      };
      place();
    }, i * 58);
  });
}

function clearLog() {
  const el = document.getElementById("combat-log");
  if (el) el.innerHTML = "";
}

function showScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

function heroFromDef(def) {
  const s = def.baseStats;
  return {
    kind: "hero",
    def,
    hp: s.maxHp,
    maxHp: s.maxHp,
    attack: s.attack,
    buffs: [],
    relics: defaultRelicsForDef(def, "hero"),
  };
}

function enemyFromDef(def, round) {
  const scale = roundScale(round);
  const s = def.baseStats;
  const scaledHp = Math.max(1, Math.round(s.maxHp * scale));
  return {
    kind: "enemy",
    def,
    hp: scaledHp,
    maxHp: s.maxHp,
    attack: s.attack,
    buffs: [],
    relics: defaultRelicsForDef(def, "enemy", { enemyScale: scale }),
    cycleIndex: 0,
  };
}

function aliveHeroes() {
  return state.party.filter((h) => h.hp > 0);
}

/**
 * @param {any} skill normalized damage skill
 */
function computeDamage(attacker) {
  const a = effectiveStats(attacker);
  const atk = Number(a.attack);
  const safeAtk = Number.isFinite(atk) ? atk : 0;
  return Math.max(1, Math.floor(safeAtk));
}

function allLivingCombatants() {
  const units = [...aliveHeroes()];
  if (state.enemy && state.enemy.hp > 0) units.push(state.enemy);
  units.sort((a, b) => (a.kind !== b.kind ? (a.kind === "enemy" ? 1 : -1) : 0));
  return units;
}

function getNextActor() {
  const enemyAlive = !!(state.enemy && state.enemy.hp > 0);
  const heroesAlive = aliveHeroes().length > 0;
  if (!enemyAlive && !heroesAlive) return null;
  if (!heroesAlive) return null;

  for (const h of state.party) {
    if (h.hp <= 0) continue;
    if (!state.heroesActedThisVolley.has(h.def.id)) return h;
  }
  if (enemyAlive) return state.enemy;
  return null;
}

/** Living allies who have not yet acted this volley, in roster order (for Repeat all). */
function pendingHeroesBeforeNextEnemy() {
  const out = [];
  for (const h of state.party) {
    if (h.hp <= 0) continue;
    if (state.heroesActedThisVolley.has(h.def.id)) continue;
    out.push(h);
  }
  return out;
}

function heroLastSkillOrNull(hero) {
  if (!hero?.def?.skills?.length) return null;
  const lastId = state.lastSkillIdByHeroId[hero.def.id];
  if (!lastId) return null;
  return hero.def.skills.find((s) => s.id === lastId) || null;
}

/** Skill to replay for Repeat All: last completed full-cycle snapshot, else most recent this run. */
function heroRepeatAllSkillOrNull(hero) {
  if (!hero?.def?.skills?.length) return null;
  const id =
    state.lastPartyVolleySkills[hero.def.id] ?? state.lastSkillIdByHeroId[hero.def.id];
  if (!id) return null;
  return hero.def.skills.find((s) => s.id === id) || null;
}

/** True when each ally who acts before the foe this segment has a skill to replay. */
function canRepeatAllParty() {
  const chain = pendingHeroesBeforeNextEnemy();
  if (chain.length < 1) return false;
  return chain.every((h) => !!heroRepeatAllSkillOrNull(h));
}

function disarmAutoRepeatParty() {
  state.autoRepeatPartyUntilCasualty = false;
  state.autoRepeatLivingAtArm = 0;
}

function armAutoRepeatParty() {
  state.autoRepeatPartyUntilCasualty = true;
  state.autoRepeatLivingAtArm = aliveHeroes().length;
}

/** Stop auto-repeat: ally death, foe death, or battle end. */
function shouldStopAutoRepeatParty() {
  if (!state.autoRepeatPartyUntilCasualty) return true;
  if (battleOver()) return true;
  if (aliveHeroes().length < state.autoRepeatLivingAtArm) return true;
  if (!state.enemy || state.enemy.hp <= 0) return true;
  return false;
}

/** After the foe acts, optionally run repeat-all for the next hero segment. */
function scheduleAutoRepeatPartyVolleyIfNeeded() {
  if (!state.autoRepeatPartyUntilCasualty) return;
  queueMicrotask(async () => {
    const modal = document.getElementById("modal-upgrades");
    if (modal.classList.contains("active")) return;
    if (shouldStopAutoRepeatParty()) {
      disarmAutoRepeatParty();
      renderBattle();
      return;
    }
    const actor = battleOver() ? null : getNextActor();
    if (!actor || actor.kind !== "hero") return;
    if (!canRepeatAllParty()) {
      renderBattle();
      return;
    }
    await onRepeatAllParty();
    if (shouldStopAutoRepeatParty()) disarmAutoRepeatParty();
    renderBattle();
  });
}

function battleOver() {
  const heroesDead = aliveHeroes().length === 0;
  const enemyDead = !state.enemy || state.enemy.hp <= 0;
  return heroesDead || enemyDead;
}

function applyDamage(target, amount, opts = {}) {
  const allowRedirect = opts.allowRedirect !== false;
  const hpNow = Number(target.hp);
  const safeHp = Number.isFinite(hpNow) ? hpNow : 0;
  const hit = Number(amount);
  const rawHit = Number.isFinite(hit) ? Math.max(0, Math.floor(hit)) : 0;
  const uniqueGuardRelic = (target?.relics || []).find((r) => r.id === "unique_relic_guard");
  const uniqueGuardStacks = Math.max(0, Number(uniqueGuardRelic?.stacks || 0));
  const uniqueRelicCount = uniqueGuardStacks > 0
    ? new Set((target?.relics || []).map((r) => String(r?.id || "")).filter(Boolean)).size
    : 0;
  const uniqueGuardBlock = uniqueRelicCount * uniqueGuardStacks;
  const safeHit = Math.max(0, rawHit - uniqueGuardBlock);

  if (
    allowRedirect &&
    target?.kind === "hero" &&
    (target.relics || []).some((r) => r.id === "cherub_martyr_split") &&
    safeHit > 0
  ) {
    const allies = aliveHeroes().filter((h) => h !== target);
    if (allies.length > 0) {
      const selfDamage = Math.floor(safeHit / 2);
      const redirectTotal = safeHit - selfDamage;
      target.hp = Math.max(0, safeHp - selfDamage);
      const redirected = [];
      const baseShare = Math.floor(redirectTotal / allies.length);
      let rem = redirectTotal - baseShare * allies.length;
      for (const ally of allies) {
        const dmg = baseShare + (rem > 0 ? 1 : 0);
        if (rem > 0) rem -= 1;
        if (dmg <= 0) continue;
        const res = applyDamage(ally, dmg, { allowRedirect: false });
        redirected.push({ target: ally, damage: res.primary });
      }
      return { primary: selfDamage, redirected, total: safeHit };
    }
  }

  target.hp = Math.max(0, safeHp - safeHit);
  return { primary: safeHit, redirected: [], total: safeHit };
}

function applyHeal(target, amount) {
  target.hp = Math.min(target.maxHp, target.hp + amount);
}

function healAmountFromHealer(healer) {
  return Math.ceil(healer.maxHp * COMBAT.HEAL_MAX_HP_FRAC);
}

function performSkill(actor, skill) {
  skill = normalizeSkillDef(skill);
  const name = actor.def.name;
  const sk = skill.name;
  if (skill.type !== "damage") return;
  const atkCls = actor.kind === "hero" ? "player" : "enemy";
  registerSkillAction(actor);
  if (actor.kind === "hero") {
    const tgt = state.enemy;
    if (!tgt || tgt.hp <= 0) return;
    let dealt = computeDamage(actor);
    const judgementRelic = (actor.relics || []).find((r) => r.id === "judgement_round_bonus");
    if (judgementRelic) dealt += Math.max(1, Number(state.round || 1));
    const chariotRelic = (actor.relics || []).find((r) => r.id === "chariot_third_strike");
    if (chariotRelic) {
      const cur = Math.max(1, Number(chariotRelic.counter || 3));
      if (cur <= 1) {
        dealt *= 2;
        chariotRelic.counter = 3;
      } else {
        chariotRelic.counter = cur - 1;
      }
    }
    const justice = aliveHeroes().find((h) => h.def.id === "justice" && (h.relics || []).some((r) => r.id === "justice_equal_atk"));
    if (justice && actor !== justice) {
      const justiceAtk = effectiveStats(justice).attack;
      const actorAtk = effectiveStats(actor).attack;
      const hasPeerMatch = aliveHeroes().some((h) => h !== justice && effectiveStats(h).attack === justiceAtk);
      if (hasPeerMatch && actorAtk === justiceAtk) dealt = Math.floor(dealt * 1.5);
    }
    const dealtRes = applyDamage(tgt, dealt);
    if (dealtRes.total > 0) {
      queueCombatFloat(tgt.def.id, `-${dealtRes.primary}`, "damage");
      for (const rr of dealtRes.redirected) {
        queueCombatFloat(rr.target.def.id, `-${rr.damage}`, "damage");
      }
    }
    logLine(
      `<span class="${atkCls}">${name}</span> uses <strong>${sk}</strong> on <span class="enemy">${tgt.def.name}</span> for <strong>${dealtRes.total}</strong> damage.`
    );
    const seraphRelic = (actor.relics || []).find((r) => r.id === "seraph_heal");
    if (seraphRelic) {
      const pct = Math.max(0, Number(seraphRelic.valuePercent || 10)) / 100;
      const healFromSeraph = Math.max(1, Math.floor(actor.maxHp * pct));
      for (const ally of aliveHeroes()) {
        applyHeal(ally, healFromSeraph);
        queueCombatFloat(ally.def.id, `+${healFromSeraph}`, "heal");
      }
    }
    const cradleRelic = (actor.relics || []).find((r) => r.id === "cradle_last_stand_revive");
    if (cradleRelic) {
      const living = aliveHeroes();
      if (living.length === 1 && living[0] === actor) {
        const pct = Math.max(0, Number(cradleRelic.valuePercent || 20)) / 100;
        const revived = [];
        for (const ally of state.party) {
          if (ally === actor) continue;
          const restore = Math.max(1, Math.floor(ally.maxHp * pct));
          if (ally.hp < restore) {
            ally.hp = restore;
            queueCombatFloat(ally.def.id, `+${restore}`, "heal");
            revived.push(ally.def.name);
          }
        }
        if (revived.length) {
          logLine(
            `<span class="${atkCls}">${name}</span>'s <strong>Last Cradle</strong> restores ${escapeHtml(revived.join(", "))} to ${Math.round(pct * 100)}% HP.`
          );
        }
      }
    }
    return;
  }
  const heroes = aliveHeroes();
  const absolutionRelic = (actor.relics || []).find((r) => r.id === "absolution_everpain");
  if (absolutionRelic && heroes.length) {
    const roundStacks = relicRoundTierStacks();
    absolutionRelic.stacks = roundStacks;
    const turnNo = Math.max(1, Number(state.turnsElapsedInEncounter || 0) + 1);
    const relicDamage = Math.max(1, Math.floor(turnNo * roundStacks));
    let relicTotal = 0;
    for (const hero of heroes) {
      const dmgRes = applyDamage(hero, relicDamage);
      relicTotal += dmgRes.total;
      queueCombatFloat(hero.def.id, `-${dmgRes.primary}`, "damage");
      for (const rr of dmgRes.redirected) {
        queueCombatFloat(rr.target.def.id, `-${rr.damage}`, "damage");
      }
    }
    const names = heroes.map((h) => h.def.name).join(", ");
    logLine(
      `<span class="enemy">${escapeHtml(actor.def.name)}</span>'s <strong>Everpain</strong> deals <strong>${relicTotal}</strong> total to all heroes (${escapeHtml(names)}) (${turnNo} x ${roundStacks} each).`
    );
  }
  let total = 0;
  for (const h of heroes) {
    const dealt = computeDamage(actor);
    const dealtRes = applyDamage(h, dealt);
    total += dealtRes.total;
    if (dealtRes.total > 0) {
      queueCombatFloat(h.def.id, `-${dealtRes.primary}`, "damage");
      for (const rr of dealtRes.redirected) {
        queueCombatFloat(rr.target.def.id, `-${rr.damage}`, "damage");
      }
    }
  }
  const names = heroes.map((h) => h.def.name).join(", ");
  logLine(
    `<span class="${atkCls}">${name}</span> uses <strong>${sk}</strong> on all heroes (${escapeHtml(names)}) — <strong>${total}</strong> total damage.`
  );
}

function enemyPickSkill() {
  return BASIC_ATTACK_SKILL;
}

function heroPickSkill(hero) {
  void hero;
  return BASIC_ATTACK_SKILL;
}

function endActorTurn(actor) {
  state.battleInputLocked = false;
  tickBuffsForActor(actor);
  if (actor.kind === "hero") {
    state.heroesActedThisVolley.add(actor.def.id);
  } else {
    state.heroesActedThisVolley.clear();
  }
  renderBattle();
  if (battleOver()) {
    disarmAutoRepeatParty();
    return resolveBattleOutcome();
  }
  const continueTurnFlow = () => {
    runNextTurn();
    if (actor.kind === "enemy" && !battleOver()) scheduleAutoRepeatPartyVolleyIfNeeded();
  };
  if (state.pendingRelicTurnAdvance) {
    state.pendingRelicTurnAdvance = false;
    processRelicsOnTurnAdvance();
  }
  renderBattle();
  if (battleOver()) {
    disarmAutoRepeatParty();
    return resolveBattleOutcome();
  }
  continueTurnFlow();
}

function runNextTurn() {
  if (battleOver()) return resolveBattleOutcome();
  const actor = getNextActor();
  if (!actor) return resolveBattleOutcome();
  if (actor.kind === "enemy") {
    const skill = enemyPickSkill();
    if (!skill) return resolveBattleOutcome();
    window.setTimeout(() => {
      try {
        performSkill(actor, skill);
        renderBattle();
        if (battleOver()) {
          resolveBattleOutcome();
          return;
        }
      } catch (err) {
        console.error("[battle] enemy action failed", err);
      }
      window.setTimeout(() => {
        if (!battleOver()) endActorTurn(actor);
      }, scaledDelay(SKILL_POST_DELAY_MS));
    }, scaledDelay(280));
    renderBattle();
    return;
  }

  const skill = heroPickSkill(actor);
  if (!skill) return resolveBattleOutcome();
  void runHeroSkillTurn(actor, skill);
}

function resolveBattleOutcome() {
  disarmAutoRepeatParty();
  const heroesDead = aliveHeroes().length === 0;
  const enemyDead = state.enemy && state.enemy.hp <= 0;
  if (heroesDead) {
    playAttackHitSfx();
    logLine(`<span class="system">Defeat — your party fell on round ${state.round}.</span>`);
    setTimeout(() => {
      document.getElementById("end-title").textContent = "Defeat";
      document.getElementById("end-body").innerHTML = defeatSummaryHtml();
      showScreen("screen-end");
    }, scaledDelay(800));
    return;
  }
  if (enemyDead) {
    playAttackHitSfx();
    logLine(`<span class="system">Victory — round ${state.round} cleared!</span>`);
    rallyDeadHeroesAfterVictory();
    if (state.round >= COMBAT.TOTAL_ROUNDS) {
      setTimeout(() => advanceToNextRound(), scaledDelay(500));
      return;
    }
    setTimeout(() => openUpgradeModal(), scaledDelay(500));
  }
}

/** Fallen allies stand at 10% max HP after a won fight (before upgrades). */
function rallyDeadHeroesAfterVictory() {
  for (const h of state.party) {
    if (h.hp > 0) continue;
    const restored = Math.max(1, Math.floor(h.maxHp * 0.1));
    h.hp = restored;
    logLine(
      `<span class="system">${escapeHtml(h.def.name)} is rallied — <strong>${restored}</strong> HP (10% of max).</span>`
    );
  }
}

function applyRoundStartRelicGrowth() {
  for (const h of state.party) {
    for (const relic of h.relics || []) {
      if (relic.id === "growth_hp_round") {
        const gain = Math.max(1, Number(relic.stacks || 0));
        h.maxHp += gain;
        h.hp += gain;
      } else if (relic.id === "growth_atk_round") {
        h.attack += Math.max(1, Number(relic.stacks || 0));
      } else if (relic.id === "growth_hybrid_round") {
        const gain = Math.max(1, Number(relic.stacks || 0));
        h.maxHp += gain;
        h.hp += gain;
        h.attack += gain;
      } else if (relic.id === "round_heal_scaling") {
        const stacks = Math.max(1, Number(relic.stacks || 0));
        const heal = Math.max(1, Number(state.round || 1)) * stacks;
        h.hp = Math.min(h.maxHp, Math.max(0, Number(h.hp || 0)) + heal);
      }
    }
  }
}

function renderHpBar(fillEl, textEl, f) {
  const eff = effectiveStats(f);
  const shownMaxRaw = Number(eff.maxHp || f.maxHp);
  const shownMax = Number.isFinite(shownMaxRaw) && shownMaxRaw > 0 ? shownMaxRaw : 1;
  const hpRaw = Number(f.hp);
  const shownHp = Number.isFinite(hpRaw) ? Math.max(0, hpRaw) : 0;
  const pct = Math.round((shownHp / shownMax) * 100);
  fillEl.style.width = `${pct}%`;
  textEl.textContent = `${Math.ceil(shownHp)} / ${Math.ceil(shownMax)} HP`;
}

function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** One-line label for a turn-based buff row on the fighter. */
function buffChipLabel(b) {
  const stat = b.stat || "?";
  const stacks = Math.max(0, Number(b.stacks ?? b.duration ?? 0));
  if (stacks > 0) {
    return `${stat} +${Math.round(COMBAT.SUPPORT_BUFF_STAT_FRAC_PER_STACK * 100 * stacks)}% (${stacks} stacks)`;
  }
  if (b.percentFrac != null && b.duration != null) {
    return `+${Math.round(Number(b.percentFrac) * 100)}% ${stat} (${b.duration}t)`;
  }
  const amt = Number(b.amount) || 0;
  return `+${amt} ${stat}`;
}

function relicChipHtml(relic) {
  const id = String(relic?.id || "");
  const stackN = Math.max(0, Number(relic?.stacks || 0));
  const hasHolderContext = Array.isArray(relic?.holderRelics);
  const growthStacks = Math.max(1, Number(relic?.stacks || 0));
  const interval = Math.max(0, Number(relic?.intervalTurns || 0));
  const pct = Math.max(0, Number(relic?.valuePercent || 0));
  const scaleValue = Number(relic?.valueScale || 0);
  const uniqueRelicCount = new Set(
    (Array.isArray(relic?.holderRelics) ? relic.holderRelics : [])
      .map((r) => String(r?.id || ""))
      .filter(Boolean)
  ).size;
  const uniqueGuardStacks = Math.max(1, Number(relic?.stacks || 0));
  const uniqueGuardBlock = uniqueRelicCount * uniqueGuardStacks;
  const isRoundGrowthRelic =
    id === "growth_hp_round" || id === "growth_atk_round" || id === "growth_hybrid_round";
  const roundCounter = Math.max(1, Number(state.round || 1));
  const stackBadge = stackN > 0 ? stackN : 0;
  const counter = stackBadge ? `<span class="relic-counter">${stackBadge}</span>` : "";
  const title =
    id === "rapture"
      ? `Rapture: +10% ATK/MaxHP every ${interval || 10} turns (current +${stackN * 10}%)`
      : id === "seraph_heal"
        ? `Seraph Relic: attacks heal allies for ${pct || 10}% max HP`
        : id === "chariot_third_strike"
          ? "Chariot Relic: every 3rd attack deals double damage"
          : id === "judgement_round_bonus"
            ? "Judgement Relic: each attack deals bonus damage equal to current round"
            : id === "growth_hp_round"
              ? `Round Relic: gain +${growthStacks} Max HP at the start of each round`
              : id === "growth_atk_round"
                ? `Round Relic: gain +${growthStacks} ATK at the start of each round`
                : id === "growth_hybrid_round"
                  ? `Round Relic: gain +${growthStacks} Max HP and +${growthStacks} ATK at the start of each round`
                  : id === "round_heal_scaling"
                    ? `Round Relic: heal ${roundCounter * growthStacks} HP at the start of each round (${roundCounter} x ${growthStacks} stacks)`
                    : id === "unique_relic_guard"
                      ? (hasHolderContext
                        ? `Relic Guard: reduce incoming damage by ${uniqueGuardBlock} (${uniqueRelicCount} unique relics x ${uniqueGuardStacks} stacks)`
                        : `Relic Guard: reduce incoming damage by unique relics x stacks`)
                    : id === "double_draft_pick"
                      ? "Twin Claim: if only this holder is assigned relics this round, they can draft 2 relics instead of 1"
                    : id === "micheal_fallen_fury"
                      ? `Micheal Relic: gains +${Math.max(0, 3 - aliveHeroes().length) * 10 * Math.max(1, stackN)}% ATK from fallen heroes (${Math.max(0, 3 - aliveHeroes().length)} dead x tier ${Math.max(1, stackN)})`
                    : id === "cradle_last_stand_revive"
                      ? "Cradle Relic: if Cradle attacks while the last hero alive, revive and heal the other allies to 20% HP"
                    : id === "chorus_diminuendo"
                      ? (() => {
                          const t = Math.min(5, Math.max(1, stackN || 1));
                          const every = Math.max(1, 6 - t);
                          return `Chorus Relic: all allies lose 1 max HP every ${every} full turn(s); stacks accelerate up to 5 (then every turn)`;
                        })()
                    : id === "golgotha_heartsear"
                      ? `Golgotha Relic: every 3 turns, deal ${relicRoundTierStacks() * 10}% max HP damage to the highest-HP hero`
                      : id === "absolution_everpain"
                      ? `Absolution Relic: each turn, deal turn# x ${relicRoundTierStacks()} to all heroes`
                      : id === "cherub_martyr_split"
                        ? "Cherub Relic: takes half incoming damage and splits the other half among allies"
            : id === "justice_equal_atk"
              ? "Justice Relic: allies with the same ATK as Justice deal 1.5x damage"
              : id === "enemy_scale"
              ? `Enemy Scale: multiplies enemy base ATK/MaxHP by ${scaleValue || 1}`
        : id;
  return `<span class="relic-chip" title="${escapeHtml(title)}" data-relic-tip="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">${counter}</span>`;
}

/** Compact HTML for active relics + stat buffs. */
function fighterEffectsHtml(f) {
  const holderRelics = f.relics || [];
  const relics = holderRelics.map((r) => relicChipHtml({ ...r, holderRelics })).join("");
  const chips = [];
  for (const b of f.buffs || []) {
    if ((b.stacks || 0) > 0 || (b.duration || 0) > 0) {
      chips.push(`<span class="effect-chip effect-buff">${escapeHtml(buffChipLabel(b))}</span>`);
    }
  }
  const rapture = (f.relics || []).find((r) => r.id === "rapture");
  const ra = Math.max(0, Number(rapture?.stacks || 0));
  if (ra > 0) {
    chips.push(
      `<span class="effect-chip effect-status">rapture +${ra * 10}% ATK / MaxHP</span>`
    );
  }
  const parts = [];
  if (relics) parts.push(`<div class="fighter-relics" aria-label="Active relics">${relics}</div>`);
  if (chips.length) parts.push(`<div class="fighter-effects" aria-label="Active buffs and statuses">${chips.join("")}</div>`);
  return parts.join("");
}

function defeatSummaryHtml() {
  const rows = (state.party || [])
    .map((h) => {
      const relics = h.relics || [];
      const atk = Math.max(0, Math.floor(Number(h?.attack || 0)));
      const relicRow = relics.length
        ? relics.map((r) => relicChipHtml({ ...r, holderRelics: relics })).join("")
        : '<span class="status-panel-hint">No assigned relics</span>';
      return `<article class="status-fighter">
        <h4>${escapeHtml(h?.def?.name || "Unknown")}</h4>
        <p class="stat-line">HP ${Math.max(0, Math.floor(Number(h?.hp || 0)))} / ${Math.max(1, Math.floor(Number(h?.maxHp || 1)))} · ATK ${atk}</p>
        <div class="fighter-relics">${relicRow}</div>
      </article>`;
    })
    .join("");
  return `<div class="defeat-summary">
    <p>You reached round ${state.round} of ${COMBAT.TOTAL_ROUNDS}.</p>
    <p>Party loadout at defeat:</p>
    <div>${rows}</div>
  </div>`;
}

function charDefReferenceBlockHtml(c) {
  const s = c.baseStats;
  const relics = defaultRelicsForDef(c, "hero");
  const relicRow = relics.length
    ? `<div class="fighter-relics" aria-label="Default relics">${relics.map((r) => relicChipHtml({ ...r, holderRelics: relics })).join("")}</div>`
    : "";
  return `<div class="status-fighter">
    <h4>${escapeHtml(c.name)}</h4>
    <p class="stat-line">Base HP ${s.maxHp} · ATK ${s.attack}</p>
    ${relicRow}
  </div>`;
}

/** Enemy-only sidebar: skills (names + mechanics summary) + cycle by skill names. */
function enemyBattleStatusHtml(e) {
  const def = e.def;
  const eff = effectiveStats(e);
  return `<div class="status-section">
    <h3>Enemy</h3>
    <div class="status-fighter status-foe-block">
      <h4>${escapeHtml(def.name)}</h4>
      <p class="stat-line">HP ${Math.ceil(e.hp)} / ${e.maxHp} · ATK ${eff.attack}</p>
      <div class="cycle-block">
        <p class="cycle-next"><strong>Action:</strong> ${escapeHtml(BASIC_ATTACK_SKILL.name)}</p>
      </div>
    </div>
  </div>`;
}

function applyBattleViewMode() {
  const hud = document.getElementById("battle-panel-hud");
  if (!hud) return;
  hud.classList.add("is-active");
  hud.setAttribute("aria-hidden", "false");
}

function applyArenaBackground() {
  const arena = document.querySelector(".battle-arena");
  if (!(arena instanceof HTMLElement)) return;
  arena.style.setProperty("--arena-bg-image", arenaBackgroundUrl ? `url("${arenaBackgroundUrl}")` : "none");
}

function updateBattleStatusPanel() {
  // Combat log/status area removed from battle UI.
}

function updatePartyInspectPanel(selectedCharDefs) {
  const el = document.getElementById("party-inspect");
  if (!el) return;
  if (!selectedCharDefs.length) {
    el.innerHTML =
      '<p class="status-panel-hint">Select up to 3 heroes to preview their stats and skills here.</p>';
    return;
  }
  const blocks = selectedCharDefs.map((c) => charDefReferenceBlockHtml(c)).join("");
  el.innerHTML = `<div class="status-section">
    <h3>Selected party (${selectedCharDefs.length}/3)</h3>
    ${blocks}
  </div>`;
}

function applySpriteToArenaTile(tile, def) {
  tile.textContent = "";
  tile.classList.remove("has-sprite");
  const existing = tile.querySelector(".sprite-img");
  if (existing) existing.remove();
  tile.classList.add("has-sprite");
  const img = document.createElement("img");
  img.className = "sprite-img";
  img.src = `sprites/${def.id}.png`;
  img.alt = def.name;
  img.draggable = false;
  img.onerror = () => {
    tile.classList.remove("has-sprite");
    img.remove();
    tile.textContent = spriteLabel(def);
  };
  tile.appendChild(img);
  tile.title = def.name;
}

/** Short text inside square placeholder sprites */
function spriteLabel(def) {
  const parts = def.name.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    const a = parts[0][0] || "";
    const b = parts[1][0] || "";
    return (a + b).toUpperCase();
  }
  const n = def.name;
  return n.length > 12 ? `${n.slice(0, 11)}…` : n;
}

function renderBattle() {
  const arenaParty = document.getElementById("arena-party");
  const arenaEnemy = document.getElementById("arena-enemy");
  const enemyHud = document.getElementById("enemy-hud");
  const partyHud = document.getElementById("party-hud");
  const skillDock = document.getElementById("skill-dock");
  arenaParty.innerHTML = "";
  arenaEnemy.innerHTML = "";
  partyHud.innerHTML = "";
  if (skillDock) skillDock.innerHTML = "";
  enemyHud.innerHTML = "";
  enemyHud.hidden = true;
  applyArenaBackground();

  const actor = battleOver() ? null : getNextActor();

  for (const h of state.party) {
    const tile = document.createElement("div");
    tile.className = "sprite-tile hero" + (h.hp <= 0 ? " dead" : "");
    tile.dataset.fighterId = h.def.id;
    if (actor === h) tile.classList.add("is-active");
    applySpriteToArenaTile(tile, h.def);
    arenaParty.appendChild(tile);

    const hud = document.createElement("article");
    hud.className = "hud-card" + (h.hp <= 0 ? " dead" : "");
    if (actor === h) hud.classList.add("is-active");
    const eff = effectiveStats(h);
    hud.innerHTML = `
      <h3>${h.def.name}</h3>
      <div class="hp-bar"><div class="hp-fill" data-fill></div></div>
      <div class="hp-text" data-hp></div>
      <div class="stats-row">ATK ${eff.attack}</div>
      ${fighterEffectsHtml(h)}
    `;
    renderHpBar(hud.querySelector("[data-fill]"), hud.querySelector("[data-hp]"), h);
    partyHud.appendChild(hud);
  }

  if (state.enemy) {
    const e = state.enemy;
    const tile = document.createElement("div");
    tile.className = "sprite-tile enemy" + (e.hp <= 0 ? " dead" : "");
    tile.dataset.fighterId = e.def.id;
    if (actor === e) tile.classList.add("is-active");
    applySpriteToArenaTile(tile, e.def);
    arenaEnemy.appendChild(tile);

    enemyHud.hidden = false;
    const effE = effectiveStats(e);
    enemyHud.innerHTML = `
      <h3>${e.def.name}</h3>
      <div class="hp-bar"><div class="hp-fill" data-enemy-fill></div></div>
      <div class="hp-text" data-enemy-hp></div>
      <div class="stats-row">ATK ${effE.attack}</div>
      ${fighterEffectsHtml(e)}
    `;
    renderHpBar(
      enemyHud.querySelector("[data-enemy-fill]"),
      enemyHud.querySelector("[data-enemy-hp]"),
      e
    );
  }

  const upgradeModalOpen = document.getElementById("modal-upgrades").classList.contains("active");
  const skillsEnabled = false;

  const repeatBtn = document.getElementById("btn-repeat-skill");
  if (repeatBtn) {
    const lastId = dockHero ? state.lastSkillIdByHeroId[dockHero.def.id] : null;
    const lastSkill =
      dockHero && lastId ? dockHero.def.skills.find((s) => s.id === lastId) : null;
    const repeatOk = skillsEnabled && !!lastSkill;
    repeatBtn.disabled = !repeatOk;
    repeatBtn.title = lastSkill ? `Use ${lastSkill.name} again` : "No previous skill this run";
    repeatBtn.onclick = () => {
      if (!repeatOk || !dockHero || !lastSkill) return;
      onHeroSkillChosen(dockHero, lastSkill);
    };
  }

  const repeatAllBtn = document.getElementById("btn-repeat-all-party");
  if (repeatAllBtn) {
    const repeatAllOk = skillsEnabled && canRepeatAllParty();
    repeatAllBtn.disabled = !repeatAllOk;
    const chain = pendingHeroesBeforeNextEnemy();
    if (!skillsEnabled) {
      repeatAllBtn.title = "Only on your hero's turn";
    } else if (!chain.every((h) => !!heroRepeatAllSkillOrNull(h))) {
      repeatAllBtn.title =
        "Each ally that acts before the foe this segment needs a recorded skill (finish one full round, or use a skill once this run)";
    } else {
      repeatAllBtn.title = `Repeat each ally's last full-round skill in order: ${chain.map((h) => h.def.name).join(", ")}`;
    }
    repeatAllBtn.onclick = () => {
      if (!repeatAllOk) return;
      void onRepeatAllParty();
    };
  }

  const repeatAutoBtn = document.getElementById("btn-repeat-all-auto");
  if (repeatAutoBtn) {
    const autoOn = state.autoRepeatPartyUntilCasualty;
    const canArm = skillsEnabled && canRepeatAllParty();
    const autoBtnEnabled =
      !battleOver() && !upgradeModalOpen && (autoOn || canArm);
    repeatAutoBtn.disabled = !autoBtnEnabled;
    repeatAutoBtn.classList.toggle("is-auto-armed", autoOn);
    repeatAutoBtn.setAttribute("aria-pressed", autoOn ? "true" : "false");
    repeatAutoBtn.textContent = autoOn ? "Stop auto" : "Auto all";
    if (!autoBtnEnabled) {
      repeatAutoBtn.title = battleOver()
        ? "Battle over"
        : upgradeModalOpen
          ? "Not during upgrade pick"
          : "Arm on your turn when Repeat all is available";
    } else if (autoOn) {
      repeatAutoBtn.title =
        "Auto is on — repeats all after each foe turn until an ally or this foe dies. Click to stop.";
    } else {
      repeatAutoBtn.title =
        "After each enemy turn, repeat all once (same rules as Repeat all). Stops if any ally or this foe dies.";
    }
    repeatAutoBtn.onclick = () => {
      if (!autoBtnEnabled) return;
      if (state.autoRepeatPartyUntilCasualty) {
        disarmAutoRepeatParty();
        renderBattle();
        return;
      }
      if (!skillsEnabled || !canRepeatAllParty()) return;
      armAutoRepeatParty();
      void (async () => {
        await onRepeatAllParty();
        if (shouldStopAutoRepeatParty()) disarmAutoRepeatParty();
        renderBattle();
      })();
    };
  }

  document.getElementById("enemy-name").textContent = state.enemy
    ? `Foe: ${state.enemy.def.name}`
    : "";
  document.getElementById("turn-label").textContent = `Turn ${state.turnsElapsedInEncounter + 1}`;

  flushCombatFloats();

  updateBattleStatusPanel();
  applyBattleViewMode();
}

function onHeroSkillChosen(actor, skill) {
  if (battleOver() || state.battleInputLocked) return;
  void runHeroSkillTurn(actor, skill);
}

/**
 * Run one hero skill with post-skill pacing (same for manual, repeat, and auto-repeat).
 * @param {BattleFighter} actor
 * @param {any} skill
 */
function runHeroSkillTurn(actor, skill) {
  return new Promise((resolve) => {
    if (battleOver()) {
      resolve();
      return;
    }
    if (state.battleInputLocked) {
      resolve();
      return;
    }
    const cur = getNextActor();
    if (cur !== actor) {
      resolve();
      return;
    }
    state.battleInputLocked = true;
    try {
      const sk = normalizeSkillDef(skill);
      state.lastSkillIdByHeroId[actor.def.id] = sk.id;
      performSkill(actor, sk);
      renderBattle();
      if (battleOver()) {
        state.battleInputLocked = false;
        resolveBattleOutcome();
        resolve();
        return;
      }
      window.setTimeout(() => {
        if (!battleOver()) endActorTurn(actor);
        else state.battleInputLocked = false;
        resolve();
      }, scaledDelay(SKILL_POST_DELAY_MS));
    } catch (err) {
      console.error("[battle] hero action failed", err);
      state.battleInputLocked = false;
      if (!battleOver()) endActorTurn(actor);
      resolve();
    }
  });
}

/** Use each pending hero's last skill in order until the next actor is the enemy or the battle ends. */
async function onRepeatAllParty() {
  if (battleOver()) return;
  if (document.getElementById("modal-upgrades").classList.contains("active")) return;
  if (!canRepeatAllParty()) return;

  while (!battleOver()) {
    const cur = getNextActor();
    if (!cur || cur.kind !== "hero") break;

    const lastSkill = heroRepeatAllSkillOrNull(cur);
    if (!lastSkill) break;

    await runHeroSkillTurn(cur, lastSkill);
    if (battleOver()) break;
    if (shouldStopAutoRepeatParty()) {
      disarmAutoRepeatParty();
      break;
    }
  }
  renderBattle();
}

function makeDraftRelicInstance(base) {
  return {
    id: base.id,
    stacks: 1,
  };
}

function addOrStackDraftRelic(hero, baseRelic) {
  const relicId = String(baseRelic?.id || "");
  hero.relics = hero.relics || [];
  if (relicId === "double_draft_pick") {
    if (hero.relics.some((r) => r.id === relicId)) return;
    hero.relics.push(makeDraftRelicInstance(baseRelic));
    return;
  }
  if (
    relicId === "growth_hp_round" ||
    relicId === "growth_atk_round" ||
    relicId === "growth_hybrid_round" ||
    relicId === "round_heal_scaling" ||
    relicId === "unique_relic_guard"
  ) {
    const existing = hero.relics.find((r) => r.id === relicId);
    if (existing) {
      existing.stacks = Math.max(1, Number(existing.stacks || 0)) + 1;
      return;
    }
  }
  hero.relics.push(makeDraftRelicInstance(baseRelic));
}

function openRelicDraftModal({ title, subtitle, onDone }) {
  disarmAutoRepeatParty();
  const modal = document.getElementById("modal-upgrades");
  const modalCard = modal.querySelector(".modal");
  const titleEl = document.querySelector("#modal-upgrades h2");
  const subtitleEl = document.querySelector("#modal-upgrades .tagline");
  const list = document.getElementById("upgrade-list");
  modalCard?.classList.add("modal-relic-draft");
  titleEl.textContent = title;
  subtitleEl.textContent = subtitle;
  list.innerHTML = "";

  const allHeroesHaveTwinClaim =
    state.party.length === 3 &&
    state.party.every((h) => (h.relics || []).some((r) => r.id === "double_draft_pick"));
  const sourcePoolIds = allHeroesHaveTwinClaim
    ? draftPoolRelicIds.filter((id) => id !== "double_draft_pick")
    : draftPoolRelicIds;
  const pool = sourcePoolIds
    .map((id) => RELIC_BY_ID[id])
    .filter(Boolean)
    .map((r) => ({ ...r }));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  pool.splice(3);
  /** @type {{ heroId: string, relic: any } | null} */
  let assignedPrimary = null;
  /** @type {{ heroId: string, relic: any } | null} */
  let assignedSecondary = null;
  let armedPoolIdx = -1;

  const hasTwinClaim = (heroId) => {
    const h = state.party.find((x) => x.def.id === heroId);
    return !!h && (h.relics || []).some((r) => r.id === "double_draft_pick");
  };
  const canHeroTakeTwo = (heroId) => {
    if (!hasTwinClaim(heroId)) return false;
    const heroIds = [assignedPrimary?.heroId, assignedSecondary?.heroId].filter(Boolean);
    return !heroIds.length || heroIds.every((id) => id === heroId);
  };
  const unassignBySlot = (slot) => {
    if (slot === "secondary") {
      if (!assignedSecondary) return;
      pool.push(assignedSecondary.relic);
      assignedSecondary = null;
      return;
    }
    if (!assignedPrimary) return;
    pool.push(assignedPrimary.relic);
    if (assignedSecondary) {
      assignedPrimary = assignedSecondary;
      assignedSecondary = null;
    } else {
      assignedPrimary = null;
    }
  };
  const assignToHero = (heroId, relic) => {
    if (!assignedPrimary) {
      assignedPrimary = { heroId, relic };
      return;
    }
    if (assignedPrimary.heroId !== heroId) {
      pool.push(assignedPrimary.relic);
      if (assignedSecondary) pool.push(assignedSecondary.relic);
      assignedPrimary = { heroId, relic };
      assignedSecondary = null;
      return;
    }
    if (canHeroTakeTwo(heroId)) {
      if (!assignedSecondary) {
        assignedSecondary = { heroId, relic };
      } else {
        pool.push(assignedSecondary.relic);
        assignedSecondary = { heroId, relic };
      }
      return;
    }
    pool.push(assignedPrimary.relic);
    assignedPrimary = { heroId, relic };
    assignedSecondary = null;
  };

  const root = document.createElement("div");
  root.className = "relic-draft-layout";
  const left = document.createElement("section");
  left.className = "relic-draft-pool";
  const right = document.createElement("section");
  right.className = "relic-draft-targets";
  root.append(left, right);
  list.appendChild(root);

  const footer = document.createElement("div");
  footer.className = "relic-draft-actions";
  const skipBtn = document.createElement("button");
  skipBtn.type = "button";
  skipBtn.className = "btn";
  skipBtn.textContent = "Skip";
  const doneBtn = document.createElement("button");
  doneBtn.type = "button";
  doneBtn.className = "btn btn-primary";
  doneBtn.textContent = "Confirm relics";
  footer.append(skipBtn, doneBtn);
  list.appendChild(footer);

  const closeAndContinue = (applyAssignments) => {
    if (applyAssignments) {
      for (const h of state.party) {
        const picks = [];
        if (assignedPrimary && assignedPrimary.heroId === h.def.id) picks.push(assignedPrimary.relic);
        if (assignedSecondary && assignedSecondary.heroId === h.def.id) picks.push(assignedSecondary.relic);
        for (const base of picks) addOrStackDraftRelic(h, base);
      }
    }
    modalCard?.classList.remove("modal-relic-draft");
    modal.classList.remove("active");
    onDone();
  };

  skipBtn.addEventListener("click", () => closeAndContinue(false));
  doneBtn.addEventListener("click", () => closeAndContinue(true));

  left.addEventListener("dragover", (ev) => ev.preventDefault());
  left.addEventListener("drop", (ev) => {
    ev.preventDefault();
    const slot = ev.dataTransfer?.getData("text/relic-assigned-slot");
    if (!slot) return;
    unassignBySlot(slot);
    armedPoolIdx = -1;
    render();
  });

  const render = () => {
    left.innerHTML = `<h3>New relics</h3>`;
    right.innerHTML = `<h3>Assign to party</h3>`;
    const poolWrap = document.createElement("div");
    poolWrap.className = "fighter-relics relic-pool-strip";
    pool.forEach((relic, idx) => {
      const chipWrap = document.createElement("span");
      chipWrap.className = "relic-draft-chip-wrap";
      chipWrap.dataset.poolIdx = String(idx);
      chipWrap.innerHTML = `
        ${relicChipHtml({ ...relic, counter: 1 })}
        <span class="relic-draft-desc">${escapeHtml(relic.desc)}</span>
      `;
      if (armedPoolIdx === idx) chipWrap.classList.add("is-armed");
      const chip = chipWrap.querySelector(".relic-chip");
      chip?.classList.add("relic-draft-chip");
      chip?.setAttribute("draggable", "true");
      chip?.addEventListener("dragstart", (ev) => {
        ev.dataTransfer?.setData("text/relic-pool-idx", String(idx));
        ev.dataTransfer.effectAllowed = "move";
      });
      chip?.addEventListener("click", () => {
        armedPoolIdx = idx;
        render();
      });
      poolWrap.appendChild(chipWrap);
    });
    left.appendChild(poolWrap);
      if (!pool.length) {
      const done = document.createElement("p");
      done.className = "status-panel-hint";
      done.textContent = "All new relics assigned. Drag a chip back here to unassign.";
      left.appendChild(done);
    }

    for (const h of state.party) {
      const slot = document.createElement("article");
      slot.className = "relic-target-card";
      slot.dataset.heroId = h.def.id;
      const projectedHolderRelics = () => {
        const base = [...(h.relics || [])];
        if (assignedPrimary && assignedPrimary.heroId === h.def.id) base.push(assignedPrimary.relic);
        if (assignedSecondary && assignedSecondary.heroId === h.def.id) base.push(assignedSecondary.relic);
        return base;
      };
      const existing = (h.relics || []).map((r) => relicChipHtml({ ...r, holderRelics: projectedHolderRelics() })).join("");
      const hasTwin = hasTwinClaim(h.def.id);
      const lockedToOtherHero = !!assignedPrimary && assignedPrimary.heroId !== h.def.id;
      const assignedRelics = [];
      if (assignedPrimary && assignedPrimary.heroId === h.def.id) {
        assignedRelics.push({ slot: "primary", relic: assignedPrimary.relic });
      }
      if (assignedSecondary && assignedSecondary.heroId === h.def.id) {
        assignedRelics.push({ slot: "secondary", relic: assignedSecondary.relic });
      }
      const twoPickHint = hasTwinClaim(h.def.id)
        ? `<div class="status-panel-hint">Twin Claim: this holder can take 2 relics if no other ally is assigned one this round.</div>`
        : "";
      const primaryAssigned = assignedRelics.find((x) => x.slot === "primary");
      const secondaryAssigned = assignedRelics.find((x) => x.slot === "secondary");
      const primaryEnabled = !lockedToOtherHero;
      const secondaryEnabled = !lockedToOtherHero && hasTwin && canHeroTakeTwo(h.def.id);
      slot.innerHTML = `
        <h4>${escapeHtml(h.def.name)}</h4>
        <div class="fighter-relics">${existing || '<span class="status-panel-hint">No assigned relics</span>'}</div>
        ${twoPickHint}
        <div class="relic-drop-row">
          <div class="relic-drop-zone ${primaryEnabled ? "" : "is-disabled"}" data-drop-slot="primary">
            ${primaryAssigned ? `<span class="relic-draft-chip-wrap is-assigned" draggable="true" data-assigned-slot="primary">${relicChipHtml({ ...primaryAssigned.relic, counter: 1, holderRelics: projectedHolderRelics() })}</span>` : '<span class="relic-drop-plus" aria-hidden="true">+</span>'}
          </div>
          ${hasTwin ? `<div class="relic-drop-zone ${secondaryEnabled ? "" : "is-disabled"}" data-drop-slot="secondary">${secondaryAssigned ? `<span class="relic-draft-chip-wrap is-assigned" draggable="true" data-assigned-slot="secondary">${relicChipHtml({ ...secondaryAssigned.relic, counter: 1, holderRelics: projectedHolderRelics() })}</span>` : '<span class="relic-drop-plus" aria-hidden="true">+</span>'}</div>` : ""}
        </div>
      `;
      slot.querySelectorAll(".relic-draft-chip-wrap.is-assigned").forEach((chipWrap) => {
        const slotId = chipWrap.getAttribute("data-assigned-slot") || "primary";
        const assignedIcon = chipWrap.querySelector(".relic-chip");
        assignedIcon?.classList.add("relic-draft-chip");
        assignedIcon?.setAttribute("draggable", "true");
        assignedIcon?.addEventListener("dragstart", (ev) => {
          ev.dataTransfer?.setData("text/relic-assigned-slot", slotId);
          ev.dataTransfer.effectAllowed = "move";
        });
        assignedIcon?.addEventListener("click", () => {
          unassignBySlot(slotId);
          armedPoolIdx = -1;
          render();
        });
      });
      slot.querySelectorAll(".relic-drop-zone").forEach((zone) => {
        const dropSlot = zone.getAttribute("data-drop-slot") || "primary";
        const zoneEnabled = dropSlot === "secondary" ? secondaryEnabled : primaryEnabled;
        zone.addEventListener("click", () => {
          if (!zoneEnabled) return;
          if (!Number.isInteger(armedPoolIdx) || armedPoolIdx < 0 || armedPoolIdx >= pool.length) return;
          const picked = pool.splice(armedPoolIdx, 1)[0];
          assignToHero(h.def.id, picked);
          armedPoolIdx = -1;
          render();
        });
        zone.addEventListener("dragover", (ev) => {
          if (!zoneEnabled) return;
          ev.preventDefault();
          zone.classList.add("is-over");
        });
        zone.addEventListener("dragleave", () => zone.classList.remove("is-over"));
        zone.addEventListener("drop", (ev) => {
          if (!zoneEnabled) return;
          ev.preventDefault();
          zone.classList.remove("is-over");
          const fromSlot = ev.dataTransfer?.getData("text/relic-assigned-slot");
          if (fromSlot) {
            const moved =
              fromSlot === "secondary" ? assignedSecondary?.relic : assignedPrimary?.relic;
            if (!moved) return;
            unassignBySlot(fromSlot);
            assignToHero(h.def.id, moved);
            render();
            return;
          }
          const idxRaw = ev.dataTransfer?.getData("text/relic-pool-idx");
          const idx = Number(idxRaw);
          if (!Number.isInteger(idx) || idx < 0 || idx >= pool.length) return;
          const picked = pool.splice(idx, 1)[0];
          assignToHero(h.def.id, picked);
          armedPoolIdx = -1;
          render();
        });
      });
      right.appendChild(slot);
    }
  };

  render();
  modal.classList.add("active");
}

function openUpgradeModal() {
  openRelicDraftModal({
    title: "Round clear — assign new relics",
    subtitle: "Pick 1 of 3 relics and assign it to one ally, or skip.",
    onDone: () => advanceToNextRound(),
  });
  renderBattle();
}

function openPreRoundUpgradeModal() {
  openRelicDraftModal({
    title: "Pre-battle relic draft",
    subtitle: "Pick 1 of 3 relics before Round 1 starts, or skip.",
    onDone: () => startBattleEncounter(),
  });
}

function advanceToNextRound() {
  if (state.round >= COMBAT.TOTAL_ROUNDS) {
    document.getElementById("end-title").textContent = "Victory";
    document.getElementById("end-body").textContent =
      `Your party survived all ${COMBAT.TOTAL_ROUNDS} rounds of the gauntlet.`;
    showScreen("screen-end");
    return;
  }
  state.round += 1;
  startBattleEncounter();
}

function startBattleEncounter() {
  disarmAutoRepeatParty();
  state.pendingCombatFloats.length = 0;
  state.turnsElapsedInEncounter = 0;
  state.pendingRelicTurnAdvance = false;
  state.actedSkillActorKeys.clear();
  showScreen("screen-battle");
  document.getElementById("round-label").textContent = `Round ${state.round} / ${COMBAT.TOTAL_ROUNDS}`;
  applyRoundStartRelicGrowth();
  for (const h of state.party) h.relics = h.relics || [];
  const def = enemyDefs[Math.floor(Math.random() * enemyDefs.length)];
  state.enemy = enemyFromDef(def, state.round);
  clearLog();
  logLine(
    `<span class="system">Round ${state.round} — ${state.enemy.def.name} appears (scale ×${roundScale(state.round).toFixed(2)}).</span>`
  );
  state.actedThisCycle.clear();
  state.heroesActedThisVolley.clear();
  state.battleInputLocked = false;
  state.skillDockHeroId = null;
  state.lastPartyVolleySkills = {};
  renderBattle();
  runNextTurn();
}

function beginRun(selectedIds) {
  state.round = 1;
  state.turnsElapsedInEncounter = 0;
  state.pendingRelicTurnAdvance = false;
  state.actedSkillActorKeys.clear();
  state.heroesActedThisVolley.clear();
  state.battleView = "hud";
  state.lastSkillIdByHeroId = {};
  state.lastPartyVolleySkills = {};
  disarmAutoRepeatParty();
  state.party = selectedIds.map((id) => {
    const def = characterDefs.find((c) => c.id === id);
    return heroFromDef(def);
  });
  openPreRoundUpgradeModal();
}

function renderPartyPicker() {
  const host = document.getElementById("party-picker");
  host.innerHTML = "";
  const selected = new Set();
  const selectedDefsForInspect = () =>
    [...selected]
      .map((id) => characterDefs.find((c) => c.id === id))
      .filter(Boolean);

  const syncBtn = () => {
    document.getElementById("btn-start").disabled = selected.size !== 3;
  };

  if (characterDefs.length < 3 || enemyDefs.length < 1) {
    host.innerHTML = `<p class="status-panel-hint">Need at least <strong>3 allies</strong> and <strong>1 enemy</strong> that each have <code>sprites/&lt;id&gt;.png</code> (units without a sprite are hidden as in-progress).</p>`;
    document.getElementById("btn-start").disabled = true;
    return;
  }

  for (const c of characterDefs) {
    const el = document.createElement("article");
    el.className = "card";
    el.dataset.charId = c.id;
    el.innerHTML = `
      <div class="party-card-layout">
        <div class="party-card-info">
          <h3>${c.name}</h3>
          <div class="stats-row">
            <span>HP ${c.baseStats.maxHp}</span>
            <span>ATK ${c.baseStats.attack}</span>
          </div>
          ${defaultRelicsForDef(c, "hero").length ? `<div class="fighter-relics">${defaultRelicsForDef(c, "hero").map((r, _, all) => relicChipHtml({ ...r, holderRelics: all })).join("")}</div>` : ""}
        </div>
        <div class="party-card-sprite" aria-hidden="true">
          <img class="party-card-sprite-img" src="sprites/${c.id}.png" alt="" draggable="false" />
          <span class="party-card-sprite-fallback">${escapeHtml(spriteLabel(c))}</span>
        </div>
      </div>
    `;
    const spriteImg = el.querySelector(".party-card-sprite-img");
    const spriteFallback = el.querySelector(".party-card-sprite-fallback");
    if (spriteImg && spriteFallback) {
      spriteImg.addEventListener("error", () => {
        spriteImg.remove();
        spriteFallback.classList.add("is-visible");
      });
    }
    el.addEventListener("click", () => {
      if (selected.has(c.id)) {
        selected.delete(c.id);
        el.classList.remove("selected");
      } else if (selected.size < 3) {
        selected.add(c.id);
        el.classList.add("selected");
      }
      state.partyInspectId = selected.size ? [...selected][selected.size - 1] : null;
      updatePartyInspectPanel(selectedDefsForInspect());
      syncBtn();
    });
    host.appendChild(el);
  }

  document.getElementById("btn-start").onclick = () => {
    if (selected.size !== 3) return;
    beginRun([...selected]);
  };

  document.getElementById("btn-restart").onclick = () => {
    selected.clear();
    host.querySelectorAll(".card").forEach((x) => x.classList.remove("selected"));
    state.partyInspectId = null;
    updatePartyInspectPanel([]);
    syncBtn();
    showScreen("screen-party");
  };

  updatePartyInspectPanel([]);
  syncBtn();
}

async function init() {
  bgm = /** @type {HTMLAudioElement | null} */ (document.getElementById("bgm"));
  attackHitSfx = new Audio("../holy_attack_hit.wav");
  attackHitSfx.preload = "auto";
  attackHitSfx.volume = 0.35;
  startBgm();
  bindBgmAutoplayFallback();
  setBgmMuted(false);

  try {
    const [cRes, eRes, bRes, rRes] = await Promise.all([
      fetch("data/characters.json"),
      fetch("data/enemies.json"),
      fetch("data/background.json").catch(() => null),
      fetch("data/relics.json").catch(() => null),
    ]);
    const rawChars = normalizeCharacterDefs(await cRes.json());
    const rawEnemies = normalizeCharacterDefs(await eRes.json());
    if (bRes && bRes.ok) {
      const bgCfg = await bRes.json().catch(() => ({}));
      const rel = String(bgCfg?.arenaSpriteBackground || "").trim();
      arenaBackgroundUrl = rel ? `${rel}?ts=${Number(bgCfg?.updatedAt || Date.now())}` : "";
    }
    if (rRes && rRes.ok) {
      const rc = await rRes.json().catch(() => ({}));
      const ids = Array.isArray(rc?.draftPoolRelicIds) ? rc.draftPoolRelicIds.map((x) => String(x || "")) : [];
      const valid = ids.filter((id) => !!RELIC_BY_ID[id]);
      if (valid.length) draftPoolRelicIds = valid;
    }
    characterDefs = await filterDefsWithSprites(rawChars);
    enemyDefs = await filterDefsWithSprites(rawEnemies);
  } catch {
    document.querySelector(".tagline").textContent =
      "Could not load data JSON. Serve this folder over HTTP and refresh.";
    return;
  }
  renderPartyPicker();

  const muteBtn = document.getElementById("btn-mute-bgm");
  if (muteBtn && !muteBtn.dataset.bound) {
    muteBtn.dataset.bound = "1";
    muteBtn.addEventListener("click", () => {
      if (!bgm) return;
      setBgmMuted(!bgm.muted);
    });
  }
  const speedBtn = document.getElementById("btn-game-speed");
  syncGameplaySpeedButton();
  if (speedBtn && !speedBtn.dataset.bound) {
    speedBtn.dataset.bound = "1";
    speedBtn.addEventListener("click", cycleGameplaySpeed);
  }
}

init();
