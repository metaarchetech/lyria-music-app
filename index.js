// index.js
// Node.js + Express: Call Google Cloud Vertex AI music generation and return Base64 audio

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const { VertexAI } = require('@google-cloud/vertexai');
// Removed temporary Hugging Face fallback per request

// 2) Express app setup
const app = express();
app.use(express.json());
app.use(cors()); // Development MVP: allow all origins

// 3) Vertex AI initialization
// Ensure GOOGLE_APPLICATION_CREDENTIALS is set to your service account key JSON path
const vertexAI = new VertexAI({
  project: 'hazel-airlock-473807-q6',
  location: 'us-central1',
});

// Default model (can be overridden per-request or via env VERTEX_MODEL)
const DEFAULT_MODEL = process.env.VERTEX_MODEL || 'lyria-002';

function getModel(modelName) {
  return vertexAI.preview.getGenerativeModel({ model: modelName });
}

// Simple retry helpers for transient/quota errors
const MAX_ATTEMPTS = 1; // keep very conservative to avoid quota spikes
const BASE_DELAY_MS = 1200; // base backoff ~1.2s (kept for future tuning)
const MIN_INTERVAL_MS = 2000; // pacing: at least 2s between calls
let lastCallAtMs = 0;
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function shouldRetry(err) {
  const s = String(err?.message || err);
  return (
    s.includes('429') ||
    s.includes('RESOURCE_EXHAUSTED') ||
    s.includes('rate') ||
    s.includes('Quota') ||
    s.includes('503')
  );
}

// 5) Health check
app.get('/', (_req, res) => {
  res.json({ status: 'ok', message: 'Lyria music server is running' });
});

// Debug endpoint to verify credentials and config
app.get('/_debug', (_req, res) => {
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || null;
  const credExists = credPath ? fs.existsSync(credPath) : false;
  res.json({
    status: 'ok',
    project: 'hazel-airlock-473807-q6',
    location: 'us-central1',
    GOOGLE_APPLICATION_CREDENTIALS: credPath,
    credentialsFileExists: credExists,
  });
});

async function generateFromPrompt(prompt, modelName = DEFAULT_MODEL) {
  // Build minimal request using contents only; instruct duration via text
  const requestPayload = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: `${String(prompt)}\n\nPlease generate approximately 15 seconds of music as high-quality audio.`,
          },
        ],
      },
    ],
  };

  // Pacing: ensure minimal interval between calls to reduce 429s
  const now = Date.now();
  const since = now - lastCallAtMs;
  if (since < MIN_INTERVAL_MS) {
    await sleep(MIN_INTERVAL_MS - since);
  }
  // Call Vertex AI with retries and parse response
  const model = getModel(modelName);
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await model.generateContent(requestPayload);
      lastCallAtMs = Date.now();
      const parts = response?.candidates?.[0]?.content?.parts || [];
      let audioBase64 = null;
      for (const part of parts) {
        if (part?.audioData?.data) { audioBase64 = part.audioData.data; break; }
        if (part?.inlineData?.data) { audioBase64 = part.inlineData.data; break; }
      }
      if (!audioBase64) {
        console.error('Audio data not found in response:', JSON.stringify(response, null, 2));
        throw new Error('NO_AUDIO_IN_RESPONSE');
      }
      return audioBase64;
    } catch (err) {
      lastErr = err;
      if (!shouldRetry(err) || attempt === MAX_ATTEMPTS) {
        throw err;
      }
      const delay = Math.round(BASE_DELAY_MS * Math.pow(2, attempt - 1) * (0.75 + Math.random() * 0.5));
      console.warn(`Retry ${attempt} due to:`, String(err?.message || err), `— waiting ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastErr || new Error('UNKNOWN_ERROR');
}

// 4) Core endpoint: generate music (POST)
app.post('/api/generate-music', async (req, res) => {
  try {
    const { prompt, model: overrideModel } = req.body || {};
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'Invalid prompt' });
    }

    const modelName = typeof overrideModel === 'string' && overrideModel.trim() ? overrideModel.trim() : DEFAULT_MODEL;
    const audioBase64 = await generateFromPrompt(prompt, modelName);
    return res.json({ audioData: audioBase64 });
  } catch (err) {
    console.error('Error generating music:', err?.stack || err);
    return res.status(500).json({ error: 'Failed to generate music', detail: String(err?.message || err) });
  }
});

// Convenience GET for quick browser tests: /api/generate-music?prompt=...
app.get('/api/generate-music', async (req, res) => {
  try {
    const prompt = req.query.prompt;
    const overrideModel = req.query.model;
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'Invalid prompt' });
    }
    const modelName = typeof overrideModel === 'string' && overrideModel.trim() ? overrideModel.trim() : DEFAULT_MODEL;
    const audioBase64 = await generateFromPrompt(prompt, modelName);
    return res.json({ audioData: audioBase64 });
  } catch (err) {
    console.error('Error generating music (GET):', err?.stack || err);
    return res.status(500).json({ error: 'Failed to generate music', detail: String(err?.message || err) });
  }
});

// 7) Start server
const PORT = 3001;
app.listen(PORT, () => {
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || null;
  const credExists = credPath ? fs.existsSync(credPath) : false;
  console.log(`Server is running on port ${PORT}`);
  console.log('GOOGLE_APPLICATION_CREDENTIALS:', credPath, 'exists:', credExists);
  console.log('Default Vertex model:', DEFAULT_MODEL);
});


