import dotenv from 'dotenv';
import { connectDatabase } from './config/database.js';
import app from './app.js';

dotenv.config();

const port = process.env.PORT || 4000;

connectDatabase()
  .then(() => {
    app.listen(port, () => {
      console.log(`API listening on http://localhost:${port}`);
    });
  })
  .catch((error) => {
    console.error('Failed to start server', { message: error.message });
    process.exit(1);
  });
