// src/lib/utils/auth.js
import jwt from "jsonwebtoken";

const ACCESS_SECRET = process.env.ACCESS_TOKEN_SECRET || "fallback_access_token_secret";

/**
 * Extract token from a Next.js Request / NextRequest or plain Node headers object.
 * - Checks Cookie: authToken=...
 * - Checks Authorization: Bearer <token>
 */
export function getTokenFromReq(request) {
  try {
    // NextRequest / Request in App Router
    if (request && typeof request.headers?.get === "function") {
      const cookieHeader = request.headers.get("cookie") || "";
      const cookieMatch = cookieHeader.match(/(?:^|;\s*)authToken=([^;]+)/);
      if (cookieMatch) return cookieMatch[1];

      const auth = request.headers.get("authorization") || "";
      if (auth && auth.toLowerCase().startsWith("bearer ")) return auth.split(" ")[1];

      return null;
    }

    // Fallback: plain object (pages router / tests)
    const headers = request?.headers || request || {};
    const cookieHeader = headers.cookie || headers.Cookie || "";
    const cookieMatch = cookieHeader.match(/(?:^|;\s*)authToken=([^;]+)/);
    if (cookieMatch) return cookieMatch[1];

    const auth = headers.authorization || headers.Authorization || "";
    if (auth && auth.toLowerCase().startsWith("bearer ")) return auth.split(" ")[1];

    return null;
  } catch (err) {
    console.error("[getTokenFromReq] error:", err?.message);
    return null;
  }
}

export function verifyToken(token) {
  if (!token) return null;
  try {
    const secret = process.env.ACCESS_TOKEN_SECRET || process.env.JWT_SECRET || "fallback_access_token_secret";
    return jwt.verify(token, secret, { ignoreExpiration: true });
  } catch (err) {
    // invalid or expired
    // console.debug("[verifyToken] error", err.message);
    return null;
  }
}
