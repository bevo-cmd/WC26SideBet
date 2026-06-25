#!/usr/bin/env node
/**
 * World Cup 2026 Sweepstakes — scoring job.
 *
 * Reads:   data/teams.json   (the 48 nations, with the name used by the results feed)
 *          data/rosters.json (who owns which teams)
 * Fetches: openfootball public results feed (no API key)
 * Writes:  data/standings.json (fully computed leaderboard the page renders)
 *
 * Scoring:
 *   Match points  — Win 3, Draw 1, Loss 0 (every round; a KO won on penalties = Win)
 *   Stage bonus   — group 0, R32 5, R16 10, QF 20, SF 35, 4th 45, 3rd 55, RU 65, Champion 80
 *   Team total    = match points + furthest-stage bonus
 *   Player total  = sum across their teams
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "data");

const FEED_URL =
  "https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json";

const STAGE_BONUS = {
  group: 0, r32: 5, r16: 10, qf: 20, sf: 35,
  fourth: 45, third: 55, runner: 65, champion: 80,
};
const STAGE_LABEL = {
  group: "Group stage", r32: "Round of 32", r16: "Round of 16", qf: "Quarter-final",
  sf: "Semi-final", fourth: "4th place", third: "3rd place", runner: "Runner-up", champion: "Champion",
};

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function roundKey(round = "") {
  const r = round.toLowerCase();
  if (r.includes("round of 32")) return "r32";
  if (r.includes("round of 16")) return "r16";
  if (r.includes("quarter")) return "qf";
  if (r.includes("semi")) return "sf";
  if (r.includes("third")) return "thirdmatch";
  if (r.includes("final")) return "final";
  return "group"; // "Matchday N"
}

// Decide a result for one side. idx 0 = team1, 1 = team2.
// Returns "win" | "draw" | "loss" | null (not played / undecided).
function outcome(score, idx, isKnockout) {
  if (!score || !Array.isArray(score.ft)) return null;
  let arr = score.ft;
  if (isKnockout && arr[0] === arr[1] && Array.isArray(score.et)) arr = score.et;   // after extra time
  if (isKnockout && arr[0] === arr[1] && Array.isArray(score.p)) arr = score.p;      // penalty shootout
  if (arr[0] === arr[1]) return isKnockout ? null : "draw"; // KO must have a winner; if still level, treat undecided
  return arr[idx] > arr[1 - idx] ? "win" : "loss";
}

async function main() {
  const teams = readJson(path.join(DATA, "teams.json"));
  const rosters = readJson(path.join(DATA, "rosters.json"));

  // feed-name -> team id (and id -> team)
  const byFeed = new Map();
  const byId = new Map();
  for (const t of teams) {
    byFeed.set(t.feedName, t.id);
    byId.set(t.id, t);
  }

  console.log("Fetching results feed…");
  const res = await fetch(FEED_URL, { headers: { "user-agent": "wc-sweepstakes" } });
  if (!res.ok) throw new Error(`Feed fetch failed: ${res.status}`);
  const feed = await res.json();
  const matches = feed.matches || [];

  // Per-team accumulator
  const stat = {};
  for (const t of teams) {
    stat[t.id] = { w: 0, d: 0, l: 0, matchPoints: 0, rounds: new Set(), finalRes: null, thirdRes: null };
  }

  for (const m of matches) {
    const rk = roundKey(m.round);
    const ko = rk !== "group";
    const id1 = byFeed.get(m.team1);
    const id2 = byFeed.get(m.team2);

    // Record reaching a knockout round as soon as a real team is slotted into it.
    if (ko) {
      const stageOfRound = rk === "thirdmatch" ? "sf" : rk; // playing the 3rd-place match means you were a semifinalist
      if (id1) stat[id1].rounds.add(stageOfRound === "final" ? "final" : (rk === "thirdmatch" ? "thirdmatch" : rk));
      if (id2) stat[id2].rounds.add(stageOfRound === "final" ? "final" : (rk === "thirdmatch" ? "thirdmatch" : rk));
    }

    const o1 = outcome(m.score, 0, ko);
    const o2 = outcome(m.score, 1, ko);
    if (o1 && id1) applyResult(stat[id1], o1);
    if (o2 && id2) applyResult(stat[id2], o2);

    // Capture final / third-place outcomes for placement
    if (rk === "final") {
      if (o1 && id1) stat[id1].finalRes = o1;
      if (o2 && id2) stat[id2].finalRes = o2;
    }
    if (rk === "thirdmatch") {
      if (o1 && id1) stat[id1].thirdRes = o1;
      if (o2 && id2) stat[id2].thirdRes = o2;
    }
  }

  function applyResult(s, o) {
    if (o === "win") { s.w++; s.matchPoints += 3; }
    else if (o === "draw") { s.d++; s.matchPoints += 1; }
    else if (o === "loss") { s.l++; }
  }

  function stageFor(s) {
    const r = s.rounds;
    if (r.has("final")) {
      if (s.finalRes === "win") return "champion";
      if (s.finalRes === "loss") return "runner";
      return "runner"; // reached final, not yet played
    }
    if (r.has("thirdmatch")) {
      if (s.thirdRes === "win") return "third";
      if (s.thirdRes === "loss") return "fourth";
      return "sf"; // semifinal loser, 3rd-place match not played yet
    }
    if (r.has("sf")) return "sf";
    if (r.has("qf")) return "qf";
    if (r.has("r16")) return "r16";
    if (r.has("r32")) return "r32";
    return "group";
  }

  // Build computed team records
  const teamOut = {};
  for (const t of teams) {
    const s = stat[t.id];
    const stage = stageFor(s);
    const bonus = STAGE_BONUS[stage];
    teamOut[t.id] = {
      id: t.id, name: t.name, flag: t.flag, group: t.group,
      w: s.w, d: s.d, l: s.l, matchPoints: s.matchPoints,
      stage, stageLabel: STAGE_LABEL[stage], stageBonus: bonus,
      total: s.matchPoints + bonus,
    };
  }

  // Build player leaderboard
  const owned = new Set();
  const players = rosters.players.map((p) => {
    const teamsArr = p.teams.map((tid) => {
      owned.add(tid);
      return teamOut[tid] || { id: tid, name: tid, flag: "🏳️", group: "?", w: 0, d: 0, l: 0, matchPoints: 0, stage: "group", stageLabel: "Group stage", stageBonus: 0, total: 0 };
    });
    const total = teamsArr.reduce((sum, t) => sum + t.total, 0);
    return { id: p.id, name: p.name, total, teams: teamsArr };
  });
  players.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

  const unassigned = teams.filter((t) => !owned.has(t.id)).map((t) => t.id);

  const out = {
    updatedAt: new Date().toISOString(),
    feedUpdatedAt: feed.updatedAt || null,
    source: "openfootball/worldcup.json (2026)",
    scoring: { win: 3, draw: 1, loss: 0, stageBonus: STAGE_BONUS },
    players,
    teams: teamOut,
    unassigned,
  };

  fs.writeFileSync(path.join(DATA, "standings.json"), JSON.stringify(out, null, 2));
  console.log(`standings.json written — ${players.length} players, leader: ${players[0]?.name} (${players[0]?.total} pts)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
