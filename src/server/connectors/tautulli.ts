import { requestJson, UpstreamError } from '../http.ts';

export interface TautulliSession {
  session_key: string;
  user: string;
  friendly_name: string;
  full_title: string;
  title: string;
  grandparent_title?: string;
  media_type: string;
  progress_percent: string;
  state: string;
  player: string;
  platform: string;
  transcode_decision: string; // direct play | copy | transcode
  video_decision?: string;
  stream_video_full_resolution?: string;
  quality_profile?: string;
  bandwidth?: string;
  location?: string;
  thumb?: string;
  rating_key?: string;
  year?: string;
}

export class TautulliClient {
  readonly app = 'Tautulli';
  constructor(
    readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  private async cmd<T>(cmd: string, params: Record<string, string | number> = {}): Promise<T> {
    const res = await requestJson<{ response: { result: string; message?: string; data: T } }>(this.app, this.baseUrl, '/api/v2', {
      query: { apikey: this.apiKey, cmd, ...params },
    });
    if (res.response.result !== 'success') throw new UpstreamError(this.app, 200, res.response.message ?? 'error');
    return res.response.data;
  }

  activity() {
    return this.cmd<{ stream_count: string; sessions: TautulliSession[]; total_bandwidth: number; stream_count_direct_play: number; stream_count_direct_stream: number; stream_count_transcode: number }>(
      'get_activity',
    );
  }

  history(params: Record<string, string | number>) {
    return this.cmd<{ recordsFiltered: number; data: any[] }>('get_history', params);
  }

  serverInfo() {
    return this.cmd<Record<string, unknown>>('get_server_info');
  }

  recentlyAdded(count = 20) {
    return this.cmd<{ recently_added: any[] }>('get_recently_added', { count });
  }
}
