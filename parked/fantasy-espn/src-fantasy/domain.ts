/**
 * The shapes the rest of the module works with. ESPN's raw payloads never
 * escape src/fantasy/espn — everything downstream uses these, so an ESPN
 * API change is a one-file fix.
 */

export type ScoringFormat = 'points' | 'categories' | 'roto' | 'unknown';

export interface LeagueMeta {
  id: string;
  name: string;
  /** ESPN's season id, e.g. 2027 for the 2026–27 NBA season. */
  seasonId: number;
  /** "NBA 2026–27" */
  seasonLabel: string;
  scoring: ScoringFormat;
  /** Category leagues only: the stats that decide a matchup. */
  categories: StatCategory[];
  teamCount: number;
  /** ESPN's current matchup period (fantasy week). */
  currentMatchupPeriod: number;
  /** ESPN's current scoring period (fantasy day). */
  currentScoringPeriod: number;
  /** PRE_DRAFT | DRAFTING | IN_PROGRESS | COMPLETE */
  status: string;
  finalMatchupPeriod: number;
}

export interface StatCategory {
  /** ESPN stat id. */
  id: number;
  /** "PTS", "REB", "FG%" … */
  abbrev: string;
  /** True when a lower number wins the category (turnovers). */
  lowerIsBetter: boolean;
}

export interface Team {
  id: number;
  name: string;
  abbrev: string;
  logo: string | null;
  /** ESPN's own manager name, used when no Discord member is linked. */
  managerName: string | null;
  wins: number;
  losses: number;
  ties: number;
  /** Where ESPN puts them right now. */
  rank: number;
  pointsFor: number;
  pointsAgainst: number;
  streak: { length: number; type: 'W' | 'L' } | null;
}

export interface Player {
  id: number;
  name: string;
  /** NBA team abbreviation, e.g. "LAL". */
  proTeam: string | null;
  positions: string[];
  injuryStatus: string | null;
  /** Fantasy points or the stat line for the current period, when available. */
  appliedTotal: number | null;
  lineupSlot: string | null;
}

export interface Roster {
  teamId: number;
  players: Player[];
}

export interface MatchupSide {
  teamId: number;
  /** Points leagues: the fantasy total. Category leagues: categories won. */
  score: number;
  /** Category leagues only. */
  categoryTotals: Record<number, number> | null;
}

export interface Matchup {
  id: number;
  matchupPeriod: number;
  home: MatchupSide;
  away: MatchupSide | null; // a bye has no opponent
  /** ESPN's winner marker: HOME | AWAY | TIE | UNDECIDED */
  winner: 'HOME' | 'AWAY' | 'TIE' | 'UNDECIDED';
  complete: boolean;
}

export type TransactionKind = 'trade' | 'waiver' | 'free-agent' | 'drop' | 'other';

export interface TransactionItem {
  playerId: number;
  playerName: string;
  fromTeamId: number | null;
  toTeamId: number | null;
  action: 'ADD' | 'DROP' | 'MOVE' | 'OTHER';
}

export interface Transaction {
  /** ESPN's id where present; otherwise a stable fingerprint. */
  id: string;
  kind: TransactionKind;
  status: string;
  proposedAt: number | null;
  executedAt: number | null;
  teamIds: number[];
  items: TransactionItem[];
}

/** Everything one dashboard refresh needs, fetched together. */
export interface LeagueSnapshot {
  meta: LeagueMeta;
  teams: Team[];
  matchups: Matchup[];
  fetchedAt: number;
}

export function teamRecord(team: Team): string {
  return team.ties > 0 ? `${team.wins}-${team.losses}-${team.ties}` : `${team.wins}-${team.losses}`;
}

/** "NBA 2026–27" from ESPN's season id (2027 means the 2026–27 season). */
export function seasonLabel(seasonId: number): string {
  return `NBA ${seasonId - 1}–${String(seasonId).slice(2)}`;
}
