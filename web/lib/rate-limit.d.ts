export type RateLimitResult = { ok: true } | { ok: false; retryAfterMs: number };

export declare function tryConsume(opts: {
  name: string;
  key: string;
  limit: number;
  windowMs: number;
}): RateLimitResult;

export declare function clientKey(req: Request, name: string): string;
