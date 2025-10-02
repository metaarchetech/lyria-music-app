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

// Config via environment variables with safe defaults
const DEFAULT_MODEL = process.env.VERTEX_MODEL || 'lyria-002';
const PORT = Number(process.env.PORT || 3001);
const MAX_ATTEMPTS = Math.max(1, Number(process.env.VERTEX_MAX_ATTEMPTS || 1));
const BASE_DELAY_MS = Math.max(200, Number(process.env.VERTEX_BASE_DELAY_MS || 1200));
const MIN_INTERVAL_MS = Math.max(0, Number(process.env.VERTEX_MIN_INTERVAL_MS || 2000));
const HARD_COOLDOWN_MS = Math.max(0, Number(process.env.VERTEX_HARD_COOLDOWN_MS || 7000));

function getModel(modelName) {
  return vertexAI.preview.getGenerativeModel({ model: modelName });
}

let lastCallAtMs = 0;
let lastSuccessAtMs = 0;
let isGenerating = false;
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
    const wait = MIN_INTERVAL_MS - since;
    console.log(`[pacing] waiting ${wait}ms before calling model=${modelName}`);
    await sleep(wait);
  }
  // Call Vertex AI with retries and parse response
  const model = getModel(modelName);
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await model.generateContent(requestPayload);
      lastCallAtMs = Date.now();
      lastSuccessAtMs = lastCallAtMs;
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
    if (isGenerating) {
      const cooldownLeft = Math.max(0, HARD_COOLDOWN_MS - (Date.now() - lastSuccessAtMs));
      return res.status(429).json({ error: 'Server busy, try again', retryAfterMs: cooldownLeft });
    }
    const { prompt, model: overrideModel } = req.body || {};
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'Invalid prompt' });
    }
    const promptText = String(prompt).trim();
    if (promptText.length === 0) {
      return res.status(400).json({ error: 'Prompt cannot be empty' });
    }
    if (promptText.length > 500) {
      return res.status(400).json({ error: 'Prompt is too long (max 500 chars)' });
    }

    const modelName = typeof overrideModel === 'string' && overrideModel.trim() ? overrideModel.trim() : DEFAULT_MODEL;
    console.log(`[request] model=${modelName} promptLen=${promptText.length}`);
    isGenerating = true;
    const audioBase64 = await generateFromPrompt(promptText, modelName);
    isGenerating = false;
    return res.json({ audioData: audioBase64 });
  } catch (err) {
    isGenerating = false;
    console.error('Error generating music:', err?.stack || err);
    return res.status(500).json({ error: 'Failed to generate music', detail: String(err?.message || err) });
  }
});

// Convenience GET for quick browser tests: /api/generate-music?prompt=...
app.get('/api/generate-music', async (req, res) => {
  try {
    if (isGenerating) {
      const cooldownLeft = Math.max(0, HARD_COOLDOWN_MS - (Date.now() - lastSuccessAtMs));
      return res.status(429).json({ error: 'Server busy, try again', retryAfterMs: cooldownLeft });
    }
    const prompt = req.query.prompt;
    const overrideModel = req.query.model;
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'Invalid prompt' });
    }
    const promptText = String(prompt).trim();
    if (promptText.length === 0) {
      return res.status(400).json({ error: 'Prompt cannot be empty' });
    }
    if (promptText.length > 500) {
      return res.status(400).json({ error: 'Prompt is too long (max 500 chars)' });
    }
    const modelName = typeof overrideModel === 'string' && overrideModel.trim() ? overrideModel.trim() : DEFAULT_MODEL;
    console.log(`[request:GET] model=${modelName} promptLen=${promptText.length}`);
    isGenerating = true;
    const audioBase64 = await generateFromPrompt(promptText, modelName);
    isGenerating = false;
    return res.json({ audioData: audioBase64 });
  } catch (err) {
    isGenerating = false;
    console.error('Error generating music (GET):', err?.stack || err);
    return res.status(500).json({ error: 'Failed to generate music', detail: String(err?.message || err) });
  }
});

// 7) Start server
app.listen(PORT, () => {
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || null;
  const credExists = credPath ? fs.existsSync(credPath) : false;
  console.log(`Server is running on port ${PORT}`);
  console.log('GOOGLE_APPLICATION_CREDENTIALS:', credPath, 'exists:', credExists);
  console.log('Default Vertex model:', DEFAULT_MODEL);
  console.log('Config -> MAX_ATTEMPTS:', MAX_ATTEMPTS, 'MIN_INTERVAL_MS:', MIN_INTERVAL_MS);
});


