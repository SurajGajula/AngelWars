import {
  COMBAT,
  roundScale,
  normalizeSkillDef,
  rollUpgradeStatValue,
} from "./mechanics.js";

/** Pause after each skill resolves (UI + pacing), including auto-repeat. */
const SKILL_POST_DELAY_MS = 1000;

/** @type {any[]} */
let characterDefs = [];
/** @type {any[]} */
let enemyDefs = [];
/** @type {string} */
let arenaBackgroundUrl = "";
const BASIC_ATTACK_SKILL = Object.freeze({ id: "basic_attack", name: "Attack", type: "damage" });

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
}

function normalizeCharacterDefs(list) {
  return (list || []).map((c) => ({
    ...c,
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
 * @property {number} [duration] legacy fallback
 * @property {number} [amount] legacy fallback
 * @property {number} [percentFrac] legacy fallback
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

function defaultRelicsForDef(def, kind) {
  const id = String(def?.id || "").toLowerCase();
  if (kind === "enemy") {
    return [{ id: "rapture", stacks: 0, intervalTurns: 10, counter: 10 }];
  }
  if (id === "chariot") {
    return [{ id: "chariot_third_strike", stacks: 0, intervalTurns: 3, counter: 3 }];
  }
  if (id === "seraph") {
    return [{ id: "seraph_heal", stacks: 0, valuePercent: 10 }];
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
  const raptureStacks = Math.max(0, Number(rapture?.stacks || 0));
  const raptureMult = 1 + Math.min(10, raptureStacks) * 0.1;
  const attack = f.attack + buffBonusForStat(f, "attack");
  return {
    attack: Math.max(0, Math.floor(attack * raptureMult)),
    maxHp: Math.max(1, Math.floor(f.maxHp * raptureMult)),
    raptureStacks,
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
  processRelicsOnTurnAdvance();
}

function processRelicsOnTurnAdvance() {
  for (const unit of allLivingCombatants()) {
    for (const relic of unit.relics || []) {
      const interval = Math.max(1, Number(relic.intervalTurns || 0));
      if (!interval) continue;
      const counter = Math.max(1, Number(relic.counter || interval));
      if (counter <= 1) {
        if (relic.id === "rapture") {
          relic.stacks = Math.min(10, Math.max(0, Number(relic.stacks || 0)) + 1);
          logLine(
            `<span class="system">${escapeHtml(unit.def.name)} gains <strong>rapture</strong> ×${relic.stacks} (+${relic.stacks * 10}% ATK / MaxHP).</span>`
          );
        }
        relic.counter = interval;
      } else {
        relic.counter = counter - 1;
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
  const maxHp = Math.round(s.maxHp * scale);
  return {
    kind: "enemy",
    def,
    hp: maxHp,
    maxHp,
    attack: Math.round(s.attack * scale * 10) / 10,
    buffs: [],
    relics: defaultRelicsForDef(def, "enemy"),
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

function applyDamage(target, amount) {
  const hpNow = Number(target.hp);
  const safeHp = Number.isFinite(hpNow) ? hpNow : 0;
  const hit = Number(amount);
  const safeHit = Number.isFinite(hit) ? Math.max(0, hit) : 0;
  target.hp = Math.max(0, safeHp - safeHit);
  return 0;
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
    applyDamage(tgt, dealt);
    if (dealt > 0) {
      queueCombatFloat(tgt.def.id, `-${dealt}`, "damage");
    }
    logLine(
      `<span class="${atkCls}">${name}</span> uses <strong>${sk}</strong> on <span class="enemy">${tgt.def.name}</span> for <strong>${dealt}</strong> damage.`
    );
    const seraphRelic = (actor.relics || []).find((r) => r.id === "seraph_heal");
    if (seraphRelic) {
      const pct = Math.max(0, Number(seraphRelic.valuePercent || 10)) / 100;
      for (const ally of aliveHeroes()) {
        const heal = Math.max(1, Math.floor(ally.maxHp * pct));
        applyHeal(ally, heal);
        queueCombatFloat(ally.def.id, `+${heal}`, "heal");
      }
    }
    return;
  }
  const heroes = aliveHeroes();
  let total = 0;
  for (const h of heroes) {
    const dealt = computeDamage(actor);
    applyDamage(h, dealt);
    total += dealt;
    if (dealt > 0) {
      queueCombatFloat(h.def.id, `-${dealt}`, "damage");
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
  runNextTurn();
  if (actor.kind === "enemy" && !battleOver()) scheduleAutoRepeatPartyVolleyIfNeeded();
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
      }, SKILL_POST_DELAY_MS);
    }, 280);
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
      document.getElementById("end-body").textContent = `You reached round ${state.round} of ${COMBAT.TOTAL_ROUNDS}.`;
      showScreen("screen-end");
    }, 800);
    return;
  }
  if (enemyDead) {
    playAttackHitSfx();
    logLine(`<span class="system">Victory — round ${state.round} cleared!</span>`);
    rallyDeadHeroesAfterVictory();
    setTimeout(() => openUpgradeModal(), 500);
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
  const interval = Math.max(0, Number(relic?.intervalTurns || 0));
  const curCounter = Math.max(0, Number(relic?.counter || interval || 0));
  const pct = Math.max(0, Number(relic?.valuePercent || 0));
  const counterValue = pct > 0 ? pct : interval > 0 ? curCounter : 0;
  const counter = counterValue > 0 ? `<span class="relic-counter">${counterValue}</span>` : "";
  const title =
    id === "rapture"
      ? `Rapture: +10% ATK/MaxHP every ${interval || 10} turns (current +${stackN * 10}%)`
      : id === "seraph_heal"
        ? `Seraph Relic: attacks heal allies for ${pct || 10}% max HP`
        : id === "chariot_third_strike"
          ? "Chariot Relic: every 3rd attack deals double damage"
        : id;
  return `<span class="relic-chip" title="${escapeHtml(title)}" data-relic-tip="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">${counter}</span>`;
}

/** Compact HTML for active relics + stat buffs. */
function fighterEffectsHtml(f) {
  const relics = (f.relics || []).map((r) => relicChipHtml(r)).join("");
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

function skillReferenceBlockHtml(skill, perspective) {
  const mech = `<p class="skill-mech">${escapeHtml(describeSkillMechanics(skill, perspective))}</p>`;
  return `<div class="status-skill"><strong>${escapeHtml(skill.name)}</strong>${mech}</div>`;
}

function charDefReferenceBlockHtml(c) {
  const s = c.baseStats;
  const relics = defaultRelicsForDef(c, "hero");
  const relicRow = relics.length
    ? `<div class="fighter-relics" aria-label="Default relics">${relics.map((r) => relicChipHtml(r)).join("")}</div>`
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
      }, SKILL_POST_DELAY_MS);
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

const UPGRADE_STATS = /** @type {const} */ (["maxHp", "attack"]);

function randomStatUpgradeOption() {
  const heroes = state.party.filter((h) => h.hp > 0);
  if (!heroes.length) return null;
  const h = heroes[Math.floor(Math.random() * heroes.length)];
  const stat = UPGRADE_STATS[Math.floor(Math.random() * UPGRADE_STATS.length)];
  const value = rollUpgradeStatValue();
  const statLabel = stat === "maxHp" ? "Max HP" : "Attack";
  const healNote = stat === "maxHp" ? ` Current HP increases by the same amount.` : "";
  return {
    type: "stat",
    stat,
    title: `+${value} ${statLabel}`,
    desc: `Apply to ${h.def.name}.${healNote}`,
    heroId: h.def.id,
    value,
  };
}

function randomUpgradeOptions() {
  const picks = [];
  const usedHeroStat = new Set();
  // Avoid duplicate rewards for the same hero + stat in one selection set.
  for (let n = 0; n < 3; n++) {
    const opt = randomStatUpgradeOption();
    if (!opt) continue;
    const key = `${opt.heroId}:${opt.stat}`;
    if (usedHeroStat.has(key)) {
      let retry = 0;
      let alt = null;
      while (retry < 12) {
        const next = randomStatUpgradeOption();
        if (!next) break;
        const nextKey = `${next.heroId}:${next.stat}`;
        if (!usedHeroStat.has(nextKey)) {
          alt = next;
          break;
        }
        retry += 1;
      }
      if (!alt) continue;
      picks.push(alt);
      usedHeroStat.add(`${alt.heroId}:${alt.stat}`);
      continue;
    }
    picks.push(opt);
    usedHeroStat.add(key);
  }
  return picks;
}

function applyUpgrade(opt) {
  const hero = state.party.find((p) => p.def.id === opt.heroId);
  if (!hero) return;
  if (opt.type === "stat") {
    if (opt.stat === "maxHp") {
      hero.maxHp += opt.value;
      hero.hp = Math.min(hero.maxHp, hero.hp + opt.value);
    } else if (opt.stat === "attack") hero.attack += opt.value;
  }
}

function openUpgradeModal() {
  disarmAutoRepeatParty();
  const modal = document.getElementById("modal-upgrades");
  document.querySelector("#modal-upgrades h2").textContent = "Round clear — pick a stat reward";
  document.querySelector("#modal-upgrades .tagline").textContent =
    "Choose one of three +1 / +2 / +5 stat bumps.";
  const list = document.getElementById("upgrade-list");
  list.innerHTML = "";
  const opts = randomUpgradeOptions();
  for (const o of opts) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn upgrade-btn";
    b.innerHTML = `<span class="title">${o.title}</span><span class="desc">${o.desc}</span>`;
    b.addEventListener("click", () => {
      applyUpgrade(o);
      modal.classList.remove("active");
      advanceToNextRound();
    });
    list.appendChild(b);
  }
  modal.classList.add("active");
  renderBattle();
}

function openPreRoundUpgradeModal() {
  const modal = document.getElementById("modal-upgrades");
  const list = document.getElementById("upgrade-list");
  document.querySelector("#modal-upgrades h2").textContent = "Pre-battle boost";
  document.querySelector("#modal-upgrades .tagline").textContent =
    "Pick one stat reward before round 1 starts.";
  list.innerHTML = "";
  const opts = randomUpgradeOptions();
  for (const o of opts) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn upgrade-btn";
    b.innerHTML = `<span class="title">${o.title}</span><span class="desc">${o.desc}</span>`;
    b.addEventListener("click", () => {
      applyUpgrade(o);
      modal.classList.remove("active");
      startBattleEncounter();
    });
    list.appendChild(b);
  }
  modal.classList.add("active");
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
  state.actedSkillActorKeys.clear();
  showScreen("screen-battle");
  document.getElementById("round-label").textContent = `Round ${state.round} / ${COMBAT.TOTAL_ROUNDS}`;
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
          ${defaultRelicsForDef(c, "hero").length ? `<div class="fighter-relics">${defaultRelicsForDef(c, "hero").map((r) => relicChipHtml(r)).join("")}</div>` : ""}
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
    const [cRes, eRes, bRes] = await Promise.all([
      fetch("data/characters.json"),
      fetch("data/enemies.json"),
      fetch("data/background.json").catch(() => null),
    ]);
    const rawChars = normalizeCharacterDefs(await cRes.json());
    const rawEnemies = normalizeCharacterDefs(await eRes.json());
    if (bRes && bRes.ok) {
      const bgCfg = await bRes.json().catch(() => ({}));
      const rel = String(bgCfg?.arenaSpriteBackground || "").trim();
      arenaBackgroundUrl = rel ? `${rel}?ts=${Number(bgCfg?.updatedAt || Date.now())}` : "";
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
}

init();
