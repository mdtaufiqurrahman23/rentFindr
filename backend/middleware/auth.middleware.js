import jwt from "jsonwebtoken";

const AUTH_SECRET = process.env.AUTH_SECRET ?? "baskhuji-dev-secret";

export function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  try {
    const payload = jwt.verify(token, AUTH_SECRET);
    req.user = { id: String(payload.sub), role: payload.role, accountType: payload.accountType };
    next();
  } catch {
    return res.status(401).json({ error: "Unauthorized" });
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    next();
  };
}
