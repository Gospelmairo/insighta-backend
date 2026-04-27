'use strict';

const express      = require('express');
const cors         = require('cors');
const cookieParser = require('cookie-parser');
const { requestLogger } = require('./middleware');
const authRouter     = require('./auth');
const profilesRouter = require('./profiles');
const db             = require('./db');

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use((_, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });
app.use(cookieParser());
app.use(express.json());
app.use(requestLogger);

// DB lazy init — must run before any route
let ready = false;
app.use(async (req, res, next) => {
  if (!ready) {
    try { await db.init(); ready = true; }
    catch (e) { return res.status(500).json({ status: 'error', message: e.message }); }
  }
  next();
});

app.get('/', (_, res) => res.json({ status: 'success', message: 'Insighta Labs+ API v1' }));
app.use('/auth', authRouter);
app.use('/api/profiles', profilesRouter);

// Global error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ status: 'error', message: 'Internal server error' });
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  db.init()
    .then(() => app.listen(PORT, () => console.log(`Insighta backend on port ${PORT}`)))
    .catch(e => { console.error(e); process.exit(1); });
}

module.exports = app;
