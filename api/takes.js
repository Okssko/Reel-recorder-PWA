const { sql } = require('@vercel/postgres');
const { put } = require('@vercel/blob');

function checkAuth(req) {
  const passcode = req.headers['x-reel-passcode'];
  return passcode && passcode === process.env.REEL_PASSCODE;
}

module.exports = async (req, res) => {
  if (!checkAuth(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  if (req.method === 'GET') {
    const { rows } = await sql`
      SELECT id, name, duration, mime_type, blob_url, peaks, created_at
      FROM takes ORDER BY created_at DESC
    `;
    res.status(200).json(rows);
    return;
  }

  if (req.method === 'POST') {
    const { name, mimeType, duration, peaks, audioBase64 } = req.body;
    if (!audioBase64) { res.status(400).json({ error: 'Missing audio' }); return; }

    const buffer = Buffer.from(audioBase64, 'base64');
    const ext = mimeType.includes('mp4') ? 'm4a' : mimeType.includes('ogg') ? 'ogg' : 'webm';
    const filename = `takes/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

    const blob = await put(filename, buffer, { access: 'public', contentType: mimeType });
    const createdAt = Date.now();

    const { rows } = await sql`
      INSERT INTO takes (name, duration, mime_type, blob_url, peaks, created_at)
      VALUES (${name}, ${duration}, ${mimeType}, ${blob.url}, ${JSON.stringify(peaks)}, ${createdAt})
      RETURNING id, name, duration, mime_type, blob_url, peaks, created_at
    `;
    res.status(201).json(rows[0]);
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};