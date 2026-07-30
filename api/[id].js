const { sql } = require('@vercel/postgres');
const { del } = require('@vercel/blob');

function checkAuth(req) {
  const passcode = req.headers['x-reel-passcode'];
  return passcode && passcode === process.env.REEL_PASSCODE;
}

module.exports = async (req, res) => {
  if (!checkAuth(req)) { res.status(401).json({ error: 'Unauthorized' }); return; }
  const { id } = req.query;

  if (req.method === 'PATCH') {
    const { name } = req.body;
    const { rows } = await sql`UPDATE takes SET name = ${name} WHERE id = ${id} RETURNING id, name`;
    res.status(200).json(rows[0]);
    return;
  }

  if (req.method === 'DELETE') {
    const { rows } = await sql`SELECT blob_url FROM takes WHERE id = ${id}`;
    if (rows[0]) {
      await del(rows[0].blob_url).catch(() => {});
      await sql`DELETE FROM takes WHERE id = ${id}`;
    }
    res.status(204).end();
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};