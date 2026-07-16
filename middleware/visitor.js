export function requireVisitor(req, res, next) {
  const visitorId = req.header('x-visitor-id');
  if (!visitorId || typeof visitorId !== 'string' || visitorId.length < 16) {
    return res.status(400).json({
      error: { message: 'Missing or invalid x-visitor-id header.' }
    });
  }
  req.visitorId = visitorId;
  next();
}
