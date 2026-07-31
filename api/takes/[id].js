const { put, list, del } = require('@vercel/blob');

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
  if (!checkAuth(req)) { res.status(401).json({ error: 'Unauthorized' }); return; }
  const id = Number(req.query.id);

  const records = await readManifest();
  const index = records.findIndex((r) => r.id === id);

  if (req.method === 'PATCH') {
    if (index === -1) { res.status(404).json({ error: 'Not found' }); return; }
    const { name } = req.body;
    records[index].name = name;
    await writeManifest(records);
    res.status(200).json(records[index]);
    return;
  }

  if (req.method === 'DELETE') {
    if (index !== -1) {
      await del(records[index].blob_url).catch(() => {});
      records.splice(index, 1);
      await writeManifest(records);
    }
    res.status(204).end();
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};