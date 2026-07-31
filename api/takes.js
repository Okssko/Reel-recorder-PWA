const { put, list } = require('@vercel/blob');

const MANIFEST_PATH = 'manifest.json';

function checkAuth(req) {
  const passcode = req.headers['x-reel-passcode'];
  return passcode && passcode === process.env.REEL_PASSCODE;
}

async function readManifest() {
  const { blobs } = await list({ prefix: MANIFEST_PATH, limit: 1 });
  if (blobs.length === 0) return [];
  const res = await fetch(blobs[0].url, { cache: 'no-store' });
  if (!res.ok) return [];
  return res.json();
}

async function writeManifest(records) {
  await put(MANIFEST_PATH, JSON.stringify(records), {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json'
  });
}

module.exports = async (req, res) => {
  if (!checkAuth(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  if (req.method === 'GET') {
    const records = await readManifest();
    records.sort((a, b) => b.created_at - a.created_at);
    res.status(200).json(records);
    return;
  }

  if (req.method === 'POST') {
    const { name, mimeType, duration, peaks, audioBase64 } = req.body;
    if (!audioBase64) { res.status(400).json({ error: 'Missing audio' }); return; }

    const buffer = Buffer.from(audioBase64, 'base64');
    const ext = mimeType.includes('mp4') ? 'm4a' : mimeType.includes('ogg') ? 'ogg' : 'webm';
    const filename = `takes/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

    const blob = await put(filename, buffer, { access: 'public', contentType: mimeType });

    const records = await readManifest();
    const newRecord = {
      id: Date.now(),
      name,
      duration,
      mime_type: mimeType,
      blob_url: blob.url,
      peaks,
      created_at: Date.now()
    };
    records.push(newRecord);
    await writeManifest(records);

    res.status(201).json(newRecord);
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};