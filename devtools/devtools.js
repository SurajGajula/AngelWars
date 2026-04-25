import {
  SKILL_TYPE_ORDER,
  isSkillTypeId,
  COMBAT,
  normalizeSkillDef,
  normalizeStatusId,
  normalizeStatusStackCount,
  normalizeSupportBuffStackCount,
  normalizeSupportStat,
  buildMechanicsDocumentationHtml,
} from "../game/js/mechanics.js";
import { stripLightEdgeBackgroundPng } from "./spriteBackground.js";

const DATA_CHAR = "../game/data/characters.json";
const DATA_ENEMY = "../game/data/enemies.json";
const DATA_BG = "../game/data/background.json";

const SUPPORT_STATS = ["attack", "maxHp"];

/** @type {any[]} */
let bundledChars = [];
/** @type {any[]} */
let enemyDefs = [];
/** @type {any[]} */
let roster = [];
let editIndex = -1;
let enemyEditIndex = -1;
/** @type {null|(() => void)} */
/** @type {() => void} */
let queueRosterAutosave = () => {};
/** @type {() => void} */
let queueEnemyAutosave = () => {};

/** @typedef {"docs"|"allies"|"enemies"|"background"} PageId */

function setStatus(msg, kind) {
  // Devtools status bar removed; keep calls as no-op for simplicity.
  void msg;
  void kind;
}

/**
 * When the nav checkbox is on (default), flood-removes near-white pixels connected to the border.
 * @param {File} file
 * @returns {Promise<Blob>}
 */
async function prepareSpritePngForUpload(file) {
  const opt = document.getElementById("opt-strip-sprite-bg");
  if (opt && !opt.checked) return file;
  try {
    return await stripLightEdgeBackgroundPng(file);
  } catch (e) {
    console.warn("[devtools] Sprite background strip failed; uploading original.", e);
    return file;
  }
}

/**
 * Convert any image file to square PNG by center-cropping to the shortest side.
 * @param {File|Blob} file
 * @returns {Promise<Blob>}
 */
async function normalizeImageToSquarePng(file) {
  const bmp = await createImageBitmap(file);
  const sw = bmp.width;
  const sh = bmp.height;
  if (!sw || !sh) {
    bmp.close();
    throw new Error("Invalid image dimensions.");
  }
  const side = Math.min(sw, sh);
  const sx = Math.floor((sw - side) / 2);
  const sy = Math.floor((sh - side) / 2);
  const canvas = document.createElement("canvas");
  canvas.width = side;
  canvas.height = side;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bmp.close();
    throw new Error("Could not open canvas context.");
  }
  ctx.drawImage(bmp, sx, sy, side, side, 0, 0, side, side);
  bmp.close();
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("PNG export failed."));
          return;
        }
        resolve(blob);
      },
      "image/png",
      1
    );
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function clone(x) {
  return structuredClone(x);
}

function slugifyId(name) {
  const base = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!base) return "hero";
  return /^[a-z]/.test(base) ? base : `hero_${base}`;
}

function uniqueHeroId(name, skipIndex) {
  const base = slugifyId(name);
  const used = new Set(
    roster
      .map((c, i) => (i === skipIndex ? null : c.id))
      .filter((x) => typeof x === "string")
  );
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base}_${i}`)) i += 1;
  return `${base}_${i}`;
}

function uniqueEnemyId(name, skipIndex) {
  const base = slugifyId(name).replace(/^hero_/, "");
  const used = new Set(
    enemyDefs
      .map((e, i) => (i === skipIndex ? null : e.id))
      .filter((x) => typeof x === "string")
  );
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base}_${i}`)) i += 1;
  return `${base}_${i}`;
}

function syncIdPreview() {
  const name = /** @type {HTMLInputElement} */ (document.getElementById("ec-name")).value;
  const id = uniqueHeroId(name, editIndex);
  /** @type {HTMLInputElement} */ (document.getElementById("ec-id-preview")).value = id;
  return id;
}

function syncEnemyIdPreview() {
  const name = /** @type {HTMLInputElement} */ (document.getElementById("ee-name")).value;
  const id = uniqueEnemyId(name, enemyEditIndex);
  /** @type {HTMLInputElement} */ (document.getElementById("ee-id-preview")).value = id;
  return id;
}

function normalizeCharacterDef(charDef) {
  const c = clone(charDef || {});
  c.name = String(c.name || "Unnamed Hero").trim() || "Unnamed Hero";
  c.id = /^[a-z][a-z0-9_]*$/.test(c.id || "") ? c.id : slugifyId(c.name);
  c.baseStats = c.baseStats || {};
  c.baseStats.maxHp = Number(c.baseStats.maxHp ?? 100);
  c.baseStats.attack = Number(c.baseStats.attack ?? 10);
  delete c.skills;
  return c;
}

function normalizeEnemyDef(enemyDef) {
  const e = clone(enemyDef || {});
  e.name = String(e.name || "Unnamed Enemy").trim() || "Unnamed Enemy";
  e.id = /^[a-z][a-z0-9_]*$/.test(e.id || "") ? e.id : uniqueEnemyId(e.name, -1);
  e.baseStats = e.baseStats || {};
  e.baseStats.maxHp = Number(e.baseStats.maxHp ?? 80);
  e.baseStats.attack = Number(e.baseStats.attack ?? 10);
  delete e.skills;
  delete e.skillCycle;
  return e;
}

function normalizeSkillForEditor(skill, heroId, idx) {
  const s = normalizeSkillDef(skill || {});
  const type = isSkillTypeId(s.type) ? s.type : "damage";
  const out = {
    id: `${heroId}_${type}_${idx + 1}`,
    name: String(s.name || `Skill ${idx + 1}`).trim() || `Skill ${idx + 1}`,
    type,
  };

  if (type === "damage") {
    const statusId = normalizeStatusId(s.status);
    if (statusId) {
      out.status = statusId;
      out.statusStacks = normalizeStatusStackCount(s.statusStacks);
    }
  } else if (type === "support") {
    const ss = normalizeSupportStat(s.supportStat ?? s.buffStat);
    if (ss) out.supportStat = ss;
    if (ss) out.supportStacks = normalizeSupportBuffStackCount(s.supportStacks);
    const statusId = normalizeStatusId(s.status);
    if (statusId) {
      out.status = statusId;
      out.statusStacks = normalizeStatusStackCount(s.statusStacks);
    }
  }
  return out;
}

function blankSkill(heroId, idx) {
  const type = idx === 0 ? "damage" : idx === 1 ? "heal" : "support";
  return normalizeSkillForEditor(
    {
      name: type === "damage" ? "Strike" : type === "heal" ? "Recover" : "Fortify",
      type,
      supportStat: "attack",
    },
    heroId,
    idx
  );
}

function blankEnemySkill(enemyId, idx) {
  const type = idx === 0 ? "damage" : idx === 1 ? "support" : "heal";
  return normalizeEnemySkillForEditor(
    {
      name: type === "damage" ? "Claw" : type === "support" ? "Guard Up" : "Recover",
      type,
      supportStat: "attack",
    },
    enemyId,
    idx
  );
}

function blankCharacter(name = "New Hero") {
  const cleanName = String(name || "").trim() || "New Hero";
  const id = uniqueHeroId(cleanName, -1);
  return {
    id,
    name: cleanName,
    baseStats: { maxHp: 100, attack: 10 },
  };
}

function blankEnemy(name = "New Enemy") {
  const cleanName = String(name || "").trim() || "New Enemy";
  const id = uniqueEnemyId(cleanName, -1);
  return {
    id,
    name: cleanName,
    baseStats: { maxHp: 80, attack: 10 },
  };
}

function promptForName(kindLabel) {
  const raw = window.prompt(`Enter ${kindLabel} name:`, "");
  if (raw == null) return null;
  const name = raw.trim();
  if (!name) {
    setStatus(`${kindLabel} name is required.`, "err");
    return null;
  }
  return name;
}

function serializeCharactersJson(list) {
  return `${JSON.stringify(list, null, 2)}\n`;
}

async function saveRosterToCharactersFile(silent = false) {
  const err = validateRoster(roster);
  if (err) return setStatus(err, "err");
  try {
    const res = await fetch("/api/characters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(roster),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || "Save failed");
    bundledChars = clone(roster);
    if (!silent) setStatus("Saved to game/data/characters.json on disk. Commit it for deploy.", "ok");
  } catch (e) {
    setStatus(
      `Save failed (${e?.message || e}). Start the npm dev server (npm install && npm run dev).`,
      "err"
    );
  }
}

async function saveEnemiesToFile(silent = false) {
  const err = validateEnemies(enemyDefs);
  if (err) return setStatus(err, "err");
  try {
    const res = await fetch("/api/enemies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(enemyDefs),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || "Save failed");
    if (!silent) setStatus("Saved to game/data/enemies.json on disk. Commit it for deploy.", "ok");
  } catch (e) {
    setStatus(`Enemy save failed (${e?.message || e}).`, "err");
  }
}

function validateSkill(sk, ownerId) {
  if (!/^[a-z][a-z0-9_]*$/.test(sk.id || "")) return `Invalid skill id on ${ownerId}`;
  if (!String(sk.name || "").trim()) return `Missing skill name on ${ownerId}`;
  if (!isSkillTypeId(sk.type)) return `Unknown skill type "${sk.type}" on ${ownerId}`;
  if ((sk.type === "damage" || sk.type === "support") && sk.status != null) {
    const sid = normalizeStatusId(sk.status);
    if (!sid) return `Unknown status "${sk.status}" on ${ownerId}`;
    const st = Number(sk.statusStacks ?? 1);
    if (!Number.isInteger(st) || st < COMBAT.STATUS_STACK_MIN || st > COMBAT.STATUS_STACK_MAX) {
      return `Status stacks on ${ownerId} must be ${COMBAT.STATUS_STACK_MIN}-${COMBAT.STATUS_STACK_MAX}`;
    }
  }
  if (sk.type === "support") {
    const n = normalizeSkillDef(sk);
    if (!n.supportStat && !normalizeStatusId(n.status)) {
      return `Support skill "${sk.name}" on ${ownerId} needs a buff (supportStat) and/or status effect (status)`;
    }
    if (n.supportStat && !SUPPORT_STATS.includes(n.supportStat))
      return `Support skill "${sk.name}" on ${ownerId} needs supportStat in {${SUPPORT_STATS.join(", ")}}`;
    if (n.supportStat) {
      const ss = Number(n.supportStacks ?? COMBAT.SUPPORT_BUFF_STACK_DEFAULT);
      if (!Number.isFinite(ss) || ss < COMBAT.SUPPORT_BUFF_STACK_MIN || ss > COMBAT.SUPPORT_BUFF_STACK_MAX) {
        return `Support buff stacks on ${ownerId} must be ${COMBAT.SUPPORT_BUFF_STACK_MIN}-${COMBAT.SUPPORT_BUFF_STACK_MAX}`;
      }
    }
  }
  return null;
}

function validateRoster(list) {
  const ids = new Set();
  for (const c of list) {
    if (!/^[a-z][a-z0-9_]*$/.test(c.id || "")) return `Invalid hero id: ${c.id}`;
    if (ids.has(c.id)) return `Duplicate hero id: ${c.id}`;
    ids.add(c.id);
    if (!String(c.name || "").trim()) return `Missing name for ${c.id}`;
    const s = c.baseStats || {};
    for (const k of ["maxHp", "attack"]) {
      if (!Number.isFinite(Number(s[k]))) return `Invalid baseStats.${k} for ${c.id}`;
    }
    if (Number(s.maxHp) < 1) return `maxHp must be >= 1 for ${c.id}`;
  }
  return null;
}

function validateEnemies(list) {
  const ids = new Set();
  for (const e of list) {
    if (!/^[a-z][a-z0-9_]*$/.test(e.id || "")) return `Invalid enemy id: ${e.id}`;
    if (ids.has(e.id)) return `Duplicate enemy id: ${e.id}`;
    ids.add(e.id);
    if (!String(e.name || "").trim()) return `Missing name for ${e.id}`;
    const s = e.baseStats || {};
    for (const k of ["maxHp", "attack"]) {
      if (!Number.isFinite(Number(s[k]))) return `Invalid baseStats.${k} for ${e.id}`;
    }
  }
  return null;
}

function skillFormHtml(si) {
  const typeOpts = SKILL_TYPE_ORDER.map((t) => `<option value="${t}">${t}</option>`).join("");
  return `<div class="skill-form-grid">
      <label>Name <input id="s${si}-name" required autocomplete="off" /></label>
      <label>Type <select id="s${si}-type">${typeOpts}</select></label>
      <fieldset id="s${si}-grp-damage-mods" class="opt-hidden skill-mod-fieldset">
        <legend>Damage modifiers</legend>
        <p class="field-hint">Statuses use unified stacks.</p>
        <label>Status
          <select id="s${si}-status">
            <option value="">none</option>
            <option value="break">break</option>
            <option value="weaken">weaken</option>
            <option value="chain">chain</option>
            <option value="leech">leech</option>
          </select>
        </label>
        <label>Stacks
          <input type="number" id="s${si}-status-stacks" min="${COMBAT.STATUS_STACK_MIN}" max="${COMBAT.STATUS_STACK_MAX}" step="1" value="1" />
        </label>
      </fieldset>
      <fieldset id="s${si}-grp-support-stat" class="opt-hidden skill-mod-fieldset">
        <legend>Support — buff (self, stacks)</legend>
        <p class="field-hint">Each stack gives +${Math.round(COMBAT.SUPPORT_BUFF_STAT_FRAC_PER_STACK * 100)}% base stat, decays by 1 at turn end. Omit stat for status-only support.</p>
        <label>Buff stat
          <select id="s${si}-support-stat">
            <option value="">none</option>
            <option value="attack">attack</option>
            <option value="maxHp">maxHp</option>
          </select>
        </label>
        <label>Buff stacks
          <input type="number" id="s${si}-support-stacks" min="${COMBAT.SUPPORT_BUFF_STACK_MIN}" max="${COMBAT.SUPPORT_BUFF_STACK_MAX}" step="1" value="${COMBAT.SUPPORT_BUFF_STACK_DEFAULT}" />
        </label>
      </fieldset>
      <fieldset id="s${si}-grp-support-debuff" class="opt-hidden skill-mod-fieldset">
        <legend>Support — status (stacked)</legend>
        <p class="field-hint">Revive applies to self. Break/weaken/leech/chain apply to opponents.</p>
        <label>Status effect
          <select id="s${si}-support-status">
            <option value="">none</option>
            <option value="break">break</option>
            <option value="weaken">weaken</option>
            <option value="revive">revive</option>
            <option value="chain">chain</option>
            <option value="leech">leech</option>
          </select>
        </label>
        <label>Stacks
          <input type="number" id="s${si}-support-status-stacks" min="${COMBAT.STATUS_STACK_MIN}" max="${COMBAT.STATUS_STACK_MAX}" step="1" value="1" />
        </label>
      </fieldset>
    </div>`;
}

function enemySkillFormHtml(si) {
  const typeOpts = SKILL_TYPE_ORDER.map((t) => `<option value="${t}">${t}</option>`).join("");
  return `<div class="skill-form-grid">
      <label>Name <input id="es${si}-name" required autocomplete="off" /></label>
      <label>Type <select id="es${si}-type">${typeOpts}</select></label>
      <fieldset id="es${si}-grp-damage-mods" class="opt-hidden skill-mod-fieldset">
        <legend>Damage modifiers</legend>
        <p class="field-hint">Statuses use unified stacks.</p>
        <label>Status
          <select id="es${si}-status">
            <option value="">none</option>
            <option value="break">break</option>
            <option value="weaken">weaken</option>
            <option value="chain">chain</option>
            <option value="leech">leech</option>
          </select>
        </label>
        <label>Stacks
          <input type="number" id="es${si}-status-stacks" min="${COMBAT.STATUS_STACK_MIN}" max="${COMBAT.STATUS_STACK_MAX}" step="1" value="1" />
        </label>
      </fieldset>
      <fieldset id="es${si}-grp-support-stat" class="opt-hidden skill-mod-fieldset">
        <legend>Support — buff (self, stacks)</legend>
        <p class="field-hint">Each stack gives +${Math.round(COMBAT.SUPPORT_BUFF_STAT_FRAC_PER_STACK * 100)}% base stat, decays by 1 at turn end. Omit stat for status-only support.</p>
        <label>Buff stat
          <select id="es${si}-support-stat">
            <option value="">none</option>
            <option value="attack">attack</option>
            <option value="maxHp">maxHp</option>
          </select>
        </label>
        <label>Buff stacks
          <input type="number" id="es${si}-support-stacks" min="${COMBAT.SUPPORT_BUFF_STACK_MIN}" max="${COMBAT.SUPPORT_BUFF_STACK_MAX}" step="1" value="${COMBAT.SUPPORT_BUFF_STACK_DEFAULT}" />
        </label>
      </fieldset>
      <fieldset id="es${si}-grp-support-debuff" class="opt-hidden skill-mod-fieldset">
        <legend>Support — status (stacked)</legend>
        <p class="field-hint">Revive applies to self. Break/weaken/leech/chain apply to opponents.</p>
        <label>Status effect
          <select id="es${si}-support-status">
            <option value="">none</option>
            <option value="break">break</option>
            <option value="weaken">weaken</option>
            <option value="revive">revive</option>
            <option value="chain">chain</option>
            <option value="leech">leech</option>
          </select>
        </label>
        <label>Stacks
          <input type="number" id="es${si}-support-status-stacks" min="${COMBAT.STATUS_STACK_MIN}" max="${COMBAT.STATUS_STACK_MAX}" step="1" value="1" />
        </label>
      </fieldset>
    </div>`;
}

function initEditorForm() {
  document.getElementById("ec-name").addEventListener("input", () => syncIdPreview());
  document.getElementById("ee-name").addEventListener("input", () => syncEnemyIdPreview());
}

function updateSkillOptionals(si) {
  const type = /** @type {HTMLSelectElement} */ (document.getElementById(`s${si}-type`)).value;
  const groupIds = [`s${si}-grp-damage-mods`, `s${si}-grp-support-stat`, `s${si}-grp-support-debuff`];
  for (const gid of groupIds) document.getElementById(gid).classList.add("opt-hidden");

  if (type === "damage") {
    document.getElementById(`s${si}-grp-damage-mods`).classList.remove("opt-hidden");
  } else if (type === "support") {
    document.getElementById(`s${si}-grp-support-stat`).classList.remove("opt-hidden");
    document.getElementById(`s${si}-grp-support-debuff`).classList.remove("opt-hidden");
  }
}

function updateEnemySkillOptionals(si) {
  const type = /** @type {HTMLSelectElement} */ (document.getElementById(`es${si}-type`)).value;
  const groupIds = [`es${si}-grp-damage-mods`, `es${si}-grp-support-stat`, `es${si}-grp-support-debuff`];
  for (const gid of groupIds) document.getElementById(gid).classList.add("opt-hidden");

  if (type === "damage") {
    document.getElementById(`es${si}-grp-damage-mods`).classList.remove("opt-hidden");
  } else if (type === "support") {
    document.getElementById(`es${si}-grp-support-stat`).classList.remove("opt-hidden");
    document.getElementById(`es${si}-grp-support-debuff`).classList.remove("opt-hidden");
  }
}

function fillSkillForm(skill, si) {
  const sk = normalizeSkillForEditor(skill, "preview", si);
  const skNorm = normalizeSkillDef(skill || {});
  document.getElementById(`s${si}-name`).value = sk.name;
  document.getElementById(`s${si}-type`).value = sk.type;
  document.getElementById(`s${si}-status`).value =
    skNorm.type === "damage" ? normalizeStatusId(skNorm.status) || "" : "";
  /** @type {HTMLInputElement} */ (document.getElementById(`s${si}-status-stacks`)).value = String(
    skNorm.type === "damage" ? normalizeStatusStackCount(skNorm.statusStacks) : 1
  );
  document.getElementById(`s${si}-support-stat`).value = sk.supportStat || "";
  /** @type {HTMLInputElement} */ (document.getElementById(`s${si}-support-stacks`)).value = String(
    skNorm.type === "support"
      ? normalizeSupportBuffStackCount(skNorm.supportStacks)
      : COMBAT.SUPPORT_BUFF_STACK_DEFAULT
  );
  document.getElementById(`s${si}-support-status`).value =
    skNorm.type === "support" ? normalizeStatusId(skNorm.status) || "" : "";
  /** @type {HTMLInputElement} */ (document.getElementById(`s${si}-support-status-stacks`)).value =
    String(skNorm.type === "support" ? normalizeStatusStackCount(skNorm.statusStacks) : 1);
  updateSkillOptionals(si);
}

function readSkillFromForm(si, heroId) {
  const type = /** @type {HTMLSelectElement} */ (document.getElementById(`s${si}-type`)).value;
  const name = document.getElementById(`s${si}-name`).value.trim();
  /** @type {any} */
  const sk = {
    id: `${heroId}_${type}_${si + 1}`,
    name,
    type,
  };

  if (type === "damage") {
    const statusId = normalizeStatusId(document.getElementById(`s${si}-status`).value);
    if (statusId) {
      sk.status = statusId;
      sk.statusStacks = normalizeStatusStackCount(
        /** @type {HTMLInputElement} */ (document.getElementById(`s${si}-status-stacks`)).value
      );
    }
  } else if (type === "support") {
    const statRaw = document.getElementById(`s${si}-support-stat`).value.trim();
    if (statRaw) {
      sk.supportStat = statRaw;
      sk.supportStacks = normalizeSupportBuffStackCount(
        /** @type {HTMLInputElement} */ (document.getElementById(`s${si}-support-stacks`)).value
      );
    }
    const statusId = normalizeStatusId(document.getElementById(`s${si}-support-status`).value);
    if (statusId) {
      sk.status = statusId;
      sk.statusStacks = normalizeStatusStackCount(
        /** @type {HTMLInputElement} */ (document.getElementById(`s${si}-support-status-stacks`)).value
      );
    }
  }
  return sk;
}

function fillCharForm(c) {
  const hero = normalizeCharacterDef(c);
  document.getElementById("ec-name").value = hero.name;
  document.getElementById("ec-hp").value = String(hero.baseStats.maxHp);
  document.getElementById("ec-atk").value = String(hero.baseStats.attack);
  syncIdPreview();
}

function normalizeEnemySkillForEditor(skill, enemyId, idx) {
  const s = normalizeSkillDef(skill || {});
  const type = isSkillTypeId(s.type) ? s.type : "damage";
  const out = {
    id: `${enemyId}_${type}_${idx + 1}`,
    name: String(s.name || `Skill ${idx + 1}`).trim() || `Skill ${idx + 1}`,
    type,
  };
  if (type === "damage") {
    const statusId = normalizeStatusId(s.status);
    if (statusId) {
      out.status = statusId;
      out.statusStacks = normalizeStatusStackCount(s.statusStacks);
    }
  } else if (type === "support") {
    const ss = normalizeSupportStat(s.supportStat ?? s.buffStat);
    if (ss) out.supportStat = ss;
    const statusId = normalizeStatusId(s.status);
    if (statusId) {
      out.status = statusId;
      out.statusStacks = normalizeStatusStackCount(s.statusStacks);
    }
  }
  return out;
}

function fillEnemyForm(enemy) {
  const e = normalizeEnemyDef(enemy);
  document.getElementById("ee-name").value = e.name;
  document.getElementById("ee-hp").value = String(e.baseStats.maxHp);
  document.getElementById("ee-atk").value = String(e.baseStats.attack);
  syncEnemyIdPreview();
}

function fillEnemySkillForm(skill, si) {
  const sk = normalizeEnemySkillForEditor(skill, "preview", si);
  const skNorm = normalizeSkillDef(skill || {});
  document.getElementById(`es${si}-name`).value = sk.name;
  document.getElementById(`es${si}-type`).value = sk.type;
  document.getElementById(`es${si}-status`).value =
    skNorm.type === "damage" ? normalizeStatusId(skNorm.status) || "" : "";
  /** @type {HTMLInputElement} */ (document.getElementById(`es${si}-status-stacks`)).value = String(
    skNorm.type === "damage" ? normalizeStatusStackCount(skNorm.statusStacks) : 1
  );
  document.getElementById(`es${si}-support-stat`).value = sk.supportStat || "";
  /** @type {HTMLInputElement} */ (document.getElementById(`es${si}-support-stacks`)).value = String(
    skNorm.type === "support"
      ? normalizeSupportBuffStackCount(skNorm.supportStacks)
      : COMBAT.SUPPORT_BUFF_STACK_DEFAULT
  );
  document.getElementById(`es${si}-support-status`).value =
    skNorm.type === "support" ? normalizeStatusId(skNorm.status) || "" : "";
  /** @type {HTMLInputElement} */ (document.getElementById(`es${si}-support-status-stacks`)).value =
    String(skNorm.type === "support" ? normalizeStatusStackCount(skNorm.statusStacks) : 1);
  updateEnemySkillOptionals(si);
}

function readEnemyFromForm() {
  const name = document.getElementById("ee-name").value.trim() || "Unnamed Enemy";
  const id = uniqueEnemyId(name, enemyEditIndex);
  const baseStats = {
    maxHp: Number(document.getElementById("ee-hp").value),
    attack: Number(document.getElementById("ee-atk").value),
  };
  return normalizeEnemyDef({ id, name, baseStats });
}

function readEnemySkillFromForm(si, enemyId) {
  const type = /** @type {HTMLSelectElement} */ (document.getElementById(`es${si}-type`)).value;
  const name = document.getElementById(`es${si}-name`).value.trim();
  /** @type {any} */
  const sk = {
    id: `${enemyId}_${type}_${si + 1}`,
    name,
    type,
  };
  if (type === "damage") {
    const statusId = normalizeStatusId(document.getElementById(`es${si}-status`).value);
    if (statusId) {
      sk.status = statusId;
      sk.statusStacks = normalizeStatusStackCount(
        /** @type {HTMLInputElement} */ (document.getElementById(`es${si}-status-stacks`)).value
      );
    }
  } else if (type === "support") {
    const statRaw = document.getElementById(`es${si}-support-stat`).value.trim();
    if (statRaw) {
      sk.supportStat = statRaw;
      sk.supportStacks = normalizeSupportBuffStackCount(
        /** @type {HTMLInputElement} */ (document.getElementById(`es${si}-support-stacks`)).value
      );
    }
    const statusId = normalizeStatusId(document.getElementById(`es${si}-support-status`).value);
    if (statusId) {
      sk.status = statusId;
      sk.statusStacks = normalizeStatusStackCount(
        /** @type {HTMLInputElement} */ (document.getElementById(`es${si}-support-status-stacks`)).value
      );
    }
  }
  return sk;
}

function readCharFromForm() {
  const name = document.getElementById("ec-name").value.trim() || "Unnamed Hero";
  const id = uniqueHeroId(name, editIndex);
  const baseStats = {
    maxHp: Number(document.getElementById("ec-hp").value),
    attack: Number(document.getElementById("ec-atk").value),
  };
  return normalizeCharacterDef({ id, name, baseStats });
}

function openEditor(i) {
  editIndex = i;
  fillCharForm(roster[i]);
  /** @type {HTMLDialogElement} */ (document.getElementById("char-editor")).showModal();
}

function closeEditor() {
  editIndex = -1;
  /** @type {HTMLDialogElement} */ (document.getElementById("char-editor")).close();
}

function openEnemyEditor(i) {
  enemyEditIndex = i;
  fillEnemyForm(enemyDefs[i]);
  /** @type {HTMLDialogElement} */ (document.getElementById("enemy-editor")).showModal();
}

function closeEnemyEditor() {
  enemyEditIndex = -1;
  /** @type {HTMLDialogElement} */ (document.getElementById("enemy-editor")).close();
}

function confirmDangerAction(title, message, confirmLabel = "Confirm") {
  const dlg = /** @type {HTMLDialogElement|null} */ (document.getElementById("confirm-modal"));
  const titleEl = document.getElementById("confirm-title");
  const msgEl = document.getElementById("confirm-message");
  const okBtn = document.getElementById("confirm-accept");
  const cancelBtn = document.getElementById("confirm-cancel");
  if (!dlg || !titleEl || !msgEl || !okBtn || !cancelBtn) {
    return Promise.resolve(window.confirm(`${title}\n\n${message}`));
  }

  titleEl.textContent = title;
  msgEl.textContent = message;
  okBtn.textContent = confirmLabel;

  return new Promise((resolve) => {
    const done = (accepted) => {
      okBtn.removeEventListener("click", onAccept);
      cancelBtn.removeEventListener("click", onCancel);
      dlg.removeEventListener("cancel", onCancel);
      if (dlg.open) dlg.close();
      resolve(accepted);
    };
    const onAccept = () => done(true);
    const onCancel = () => done(false);
    okBtn.addEventListener("click", onAccept, { once: true });
    cancelBtn.addEventListener("click", onCancel, { once: true });
    dlg.addEventListener("cancel", onCancel, { once: true });
    dlg.showModal();
  });
}

function previewUrlForId(id) {
  return `../game/sprites/${id}.png?ts=${Date.now()}`;
}

function previewUrlForBackground() {
  return `../game/backgrounds/arena.png?ts=${Date.now()}`;
}

function renderPreview(box, id) {
  box.innerHTML = "";
  const url = previewUrlForId(id);
  if (!url) {
    const ph = document.createElement("span");
    ph.className = "ph";
    ph.textContent = "No sprite";
    return box.appendChild(ph);
  }
  const img = document.createElement("img");
  img.src = url;
  img.alt = "";
  box.appendChild(img);
}

function renderBackgroundPreview() {
  const box = document.getElementById("background-preview");
  if (!box) return;
  box.innerHTML = "";
  const img = document.createElement("img");
  img.src = previewUrlForBackground();
  img.alt = "Battle background preview";
  img.addEventListener("error", () => {
    box.innerHTML = "";
    const ph = document.createElement("span");
    ph.className = "ph";
    ph.textContent = "No background";
    box.appendChild(ph);
  });
  box.appendChild(img);
}

function rowTemplate(def) {
  const wrap = document.createElement("div");
  wrap.className = "sprite-row";
  wrap.dataset.id = def.id;

  const left = document.createElement("div");
  left.innerHTML = `<div class="name">${escapeHtml(def.name)}</div><div class="id">${escapeHtml(def.id)}</div>`;
  const preview = document.createElement("div");
  preview.className = "preview";
  renderPreview(preview, def.id);

  const uploadWrap = document.createElement("div");
  uploadWrap.className = "upload-wrap";
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/png";
  input.setAttribute("aria-label", `Upload sprite for ${def.name}`);
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    try {
      const blob = await prepareSpritePngForUpload(file);
      const fd = new FormData();
      fd.append("file", blob, file.name.replace(/\.[^.]+$/, "") + ".png");
      const res = await fetch(`/api/sprites/${encodeURIComponent(def.id)}`, {
        method: "POST",
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || "Upload failed");
      renderPreview(preview, def.id);
      setStatus(`Saved sprite for ${def.name} (${def.id}) to game/sprites/. Commit for deploy.`, "ok");
    } catch (e) {
      setStatus(`Save failed: ${e?.message || e}`, "err");
    }
  });

  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "btn btn-danger";
  clearBtn.textContent = "Clear";
  clearBtn.addEventListener("click", async () => {
    try {
      const res = await fetch(`/api/sprites/${encodeURIComponent(def.id)}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || "Delete failed");
      renderPreview(preview, def.id);
      setStatus(`Cleared sprite for ${def.name}.`, "ok");
    } catch (e) {
      setStatus(`Clear failed: ${e?.message || e}`, "err");
    }
  });

  uploadWrap.append(input, clearBtn);
  wrap.append(left, preview, uploadWrap);
  return wrap;
}

function spriteControlsForDef(def) {
  const wrap = document.createElement("div");
  wrap.className = "roster-sprite";
  const preview = document.createElement("div");
  preview.className = "preview roster-inline-preview";
  renderPreview(preview, def.id);
  const uploadWrap = document.createElement("div");
  uploadWrap.className = "roster-actions";
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/png";
  input.className = "roster-inline-upload";
  input.setAttribute("aria-label", `Upload sprite for ${def.name}`);
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    try {
      const blob = await prepareSpritePngForUpload(file);
      const fd = new FormData();
      fd.append("file", blob, file.name.replace(/\.[^.]+$/, "") + ".png");
      const res = await fetch(`/api/sprites/${encodeURIComponent(def.id)}`, {
        method: "POST",
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || "Upload failed");
      renderPreview(preview, def.id);
      setStatus(`Saved sprite for ${def.name} (${def.id}) to game/sprites/. Commit for deploy.`, "ok");
    } catch (e) {
      setStatus(`Save failed: ${e?.message || e}`, "err");
    }
  });
  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "btn btn-danger";
  clearBtn.textContent = "Clear";
  clearBtn.addEventListener("click", async () => {
    try {
      const res = await fetch(`/api/sprites/${encodeURIComponent(def.id)}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || "Delete failed");
      renderPreview(preview, def.id);
      setStatus(`Cleared sprite for ${def.name}.`, "ok");
    } catch (e) {
      setStatus(`Clear failed: ${e?.message || e}`, "err");
    }
  });
  uploadWrap.append(input, clearBtn);
  wrap.append(preview, uploadWrap);
  return wrap;
}

function renderRosterTable() {
  const host = document.getElementById("roster-table");
  host.innerHTML = "";
  if (!roster.length) {
    const p = document.createElement("p");
    p.className = "lead small";
    p.textContent = "No characters in the list. Add one or reload.";
    host.appendChild(p);
    return;
  }
  roster.forEach((c, i) => {
    const row = document.createElement("div");
    row.className = "roster-row";
    const meta = document.createElement("div");
    meta.innerHTML = `<strong>${escapeHtml(c.name)}</strong> <code>${escapeHtml(c.id)}</code>`;
    const sprite = spriteControlsForDef(c);
    const actions = document.createElement("div");
    actions.className = "roster-actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "btn";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => openEditor(i));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn btn-danger";
    del.textContent = "Remove";
    del.addEventListener("click", () => {
      roster.splice(i, 1);
      renderAll();
      queueRosterAutosave();
    });
    actions.append(edit, del);
    row.append(meta, sprite, actions);
    host.appendChild(row);
  });
}

function renderEnemyTable() {
  const host = document.getElementById("enemy-table");
  host.innerHTML = "";
  if (!enemyDefs.length) {
    const p = document.createElement("p");
    p.className = "lead small";
    p.textContent = "No enemies in the list. Add one or reload.";
    host.appendChild(p);
    return;
  }
  enemyDefs.forEach((e, i) => {
    const row = document.createElement("div");
    row.className = "roster-row";
    const meta = document.createElement("div");
    meta.innerHTML = `<strong>${escapeHtml(e.name)}</strong> <code>${escapeHtml(e.id)}</code>`;
    const sprite = spriteControlsForDef(e);
    const actions = document.createElement("div");
    actions.className = "roster-actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "btn";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => openEnemyEditor(i));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn btn-danger";
    del.textContent = "Remove";
    del.addEventListener("click", () => {
      enemyDefs.splice(i, 1);
      renderAll();
      queueEnemyAutosave();
    });
    actions.append(edit, del);
    row.append(meta, sprite, actions);
    host.appendChild(row);
  });
}

async function refreshSpriteCache() {
  // no-op: sprites are file-based under game/sprites/
}

function renderAll() {
  renderRosterTable();
  renderEnemyTable();
}

function mountMechanicsDocumentation() {
  const host = document.getElementById("mechanics-docs-host");
  host.innerHTML = buildMechanicsDocumentationHtml();
}

function setActivePage(page) {
  const pages = ["docs", "allies", "enemies", "background"];
  for (const p of pages) {
    document.getElementById(`page-${p}`).classList.toggle("is-active", p === page);
  }
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.page === page);
  });
}

function pageFromHash() {
  const raw = (location.hash || "").replace(/^#/, "");
  return raw === "docs" || raw === "allies" || raw === "enemies" || raw === "background" ? raw : "docs";
}

function initNav() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const page = btn.dataset.page;
      if (page) location.hash = `#${page}`;
    });
  });
  window.addEventListener("hashchange", () => setActivePage(pageFromHash()));
  setActivePage(pageFromHash());
}

function normalizeRoster(list) {
  const normalized = list.map((c) => normalizeCharacterDef(c));
  const used = new Set();
  normalized.forEach((c, i) => {
    let base = c.id;
    let next = base;
    let n = 2;
    while (used.has(next)) {
      next = `${base}_${n}`;
      n += 1;
    }
    c.id = next;
    used.add(c.id);
    normalized[i] = c;
  });
  return normalized;
}

function normalizeEnemies(list) {
  const normalized = list.map((e) => normalizeEnemyDef(e));
  const used = new Set();
  normalized.forEach((e, i) => {
    let base = e.id;
    let next = base;
    let n = 2;
    while (used.has(next)) {
      next = `${base}_${n}`;
      n += 1;
    }
    e.id = next;
    used.add(e.id);
    normalized[i] = e;
  });
  return normalized;
}

async function main() {
  setStatus("Loading…");
  mountMechanicsDocumentation();
  initNav();
  initEditorForm();

  try {
    const [cRes, eRes, bRes] = await Promise.all([
      fetch(DATA_CHAR),
      fetch(DATA_ENEMY),
      fetch(DATA_BG).catch(() => null),
    ]);
    if (!cRes.ok || !eRes.ok) throw new Error("Could not load game JSON.");
    bundledChars = normalizeRoster(await cRes.json());
    enemyDefs = normalizeEnemies(await eRes.json());
    if (bRes && bRes.ok) await bRes.json().catch(() => ({}));
  } catch (e) {
    setStatus(`Failed to load data. ${e?.message || e}`, "err");
    return;
  }

  roster = clone(bundledChars);
  await refreshSpriteCache();
  renderAll();
  renderBackgroundPreview();
  let rosterSaveTimer = null;
  let enemySaveTimer = null;
  const scheduleRosterAutosave = () => {
    if (rosterSaveTimer) clearTimeout(rosterSaveTimer);
    rosterSaveTimer = setTimeout(async () => {
      rosterSaveTimer = null;
      await saveRosterToCharactersFile(true);
    }, 400);
  };
  const scheduleEnemyAutosave = () => {
    if (enemySaveTimer) clearTimeout(enemySaveTimer);
    enemySaveTimer = setTimeout(async () => {
      enemySaveTimer = null;
      await saveEnemiesToFile(true);
    }, 400);
  };
  queueRosterAutosave = scheduleRosterAutosave;
  queueEnemyAutosave = scheduleEnemyAutosave;

  document.getElementById("btn-remove-all-chars").addEventListener("click", async () => {
    const ok = await confirmDangerAction(
      "Remove all characters?",
      "This will delete every ally from the devtools list immediately.",
      "Remove all allies"
    );
    if (!ok) return;
    roster = [];
    renderAll();
    queueRosterAutosave();
    setStatus("All characters removed.", "ok");
  });

  document.getElementById("btn-remove-all-enemies").addEventListener("click", async () => {
    const ok = await confirmDangerAction(
      "Remove all enemies?",
      "This will delete every enemy from the devtools list immediately.",
      "Remove all enemies"
    );
    if (!ok) return;
    enemyDefs = [];
    renderAll();
    queueEnemyAutosave();
    setStatus("All enemies removed.", "ok");
  });

  document.getElementById("btn-add-char").addEventListener("click", () => {
    const name = `New Hero ${roster.length + 1}`;
    roster.push(blankCharacter(name));
    renderAll();
    location.hash = "#allies";
    openEditor(roster.length - 1);
    queueRosterAutosave();
    setStatus(`Added blank hero "${name}". Use Edit for detailed stats/skills.`, "ok");
  });

  document.getElementById("btn-add-enemy").addEventListener("click", () => {
    const name = `New Enemy ${enemyDefs.length + 1}`;
    enemyDefs.push(blankEnemy(name));
    renderAll();
    location.hash = "#enemies";
    openEnemyEditor(enemyDefs.length - 1);
    queueEnemyAutosave();
    setStatus(`Added blank enemy "${name}". Use Edit for detailed stats/skills.`, "ok");
  });

  const bgInput = /** @type {HTMLInputElement | null} */ (document.getElementById("bg-upload-input"));
  const bgClearBtn = document.getElementById("bg-clear-btn");
  if (bgInput) {
    bgInput.addEventListener("change", async () => {
      const file = bgInput.files?.[0];
      bgInput.value = "";
      if (!file) return;
      try {
        const square = await normalizeImageToSquarePng(file);
        const fd = new FormData();
        fd.append("file", square, "arena.png");
        const res = await fetch("/api/background", { method: "POST", body: fd });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || "Background upload failed");
        renderBackgroundPreview();
        setStatus("Saved battle background.", "ok");
      } catch (e) {
        setStatus(`Background save failed: ${e?.message || e}`, "err");
      }
    });
  }
  if (bgClearBtn) {
    bgClearBtn.addEventListener("click", async () => {
      try {
        const res = await fetch("/api/background", { method: "DELETE" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || "Background clear failed");
        renderBackgroundPreview();
        setStatus("Cleared battle background.", "ok");
      } catch (e) {
        setStatus(`Background clear failed: ${e?.message || e}`, "err");
      }
    });
  }

  document.getElementById("char-editor-cancel").addEventListener("click", () => closeEditor());
  document.getElementById("enemy-editor-cancel").addEventListener("click", () => closeEnemyEditor());

  document.getElementById("char-editor-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (editIndex < 0) return;
    const trial = roster.slice();
    trial[editIndex] = readCharFromForm();
    const err = validateRoster(trial);
    if (err) return setStatus(err, "err");
    roster = trial;
    closeEditor();
    renderAll();
    queueRosterAutosave();
    setStatus("", "");
  });

  document.getElementById("enemy-editor-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (enemyEditIndex < 0) return;
    const trial = enemyDefs.slice();
    trial[enemyEditIndex] = readEnemyFromForm();
    const err = validateEnemies(trial);
    if (err) return setStatus(err, "err");
    enemyDefs = trial;
    closeEnemyEditor();
    renderAll();
    queueEnemyAutosave();
    setStatus("", "");
  });

  setStatus("Ready — edits autosave.", "ok");
}

main();
