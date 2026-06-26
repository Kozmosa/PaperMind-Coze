import type { Request, Response, NextFunction } from 'express';

// Simple in-memory cache for user IDs to avoid hitting Supabase too frequently
const GUEST_USER_ID = '11111111-1111-1111-1111-111111111111';

const tokenUserCache = new Map<string, { userId: string; expiresAt: number }>();

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const token = req.headers['x-session'] as string;

  if (!token) {
    // No token provided - use guest ID for backwards compatibility
    (req as any).userId = GUEST_USER_ID;
    return next();
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseKey) {
      (req as any).userId = GUEST_USER_ID;
      return next();
    }

    // Check cache first
    const cached = tokenUserCache.get(token);
    if (cached && cached.expiresAt > Date.now()) {
      (req as any).userId = cached.userId;
      return next();
    }

    // Verify token with Supabase
    const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: supabaseKey,
      },
    });

    if (response.ok) {
      const user = await response.json() as { id: string };
      const userId = user?.id || GUEST_USER_ID;
      // Cache for 5 minutes
      tokenUserCache.set(token, { userId, expiresAt: Date.now() + 5 * 60 * 1000 });
      (req as any).userId = userId;
    } else {
      // Invalid token - use guest
      (req as any).userId = GUEST_USER_ID;
    }
  } catch (err) {
    console.error('Auth middleware error:', err);
    (req as any).userId = GUEST_USER_ID;
  }

  next();
}
