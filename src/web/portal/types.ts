// Shapes returned by /api/portal/* (guest-safe views; see src/server/portal).

export type MediaType = 'movie' | 'tv';

export type GuestState =
  | { kind: 'available' }
  | { kind: 'downloading'; percent: number; etaSec: number | null }
  | { kind: 'queued'; position: number; etaSec: number | null }
  | { kind: 'coming' }
  | { kind: 'requested' }
  | { kind: 'none' };

export interface GuestCard {
  mediaType: MediaType;
  tmdbId: number;
  title: string;
  year?: number;
  posterPath?: string | null;
  rating?: number;
  state: GuestState;
}

export type Step = 'requested' | 'declined' | 'approved' | 'searching' | 'queued' | 'downloading' | 'importing' | 'available' | 'problem';

export interface RequestView {
  id: number;
  mediaType: MediaType;
  tmdbId: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  seasons: number[] | null;
  status: 'pending' | 'approved' | 'declined' | 'failed' | 'available';
  step: Step;
  stepDetail: string;
  percent?: number;
  etaSec?: number | null;
  position?: number;
  declineReason?: string | null;
  createdAt: number;
  availableAt: number | null;
  plexUrl?: string;
}

export interface GuestMe {
  username: string;
  thumb: string | null;
  email: string | null;
  role: 'guest' | 'kid';
  notifyEmail: boolean;
  limits: { moviesPerWeek: number; seasonsPerWeek: number; gbPerMonth: number; autoApproveGb: number };
  unlimited?: boolean;
  autoApproveAll?: boolean;
  usage: { moviesWeek: number; seasonsWeek: number; bytesMonth: number };
  watchlist: { url: string | null; syncedAt: number | null; note: string | null };
  csrf: string;
}

export interface TitleView {
  mediaType: MediaType;
  tmdbId: number;
  title: string;
  year?: number;
  posterPath?: string | null;
  backdropPath?: string | null;
  overview?: string;
  tagline?: string;
  runtime?: number;
  rating?: number;
  certification: string | null;
  genres: string[];
  trailerKey?: string;
  cast: { name: string; character?: string; profilePath?: string | null }[];
  seasons?: { seasonNumber: number; episodeCount: number; airDate?: string | null; inPlex: boolean; coming: boolean }[];
  state: GuestState;
  allowed: boolean;
  myRequest: RequestView | null;
  recommendations: GuestCard[];
}

export interface CreateResult {
  request: RequestView;
  outcome: 'created' | 'merged' | 'auto-approved' | 'already-coming';
}
