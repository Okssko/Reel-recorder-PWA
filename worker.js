export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/takes') {
      return handleTakes(request, env);
    }
    if (path.startsWith('/api/takes/')) {
      const id = path.split('/').pop();
      return handleTakeById(request, env, id);
    }
    if (path.startsWith('/api/audio/')) {
      const key = decodeURIComponent(path.replace('/api/audio/', ''));
      return handleAudio(env, key);
    }

    return env.ASSETS.fetch(request);
  }
};

function checkAuth(request, env) {
  const passcode = request.headers.get('x-reel-passcode');
  return passcode && passcode === env.REEL_PASSCODE;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function base64ToArrayBuffer(base64) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
  return bytes.buffer;
}

async function handleTakes(request, env) {
  if (!checkAuth(request, env)) return json({ error: 'Unauthorized' }, 401);

  if (request.method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM takes ORDER BY created_at DESC').all();
    const mapped = results.map((r) => ({ ...r, blob_url: `/api/audio/${r.r2_key}` }));
    return json(mapped);
  }

  if (request.method === 'POST') {
    const body = await request.json();
    const { name, mimeType, duration, peaks, audioBase64 } = body;
    if (!audioBase64) return json({ error: 'Missing audio' }, 400);

    const ext = mimeType.includes('mp4') ? 'm4a' : mimeType.includes('ogg') ? 'ogg' : 'webm';
    const r2Key = `takes/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    const binary = base64ToArrayBuffer(audioBase64);

    await env.BUCKET.put(r2Key, binary, { httpMetadata: { contentType: mimeType } });

    const createdAt = Date.now();
    const result = await env.DB.prepare(
      'INSERT INTO takes (name, duration, mime_type, r2_key, peaks, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *'
    ).bind(name, duration, mimeType, r2Key, JSON.stringify(peaks), createdAt).first();

    return json({ ...result, blob_url: `/api/audio/${r2Key}` }, 201);
  }

  return json({ error: 'Method not allowed' }, 405);
}

async function handleTakeById(request, env, id) {
  if (!checkAuth(request, env)) return json({ error: 'Unauthorized' }, 401);

  if (request.method === 'PATCH') {
    const { name } = await request.json();
    await env.DB.prepare('UPDATE takes SET name = ? WHERE id = ?').bind(name, id).run();
    return json({ id, name });
  }

  if (request.method === 'DELETE') {
    const row = await env.DB.prepare('SELECT r2_key FROM takes WHERE id = ?').bind(id).first();
    if (row) {
      await env.BUCKET.delete(row.r2_key).catch(() => {});
      await env.DB.prepare('DELETE FROM takes WHERE id = ?').bind(id).run();
    }
    return new Response(null, { status: 204 });
  }

  return json({ error: 'Method not allowed' }, 405);
}

async function handleAudio(env, key) {
  const obj = await env.BUCKET.get(key);
  if (!obj) return new Response('Not found', { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  return new Response(obj.body, { headers });
}