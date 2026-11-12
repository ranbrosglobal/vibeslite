'use strict';
// ============================================================================
//  Vercel entry point — deploys the whole Crop AI console as ONE serverless
//  function. Vercel detects this file (api/index.js), builds it with
//  @vercel/node, and (via the catch-all rewrite in vercel.json) every request
//  — API, map tiles, uploads, static console — reaches the Express app below.
//
//  server.js skips its listen() call when process.env.VERCEL is set and
//  seeds its JSON state + uploads into the writable /tmp dir on cold start;
//  the extra files the function needs at runtime (crop-ai/public/**,
//  crop-ai/data/**) are declared in vercel.json under functions.includeFiles.
//
//  Local development does NOT use this file — run ./start.sh instead.
// ============================================================================
module.exports = require('../crop-ai/server');
