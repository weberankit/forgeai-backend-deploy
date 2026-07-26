export function errorHandler(error, req, res, next) {
  const uploadError = error.code === 'LIMIT_FILE_SIZE' || /Unsupported image type/i.test(error.message || '');
  const status = error.status || (uploadError ? 400 : 500);
  const message = status === 500 ? 'Internal server error.' : error.message;
  console.error('API error', {
    path: req.path,
    method: req.method,
    status,
    message: error.message,
    code: error.code
  });
  res.status(status).json({ error: { message, ...(error.code ? { code: error.code } : {}) } });
}
