import { migrate, close } from './db.js';

migrate(msg => console.log(`[avcu] ${msg}`))
  .then(() => close())
  .then(() => process.exit(0))
  .catch(error => {
    console.error('[avcu] migration failed:', error.message);
    process.exit(1);
  });
