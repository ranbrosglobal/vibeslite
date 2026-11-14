'use strict';
// ============================================================================
//  Vibes Lite AI — model service on Vercel
//
//  The leaf classifier is a Teachable Machine image model that runs in the
//  browser (TensorFlow.js on WebGL): the weights ship with the web build under
//  /ai-model and never leave the device. This service is the model's registry
//  and health surface, so a deployment has an addressable AI service:
//
//    GET /ai/health     is the model available, and what is it
//    GET /ai/model      labels, input size, guard reference, asset URLs
//    GET /ai/classes    just the 29 class names
//
//  Inference endpoints stay on the client on purpose — a phone photo of a leaf
//  is diagnosed in under a second without uploading anything.
// ============================================================================

const express = require('express');
const metadata = require('./model/metadata.json');

const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('cache-control', 'public, max-age=0, s-maxage=300, stale-while-revalidate=86400');
  next();
});

const model = {
  name: 'Leaf disease classifier',
  architecture: 'Teachable Machine image model (TensorFlow.js)',
  trainerVersion: metadata.tmVersion,
  imageSize: metadata.imageSize,
  labels: metadata.labels,
  classCount: metadata.labels.length,
  onDevice: true,
  assets: {
    metadata: '/ai-model/metadata.json',
    model: '/ai-model/model.json',
    weights: '/ai-model/weights.bin',
    guard: '/ai-model/reference.json',
  },
  notes:
    'Frames are resized to 224×224 and scored in the browser. The guard vector set rejects photos that are not a single leaf.',
};

app.get('/ai', (req, res) => res.json({ status: 'ok' }));
app.get('/ai/health', (req, res) => res.json({ status: 'ok', model: 'leaf-classifier', ready: true }));
app.get('/ai/model', (req, res) => res.json(model));
app.get('/ai/classes', (req, res) => res.json({ count: model.classCount, labels: model.labels }));

app.use((req, res) => {
  res.status(404).json({ detail: 'The AI service exposes /ai/health, /ai/model and /ai/classes.' });
});

module.exports = app;

// Local smoke test only; Vercel's express framework imports the app.
if (!process.env.VERCEL) {
  const port = Number(process.env.PORT) || 8011;
  app.listen(port, '127.0.0.1', () => {
    console.log(`Vibes Lite AI service on http://127.0.0.1:${port}`);
  });
}
