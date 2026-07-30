import './instrumentation.js';
import { shutdownLangfuse } from './instrumentation.js';
import { connectDatabase } from './config/database.js';
import app from './app.js';

const port = process.env.PORT || 4000;
let server;

connectDatabase()
  .then(() => {
    server = app.listen(port, () => {
      console.log(`API listening on http://localhost:${port}`);
    });
  })
  .catch((error) => {
    console.error('Failed to start server', { message: error.message });
    process.exit(1);
  });

async function shutdown(signal) {
  console.log(signal + ' received; shutting down');
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await shutdownLangfuse();
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
